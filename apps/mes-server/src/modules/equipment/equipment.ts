import { HOUR, type Millis } from '@shopfloor/oee-core';
import { shiftCuts, type ShiftPattern } from '@shopfloor/shift-calendar';
import { sql, type Kysely, type QueryCreator, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import type {
  FactSummary,
  IngestNotice,
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
}

export interface EquipmentLog {
  info(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface EquipmentOptions {
  readonly db: Kysely<Database>;
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
  /** The part of `ms` in provisional pieces (the open interval). */
  readonly provisionalMs: number;
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
}

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

  /** Stored pieces of one equipment overlapping [from, to), by time (and epoch). */
  async intervals(
    equipment: string,
    from: Date,
    to: Date,
    options: { readonly epoch?: number } = {},
  ): Promise<StoredInterval[]> {
    let query = this.#db
      .selectFrom('equipment.equipment_state_interval')
      .selectAll()
      .where('equipment', '=', equipment)
      // Pieces never exceed an hour: this bound lets the index on start_time do the work.
      .where('start_time', '>', new Date(from.getTime() - HOUR))
      .where('start_time', '<', to)
      .where('end_time', '>', from);
    if (options.epoch !== undefined) query = query.where('epoch', '=', options.epoch);
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
    let query = this.#db
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
    return rows.map((row) => ({
      equipment: row.equipment,
      epoch: row.epoch,
      state: row.state,
      ms: Number(row.ms),
      provisionalMs: Number(row.provisional_ms),
    }));
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
          await this.#onState(track, notice.fact);
          break;
        case 'anchor':
          if (notice.anchor.deviceEpoch === null) return;
          track = await this.#track(notice.anchor.equipment, notice.anchor.deviceEpoch);
          await this.#onAnchor(track, notice.anchor);
          break;
        case 'sample':
          await this.#onSample(notice.sample);
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
    };
    byEpoch.set(epoch, track);
    for (const older of byEpoch.values()) {
      if (older.epoch < epoch && !older.closed) await this.#close(older);
    }
    return track;
  }

  /** A newer epoch started: the old one's open interval becomes final at its watermark. */
  async #close(track: Track): Promise<void> {
    track.closed = true;
    track.closedAt = this.#watermarks.get(track.epoch);
    if (track.last) {
      await this.#rewriteTail(track, true);
    } else {
      await this.#db.transaction().execute((trx) => this.#saveSource(trx, track));
    }
  }

  async #onState(track: Track, fact: StateFact): Promise<void> {
    this.#raise(track.epoch, fact.sourceTime.getTime());
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
      if (succ) {
        const pieces = cutPieces(points.slice(0, -1), succ.at, this.#pattern, false);
        await this.#replace(track, pred?.at, succ.at, pieces, { facts, lastSeq });
      } else {
        const end = this.#end(track, last.at);
        const pieces = cutPieces(points, end, this.#pattern, !track.closed);
        await this.#replace(track, pred?.at, undefined, pieces, { facts, lastSeq });
        this.#tail(track, last, pieces, end);
      }
      this.#emit(track, pred?.at, succ?.at);
    }
    await this.#advance(track.epoch);
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

  async #onSample(sample: StoredSample): Promise<void> {
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
    await this.#track(sample.equipment, epoch);
    this.#raise(epoch, sample.sourceTime.getTime());
    await this.#advance(epoch);
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
    const pieces = cutPieces([last], end, this.#pattern, !track.closed).filter(
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
    const pieces = last ? cutPieces(points, end, this.#pattern, !track.closed) : [];
    track.clamped = clamped;
    await this.#replace(track, undefined, undefined, pieces, {
      facts: facts.length,
      lastSeq: facts.at(-1)?.seq ?? null,
    });
    track.last = last;
    if (last) this.#tail(track, last, pieces, end);
    this.#dirty.delete(track);
    this.#emit(track, undefined, undefined);
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
    const [summaries, anchors, sources, stored] = await Promise.all([
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
      };
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
    }
    this.#log.info({ tracks: pairs.size, rebuilt }, 'equipment intervals caught up');
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
