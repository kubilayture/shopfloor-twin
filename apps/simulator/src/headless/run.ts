import { createHash } from 'node:crypto';
import {
  checkInjections,
  simulationSections,
  type FailureInjectionSpec,
  type PlantConfig,
} from '@shopfloor/plant-config';
import { RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { ProductionLine, type LineEvent } from '../plant/line.ts';
import { RUN_SCHEMA, EVENT_SCHEMA, SUMMARY_SCHEMA, isoTime, stableStringify } from './serialize.ts';
import { InvariantChecker } from './invariants.ts';
import { GroundTruth, type GroundTruthSummary } from './summary.ts';

export interface HeadlessOptions {
  readonly config: PlantConfig;
  readonly seed: number;
  readonly start: SimTime;
  readonly end: SimTime;
  readonly checkInvariants?: boolean;
  /** Failure injections (#140), scheduled after `line.start` in list order. */
  readonly injections?: readonly FailureInjectionSpec[];
}

/** An injection as the run header records it. */
export interface HeaderInjection {
  readonly at: string;
  readonly machine: string;
  readonly code: string;
  readonly repairMs?: number;
}

export interface RunHeader {
  readonly schema: string;
  readonly seed: number;
  readonly start: string;
  readonly end: string;
  readonly configSha256: string;
  /** Only when the run has any, so a run without injections keeps its header (#140). */
  readonly injections?: readonly HeaderInjection[];
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
  { config, seed, start, end, checkInvariants = false, injections = [] }: HeadlessOptions,
  writeLine: (line: string) => void,
): HeadlessResult {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw new RangeError('start and end must be integer milliseconds with end after start');
  }
  const issues = [
    ...checkInjections(config, injections),
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
          injections: injections.map((injection) => ({
            at: isoTime(injection.at),
            machine: injection.machine,
            code: injection.code,
            ...(injection.repairMs === undefined ? {} : { repairMs: injection.repairMs }),
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
  // After line.start and in list order, exactly as the control API schedules them (#140).
  for (const injection of injections) {
    const accepted = line.injectFailure(injection, simulation);
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
