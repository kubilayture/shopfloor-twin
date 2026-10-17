import { createHash, randomUUID } from 'node:crypto';
import { PROBLEM_TYPES, type ProblemType } from '@shopfloor/contracts/mes-api';
import type { PlantConfig } from '@shopfloor/plant-config';
import {
  capability,
  checkRuleSet,
  comparePositions,
  estimateLimits,
  firstPass,
  firstVersion,
  spcChart,
  type Capability,
  type ChartName,
  type LimitVersion,
  type Position,
  type Reading,
  type RuleSet,
  type SpcChart,
} from '@shopfloor/spc-core';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { Counter, Histogram, type Registry } from 'prom-client';
import type { Database } from '../../db/database.ts';
import { Identity, auditActor, isAuthenticated, nameOf, type WriteBy } from '../identity/index.ts';
import type { CycleFact, DeviceProgress, IngestNotice } from '../ingest/index.ts';
import {
  derivedSignals,
  inUnit,
  isFinal,
  keyParts,
  passesOf,
  planSignals,
  readingKey,
  sameLimits,
  signalKey,
  stepsOf,
  storeLimits,
  versionsOf,
  type LimitEvent,
  type PointRef,
  type Progress,
  type StoredSignal,
  type VersionRecord,
  type WithdrawalCause,
} from './derive.ts';
import type {
  ControlLimitTable,
  MeasurementTable,
  SignalStatus,
  SpcSignalTable,
} from './tables.ts';

/** What the quality module reads of ingest (#200). */
export interface QualityIngest {
  onStored(listener: (notice: IngestNotice) => void | Promise<void>): () => void;
  cycleFacts(options: {
    readonly epoch: number;
    readonly partIds?: readonly number[];
    readonly equipment?: string;
    readonly seqs?: readonly number[];
  }): Promise<CycleFact[]>;
  cycleFactCounts(): Promise<
    readonly { readonly equipment: string; readonly epoch: number; readonly facts: number }[]
  >;
  deviceProgress(equipment: string): Promise<DeviceProgress>;
  /** `deviceProgress` once every fact it counts has been announced (#178). */
  announcedProgress(equipment: readonly string[]): Promise<Map<string, DeviceProgress>>;
}

/** A characteristic as configured (`quality.yaml`, the leak test's limit and resolution). */
export interface CharacteristicConfig {
  readonly id: string;
  readonly name: string;
  readonly equipment: string;
  readonly operation: string;
  readonly unit: string;
  readonly resolution: number;
  readonly upperSpec: number;
  readonly subgroupSize: number;
  readonly baselineSubgroups: number;
  readonly rules: RuleSet;
}

/** The characteristics of a plant configuration: `quality.yaml` with the leak test's figures. */
export function characteristicsOf(plant: PlantConfig): CharacteristicConfig[] {
  const leak = plant.process.leakTest;
  return plant.quality.characteristics.map((c) => ({
    id: c.id,
    name: c.name,
    equipment: c.equipment,
    operation: c.operation,
    unit: leak.unit,
    resolution: leak.resolution,
    upperSpec: leak.upperLimit,
    subgroupSize: c.subgroupSize,
    baselineSubgroups: c.baselineSubgroups,
    rules: checkRuleSet(c.rules as RuleSet),
  }));
}

export interface QualityLog {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface QualityOptions {
  readonly db: Kysely<Database>;
  /** The API's pool for reads (default `db`). */
  readonly readDb?: Kysely<Database>;
  readonly ingest: QualityIngest;
  readonly characteristics: readonly CharacteristicConfig[];
  /** The plant clock (the newest epoch's watermark): limit writes, audit and detection times. */
  readonly clock?: () => Date | undefined;
  /** How often the charts are brought up to date (1 s; a notice brings one forward by 100 ms); 0: only `tick()`. */
  readonly tickMs?: number;
  readonly registry?: Registry;
  readonly log?: QualityLog;
}

export type QualityErrorKind = 'not-found' | 'conflict' | 'invalid';

/** A refused write: the API answers 404, 409 or 422. */
export class QualityError extends Error {
  readonly kind: QualityErrorKind;
  readonly type: ProblemType | undefined;

