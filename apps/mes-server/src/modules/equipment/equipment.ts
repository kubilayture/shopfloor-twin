import { HOUR, availabilityLoss, type AvailabilityLoss, type Millis } from '@shopfloor/oee-core';
import { UNCODED } from '@shopfloor/plant-config';
import { shiftCuts, type ShiftPattern } from '@shopfloor/shift-calendar';
import { sql, type Kysely, type QueryCreator, type Transaction } from 'kysely';
import {
  AggregateRefresher,
  type AggregateStatus,
  type RefreshOptions,
} from '../../db/aggregate-refresh.ts';
import type { Database } from '../../db/database.ts';
import type {
  CycleCount,
  FactSummary,
  GapIncident,
  IngestNotice,
  SettledState,
  StateAnchor,
  StateFact,
  StoredSample,
} from '../ingest/index.ts';
import { pairKey, readCodings, type Coding } from './coding.ts';
import { deriveRecords, type DerivedRecord, type DowntimeRules } from './downtime.ts';
import { clamp, cutPieces, monotonic, type Piece, type Point } from './pieces.ts';

/** The downtime records replacing those of the intervals starting in [from, to) (#119). */
interface RecordWindow {
  readonly from: Millis | undefined;
  readonly to: Millis | undefined;
  readonly records: readonly DerivedRecord[];
}

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
  /** Cycles per hour of (equipment, epoch) in [from, to), from the facts (#118). */
  cycleCounts(
    equipment: string,
    epoch: number,
    from: Date | null,
    to: Date | null,
  ): Promise<CycleCount[]>;
  /** Cycles per (equipment, epoch, hour) from `cycle_hourly`, once caught up (#118). */
  hourlyCycleTotals(): Promise<CycleCount[]>;
  /** Buckets are final up to `end`: `cycle_hourly` is to be refreshed up to it (#118). */
  refreshCyclesThrough(end: Date): void;
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
  /**
   * Refresh `equipment.state_hourly` explicitly (ADR-0022): debounced, off the acknowledgement
   * path, on `refresh.db`. Without it the aggregate is never materialised: it reads the raw pieces,
   * and no hour is `final` in `stateHourly`.
   */
  readonly refresh?: RefreshOptions;
  /** The micro-stop threshold and reason rules downtime records are derived with (#119). */
  readonly downtime: DowntimeRules;
  readonly log?: EquipmentLog;
}

/**
 * One downtime record (#119): an availability-loss interval in one scheduled shift bucket, with
 * the reason the auto-classification rules give it.
 */
export interface DowntimeRecord {
  readonly equipment: string;
  readonly epoch: number;
  /** The later of the interval's start and its shift bucket's start (the record's key). */
  readonly start: Date;
  /** Null while the interval is open and this is its last bucket. */
  readonly end: Date | null;
  readonly intervalStart: Date;
  readonly shiftKey: string;
  readonly state: string;
  readonly cause: string | null;
  /** Own (Stopped from the threshold on, Down, Setup, Idle) or external (Starved, Blocked). */
  readonly loss: AvailabilityLoss;
  /** A `master_data.reason_code` id; UNCODED when no rule matched. */
  readonly autoReason: string;
  /** Open, or some of its time may still change (#113). */
  readonly provisional: boolean;
  /**
   * Operator codings inside the record, clipped to it, by time (#121): their reasons are in effect
   * there, the auto reason elsewhere.
   */
  readonly codings: readonly Coding[];
  /** The version of its (equipment, epoch)'s coding set: the token a coding write sends (#121). */
  readonly codingVersion: number;
}

/** Which downtime records to read (#120). */
export interface DowntimeQuery {
  /** Records overlapping [from, to). */
  readonly from: Date;
  readonly to: Date;
  /** One equipment, or all. */
  readonly equipment?: string;
  readonly epoch?: number;
  /**
   * Records with uncoded time first (the coding screen), then by start; otherwise by start only.
   * Uncoded time: the auto reason is UNCODED and no coding covers it (#121).
   */
  readonly uncodedFirst?: boolean;
  /** Only the records with uncoded time. */
  readonly uncoded?: boolean;
  readonly limit?: number;
}

