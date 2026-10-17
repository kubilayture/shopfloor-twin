import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../headless/run.ts';
import { traceSection } from '../headless/trace-truth.ts';
import { GroundTruth } from '../headless/summary.ts';
import { ProductionLine, type LineEvent, type PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { createLiveRun } from './run.ts';
import { ManualClock } from './testing.ts';

// Monday 06:00 Istanbul, the start of shift A.
const T0 = Date.UTC(2026, 9, 12, 3);
let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

describe('live ground truth (#100)', () => {
  it('a snapshot equals what finish would return at that time, and changes nothing', () => {
    const lots = config.stock.lots.map((lot) => lot.id);
    const truth = new GroundTruth(config, T0);
    const line = new ProductionLine({
      config,
      random: new RandomSource(7),
      startTime: T0,
      onEvent: (event) => {
        truth.record(event);
      },
    });
    const simulation = new Simulation<LineEvent>(T0);
    line.start(simulation);
    const end = T0 + 30 * HOUR + 12_345;
    const reads: string[] = [];
    simulation.runUntil(end - 1, (event, sim) => {
      line.handle(event, sim);
      // Reading in the middle of the run, OEE included, must not change what is recorded later.
      if (reads.length < 200 && sim.now % 7 === 0) {
        reads.push(JSON.stringify(truth.snapshot(sim.now, line, lots).oee.workCenters));
      }
    });
    expect(reads.length).toBeGreaterThan(10);
    const first = truth.snapshot(end, line, lots);
    expect(truth.snapshot(end, line, lots)).toEqual(first);
    expect(truth.currentBucket).toBe('2026-10-13/A');
    expect(truth.finish(end, line, lots)).toEqual(first);
    const unread = runHeadless({ config, seed: 7, start: T0, end }, () => undefined).summary;
    expect(first).toEqual(unread);
  });

  it('equals the headless ground truth of the same span in every completed bucket', () => {
    const seed = 11;
    const until = T0 + 26 * HOUR + 7 * 60_000;
    const clock = new ManualClock();
    const events: PlantEvent[] = [];
    const run = createLiveRun({
      config,
      seed,
      start: T0,
      speed: 60,
      clock,
      onEvent: (event) => events.push(event),
    });
    run.pacer.start();
    // Reading the ground truth while the run is paced must not change the run: a run that is
    // never read (replayed below) emits the very same events.
    const wall = (until - T0) / 60;
    while (clock.now() + 7_000 < wall) {
      clock.advance(7_000);
      const read = run.groundTruth();
      expect(read.pacedTime).toBe(new Date(T0 + clock.now() * 60).toISOString());
      expect(Date.parse(read.simTime)).toBeLessThanOrEqual(Date.parse(read.pacedTime));
    }
    clock.advance(wall - clock.now());
    run.pacer.pause();
    expect(run.simulation.now).toBe(until);
    const live = run.groundTruth();

    const replay: PlantEvent[] = [];
    const replayRun = createLiveRun({
      config,
      seed,
      start: T0,
      speed: 60,
      clock: new ManualClock(),
      onEvent: (event) => replay.push(event),
    });
    replayRun.simulation.runUntil(until, (event, sim) => {
      replayRun.line.handle(event, sim);
    });
    expect(replay).toEqual(events);

    const headlessRun = runHeadless({ config, seed, start: T0, end: until }, () => undefined);
    const headless = headlessRun.summary;
    // The trace (#208) as a headless run ending now would write it, without schema and header.
    expect(live.trace).toEqual(traceSection(headlessRun.trace));
    expect(live.trace.units.count).toBeGreaterThan(100);
    expect(live.currentBucket).toBe('2026-10-13/A');
    const complete = Object.entries(live.buckets)
      .filter(([, bucket]) => bucket.complete)
      .map(([key]) => key)
      .sort();
    expect(complete).toEqual(['2026-10-12/A', '2026-10-12/B', '2026-10-12/C']);
    for (const [id, machine] of Object.entries(live.machines)) {
      for (const key of complete) {
        expect(machine.byShift[key], `${id} ${key}`).toEqual(headless.machines[id]?.byShift[key]);
        // The OEE inputs and results of a completed bucket are final: the same on both sides (#117).
        expect(live.oee.machines[id]?.shifts[key], `${id} ${key} OEE`).toEqual(
          headless.oee.machines[id]?.shifts[key],
        );
      }
      const total = Object.values(machine.stateMs).reduce((sum, ms) => sum + ms, 0);
      expect(total).toBe(until - T0);
    }
    for (const key of complete) {
      expect(live.oee.workCenters, key).toBeDefined();
      for (const [wc, center] of Object.entries(live.oee.workCenters)) {
        expect(center.shifts[key], `${wc} ${key}`).toEqual(
          headless.oee.workCenters[wc]?.shifts[key],
        );
      }
    }
    expect(live.simTime).toBe(new Date(until).toISOString());
    expect(Object.keys(live.current).sort()).toEqual(Object.keys(live.machines).sort());
  });
});
