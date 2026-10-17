/**
 * The traceability and SPC ground truth (#208, Phase 8 plan "Ground truth for traceability and
 * SPC", ADR-0033): `trace.json` (`sim-trace/1`) beside each golden `summary.json`, and `trace` in
 * the live `GET /ground-truth`. Everything is derived from plant events as the MES derives it from
 * device facts, with the MES's definitions: lots and operators per cycle from `trace-core`'s
 * `attachConsumption` (as `ConsumptionTracker`, its one-event form), cartons and the trace tree from
 * `buildTrace`, SPC from `spc-core`, and the configuration from `packing.yaml` and `quality.yaml`.
 *
 * - A unit is a part (`partId`); its order is its CNC's latest `started` job when its blank was
 *   taken (orders mode), none in schedule mode. Passes count as execution counts them: a leak-test
 *   `rework` opens pass 2 at OP30 and OP40.
 * - A record's `seq` is the machine's device sequence: its state, cycle, alarm and job facts
 *   numbered from 1, as the machine servers number them. It orders a machine's facts at one plant
 *   time; the document leaves it out (a transport detail), and positions keep their time.
 * - A reading is the leak test's value in whole steps of its `resolution`.
 * - **Counterfactual readings** (exit criterion 3): for each reading the steps the same draw gives
 *   without an injected drift. The tester adds a drift's whole steps to the rounded reading
 *   (ADR-0033), so the counterfactual is the logged steps minus the steps of every drift whose
 *   `leak-drift` `applied` line comes before the reading's line and whose `ended` line (if any)
 *   doesn't, in log order: exact, in integer steps. A reading outside every drift is its own.
 * - The headless run has no device epoch: units and readings carry epoch 0 internally, and the
 *   document names units by `partId` only, so it compares with any run's epoch.
 */
import { createHash } from 'node:crypto';
import { formatFraction, type Fraction } from '@shopfloor/oee-core';
import { driftSteps, type PlantConfig } from '@shopfloor/plant-config';
import {
  CHARTS,
  comparePositions,
  spcChart,
  type ChartLimits,
  type ChartName,
  type Episode,
  type LimitVersion,
  type Point,
  type Position,
  type Reading,
  type RuleSet,
  type SpcChart,
} from '@shopfloor/spc-core';
import {
  ConsumptionTracker,
  buildTrace,
  readingKey,
  type Carton,
  type OrderPacking,
  type Trace,
  type TraceConfig,
  type TraceRecord,
  type TraceUnit,
  type UnitInput,
  type UnitKey,
} from '@shopfloor/trace-core';
import type { SimTime } from '@shopfloor/sim-core';
import type { PlantEvent } from '../plant/line.ts';
import type { OrdersSummary } from './order-truth.ts';
import { isoTime, stableStringify } from './serialize.ts';

export const TRACE_SCHEMA = 'sim-trace/1';

/** The epoch of every unit of a headless or live run's trace (one run, one epoch). */
const EPOCH = 0;

/** The facts that take a device sequence number on their machine (the machine servers' facts). */
const DEVICE_FACTS: ReadonlySet<string> = new Set(['state', 'cycle-complete', 'alarm', 'job']);

/**
 * The counterfactual window (Phase 8 plan, review round 2 HIGH A): the first-pass readings before
 * a drift's start and after it. 40 and 20; under the plan's fallback, 20 and 20.
 */
export interface DriftWindow {
  readonly before: number;
  readonly after: number;
}

export const DEFAULT_DRIFT_WINDOW: DriftWindow = { before: 40, after: 20 };

/** The first-pass readings after a drift's start within which its first episode must open. */
export const DETECTION_READINGS = 20;

/** The trace configuration from `packing.yaml` and `quality.yaml`: the leak test's characteristic. */
export function traceConfigOf(config: PlantConfig): TraceConfig {
  const operation = config.process.leakTest.operation;
  const characteristic = config.quality.characteristics.find((c) => c.operation === operation);
  if (!characteristic) {
    throw new RangeError(`quality.yaml has no characteristic of the leak test (${operation})`);
  }
  return {
    packOperation: config.packing.operation,
    capacity: { ...config.packing.capacity },
    spc: {
      characteristic: characteristic.id,
      operation: characteristic.operation,
      subgroupSize: characteristic.subgroupSize,
      baselineSubgroups: characteristic.baselineSubgroups,
      rules: characteristic.rules as RuleSet,
    },
  };
}