/** Downtime of a range summed per (equipment, epoch, reason, loss), clipped to it (#120). */
export interface DowntimeLoss {
  readonly equipment: string;
  readonly epoch: number;
  /** The reason in effect: a coding's where one lies, the auto reason elsewhere (#121). */
  readonly reason: string;
  readonly loss: AvailabilityLoss;
  /** Clipped to the range; an open record runs to its epoch's watermark. */
  readonly ms: number;
  readonly records: number;
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

/** One row of `equipment.state_hourly`, with the hour's finality (#118). */
export interface StateHour {
  readonly equipment: string;
  readonly epoch: number;
  readonly hour: Date;
  readonly shiftKey: string;
  readonly state: string;
  readonly ms: number;
  readonly provisionalMs: number;
  /**
   * The hour is final (its `bucket_finality` row exists: no fact that can still arrive changes
   * it) and `state_hourly` holds it as it is now (a refresh covered it, nothing changed since).
   * Final for OEE also needs `Ingest.cyclesRefreshed(hour)` (ADR-0022).
   */
  readonly final: boolean;
  /** How often the hour changed after it became final (0 while not final). */
  readonly revision: number;
  /** Ids of the gap incidents over the hour (from its `bucket_finality` row; empty while not final). */
  readonly incidentIds: readonly number[];
}

/**
 * One stored piece of a Stopped interval with its interval's whole length (#120, ADR-0021): what
 * `oee-core` classifies as a micro-stop or a long stop.
 */
export interface StopPiece {
  readonly equipment: string;
  readonly epoch: number;
  readonly hour: Date;
  readonly shiftKey: string;
  readonly start: Date;
  readonly end: Date;
  readonly cause: string | null;
  readonly intervalStart: Date;
  /**
   * The whole interval's length: to its end when settled; while open (the epoch's last interval,
   * or one ending after the equipment's "final through"), to the earlier of its end and "final
   * through", never shorter than this piece.
   */
  readonly wholeMs: number;
  /** Its end may still move: a classification below the threshold is provisional. */
  readonly open: boolean;
}

/** The hourly state rows and stop pieces of a range, read in one snapshot (#120, ADR-0021). */
export interface OeeInputs {
  readonly hours: readonly StateHour[];
  readonly stops: readonly StopPiece[];
}

/** Sent after any write to the stored pieces of one (equipment, epoch) (#118). */
export interface PiecesChanged {
  readonly equipment: string;
  readonly epoch: number;
  /** The UTC hours whose pieces changed: [from, to), whole hours. */
  readonly from: Date;
  readonly to: Date;
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

/** The lowest and highest of `values` (none when empty), without spreading a long list. */
const span = (values: readonly Millis[]): Millis[] => {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return values.length === 0 ? [] : [low, high];
};

const minutesOfDay = (hhmm: string): number => {
  const [hours = 0, minutes = 0] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * The longest shift of the pattern in ms (a shift ending at its start lasts a day), plus an hour
 * for a daylight-saving change inside it: the longest a scheduled shift bucket can be.
 */
const longestShiftMs = (pattern: ShiftPattern): Millis =>
  Math.max(
    0,
    ...pattern.shifts.map(
      (shift) => (minutesOfDay(shift.end) - minutesOfDay(shift.start) + 1440) % 1440 || 1440,
    ),
  ) *
    60_000 +
  HOUR;

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

/** Where the codings of an open record are read up to: 9999-12-31 (PostgreSQL takes it). */
const OPEN_END = 253_402_214_400_000;

/**
 * A record (alias `r`) with uncoded time (#121): its auto reason is UNCODED and its codings
 * don't cover it all (an open record never is covered: it keeps growing).
 */
const UNCODED_TIME = sql<boolean>`(r.auto_reason = ${UNCODED} AND (r.end_time IS NULL OR coalesce((
  SELECT sum(least(c.to_time, r.end_time) - greatest(c.from_time, r.start_time))
  FROM equipment.downtime_coding c
  WHERE c.equipment = r.equipment AND c.epoch = r.epoch AND NOT c.orphaned
    AND c.from_time < r.end_time AND c.to_time > r.start_time), interval '0')
  < r.end_time - r.start_time))`;

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
  readonly #downtime: DowntimeRules;
  /** The longest scheduled shift bucket: no downtime record is longer (#119). */
  readonly #maxBucketMs: Millis;
  readonly #log: EquipmentLog;
  readonly #tracks = new Map<string, Map<number, Track>>();
  readonly #watermarks = new Map<number, Millis>();
  readonly #dirty = new Set<Track>();
  readonly #listeners = new Set<(change: EquipmentChange) => void>();
  readonly #pieceListeners = new Set<(change: PiecesChanged) => void>();
  /** Refreshes `equipment.state_hourly` (#118), if enabled. */
  readonly #states: AggregateRefresher | undefined;
  /** The end of the latest final hour of any (equipment, epoch): how far to refresh (#118). */
  #finalEnd: Millis = -Infinity;
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
    this.#downtime = options.downtime;
    this.#maxBucketMs = longestShiftMs(this.#pattern);
    this.#log = options.log ?? silent;
    const states =
      options.refresh &&
      new AggregateRefresher(
        'equipment.state_hourly',
        options.refresh.db ?? options.db,
        options.refresh.debounceMs,
        this.#log,
      );
    this.#states = states;
    if (states) {
      this.#pieceListeners.add((change) => {
        states.changed(change.from.getTime(), change.to.getTime());
      });
    }
  }

  /** Catches up from the tables, then follows ingest's notices (queued behind the catch-up). */
  async start(): Promise<void> {
    const caughtUp = this.#enqueue(() => this.#catchUp());
    this.#unsubscribe = this.#source.onStored((notice) =>
      this.#enqueue(() => this.#handle(notice)),
    );
    await caughtUp;
  }

  /** Stops following notices and waits for the work in hand, then for a running refresh. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#queue.catch(() => undefined);
    await this.#states?.stop();
  }

  /** Listens for every write to the stored pieces, with the hours it touched (#118). */
  onPiecesChanged(listener: (change: PiecesChanged) => void): () => void {
    this.#pieceListeners.add(listener);
    return () => this.#pieceListeners.delete(listener);
  }

  /** How far `state_hourly` is refreshed; undefined when this instance doesn't refresh it. */
  stateAggregate(): AggregateStatus | undefined {
    return this.#states?.status();
  }

  /** Runs the pending refresh of `state_hourly` now and waits for it (tests, replays). */
  async refreshAggregates(): Promise<void> {
    await this.#states?.flush();
  }

  /**
   * Rows of `equipment.state_hourly` for the hours in [from, to) (#118): materialised below the
   * aggregate's watermark, raw above it, each with its hour's finality and revision.
   */
  async stateHourly(
    from: Date,
    to: Date,
    options: {
      readonly equipment?: string;
      readonly epoch?: number;
      readonly shiftKey?: string;
    } = {},
  ): Promise<StateHour[]> {
    return this.#stateHourly(this.#readDb, from, to, options);
  }

  /**
   * The hourly state rows (`stateHourly`) and the Stopped pieces (`stopPieces`) of the hours in
   * [from, to), read in one REPEATABLE READ snapshot (ADR-0021: so a concurrent interval update
   * can't make the stop pieces disagree with the Stopped time of the same read).
   */
  async oeeInputs(
    from: Date,
    to: Date,
    options: { readonly equipment?: readonly string[]; readonly epoch?: number } = {},
  ): Promise<OeeInputs> {
    return this.#readDb
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const hours: StateHour[] = [];
        const stops: StopPiece[] = [];
        // One equipment at a time keeps every query on its index; all inside the same snapshot.
        for (const equipment of options.equipment ?? [undefined]) {
          const scope = {
            ...(equipment === undefined ? {} : { equipment }),
            ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
          };
          hours.push(...(await this.#stateHourly(trx, from, to, scope)));
          stops.push(...(await this.#stopPieces(trx, from, to, scope)));
        }
        return { hours, stops };
      });
  }

  /**
   * Stored Stopped pieces overlapping [from, to), each with its whole interval's length (#120;
   * plan "Storage and aggregation": the threshold applies to the whole interval, so it is not
   * stored). An interval is open while it is its epoch's last or its end lies after "final
   * through"; its length then runs to "final through" (never short of the piece's own end).
   */
  async stopPieces(
    from: Date,
    to: Date,
    options: { readonly equipment?: string; readonly epoch?: number } = {},
  ): Promise<StopPiece[]> {
    return this.#stopPieces(this.#readDb, from, to, options);
  }

  async #stopPieces(
    db: Kysely<Database>,
    from: Date,
    to: Date,
    options: { readonly equipment?: string; readonly epoch?: number },
  ): Promise<StopPiece[]> {
    const filters = [
      sql`s.state = 'Stopped'`,
      // Pieces never exceed an hour: this bound lets the index on start_time do the work.
      sql`s.start_time > ${new Date(from.getTime() - HOUR)}`,
      sql`s.start_time < ${to}`,
      sql`s.end_time > ${from}`,
      ...(options.equipment === undefined ? [] : [sql`s.equipment = ${options.equipment}`]),
      ...(options.epoch === undefined ? [] : [sql`s.epoch = ${options.epoch}`]),
    ];
    // The interval ends where the next interval's first piece starts (pieces of a track are
    // contiguous); the last interval of a track ends with the track's last piece.
    const rows = await sql<{
      equipment: string;
      epoch: number;
      hour: Date;
      shift_key: string;
      start_time: Date;
      end_time: Date;
      cause: string | null;
      interval_start: Date;
      next_start: Date | null;
      last_end: Date | null;
    }>`
      SELECT s.equipment, s.epoch, s.hour, s.shift_key, s.start_time, s.end_time, s.cause,
        s.interval_start,
        n.next_start, (
          -- Only for the last interval of a track: where its last stored piece ends.
          SELECT p.end_time FROM equipment.equipment_state_interval p
          WHERE n.next_start IS NULL AND p.equipment = s.equipment AND p.epoch = s.epoch
            AND p.start_time >= s.start_time
          ORDER BY p.start_time DESC LIMIT 1) AS last_end
      FROM equipment.equipment_state_interval s
      LEFT JOIN LATERAL (
        SELECT p.start_time AS next_start FROM equipment.equipment_state_interval p
        WHERE p.equipment = s.equipment AND p.epoch = s.epoch AND p.start_time > s.start_time
          AND p.interval_start <> s.interval_start
        ORDER BY p.start_time LIMIT 1) n ON true
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY s.equipment, s.epoch, s.start_time`.execute(db);
    return rows.rows.map((row) => {
      const track = this.#tracks.get(row.equipment)?.get(row.epoch);
      const start = row.interval_start.getTime();
      const end = row.next_start?.getTime() ?? row.last_end?.getTime() ?? row.end_time.getTime();
      const bound = track ? this.#bound(track) : Infinity;
      // Open: the last interval of an epoch not closed, or one whose end is not settled yet (a
      // later fact arrived before a missing one, #120 review). Its length so far runs to the
      // bound, the part that can no longer shrink, and never short of the piece itself.
      const open = (row.next_start === null && track !== undefined && !track.closed) || end > bound;
      const wholeEnd = open ? Math.max(Math.min(end, bound), row.end_time.getTime()) : end;
      return {
        equipment: row.equipment,
        epoch: row.epoch,
        hour: row.hour,
        shiftKey: row.shift_key,
        start: row.start_time,
        end: row.end_time,
        cause: row.cause,
        intervalStart: row.interval_start,
        wholeMs: wholeEnd - start,
        open,
      };
    });
  }

  async #stateHourly(
    db: Kysely<Database>,
    from: Date,
    to: Date,
    options: {
      readonly equipment?: string;
      readonly epoch?: number;
      readonly shiftKey?: string;
    },
  ): Promise<StateHour[]> {
    let query = db
      .selectFrom('equipment.state_hourly as h')
      .leftJoin('equipment.bucket_finality as f', (join) =>
        join
          .onRef('f.equipment', '=', 'h.equipment')
          .onRef('f.epoch', '=', 'h.epoch')
          .onRef('f.hour', '=', 'h.hour'),
      )
      .select([
        'h.equipment',
        'h.epoch',
        'h.hour',
        'h.shift_key',
        'h.state',
        'h.ms',
        'h.provisional_ms',
        'f.revision',
        'f.hour as final_hour',
        'f.incident_ids',
      ])
      .where('h.hour', '>=', from)
      .where('h.hour', '<', to);
    if (options.equipment !== undefined) {
      query = query.where('h.equipment', '=', options.equipment);
    }
    if (options.epoch !== undefined) query = query.where('h.epoch', '=', options.epoch);
    if (options.shiftKey !== undefined) query = query.where('h.shift_key', '=', options.shiftKey);
    const rows = await query
      .orderBy('h.equipment')
      .orderBy('h.epoch')
      .orderBy('h.hour')
      .orderBy('h.state')
      .execute();
    return rows.map((row) => ({
      equipment: row.equipment,
      epoch: row.epoch,
      hour: row.hour,
      shiftKey: row.shift_key,
      state: row.state,
      ms: row.ms,
      provisionalMs: row.provisional_ms,
      final: row.final_hour !== null && this.#states?.isRefreshed(row.hour.getTime()) === true,
      revision: row.revision ?? 0,
      incidentIds: row.incident_ids ?? [],
    }));
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

  /**
   * Where a newer epoch closed (equipment, epoch) (#142, the alarms module's `epoch-ended`):
   * `closed: false` while it is open or unknown here, else the closing time recorded with it
   * (`interval_source.closed_at`), undefined when the epoch had no watermark yet.
   */
  epochEnd(equipment: string, epoch: number): { closed: boolean; closedAt: Date | undefined } {
    const track = this.#tracks.get(equipment)?.get(epoch);
    if (!track?.closed) return { closed: false, closedAt: undefined };
    return {
      closed: true,
      closedAt: track.closedAt === undefined ? undefined : new Date(track.closedAt),
    };
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

  /**
   * Downtime records overlapping [from, to) (#119, for #120's downtime list and Pareto), by start
   * (and equipment, epoch); with `uncodedFirst`, the ones with uncoded time before the rest. Each
   * carries its codings and its coding set's version (#121).
   */
  async downtimeRecords(query: DowntimeQuery): Promise<DowntimeRecord[]> {
    let select = this.#readDb
      .selectFrom('equipment.downtime_record as r')
      .selectAll('r')
      // A record lies inside one shift bucket, open ones too (the tail is rewritten at every
      // boundary), so none that overlaps the range starts more than a bucket before it: this
      // bound lets the index on start_time do the work.
      .where('r.start_time', '>', new Date(query.from.getTime() - this.#maxBucketMs))
      .where('r.start_time', '<', query.to)
      .where((eb) => eb.or([eb('r.end_time', 'is', null), eb('r.end_time', '>', query.from)]));
    if (query.equipment !== undefined) select = select.where('r.equipment', '=', query.equipment);
    if (query.epoch !== undefined) select = select.where('r.epoch', '=', query.epoch);
    if (query.uncoded === true) select = select.where(UNCODED_TIME);
    if (query.uncodedFirst === true) select = select.orderBy(UNCODED_TIME, 'desc');
    if (query.limit !== undefined) select = select.limit(query.limit);
    const rows = await select
      .orderBy('r.start_time')
      .orderBy('r.equipment')
      .orderBy('r.epoch')
      .execute();
    if (rows.length === 0) return [];
    const from = Math.min(...rows.map((row) => row.start_time.getTime()));
    const to = Math.max(...rows.map((row) => row.end_time?.getTime() ?? OPEN_END));
    const { codings, versions } = await readCodings(
      this.#readDb,
      rows.map((row) => ({ equipment: row.equipment, epoch: row.epoch })),
      new Date(from),
      new Date(to),
    );
    return rows.map((row) => {
      const key = pairKey(row.equipment, row.epoch);
      const start = row.start_time.getTime();
      const end = row.end_time?.getTime() ?? Infinity;
      return {
        equipment: row.equipment,
        epoch: row.epoch,
        start: row.start_time,
        end: row.end_time,
        intervalStart: row.interval_start,
        shiftKey: row.shift_key,
        state: row.state,
        cause: row.cause,
        // Stored records are availability loss by construction (a CHECK lists their states).
        loss: availabilityLoss(row.state, Infinity, 0) ?? 'own',
        autoReason: row.auto_reason,
        provisional: row.provisional,
        codings: (codings.get(key) ?? []).flatMap((coding) => {
          const from = Math.max(coding.from.getTime(), start);
          const to = Math.min(coding.to.getTime(), end);
          return to > from ? [{ ...coding, from: new Date(from), to: new Date(to) }] : [];
        }),
        codingVersion: versions.get(key) ?? 0,
      };
    });
  }

  /**
   * Downtime records overlapping [from, to), summed in the database per (equipment, epoch,
   * reason in effect, state), each clipped to the range, without a row limit (#120: the Pareto
   * must equal the OEE losses). Coded time counts under the coding's reason, the rest under the
   * auto reason (#121); `records` counts the records with time under a reason. An open record
   * runs to its epoch's watermark.
   */
  async downtimeLoss(query: {
    readonly from: Date;
    readonly to: Date;
    readonly equipment?: string;
    readonly epoch?: number;
  }): Promise<DowntimeLoss[]> {
    const marks = [...this.#watermarks];
    const filters = [
      sql`r.start_time > ${new Date(query.from.getTime() - this.#maxBucketMs)}`,
      sql`r.start_time < ${query.to}`,
      sql`(r.end_time IS NULL OR r.end_time > ${query.from})`,
      ...(query.equipment === undefined ? [] : [sql`r.equipment = ${query.equipment}`]),
      ...(query.epoch === undefined ? [] : [sql`r.epoch = ${query.epoch}`]),
    ];
    const rows = await sql<{
      equipment: string;
      epoch: number;
      reason: string;
      state: string;
      ms: number;
      records: number;
    }>`
      WITH rec AS (
        SELECT r.equipment, r.epoch, r.start_time, r.state, r.auto_reason,
          greatest(r.start_time, ${query.from}) AS s,
          greatest(r.start_time, ${query.from},
            least(coalesce(r.end_time, w.watermark, r.start_time), ${query.to})) AS e
        FROM equipment.downtime_record r
        LEFT JOIN unnest(${marks.map(([epoch]) => epoch)}::bigint[],
          ${marks.map(([, at]) => new Date(at))}::timestamptz[]) AS w(epoch, watermark)
          ON w.epoch = r.epoch
        WHERE ${sql.join(filters, sql` AND `)}
      ),
      coded AS (
        SELECT rec.equipment, rec.epoch, rec.start_time, rec.state, c.reason,
          greatest(0, (extract(epoch FROM least(c.to_time, rec.e) - greatest(c.from_time, rec.s))
            * 1000)::bigint) AS ms
        FROM rec
        JOIN equipment.downtime_coding c
          ON c.equipment = rec.equipment AND c.epoch = rec.epoch AND NOT c.orphaned
          AND c.from_time < rec.e AND c.to_time > rec.s
      ),
      auto AS (
        SELECT rec.equipment, rec.epoch, rec.start_time, rec.state, rec.auto_reason AS reason,
          (extract(epoch FROM rec.e - rec.s) * 1000)::bigint - coalesce((
            SELECT sum(coded.ms) FROM coded
            WHERE coded.equipment = rec.equipment AND coded.epoch = rec.epoch
              AND coded.start_time = rec.start_time), 0) AS ms
        FROM rec
      ),
      parts AS (SELECT * FROM coded UNION ALL SELECT * FROM auto)
      SELECT equipment, epoch, reason, state,
        coalesce(sum(ms), 0)::bigint AS ms,
        count(DISTINCT start_time) FILTER (WHERE ms > 0)::bigint AS records
      FROM parts
      GROUP BY equipment, epoch, reason, state
      ORDER BY equipment, epoch, reason, state`.execute(this.#readDb);
    const merged = new Map<string, DowntimeLoss>();
    for (const row of rows.rows) {
      // Stored records are availability loss by construction (a CHECK lists their states).
      const loss = availabilityLoss(row.state, Infinity, 0) ?? 'own';
      const key = [row.equipment, row.epoch, row.reason, loss].join('\u0000');
      const before = merged.get(key);
      merged.set(key, {
        equipment: row.equipment,
        epoch: row.epoch,
        reason: row.reason,
        loss,
        ms: (before?.ms ?? 0) + row.ms,
        records: (before?.records ?? 0) + row.records,
      });
    }
    return [...merged.values()].filter((row) => row.ms > 0);
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
        // For the aggregates (#118); a cycle's `sample` notice is what counts here.
        case 'cycle':
        case 'epoch':
          return;
        // For the alarms module (#141); an alarm's `sample` notice moves the watermark.
        case 'alarm':
        case 'alarm-anchor':
        case 'alarm-snapshot':
        case 'alarm-stale':
          return;
        // For the orders module (#174); a job's `sample` notice moves the watermark.
        case 'job':
        case 'command-result':
          return;
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
    // How far the stored intervals were settled before this fact: only a stop class settled
    // then can have been final, and so revised (#120 review).
    const priorBound = this.#bound(track);
    if (await this.#learn(track, settledSeq, { seq: fact.seq, at: fact.sourceTime.getTime() })) {
      // This fact is one the track is about to count: the rest must be known already.
      await this.#verifyFacts(track, 1, false);
    }
    // A track whose last handling failed is recomputed, never patched from a stale state.
    const window = this.#dirty.has(track) ? undefined : await this.#window(track, fact);
    if (!window) {
      await this.#rebuild(track, priorBound);
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
          priorBound,
        );
        await this.#replace(
          track,
          pred?.at,
          succ.at,
          pieces,
          { facts, lastSeq },
          this.#records(pieces, pred?.at, succ.at, undefined),
        );
        await this.#revise(track, revised);
      } else {
        const end = this.#end(track, last.at);
        const pieces = cutPieces(points, end, this.#pattern, this.#bound(track));
        const revised = await this.#changedFinalHours(
          track,
          changedFrom,
          { from: pred?.at },
          pieces,
          priorBound,
        );
        await this.#replace(
          track,
          pred?.at,
          undefined,
          pieces,
          { facts, lastSeq },
          this.#records(pieces, pred?.at, undefined, track.closed ? undefined : last.at),
        );
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
        await this.#revise(track, [hourOf(at)], 1);
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
    // Downtime records follow their pieces (#119): a closed record is final with its last piece.
    let promoteRecords = this.#db
      .updateTable('equipment.downtime_record')
      .set({ provisional: false })
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch)
      .where('provisional', '=', true)
      .where('end_time', 'is not', null);
    if (Number.isFinite(bound))
      promoteRecords = promoteRecords.where('end_time', '<=', new Date(bound));
    let rest = this.#db
      .with('promoted', () => promote.returning('start_time'))
      .with('promoted_records', () => promoteRecords.returning('start_time'))
      .selectFrom('equipment.equipment_state_interval')
      .select((eb) => [
        eb.fn.min<Date | null>('end_time').as('next'),
        // The hours whose pieces changed flag (#118).
        sql<Date | null>`(SELECT min(start_time) FROM promoted)`.as('promoted_from'),
        sql<Date | null>`(SELECT max(start_time) FROM promoted)`.as('promoted_to'),
      ])
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
    this.#piecesChanged(track, [row?.promoted_from?.getTime(), row?.promoted_to?.getTime()]);
    this.#emit(track, Number.isFinite(from) ? from - HOUR : undefined, undefined);
  }

  /**
   * Records the hours in [from, until) that have pieces and no row yet as final, with their
   * incidents and their cycle count (#118), and moves the aggregates' refresh target past them.
   */
  async #markFinal(track: Track, from: Millis, until: Millis): Promise<void> {
    let query = this.#db
      .selectFrom('equipment.equipment_state_interval as p')
      .select('p.hour')
      .distinct()
      .where('p.equipment', '=', track.equipment)
      .where('p.epoch', '=', track.epoch)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('equipment.bucket_finality as f')
              .select('f.hour')
              .whereRef('f.equipment', '=', 'p.equipment')
              .whereRef('f.epoch', '=', 'p.epoch')
              .whereRef('f.hour', '=', 'p.hour'),
          ),
        ),
      );
    // `from` and `until` are whole hours, so the key's start_time bounds the hours (and the index).
    if (Number.isFinite(from)) query = query.where('p.start_time', '>=', new Date(from));
    if (Number.isFinite(until)) query = query.where('p.start_time', '<', new Date(until));
    const hours = (await query.execute()).map((row) => row.hour.getTime()).sort((a, b) => a - b);
    const first = hours[0];
    const last = hours.at(-1);
    if (first === undefined || last === undefined) return;
    const counts = await this.#source.cycleCounts(
      track.equipment,
      track.epoch,
      new Date(first),
      new Date(last + HOUR),
    );
    const countOf = new Map(counts.map((c) => [c.hour.getTime(), c.count]));
    for (let i = 0; i < hours.length; i += INSERT_CHUNK) {
      await this.#db
        .insertInto('equipment.bucket_finality')
        .values(
          hours.slice(i, i + INSERT_CHUNK).map((hour) => ({
            equipment: track.equipment,
            epoch: track.epoch,
            hour: new Date(hour),
            incident_ids: this.#incidentsIn(track, hour),
            cycles: countOf.get(hour) ?? 0,
          })),
        )
        .onConflict((c) => c.columns(['equipment', 'epoch', 'hour']).doNothing())
        .execute();
    }
    this.#finalThrough(last + HOUR);
  }

  /** Buckets are final up to `end`: both hourly aggregates are refreshed up to it (#118). */
  #finalThrough(end: Millis): void {
    if (end <= this.#finalEnd) return;
    this.#finalEnd = end;
    this.#states?.through(end);
    this.#source.refreshCyclesThrough(new Date(end));
  }

  /**
   * Start-up (#118): compares each final hour's remembered cycle count with `cycle_hourly` and
   * raises the revision of an hour whose count changed unheard (a cycle whose notice was missed:
   * equipment stopped between the commit and the notice, or a redelivery seen as a duplicate after
   * a resume). Hours recorded before migration 0006 only get their count.
   */
  async #checkCycleCounts(): Promise<void> {
    const [totals, rows] = await Promise.all([
      this.#source.hourlyCycleTotals(),
      this.#db
        .selectFrom('equipment.bucket_finality')
        .select(['equipment', 'epoch', 'hour', 'cycles'])
        .execute(),
    ]);
    const key = (equipment: string, epoch: number, hour: Date): string =>
      `${equipment}\u0000${String(epoch)}\u0000${String(hour.getTime())}`;
    const countOf = new Map(totals.map((t) => [key(t.equipment, t.epoch, t.hour), t.count]));
    const changed = rows.flatMap((row) => {
      const count = countOf.get(key(row.equipment, row.epoch, row.hour)) ?? 0;
      return row.cycles === count ? [] : [{ ...row, count, revise: row.cycles !== null }];
    });
    if (changed.length === 0) return;
    await sql`
      UPDATE equipment.bucket_finality f
      SET cycles = c.cycles,
        revision = f.revision + CASE WHEN c.revise THEN 1 ELSE 0 END,
        revised_at = CASE WHEN c.revise THEN now() ELSE f.revised_at END
      FROM unnest(
        ${changed.map((c) => c.equipment)}::text[],
        ${changed.map((c) => c.epoch)}::bigint[],
        ${changed.map((c) => c.hour)}::timestamptz[],
        ${changed.map((c) => c.count)}::bigint[],
        ${changed.map((c) => c.revise)}::boolean[]
      ) AS c(equipment, epoch, hour, cycles, revise)
      WHERE f.equipment = c.equipment AND f.epoch = c.epoch AND f.hour = c.hour`.execute(this.#db);
    const revised = changed.filter((c) => c.revise);
    this.#log.info(
      {
        filled: changed.length - revised.length,
        revised: revised.map((c) => ({
          equipment: c.equipment,
          epoch: c.epoch,
          hour: c.hour,
          was: c.cycles,
          now: c.count,
        })),
      },
      'cycle counts of final hours checked: changed ones revised',
    );
  }

  #piecesChanged(track: Track, hours: readonly (Millis | null | undefined)[]): void {
    const known = hours.filter((hour): hour is Millis => typeof hour === 'number');
    if (known.length === 0 || this.#pieceListeners.size === 0) return;
    const change: PiecesChanged = {
      equipment: track.equipment,
      epoch: track.epoch,
      from: new Date(hourOf(Math.min(...known))),
      to: new Date(hourOf(Math.max(...known)) + HOUR),
    };
    for (const listener of this.#pieceListeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error({ err: error }, 'pieces listener failed');
      }
    }
  }

  /**
   * The final hours from `from`'s hour on whose stored pieces in the replaced window
   * [window.from, window.to) differ from `pieces`: what a change after finality revises. Asked
   * only when such an hour can exist, so the in-order path rarely reads.
   *
   * A Stopped piece also compares by its interval's class (micro-stop or not, ADR-0021): a late
   * fill that moves a stop's end changes the OEE of every hour the stop touches, also hours
   * before the fact whose pieces stay the same (#120 review). So when the window opens with a
   * Stopped interval, the check starts at that interval's hour.
   */
  async #changedFinalHours(
    track: Track,
    from: Millis | undefined,
    window: { readonly from?: Millis | undefined; readonly to?: Millis | undefined },
    pieces: readonly Piece[],
    settledBound: Millis = this.#bound(track),
  ): Promise<Millis[]> {
    const { to } = window;
    const opening = pieces[0];
    const stopFrom =
      opening?.state === 'Stopped' && opening.from === window.from ? opening.from : undefined;
    const first = from === undefined ? undefined : hourOf(Math.min(from, stopFrom ?? from));
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
    // Where each stored Stopped interval of those hours ends (its pieces may reach later hours).
    const stoppedStarts = [
      ...new Set(
        stored.filter((r) => r.state === 'Stopped').map((r) => r.interval_start.getTime()),
      ),
    ];
    const storedEnds = new Map<Millis, Millis>();
    if (stoppedStarts.length > 0) {
      const ends = await this.#db
        .selectFrom('equipment.equipment_state_interval')
        .select(['interval_start', (eb) => eb.fn.max<Date>('end_time').as('end')])
        .where('equipment', '=', track.equipment)
        .where('epoch', '=', track.epoch)
        .where('state', '=', 'Stopped')
        .where('start_time', '>=', new Date(Math.min(...stoppedStarts)))
        .where(
          'interval_start',
          'in',
          stoppedStarts.map((start) => new Date(start)),
        )
        .groupBy('interval_start')
        .execute();
      for (const row of ends) storedEnds.set(row.interval_start.getTime(), row.end.getTime());
    }
    const newEnds = new Map<Millis, Millis>();
    for (const piece of pieces) {
      if (piece.state !== 'Stopped') continue;
      newEnds.set(
        piece.intervalStart,
        Math.max(newEnds.get(piece.intervalStart) ?? -Infinity, piece.to),
      );
    }
    const threshold = this.#downtime.microStopThresholdMs;
    // Only a settled class can be revised: a stop that was still open, or whose end lay past
    // "final through", was provisional, so its OEE bucket was not final either.
    // `settledBound`: "final through" before the fact being handled moved it.
    const settled = new Set(
      [...storedEnds]
        .filter(([start, end]) => end <= settledBound && (track.closed || start !== track.last?.at))
        .map(([start]) => start),
    );
    const stopClass = (state: string, start: Millis, ends: ReadonlyMap<Millis, Millis>) =>
      state === 'Stopped' && settled.has(start)
        ? (ends.get(start) ?? start) - start >= threshold
          ? 'long'
          : 'micro'
        : '';
    const byHour = (
      rows: readonly (readonly [Millis, Millis, string, string | null, Millis, string])[],
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
            stopClass(row.state, row.interval_start.getTime(), storedEnds),
          ] as const,
      ),
    );
    const after = byHour(
      pieces.map(
        (piece) =>
          [
            piece.from,
            piece.to,
            piece.state,
            piece.cause,
            piece.intervalStart,
            stopClass(piece.state, piece.intervalStart, newEnds),
          ] as const,
      ),
    );
    // An hour without stored pieces has nothing to compare (they were removed by hand).
    return hours.filter((hour) => before.has(hour) && before.get(hour) !== after.get(hour));
  }

  /**
   * Raises the revision of those of `hours` that are final (#113); `cycles`: a late cycle, which
   * the hour's remembered count gains too (#118).
   */
  async #revise(track: Track, hours: readonly Millis[], cycles = 0): Promise<void> {
    if (hours.length === 0) return;
    await this.#db
      .updateTable('equipment.bucket_finality')
      .set((eb) => ({
        revision: eb('revision', '+', 1),
        revised_at: new Date(),
        ...(cycles === 0 ? {} : { cycles: eb('cycles', '+', cycles) }),
      }))
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
    const whole = cutPieces([last], end, this.#pattern, this.#bound(track));
    const pieces = whole.filter((piece) => piece.from >= from);
    // The open interval's records need all of its pieces (its length, its buckets).
    const records = this.#records(whole, last.at, undefined, track.closed ? undefined : last.at);
    await this.#replace(track, from, undefined, pieces, track, records);
    this.#tail(track, last, pieces, end);
    this.#emit(track, from, undefined);
  }

  /** Recomputes all intervals of (equipment, epoch) from ingest's tables. */
  async #rebuild(track: Track, settledBound: Millis = this.#bound(track)): Promise<void> {
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
    const revised = await this.#changedFinalHours(track, undefined, {}, pieces, settledBound);
    // Every piece is replaced: the earliest provisional end is among the new ones.
    track.promoteAt = Infinity;
    await this.#replace(
      track,
      undefined,
      undefined,
      pieces,
      { facts: facts.length, lastSeq: facts.at(-1)?.seq ?? null },
      this.#records(pieces, undefined, undefined, track.closed ? undefined : last?.at),
    );
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
    records: RecordWindow,
  ): Promise<void> {
    for (const piece of pieces) {
      if (piece.provisional && piece.to < track.promoteAt) track.promoteAt = piece.to;
    }
    // The hours of the new pieces; an upserted piece keeps its start, so its old hour too (#118).
    const touched: (Millis | undefined)[] = [pieces[0]?.from, pieces.at(-1)?.from];
    if (pieces.length <= INSERT_CHUNK && records.records.length <= INSERT_CHUNK) {
      const removed = await this.#replaceAtOnce(track, from, to, pieces, source, records);
      this.#piecesChanged(track, [...touched, ...removed]);
      return;
    }
    const removed = await this.#db.transaction().execute(async (trx) => {
      let remove = trx
        .deleteFrom('equipment.equipment_state_interval')
        .where('equipment', '=', track.equipment)
        .where('epoch', '=', track.epoch);
      if (from !== undefined) remove = remove.where('start_time', '>=', new Date(from));
      if (to !== undefined) remove = remove.where('start_time', '<', new Date(to));
      const gone = await remove.returning('start_time').execute();
      for (let i = 0; i < pieces.length; i += INSERT_CHUNK) {
        await trx
          .insertInto('equipment.equipment_state_interval')
          .values(pieces.slice(i, i + INSERT_CHUNK).map((piece) => this.#pieceRow(track, piece)))
          .execute();
      }
      await this.#removedRecords(trx, track, { ...records, records: [] }).execute();
      for (let i = 0; i < records.records.length; i += INSERT_CHUNK) {
        await trx
          .insertInto('equipment.downtime_record')
          .values(records.records.slice(i, i + INSERT_CHUNK).map((r) => this.#recordRow(track, r)))
          .execute();
      }
      track.facts = source.facts;
      track.lastSeq = source.lastSeq;
      await this.#saveSource(trx, track);
      return span(gone.map((row) => row.start_time.getTime()));
    });
    this.#piecesChanged(track, [...touched, ...removed]);
  }

  /**
   * `#replace` as one statement (one round trip, atomic by itself): pieces are upserted by key,
   * and the range's other pieces deleted, so the two parts never touch the same row. Returns the
   * earliest and latest start of the deleted pieces, if any.
   */
  async #replaceAtOnce(
    track: Track,
    from: Millis | undefined,
    to: Millis | undefined,
    pieces: readonly Piece[],
    source: { readonly facts: number; readonly lastSeq: number | null },
    records: RecordWindow,
  ): Promise<(Millis | undefined)[]> {
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
      return remove.returning('start_time');
    };
    const range = [
      sql<Date | null>`(SELECT min(start_time) FROM removed)`.as('removed_from'),
      sql<Date | null>`(SELECT max(start_time) FROM removed)`.as('removed_to'),
    ];
    let row: { removed_from: Date | null; removed_to: Date | null } | undefined;
    const next = { ...track, facts: source.facts, lastSeq: source.lastSeq };
    // Downtime records of the same intervals, in the same statement (#119): the range's other
    // records are deleted, the new ones upserted by key.
    const withRecords = this.#db
      .with('removed_records', (db) => this.#removedRecords(db, track, records).returning('epoch'))
      .with('stored_records', (db) =>
        records.records.length === 0
          ? db
              .selectFrom('equipment.downtime_record')
              .select('epoch')
              .where(sql<boolean>`false`)
          : db
              .insertInto('equipment.downtime_record')
              .values(records.records.map((record) => this.#recordRow(track, record)))
              .onConflict((c) =>
                c.columns(['equipment', 'epoch', 'start_time']).doUpdateSet((eb) => ({
                  end_time: eb.ref('excluded.end_time'),
                  interval_start: eb.ref('excluded.interval_start'),
                  shift_key: eb.ref('excluded.shift_key'),
                  state: eb.ref('excluded.state'),
                  cause: eb.ref('excluded.cause'),
                  auto_reason: eb.ref('excluded.auto_reason'),
                  provisional: eb.ref('excluded.provisional'),
                  recorded_at: eb.ref('excluded.recorded_at'),
                })),
              )
              .returning('epoch'),
      );
    if (pieces.length === 0) {
      row = await withRecords
        .with('removed', removed)
        .insertInto('equipment.interval_source')
        .values(this.#sourceRow(next))
        .onConflict((c) => c.columns(['equipment', 'epoch']).doUpdateSet(this.#sourceUpdate(next)))
        .returning(range)
        .executeTakeFirst();
    } else {
      row = await withRecords
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
        .returning(range)
        .executeTakeFirst();
    }
    track.facts = source.facts;
    track.lastSeq = source.lastSeq;
    return [row?.removed_from?.getTime(), row?.removed_to?.getTime()];
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

  /** The downtime records of whole intervals' pieces, replacing those of [from, to) (#119). */
  #records(
    pieces: readonly Piece[],
    from: Millis | undefined,
    to: Millis | undefined,
    openStart: Millis | undefined,
  ): RecordWindow {
    return { from, to, records: deriveRecords(pieces, this.#downtime, openStart) };
  }

  /** Deletes the records of the intervals starting in the window, except those it upserts. */
  #removedRecords(db: QueryCreator<Database>, track: Track, window: RecordWindow) {
    let remove = db
      .deleteFrom('equipment.downtime_record')
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch);
    if (window.from !== undefined) {
      // start_time >= interval_start >= from: the bound on the key lets the primary key do the
      // work, so an in-order fact touches only the tail, not every record of its epoch.
      remove = remove
        .where('start_time', '>=', new Date(window.from))
        .where('interval_start', '>=', new Date(window.from));
    }
    if (window.to !== undefined) remove = remove.where('interval_start', '<', new Date(window.to));
    if (window.records.length > 0) {
      remove = remove.where(
        'start_time',
        'not in',
        window.records.map((record) => new Date(record.from)),
      );
    }
    return remove;
  }

  #recordRow(track: Track, record: DerivedRecord) {
    return {
      equipment: track.equipment,
      epoch: track.epoch,
      start_time: new Date(record.from),
      end_time: record.to === null ? null : new Date(record.to),
      interval_start: new Date(record.intervalStart),
      shift_key: record.shiftKey,
      state: record.state,
      cause: record.cause,
      auto_reason: record.reason,
      provisional: record.provisional,
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
      downtime_threshold_ms: this.#downtime.microStopThresholdMs,
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
      // Records derived with another threshold (or before #119: null) are derived again.
      const unchanged =
        source?.state_facts === track.facts &&
        source.last_seq === track.lastSeq &&
        source.anchor_arrival === (anchor?.arrival ?? null) &&
        source.downtime_threshold_ms === this.#downtime.microStopThresholdMs;
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
    const reclassified = await this.#reclassify();
    this.#log.info({ tracks: pairs.size, rebuilt, reclassified }, 'equipment intervals caught up');
    // The aggregates (#118): refresh both up to the latest final hour, check the final hours' cycle
    // counts against `cycle_hourly` (caught up first), then catch `state_hourly` up in the
    // background, after every write of this catch-up.
    let latestFinal = -Infinity;
    for (const last of lastFinalOf.values()) latestFinal = Math.max(latestFinal, last);
    if (Number.isFinite(latestFinal)) this.#finalThrough(latestFinal + HOUR);
    await this.#checkCycleCounts();
    this.#states?.catchUp().catch(() => undefined);
  }

  /**
   * Start-up: gives every stored downtime record the reason today's rules give it, so a changed
   * `reasons.yaml` applies to the records stored before (#119). One query per distinct (state,
   * cause) pair whose reason changed. Returns the number of records changed.
   */
  async #reclassify(): Promise<number> {
    const pairs = await this.#db
      .selectFrom('equipment.downtime_record')
      .select(['state', 'cause', 'auto_reason'])
      .distinct()
      .execute();
    let changed = 0;
    for (const pair of pairs) {
      const reason = this.#downtime.classify(pair.state, pair.cause);
      if (reason === pair.auto_reason) continue;
      const result = await this.#db
        .updateTable('equipment.downtime_record')
        .set({ auto_reason: reason })
        .where('state', '=', pair.state)
        .where((eb) =>
          pair.cause === null ? eb('cause', 'is', null) : eb('cause', '=', pair.cause),
        )
        .where('auto_reason', '=', pair.auto_reason)
        .executeTakeFirst();
      changed += Number(result.numUpdatedRows);
    }
    return changed;
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
    const changed = await query.returning('start_time').execute();
    this.#piecesChanged(track, span(changed.map((row) => row.start_time.getTime())));
    // Downtime records likewise: provisional while open or ending after the bound (#119). No
    // `finalEnd` guard is needed, unlike the pieces: a record's flag depends only on its end and
    // the bound, never on per-hour state, and a record inside the final hours ends at or before
    // `finalEnd` <= bound, so it is set false here exactly as it already is. A record reaching
    // past `finalEnd` has pieces outside the final hours, whose flags were just set by the same rule.
    const recordFlag = Number.isFinite(bound)
      ? sql<boolean>`end_time IS NULL OR end_time > ${new Date(bound)}`
      : sql<boolean>`end_time IS NULL OR ${sql.lit(bound < 0)}`;
    await this.#db
      .updateTable('equipment.downtime_record')
      .set({ provisional: recordFlag })
      .where('equipment', '=', track.equipment)
      .where('epoch', '=', track.epoch)
      .where(sql<boolean>`provisional IS DISTINCT FROM (${recordFlag})`)
      .execute();
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
