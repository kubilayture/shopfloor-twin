import {
  SYS_SEGMENT,
  UNS_ROOT,
  parseEquipmentTopic,
  type Incident,
  type MachineState,
  type StateCurrent,
  type Status,
} from '@shopfloor/contracts';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import type { Classified, StateEvent } from './classify.ts';
import { add, contains, holes, missing, overlaps, union, type Range } from './ranges.ts';
import type { RejectReason, StateAnchorTable } from './tables.ts';

/** Durable dedup and gap state of one stream (`ingest.source_cursor`). */
export interface Cursor {
  readonly epoch: number;
  readonly seen: readonly Range[];
  /** Gaps already recorded as incidents; a late message may still fill them. */
  readonly reported: readonly Range[];
}

/** A state change as stored: the input of the equipment module's intervals (#96). */
export interface StateFact {
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  readonly sourceTime: Date;
  readonly state: MachineState;
  readonly cause: string | null;
  readonly quality: 'good' | 'uncertain' | 'bad';
}

/**
 * The current state from a retained delivery or a snapshot (not a fact). `deviceEpoch` is the
 * device epoch it anchors: a retained state event carries it; a snapshot (gateway epoch) gets the
 * epoch of the next device fact of its equipment.
 */
export interface StateAnchor {
  readonly arrival: number;
  readonly equipment: string;
  readonly deviceEpoch: number | null;
  readonly sourceTime: Date;
  readonly state: MachineState;
  readonly cause: string | null;
  readonly kind: 'event' | 'snapshot';
  readonly retained: boolean;
}

/** Any other stored fact (cycle, alarm, telemetry): its time, for watermarks. */
export interface StoredSample {
  readonly equipment: string;
  readonly kind: 'cycle' | 'alarm' | 'telemetry';
  readonly scope: 'device' | 'topic';
  readonly epoch: number;
  readonly seq: number;
  readonly sourceTime: Date;
}

/** What a committed message adds, for listeners (sent after commit). */
export type IngestNotice =
  | { readonly type: 'state'; readonly fact: StateFact }
  | { readonly type: 'anchor'; readonly anchor: StateAnchor }
  | { readonly type: 'sample'; readonly sample: StoredSample };

export type FactOutcome =
  | { readonly status: 'stored'; readonly notices: readonly IngestNotice[] }
  /** `notices`: a row the table had but the cursor didn't, so nobody was told of it yet. */
  | { readonly status: 'duplicate'; readonly notices?: readonly IngestNotice[] }
  | { readonly status: 'stale' };

type FactInput = Extract<Classified, { kind: 'event' | 'telemetry' | 'incident' }>;

/** `_sys` streams are deduplicated but not checked for gaps (status numbers aren't gap-free). */
const tracksGaps = (stream: string): boolean =>
  !stream.startsWith(`topic:${UNS_ROOT}/${SYS_SEGMENT}/`);

function streamEquipment(stream: string): string | null {
  if (stream.startsWith('device:')) return stream.slice('device:'.length);
  return parseEquipmentTopic(stream.slice('topic:'.length))?.equipment ?? null;
}

export function toAnchor(row: Selectable<StateAnchorTable>): StateAnchor {
  return {
    arrival: row.arrival,
    equipment: row.equipment,
    deviceEpoch: row.device_epoch,
    sourceTime: row.source_time,
    state: row.state as MachineState,
    cause: row.cause,
    kind: row.kind,
    retained: row.retained,
  };
}

interface PendingHole {
  readonly range: Range;
  readonly since: number;
}

/**
 * The database side of ingest. Every method runs one transaction; the caller serialises calls
 * (one message at a time, in arrival order), so the cursor cache always equals the table.
 */
export class IngestStore {
  readonly #db: Kysely<Database>;
  readonly #cursors = new Map<string, Cursor>();
  /** Holes seen by `sweep`, with the wall time they were first seen (restarts reset it). */
  readonly #pending = new Map<string, { epoch: number; holes: PendingHole[] }>();
  readonly #beforeCommit: ((topic: string) => Promise<void>) | undefined;

  constructor(db: Kysely<Database>, beforeCommit?: (topic: string) => Promise<void>) {
    this.#db = db;
    this.#beforeCommit = beforeCommit;
  }

  async load(): Promise<void> {
    const rows = await this.#db.selectFrom('ingest.source_cursor').selectAll().execute();
    this.#cursors.clear();
    for (const row of rows) {
      this.#cursors.set(row.stream, { epoch: row.epoch, seen: row.seen, reported: row.reported });
    }
  }

