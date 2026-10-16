import {
  SYS_SEGMENT,
  UNS_ROOT,
  parseEquipmentTopic,
  type Alarm,
  type AlarmSnapshot,
  type CycleComplete,
  type Incident,
  type MachineState,
  type StateCurrent,
  type Status,
} from '@shopfloor/contracts';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import type { Classified, StateEvent } from './classify.ts';
import {
  add,
  contains,
  holes,
  missing,
  overlaps,
  settledThrough,
  union,
  type Range,
} from './ranges.ts';
import type {
  AlarmAnchorTable,
  AlarmSnapshotTable,
  RejectReason,
  StateAnchorTable,
} from './tables.ts';

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
  /**
   * The device epoch the value belongs to: a device fact's own epoch, a telemetry sample's
   * `deviceEpoch` (contract 1.1), or null for telemetry without it.
   */
  readonly deviceEpoch: number | null;
  /** A telemetry sample's metric, value and unit (for push, #97); absent for other facts. */
  readonly telemetry?: { readonly metric: string; readonly value: number; readonly unit: string };
}

/** An alarm transition as stored (#141): one device fact of `ingest.equipment_event`. */
export interface AlarmFact {
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  readonly sourceTime: Date;
  readonly code: string;
  readonly transition: 'active' | 'cleared';
  /** The wire severity, 1–1000. */
  readonly severity: number;
  readonly quality: 'good' | 'uncertain' | 'bad';
  /** When the gateway received it from the device (#142: the occurrence's history). */
  readonly receivedAt: Date;
  /** The device protocol it came through (`opcua`, `modbus`). */
  readonly protocol: string;
}

/**
 * A retained alarm delivery (#141, `ingest.alarm_anchor`): the device's own last fact for one
 * code, with its true epoch, `seq` and time; the highest `seq` per (equipment, epoch, code) is
 * kept. `stale`: its epoch is older than the newest one ingest knows for the equipment, so it is
 * never used.
 */
export interface AlarmAnchor {
  readonly equipment: string;
  readonly epoch: number;
  readonly code: string;
  readonly seq: number;
  readonly transition: 'active' | 'cleared';
  readonly severity: number;
  readonly sourceTime: Date;
  readonly stale: boolean;
}

/**
 * The latest alarm snapshot of one (equipment, device epoch) (#141, `ingest.alarm_snapshot`): the
 * codes active at device sequence `asOfSeq`, read on a gateway resync. `stale` as for anchors.
 */
export interface StoredAlarmSnapshot {
  readonly equipment: string;
  readonly deviceEpoch: number;
  readonly asOfSeq: number;
  /** Sorted, without duplicates. */
  readonly active: readonly string[];
  /** A simulation time at which the bits held (OPC UA: fact asOfSeq's; Modbus: the read's). */
  readonly sourceTime: Date;
  readonly stale: boolean;
}

export function toAlarmAnchor(row: Selectable<AlarmAnchorTable>): AlarmAnchor {
  return {
    equipment: row.equipment,
    epoch: row.epoch,
    code: row.code,
    seq: row.seq,
    transition: row.transition,
    severity: row.severity,
    sourceTime: row.source_time,
    stale: row.stale,
  };
}

export function toAlarmSnapshot(row: Selectable<AlarmSnapshotTable>): StoredAlarmSnapshot {
  return {
    equipment: row.equipment,
    deviceEpoch: row.device_epoch,
    asOfSeq: row.as_of_seq,
    active: row.active,
    sourceTime: row.source_time,
    stale: row.stale,
  };
}

/** A completed cycle as stored (#118): what changes `ingest.cycle_hourly`. */
export interface StoredCycle {
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  readonly sourceTime: Date;
  readonly product: string;
  readonly result: 'good' | 'scrap' | 'rework';
}

/**
 * What a committed message adds, for listeners (sent after commit). Device facts (state, cycle,
 * alarm) carry `settledSeq`: the highest `seq` of their device stream's epoch with no open gap at
 * or below it, a gap already reported as an incident counting as closed (#113). `gaps` says that
 * reported gaps moved it without a new fact. A cycle also sends `cycle` (after its `sample`), and
 * the first fact of a device stream's new epoch sends `epoch` first, with its time, which may lie
 * anywhere relative to the older epochs' (#118).
 */