  constructor(kind: QualityErrorKind, message: string, type?: ProblemType) {
    super(message);
    this.kind = kind;
    this.type = type;
  }
}

/** A characteristic with its state. */
export interface CharacteristicRecord extends CharacteristicConfig {
  readonly version: number;
  readonly currentLimits: number | null;
  readonly baseline: { readonly needed: number; readonly final: number };
  readonly notice: {
    readonly kind: 'baseline-changed';
    readonly at: Date;
    readonly detail: string;
  } | null;
  readonly signals: { readonly open: number; readonly unacknowledged: number };
}

/** A stored signal episode. */
export interface SignalRecord {
  readonly id: number;
  readonly characteristic: string;
  readonly version: number;
  readonly chart: ChartName;
  readonly rule: number;
  readonly first: PointRef;
  readonly last: PointRef;
  readonly points: number;
  readonly closedBy: PointRef | null;
  readonly baseline: boolean;
  /** The tester is final through its closing point (open: its last point). */
  readonly extentFinal: boolean;
  readonly status: SignalStatus;
  readonly detectedAt: Date;
  readonly detectedPlantAt: Date | null;
  readonly finalAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly withdrawnReason: string | null;
  readonly acknowledged: {
    readonly by: string;
    readonly at: Date;
    readonly plantAt: Date | null;
    readonly comment: string;
  } | null;
  readonly rowVersion: number;
}

/** The readings since the last in-control point before an episode (#201: a suggested hold scope). */
export interface SignalWindow {
  readonly signal: SignalRecord;
  /** The last in-control point before the episode; null: from its segment's start. */
  readonly after: Position | null;
  /** The window's first reading: just after `after`, or the segment's first reading. */
  readonly from: Position;
  /** The episode's last triggering point. */
  readonly through: Position;
  /** Every reading (retests included) after `after` through `through`, in chart order. */
  readonly readings: readonly {
    readonly epoch: number;
    readonly partId: number;
    readonly pass: number;
    readonly at: number;
    readonly seq: number;
  }[];
  /** The episode's `extentFinal`. */
  readonly final: boolean;
}

/**
 * The readings of a signal episode's window (pure, #201 review L3): from just after the episode
 * chart's last point that fired no rule before the episode's first point, in the same segment, or
 * from the segment's start (its first reading) when there is none, through the episode's last
 * triggering point; every reading, retests included, in chart order. Undefined when the chart has
 * no point at `first`.
 */
export function windowOf(
  points: readonly {
    readonly position: Position;
    readonly segment: number;
    readonly rules: readonly number[];
  }[],
  readings: readonly (Position & { readonly key: string })[],
  first: { readonly epoch: number; readonly at: number; readonly seq: number },
  last: { readonly epoch: number; readonly at: number; readonly seq: number },
):
  | {
      after: Position | null;
      from: Position;
      through: Position;
      readings: { epoch: number; partId: number; pass: number; at: number; seq: number }[];
    }
  | undefined {
  const index = points.findIndex(
    (p) =>
      p.position.epoch === first.epoch &&
      p.position.at === first.at &&
      p.position.seq === first.seq,
  );
  const start = points[index];
  if (!start) return undefined;
  let after: Position | null = null;
  for (let i = index - 1; i >= 0; i--) {
    const point = points[i];
    if (point?.segment !== start.segment) break;
    if (point.rules.length === 0) {
      after = point.position;
      break;
    }
  }
  const through: Position = { epoch: last.epoch, at: last.at, seq: last.seq };
  // The segment is the device epoch of the episode's first point (ADR-0032: a new epoch starts a
  // new segment): its first reading is where a window without an in-control point starts.
  const inWindow = [...readings]
    .filter(
      (r) =>
        comparePositions(r, through) <= 0 &&
        (after === null ? r.epoch === start.position.epoch : comparePositions(r, after) > 0),
    )
    .sort(comparePositions);
  const head = inWindow[0];
  return {
    after,
    from: head ? { epoch: head.epoch, at: head.at, seq: head.seq } : start.position,
    through,
    readings: inWindow.map((r) => ({ ...keyParts(r.key), at: r.at, seq: r.seq })),
  };
}

/** A measurement as the module reports it. */
export interface MeasurementRecord {
  readonly epoch: number;
  readonly partId: number;
  readonly pass: number;
  readonly at: Date;
  readonly seq: number;
  readonly value: number;
  readonly steps: number;
  readonly upperLimit: number;
  readonly result: 'good' | 'scrap' | 'rework';
  readonly final: boolean;
}

/** A limit version with its capability against the specification. */
export interface LimitRecord extends VersionRecord {
  readonly capability: Capability | null;
}

/** A characteristic's charts as derived on read. */
export interface ChartView {
  readonly characteristic: CharacteristicRecord;
  readonly limits: readonly LimitRecord[];
  readonly chart: SpcChart;
  /** Whether a position is final (the tester's progress when read). */
  readonly final: (p: Position) => boolean;
  readonly finalThrough: {
    readonly epoch: number;
    readonly seq: number;
    readonly at: Date | null;
  } | null;
  readonly retests: readonly MeasurementRecord[];
  readonly signals: readonly SignalRecord[];
  /** The entity tag of this answer when served from the derivation in memory, else null. */
  readonly tag: string | null;
}

/** Who writes and which request (the audit's). */
export interface QualityWriteContext {
  readonly by: WriteBy;
  readonly requestId?: string;
}

/** A change for push and listeners. */
export type QualityChange =
  | {
      readonly type: 'signal';
      readonly event: 'opened' | 'updated' | 'final' | 'withdrawn' | 'removed' | 'acknowledged';
      readonly signal: SignalRecord;
    }
  | {
      readonly type: 'characteristic';
      readonly event: 'readings' | 'limits' | 'notice';
      readonly characteristic: CharacteristicRecord;
    };

export const LIMIT_AUDIT_ENTITY = 'control_limit';
export const SIGNAL_AUDIT_ENTITY = 'spc_signal';
/** The actor of version 1 (automatic). */
export const SYSTEM_ACTOR = 'system';

const silent: QualityLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Per characteristic: the readings (by key) and the limit versions, kept in step with the tables. */
interface State {
  readonly config: CharacteristicConfig;
  readonly readings: Map<string, Reading>;
  versions: VersionRecord[];
  /** Something changed since the last derivation (readings, versions). */
  dirty: boolean;
  /** Readings changed since the last derivation (a push of `readings`). */
  readingsChanged: boolean;
  /** The earliest position whose readings changed since the last derivation. */
  earliest: Position | null;
  /** The tester's progress the episodes were last derived with. */
  progress: string;
  /** The stored episode rows, as the last write left them (null: read them first). */
  signals: Selectable<SpcSignalTable>[] | null;
  /** A `readings` summary is due for push. */
  summaryDue: boolean;
  /** The measurement rows by reading key, in step with `readings` (the retests on read). */
  readonly rows: Map<string, Selectable<MeasurementTable>>;
  /** The chart as last derived and the progress it was judged with: what reads serve. */
  view: { readonly chart: SpcChart; readonly progress: Progress } | null;
  /** Rises with every derivation, write and acknowledgement: the chart's entity tag. */
  revision: number;
}

/**
 * The `quality` module, SPC part (#200, Phase 8 plan "SPC", ADR-0032): characteristics from
 * `quality.yaml`; one measurement per cycle fact of the characteristic's machine (passes counted
 * per part, rebuilt like execution's records); limit version 1 estimated from the baseline's
 * final first-pass readings, created at the baseline's last reading and never re-derived (a late
 * reading inside it raises `baseline-changed`); later versions and their end by a quality user;
 * signal episodes derived from the readings by `spc-core` and stored with their finality (final
 * once the tester is final through the triggering point), withdrawn when re-derived away, and
 * acknowledged once each. Points and subgroups are derived on read.
 */
export class Quality {
  readonly #db: Kysely<Database>;
  readonly #readDb: Kysely<Database>;
  readonly #options: QualityOptions;
  readonly #ingest: QualityIngest;
  readonly #log: QualityLog;
  readonly #listeners = new Set<(change: QualityChange) => void>();
  readonly #states = new Map<string, State>();
  /** Cycle facts heard of, by `equipment␀epoch`. */
  readonly #pending = new Map<string, Set<number>>();
  readonly #derived: Histogram | undefined;
  readonly #signals: Counter | undefined;
  #timer: NodeJS.Timeout | undefined;
  #kick: NodeJS.Timeout | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  /** Tells this process's chart tags from another start's. */
  readonly #instance = randomUUID().slice(0, 8);
  /** The `readings` summaries being read for push, off the derivation's path. */
  #summaries: Promise<void> = Promise.resolve();
  #started = false;
  #stopping = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: QualityOptions) {
    this.#options = options;
    this.#db = options.db;
    this.#readDb = options.readDb ?? options.db;
    this.#ingest = options.ingest;
    this.#log = options.log ?? silent;
    for (const config of options.characteristics) {
      this.#states.set(config.id, {
        config,
        readings: new Map(),
        versions: [],
        dirty: true,
        readingsChanged: false,
        earliest: null,
        progress: '',
        signals: null,
        summaryDue: false,
        rows: new Map(),
        view: null,
        revision: 0,
      });
    }
    const registers = options.registry ? [options.registry] : [];
    if (registers.length > 0) {
      this.#derived = new Histogram({
        name: 'mes_quality_spc_derive_seconds',
        help: 'One derivation of a characteristic’s charts and episodes, the database rewrite included',
        buckets: [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 1],
        registers,
      });
      this.#signals = new Counter({
        name: 'mes_quality_signals_total',
        help: 'Signal episodes opened, made final and withdrawn',
        labelNames: ['event'] as const,
        registers,
      });
    }
  }

  /** Listens for signal and characteristic changes; returns an unsubscribe. */
  onChange(listener: (change: QualityChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * Seeds the characteristics, rebuilds every measurement from the cycle facts (catch-up), loads
   * the limit versions, follows ingest's notices and starts the tick.
   */
  async start(): Promise<void> {
    await this.#seed();
    this.#unsubscribe = this.#ingest.onStored((notice) => {
      this.#onNotice(notice);
    });
    this.#started = true;
    await this.#serial(() => this.#catchUp());
    await this.tick();
    const period = this.#options.tickMs ?? 1_000;
    if (period > 0) {
      this.#timer = setInterval(() => {
        this.tick().catch((error: unknown) => {
          this.#log.error({ err: error }, 'quality: tick failed');
        });
      }, period);
      this.#timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#timer);
    clearTimeout(this.#kick);
    this.#unsubscribe?.();
    await this.#queue.catch(() => undefined);
    await this.#summaries;
  }

  /**
   * One round: the tester's progress first (#178: every fact it counts was announced, so it is in
   * the pending sets taken next), then the measurements of the parts heard of, then each
   * characteristic whose readings, versions or progress changed is derived again: version 1 once
   * its baseline is final, the `baseline-changed` notice, and the episodes written.
   */
  async tick(): Promise<void> {
    if (!this.#started || this.#stopping) return;
    await this.#serial(async () => {
      const machines = [...new Set([...this.#states.values()].map((s) => s.config.equipment))];
      const progress = await this.#ingest.announcedProgress(machines);
      const pending = [...this.#pending];
      this.#pending.clear();
      try {
        for (const [key, seqs] of pending) {
          const [equipment = '', epochText = '0'] = key.split('\u0000');
          await this.#rebuild(equipment, Number(epochText), [...seqs]);
        }
        for (const state of this.#states.values()) {
          await this.#derive(state, progressOf(progress.get(state.config.equipment)));
        }
      } catch (error) {
        for (const [key, seqs] of pending) {
          const kept = this.#pending.get(key) ?? new Set<number>();
          for (const seq of seqs) kept.add(seq);
          this.#pending.set(key, kept);
        }
        throw error;
      }
    });
  }

  // ---- reads ----

  /** Every characteristic with its state. */
  async characteristics(db: Kysely<Database> = this.#readDb): Promise<CharacteristicRecord[]> {
    const result: CharacteristicRecord[] = [];
    for (const state of this.#states.values()) {
      result.push(await this.#summary(state.config, db));
    }
    return result;
  }

  /** Each characteristic's machine, from the configuration (no read; #203, the terminal). */
  machines(): { readonly characteristic: string; readonly equipment: string }[] {
    return [...this.#states.values()].map((s) => ({
      characteristic: s.config.id,
      equipment: s.config.equipment,
    }));
  }

  async characteristic(id: string): Promise<CharacteristicRecord | undefined> {
    const state = this.#states.get(id);
    return state && this.#summary(state.config, this.#readDb);
  }

  /** The limit versions of a characteristic, with their capability. */
  async limits(id: string): Promise<LimitRecord[] | undefined> {
    const state = this.#states.get(id);
    if (!state) return undefined;
    return (await this.#versions(id, this.#readDb)).map((v) => withCapability(v, state.config));
  }

  /**
   * A characteristic's charts derived on read from its stored readings and limit versions
   * (`spc-core`), with each point's finality, the retests and every stored episode.
   */
  async chart(id: string): Promise<ChartView | undefined> {
    const state = this.#states.get(id);
    if (!state) return undefined;
    const config = state.config;
    const db = this.#readDb;
    const view = state.view;
    if (view !== null) {
      // The derivation in memory (#200 review M5): no reading or chart is derived per request;
      // only the episodes (acknowledgements) and the summary are read.
      const tag = this.chartTag(id) ?? '';
      const [signals, characteristic] = await Promise.all([
        this.signals({ characteristic: id, withdrawn: true, limit: 100_000 }),
        this.#summary(config, db),
      ]);
      const p = view.progress;
      const final = (position: Position): boolean => isFinal(position, p);
      return {
        characteristic,
        limits: state.versions.map((v) => withCapability(v, config)),
        chart: view.chart,
        final,
        finalThrough:
          p.epoch === null || p.settledSeq === null
            ? null
            : { epoch: p.epoch, seq: p.settledSeq, at: p.settledTime ?? null },
        retests: [...state.rows.values()]
          .filter((r) => r.pass > 1)
          .sort(
            (a, b) =>
              a.epoch - b.epoch ||
              a.measured_at.getTime() - b.measured_at.getTime() ||
              a.seq - b.seq,
          )
          .map((r) => toMeasurement(r, final)),
        signals: signals.signals,
        tag,
      };
    }
    const [rows, versions, progress, signals, characteristic] = await Promise.all([
      this.#measurementRows(id, db),
      this.#versions(id, db),
      this.#ingest.deviceProgress(config.equipment),
      this.signals({ characteristic: id, withdrawn: true, limit: 100_000 }),
      this.#summary(config, db),
    ]);
    const p = progressOf(progress);
    const final = (position: Position): boolean => isFinal(position, p);
    const readings = rows.map(toReading);
    const chart = spcChart({
      readings,
      versions,
      rules: config.rules,
      subgroupSize: config.subgroupSize,
    });
    return {
      characteristic,
      limits: versions.map((v) => withCapability(v, config)),
      chart,
      final,
      finalThrough:
        progress.epoch === null || progress.settledSeq === null
          ? null
          : { epoch: progress.epoch, seq: progress.settledSeq, at: progress.settledTime },
      retests: rows.filter((r) => r.pass > 1).map((r) => toMeasurement(r, final)),
      signals: signals.signals,
      tag: null,
    };
  }

  /**
   * The chart's entity tag while it is served from memory: it changes with every derivation,
   * limit write and acknowledgement, and with each MES start. Null before the first derivation.
   */
  chartTag(id: string, query = ''): string | null {
    const state = this.#states.get(id);
    if (!state?.view) return null;
    // The normalized query is part of the tag: another range is another representation.
    const variant = createHash('sha256').update(query).digest('hex').slice(0, 8);
    return `"${this.#instance}-${id}-${String(state.revision)}-${variant}"`;
  }

  /** A characteristic's measurements in chart order (every pass); at most `limit`. */
  async measurements(
    id: string,
    query: { readonly from?: Date; readonly to?: Date; readonly limit?: number } = {},
  ): Promise<{ measurements: MeasurementRecord[]; truncated: boolean } | undefined> {
    const state = this.#states.get(id);
    if (!state) return undefined;
    const limit = query.limit ?? 5_000;
    let select = this.#readDb
      .selectFrom('quality.measurement')
      .selectAll()
      .where('characteristic', '=', id);
    if (query.from !== undefined) select = select.where('measured_at', '>=', query.from);
    if (query.to !== undefined) select = select.where('measured_at', '<', query.to);
    const rows = await select
      .orderBy('epoch')
      .orderBy('measured_at')
      .orderBy('seq')
      .limit(limit + 1)
      .execute();
    const p = progressOf(await this.#ingest.deviceProgress(state.config.equipment));
    return {
      measurements: rows
        .slice(0, limit)
        .map((r) => toMeasurement(r, (position) => isFinal(position, p))),
      truncated: rows.length > limit,
    };
  }

  /** Signal episodes, newest first by their first point; withdrawn ones only on request. */
  async signals(
    query: {
      readonly characteristic?: string;
      readonly status?: readonly SignalStatus[];
      readonly withdrawn?: boolean;
      readonly unacknowledged?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<{ signals: SignalRecord[]; truncated: boolean }> {
    const limit = query.limit ?? 500;
    let select = this.#readDb.selectFrom('quality.spc_signal').selectAll();
    if (query.characteristic !== undefined) {
      select = select.where('characteristic', '=', query.characteristic);
    }
    if (query.status !== undefined && query.status.length > 0) {
      select = select.where('status', 'in', [...query.status]);
    } else if (query.withdrawn !== true) {
      select = select.where('status', '<>', 'withdrawn');
    }
    if (query.unacknowledged === true) select = select.where('ack_by', 'is', null);
    const rows = await select
      .orderBy('first_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    return { signals: rows.slice(0, limit).map(toSignal), truncated: rows.length > limit };
  }

  async signal(id: number): Promise<SignalRecord | undefined> {
    const row = await this.#readDb
      .selectFrom('quality.spc_signal')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toSignal(row);
  }

  /**
   * The readings tested since the last in-control point before a signal episode (#201, plan
   * "Signals and people": the hold a quality user may open from it): every reading, retests
   * included, after the episode's chart's last point that fired no rule before the episode's first
   * point (in its segment; none: from the segment's start) through its last triggering point.
   * `final` is the episode's `extentFinal` (its last point won't move but for a written-off gap's
   * fact). Undefined for an unknown or withdrawn signal, or one whose point the chart no longer has.
   */
  async signalWindow(id: number): Promise<SignalWindow | undefined> {
    const signal = await this.signal(id);
    if (!signal || signal.status === 'withdrawn') return undefined;
    const view = await this.chart(signal.characteristic);
    if (!view) return undefined;
    const window = windowOf(
      view.chart.points[signal.chart],
      [...view.chart.firstPass, ...view.chart.retests],
      signal.first,
      signal.last,
    );
    if (!window) return undefined;
    const { after, from, through, readings } = window;
    return {
      signal,
      after,
      from,
      through,
      readings,
      final: signal.extentFinal,
    };
  }

  // ---- writes ----

  /**
   * Estimates a new limit version from the final first-pass readings whose plant time lies in
   * [from, to] (`spc:limits`, plan "Control limits, versioned"): it applies to the readings after
   * the plant clock W, `from` = (newest epoch, W, last seq received + 1), so a reading already
   * received at exactly W keeps its version; the characteristic's version read (409
   * `limits-stale`); refused while version 1 doesn't exist yet (409 `limits-v1-missing`: it is
   * estimated automatically), checked before the estimate, and for a window without a moving
   * range or a complete subgroup (422). Clears a `baseline-changed` notice. Audited.
   */
  async createLimits(
    id: string,
    request: {
      readonly version: number;
      readonly from: Date;
      readonly to: Date;
      readonly comment: string;
    },
    context: QualityWriteContext,
  ): Promise<{ characteristic: CharacteristicRecord; limits: LimitRecord }> {
    const state = this.#state(id);
    const config = state.config;
    return this.#serial(async () => {
      if (!state.versions.some((v) => v.version === 1)) {
        throw new QualityError(
          'conflict',
          'limit version 1 is estimated automatically once the baseline is final; none exists yet',
          PROBLEM_TYPES.limitsV1Missing,
        );
      }
      const device = await this.#ingest.deviceProgress(config.equipment);
      const progress = progressOf(device);
      const final = (p: Position): boolean => isFinal(p, progress);
      const ordered = firstPass([...state.readings.values()].filter(final));
      const inside = ordered.filter(
        (r) => r.at >= request.from.getTime() && r.at <= request.to.getTime(),
      );
      const first = inside[0];
      const last = inside.at(-1);
      if (request.from.getTime() > request.to.getTime() || !first || !last) {
        throw new QualityError(
          'invalid',
          'the window holds no final first-pass reading of the characteristic',
        );
      }
      const window = { from: positionOf(first), to: positionOf(last) };
      let limits;
      try {
        limits = estimateLimits(ordered, window, config.subgroupSize);
      } catch (error) {
        throw new QualityError('invalid', (error as Error).message);
      }
      const plantAt = this.#plantNow(state);
      const from = boundary(device, plantAt, last.epoch);
      const created = await this.#db.transaction().execute(async (trx) => {
        const row = await this.#lockCharacteristic(trx, id, request.version);
        const events = await this.#events(id, trx);
        const version = Math.max(...events.map((e) => e.version)) + 1;
        await this.#appendEvent(trx, {
          characteristic: id,
          n: events.length + 1,
          kind: 'created',
          version,
          plantAt,
          position: from,
          limits: storeLimits(limits),
          comment: request.comment,
          actor: nameOf(context.by),
        });
        await this.#bump(trx, id, row.version, true);
        await Identity.audit(trx, {
          actor: auditActor(context.by),
          authenticated: isAuthenticated(context.by),
          action: 'spc.limits-create',
          entityType: LIMIT_AUDIT_ENTITY,
          entityId: `${id}/${String(version)}`,
          before: { characteristicVersion: row.version },
          after: {
            characteristicVersion: row.version + 1,
            version,
            from: request.from.toISOString(),
            to: request.to.toISOString(),
            readings: limits.counts.readings,
            subgroups: limits.counts.subgroups,
            comment: request.comment,
          },
          requestId: context.requestId,
          plantAt: new Date(plantAt),
        });
        return version;
      });
      await this.#reloadVersions(state);
      await this.#derive(state, progress, 'version');
      const characteristic = await this.#summary(config, this.#db);
      this.#emit({ type: 'characteristic', event: 'limits', characteristic });
      const record = state.versions.find((v) => v.version === created);
      if (!record) throw new Error(`limit version ${String(created)} not found after its write`);
      return { characteristic, limits: withCapability(record, config) };
    });
  }

  /**
   * Ends a limit version at the plant clock (`spc:limits`): points from then on are judged by the
   * highest other version open there, or not at all. 409 `limits-stale` on a stale
   * characteristic version; 409 for a version already ended; 404 for an unknown one.
   */
  async endLimits(
    id: string,
    version: number,
    request: { readonly version: number; readonly comment: string },
    context: QualityWriteContext,
  ): Promise<{ characteristic: CharacteristicRecord; limits: LimitRecord }> {
    const state = this.#state(id);
    const config = state.config;
    return this.#serial(async () => {
      const device = await this.#ingest.deviceProgress(config.equipment);
      const progress = progressOf(device);
      const plantAt = this.#plantNow(state);
      await this.#db.transaction().execute(async (trx) => {
        const row = await this.#lockCharacteristic(trx, id, request.version);
        const events = await this.#events(id, trx);
        if (!events.some((e) => e.kind === 'created' && e.version === version)) {
          throw new QualityError('not-found', `no limit version ${String(version)} of ${id}`);
        }
        if (events.some((e) => e.kind === 'ended' && e.version === version)) {
          throw new QualityError(
            'conflict',
            `limit version ${String(version)} is ended already`,
            PROBLEM_TYPES.limitsEnded,
          );
        }
        const until = boundary(device, plantAt, state.versions.at(-1)?.limits.window.to.epoch ?? 0);
        await this.#appendEvent(trx, {
          characteristic: id,
          n: events.length + 1,
          kind: 'ended',
          version,
          plantAt,
          position: until,
          limits: null,
          comment: request.comment,
          actor: nameOf(context.by),
        });
        await this.#bump(trx, id, row.version, false);
        await Identity.audit(trx, {
          actor: auditActor(context.by),
          authenticated: isAuthenticated(context.by),
          action: 'spc.limits-end',
          entityType: LIMIT_AUDIT_ENTITY,
          entityId: `${id}/${String(version)}`,
          before: { characteristicVersion: row.version, endedAt: null },
          after: {
            characteristicVersion: row.version + 1,
            endedAt: new Date(plantAt).toISOString(),
            comment: request.comment,
          },
          requestId: context.requestId,
          plantAt: new Date(plantAt),
        });
      });
      await this.#reloadVersions(state);
      await this.#derive(state, progress, 'version');
      const characteristic = await this.#summary(config, this.#db);
      this.#emit({ type: 'characteristic', event: 'limits', characteristic });
      const record = state.versions.find((v) => v.version === version);
      if (!record) throw new Error(`limit version ${String(version)} not found after its end`);
      return { characteristic, limits: withCapability(record, config) };
    });
  }

  /**
   * Acknowledges a signal episode once (`spc:ack`, plan "Signals and people"): the signal's row
   * version read (409 `signal-stale`); 409 when it is acknowledged already or withdrawn. Audited
   * with the session's user and the plant time.
   */
  async acknowledge(
    id: number,
    request: { readonly version: number; readonly comment: string },
    context: QualityWriteContext,
  ): Promise<SignalRecord> {
    const signal = await this.#serial(() =>
      this.#db
        .transaction()
        .execute(async (trx) => {
          const row = await trx
            .selectFrom('quality.spc_signal')
            .selectAll()
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst();
          if (!row) throw new QualityError('not-found', `no signal ${String(id)}`);
          if (row.row_version !== request.version) {
            throw new QualityError(
              'conflict',
              `signal ${String(id)} changed: version is ${String(row.row_version)}, not ${String(request.version)}`,
              PROBLEM_TYPES.signalStale,
            );
          }
          if (row.status === 'withdrawn') {
            throw new QualityError(
              'conflict',
              `signal ${String(id)} is withdrawn`,
              PROBLEM_TYPES.signalWithdrawn,
            );
          }
          if (row.ack_by !== null) {
            throw new QualityError(
              'conflict',
              `signal ${String(id)} is acknowledged already by ${row.ack_by}`,
              PROBLEM_TYPES.signalAcknowledged,
            );
          }
          const plantAt = this.#options.clock?.() ?? null;
          const updated = await trx
            .updateTable('quality.spc_signal')
            .set({
              ack_by: nameOf(context.by),
              ack_at: sql<Date>`clock_timestamp()`,
              ack_plant_at: plantAt,
              ack_comment: request.comment,
              row_version: row.row_version + 1,
            })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await Identity.audit(trx, {
            actor: auditActor(context.by),
            authenticated: isAuthenticated(context.by),
            action: 'spc.ack',
            entityType: SIGNAL_AUDIT_ENTITY,
            entityId: String(id),
            before: { rowVersion: row.row_version, acknowledged: false },
            after: {
              rowVersion: updated.row_version,
              acknowledged: true,
              comment: request.comment,
              characteristic: row.characteristic,
              key: signalKey(toStored(row)),
              status: row.status,
            },
            requestId: context.requestId,
            plantAt: plantAt ?? undefined,
          });
          return toSignal(updated);
        })
        .then((acknowledged) => {
          // After COMMIT, still in the queue (#200 re-review): a chart read between the write and
          // its commit must not take the new tag with a body that lacks the acknowledgement.
          const state = this.#states.get(acknowledged.characteristic);
          if (state) {
            state.signals = null;
            state.revision += 1;
          }
          return acknowledged;
        }),
    );
    this.#emit({ type: 'signal', event: 'acknowledged', signal });
    return signal;
  }

  // ---- internals ----

  #state(id: string): State {
    const state = this.#states.get(id);
    if (!state) throw new QualityError('not-found', `no characteristic ${id}`);
    return state;
  }

  async #seed(): Promise<void> {
    for (const { config } of this.#states.values()) {
      const values = {
        name: config.name,
        equipment: config.equipment,
        operation: config.operation,
        unit: config.unit,
        resolution: config.resolution,
        upper_spec: config.upperSpec,
        subgroup_size: config.subgroupSize,
        baseline_subgroups: config.baselineSubgroups,
        rules: JSON.stringify(config.rules),
      };
      await this.#db
        .insertInto('quality.characteristic')
        .values({ id: config.id, ...values })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({ ...values, updated_at: sql<Date>`clock_timestamp()` }),
        )
        .execute();
    }
  }

  #onNotice(notice: IngestNotice): void {
    const ours = (equipment: string): boolean =>
      [...this.#states.values()].some((s) => s.config.equipment === equipment);
    let relevant = false;
    if (notice.type === 'cycle' && ours(notice.cycle.equipment)) {
      const key = `${notice.cycle.equipment}\u0000${String(notice.cycle.epoch)}`;
      const seqs = this.#pending.get(key) ?? new Set<number>();
      seqs.add(notice.cycle.seq);
      this.#pending.set(key, seqs);
      relevant = true;
    } else if (
      (notice.type === 'gaps' && ours(notice.equipment)) ||
      (notice.type === 'epoch' && ours(notice.equipment)) ||
      (notice.type === 'state' && ours(notice.fact.equipment)) ||
      (notice.type === 'sample' &&
        notice.sample.scope === 'device' &&
        ours(notice.sample.equipment))
    ) {
      // The tester's final-through may have moved: provisional episodes may become final.
      relevant = true;
    }
    if (relevant) this.#soon();
  }

  #soon(): void {
    if (this.#kick !== undefined || !this.#started || this.#options.tickMs === 0) return;
    this.#kick = setTimeout(() => {
      this.#kick = undefined;
      this.tick().catch((error: unknown) => {
        this.#log.error({ err: error }, 'quality: tick failed');
      });
    }, 100);
    this.#kick.unref();
  }

  /** Every measurement rebuilt from the cycle facts of each characteristic's machine. */
  async #catchUp(): Promise<void> {
    const counts = await this.#ingest.cycleFactCounts();
    for (const state of this.#states.values()) {
      await this.#reloadVersions(state);
      state.readings.clear();
      state.rows.clear();
      state.signals = null;
      for (const count of counts.filter((c) => c.equipment === state.config.equipment)) {
        const facts = await this.#ingest.cycleFacts({
          epoch: count.epoch,
          equipment: count.equipment,
        });
        await this.#store(state, count.epoch, facts, [...new Set(facts.map((f) => f.partId))]);
      }
      // Rows of an epoch whose facts are gone (none expected) are left to the next rebuild.
      for (const row of await this.#measurementRows(state.config.id, this.#db)) {
        const key = readingKey(row.epoch, row.part_id, row.pass);
        state.readings.set(key, toReading(row));
        state.rows.set(key, row);
      }
      state.dirty = true;
    }
  }

  /** Rebuilds the measurements of the parts whose facts were heard of. */
  async #rebuild(equipment: string, epoch: number, seqs: readonly number[]): Promise<void> {
    const states = [...this.#states.values()].filter((s) => s.config.equipment === equipment);
    if (states.length === 0) return;
    const parts = new Set<number>();
    for (let i = 0; i < seqs.length; i += 1_000) {
      for (const fact of await this.#ingest.cycleFacts({
        epoch,
        equipment,
        seqs: seqs.slice(i, i + 1_000),
      })) {
        parts.add(fact.partId);
      }
    }
    if (parts.size === 0) return;
    const list = [...parts];
    const facts: CycleFact[] = [];
    for (let i = 0; i < list.length; i += 1_000) {
      facts.push(
        ...(await this.#ingest.cycleFacts({ epoch, equipment, partIds: list.slice(i, i + 1_000) })),
      );
    }
    for (const state of states) await this.#store(state, epoch, facts, list);
  }

  /** Replaces the measurements of `parts` (one epoch) with those of their facts. */
  async #store(
    state: State,
    epoch: number,
    facts: readonly CycleFact[],
    parts: readonly number[],
  ): Promise<void> {
    const config = state.config;
    const byPart = new Map<number, CycleFact[]>();
    for (const fact of facts) {
      if (fact.equipment !== config.equipment) continue;
      byPart.set(fact.partId, [...(byPart.get(fact.partId) ?? []), fact]);
    }
    const rows: Selectable<MeasurementTable>[] = [];
    for (const [partId, cycles] of byPart) {
      const passes = passesOf(
        cycles.map((c) => ({ seq: c.seq, at: c.sourceTime.getTime(), result: c.result })),
      );
      for (const cycle of cycles) {
        const m = cycle.measurement;
        if (m?.characteristic !== config.id) continue;
        rows.push({
          equipment: cycle.equipment,
          epoch,
          seq: cycle.seq,
          characteristic: config.id,
          part_id: partId,
          pass: passes.get(cycle.seq) ?? 1,
          measured_at: cycle.sourceTime,
          value: m.value,
          steps: stepsOf(m.value, config.resolution),
          unit: m.unit,
          upper_limit: m.upperLimit,
          result: cycle.result,
        });
      }
    }
    const partSet = new Set(parts);
    const before = [...state.readings.values()].filter(
      (r) => r.epoch === epoch && partSet.has(keyParts(r.key).partId),
    );
    const after = rows.map(toReading);
    const unchanged =
      before.length === after.length &&
      after.every((r) => {
        const old = state.readings.get(r.key);
        return old?.value === r.value && old.seq === r.seq && old.at === r.at;
      });
    if (unchanged && before.length > 0) return;
    await this.#db.transaction().execute(async (trx) => {
      for (let i = 0; i < parts.length; i += 1_000) {
        await trx
          .deleteFrom('quality.measurement')
          .where('characteristic', '=', config.id)
          .where('epoch', '=', epoch)
          .where('part_id', 'in', parts.slice(i, i + 1_000))
          .execute();
      }
      for (let i = 0; i < rows.length; i += 1_000) {
        await trx
          .insertInto('quality.measurement')
          .values(rows.slice(i, i + 1_000))
          .execute();
      }
    });
    for (const reading of before) {
      state.readings.delete(reading.key);
      state.rows.delete(reading.key);
    }
    for (const row of rows) {
      const key = readingKey(row.epoch, row.part_id, row.pass);
      state.readings.set(key, toReading(row));
      state.rows.set(key, row);
    }
    if (before.length === 0 && after.length === 0) return;
    state.dirty = true;
    state.readingsChanged = true;
    for (const r of [...before, ...after]) {
      if (state.earliest === null || comparePositions(r, state.earliest) < 0) {
        state.earliest = positionOf(r);
      }
    }
  }

  /**
   * Derives a characteristic again when its readings or versions changed or the tester's
   * progress moved: version 1 once the baseline is final, the `baseline-changed` notice, then the
   * episodes brought in line with the chart (`planSignals`) in one transaction.
   */
  async #derive(state: State, progress: Progress, cause?: WithdrawalCause): Promise<void> {
    const signature = `${String(progress.epoch)}:${String(progress.settledSeq)}`;
    if (cause === undefined && !state.dirty && state.progress === signature) return;
    const started = performance.now();
    const config = state.config;
    const final = (p: Position): boolean => isFinal(p, progress);
    const readings = [...state.readings.values()];
    if (state.versions.length === 0) {
      const v1 = firstVersion(readings.filter(final), config);
      if (v1) await this.#createFirst(state, v1);
    } else if (state.earliest !== null) {
      const v1 = state.versions.find((v) => v.version === 1);
      if (v1 && comparePositions(state.earliest, v1.limits.window.to) <= 0) {
        await this.#checkBaseline(state, v1, readings.filter(final));
      }
    }
    const chart = spcChart({
      readings,
      versions: state.versions,
      rules: config.rules,
      subgroupSize: config.subgroupSize,
    });
    const positions = new Map(chart.firstPass.map((r) => [r.key, positionOf(r)]));
    const derived = derivedSignals(chart.episodes, positions, progress);
    await this.#writeSignals(state, derived, cause ?? 'reading');
    // The chart as derived now serves reads (#200 review M5), tagged by a revision that rises
    // with every derivation, write and acknowledgement.
    state.view = { chart, progress };
    state.revision += 1;
    const readingsChanged = state.readingsChanged;
    state.dirty = false;
    state.readingsChanged = false;
    state.earliest = null;
    state.progress = signature;
    this.#derived?.observe((performance.now() - started) / 1_000);
    if (readingsChanged) this.#summarySoon(state);
  }

  /**
   * The `readings` summary of a characteristic for push, read off the derivation's path (it adds
   * nothing the episodes need) and coalesced: one read for any number of derivations meanwhile.
   */
  #summarySoon(state: State): void {
    if (state.summaryDue) return;
    state.summaryDue = true;
    this.#summaries = this.#summaries.then(async () => {
      state.summaryDue = false;
      if (this.#stopping) return;
      try {
        this.#emit({
          type: 'characteristic',
          event: 'readings',
          characteristic: await this.#summary(state.config, this.#db),
        });
      } catch (error) {
        this.#log.error({ err: error }, 'quality: reading a characteristic summary failed');
      }
    });
  }

  /** Limit version 1 (automatic, `system`): created at its baseline's last reading (ADR-0032). */
  async #createFirst(state: State, v1: LimitVersion): Promise<void> {
    const id = state.config.id;
    await this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('quality.characteristic')
        .select('version')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const events = await this.#events(id, trx);
      if (events.length > 0) return;
      await this.#appendEvent(trx, {
        characteristic: id,
        n: 1,
        kind: 'created',
        version: 1,
        plantAt: v1.createdAt,
        position: null,
        limits: storeLimits(v1.limits),
        comment: 'estimated from the baseline',
        actor: SYSTEM_ACTOR,
      });
      await this.#bump(trx, id, row.version, false);
      await Identity.audit(trx, {
        actor: { system: 'quality' },
        authenticated: false,
        action: 'spc.limits-create',
        entityType: LIMIT_AUDIT_ENTITY,
        entityId: `${id}/1`,
        before: { characteristicVersion: row.version },
        after: {
          characteristicVersion: row.version + 1,
          version: 1,
          window: storeLimits(v1.limits).window,
          readings: v1.limits.counts.readings,
          subgroups: v1.limits.counts.subgroups,
        },
        plantAt: new Date(v1.createdAt),
      });
    });
    await this.#reloadVersions(state);
    this.#log.info({ characteristic: id }, 'quality: limit version 1 estimated from the baseline');
    this.#emit({
      type: 'characteristic',
      event: 'limits',
      characteristic: await this.#summary(state.config, this.#db),
    });
  }

  /** A late reading inside version 1's window: a notice, never a new estimate (plan MEDIUM 8). */
  async #checkBaseline(
    state: State,
    v1: VersionRecord,
    finalReadings: readonly Reading[],
  ): Promise<void> {
    const now = firstVersion(finalReadings, state.config);
    if (now !== null && sameLimits(now.limits, v1.limits)) return;
    // The basis of the notice: the re-estimate itself. The same re-estimate (after a restart, or
    // once a quality user resolved the notice) never raises it again (#200 review H1).
    const basis = createHash('sha256')
      .update(now === null ? 'incomplete' : JSON.stringify(storeLimits(now.limits)))
      .digest('hex');
    const detail =
      now === null
        ? 'a reading of the baseline window changed: the baseline is no longer complete'
        : `a late reading changed the baseline window: estimated again it gives X̄ ${String(
            inUnit(now.limits.statistics.mean, state.config.resolution),
          )} and M̄R ${String(
            inUnit(now.limits.statistics.movingRange, state.config.resolution),
          )} (version 1: X̄ ${String(
            inUnit(v1.limits.statistics.mean, state.config.resolution),
          )}, M̄R ${String(inUnit(v1.limits.statistics.movingRange, state.config.resolution))}); version 1 stays until a quality user creates a new version`;
    // Raising a notice is a change a limit write must have seen: the version rises (review M6).
    const updated = await this.#db
      .updateTable('quality.characteristic')
      .set((eb) => ({
        notice_kind: 'baseline-changed',
        notice_at: sql<Date>`clock_timestamp()`,
        notice_detail: detail,
        notice_basis: basis,
        version: eb('version', '+', 1),
        updated_at: sql<Date>`clock_timestamp()`,
      }))
      .where('id', '=', state.config.id)
      .where((eb) => eb.or([eb('notice_basis', 'is', null), eb('notice_basis', '<>', basis)]))
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) return;
    this.#log.warn({ characteristic: state.config.id, detail }, 'quality: baseline changed');
    this.#emit({
      type: 'characteristic',
      event: 'notice',
      characteristic: await this.#summary(state.config, this.#db),
    });
  }

  /** Brings the stored episodes in line with the derived ones, in one transaction. */
  async #writeSignals(
    state: State,
    derived: ReturnType<typeof derivedSignals>,
    cause: WithdrawalCause,
  ): Promise<void> {
    const id = state.config.id;
    // The stored rows as the last write left them: every write to them goes through this
    // module's queue, which drops the copy.
    state.signals ??= await this.#db
      .selectFrom('quality.spc_signal')
      .selectAll()
      .where('characteristic', '=', id)
      .execute();
    const plan = planSignals(derived, state.signals.map(toStored), cause);
    if (
      plan.inserts.length === 0 &&
      plan.updates.length === 0 &&
      plan.withdrawals.length === 0 &&
      plan.deletes.length === 0
    ) {
      return;
    }
    const plantAt = this.#options.clock?.() ?? null;
    const changes: QualityChange[] = [];
    const now = sql<Date>`clock_timestamp()`;
    state.signals = null;
    await this.#db.transaction().execute(async (trx) => {
      if (plan.deletes.length > 0) {
        const removed = await trx
          .deleteFrom('quality.spc_signal')
          .where('id', 'in', [...plan.deletes])
          .returningAll()
          .execute();
        for (const row of removed) {
          changes.push({ type: 'signal', event: 'removed', signal: toSignal(row) });
          this.#log.info(
            { characteristic: id, key: signalKey(toStored(row)) },
            'quality: a provisional signal was re-derived away and removed',
          );
        }
      }
      for (const w of plan.withdrawals) {
        const row = await trx
          .updateTable('quality.spc_signal')
          .set((eb) => ({
            status: 'withdrawn',
            withdrawn_at: now,
            withdrawn_reason: w.reason,
            row_version: eb('row_version', '+', 1),
          }))
          .where('id', '=', w.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        changes.push({ type: 'signal', event: 'withdrawn', signal: toSignal(row) });
      }
      for (const u of plan.updates) {
        const s = u.signal;
        const row = await trx
          .updateTable('quality.spc_signal')
          .set((eb) => ({
            ...extent(s),
            status: u.status,
            ...(u.statusChanged
              ? {
                  row_version: eb('row_version', '+', 1),
                  withdrawn_at: null,
                  withdrawn_reason: null,
                  ...(u.status === 'final' ? { final_at: now } : {}),
                }
              : {}),
          }))
          .where('id', '=', u.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        changes.push({ type: 'signal', event: u.event, signal: toSignal(row) });
      }
      for (let i = 0; i < plan.inserts.length; i += 500) {
        const rows = await trx
          .insertInto('quality.spc_signal')
          .values(
            plan.inserts.slice(i, i + 500).map((s) => ({
              characteristic: id,
              limit_version: s.version,
              chart: s.chart,
              rule: s.rule,
              epoch: s.first.epoch,
              part_id: s.first.partId,
              pass: s.first.pass,
              ...extent(s),
              status: s.final ? ('final' as const) : ('provisional' as const),
              detected_plant_at: plantAt,
              final_at: s.final ? now : null,
            })),
          )
          .returningAll()
          .execute();
        for (const row of rows)
          changes.push({ type: 'signal', event: 'opened', signal: toSignal(row) });
      }
    });
    for (const change of changes) {
      if (change.type === 'signal') this.#signals?.inc({ event: change.event });
      this.#emit(change);
    }
  }

  async #lockCharacteristic(
    trx: Transaction<Database>,
    id: string,
    version: number,
  ): Promise<{ version: number }> {
    const row = await trx
      .selectFrom('quality.characteristic')
      .select('version')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new QualityError('not-found', `no characteristic ${id}`);
    if (row.version !== version) {
      throw new QualityError(
        'conflict',
        `characteristic ${id} changed: version is ${String(row.version)}, not ${String(version)}`,
        PROBLEM_TYPES.limitsStale,
      );
    }
    return row;
  }

  async #bump(
    trx: Transaction<Database>,
    id: string,
    version: number,
    clearNotice: boolean,
  ): Promise<void> {
    await trx
      .updateTable('quality.characteristic')
      .set({
        version: version + 1,
        updated_at: sql<Date>`clock_timestamp()`,
        ...(clearNotice ? { notice_kind: null, notice_at: null, notice_detail: null } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  async #appendEvent(
    trx: Transaction<Database>,
    event: LimitEvent & { readonly characteristic: string },
  ): Promise<void> {
    await trx
      .insertInto('quality.control_limit')
      .values({
        characteristic: event.characteristic,
        n: event.n,
        kind: event.kind,
        version: event.version,
        plant_at: new Date(event.plantAt),
        position_epoch: event.position?.epoch ?? null,
        position_at: event.position === null ? null : new Date(event.position.at),
        position_seq: event.position?.seq ?? null,
        limits: event.limits === null ? null : JSON.stringify(event.limits),
        comment: event.comment,
        actor: event.actor,
      })
      .execute();
  }

  async #events(id: string, db: Kysely<Database> | Transaction<Database>): Promise<LimitEvent[]> {
    const rows = await db
      .selectFrom('quality.control_limit')
      .selectAll()
      .where('characteristic', '=', id)
      .orderBy('n')
      .execute();
    return rows.map(toEvent);
  }

  async #versions(id: string, db: Kysely<Database>): Promise<VersionRecord[]> {
    return versionsOf(await this.#events(id, db));
  }

  async #reloadVersions(state: State): Promise<void> {
    state.versions = await this.#versions(state.config.id, this.#db);
    state.dirty = true;
  }

  async #measurementRows(
    id: string,
    db: Kysely<Database>,
  ): Promise<Selectable<MeasurementTable>[]> {
    return db
      .selectFrom('quality.measurement')
      .selectAll()
      .where('characteristic', '=', id)
      .orderBy('epoch')
      .orderBy('measured_at')
      .orderBy('seq')
      .execute();
  }

  /** The plant clock now; without one, the newest reading's time. */
  #plantNow(state: State): number {
    const clock = this.#options.clock?.();
    if (clock) return clock.getTime();
    let latest = 0;
    for (const r of state.readings.values()) latest = Math.max(latest, r.at);
    return latest;
  }

  async #summary(
    config: CharacteristicConfig,
    db: Kysely<Database>,
  ): Promise<CharacteristicRecord> {
    const [row, versions, counts, progress] = await Promise.all([
      db
        .selectFrom('quality.characteristic')
        .selectAll()
        .where('id', '=', config.id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('quality.control_limit')
        .select((eb) => eb.fn.max<number | null>('version').as('version'))
        .where('characteristic', '=', config.id)
        .where('kind', '=', 'created')
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('quality.spc_signal')
        .select((eb) => [
          eb.fn
            .countAll<string>()
            .filterWhere((w) =>
              w.and([w('closed_epoch', 'is', null), w('status', '<>', 'withdrawn')]),
            )
            .as('open'),
          eb.fn
            .countAll<string>()
            .filterWhere((w) => w.and([w('ack_by', 'is', null), w('status', '<>', 'withdrawn')]))
            .as('unacknowledged'),
        ])
        .where('characteristic', '=', config.id)
        .executeTakeFirstOrThrow(),
      this.#ingest.deviceProgress(config.equipment),
    ]);
    const p = progressOf(progress);
    let final = 0;
    if (p.epoch !== null) {
      const found = await db
        .selectFrom('quality.measurement')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('characteristic', '=', config.id)
        .where('pass', '=', 1)
        .where((eb) =>
          eb.or([
            eb('epoch', '<', p.epoch ?? 0),
            eb.and([eb('epoch', '=', p.epoch ?? 0), eb('seq', '<=', p.settledSeq ?? -1)]),
          ]),
        )
        .executeTakeFirstOrThrow();
      final = Number(found.n);
    }
    return {
      ...config,
      version: row.version,
      currentLimits: versions.version,
      baseline: { needed: config.subgroupSize * config.baselineSubgroups, final },
      notice:
        row.notice_kind === null || row.notice_at === null || row.notice_detail === null
          ? null
          : { kind: row.notice_kind, at: row.notice_at, detail: row.notice_detail },
      signals: { open: Number(counts.open), unacknowledged: Number(counts.unacknowledged) },
    };
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #emit(change: QualityChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error({ err: error }, 'quality listener failed');
      }
    }
  }
}

