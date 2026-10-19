import type { InjectionSpec, PlantConfig, Scenario } from '@shopfloor/plant-config';
import { RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { isoTime } from '../headless/serialize.ts';
import {
  analysisConfigHash,
  applyDispatches,
  configHash,
  type DispatchSpec,
} from '../headless/run.ts';
import { LineOeeTruth, type LineOeeSection } from '../headless/line-oee-truth.ts';
import { GroundTruth, type GroundTruthSummary } from '../headless/summary.ts';
import {
  AsOfAfterSimTimeError,
  TraceTruth,
  traceResultAsOf,
  traceSection,
  type TraceSection,
} from '../headless/trace-truth.ts';
import {
  ProductionLine,
  type ActionRequest,
  type ActionResult,
  type ConsoleAction,
  type FailureInjection,
  type LotView,
  type OperatorsView,
  type InjectDriftRequest,
  type InjectDriftResult,
  type InjectFailureRequest,
  type InjectFailureResult,
  type LeakDrift,
  type LineEvent,
  type PlantEvent,
  type ProductionMode,
} from '../plant/line.ts';
import type { MachineState } from '../plant/machine-state.ts';
import { ProcessValues } from '../plant/process-values.ts';
import { LivePacer, type WallClock } from './pacer.ts';
import { recordScenario, type RecordedScenario } from './recording.ts';
import {
  LiveTimeline,
  type InfrastructureHooks,
  type TimelineLoadResult,
  type TimelineView,
} from './timeline.ts';

export interface LiveOptions {
  readonly config: PlantConfig;
  readonly seed: number;
  readonly start: SimTime;
  readonly end?: SimTime;
  readonly speed?: number;
  readonly clock?: WallClock;
  readonly onEvent?: (event: PlantEvent) => void;
  readonly onAdvance?: (simNow: SimTime) => void;
  /** `schedule` (default) or `orders` (#172, `SIM_PRODUCTION`). */
  readonly production?: ProductionMode;
  /**
   * Orders mode (#172, B3): jobs given to the CNCs right after `line.start`, before anything else
   * can schedule an injection, exactly as a headless run applies a scenario's dispatches. A live
   * dispatch through `LoadOrder` while the run is idle at its start time does the same.
   */
  readonly dispatches?: readonly DispatchSpec[];
  /** The infrastructure faults a timeline's `opcua-offline` and `modbus-silent` entries use (#235). */
  readonly infrastructure?: InfrastructureHooks;
}

/**
 * The headless ground truth of a live run so far (#100): the summary `finish` would write if the
 * run ended at `simTime`, plus where the run is. Times are ISO 8601 UTC.
 */
export interface LiveGroundTruth extends GroundTruthSummary {
  /** The run's production mode (#172). */
  readonly productionMode: ProductionMode;
  /** Simulation start. */
  readonly start: string;
  /** How far events have been processed; the summary counts up to here. */
  readonly simTime: string;
  /**
   * The paced simulation clock when this was read (`pacer.simNow()`). While running, `simTime`
   * trails it by up to about 1 s × speed between events; equal while paused or idle.
   */
  readonly pacedTime: string;
  /** The shift bucket the run is in (`2026-10-12/A`, or `no-shift`). */
  readonly currentBucket: string;
  /**
   * Every bucket seen. A bucket is complete when the run is no longer in it: its totals are final.
   * `no-shift` collects every gap between shifts, so it can be entered again later.
   */
  readonly buckets: Record<string, { readonly complete: boolean }>;
  /** Each machine's current state and when it began. */
  readonly current: Record<string, { readonly state: MachineState; readonly since: string }>;
  /**
   * The traceability and SPC truth so far (#208): `trace.json`'s content without its schema and
   * run header, as a headless run ending at `simTime` would write it. Provisional: open cartons,
   * orders not complete yet and episodes still open can change as the run goes on.
   */
  readonly trace: TraceSection;
  /** Present when `trace` was cut at an earlier plant time (`?asOf`, control API 1.6). */
  readonly traceAsOf?: string;
  /**
   * The order and line OEE truth so far (#230, control API 1.8): `line-oee.json`'s content without
   * its schema and run header, as a headless run ending at `simTime` would write it. Buckets and
   * orders reaching past `simTime` are provisional.
   */
  readonly lineOee: LineOeeSection;
  /** Present when `lineOee` was cut at an earlier plant time (`?asOf`, control API 1.8). */
  readonly lineOeeAsOf?: string;
}

export interface LiveRun {
  readonly line: ProductionLine;
  readonly simulation: Simulation<LineEvent>;
  readonly pacer: LivePacer<LineEvent>;
  readonly processValues: ProcessValues;
  /** The ground truth up to the simulation's current time; read-only, never moves the run. */
  /**
   * With `asOf` (#208 review, control API 1.6), `trace` is the trace as it stood at that plant
   * time (`trace-core`'s `traceAsOf`, counterfactual included), which must not be after `simTime`;
   * from 1.8 (#230) `lineOee` is cut there too, as a run that ended at `asOf` gives it. Every other
   * section stays as of `simTime`.
   */
  groundTruth(asOf?: SimTime): LiveGroundTruth;
  /**
   * Schedules a failure injection (#140) at `at`, or at the simulation's current time (the next
   * step) when left out, exactly as a headless run schedules a scenario's injections.
   */
  injectFailure(request: InjectFailureRequest): InjectFailureResult;
  /** Every injection so far, with its outcome. */
  injections(): FailureInjection[];
  /**
   * Schedules a leak-test drift (#196, control API 1.5) from `at` (now when left out) until
   * `until` or the tester's next calibration, exactly as a headless run schedules a scenario's.
   */
  injectLeakDrift(request: InjectDriftRequest): InjectDriftResult;
  /** Every drift injection so far, with its outcome. */
  drifts(): LeakDrift[];
  /** A scenario's injection of either kind (failure or `leak-drift`), as a headless run applies it. */
  inject(spec: InjectionSpec): InjectFailureResult | InjectDriftResult;
  /**
   * A console action (#234, ADR-0037): a lot block or release or a tool breakage at `at` (now when
   * left out), or a forced absence for a later shift, exactly as a headless run's `actions`.
   */
  act(request: ActionRequest): ActionResult;
  /** Every console action so far, with its outcome. */
  actions(): ConsoleAction[];
  /** Every material lot with what is left and whether it is blocked. */
  lots(): LotView[];
  /** The roster, each operator's place in the current shift, and the forced absences. */
  operators(): OperatorsView;
  /**
   * Loads a scenario timeline while the run is idle (#235): every plant entry is accepted at the
   * start time in the headless order, the infrastructure entries become pacer cues.
   */
  loadTimeline(scenario: Scenario, name?: string | null): TimelineLoadResult;
  /** The loaded timeline with each entry's progress, or undefined. */
  timeline(): TimelineView | undefined;
  /**
   * The recording so far (#236, `GET /scenario/recorded`): a `scenario.json` a headless run
   * replays to this run's event log, with every accepted dispatch at its point of the run.
   */
  recorded(where: RecordingPlace): RecordedScenario;
}

/** Where the recorded run's configuration is, as a scenario names it (#236). */
export interface RecordingPlace {
  /** The configuration folder, relative to the repository root. */
  readonly config: string;
  /** The stock file's name, when the run used one (`SIM_STOCK`). */
  readonly stock?: string | undefined;
}

export function createLiveRun(options: LiveOptions): LiveRun {
  const processValues = new ProcessValues(
    options.config.process.processValues,
    options.seed,
    options.start,
  );
  const lotIds = options.config.stock.lots.map((lot) => lot.id);
  const truth = new GroundTruth(options.config, options.start);
  const traceTruth = new TraceTruth(options.config);
  const lineOeeTruth = new LineOeeTruth(
    options.config,
    options.start,
    options.production ?? 'schedule',
    analysisConfigHash(options.config),
    (id) => line.jobNotBefore(id),
  );
  const line = new ProductionLine({
    config: options.config,
    random: new RandomSource(options.seed),
    startTime: options.start,
    production: options.production,
    onEvent: (event) => {
      truth.record(event);
      traceTruth.record(event);
      lineOeeTruth.record(event);
      processValues.record(event);
      options.onEvent?.(event);
    },
  });
  const simulation = new Simulation<LineEvent>(options.start);
  line.start(simulation);
  applyDispatches(line, simulation, options.dispatches ?? []);
  const pacer = new LivePacer<LineEvent>({
    simulation,
    handle: (event, sim) => {
      line.handle(event, sim);
    },
    ...(options.speed === undefined ? {} : { speed: options.speed }),
    ...(options.end === undefined ? {} : { end: options.end }),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.onAdvance ? { onAdvance: options.onAdvance } : {}),
  });
  const timeline = new LiveTimeline({
    config: options.config,
    seed: options.seed,
    start: options.start,
    line,
    simulation,
    pacer,
    infrastructure: options.infrastructure ?? {},
  });
  const groundTruth = (asOf?: SimTime): LiveGroundTruth => {
    const now = simulation.now;
    if (asOf !== undefined && asOf > now) {
      throw new AsOfAfterSimTimeError(asOf, now);
    }
    const summary = truth.snapshot(now, line, lotIds);
    const currentBucket = truth.currentBucket;
    const keys = new Set([
      ...Object.values(summary.machines).flatMap((m) => Object.keys(m.byShift)),
      currentBucket,
    ]);
    return {
      productionMode: line.production,
      start: isoTime(options.start),
      simTime: isoTime(now),
      pacedTime: isoTime(pacer.simNow()),
      currentBucket,
      buckets: Object.fromEntries(
        [...keys].map((key) => [key, { complete: key !== currentBucket }]),
      ),
      current: Object.fromEntries(
        Object.entries(truth.current()).map(([id, c]) => [
          id,
          { state: c.state, since: isoTime(c.since) },
        ]),
      ),
      ...summary,
      trace: traceSection(
        asOf === undefined
          ? traceTruth.build(summary.orders)
          : traceResultAsOf(traceTruth.build(summary.orders), asOf),
      ),
      lineOee: lineOeeTruth.build(now, asOf),
      ...(asOf === undefined ? {} : { traceAsOf: isoTime(asOf), lineOeeAsOf: isoTime(asOf) }),
    };
  };
  return {
    line,
    simulation,
    pacer,
    processValues,
    groundTruth,
    injectFailure: (request) => line.injectFailure(request, simulation),
    injections: () => line.injections(),
    injectLeakDrift: (request) => line.injectLeakDrift(request, simulation, options.end),
    drifts: () => line.drifts(),
    inject: (spec) =>
      spec.kind === 'leak-drift'
        ? line.injectLeakDrift(spec, simulation, options.end)
        : line.injectFailure(spec, simulation),
    act: (request) => line.act(request, simulation),
    actions: () => line.actions(),
    lots: () => line.lots(),
    operators: () => line.operators(),
    loadTimeline: (scenario, name) => timeline.load(scenario, name ?? null),
    timeline: () => timeline.view(),
    recorded: (where) =>
      recordScenario({
        seed: options.seed,
        start: options.start,
        simNow: simulation.now,
        production: line.production,
        configSha256: configHash(options.config),
        processed: simulation.processed,
        inputOrder: line.inputOrder(),
        config: where.config,
        stock: where.stock,
        dispatches: line.recordedDispatches(),
        injections: line.injections(),
        drifts: line.drifts(),
        actions: line.actions(),
      }),
  };
}
