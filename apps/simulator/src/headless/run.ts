import { createHash } from 'node:crypto';
import { simulationSections, type PlantConfig } from '@shopfloor/plant-config';
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
}

export interface RunHeader {
  readonly schema: string;
  readonly seed: number;
  readonly start: string;
  readonly end: string;
  readonly configSha256: string;
}

export interface HeadlessResult {
  readonly header: RunHeader;
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

export function runHeadless(
  { config, seed, start, end, checkInvariants = false }: HeadlessOptions,
  writeLine: (line: string) => void,
): HeadlessResult {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw new RangeError('start and end must be integer milliseconds with end after start');
  }
  const header: RunHeader = {
    schema: RUN_SCHEMA,
    seed,
    start: isoTime(start),
    end: isoTime(end),
    configSha256: configHash(config),
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
  return { header, eventCount: sequence, invariantChecks: checker?.checks ?? 0, summary };
}

export const summaryDocument = (result: HeadlessResult): string =>
  `${stableStringify({ schema: SUMMARY_SCHEMA, run: result.header, events: result.eventCount, ...result.summary }, 2)}\n`;
