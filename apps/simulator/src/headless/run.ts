import { createHash } from 'node:crypto';
import {
  checkActions,
  checkInjections,
  recordedDispatchIssues,
  shiftStart,
  simulationSections,
  type ActionSpec,
  type InjectionSpec,
  type PlantConfig,
} from '@shopfloor/plant-config';
import { RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { ProductionLine, type LineEvent, type ProductionMode } from '../plant/line.ts';
import { RUN_SCHEMA, EVENT_SCHEMA, SUMMARY_SCHEMA, isoTime, stableStringify } from './serialize.ts';
import { InvariantChecker } from './invariants.ts';
import { GroundTruth, type GroundTruthSummary } from './summary.ts';
import { TRACE_SCHEMA, TraceTruth, traceSection, type TraceResult } from './trace-truth.ts';
import { LINE_OEE_SCHEMA, LineOeeTruth, type LineOeeSection } from './line-oee-truth.ts';

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
   * in list order, at the start time, as a live run's dispatch through `LoadOrder` does. A
   * recorded dispatch (#236, with `acceptedAt` and `afterEvents`) is given instead at its point
   * of the run: after exactly `afterEvents` events, with the clock at `acceptedAt`, where the live
   * run accepted it. Recorded dispatches come after every start-time one, in acceptance order.
   */
  readonly dispatches?: readonly DispatchSpec[];
  /**
   * Console actions (#234, ADR-0037): lot blocks and releases, forced absences and tool
   * breakages, given after `line.start`, the dispatches and the injections, in list order, as the
   * control API accepts them. Their own numbering, from 1.
   */
  readonly actions?: readonly ActionSpec[];
}

/**
 * A scenario dispatch (#172): one `LoadOrder` at the start time, without epoch or expiry; or a
 * recorded one (#236): at the point of the run where a live run accepted it.
 */
export interface DispatchSpec {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: SimTime;
  /** Recorded (#236): the simulation time of the acceptance, with `afterEvents`. */
  readonly acceptedAt?: SimTime | undefined;
  /** Recorded (#236): the events processed before the acceptance, with `acceptedAt`. */
  readonly afterEvents?: number | undefined;
}

/** A dispatch as the run header records it; the recorded keys only for a recorded one (#236). */
export interface HeaderDispatch {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: string;
  readonly acceptedAt?: string;
  readonly afterEvents?: number;
}

/** Whether a dispatch was recorded live (#236) rather than given at the start. */
export const isRecorded = (
  dispatch: DispatchSpec,
): dispatch is DispatchSpec & { acceptedAt: SimTime; afterEvents: number } =>
  dispatch.acceptedAt !== undefined && dispatch.afterEvents !== undefined;

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

/** A console action as the run header records it (#234): times ISO 8601 UTC. */
export type HeaderAction =
  | { readonly kind: 'lot-block' | 'lot-release'; readonly at: string; readonly lot: string }
  | { readonly kind: 'tool-breakage'; readonly at: string; readonly machine: string }
  | {
      readonly kind: 'operators-absent';
      readonly shift: string;
      readonly operators: readonly string[];
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
  /** Only when the run has any (#234), so every existing header and `events.sha256` stay. */
  readonly actions?: readonly HeaderAction[];
}

export interface HeadlessResult {
  readonly header: RunHeader;
  readonly analysisConfigSha256: string;
  readonly eventCount: number;
  readonly invariantChecks: number;
  readonly summary: GroundTruthSummary;
  /** The traceability and SPC truth (#208): `trace.json` beside the summary. */
  readonly trace: TraceResult;
  /** The order and line OEE truth (#230): `line-oee.json` beside the summary. */
  readonly lineOee: LineOeeSection;
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
    actions = [],
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
  issues.push(...checkActions(config, actions));
  actions.forEach((action, index) => {
    // An unknown shift is already an issue of `checkActions`.
    const shiftAt =
      action.kind === 'operators-absent' ? shiftStart(config, action.shift) : undefined;
    const inside =
      action.kind === 'operators-absent'
        ? shiftAt === undefined || (shiftAt > start && shiftAt < end)
        : action.at >= start && action.at < end;
    if (!inside) {
      issues.push({
        path: `actions[${String(index)}]`,
        message:
          action.kind === 'operators-absent'
            ? `shift ${action.shift} does not start inside the run (start, end)`
            : `${isoTime(action.at)} is outside the run [start, end)`,
      });
    }
  });
  if (production === 'schedule' && dispatches.length > 0) {
    issues.push({ path: 'dispatches', message: 'dispatches need production mode "orders"' });
  }
  dispatches.forEach((dispatch, index) => {
    if ((dispatch.acceptedAt === undefined) !== (dispatch.afterEvents === undefined)) {
      issues.push({
        path: `dispatches[${String(index)}]`,
        message: 'a recorded dispatch has both acceptedAt and afterEvents, or neither',
      });
    }
  });
  issues.push(...recordedDispatchIssues(dispatches, start, end));
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
            ...(isRecorded(dispatch)
              ? { acceptedAt: isoTime(dispatch.acceptedAt), afterEvents: dispatch.afterEvents }
              : {}),
          })),
        }),
    ...(actions.length === 0 ? {} : { actions: actions.map(headerAction) }),
  };
  writeLine(stableStringify(header));

  const truth = new GroundTruth(config, start);
  const traceTruth = new TraceTruth(config);
  // The dispatch's notBefore of each accepted job, read from the line when its `accepted` event is
  // recorded (the event itself doesn't carry it, so the event log stays as it is).
  const lineOeeTruth = new LineOeeTruth(
    config,
    start,
    production,
    analysisConfigHash(config),
    (id) => line.jobNotBefore(id),
  );

  let sequence = 0;
  let checker: InvariantChecker | undefined;
  const line = new ProductionLine({
    config,
    random: new RandomSource(seed),
    startTime: start,
    production,
    onEvent: (event) => {
      truth.record(event);
      traceTruth.record(event);
      lineOeeTruth.record(event);
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
  applyDispatches(
    line,
    simulation,
    dispatches.filter((dispatch) => !isRecorded(dispatch)),
  );
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
  // Console actions last (#234), in list order, as a live run's control API accepts them.
  applyActions(line, simulation, actions);
  checker?.check(start);
  const handle = (event: LineEvent, sim: Simulation<LineEvent>): void => {
    line.handle(event, sim);
    checker?.check(sim.now);
  };
  // Recorded dispatches (#236) at their points of the run, then the rest of it.
  replayDispatches(line, simulation, dispatches.filter(isRecorded), handle);
  simulation.runUntil(end - 1, handle);

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
    trace: traceTruth.build(summary.orders),
    lineOee: lineOeeTruth.build(end),
  };
}

const headerAction = (action: ActionSpec): HeaderAction => {
  switch (action.kind) {
    case 'lot-block':
    case 'lot-release':
      return { kind: action.kind, at: isoTime(action.at), lot: action.lot };
    case 'tool-breakage':
      return { kind: action.kind, at: isoTime(action.at), machine: action.machine };
    case 'operators-absent':
      return { kind: action.kind, shift: action.shift, operators: [...action.operators] };
  }
};

/** Gives each console action to the line through `act`, in order; throws on any refusal. */
export function applyActions(
  line: ProductionLine,
  simulation: Simulation<LineEvent>,
  actions: readonly ActionSpec[],
): void {
  actions.forEach((action, index) => {
    const result = line.act(action, simulation);
    if (!result.ok) {
      throw new RangeError(`actions[${String(index)}] (${action.kind}): ${result.reason}`);
    }
  });
}

/**
 * Gives each dispatch to its CNC through `loadOrder` now, in order; throws on any refusal. Only
 * dispatches given at the start: a recorded one (#236) goes through `replayDispatches`.
 */
export function applyDispatches(
  line: ProductionLine,
  simulation: Simulation<LineEvent>,
  dispatches: readonly DispatchSpec[],
): void {
  dispatches.forEach((dispatch, index) => {
    if (isRecorded(dispatch)) {
      throw new RangeError(
        `dispatches[${String(index)}] (${dispatch.commandId}): a recorded dispatch is replayed at its point of a headless run, not given at the start`,
      );
    }
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

/**
 * Replays recorded dispatches (#236, probe Q2) at the points a live run accepted them: for each,
 * in acceptance order, the run processes events until exactly `afterEvents` have been processed,
 * moves its clock to `acceptedAt` without processing anything more, and gives the dispatch to the
 * line, just as the live `LoadOrder` call found the run between two events. Throws when the run
 * can't reach that point (the recording is of another configuration, seed or input): an event
 * due after `acceptedAt` before the count is reached, or one due at or before it after.
 */
export function replayDispatches(
  line: ProductionLine,
  simulation: Simulation<LineEvent>,
  dispatches: readonly (DispatchSpec & { acceptedAt: SimTime; afterEvents: number })[],
  handle: (event: LineEvent, simulation: Simulation<LineEvent>) => void,
): void {
  for (const dispatch of dispatches) {
    const label = `recorded dispatch ${dispatch.commandId} (after ${String(dispatch.afterEvents)} events at ${isoTime(dispatch.acceptedAt)})`;
    const misfit = (why: string) =>
      new RangeError(`${label}: ${why}; the recording does not fit this run`);
    while (simulation.processed < dispatch.afterEvents) {
      const next = simulation.nextEventTime;
      if (next === undefined || next > dispatch.acceptedAt) {
        throw misfit(
          `only ${String(simulation.processed)} events are processed by ${isoTime(dispatch.acceptedAt)}`,
        );
      }
      simulation.step(handle);
    }
    if (simulation.processed > dispatch.afterEvents || simulation.now > dispatch.acceptedAt) {
      throw misfit(
        `the run is past that point (${String(simulation.processed)} events at ${isoTime(simulation.now)})`,
      );
    }
    if (simulation.now < dispatch.acceptedAt) {
      const next = simulation.nextEventTime;
      if (next !== undefined && next <= dispatch.acceptedAt) {
        throw misfit(`an event is still due at ${isoTime(next)}`);
      }
      // Nothing is due by then: only the clock moves.
      simulation.runUntil(dispatch.acceptedAt, handle);
    }
    const result = line.loadOrder(dispatch.machine, dispatch, simulation);
    if (!result.ok) {
      throw new RangeError(`${label}: ${result.reason}`);
    }
    if (result.duplicate) {
      throw new RangeError(`${label}: ${dispatch.commandId} is listed twice`);
    }
  }
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

/**
 * `trace.json` (#208, `sim-trace/1`): the run header (as in the summary) and the trace section. A
 * new file beside the summary, which stays as it is.
 */
export const traceDocument = (result: HeadlessResult): string =>
  `${stableStringify({ schema: TRACE_SCHEMA, run: result.header, ...traceSection(result.trace) }, 2)}\n`;

/**
 * `line-oee.json` (#230, `sim-line-oee/1`): the run header (as in the summary) and the order and
 * line OEE section. A new file beside the summary and the trace, which stay as they are.
 */
export const lineOeeDocument = (result: HeadlessResult): string =>
  `${stableStringify({ schema: LINE_OEE_SCHEMA, run: result.header, ...result.lineOee }, 2)}\n`;
