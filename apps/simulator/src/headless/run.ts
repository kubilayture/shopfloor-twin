import { createHash } from 'node:crypto';
import type { PlantConfig } from '@shopfloor/plant-config';
import { RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { shiftAt } from '../plant/calendar.ts';
import { ProductionLine, type LineEvent } from '../plant/line.ts';
import { RUN_SCHEMA, EVENT_SCHEMA, SUMMARY_SCHEMA, isoTime, stableStringify } from './serialize.ts';
import { GroundTruth, type GroundTruthSummary } from './summary.ts';

export interface HeadlessOptions {
  readonly config: PlantConfig;
  readonly seed: number;
  readonly start: SimTime;
  readonly end: SimTime;
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
  readonly summary: GroundTruthSummary;
}

export const configHash = (config: PlantConfig): string =>
  createHash('sha256').update(stableStringify(config)).digest('hex');

export function runHeadless(
  { config, seed, start, end }: HeadlessOptions,
  writeLine: (line: string) => void,
): HeadlessResult {
  if (!(end > start)) {
    throw new RangeError('end must be after start');
  }
  const header: RunHeader = {
    schema: RUN_SCHEMA,
    seed,
    start: isoTime(start),
    end: isoTime(end),
    configSha256: configHash(config),
  };
  writeLine(stableStringify(header));

  const equipment = config.plant.areas.flatMap((a) => a.workCenters.flatMap((w) => w.equipment));
  const truth = new GroundTruth(
    equipment.map((e) => e.id),
    start,
  );
  const initial = shiftAt(config.shifts, start);
  truth.setInitialShift(initial && `${initial.shiftDate}/${initial.shiftId}`);

  let sequence = 0;
  const line = new ProductionLine({
    config,
    random: new RandomSource(seed),
    startTime: start,
    onEvent: (event) => {
      truth.record(event);
      sequence++;
      writeLine(
        stableStringify({ ...event, schema: EVENT_SCHEMA, seq: sequence, at: isoTime(event.at) }),
      );
    },
  });
  const simulation = new Simulation<LineEvent>(start);
  line.start(simulation);
  simulation.runUntil(end, (event, sim) => {
    line.handle(event, sim);
  });

  const summary = truth.finish(
    end,
    line,
    config.stock.lots.map((lot) => lot.id),
  );
  return { header, eventCount: sequence, summary };
}

export const summaryDocument = (result: HeadlessResult): string =>
  `${stableStringify({ schema: SUMMARY_SCHEMA, run: result.header, events: result.eventCount, ...result.summary }, 2)}\n`;
