import { HOUR, type Millis } from '@shopfloor/oee-core';
import { sql, type Kysely } from 'kysely';
import type { Database } from './database.ts';
import { DB_ROLES } from './roles.ts';

/** The hourly continuous aggregates (migration 0006), each refreshed by the module that owns it. */
export type HourlyAggregate = 'equipment.state_hourly' | 'ingest.cycle_hourly';

export interface RefreshLog {
  info(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface RefreshOptions {
  /**
   * The pool refreshes run on: their own connection, outside a transaction (TimescaleDB refuses
   * one), without the API's statement timeout. Default: the module's pool.
   */
  readonly db?: Kysely<Database>;
  /** Wall time a change waits for more before the refresh runs (default 1 s). */
  readonly debounceMs?: number;
}

/** One finished refresh: the window, start null meaning from the beginning. */
export interface RefreshWindow {
  readonly start: Date | null;
  readonly end: Date;
  readonly ms: number;
}

/** What a reader needs to tell whether an hour of the aggregate is materialised and current. */
export interface AggregateStatus {
  /**
   * Every hour before this was covered by a refresh after its last change, except `dirty` ones.
   * Null until the start-up catch-up refresh has finished.
   */
  readonly refreshedThrough: Date | null;
  /** Hours changed below the watermark and not refreshed since, ascending. */
  readonly dirty: readonly Date[];
  /** Refreshes run since start. */
  readonly refreshes: number;
  /** Failed refreshes in a row (0 after a success): the retry backs off with them. */
  readonly failures: number;
  /**
   * Moves whenever `isRefreshed` may change: an hour marked dirty, a refresh finished or failed.
   * A reader samples it before and after its reads; unchanged, the finality it saw held
   * throughout (#120).
   */
  readonly generation: number;
}

const hourOf = (at: Millis): Millis => Math.floor(at / HOUR) * HOUR;
/** TimescaleDB's watermark of an aggregate never refreshed: its lowest timestamp (4714 BC). */
const NEVER_MS = -210_866_803_200_000;
const iso = (at: Millis): string => new Date(at).toISOString();
/** Longest wait before retrying a refresh that keeps failing. */
const RETRY_MAX_MS = 60_000;
/** Attempts `flush` makes before it gives up and throws. */
const FLUSH_ATTEMPTS = 5;
const FLUSH_RETRY_MS = 250;

/**
 * Refreshes one hourly continuous aggregate explicitly (ADR-0022), for the module that owns it.
 *
 * TimescaleDB keeps one watermark per aggregate: rows below it are read from the materialisation,
 * rows above it from the raw table. Refreshing a later hour moves the watermark past every
 * earlier hour, which then shows only what was materialised, so:
 * - the owner reports every change (`changed`); a change below the watermark (or below any
 *   window refreshed or being refreshed) marks its hour dirty;
 * - the owner says how far buckets are final (`through`);
 * - a refresh covers [earliest dirty hour, max(latest dirty hour + 1 h, final end)) in one call,
 *   so the refreshed range stays contiguous; the hours already covered and unchanged cost nothing,
 *   since TimescaleDB re-materialises only the invalidated ranges of the window;
 * - the first refresh is a catch-up from the beginning, which also covers changes made before a
 *   restart (TimescaleDB keeps their invalidations).
 *
 * Refreshes are debounced (`debounceMs` of wall time after the first change), run one at a time
 * from a timer, never on the caller's path. A failed one puts its hours back and is retried with
 * exponential backoff (the debounce doubled per failure in a row, at most a minute), back to the
 * plain debounce after a success.
 */
export class AggregateRefresher {
  readonly #view: HourlyAggregate;
  readonly #db: Kysely<Database>;
  readonly #debounceMs: number;
  readonly #log: RefreshLog;
  /** Hours (start, ms) to refresh. */
  #dirty = new Set<Millis>();
  /** Hours the running refresh covers for being dirty. */
  #inflight = new Set<Millis>();
  /** Below this, a change is dirty: the watermark, or any window refreshed or being refreshed. */
  #threshold: Millis = Infinity;
  /** End of the highest window refreshed; undefined until the catch-up finished. */
  #covered: Millis | undefined;
  /** How far buckets are final: the window's end must reach it. */
  #target: Millis = -Infinity;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #caughtUp: Promise<void> | undefined;
  #refreshes = 0;
  #generation = 0;
  /** Failed refreshes in a row: the backoff. */
  #failures = 0;
  #stopped = false;
  readonly #listeners = new Set<(window: RefreshWindow) => void>();

  constructor(view: HourlyAggregate, db: Kysely<Database>, debounceMs = 1_000, log?: RefreshLog) {
    this.#view = view;
    this.#db = db;
    this.#debounceMs = debounceMs;
    this.#log = log ?? { info: () => undefined, error: () => undefined };
  }

  /** The rows of [from, to) changed in the raw table (after commit). */
  changed(from: Millis, to: Millis): void {
    let marked = false;
    for (let hour = hourOf(from); hour < to; hour += HOUR) {
      if (hour < this.#threshold) {
        this.#dirty.add(hour);
        marked = true;
      }
    }
    if (marked) {
      this.#generation++;
      this.#schedule();
    }
  }

  /** Buckets are final up to `end` (a whole hour): the aggregate is to be materialised up to it. */
  through(end: Millis): void {
    if (end <= this.#target) return;
    this.#target = end;
    if (this.#covered === undefined || end > this.#covered) this.#schedule();
  }

  /**
   * The start-up catch-up refresh (once): from the beginning to past the watermark, so changes the
   * module never reported before a restart are materialised too. Resolves when it has finished.
   */
  catchUp(): Promise<void> {
    this.#caughtUp ??= this.#untilCaughtUp().catch((error: unknown) => {
      this.#caughtUp = undefined;
      throw error;
    });
    return this.#caughtUp;
  }

  async #untilCaughtUp(): Promise<void> {
    while (this.#covered === undefined) {
      if (this.#running) {
        await this.#running.catch(() => undefined);
        continue;
      }
      clearTimeout(this.#timer);
      this.#timer = undefined;
      await this.#run();
    }
  }

  /** Whether `hour` is materialised as it is now: covered by a refresh and not changed since. */
  isRefreshed(hour: Millis): boolean {
    return (
      this.#covered !== undefined &&
      hour + HOUR <= this.#covered &&
      !this.#dirty.has(hour) &&
      !this.#inflight.has(hour)
    );
  }

  status(): AggregateStatus {
    return {
      refreshedThrough:
        this.#covered === undefined || !Number.isFinite(this.#covered)
          ? null
          : new Date(this.#covered),
      dirty: [...new Set([...this.#dirty, ...this.#inflight])]
        .sort((a, b) => a - b)
        .map((hour) => new Date(hour)),
      refreshes: this.#refreshes,
      failures: this.#failures,
      generation: this.#generation,
    };
  }

  /** Listens for finished refreshes (logs, tests). Returns an unsubscribe. */
  onRefresh(listener: (window: RefreshWindow) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Runs what is pending now, without waiting for the debounce, and waits until idle. A failing
   * refresh is tried `FLUSH_ATTEMPTS` times in all, with a growing pause, before the error is
   * thrown (a transient database error at start-up must not stop the MES).
   */
  async flush(): Promise<void> {
    // The first refresh is the catch-up (pending until it has run).
    for (let failed = 0; ;) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      if (this.#running) {
        await this.#running.catch(() => undefined);
        continue;
      }
      if (!this.#pending()) return;
      try {
        await this.#run();
      } catch (error) {
        if (++failed >= FLUSH_ATTEMPTS) throw error;
        await new Promise((done) => setTimeout(done, FLUSH_RETRY_MS * 2 ** (failed - 1)));
      }
    }
  }

  /** Stops scheduling and waits for a running refresh. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  #pending(): boolean {
    return (
      this.#covered === undefined ||
      this.#dirty.size > 0 ||
      (Number.isFinite(this.#target) && this.#target > this.#covered)
    );
  }

  #schedule(): void {
    if (this.#stopped || this.#timer || this.#running) return;
    const delay = Math.min(this.#debounceMs * 2 ** this.#failures, RETRY_MAX_MS);
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        // A flush or the catch-up is running: it schedules again when it ends, if anything is left.
        if (this.#running) return;
        this.#run().catch(() => undefined);
      },
      Math.max(delay, this.#debounceMs),
    );
    this.#timer.unref();
  }

  /** One refresh; the first one is the catch-up. Another follows if changes came meanwhile. */
  #run(): Promise<void> {
    const run = this.#refresh()
      .then(() => {
        this.#failures = 0;
      })
      .catch((error: unknown) => {
        this.#failures++;
        this.#log.error(
          { err: error, view: this.#view, failures: this.#failures },
          'continuous aggregate refresh failed',
        );
        throw error;
      })
      .finally(() => {
        this.#running = undefined;
        if (this.#pending()) this.#schedule();
      });
    this.#running = run;
    return run;
  }

  async #refresh(): Promise<void> {
    const catchUp = this.#covered === undefined;
    let watermark = -Infinity;
    if (catchUp) {
      watermark = (await this.#watermark()) ?? -Infinity;
      this.#threshold = Number.isFinite(watermark) ? watermark : -Infinity;
    }
    const taken = this.#dirty;
    this.#dirty = new Set();
    this.#inflight = taken;
    const hours = [...taken];
    const covered = this.#covered ?? -Infinity;
    const end = Math.max(
      hours.length > 0 ? Math.max(...hours) + HOUR : -Infinity,
      this.#target,
      covered,
      watermark,
    );
    // Every earlier hour was covered after its last change, unless it is dirty; nothing was
    // covered yet: from the beginning.
    const start =
      catchUp || !Number.isFinite(covered)
        ? null
        : Math.min(hours.length > 0 ? Math.min(...hours) : covered, covered);
    if (!Number.isFinite(end) || (start !== null && end <= start)) {
      this.#inflight = new Set();
      if (catchUp) this.#covered = -Infinity;
      return;
    }
    // From here on a change below `end` may be missed by this refresh's snapshot: it is dirty.
    this.#threshold = Math.max(this.#threshold, end);
    const began = performance.now();
    try {
      // Only the aggregate's owner may refresh it, and nothing can wrap the CALL (a function, a
      // procedure, a transaction): so the MES's role, a member of `mes_cagg` without inheriting
      // its rights, assumes it for the CALL on one connection, each step its own statement
      // outside a transaction (#169, ADR-0022 amendment, ADR-0027).
      await this.#db.connection().execute(async (connection) => {
        await sql.raw(`SET ROLE ${DB_ROLES.aggregates}`).execute(connection);
        try {
          await sql
            .raw(
              `CALL refresh_continuous_aggregate('${this.#view}', ${start === null ? 'NULL' : `'${iso(start)}'::timestamptz`}, '${iso(end)}'::timestamptz)`,
            )
            .execute(connection);
        } finally {
          await sql`RESET ROLE`.execute(connection);
        }
      });
    } catch (error) {
      // Retried with the next refresh.
      for (const hour of taken) this.#dirty.add(hour);
      this.#inflight = new Set();
      this.#generation++;
      throw error;
    }
    const ms = Math.round(performance.now() - began);
    this.#refreshes++;
    this.#generation++;
    this.#inflight = new Set();
    this.#covered = Math.max(covered, end);
    const window: RefreshWindow = {
      start: start === null ? null : new Date(start),
      end: new Date(end),
      ms,
    };
    this.#log.info(
      { view: this.#view, start: window.start, end: window.end, ms, catchUp },
      'continuous aggregate refreshed',
    );
    for (const listener of this.#listeners) listener(window);
  }

  /** The aggregate's watermark in TimescaleDB, null when never refreshed. */
  async #watermark(): Promise<Millis | null> {
    const [schema, name] = this.#view.split('.');
    const row = await sql<{ micros: number | null }>`
      SELECT _timescaledb_functions.cagg_watermark(mat_hypertable_id) AS micros
      FROM _timescaledb_catalog.continuous_agg
      WHERE user_view_schema = ${schema} AND user_view_name = ${name}`
      .execute(this.#db)
      .then((result) => result.rows[0]);
    if (!row) throw new Error(`${this.#view} is no continuous aggregate`);
    const ms = row.micros === null ? null : Math.floor(row.micros / 1000);
    return ms === null || ms <= NEVER_MS ? null : ms;
  }
}