const progressOf = (progress: DeviceProgress | undefined): Progress => ({
  epoch: progress?.epoch ?? null,
  settledSeq: progress?.settledSeq ?? null,
  settledTime: progress?.settledTime ?? null,
});

const positionOf = (r: Position): Position => ({ epoch: r.epoch, at: r.at, seq: r.seq });

/**
 * Where a limit version starts or ends when written at plant time `at` (#200 review M3): after
 * every reading received so far, `(newest epoch, at, last seq + 1)`, so a reading already received
 * at exactly `at` keeps the version it was judged by, and every later one takes the change.
 */
function boundary(device: DeviceProgress, at: number, fallbackEpoch: number): Position {
  return { epoch: device.epoch ?? fallbackEpoch, at, seq: (device.lastSeq ?? 0) + 1 };
}

function toReading(row: Selectable<MeasurementTable>): Reading {
  return {
    key: readingKey(row.epoch, row.part_id, row.pass),
    epoch: row.epoch,
    at: row.measured_at.getTime(),
    seq: row.seq,
    pass: row.pass,
    value: row.steps,
  };
}

function toMeasurement(
  row: Selectable<MeasurementTable>,
  final: (p: Position) => boolean,
): MeasurementRecord {
  return {
    epoch: row.epoch,
    partId: row.part_id,
    pass: row.pass,
    at: row.measured_at,
    seq: row.seq,
    value: row.value,
    steps: row.steps,
    upperLimit: row.upper_limit,
    result: row.result,
    final: final({ epoch: row.epoch, at: row.measured_at.getTime(), seq: row.seq }),
  };
}