export type IngestNotice =
  | { readonly type: 'state'; readonly fact: StateFact; readonly settledSeq: number | null }
  | { readonly type: 'anchor'; readonly anchor: StateAnchor }
  | {
      readonly type: 'sample';
      readonly sample: StoredSample;
      /** Device facts only (cycles and alarms); absent for telemetry. */
      readonly settledSeq?: number | null;
    }
  | {
      readonly type: 'gaps';
      readonly equipment: string;
      readonly epoch: number;
      readonly settledSeq: number | null;
    }
  | { readonly type: 'cycle'; readonly cycle: StoredCycle }
  /** A stored alarm transition (#141), after its `sample`. */
  | { readonly type: 'alarm'; readonly fact: AlarmFact; readonly settledSeq: number | null }
  /** A retained alarm delivery stored or raised to a higher `seq` (#141); may be `stale`. */
  | { readonly type: 'alarm-anchor'; readonly anchor: AlarmAnchor }
  /** An alarm snapshot stored or raised to a higher `asOfSeq` (#141); may be `stale`. */
  | { readonly type: 'alarm-snapshot'; readonly snapshot: StoredAlarmSnapshot }
  /**
   * A newer device epoch of `equipment` arrived (fact, state anchor, alarm anchor or snapshot):
   * these alarm anchors and snapshots of older epochs became stale (#141).
   */
  | {
      readonly type: 'alarm-stale';
      readonly equipment: string;
      /** The newer epoch. */
      readonly epoch: number;
      readonly anchors: readonly { readonly epoch: number; readonly code: string }[];
      readonly snapshots: readonly number[];
    }
  | {
      readonly type: 'epoch';
      readonly equipment: string;
      readonly epoch: number;
      /** The stream's epoch before, null for a stream seen for the first time. */
      readonly previous: number | null;
      /** The `sourceTime` of the epoch's first fact to arrive. */
      readonly sourceTime: Date;
    };

/** One `sequence-gap` incident of a device stream, placed in time by the facts around it (#113). */
export interface GapIncident {
  readonly id: number;
  readonly seqFrom: number;
  readonly seqTo: number;
  /** `sourceTime` of the fact just before the gap by `seq`; null when none is stored. */
  readonly after: Date | null;
  /** `sourceTime` of the fact just after the gap by `seq`; null when none is stored. */
  readonly before: Date | null;
}