/**
 * `traceConfigSha256`: the SHA-256 of the trace configuration the truth was derived with (what of
 * `packing.yaml` and `quality.yaml` it reads), so a later addition to `quality.yaml` that shapes no
 * chart (hold reasons, #201) leaves every `trace.json` as it is.
 */
export const traceConfigHash = (config: TraceConfig): string =>
  createHash('sha256').update(stableStringify(config)).digest('hex');

interface UnitState {
  readonly partId: number;
  serial: string;
  product: string;
  readonly orderId: string | null;
  readonly records: TraceRecord[];
  reworks: number;
}

/** A drift injection as its `leak-drift` lines show it. */
export interface DriftLines {
  readonly injection: number;
  readonly machine: string;
  readonly shift: number;
  readonly steps: number;
  readonly appliedAt: SimTime;
  readonly endedAt: SimTime | null;
  readonly endedBy: 'until' | 'calibration' | null;
  /** Readings (every pass) logged before its `applied` line. */
  readonly readingsBefore: number;
}

/** The trace of a run and what the counterfactual needs. */
export interface TraceResult {
  readonly config: TraceConfig;
  readonly trace: Trace;
  /** Counterfactual steps per reading key; equal to the logged steps outside every drift. */
  readonly counterfactual: ReadonlyMap<string, number>;
  /** Every reading's key in log order. */
  readonly logOrder: readonly string[];
  readonly drifts: readonly DriftLines[];
}

/** The fold over plant events that the trace is built from; one per run. */
export class TraceTruth {
  readonly #config: TraceConfig;
  readonly #resolution: number;
  readonly #operation: ReadonlyMap<string, string>;
  readonly #firstOperation: string;
  readonly #reworkOperations: ReadonlySet<string>;
  readonly #tracker = new ConsumptionTracker();
  readonly #sequence = new Map<string, number>();
  readonly #units = new Map<number, UnitState>();
  /** The order a CNC works on: its latest `started` job. */
  readonly #current = new Map<string, string>();
  /** Steps of the drifts active now, per machine. */
  readonly #active = new Map<string, number>();
  readonly #drifts = new Map<number, DriftLines>();
  readonly #counterfactual = new Map<string, number>();
  readonly #logOrder: string[] = [];

