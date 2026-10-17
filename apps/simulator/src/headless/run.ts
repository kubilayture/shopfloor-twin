import { createHash } from 'node:crypto';
import {
  checkInjections,
  simulationSections,
  type InjectionSpec,
  type PlantConfig,
} from '@shopfloor/plant-config';
import { RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { ProductionLine, type LineEvent, type ProductionMode } from '../plant/line.ts';
import { RUN_SCHEMA, EVENT_SCHEMA, SUMMARY_SCHEMA, isoTime, stableStringify } from './serialize.ts';
import { InvariantChecker } from './invariants.ts';
import { GroundTruth, type GroundTruthSummary } from './summary.ts';

export interface HeadlessOptions {
  readonly config: PlantConfig;
  readonly seed: number;
  readonly start: SimTime;
  readonly end: SimTime;
  readonly checkInvariants?: boolean;
  /**
   * Failure injections (#140) and leak drifts (#196, `kind: 'leak-drift'`), scheduled after
   * `line.start` (and the dispatches) in list order, sharing one numbering.
   */
  readonly injections?: readonly InjectionSpec[];
  /** `schedule` (default) or `orders` (#172). */
  readonly production?: ProductionMode;
  /**
   * Orders mode (#172, B3): jobs given to the CNCs after `line.start` and before the injections,
   * in list order, at the start time, as a live run's dispatch through `LoadOrder` does.
   */
  readonly dispatches?: readonly DispatchSpec[];
}

/** A scenario dispatch (#172): one `LoadOrder` at the start time, without epoch or expiry. */
export interface DispatchSpec {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: SimTime;
}

/** A dispatch as the run header records it. */
export interface HeaderDispatch {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: string;
}

/**
 * An injection as the run header records it: a failure without `kind` (as before #196, so
 * existing headers are unchanged), or a leak drift with `kind: 'leak-drift'`.
 */
export type HeaderInjection =
  | {
      readonly at: string;
      readonly machine: string;
      readonly code: string;
      readonly repairMs?: number;
    }
  | {
      readonly kind: 'leak-drift';
      readonly at: string;
      readonly until: string;
      readonly machine: string;
      readonly shift: number;
    };

export interface RunHeader {
  readonly schema: string;
  readonly seed: number;
  readonly start: string;
  readonly end: string;
  readonly configSha256: string;
  /** Only when the run has any, so a run without injections keeps its header (#140). */
  readonly injections?: readonly HeaderInjection[];
  /** Only in orders mode (#172), so a schedule-mode run keeps its header and `events.sha256`. */
  readonly production?: 'orders';
  /** Orders mode only (#172): the dispatches, in the order they were applied. */
  readonly dispatches?: readonly HeaderDispatch[];
}

export interface HeadlessResult {
  readonly header: RunHeader;
  readonly analysisConfigSha256: string;
  readonly eventCount: number;
  readonly invariantChecks: number;
  readonly summary: GroundTruthSummary;
}

/**
 * Hashes only the simulation sections (ADR-0021): OEE configuration is loaded beside them but is
 * not a simulation input, so changing it never changes the run header or `events.sha256`.
 */
export const configHash = (config: PlantConfig): string =>
  createHash('sha256')
    .update(stableStringify(simulationSections(config)))
    .digest('hex');

/**
 * Hashes the files that shape the analysis but not the simulation (#140): `oee.yaml`,
 * `reasons.yaml` and `alarms.yaml`. A summary records it as `analysisConfigSha256`, so it says
 * which analysis configuration produced it while `configSha256` and the event log stay the same.
 */
export const analysisConfigHash = (config: PlantConfig): string =>
  createHash('sha256')
    .update(stableStringify({ alarms: config.alarms, oee: config.oee, reasons: config.reasons }))
    .digest('hex');

export function runHeadless(
  {
    config,
    seed,
    start,
    end,
    checkInvariants = false,
    injections = [],
    production = 'schedule',
    dispatches = [],
  }: HeadlessOptions,
  writeLine: (line: string) => void,
): HeadlessResult {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw new RangeError('start and end must be integer milliseconds with end after start');
  }
  const issues = [
    ...checkInjections(config, injections, end),
    ...injections.flatMap((injection, index) =>
      injection.at >= end || injection.at < start
        ? [
            {
              path: `injections[${String(index)}]`,
              message: `${isoTime(injection.at)} is outside the run [start, end)`,
            },
          ]
        : [],
    ),
  ];
  if (production === 'schedule' && dispatches.length > 0) {
    issues.push({ path: 'dispatches', message: 'dispatches need production mode "orders"' });
  }
  if (issues.length > 0) {
    throw new RangeError(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
  const header: RunHeader = {
    schema: RUN_SCHEMA,
    seed,
    start: isoTime(start),
    end: isoTime(end),
    configSha256: configHash(config),
    ...(injections.length === 0
      ? {}
      : {
          injections: injections.map((injection): HeaderInjection =>
            injection.kind === 'leak-drift'
              ? {
                  kind: injection.kind,
                  at: isoTime(injection.at),
                  until: isoTime(injection.until),
                  machine: injection.machine,
                  shift: injection.shift,
                }
              : {
                  at: isoTime(injection.at),
                  machine: injection.machine,
                  code: injection.code,
                  ...(injection.repairMs === undefined ? {} : { repairMs: injection.repairMs }),
                },
          ),
        }),
    ...(production === 'schedule'
      ? {}
      : {
          production,
          dispatches: dispatches.map((dispatch) => ({
            commandId: dispatch.commandId,
            machine: dispatch.machine,
            orderId: dispatch.orderId,
            product: dispatch.product,
            quantity: dispatch.quantity,
            notBefore: isoTime(dispatch.notBefore),
          })),
        }),
  };
  writeLine(stableStringify(header));

  const truth = new GroundTruth(config, start);

  let sequence = 0;
  let checker: InvariantChecker | undefined;
  const line = new ProductionLine({
    config,
    random: new RandomSource(seed),
    startTime: start,
    production,
    onEvent: (event) => {
      truth.record(event);
      checker?.record(event);
      sequence++;
      writeLine(
        stableStringify({ ...event, schema: EVENT_SCHEMA, seq: sequence, at: isoTime(event.at) }),
      );
    },
  });
  if (checkInvariants) {
    checker = new InvariantChecker(line, config, start);
  }
  const simulation = new Simulation<LineEvent>(start);
  line.start(simulation);
  // Dispatches after line.start and before the injections (#172, B3): a live run is attached and
  // idle at the start time when the test dispatches, waits for every acceptance, then injects.
  applyDispatches(line, simulation, dispatches);
  // After line.start and in list order, exactly as the control API schedules them (#140, #196).
  for (const injection of injections) {
    const accepted =
      injection.kind === 'leak-drift'
        ? line.injectLeakDrift(injection, simulation, end)
        : line.injectFailure(injection, simulation);
    if (!accepted.ok) {
      throw new RangeError(`injection at ${isoTime(injection.at)}: ${accepted.reason}`);
    }
  }
  checker?.check(start);
  simulation.runUntil(end - 1, (event, sim) => {
    line.handle(event, sim);
    checker?.check(sim.now);
  });

  const summary = truth.finish(
    end,
    line,
    config.stock.lots.map((lot) => lot.id),
  );
  return {
    header,
    analysisConfigSha256: analysisConfigHash(config),
    eventCount: sequence,
    invariantChecks: checker?.checks ?? 0,
    summary,
  };
}

/** Gives each dispatch to its CNC through `loadOrder`, in order; throws on any refusal. */
export function applyDispatches(
  line: ProductionLine,
  simulation: Simulation<LineEvent>,
  dispatches: readonly DispatchSpec[],
): void {
  dispatches.forEach((dispatch, index) => {
    const result = line.loadOrder(dispatch.machine, dispatch, simulation);
    if (!result.ok) {
      throw new RangeError(
        `dispatches[${String(index)}] (${dispatch.commandId}): ${result.reason}`,
      );
    }
    if (result.duplicate) {
      throw new RangeError(`dispatches[${String(index)}]: ${dispatch.commandId} is listed twice`);
    }
  });
}

export const summaryDocument = (result: HeadlessResult): string =>
  `${stableStringify(
    {
      schema: SUMMARY_SCHEMA,
      run: result.header,
      analysisConfigSha256: result.analysisConfigSha256,
      events: result.eventCount,
      ...result.summary,
    },
    2,
  )}\n`;