function toEvent(row: Selectable<ControlLimitTable>): LimitEvent {
  return {
    n: row.n,
    kind: row.kind,
    version: row.version,
    plantAt: row.plant_at.getTime(),
    position:
      row.position_epoch === null || row.position_at === null || row.position_seq === null
        ? null
        : { epoch: row.position_epoch, at: row.position_at.getTime(), seq: row.position_seq },
    limits: row.limits,
    comment: row.comment,
    actor: row.actor,
  };
}

function withCapability(version: VersionRecord, config: CharacteristicConfig): LimitRecord {
  // The specification limit in steps: exact when it is a whole number of steps, as the leak
  // test's 3.2 Pa/min is 3,200 steps of 0.001.
  const usl = stepsOf(config.upperSpec, config.resolution);
  return {
    ...version,
    capability: capability(version.limits, { num: BigInt(usl), den: 1n }),
  };
}

/** The extent columns of a derived episode. */
function extent(s: ReturnType<typeof derivedSignals>[number]) {
  return {
    first_at: new Date(s.first.at),
    first_seq: s.first.seq,
    last_epoch: s.last.epoch,
    last_part_id: s.last.partId,
    last_pass: s.last.pass,
    last_at: new Date(s.last.at),
    last_seq: s.last.seq,
    points: s.points,
    closed_epoch: s.closedBy?.epoch ?? null,
    closed_part_id: s.closedBy?.partId ?? null,
    closed_pass: s.closedBy?.pass ?? null,
    closed_at: s.closedBy === null ? null : new Date(s.closedBy.at),
    closed_seq: s.closedBy?.seq ?? null,
    baseline: s.baseline,
    extent_final: s.extentFinal,
  };
}

