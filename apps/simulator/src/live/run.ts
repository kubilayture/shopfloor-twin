import type { InjectionSpec, PlantConfig } from '@shopfloor/plant-config';
import { RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { isoTime } from '../headless/serialize.ts';
import { applyDispatches, type DispatchSpec } from '../headless/run.ts';
import { GroundTruth, type GroundTruthSummary } from '../headless/summary.ts';
import { TraceTruth, traceSection, type TraceSection } from '../headless/trace-truth.ts';
import {
  ProductionLine,
  type FailureInjection,
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
}

export interface LiveRun {
  readonly line: ProductionLine;
  readonly simulation: Simulation<LineEvent>;
  readonly pacer: LivePacer<LineEvent>;
  readonly processValues: ProcessValues;
  /** The ground truth up to the simulation's current time; read-only, never moves the run. */
  groundTruth(): LiveGroundTruth;
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
  const line = new ProductionLine({
    config: options.config,
    random: new RandomSource(options.seed),
    startTime: options.start,
    production: options.production,
    onEvent: (event) => {
      truth.record(event);
      traceTruth.record(event);
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
  const groundTruth = (): LiveGroundTruth => {
    const now = simulation.now;
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
      trace: traceSection(traceTruth.build(summary.orders)),
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
  };
}