  cursor(stream: string): Cursor | undefined {
    return this.#cursors.get(stream);
  }

  async reject(
    topic: string,
    payload: string,
    retained: boolean,
    reason: RejectReason,
    detail: string,
  ): Promise<void> {
    await this.#db
      .insertInto('ingest.rejected_message')
      .values({ topic, payload, retained, reason, detail })
      .execute();
  }

  async status(component: string, instance: string, message: Status): Promise<void> {
    const row = {
      component,
      instance,
      status: message.value.status,
      started_at: message.value.startedAt,
      version: message.value.version,
      source_time: message.sourceTime,
      received_at: new Date(),
      payload: JSON.stringify(message),
    };
    await this.#db
      .insertInto('ingest.component_status')
      .values(row)
      .onConflict((c) =>
        c.columns(['component', 'instance']).doUpdateSet({
          status: row.status,
          started_at: row.started_at,
          version: row.version,
          source_time: row.source_time,
          received_at: row.received_at,
          payload: row.payload,
        }),
      )
      .execute();
  }

  /** True when the database answers. */
  async ping(): Promise<boolean> {
    return sql`SELECT 1`.execute(this.#db).then(
      () => true,
      () => false,
    );
  }

  /**
   * Stores a retained delivery or a snapshot; an anchor already stored is ignored. Its device
   * epoch: a state event's own epoch, a snapshot's `deviceEpoch` (contract 1.1), or, for an older
   * snapshot without it, the epoch of the next device fact (`fact`). Any snapshot supersedes the
   * equipment's snapshots still waiting for an epoch: only the latest one may anchor (ADR-0017).
   */
  async anchor(
    equipment: string,
    message: StateCurrent,
    retained: boolean,
  ): Promise<StateAnchor | undefined> {
    const deviceEpoch = message.kind === 'event' ? message.epoch : (message.deviceEpoch ?? null);
    return this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('ingest.state_anchor')
        .values({
          equipment,
          kind: message.kind,
          retained,
          scope: message.scope,
          epoch: message.epoch,
          seq: message.seq,
          source_time: message.sourceTime,
          device_epoch: deviceEpoch,
          state: message.value.state,
          cause: message.value.cause,
          quality: message.quality,
          received_at: message.receivedAt,
          payload: JSON.stringify(message),
        })
        .onConflict((c) => c.columns(['equipment', 'scope', 'epoch', 'seq']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (row && message.kind === 'snapshot') {
        await trx
          .updateTable('ingest.state_anchor')
          .set({ superseded: true })
          .where('equipment', '=', equipment)
          .where('device_epoch', 'is', null)
          .where('superseded', '=', false)
          .where('arrival', '<', row.arrival)
          .execute();
      }
      return row && toAnchor(row);
    });
  }

