import type { PlantConfig } from '@shopfloor/plant-config';
import { RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { ProductionLine, type LineEvent, type PlantEvent } from '../plant/line.ts';
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
}

export interface LiveRun {
  readonly line: ProductionLine;
  readonly simulation: Simulation<LineEvent>;
  readonly pacer: LivePacer<LineEvent>;
}

export function createLiveRun(options: LiveOptions): LiveRun {
  const line = new ProductionLine({
    config: options.config,
    random: new RandomSource(options.seed),
    startTime: options.start,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const simulation = new Simulation<LineEvent>(options.start);
  line.start(simulation);
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
  return { line, simulation, pacer };
}