/** What the equipment module needs to know which pieces may still change (#113). */
export interface SettledState {
  /** Highest `seq` with no open gap at or below it; null when the stream is not in this epoch. */
  readonly settledSeq: number | null;
  /** The latest `sourceTime` of a device fact with `seq` up to `settledSeq` (above `afterSeq`). */
  readonly settledTime: Date | null;
  /** The epoch's `sequence-gap` incidents, open or closed. */
  readonly incidents: readonly GapIncident[];
}

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
  ): Promise<{ anchor: StateAnchor | undefined; notices: IngestNotice[] }> {
    const deviceEpoch = message.kind === 'event' ? message.epoch : (message.deviceEpoch ?? null);
    return this.#db.transaction().execute(async (trx) => {
      // A state anchor of a newer device epoch makes older alarm anchors and snapshots stale (#141).
      const notices =
        deviceEpoch === null ? [] : await this.#staleBefore(trx, equipment, deviceEpoch);
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
      return { anchor: row && toAnchor(row), notices };
    });
  }

  /**
   * Stores a retained alarm delivery as an anchor (#141): the highest `seq` per (equipment, epoch,
   * code) wins; a lower or equal one changes nothing. Its epoch is the device's (alarms are scope
   * device). Never a fact: no dedup, no gaps, no cursor. Stale when its epoch is older than the
   * newest one known for the equipment; a newer one makes older anchors and snapshots stale.
   */
  async alarmAnchor(equipment: string, message: Alarm): Promise<IngestNotice[]> {
    return this.#db.transaction().execute(async (trx) => {
      const newest = await this.#newestEpoch(trx, equipment);
      const stale = newest !== null && message.epoch < newest;
      const values = {
        seq: message.seq,
        transition: message.value.transition,
        severity: message.value.severity,
        source_time: message.sourceTime,
        quality: message.quality,
        received_at: message.receivedAt,
        stale,
        payload: JSON.stringify(message),
      };
      const row = await trx
        .insertInto('ingest.alarm_anchor')
        .values({ ...values, equipment, epoch: message.epoch, code: message.value.code })
        .onConflict((c) =>
          c
            .columns(['equipment', 'epoch', 'code'])
            .doUpdateSet({ ...values, ingested_at: new Date() })
            .whereRef('ingest.alarm_anchor.seq', '<', 'excluded.seq'),
        )
        .returningAll()
        .executeTakeFirst();
      const notices = stale ? [] : await this.#staleBefore(trx, equipment, message.epoch);
      if (row) notices.push({ type: 'alarm-anchor', anchor: toAlarmAnchor(row) });
      return notices;
    });
  }

  /**
   * Stores the gateway's alarm snapshot (#141): the highest `asOfSeq` per (equipment, device epoch)
   * wins. It never enters the device stream's dedup or gap checks (ADR-0017 amendment): `asOfSeq`
   * only orders it against the device's facts and anchors. Stale by the same rule as anchors.
   */
  async alarmSnapshot(equipment: string, message: AlarmSnapshot): Promise<IngestNotice[]> {
    return this.#db.transaction().execute(async (trx) => {
      const newest = await this.#newestEpoch(trx, equipment);
      const stale = newest !== null && message.deviceEpoch < newest;
      const values = {
        as_of_seq: message.asOfSeq,
        active: [...new Set(message.value.active)].sort(),
        epoch: message.epoch,
        seq: message.seq,
        source_time: message.sourceTime,
        quality: message.quality,
        source_protocol: message.source.protocol,
        received_at: message.receivedAt,
        stale,
        payload: JSON.stringify(message),
      };
      const row = await trx
        .insertInto('ingest.alarm_snapshot')
        .values({ ...values, equipment, device_epoch: message.deviceEpoch })
        .onConflict((c) =>
          c
            .columns(['equipment', 'device_epoch'])
            .doUpdateSet({ ...values, ingested_at: new Date() })
            .whereRef('ingest.alarm_snapshot.as_of_seq', '<', 'excluded.as_of_seq'),
        )
        .returningAll()
        .executeTakeFirst();
      const notices = stale ? [] : await this.#staleBefore(trx, equipment, message.deviceEpoch);
      if (row) notices.push({ type: 'alarm-snapshot', snapshot: toAlarmSnapshot(row) });
      return notices;
    });
  }

  /**
   * The newest device epoch ingest knows for an equipment, from any fact (the device stream's
   * cursor: older epochs are refused), state anchor, alarm anchor or alarm snapshot; null if none.
   */
  async #newestEpoch(trx: Transaction<Database>, equipment: string): Promise<number | null> {
    const stream = `device:${equipment}`;
    const result = await sql<{ newest: number | null }>`
      SELECT GREATEST(
        (SELECT epoch FROM ingest.source_cursor WHERE stream = ${stream}),
        (SELECT max(device_epoch) FROM ingest.state_anchor WHERE equipment = ${equipment}),
        (SELECT max(epoch) FROM ingest.alarm_anchor WHERE equipment = ${equipment}),
        (SELECT max(device_epoch) FROM ingest.alarm_snapshot WHERE equipment = ${equipment})
      ) AS newest`.execute(trx);
    return result.rows[0]?.newest ?? null;
  }

  /** Device epoch `epoch` is known: alarm anchors and snapshots of older ones become stale (#141). */
  async #staleBefore(
    trx: Transaction<Database>,
    equipment: string,
    epoch: number,
  ): Promise<IngestNotice[]> {
    const anchors = await trx
      .updateTable('ingest.alarm_anchor')
      .set({ stale: true })
      .where('equipment', '=', equipment)
      .where('epoch', '<', epoch)
      .where('stale', '=', false)
      .returning(['epoch', 'code'])
      .execute();
    const snapshots = await trx
      .updateTable('ingest.alarm_snapshot')
      .set({ stale: true })
      .where('equipment', '=', equipment)
      .where('device_epoch', '<', epoch)
      .where('stale', '=', false)
      .returning('device_epoch')
      .execute();
    if (anchors.length === 0 && snapshots.length === 0) return [];
    return [
      {
        type: 'alarm-stale',
        equipment,
        epoch,
        anchors: anchors.map((a) => ({ epoch: a.epoch, code: a.code })),
        snapshots: snapshots.map((row) => row.device_epoch),
      },
    ];
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
    const epochNotices: IngestNotice[] =
      (!cursor || epoch > cursor.epoch) && stream.startsWith('device:')
        ? [
            {
              type: 'epoch',
              equipment: stream.slice('device:'.length),
              epoch,
              previous: cursor?.epoch ?? null,
              sourceTime: new Date(message.sourceTime),
            },
          ]
        : [];
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
      if ((!cursor || epoch > cursor.epoch) && stream.startsWith('device:')) {
        // The first fact of a newer device epoch: older alarm anchors and snapshots of the
        // equipment are stale from now on (#141).
        notices.push(...(await this.#staleBefore(trx, stream.slice('device:'.length), epoch)));
      }
      if (cursor && epoch > cursor.epoch && stream.startsWith('device:')) {
        // The old epoch's open gaps became incidents (`epoch-ended`): a closed epoch's final
        // hours carry them too (#113).
        notices.push({
          type: 'gaps',
          equipment: stream.slice('device:'.length),
          epoch: cursor.epoch,
          settledSeq: null,
        });
      }
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
    const settledSeq = settledThrough(result.next.seen, result.next.reported);
    // Already in the table, unknown to the cursor: a commit that failed on the way back but was
    // applied (ADR-0017). Its notices were never sent, so they go out now, with the anchor that
    // commit may have attributed to this epoch (listeners treat a known anchor as a no-op).
    if (!result.inserted) {
      const anchor =
        input.kind === 'event' ? await this.#firstAnchor(input.equipment, epoch) : undefined;
      return {
        status: 'duplicate',
        notices: [
          ...epochNotices,
          ...(anchor ? [{ type: 'anchor' as const, anchor }] : []),
          ...factNotices(input, settledSeq),
        ],
      };
    }
    return {
      status: 'stored',
      notices: [...epochNotices, ...result.notices, ...factNotices(input, settledSeq)],
    };
  }

  /**
   * Records every hole that has stayed open for `graceMs` as a `sequence-gap` incident and writes
   * it off in the cursor (a late message still fills it); the numbers below a stream's first one
   * are written off the same way, without an incident. Returns the incidents recorded, and a
   * `gaps` notice per device stream whose settled part moved.
   */
  async sweep(
    now: number,
    graceMs: number,
  ): Promise<{
    recorded: number;
    notices: IngestNotice[];
    /** Numbers below a stream's first one, written off as history (no incident). */
    history: { stream: string; epoch: number; from: number; to: number }[];
  }> {
    let recorded = 0;
    const written: { stream: string; epoch: number; from: number; to: number }[] = [];
    const notices: IngestNotice[] = [];
    for (const [stream, cursor] of this.#cursors) {
      if (!tracksGaps(stream)) continue;
      const merged = union(cursor.seen, cursor.reported);
      const open = holes(merged);
      // A stream seen for the first time started above 1: the numbers below are history, not a
      // gap, but they may still be in flight (a reordered replay). They hold finality back for
      // the grace period too, then are written off without an incident (#113).
      const floor = merged[0]?.[0] ?? 1;
      const history: Range | undefined = floor > 1 ? [1, floor - 1] : undefined;
      if (history) open.unshift(history);
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
      const gaps = due.filter((hole) => hole.range !== history);
      await this.#db.transaction().execute(async (trx) => {
        for (const { range } of gaps) {
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
      recorded += gaps.length;
      if (history && due.some((hole) => hole.range === history)) {
        written.push({ stream, epoch: cursor.epoch, from: history[0], to: history[1] });
      }
      if (stream.startsWith('device:')) {
        notices.push({
          type: 'gaps',
          equipment: stream.slice('device:'.length),
          epoch: cursor.epoch,
          settledSeq: settledThrough(cursor.seen, reported),
        });
      }
    }
    return { recorded, notices, history: written };
  }

  /**
   * The settled part of one equipment's device stream in a device epoch (#113): the highest `seq`
   * with no open gap at or below it, the latest fact time up to it (only facts above `afterSeq`,
   * when given, are read), and the epoch's gap incidents with the times around them. Read from the
   * tables, so it holds before `load` and in any process.
   */
  async settled(equipment: string, epoch: number, afterSeq?: number): Promise<SettledState> {
    const stream = `device:${equipment}`;
    const cursor = await this.#db
      .selectFrom('ingest.source_cursor')
      .select(['epoch', 'seen', 'reported'])
      .where('stream', '=', stream)
      .executeTakeFirst();
    const settledSeq =
      cursor?.epoch === epoch ? settledThrough(cursor.seen, cursor.reported) : null;
    const events = () =>
      this.#db
        .selectFrom('ingest.equipment_event')
        .where('equipment', '=', equipment)
        .where('epoch', '=', epoch);
    let settledTime: Date | null = null;
    if (settledSeq !== null) {
      let query = events()
        .select((eb) => eb.fn.max<Date | null>('source_time').as('t'))
        .where('seq', '<=', settledSeq);
      if (afterSeq !== undefined) query = query.where('seq', '>', afterSeq);
      settledTime = (await query.executeTakeFirstOrThrow()).t;
    }
    // The fact just before and just after the gap by seq; either may be missing (null).
    const time = sql<Date | null>`source_time`.as('t');
    const rows = await this.#db
      .selectFrom('ingest.data_quality_incident')
      .select(['id', 'seq_from', 'seq_to'])
      .select((eb) => [
        events()
          .select(time)
          .where('seq', '<', eb.ref('seq_from'))
          .orderBy('seq', 'desc')
          .limit(1)
          .$asScalar()
          .as('after'),
        events()
          .select(time)
          .where('seq', '>', eb.ref('seq_to'))
          .orderBy('seq')
          .limit(1)
          .$asScalar()
          .as('before'),
      ])
      .where('origin', '=', 'mes')
      .where('type', '=', 'sequence-gap')
      .where('stream', '=', stream)
      .where('epoch', '=', epoch)
      .orderBy('seq_from')
      .execute();
    return {
      settledSeq,
      settledTime,
      incidents: rows.map((row) => ({
        id: row.id,
        seqFrom: row.seq_from,
        seqTo: row.seq_to,
        after: row.after,
        before: row.before,
      })),
    };
  }

  async #firstAnchor(equipment: string, deviceEpoch: number): Promise<StateAnchor | undefined> {
    const row = await this.#db
      .selectFrom('ingest.state_anchor')
      .selectAll()
      .where('equipment', '=', equipment)
      .where('device_epoch', '=', deviceEpoch)
      .where('superseded', '=', false)
      .orderBy('arrival')
      .limit(1)
      .executeTakeFirst();
    return row && toAnchor(row);
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

function factNotices(input: FactInput, settledSeq: number | null): IngestNotice[] {
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
        settledSeq,
      },
    ];
  }
  const cycle: IngestNotice[] =
    input.kind === 'event' && input.eventType === 'cycle'
      ? [
          {
            type: 'cycle',
            cycle: {
              equipment: input.equipment,
              epoch: message.epoch,
              seq: message.seq,
              sourceTime,
              product: (input.message as CycleComplete).value.product,
              result: (input.message as CycleComplete).value.result,
            },
          },
        ]
      : [];
  const alarm: IngestNotice[] =
    input.kind === 'event' && input.eventType === 'alarm'
      ? [
          {
            type: 'alarm',
            fact: {
              equipment: input.equipment,
              epoch: message.epoch,
              seq: message.seq,
              sourceTime,
              code: (input.message as Alarm).value.code,
              transition: (input.message as Alarm).value.transition,
              severity: (input.message as Alarm).value.severity,
              quality: message.quality,
              receivedAt: new Date(message.receivedAt),
              protocol: message.source.protocol,
            },
            settledSeq,
          },
        ]
      : [];
  return [
    {
      type: 'sample',
      ...(input.kind === 'telemetry' ? {} : { settledSeq }),
      sample: {
        equipment: input.equipment,
        kind: input.kind === 'telemetry' ? 'telemetry' : (input.eventType as 'cycle' | 'alarm'),
        scope: input.kind === 'telemetry' ? 'topic' : 'device',
        epoch: message.epoch,
        seq: message.seq,
        sourceTime,
        deviceEpoch:
          input.kind === 'telemetry' ? (input.message.deviceEpoch ?? null) : message.epoch,
        ...(input.kind === 'telemetry'
          ? {
              telemetry: {
                metric: input.name,
                value: input.message.value,
                unit: input.message.unit,
              },
            }
          : {}),
      },
    },
    ...cycle,
    ...alarm,
  ];
}