const ref = (epoch: number, partId: number, pass: number, at: Date, seq: number): PointRef => ({
  epoch,
  partId,
  pass,
  at: at.getTime(),
  seq,
});

function closedRef(row: Selectable<SpcSignalTable>): PointRef | null {
  return row.closed_epoch === null ||
    row.closed_part_id === null ||
    row.closed_pass === null ||
    row.closed_at === null ||
    row.closed_seq === null
    ? null
    : ref(row.closed_epoch, row.closed_part_id, row.closed_pass, row.closed_at, row.closed_seq);
}

function toStored(row: Selectable<SpcSignalTable>): StoredSignal {
  return {
    id: row.id,
    version: row.limit_version,
    chart: row.chart,
    rule: row.rule,
    first: ref(row.epoch, row.part_id, row.pass, row.first_at, row.first_seq),
    last: ref(row.last_epoch, row.last_part_id, row.last_pass, row.last_at, row.last_seq),
    points: row.points,
    closedBy: closedRef(row),
    baseline: row.baseline,
    extentFinal: row.extent_final,
    status: row.status,
    acknowledged: row.ack_by !== null,
  };
}

function toSignal(row: Selectable<SpcSignalTable>): SignalRecord {
  const stored = toStored(row);
  return {
    id: row.id,
    characteristic: row.characteristic,
    version: row.limit_version,
    chart: row.chart,
    rule: row.rule,
    first: stored.first,
    last: stored.last,
    points: row.points,
    closedBy: stored.closedBy,
    baseline: row.baseline,
    extentFinal: row.extent_final,
    status: row.status,
    detectedAt: row.detected_at,
    detectedPlantAt: row.detected_plant_at,
    finalAt: row.final_at,
    withdrawnAt: row.withdrawn_at,
    withdrawnReason: row.withdrawn_reason,
    acknowledged:
      row.ack_by === null || row.ack_at === null
        ? null
        : {
            by: row.ack_by,
            at: row.ack_at,
            plantAt: row.ack_plant_at,
            comment: row.ack_comment ?? '',
          },
    rowVersion: row.row_version,
  };
}