  constructor(config: PlantConfig) {
    this.#config = traceConfigOf(config);
    this.#resolution = config.process.leakTest.resolution;
    this.#operation = new Map(
      config.plant.areas.flatMap((a) =>
        a.workCenters.flatMap((w) => w.equipment.map((e) => [e.id, e.operation] as const)),
      ),
    );
    this.#firstOperation = config.products.operations[0] ?? 'OP10';
    this.#reworkOperations = new Set([
      config.process.leakTest.reworkOperation,
      config.process.leakTest.operation,
    ]);
  }

  get config(): TraceConfig {
    return this.#config;
  }

  record(event: PlantEvent): void {
    let seq = 0;
    if (DEVICE_FACTS.has(event.type) && 'machineId' in event) {
      seq = (this.#sequence.get(event.machineId) ?? 0) + 1;
      this.#sequence.set(event.machineId, seq);
    }
    const attachment = this.#tracker.record(event);
    switch (event.type) {
      case 'job':
        if (event.transition === 'started') this.#current.set(event.machineId, event.orderId);
        return;
      case 'material-consumed':
        this.#unit(event.machineId, event.partId, '');
        return;
      case 'leak-drift':
        this.#onDrift(event);
        return;
      case 'cycle-complete':
        break;
      case 'state':
      case 'alarm':
      case 'shift':
      case 'operator':
      case 'repair-start':
      case 'repair-end':
      case 'program-loaded':
      case 'injection-held':
      case 'injection-applied':
        return;
    }
    const unit = this.#unit(event.machineId, event.partId, event.product);
    const operation = this.#operation.get(event.machineId);
    if (operation === undefined) {
      throw new RangeError(`cycle on unknown machine ${event.machineId}`);
    }
    if (event.serial !== '') unit.serial = event.serial;
    const pass = this.#reworkOperations.has(operation) ? unit.reworks + 1 : 1;
    let reading: number | null = null;
    if (event.measurement !== undefined && operation === this.#config.spc.operation) {
      reading = Math.round(event.measurement.value / this.#resolution);
      const key = readingKey({ epoch: EPOCH, partId: unit.partId }, pass);
      this.#counterfactual.set(key, reading - (this.#active.get(event.machineId) ?? 0));
      this.#logOrder.push(key);
    }
    unit.records.push({
      operation,
      pass,
      machine: event.machineId,
      at: event.at,
      seq,
      result: event.result,
      reason: event.reason ?? null,
      lots: attachment?.lots ?? [],
      operator: attachment?.operator ?? null,
      reading,
    });
    if (event.result === 'rework') unit.reworks++;
  }

  #unit(machineId: string, partId: number, product: string): UnitState {
    let unit = this.#units.get(partId);
    if (!unit) {
      const first = this.#operation.get(machineId) === this.#firstOperation;
      unit = {
        partId,
        serial: '',
        product,
        orderId: first ? (this.#current.get(machineId) ?? null) : null,
        records: [],
        reworks: 0,
      };
      this.#units.set(partId, unit);
    }
    if (product !== '') unit.product = product;
    return unit;
  }

  #onDrift(event: Extract<PlantEvent, { type: 'leak-drift' }>): void {
    const steps = driftSteps(event.shift, this.#resolution);
    if (steps === undefined) {
      throw new RangeError(`drift ${String(event.injection)}: shift ${String(event.shift)}`);
    }
    const active = this.#active.get(event.machineId) ?? 0;
    if (event.transition === 'applied') {
      this.#active.set(event.machineId, active + steps);
      this.#drifts.set(event.injection, {
        injection: event.injection,
        machine: event.machineId,
        shift: event.shift,
        steps,
        appliedAt: event.at,
        endedAt: null,
        endedBy: null,
        readingsBefore: this.#logOrder.length,
      });
      return;
    }
    const drift = this.#drifts.get(event.injection);
    if (!drift) {
      throw new RangeError(`drift ${String(event.injection)} ended before it was applied`);
    }
    this.#active.set(event.machineId, active - steps);
    this.#drifts.set(event.injection, {
      ...drift,
      endedAt: event.at,
      endedBy: event.endedBy ?? null,
    });
  }

  /** The trace now, with the orders' packing state from the order truth (none in schedule mode). */
  build(orders: OrdersSummary): TraceResult {
    const units: UnitInput[] = [...this.#units.values()]
      .filter((unit) => unit.records.length > 0)
      .map((unit) => ({
        epoch: EPOCH,
        partId: unit.partId,
        serial: unit.serial,
        product: unit.product,
        orderId: unit.orderId,
        records: [...unit.records],
      }));
    const packing: OrderPacking[] = Object.entries(orders.orders).map(([orderId, order]) => ({
      orderId,
      product: order.product,
      completedAt: order.completedAt === null ? null : Date.parse(order.completedAt),
    }));
    return {
      config: this.#config,
      trace: buildTrace({ config: this.#config, units, orders: packing }),
      counterfactual: new Map(this.#counterfactual),
      logOrder: [...this.#logOrder],
      drifts: [...this.#drifts.values()],
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The drift analysis: the first episode after a drift's start and the counterfactual window.

export interface DriftAnalysis {
  readonly drift: DriftLines;
  /** First-pass readings (chart order) before the drift's start, in the whole run. */
  readonly startIndex: number;
  /** The first first-pass reading logged after the `applied` line; `null` if none yet. */
  readonly start: Reading | null;
  /** The first episode opening at or after the start that is not a baseline episode. */
  readonly firstEpisode: Episode | null;
  /** First-pass readings from the start to the episode's triggering reading, both included. */
  readonly latency: number | null;
  readonly window: {
    readonly before: number;
    readonly after: number;
    /** The window's readings (chart order) with their counterfactual steps. */
    readonly readings: readonly { readonly reading: Reading; readonly counterfactual: number }[];
  };
  /** The counterfactual chart (same limits, baseline judged retroactively). */
  readonly counterfactualChart: SpcChart;
  /** Counterfactual points inside the window on which an enabled rule fires, every chart. */
  readonly counterfactualSignals: readonly Point[];
  /** Counterfactual episodes opening inside the window. */
  readonly counterfactualEpisodes: readonly Episode[];
}

/** The analysis of each drift of the run, in injection order. */
export function analyseDrifts(
  result: TraceResult,
  window: DriftWindow = DEFAULT_DRIFT_WINDOW,
): DriftAnalysis[] {
  const { spc } = result.trace;
  const firstPass = spc.chart.firstPass;
  const logIndex = new Map(result.logOrder.map((key, i) => [key, i]));
  const counterfactualOf = (r: Reading): number => result.counterfactual.get(r.key) ?? r.value;
  const counterfactualChart = spcChart({
    readings: spc.readings.map((r) => ({ ...r, value: counterfactualOf(r) })),
    versions: spc.limits,
    rules: result.config.spc.rules,
    subgroupSize: result.config.spc.subgroupSize,
  });
  return [...result.drifts]
    .sort((a, b) => a.injection - b.injection)
    .map((drift) => {
      const found = firstPass.findIndex((r) => (logIndex.get(r.key) ?? -1) >= drift.readingsBefore);
      const startIndex = found < 0 ? firstPass.length : found;
      const start = firstPass[startIndex] ?? null;
      const from = Math.max(0, startIndex - window.before);
      const inWindow = firstPass.slice(from, startIndex + window.after);
      const first = inWindow[0];
      const last = inWindow.at(-1);
      const inside = (p: Position): boolean =>
        first !== undefined &&
        last !== undefined &&
        comparePositions(p, first) >= 0 &&
        comparePositions(p, last) <= 0;
      const firstEpisode =
        start === null
          ? null
          : (spc.chart.episodes.find(
              (e) => !e.baseline && comparePositions(e.position, start) >= 0,
            ) ?? null);
      const triggering =
        firstEpisode === null ? -1 : firstPass.findIndex((r) => r.key === firstEpisode.key);
      return {
        drift,
        startIndex,
        start,
        firstEpisode,
        latency: triggering < 0 ? null : triggering - startIndex + 1,
        window: {
          before: startIndex - from,
          after: Math.min(window.after, firstPass.length - startIndex),
          readings: inWindow.map((reading) => ({
            reading,
            counterfactual: counterfactualOf(reading),
          })),
        },
        counterfactualChart,
        counterfactualSignals: CHARTS.flatMap((chart) =>
          counterfactualChart.points[chart].filter((p) => p.rules.length > 0 && inside(p.position)),
        ),
        counterfactualEpisodes: counterfactualChart.episodes.filter((e) => inside(e.position)),
      };
    });
}

// ---------------------------------------------------------------------------------------------
// The document.

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const fractionText = (f: Fraction): string => formatFraction(f);

/** A reading key `{epoch}/{partId}/{pass}` as the document names it: part and pass. */
function keyParts(key: string): { partId: number; pass: number } {
  const [, partId, pass] = key.split('/').map(Number);
  if (partId === undefined || pass === undefined) throw new RangeError(`reading key ${key}`);
  return { partId, pass };
}

/** A record as the document (and `unitsTraceSha256`) has it. */
export interface TraceRecordJson {
  readonly operation: string;
  readonly pass: number;
  readonly machine: string;
  readonly at: string;
  readonly result: TraceRecord['result'];
  readonly reason: string | null;
  readonly lots: readonly { readonly material: string; readonly lot: string }[];
  readonly operator: string | null;
  readonly reading: number | null;
}

export interface TraceUnitJson {
  readonly partId: number;
  readonly serial: string;
  readonly product: string;
  readonly orderId: string | null;
  readonly status: TraceUnit['status'];
  readonly carton: string | null;
  readonly records: readonly TraceRecordJson[];
}

/** Every unit by part id, its records by completion time: the list `unitsTraceSha256` hashes. */
export const traceUnits = (trace: Trace): TraceUnitJson[] =>
  trace.units.map((unit) => ({
    partId: unit.partId,
    serial: unit.serial,
    product: unit.product,
    orderId: unit.orderId,
    status: unit.status,
    carton: unit.carton,
    records: unit.records.map((r) => ({
      operation: r.operation,
      pass: r.pass,
      machine: r.machine,
      at: isoTime(r.at),
      result: r.result,
      reason: r.reason,
      lots: r.lots.map((l) => ({ material: l.material, lot: l.lot })),
      operator: r.operator,
      reading: r.reading,
    })),
  }));

export const unitsTraceHash = (units: readonly TraceUnitJson[]): string =>
  sha256(stableStringify(units));

const partIds = (units: readonly UnitKey[]): number[] => units.map((u) => u.partId);

const cartonJson = (carton: Carton) => ({
  id: carton.id,
  orderId: carton.orderId,
  product: carton.product,
  capacity: carton.capacity,
  status: carton.status,
  closedAt: carton.closedAt === null ? null : isoTime(carton.closedAt),
  members: {
    count: carton.members.length,
    sha256: sha256(stableStringify(partIds(carton.members))),
  },
});

const positionJson = (p: Position) => ({ at: isoTime(p.at) });

const limitsJson = (limits: ChartLimits) => ({
  subgroupSize: limits.subgroupSize,
  window: {
    from: positionJson(limits.window.from),
    to: positionJson(limits.window.to),
  },
  counts: { ...limits.counts },
  statistics: {
    mean: fractionText(limits.statistics.mean),
    movingRange: fractionText(limits.statistics.movingRange),
    grandMean: fractionText(limits.statistics.grandMean),
    range: fractionText(limits.statistics.range),
  },
  charts: Object.fromEntries(
    CHARTS.map((chart) => [
      chart,
      {
        lower: fractionText(limits.charts[chart].lower),
        centre: fractionText(limits.charts[chart].centre),
        upper: fractionText(limits.charts[chart].upper),
      },
    ]),
  ),
});

const versionJson = (v: LimitVersion) => ({
  version: v.version,
  createdAt: isoTime(v.createdAt),
  from: v.from === null ? null : positionJson(v.from),
  until: v.until === null ? null : positionJson(v.until),
  endedAt: v.endedAt === null ? null : isoTime(v.endedAt),
  limits: limitsJson(v.limits),
});

/** A chart point as `points.{chart}.sha256` hashes it. */
const pointJson = (p: Point) => ({
  ...keyParts(p.key),
  at: isoTime(p.position.at),
  segment: p.segment,
  value: fractionText(p.value),
  version: p.version,
  baseline: p.baseline,
  rules: [...p.rules],
});

export const chartPoints = (chart: SpcChart, name: ChartName) => chart.points[name].map(pointJson);

const episodeJson = (e: Episode) => ({
  chart: e.chart,
  rule: e.rule,
  version: e.version,
  ...keyParts(e.key),
  at: isoTime(e.position.at),
  last: keyParts(e.lastKey),
  points: e.points,
  closedBy: e.closedBy === null ? null : keyParts(e.closedBy),
  baseline: e.baseline,
});

const readingJson = (r: Reading) => ({ ...keyParts(r.key), at: isoTime(r.at), value: r.value });

function driftJson(analysis: DriftAnalysis) {
  const { drift } = analysis;
  return {
    injection: drift.injection,
    machine: drift.machine,
    shift: drift.shift,
    steps: drift.steps,
    appliedAt: isoTime(drift.appliedAt),
    endedAt: drift.endedAt === null ? null : isoTime(drift.endedAt),
    endedBy: drift.endedBy,
    start:
      analysis.start === null
        ? null
        : { ...readingJson(analysis.start), firstPassBefore: analysis.startIndex },
    firstEpisode:
      analysis.firstEpisode === null
        ? null
        : { ...episodeJson(analysis.firstEpisode), latency: analysis.latency },
    window: {
      before: analysis.window.before,
      after: analysis.window.after,
      readings: analysis.window.readings.map(({ reading, counterfactual }) => ({
        ...readingJson(reading),
        counterfactual,
        drifted: counterfactual !== reading.value,
      })),
    },
    counterfactual: {
      signals: analysis.counterfactualSignals.map((p) => ({ chart: p.chart, ...pointJson(p) })),
      episodes: analysis.counterfactualEpisodes.map(episodeJson),
      clean: analysis.counterfactualSignals.length === 0,
    },
  };
}

/** The trace section: `trace.json` without its schema and run header, and the live `trace`. */
export function traceSection(result: TraceResult, window: DriftWindow = DEFAULT_DRIFT_WINDOW) {
  const { trace } = result;
  const units = traceUnits(trace);
  const chart = trace.spc.chart;
  return {
    traceConfigSha256: traceConfigHash(result.config),
    config: result.config,
    units: { count: units.length, unitsTraceSha256: unitsTraceHash(units) },
    orders: trace.orders.map((o) => ({
      orderId: o.orderId,
      product: o.product,
      completedAt: o.completedAt === null ? null : isoTime(o.completedAt),
    })),
    lots: trace.lots.map((lot) => ({
      lot: lot.lot,
      material: lot.material,
      consumed: lot.consumed,
      units: partIds(lot.units),
      orders: [...lot.orders],
      cartons: [...lot.cartons],
    })),
    cartons: trace.cartons.map(cartonJson),
    spc: {
      characteristic: trace.spc.characteristic,
      readings: { firstPass: chart.firstPass.length, retests: chart.retests.length },
      limits: trace.spc.limits.map(versionJson),
      points: Object.fromEntries(
        CHARTS.map((name) => {
          const points = chartPoints(chart, name);
          return [name, { count: points.length, sha256: sha256(stableStringify(points)) }];
        }),
      ),
      subgroups: { complete: chart.points.Xbar.length, pending: chart.pending.length },
      episodes: chart.episodes.map(episodeJson),
    },
    drifts: analyseDrifts(result, window).map(driftJson),
  };
}

export type TraceSection = ReturnType<typeof traceSection>;
