import { HOUR, type Millis } from '@shopfloor/oee-core';
import { shiftCuts, type ShiftPattern } from '@shopfloor/shift-calendar';
import { sql, type Kysely, type QueryCreator, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import type {
  FactSummary,
  GapIncident,
  IngestNotice,
  SettledState,
  StateAnchor,
  StateFact,
  StoredSample,
} from '../ingest/index.ts';
import { clamp, cutPieces, monotonic, type Piece, type Point } from './pieces.ts';

/** What the equipment module needs from ingest (`Ingest` implements it). */
export interface StateSource {
  onStored(listener: (notice: IngestNotice) => void | Promise<void>): () => void;
  stateFacts(
    equipment: string,
    epoch: number,
    window?: { readonly fromSeq?: number; readonly toSeq?: number },
  ): Promise<StateFact[]>;
  stateFactWindow(equipment: string, epoch: number, seq: number): Promise<StateFact[]>;
  stateFactCount(equipment: string, epoch: number): Promise<number>;
  latestStateTime(equipment: string, epoch: number, beforeSeq: number): Promise<Date | null>;
  anchor(equipment: string, deviceEpoch: number): Promise<StateAnchor | undefined>;
  anchors(): Promise<StateAnchor[]>;
  factSummary(): Promise<FactSummary[]>;
  settled(equipment: string, epoch: number, afterSeq?: number): Promise<SettledState>;
}

export interface EquipmentLog {
  info(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface EquipmentOptions {
  readonly db: Kysely<Database>;
  /**
   * The pool for the API's reads (`intervals`, `shiftTotals`); default `db`. A separate pool keeps
   * dashboard reads from waiting in front of the writes on ingest's acknowledgement path.
   */
  readonly readDb?: Kysely<Database>;
  readonly source: StateSource;
  readonly shiftPattern: ShiftPattern;
  /**
   * How far (simulation ms) the plant watermark must move before an open interval is stored
   * again, unless it passes an hour or shift boundary first (default 60 s, one wall second at
   * 60×). A new fact always stores the exact watermark.
   */
  readonly provisionalStepMs?: number;
  readonly log?: EquipmentLog;
}

/** The latest known state of one equipment, in its newest device epoch. */
export interface CurrentState {
  readonly equipment: string;
  readonly epoch: number;
  readonly state: string;
  readonly cause: string | null;
  /** When this state began (the fact's or anchor's `sourceTime`). */
  readonly since: Date;
  /** The fact's `seq`; null when only the anchor is known. */
  readonly seq: number | null;
  /** The plant watermark the open interval is stored up to, if any. */
  readonly until: Date | null;
}

/** One stored piece of a state interval. */
export interface StoredInterval {
  readonly equipment: string;
  readonly epoch: number;
  readonly start: Date;
  readonly end: Date;
  readonly state: string;
  readonly cause: string | null;
  readonly hour: Date;
  readonly shiftKey: string;
  readonly provisional: boolean;
  readonly intervalStart: Date;
  readonly startSeq: number | null;
}

/** Time per state in one shift bucket. */
export interface ShiftTotal {
  readonly equipment: string;
  readonly epoch: number;
  readonly state: string;
  readonly ms: number;
  /** The part of `ms` in provisional pieces: what may still change (#113). */
  readonly provisionalMs: number;
  /**
   * The bucket's revision for this (equipment, epoch): how often one of its hours changed after
   * it was final (the highest count among its hours); 0 while unchanged.
   */
  readonly revision: number;
  /** Sequence-gap incidents of the equipment's device stream over the bucket's final hours. */
  readonly incidents: number;
}

/** Sent after the stored intervals of one (equipment, epoch) changed. */
export interface EquipmentChange {
  readonly equipment: string;
  readonly epoch: number;
  /** The changed range of stored pieces: [from, to), to null meaning open-ended. */
  readonly from: Date | null;
  readonly to: Date | null;
  /** The equipment's current state after the change. */
  readonly current: CurrentState | undefined;
}

/** Per (equipment, epoch): what is known and stored. */
interface Track {
  readonly equipment: string;
  readonly epoch: number;
  /** The latest point by `seq` (clamped time), or the anchor when no fact is known. */
  last: Point | undefined;
  anchor: StateAnchor | undefined;
  facts: number;
  lastSeq: number | null;
  /** A newer epoch of the equipment exists: the last interval is final, at the watermark. */
  closed: boolean;
  /** Where a newer epoch closed it: the epoch's watermark then, never moved afterwards. */
  closedAt: Millis | undefined;
  clamped: boolean;
  /** Start of the last stored piece of the open interval, if one is stored. */
  tailStart: Millis | undefined;
  /** End of the stored open interval. */
  stored: Millis | undefined;
  /** First hour or shift boundary after `stored`. */
  nextCut: Millis;
  /** Highest `seq` of the device stream with no open gap at or below it (#113); null: unknown. */
  settledSeq: number | null;
  /** The latest fact time up to `settledSeq`: pieces ending at or before it are final. */
  finalThrough: Millis;
  /** Every hour before this has its `bucket_finality` row (Infinity once closed and recorded). */
  finalEnd: Millis;
  /** No stored provisional piece ends before this (a lower bound; -Infinity when unknown). */
  promoteAt: Millis;
  /** The epoch's gap incidents, placed in time. */
  incidents: readonly IncidentSpan[];
}

/** A gap incident's time span: the missing facts lie between `from` and `to`. */
interface IncidentSpan {
  readonly id: number;
  readonly from: Millis;
  readonly to: Millis;
}

const spans = (incidents: readonly GapIncident[]): IncidentSpan[] =>
  incidents.map((incident) => ({
    id: incident.id,
    from: incident.after?.getTime() ?? -Infinity,
    to: incident.before?.getTime() ?? Infinity,
  }));

const hourOf = (at: Millis): Millis => Math.floor(at / HOUR) * HOUR;

/** The fields #113 adds to a new track: nothing settled or recorded yet. */
const UNSETTLED = {
  settledSeq: null,
  finalThrough: -Infinity,
  finalEnd: -Infinity,
  promoteAt: -Infinity,
  incidents: [],
} as const;

const INSERT_CHUNK = 1_000;
const DAY = 24 * HOUR;

const silent: EquipmentLog = { info: () => undefined, error: () => undefined };

const factPoint = (fact: StateFact): Point => ({
  at: fact.sourceTime.getTime(),
  state: fact.state,
  cause: fact.cause,
  seq: fact.seq,
});

const anchorPoint = (anchor: StateAnchor): Point => ({
  at: anchor.sourceTime.getTime(),
  state: anchor.state,
  cause: anchor.cause,
  seq: null,
});

/** The anchor opens the first interval only when no fact precedes it (plan "Ingest"). */
const withAnchor = (anchor: StateAnchor | undefined, facts: readonly Point[]): Point[] => {
  const first = facts[0];
  return anchor && (!first || anchor.sourceTime.getTime() < first.at)
    ? [anchorPoint(anchor), ...facts]
    : [...facts];
};

/**
 * The `equipment` module (#96): state intervals from ingest's state facts, each stored piece
 * inside one UTC hour and one shift bucket (`equipment.equipment_state_interval`).
 *
 * - Per (equipment, device epoch), an interval runs from one fact (or the anchor, when no fact
 *   precedes it) to the next by `seq`, on `sourceTime`.
 * - The open interval is stored up to the plant watermark (the latest `sourceTime` of any device
 *   in that epoch), flagged provisional, and replaced when the next fact arrives. A newer epoch
 *   of the equipment closes it for good at the old epoch's watermark (ADR-0018).
 * - A fact changes only the window between its neighbours by `seq`, recomputed from ingest's
 *   tables and replaced in one transaction: reordering, duplicates and replays change nothing.
 * - Notices are the fast path. At start-up, and for anything whose handling failed, the module
 *   compares `interval_source` with ingest's tables and recomputes what differs.
 */
export class Equipment {
  readonly #db: Kysely<Database>;
  readonly #readDb: Kysely<Database>;
  readonly #source: StateSource;
  readonly #pattern: ShiftPattern;
  readonly #step: number;
  readonly #log: EquipmentLog;
  readonly #tracks = new Map<string, Map<number, Track>>();
  readonly #watermarks = new Map<number, Millis>();
  readonly #dirty = new Set<Track>();
  readonly #listeners = new Set<(change: EquipmentChange) => void>();
  #queue: Promise<unknown> = Promise.resolve();
  /** Shift cuts of [from, until + 8 days), for `#nextCut` with `after` in [from, until). */
  #cuts: { from: Millis; until: Millis; cuts: Millis[] } = { from: 0, until: 0, cuts: [] };
  #unsubscribe: (() => void) | undefined;

  constructor(options: EquipmentOptions) {
    this.#db = options.db;
    this.#readDb = options.readDb ?? options.db;
    this.#source = options.source;
    this.#pattern = options.shiftPattern;
    this.#step = options.provisionalStepMs ?? 60_000;
    this.#log = options.log ?? silent;
  }

  /** Catches up from the tables, then follows ingest's notices (queued behind the catch-up). */
  async start(): Promise<void> {
    const caughtUp = this.#enqueue(() => this.#catchUp());
    this.#unsubscribe = this.#source.onStored((notice) =>
      this.#enqueue(() => this.#handle(notice)),
    );
    await caughtUp;
  }

  /** Stops following notices and waits for the work in hand. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#queue.catch(() => undefined);
  }

  /** Stores every open interval up to the exact watermark (a provisional step may lag). */
  async flush(): Promise<void> {
    await this.#enqueue(async () => {
      for (const track of this.#allTracks()) {
        const watermark = this.#watermarks.get(track.epoch);
        if (!track.closed && track.last && watermark !== undefined && watermark !== track.stored) {
          await this.#rewriteTail(track, false);
        }
      }
    });
  }

  /** Listens for changed intervals and states (for WebSocket push, #97). Returns an unsubscribe. */
  onChange(listener: (change: EquipmentChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The current state of every equipment the module has seen, by equipment id. */
  currentStates(): CurrentState[] {
    return [...this.#tracks.keys()]
      .sort()
      .map((equipment) => this.#current(equipment))
      .filter((state) => state !== undefined);
  }

  currentState(equipment: string): CurrentState | undefined {
    return this.#current(equipment);
  }

  /** The plant watermark of a device epoch: the latest `sourceTime` seen in it. */
  watermark(epoch: number): Date | undefined {
    const watermark = this.#watermarks.get(epoch);
    return watermark === undefined ? undefined : new Date(watermark);
  }

  /** Every device epoch's watermark, the newest epoch first (the plant clock, #97). */
  watermarks(): { readonly epoch: number; readonly watermark: Date }[] {
    return [...this.#watermarks]
      .sort(([a], [b]) => b - a)
      .map(([epoch, watermark]) => ({ epoch, watermark: new Date(watermark) }));
  }

  /** Stored pieces of one equipment overlapping [from, to), by time (and epoch), up to `limit`. */
  async intervals(
    equipment: string,
    from: Date,
    to: Date,
    options: { readonly epoch?: number; readonly limit?: number } = {},
  ): Promise<StoredInterval[]> {
    let query = this.#readDb
      .selectFrom('equipment.equipment_state_interval')
      .selectAll()
      .where('equipment', '=', equipment)
      // Pieces never exceed an hour: this bound lets the index on start_time do the work.
      .where('start_time', '>', new Date(from.getTime() - HOUR))
      .where('start_time', '<', to)
      .where('end_time', '>', from);
    if (options.epoch !== undefined) query = query.where('epoch', '=', options.epoch);
    if (options.limit !== undefined) query = query.limit(options.limit);
    const rows = await query.orderBy('start_time').orderBy('epoch').execute();
    return rows.map((row) => ({
      equipment: row.equipment,
      epoch: row.epoch,
      start: row.start_time,
      end: row.end_time,
      state: row.state,
      cause: row.cause,
      hour: row.hour,
      shiftKey: row.shift_key,
      provisional: row.provisional,
      intervalStart: row.interval_start,
      startSeq: row.start_seq,
    }));
  }

  /** Time per state in one shift bucket (`2026-10-12/A`, or `no-shift`), per equipment and epoch. */
  async shiftTotals(
    shiftKey: string,
    options: { readonly equipment?: string; readonly epoch?: number } = {},
  ): Promise<ShiftTotal[]> {
    const ms = sql<string>`sum(extract(epoch from end_time - start_time) * 1000)::bigint`;
    let query = this.#readDb
      .selectFrom('equipment.equipment_state_interval')
      .select([
        'equipment',
        'epoch',
        'state',
        ms.as('ms'),
        sql<string>`coalesce(sum(extract(epoch from end_time - start_time) * 1000) FILTER (WHERE provisional), 0)::bigint`.as(
          'provisional_ms',
        ),
      ])
      .where('shift_key', '=', shiftKey);
    if (options.equipment !== undefined) query = query.where('equipment', '=', options.equipment);
    if (options.epoch !== undefined) query = query.where('epoch', '=', options.epoch);
    const rows = await query
      .groupBy(['equipment', 'epoch', 'state'])
      .orderBy('equipment')
      .orderBy('epoch')
      .orderBy('state')
      .execute();
    // Per (equipment, epoch): the highest revision and the distinct incidents of the bucket's hours.
    const filters = [
      sql`p.shift_key = ${shiftKey}`,
      ...(options.equipment === undefined ? [] : [sql`p.equipment = ${options.equipment}`]),
      ...(options.epoch === undefined ? [] : [sql`p.epoch = ${options.epoch}`]),
    ];
    const buckets = await sql<{
      equipment: string;
      epoch: number;
      revision: number;
      incidents: number;
    }>`
      SELECT f.equipment, f.epoch, max(f.revision) AS revision, count(DISTINCT i.id) AS incidents
      FROM equipment.bucket_finality f
      LEFT JOIN LATERAL unnest(f.incident_ids) AS i(id) ON true
      WHERE (f.equipment, f.epoch, f.hour) IN (
        SELECT DISTINCT p.equipment, p.epoch, p.hour FROM equipment.equipment_state_interval p
        WHERE ${sql.join(filters, sql` AND `)})
      GROUP BY f.equipment, f.epoch`.execute(this.#readDb);
    const key = (equipment: string, epoch: number): string => `${equipment}\u0000${String(epoch)}`;
    const bucketOf = new Map(buckets.rows.map((b) => [key(b.equipment, b.epoch), b]));
    return rows.map((row) => {
      const bucket = bucketOf.get(key(row.equipment, row.epoch));
      return {
        equipment: row.equipment,
        epoch: row.epoch,
        state: row.state,
        ms: Number(row.ms),
        provisionalMs: Number(row.provisional_ms),
        revision: bucket?.revision ?? 0,
        incidents: bucket?.incidents ?? 0,
      };
    });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #handle(notice: IngestNotice): Promise<void> {
    await this.#retryDirty();
    let track: Track | undefined;
    try {
      switch (notice.type) {
        case 'state':
          track = await this.#track(notice.fact.equipment, notice.fact.epoch);
          await this.#onState(track, notice.fact, notice.settledSeq);
          break;
        case 'anchor':
          if (notice.anchor.deviceEpoch === null) return;
          track = await this.#track(notice.anchor.equipment, notice.anchor.deviceEpoch);
          await this.#onAnchor(track, notice.anchor);
          break;
        case 'sample':
          await this.#onSample(notice.sample, notice.settledSeq);
          break;
        case 'gaps':
          track = this.#tracks.get(notice.equipment)?.get(notice.epoch);
          if (!track) return;
          if (track.closed) {
            // The epoch ended with gaps (`epoch-ended` incidents): its final hours carry them.
            await this.#setIncidents(
              track,
              (await this.#source.settled(track.equipment, track.epoch)).incidents,
            );
            return;
          }
          if (await this.#learn(track, notice.settledSeq)) await this.#verifyFacts(track, 0);
          await this.#settle(track);
          break;
      }
    } catch (error) {
      // Recomputed in full before the next notice (or at the next start-up).
      if (track) this.#dirty.add(track);
      this.#log.error({ err: error, notice: notice.type }, 'equipment intervals not updated');
    }
  }

  async #retryDirty(): Promise<void> {
    for (const track of [...this.#dirty]) {
      try {
        await this.#rebuild(track);
        this.#dirty.delete(track);
      } catch (error) {
        this.#log.error({ err: error, equipment: track.equipment }, 'recompute failed');
        return;
      }
    }
  }

  /** The track of (equipment, epoch); a newer epoch closes the equipment's older ones. */
  async #track(equipment: string, epoch: number): Promise<Track> {
    let byEpoch = this.#tracks.get(equipment);
    if (!byEpoch) {
      byEpoch = new Map();
      this.#tracks.set(equipment, byEpoch);
    }
    const existing = byEpoch.get(epoch);
    if (existing) return existing;
    const newest = Math.max(...byEpoch.keys());
    const track: Track = {
      equipment,
      epoch,
      last: undefined,
      anchor: undefined,
      facts: 0,
      lastSeq: null,
      closed: epoch < newest,
      closedAt: epoch < newest ? this.#watermarks.get(epoch) : undefined,
      clamped: false,
      tailStart: undefined,
      stored: undefined,
      nextCut: -Infinity,
      ...UNSETTLED,
    };
    byEpoch.set(epoch, track);
    for (const older of byEpoch.values()) {
      if (older.epoch < epoch && !older.closed) await this.#close(older);
    }
    return track;
  }

  /**
   * A newer epoch started: the old one's open interval becomes final at its watermark, and so
   * does every hour of it (#113: a closed epoch is final everywhere).
   */
  async #close(track: Track): Promise<void> {
    track.closed = true;
    track.closedAt = this.#watermarks.get(track.epoch);
    if (track.last) {
      await this.#rewriteTail(track, true);
    } else {
      await this.#db.transaction().execute((trx) => this.#saveSource(trx, track));
    }
    await this.#setIncidents(
      track,
      (await this.#source.settled(track.equipment, track.epoch)).incidents,
    );
    await this.#settle(track);
  }

  async #onState(track: Track, fact: StateFact, settledSeq: number | null): Promise<void> {
    this.#raise(track.epoch, fact.sourceTime.getTime());
    if (await this.#learn(track, settledSeq, { seq: fact.seq, at: fact.sourceTime.getTime() })) {
      // This fact is one the track is about to count: the rest must be known already.
      await this.#verifyFacts(track, 1, false);
    }
    // A track whose last handling failed is recomputed, never patched from a stale state.
    const window = this.#dirty.has(track) ? undefined : await this.#window(track, fact);
    if (!window) {
      await this.#rebuild(track);
    } else {
      const { points: span, index, facts } = window;
      const first = span[0];
      const last = span.at(-1);
      if (!first || !last) throw new RangeError('empty window');
      const pred = index > 0 ? first : undefined;
      const succ = index < span.length - 1 ? last : undefined;
      // Without a predecessor, the window reaches back to the anchor (if it opens the first
      // interval) and replaces everything before the successor.
      const points = pred ? span : withAnchor(track.anchor, span);
      const lastSeq = Math.max(track.lastSeq ?? fact.seq, fact.seq);
      // Nothing before the fact's own (clamped) time changes: the pieces before it are cut alike.
      const changedFrom = span[index]?.at ?? fact.sourceTime.getTime();
      if (succ) {
        const pieces = cutPieces(points.slice(0, -1), succ.at, this.#pattern, this.#bound(track));
        const revised = await this.#changedFinalHours(
          track,
          changedFrom,
          { from: pred?.at, to: succ.at },
          pieces,
        );
        await this.#replace(track, pred?.at, succ.at, pieces, { facts, lastSeq });
        await this.#revise(track, revised);
      } else {
        const end = this.#end(track, last.at);
        const pieces = cutPieces(points, end, this.#pattern, this.#bound(track));
        const revised = await this.#changedFinalHours(
          track,
          changedFrom,
          { from: pred?.at },
          pieces,
        );
        await this.#replace(track, pred?.at, undefined, pieces, { facts, lastSeq });
        await this.#revise(track, revised);
        this.#tail(track, last, pieces, end);
      }
      // A late fact of a closed epoch may reach an hour that had no piece yet, and so may a fact
      // earlier than every other (or the anchor before it) below the final hours.
      if (track.closed) await this.#markFinal(track, hourOf(changedFrom), Infinity);
      else if (!pred && track.finalEnd > -Infinity) {
        await this.#markFinal(track, -Infinity, track.finalEnd);
      }
      this.#emit(track, pred?.at, succ?.at);
    }
    await this.#advance(track.epoch);
    await this.#settle(track);
  }

  /**
   * The fact with its neighbours by `seq`, times clamped as a full recompute would clamp them,
   * and the number of state facts the result reflects; undefined when only a full recompute can
   * tell (the first clamp of a reordered fact, or a late fact that would move later ones).
   * In order (the usual case) the predecessor is the last point already known and there is no
   * successor, so the tables needn't be asked.
   */
  async #window(
    track: Track,
    fact: StateFact,
  ): Promise<{ points: Point[]; index: number; facts: number } | undefined> {
    const { last, lastSeq } = track;
    const point = factPoint(fact);
    if (last && lastSeq !== null && last.seq === lastSeq && fact.seq > lastSeq) {
      if (point.at < last.at) track.clamped = true; // moved up to its predecessor's time
      return {
        points: [last, { ...point, at: Math.max(point.at, last.at) }],
        index: 1,
        facts: track.facts + 1,
      };
    }
    const [raw, facts] = await Promise.all([
      this.#source.stateFactWindow(track.equipment, track.epoch, fact.seq),
      this.#source.stateFactCount(track.equipment, track.epoch),
    ]);
    const points = raw.map(factPoint);
    const index = points.findIndex((p) => p.seq === fact.seq);
    const self = points[index];
    if (!self) return undefined;
    if (!track.clamped) return monotonic(points) ? { points, index, facts } : undefined;
    // Clamped: a point's time is the latest raw time up to it by seq.
    const before =
      index > 0 ? await this.#source.latestStateTime(track.equipment, track.epoch, fact.seq) : null;
    const floor = before?.getTime() ?? -Infinity;
    const at = Math.max(floor, self.at);
    const succ = points[index + 1];
    // The successor's time was max(floor, its own); a later time here would move it and more.
    if (succ && at > Math.max(floor, succ.at)) return undefined;
    const clamped = points.map((p, i) =>
      i < index
        ? { ...p, at: floor }
        : i === index
          ? { ...p, at }
          : { ...p, at: Math.max(floor, p.at) },
    );
    return { points: clamped, index, facts };
  }

  async #onAnchor(track: Track, anchor: StateAnchor): Promise<void> {
    // Only the first anchor of (equipment, epoch) counts; a later one is just the current state.
    const winner = await this.#source.anchor(track.equipment, track.epoch);
    if (winner?.arrival !== anchor.arrival || track.anchor?.arrival === anchor.arrival) return;
    track.anchor = winner;
    await this.#rebuild(track);
  }

  async #onSample(sample: StoredSample, settledSeq?: number | null): Promise<void> {
    // Telemetry carries the gateway's epoch; only its `deviceEpoch` (contract 1.1) says which
    // run it belongs to. Without one it never moves a watermark.
    const epoch = sample.deviceEpoch;
    if (epoch === null) return;
    if (sample.scope === 'topic') {
      // Telemetry never moves an epoch its equipment has left (or a run older than that).
      const byEpoch = this.#tracks.get(sample.equipment);
      const newest = byEpoch && byEpoch.size > 0 ? Math.max(...byEpoch.keys()) : -Infinity;
      if (epoch < newest || byEpoch?.get(epoch)?.closed === true) return;
    }
    const track = await this.#track(sample.equipment, epoch);
    const at = sample.sourceTime.getTime();
    this.#raise(epoch, at);
    if (sample.scope === 'device') {
      // A cycle in an hour that is final already (a late fill, or a late fact of a closed epoch)
      // changes that hour's count: its revision goes up (#113).
      if (sample.kind === 'cycle' && this.#isFinalHour(track, hourOf(at))) {
        await this.#revise(track, [hourOf(at)]);
      }
      if (await this.#learn(track, settledSeq, { seq: sample.seq, at })) {
        await this.#verifyFacts(track, 0);
      }
    }
    await this.#advance(epoch);
    if (sample.scope === 'device') await this.#settle(track);
  }

  /** The time pieces are final up to: everything once the epoch is closed (#113). */
  #bound(track: Track): Millis {
    return track.closed ? Infinity : track.finalThrough;
  }

  /** Whether `hour` of the track has become final (its `bucket_finality` row exists if it has pieces). */
  #isFinalHour(track: Track, hour: Millis): boolean {
    return track.closed || hour < track.finalEnd;
  }

  /**
   * Learns how far the device stream is settled (#113). In order, the fact itself moves it by one;
   * otherwise (a gap filled or reported, or the first fact known) ingest is asked, which also
   * tells the epoch's incidents. Returns true for such a jump: the caller then checks that no
   * state fact below it went unheard (`#verifyFacts`) before anything is stored as final.
   */
  async #learn(
    track: Track,
    settledSeq: number | null | undefined,
    fact?: { readonly seq: number; readonly at: Millis },
  ): Promise<boolean> {
    if (settledSeq === undefined || settledSeq === null || track.closed) return false;
    const known = track.settledSeq;
    if (known !== null && settledSeq <= known) return false;
    if (fact && known !== null && fact.seq === settledSeq && known === fact.seq - 1) {
      track.settledSeq = settledSeq;
      track.finalThrough = Math.max(track.finalThrough, fact.at);
      return false;
    }
    await this.#apply(
      track,
      await this.#source.settled(track.equipment, track.epoch, known ?? undefined),
    );
    return true;
  }

  /**
   * A jump in the settled part may pass a state fact the module never heard of: a commit applied
   * although it reported failure, whose redelivery the reloaded cursor then saw as a duplicate
   * (ADR-0017), so no notice came. If ingest counts more state facts than the track (plus the
   * `pending` ones in hand), the track is recomputed from the tables before anything is final:
   * at once, or (`now` false) by the caller's next step, through the dirty mark.
   */
  async #verifyFacts(track: Track, pending: number, now = true): Promise<void> {
    if (track.closed || this.#dirty.has(track)) return;
    const counted = await this.#source.stateFactCount(track.equipment, track.epoch);
    if (counted === track.facts + pending) return;
    this.#log.info(
      { equipment: track.equipment, epoch: track.epoch, counted, known: track.facts + pending },
      'state facts missed by notices: recomputing before finality',
    );
    this.#dirty.add(track);
    if (now) await this.#rebuild(track);
  }

  /**
   * Remembers the epoch's gap incidents and, when they changed, updates the final hours they
   * overlap (an incident may be recorded after its hours became final: a closed epoch's gaps).
   */
  async #setIncidents(track: Track, incidents: readonly GapIncident[]): Promise<void> {
    const before = track.incidents.map((s) => s.id).join(',');
    track.incidents = spans(incidents);
    if (track.incidents.map((s) => s.id).join(',') === before) return;
    if (!track.closed && track.finalEnd === -Infinity) return;
    const rows = await this.#db
      .selectFrom('equipment.bucket_finality')
      .select(['hour', 'incident_ids'])
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch)
      .execute();
    for (const row of rows) {
      const ids = this.#incidentsIn(track, row.hour.getTime());
      if (ids.join(',') === [...row.incident_ids].sort((a, b) => a - b).join(',')) continue;
      await this.#db
        .updateTable('equipment.bucket_finality')
        .set({ incident_ids: ids })
        .where('equipment', '=', track.equipment)
        .where('epoch', '=', track.epoch)
        .where('hour', '=', row.hour)
        .execute();
    }
  }

  /** Ids of the track's incidents whose span overlaps the hour, ascending. */
  #incidentsIn(track: Track, hour: Millis): number[] {
    return track.incidents
      .filter((s) => s.from < hour + HOUR && s.to >= hour)
      .map((s) => s.id)
      .sort((a, b) => a - b);
  }

  async #apply(track: Track, state: SettledState): Promise<void> {
    await this.#setIncidents(track, state.incidents);
    if (state.settledSeq === null) return;
    track.settledSeq = Math.max(track.settledSeq ?? state.settledSeq, state.settledSeq);
    if (state.settledTime) {
      track.finalThrough = Math.max(track.finalThrough, state.settledTime.getTime());
    }
  }

  /**
   * Brings stored finality up to the track's bound: provisional pieces that now end at or before
   * it become final, and every hour before it gets its `bucket_finality` row (all hours once the
   * epoch is closed). Only hours stored up to the open interval's end count, so an hour is
   * recorded once all its pieces are.
   */
  async #settle(track: Track): Promise<void> {
    if (this.#dirty.has(track)) return;
    const bound = this.#bound(track);
    // promoteAt is Infinity when no stored piece is provisional.
    if (bound > -Infinity && track.promoteAt !== Infinity && bound >= track.promoteAt) {
      await this.#promote(track, bound);
    }
    if (track.closed) {
      if (track.finalEnd !== Infinity) {
        await this.#markFinal(track, track.finalEnd, Infinity);
        track.finalEnd = Infinity;
      }
      return;
    }
    if (track.stored === undefined) return;
    const until = Math.min(hourOf(bound), hourOf(track.stored));
    if (until > track.finalEnd) {
      await this.#markFinal(track, track.finalEnd, until);
      track.finalEnd = until;
    }
  }

  /**
   * Flags the provisional pieces ending at or before `bound` final and finds the next provisional
   * end, in one statement.
   */
  async #promote(track: Track, bound: Millis): Promise<void> {
    const from = track.promoteAt;
    let promote = this.#db
      .updateTable('equipment.equipment_state_interval')
      .set({ provisional: false })
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch)
      .where('provisional', '=', true);
    // Pieces never exceed an hour, and no provisional one ends before `promoteAt`.
    if (Number.isFinite(from)) promote = promote.where('start_time', '>=', new Date(from - HOUR));
    if (Number.isFinite(bound)) promote = promote.where('end_time', '<=', new Date(bound));
    let rest = this.#db
      .with('promoted', () => promote.returning('start_time'))
      .selectFrom('equipment.equipment_state_interval')
      .select((eb) => eb.fn.min<Date | null>('end_time').as('next'))
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch)
      .where('provisional', '=', true);
    // The statement sees the rows as before the update: the rest are those ending after `bound`.
    if (Number.isFinite(bound)) {
      rest = rest
        .where('start_time', '>', new Date(bound - HOUR))
        .where('end_time', '>', new Date(bound));
    }
    const row = await rest.executeTakeFirst();
    track.promoteAt = Number.isFinite(bound) ? (row?.next?.getTime() ?? Infinity) : Infinity;
    this.#emit(track, Number.isFinite(from) ? from - HOUR : undefined, undefined);
  }

  /** Records the hours in [from, until) that have pieces as final, with their incidents. */
  async #markFinal(track: Track, from: Millis, until: Millis): Promise<void> {
    let query = this.#db
      .selectFrom('equipment.equipment_state_interval')
      .select('hour')
      .distinct()
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch);
    // `from` and `until` are whole hours, so the key's start_time bounds the hours (and the index).
    if (Number.isFinite(from)) query = query.where('start_time', '>=', new Date(from));
    if (Number.isFinite(until)) query = query.where('start_time', '<', new Date(until));
    const hours = await query.execute();
    for (let i = 0; i < hours.length; i += INSERT_CHUNK) {
      await this.#db
        .insertInto('equipment.bucket_finality')
        .values(
          hours.slice(i, i + INSERT_CHUNK).map(({ hour }) => ({
            equipment: track.equipment,
            epoch: track.epoch,
            hour,
            incident_ids: this.#incidentsIn(track, hour.getTime()),
          })),
        )
        .onConflict((c) => c.columns(['equipment', 'epoch', 'hour']).doNothing())
        .execute();
    }
  }

  /**
   * The final hours from `from`'s hour on whose stored pieces in the replaced window
   * [window.from, window.to) differ from `pieces`: what a change after finality revises. Asked
   * only when such an hour can exist, so the in-order path never reads.
   */
  async #changedFinalHours(
    track: Track,
    from: Millis | undefined,
    window: { readonly from?: Millis | undefined; readonly to?: Millis | undefined },
    pieces: readonly Piece[],
  ): Promise<Millis[]> {
    const { to } = window;
    const first = from === undefined ? undefined : hourOf(from);
    const possible =
      first === undefined
        ? track.closed || track.finalEnd > -Infinity
        : this.#isFinalHour(track, first);
    if (!possible) return [];
    let finals = this.#db
      .selectFrom('equipment.bucket_finality')
      .select('hour')
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch);
    if (first !== undefined) finals = finals.where('hour', '>=', new Date(first));
    if (to !== undefined) finals = finals.where('hour', '<', new Date(to));
    const hours = (await finals.execute()).map((row) => row.hour.getTime());
    if (hours.length === 0) return [];
    let query = this.#db
      .selectFrom('equipment.equipment_state_interval')
      .select(['start_time', 'end_time', 'state', 'cause', 'interval_start'])
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch)
      .where(
        'hour',
        'in',
        hours.map((hour) => new Date(hour)),
      );
    if (window.from !== undefined) query = query.where('start_time', '>=', new Date(window.from));
    if (to !== undefined) query = query.where('start_time', '<', new Date(to));
    const stored = await query.orderBy('start_time').execute();
    const byHour = (
      rows: readonly (readonly [Millis, Millis, string, string | null, Millis])[],
    ) => {
      const result = new Map<Millis, string>();
      for (const row of rows) {
        const hour = hourOf(row[0]);
        result.set(hour, `${result.get(hour) ?? ''}${JSON.stringify(row)}`);
      }
      return result;
    };
    const before = byHour(
      stored.map(
        (row) =>
          [
            row.start_time.getTime(),
            row.end_time.getTime(),
            row.state,
            row.cause,
            row.interval_start.getTime(),
          ] as const,
      ),
    );
    const after = byHour(
      pieces.map(
        (piece) => [piece.from, piece.to, piece.state, piece.cause, piece.intervalStart] as const,
      ),
    );
    // An hour without stored pieces has nothing to compare (they were removed by hand).
    return hours.filter((hour) => before.has(hour) && before.get(hour) !== after.get(hour));
  }

  /** Raises the revision of those of `hours` that are final (#113). */
  async #revise(track: Track, hours: readonly Millis[]): Promise<void> {
    if (hours.length === 0) return;
    await this.#db
      .updateTable('equipment.bucket_finality')
      .set((eb) => ({ revision: eb('revision', '+', 1), revised_at: new Date() }))
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch)
      .where(
        'hour',
        'in',
        hours.map((hour) => new Date(hour)),
      )
      .execute();
  }

  #raise(epoch: number, at: Millis): void {
    if (at > (this.#watermarks.get(epoch) ?? -Infinity)) this.#watermarks.set(epoch, at);
  }

  /**
   * Where the last interval ends: the epoch's watermark while it is open, the watermark at closing
   * once a newer epoch closed it; never before the last point.
   */
  #end(track: Track, lastAt: Millis): Millis {
    const end = track.closed ? track.closedAt : this.#watermarks.get(track.epoch);
    return Math.max(end ?? lastAt, lastAt);
  }

  /** Stores the open intervals of an epoch again once its watermark passed a boundary or a step. */
  async #advance(epoch: number): Promise<void> {
    const watermark = this.#watermarks.get(epoch);
    if (watermark === undefined) return;
    for (const track of this.#allTracks()) {
      if (track.epoch !== epoch || track.closed || !track.last || this.#dirty.has(track)) continue;
      const stored = track.stored ?? -Infinity;
      if (watermark <= stored) continue;
      if (watermark >= track.nextCut || watermark - stored >= this.#step) {
        await this.#rewriteTail(track, false);
      }
    }
  }

  /**
   * Stores the open interval (the last point's) again, up to the watermark. Only the pieces from
   * the last stored one on are replaced, unless `all` (closing changes every piece's flag).
   */
  async #rewriteTail(track: Track, all: boolean): Promise<void> {
    const last = track.last;
    if (!last) return;
    const end = this.#end(track, last.at);
    const from = all ? last.at : (track.tailStart ?? last.at);
    const pieces = cutPieces([last], end, this.#pattern, this.#bound(track)).filter(
      (piece) => piece.from >= from,
    );
    await this.#replace(track, from, undefined, pieces, track);
    this.#tail(track, last, pieces, end);
    this.#emit(track, from, undefined);
  }

  /** Recomputes all intervals of (equipment, epoch) from ingest's tables. */
  async #rebuild(track: Track): Promise<void> {
    const [facts, anchor] = await Promise.all([
      this.#source.stateFacts(track.equipment, track.epoch),
      this.#source.anchor(track.equipment, track.epoch),
    ]);
    for (const fact of facts) this.#raise(track.epoch, fact.sourceTime.getTime());
    track.anchor = anchor;
    const { points, clamped } = clamp(withAnchor(anchor, facts.map(factPoint)));
    const last = points.at(-1);
    const end = last ? this.#end(track, last.at) : -Infinity;
    const pieces = last ? cutPieces(points, end, this.#pattern, this.#bound(track)) : [];
    track.clamped = clamped;
    const revised = await this.#changedFinalHours(track, undefined, {}, pieces);
    // Every piece is replaced: the earliest provisional end is among the new ones.
    track.promoteAt = Infinity;
    await this.#replace(track, undefined, undefined, pieces, {
      facts: facts.length,
      lastSeq: facts.at(-1)?.seq ?? null,
    });
    await this.#revise(track, revised);
    track.last = last;
    if (last) this.#tail(track, last, pieces, end);
    this.#dirty.delete(track);
    this.#emit(track, undefined, undefined);
    // Hours below the final ones may have gained pieces (an anchor or a first fact arriving late).
    if (track.closed || track.finalEnd > -Infinity) {
      await this.#markFinal(track, -Infinity, track.closed ? Infinity : track.finalEnd);
    }
    await this.#settle(track);
  }

  /** Remembers where the open interval is stored up to. */
  #tail(track: Track, last: Point, pieces: readonly Piece[], end: Millis): void {
    track.last = last;
    const final = pieces.at(-1);
    // Undefined when the open interval has no stored piece yet (zero length so far).
    track.tailStart = final?.intervalStart === last.at ? final.from : undefined;
    track.stored = end;
    track.nextCut = this.#nextCut(end);
  }

  /** The first hour or shift boundary after `after`. */
  #nextCut(after: Millis): Millis {
    const hour = Math.floor(after / HOUR) * HOUR + HOUR;
    let cache = this.#cuts;
    if (after < cache.from || after >= cache.until) {
      // Cuts for the next eight days, so a long weekend still has its next shift start.
      const until = after + DAY;
      cache = { from: after, until, cuts: shiftCuts(this.#pattern, after, until + 8 * DAY) };
      this.#cuts = cache;
    }
    const shift = cache.cuts.find((cut) => cut > after) ?? Infinity;
    return Math.min(hour, shift);
  }

  /**
   * Replaces the pieces of (equipment, epoch) starting in [from, to) (unbounded where undefined)
   * and records the source, in one transaction.
   */
  async #replace(
    track: Track,
    from: Millis | undefined,
    to: Millis | undefined,
    pieces: readonly Piece[],
    source: { readonly facts: number; readonly lastSeq: number | null },
  ): Promise<void> {
    for (const piece of pieces) {
      if (piece.provisional && piece.to < track.promoteAt) track.promoteAt = piece.to;
    }
    if (pieces.length <= INSERT_CHUNK) {
      await this.#replaceAtOnce(track, from, to, pieces, source);
      return;
    }
    await this.#db.transaction().execute(async (trx) => {
      let remove = trx
        .deleteFrom('equipment.equipment_state_interval')
        .where('equipment', '=', track.equipment)
        .where('epoch', '=', track.epoch);
      if (from !== undefined) remove = remove.where('start_time', '>=', new Date(from));
      if (to !== undefined) remove = remove.where('start_time', '<', new Date(to));
      await remove.execute();
      for (let i = 0; i < pieces.length; i += INSERT_CHUNK) {
        await trx
          .insertInto('equipment.equipment_state_interval')
          .values(pieces.slice(i, i + INSERT_CHUNK).map((piece) => this.#pieceRow(track, piece)))
          .execute();
      }
      track.facts = source.facts;
      track.lastSeq = source.lastSeq;
      await this.#saveSource(trx, track);
    });
  }

  /**
   * `#replace` as one statement (one round trip, atomic by itself): pieces are upserted by key,
   * and the range's other pieces deleted, so the two parts never touch the same row.
   */
  async #replaceAtOnce(
    track: Track,
    from: Millis | undefined,
    to: Millis | undefined,
    pieces: readonly Piece[],
    source: { readonly facts: number; readonly lastSeq: number | null },
  ): Promise<void> {
    const removed = (db: QueryCreator<Database>) => {
      let remove = db
        .deleteFrom('equipment.equipment_state_interval')
        .where('equipment', '=', track.equipment)
        .where('epoch', '=', track.epoch);
      if (from !== undefined) remove = remove.where('start_time', '>=', new Date(from));
      if (to !== undefined) remove = remove.where('start_time', '<', new Date(to));
      if (pieces.length > 0) {
        remove = remove.where(
          'start_time',
          'not in',
          pieces.map((piece) => new Date(piece.from)),
        );
      }
      return remove;
    };
    const next = { ...track, facts: source.facts, lastSeq: source.lastSeq };
    if (pieces.length === 0) {
      await this.#db
        .with('removed', removed)
        .insertInto('equipment.interval_source')
        .values(this.#sourceRow(next))
        .onConflict((c) => c.columns(['equipment', 'epoch']).doUpdateSet(this.#sourceUpdate(next)))
        .execute();
    } else {
      await this.#db
        .with('removed', removed)
        .with('stored', (db) =>
          db
            .insertInto('equipment.equipment_state_interval')
            .values(pieces.map((piece) => this.#pieceRow(track, piece)))
            .onConflict((c) =>
              c.columns(['equipment', 'epoch', 'start_time']).doUpdateSet((eb) => ({
                end_time: eb.ref('excluded.end_time'),
                state: eb.ref('excluded.state'),
                cause: eb.ref('excluded.cause'),
                hour: eb.ref('excluded.hour'),
                shift_key: eb.ref('excluded.shift_key'),
                provisional: eb.ref('excluded.provisional'),
                interval_start: eb.ref('excluded.interval_start'),
                start_seq: eb.ref('excluded.start_seq'),
                recorded_at: eb.ref('excluded.recorded_at'),
              })),
            ),
        )
        .insertInto('equipment.interval_source')
        .values(this.#sourceRow(next))
        .onConflict((c) => c.columns(['equipment', 'epoch']).doUpdateSet(this.#sourceUpdate(next)))
        .execute();
    }
    track.facts = source.facts;
    track.lastSeq = source.lastSeq;
  }

  #pieceRow(track: Track, piece: Piece) {
    return {
      equipment: track.equipment,
      epoch: track.epoch,
      start_time: new Date(piece.from),
      end_time: new Date(piece.to),
      state: piece.state,
      cause: piece.cause,
      hour: new Date(piece.hour),
      shift_key: piece.shiftKey,
      provisional: piece.provisional,
      interval_start: new Date(piece.intervalStart),
      start_seq: piece.startSeq,
      recorded_at: new Date(),
    };
  }

  #sourceUpdate(track: Track) {
    return {
      state_facts: track.facts,
      last_seq: track.lastSeq,
      anchor_arrival: track.anchor?.arrival ?? null,
      closed: track.closed,
      closed_at: track.closedAt === undefined ? null : new Date(track.closedAt),
      clamped: track.clamped,
      updated_at: new Date(),
    };
  }

  #sourceRow(track: Track) {
    return { equipment: track.equipment, epoch: track.epoch, ...this.#sourceUpdate(track) };
  }

  async #saveSource(trx: Transaction<Database>, track: Track): Promise<void> {
    await trx
      .insertInto('equipment.interval_source')
      .values(this.#sourceRow(track))
      .onConflict((c) => c.columns(['equipment', 'epoch']).doUpdateSet(this.#sourceUpdate(track)))
      .execute();
  }

  /**
   * Start-up: compares `interval_source` with ingest's tables, recomputes every (equipment,
   * epoch) whose facts or anchor differ, closes epochs a newer one superseded, and stores the
   * open intervals up to the watermark.
   */
  async #catchUp(): Promise<void> {
    const [summaries, anchors, sources, stored, finality] = await Promise.all([
      this.#source.factSummary(),
      this.#source.anchors(),
      this.#db.selectFrom('equipment.interval_source').selectAll().execute(),
      // The last stored piece of every (equipment, epoch).
      this.#db
        .selectFrom('equipment.equipment_state_interval')
        .select(['equipment', 'epoch', 'start_time', 'end_time', 'interval_start'])
        .select(['state', 'cause', 'start_seq'])
        .distinctOn(['equipment', 'epoch'])
        .orderBy('equipment')
        .orderBy('epoch')
        .orderBy('start_time', 'desc')
        .execute(),
      // The latest final hour of every (equipment, epoch) (#113).
      this.#db
        .selectFrom('equipment.bucket_finality')
        .select(['equipment', 'epoch'])
        .select((eb) => eb.fn.max('hour').as('last'))
        .groupBy(['equipment', 'epoch'])
        .execute(),
    ]);
    const key = (equipment: string, epoch: number): string => `${equipment}\u0000${String(epoch)}`;
    const summaryOf = new Map(summaries.map((s) => [key(s.equipment, s.epoch), s]));
    const anchorOf = new Map(
      anchors.flatMap((a) =>
        a.deviceEpoch === null ? [] : [[key(a.equipment, a.deviceEpoch), a]],
      ),
    );
    const sourceOf = new Map(sources.map((s) => [key(s.equipment, s.epoch), s]));
    const lastPieceOf = new Map(stored.map((s) => [key(s.equipment, s.epoch), s]));
    const lastFinalOf = new Map(finality.map((f) => [key(f.equipment, f.epoch), f.last.getTime()]));
    for (const summary of summaries) {
      this.#raise(summary.epoch, summary.latestSourceTime.getTime());
    }
    for (const piece of stored) this.#raise(piece.epoch, piece.end_time.getTime());

    const pairs = new Map<string, { equipment: string; epoch: number }>();
    for (const item of [...summaries, ...sources]) pairs.set(key(item.equipment, item.epoch), item);
    for (const anchor of anchors) {
      if (anchor.deviceEpoch !== null) {
        pairs.set(key(anchor.equipment, anchor.deviceEpoch), {
          equipment: anchor.equipment,
          epoch: anchor.deviceEpoch,
        });
      }
    }
    const newest = new Map<string, number>();
    for (const { equipment, epoch } of pairs.values()) {
      newest.set(equipment, Math.max(newest.get(equipment) ?? epoch, epoch));
    }
    let rebuilt = 0;
    for (const [id, { equipment, epoch }] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
      const summary = summaryOf.get(id);
      const anchor = anchorOf.get(id);
      const source = sourceOf.get(id);
      const lastPiece = lastPieceOf.get(id);
      const closed = epoch < (newest.get(equipment) ?? epoch);
      const lastFinal = lastFinalOf.get(id);
      // Closed and recorded before: every hour is final already, nothing to learn.
      const recorded = closed && source?.closed === true && lastFinal !== undefined;
      const track: Track = {
        equipment,
        epoch,
        last: undefined,
        anchor,
        facts: summary?.stateFacts ?? 0,
        lastSeq: summary?.lastStateSeq ?? null,
        closed,
        // Closed earlier: where it was closed then; closed only now: at the watermark now.
        closedAt: closed
          ? (source?.closed_at?.getTime() ?? this.#watermarks.get(epoch))
          : undefined,
        clamped: source?.clamped ?? false,
        tailStart: undefined,
        stored: undefined,
        nextCut: -Infinity,
        ...UNSETTLED,
        finalEnd: recorded ? Infinity : lastFinal === undefined ? -Infinity : lastFinal + HOUR,
      };
      if (!recorded) await this.#apply(track, await this.#source.settled(equipment, epoch));
      let byEpoch = this.#tracks.get(equipment);
      if (!byEpoch) {
        byEpoch = new Map();
        this.#tracks.set(equipment, byEpoch);
      }
      byEpoch.set(epoch, track);
      const unchanged =
        source?.state_facts === track.facts &&
        source.last_seq === track.lastSeq &&
        source.anchor_arrival === (anchor?.arrival ?? null);
      // The open interval as stored must be the last piece, opened by the last fact (or anchor).
      // Nothing to store: no state fact and no anchor (an equipment seen only through cycles).
      if (unchanged && track.lastSeq === null && !anchor) continue;
      const opened = lastPiece?.start_seq === track.lastSeq ? lastPiece : undefined;
      if (unchanged && opened) {
        track.last = {
          at: opened.interval_start.getTime(),
          state: opened.state,
          cause: opened.cause,
          seq: opened.start_seq,
        };
        track.tailStart = opened.start_time.getTime();
        track.stored = opened.end_time.getTime();
      } else if (unchanged && !track.clamped && track.lastSeq !== null) {
        // The last fact's interval has no piece yet (zero length so far): read just that fact.
        const [fact] = await this.#source.stateFacts(equipment, epoch, {
          fromSeq: track.lastSeq,
          toSeq: track.lastSeq,
        });
        if (!fact) throw new Error(`fact ${String(track.lastSeq)} of ${equipment} vanished`);
        track.last = factPoint(fact);
        track.stored = track.last.at;
      } else {
        await this.#rebuild(track);
        rebuilt++;
        continue;
      }
      track.nextCut = this.#nextCut(track.stored);
      if (source.closed !== closed) await this.#rewriteTail(track, true);
      else if (!closed && this.#watermarks.get(epoch) !== track.stored) {
        await this.#rewriteTail(track, false);
      }
      await this.#syncFlags(track);
      await this.#settle(track);
    }
    this.#log.info({ tracks: pairs.size, rebuilt }, 'equipment intervals caught up');
  }

  /**
   * Start-up: sets every piece not yet in a final hour to what the track's bound says, both ways,
   * so pieces stored before #113 (or under an older bound) agree with it.
   */
  async #syncFlags(track: Track): Promise<void> {
    if (track.finalEnd === Infinity) return;
    const bound = this.#bound(track);
    const flag = Number.isFinite(bound)
      ? sql<boolean>`end_time > ${new Date(bound)}`
      : sql<boolean>`${sql.lit(bound < 0)}`;
    let query = this.#db
      .updateTable('equipment.equipment_state_interval')
      .set({ provisional: flag })
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch)
      .where(sql<boolean>`provisional IS DISTINCT FROM (${flag})`);
    if (Number.isFinite(track.finalEnd)) {
      query = query.where('start_time', '>=', new Date(track.finalEnd));
    }
    await query.execute();
    track.promoteAt = -Infinity;
  }

  *#allTracks(): Generator<Track> {
    for (const byEpoch of this.#tracks.values()) yield* byEpoch.values();
  }

  #current(equipment: string): CurrentState | undefined {
    const byEpoch = this.#tracks.get(equipment);
    if (!byEpoch) return undefined;
    const newest = [...byEpoch.values()]
      .filter((track) => track.last)
      .sort((a, b) => b.epoch - a.epoch)[0];
    const last = newest?.last;
    if (!newest || !last) return undefined;
    return {
      equipment,
      epoch: newest.epoch,
      state: last.state,
      cause: last.cause,
      since: new Date(last.at),
      seq: last.seq,
      until: newest.stored === undefined ? null : new Date(newest.stored),
    };
  }

  #emit(track: Track, from: Millis | undefined, to: Millis | undefined): void {
    if (this.#listeners.size === 0) return;
    const change: EquipmentChange = {
      equipment: track.equipment,
      epoch: track.epoch,
      from: from === undefined ? null : new Date(from),
      to: to === undefined ? null : new Date(to),
      current: this.#current(track.equipment),
    };
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error({ err: error }, 'equipment change listener failed');
      }
    }
  }
}