  /**
   * Stores a fact under ADR-0015's rule: an older epoch is stale, a number already seen in the
   * current epoch is a duplicate, a newer epoch starts the stream over (closing the old epoch's
   * gaps), and a late number fills a recorded gap. Row, cursor and incident changes commit together.
   */
  async fact(input: FactInput, topic: string, now: Date): Promise<FactOutcome> {
    const { stream, message } = input;
    const { epoch, seq } = message;
    const cursor = this.#cursors.get(stream);
    if (cursor && epoch < cursor.epoch) return { status: 'stale' };
    if (cursor?.epoch === epoch && contains(cursor.seen, seq)) return { status: 'duplicate' };
    const result = await this.#db.transaction().execute(async (trx) => {
      const inserted = await this.#insertFact(trx, input, topic, now);
      let next: Cursor;
      if (!cursor || epoch > cursor.epoch) {
        if (cursor && tracksGaps(stream)) await this.#endEpoch(trx, stream, cursor, now);
        // A known stream's new epoch numbers from 1 (ADR-0015): a sentinel 0 makes 1..seq-1 a
        // hole, so facts lost at the start of a run are counted. A stream seen for the first time
        // starts at its first number: what came before is history, not a gap.
        next = { epoch, seen: cursor ? add([[0, 0]], seq) : [[seq, seq]], reported: [] };
      } else {
        next = { epoch, seen: add(cursor.seen, seq), reported: cursor.reported };
        if (contains(cursor.reported, seq)) await this.#fill(trx, stream, next, seq, now);
      }
      await trx
        .insertInto('ingest.source_cursor')
        .values({
          stream,
          epoch: next.epoch,
          seen: JSON.stringify(next.seen),
          reported: JSON.stringify(next.reported),
          updated_at: now,
        })
        .onConflict((c) =>
          c.column('stream').doUpdateSet({
            epoch: next.epoch,
            seen: JSON.stringify(next.seen),
            reported: JSON.stringify(next.reported),
            updated_at: now,
          }),
        )
        .execute();
      const notices: IngestNotice[] = [];
      if (input.kind === 'event') {
        // The next device fact tells which device epoch a waiting snapshot (one without
        // deviceEpoch, from an older gateway) belongs to.
        const attributed = await trx
          .updateTable('ingest.state_anchor')
          .set({ device_epoch: epoch })
          .where('equipment', '=', input.equipment)
          .where('device_epoch', 'is', null)
          .where('superseded', '=', false)
          .returningAll()
          .execute();
        notices.push(
          ...attributed.map((row) => ({ type: 'anchor' as const, anchor: toAnchor(row) })),
        );
      }
      await this.#beforeCommit?.(topic);
      return { inserted, next, notices };
    });
    this.#cursors.set(stream, result.next);
    // Already in the table, unknown to the cursor: a commit that failed on the way back but was
    // applied (ADR-0017). Its notices were never sent, so they go out now.
    if (!result.inserted) return { status: 'duplicate', notices: factNotices(input) };
    return { status: 'stored', notices: [...result.notices, ...factNotices(input)] };
  }

  /**
   * Records every hole that has stayed open for `graceMs` as a `sequence-gap` incident and writes
   * it off in the cursor (a late message still fills it). Returns the incidents recorded.
   */
  async sweep(now: number, graceMs: number): Promise<number> {
    let recorded = 0;
    for (const [stream, cursor] of this.#cursors) {
      if (!tracksGaps(stream)) continue;
      const open = holes(union(cursor.seen, cursor.reported));
      const known = this.#pending.get(stream);
      const previous = known?.epoch === cursor.epoch ? known.holes : [];
      const tracked = open.map((range) => ({
        range,
        since: Math.min(
          now,
          ...previous.filter((p) => overlaps(p.range, range)).map((p) => p.since),
        ),
      }));
      const due = tracked.filter((hole) => now - hole.since >= graceMs);
      this.#pending.set(stream, {
        epoch: cursor.epoch,
        holes: tracked.filter((hole) => !due.includes(hole)),
      });
      if (due.length === 0) continue;
      const reported = due.reduce<Range[]>(
        (acc, h) => add(acc, h.range[0], h.range[1]),
        [...cursor.reported],
      );
      await this.#db.transaction().execute(async (trx) => {
        for (const { range } of due) {
          await this.#gapIncident(trx, stream, cursor.epoch, range, new Date(now), {
            message: `${String(range[1] - range[0] + 1)} message(s) ${String(range[0])}-${String(range[1])} missing after ${String(graceMs)} ms`,
          });
        }
        await trx
          .updateTable('ingest.source_cursor')
          .set({ reported: JSON.stringify(reported), updated_at: new Date(now) })
          .where('stream', '=', stream)
          .execute();
      });
      this.#cursors.set(stream, { ...cursor, reported });
      recorded += due.length;
    }
    return recorded;
  }

  async #insertFact(
    trx: Transaction<Database>,
    input: FactInput,
    topic: string,
    now: Date,
  ): Promise<boolean> {
    const { message } = input;
    const common = {
      epoch: message.epoch,
      seq: message.seq,
      source_time: message.sourceTime,
      quality: message.quality,
      source_protocol: message.source.protocol,
      received_at: message.receivedAt,
      payload: JSON.stringify(message),
    };
    switch (input.kind) {
      case 'event': {
        const state = input.eventType === 'state' ? (input.message as StateEvent).value : null;
        const result = await trx
          .insertInto('ingest.equipment_event')
          .values({
            ...common,
            equipment: input.equipment,
            event_type: input.eventType,
            topic,
            state: state?.state ?? null,
            cause: state?.cause ?? null,
          })
          .onConflict((c) => c.columns(['equipment', 'epoch', 'seq', 'source_time']).doNothing())
          .executeTakeFirst();
        return result.numInsertedOrUpdatedRows === 1n;
      }
      case 'telemetry': {
        const result = await trx
          .insertInto('ingest.telemetry_sample')
          .values({
            ...common,
            topic,
            equipment: input.equipment,
            name: input.name,
            value: input.message.value,
            unit: input.message.unit,
          })
          .onConflict((c) => c.columns(['topic', 'epoch', 'seq', 'source_time']).doNothing())
          .executeTakeFirst();
        return result.numInsertedOrUpdatedRows === 1n;
      }
      case 'incident': {
        const value: Incident['value'] = input.message.value;
        const result = await trx
          .insertInto('ingest.data_quality_incident')
          .values({
            origin: 'gateway',
            type: value.type,
            stream: input.stream,
            epoch: message.epoch,
            seq_from: message.seq,
            seq_to: message.seq,
            equipment: value.equipment,
            lost: value.lost,
            message: value.message,
            source_time: message.sourceTime,
            detected_at: now,
            payload: JSON.stringify(input.message),
          })
          .onConflict((c) => c.columns(['origin', 'stream', 'epoch', 'seq_from']).doNothing())
          .executeTakeFirst();
        return result.numInsertedOrUpdatedRows === 1n;
      }
    }
  }

  /** A newer epoch: the old epoch's holes can no longer be filled. */
  async #endEpoch(
    trx: Transaction<Database>,
    stream: string,
    cursor: Cursor,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable('ingest.data_quality_incident')
      .set({ closed_at: now, resolution: 'epoch-ended' })
      .where('origin', '=', 'mes')
      .where('stream', '=', stream)
      .where('epoch', '=', cursor.epoch)
      .where('closed_at', 'is', null)
      .execute();
    for (const range of holes(union(cursor.seen, cursor.reported))) {
      await this.#gapIncident(trx, stream, cursor.epoch, range, now, {
        message: `${String(range[1] - range[0] + 1)} message(s) ${String(range[0])}-${String(range[1])} never arrived before a new epoch started`,
        closed: true,
      });
    }
    this.#pending.delete(stream);
  }

  /** A late message inside a recorded gap: fewer numbers lost, closed once none are. */
  async #fill(
    trx: Transaction<Database>,
    stream: string,
    next: Cursor,
    seq: number,
    now: Date,
  ): Promise<void> {
    const incidents = await trx
      .selectFrom('ingest.data_quality_incident')
      .select(['id', 'seq_from', 'seq_to'])
      .where('origin', '=', 'mes')
      .where('stream', '=', stream)
      .where('epoch', '=', next.epoch)
      .where('seq_from', '<=', seq)
      .where('seq_to', '>=', seq)
      .where('closed_at', 'is', null)
      .execute();
    for (const incident of incidents) {
      const lost = missing(next.seen, incident.seq_from, incident.seq_to);
      await trx
        .updateTable('ingest.data_quality_incident')
        .set(lost === 0 ? { lost, closed_at: now, resolution: 'filled' } : { lost })
        .where('id', '=', incident.id)
        .execute();
    }
  }

  async #gapIncident(
    trx: Transaction<Database>,
    stream: string,
    epoch: number,
    [from, to]: Range,
    now: Date,
    { message, closed = false }: { message: string; closed?: boolean },
  ): Promise<void> {
    await trx
      .insertInto('ingest.data_quality_incident')
      .values({
        origin: 'mes',
        type: 'sequence-gap',
        stream,
        epoch,
        seq_from: from,
        seq_to: to,
        equipment: streamEquipment(stream),
        lost: to - from + 1,
        message: `${stream} epoch ${String(epoch)}: ${message}`,
        source_time: null,
        detected_at: now,
        closed_at: closed ? now : null,
        resolution: closed ? 'epoch-ended' : null,
        payload: null,
      })
      .onConflict((c) => c.columns(['origin', 'stream', 'epoch', 'seq_from']).doNothing())
      .execute();
  }
}

function factNotices(input: FactInput): IngestNotice[] {
  const { message } = input;
  const sourceTime = new Date(message.sourceTime);
  if (input.kind === 'incident') return [];
  if (input.kind === 'event' && input.eventType === 'state') {
    const state = (input.message as StateEvent).value;
    return [
      {
        type: 'state',
        fact: {
          equipment: input.equipment,
          epoch: message.epoch,
          seq: message.seq,
          sourceTime,
          state: state.state,
          cause: state.cause,
          quality: message.quality,
        },
      },
    ];
  }
  return [
    {
      type: 'sample',
      sample: {
        equipment: input.equipment,
        kind: input.kind === 'telemetry' ? 'telemetry' : (input.eventType as 'cycle' | 'alarm'),
        scope: input.kind === 'telemetry' ? 'topic' : 'device',
        epoch: message.epoch,
        seq: message.seq,
        sourceTime,
      },
    },
  ];
}
