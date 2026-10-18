import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { scenarioOptions } from '../headless/golden.ts';
import { runHeadless } from '../headless/run.ts';
import { traceResultAsOf, traceSection } from '../headless/trace-truth.ts';
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
    // Past a time cut (#208 review, `?asOf`): the trace as it stood then is what a run that ended
    // then gives, and the other sections stay as of now.
    const cut = T0 + 20 * HOUR + 12_345;
    const atCut = runHeadless({ config, seed, start: T0, end: cut }, () => undefined);
    const asOf = run.groundTruth(cut);
    expect(asOf.trace).toEqual(traceSection(atCut.trace));
    expect(asOf.trace).toEqual(traceSection(traceResultAsOf(headlessRun.trace, cut)));
    expect(asOf.traceAsOf).toBe(new Date(cut).toISOString());
    expect(asOf.machines).toEqual(live.machines);
    expect(live.traceAsOf).toBeUndefined();
    // The order and line OEE truth (#230, 1.8): now as a headless run ending now writes it, and at
    // the cut as a run that ended then; the hour and shift in progress are provisional.
    expect(live.lineOee).toEqual(headlessRun.lineOee);
    expect(asOf.lineOee).toEqual(atCut.lineOee);
    expect(asOf.lineOeeAsOf).toBe(new Date(cut).toISOString());
    expect(live.lineOeeAsOf).toBeUndefined();
    expect(live.lineOee.line.shifts['2026-10-13/A']?.provisional).toBe(true);
    expect(live.lineOee.line.shifts['2026-10-12/C']?.provisional).toBe(false);
    expect(() => run.groundTruth(until + 1)).toThrow(/must not be after the simulation time/);
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

  it('cuts lineOee at asOf in orders mode as a run that ended then (#230, orders-01)', async () => {
    const options = await scenarioOptions('orders-01');
    const run = createLiveRun({
      config: options.config,
      seed: options.seed,
      start: options.start,
      end: options.end,
      production: 'orders',
      dispatches: options.dispatches ?? [],
      clock: new ManualClock(),
    });
    for (const injection of options.injections ?? []) {
      expect(run.inject(injection).ok).toBe(true);
    }
    run.simulation.runUntil(options.end - 1, (event, sim) => {
      run.line.handle(event, sim);
    });
    // Monday 14:00 Istanbul (the end of shift A) and a moment inside Tuesday's shift A.
    for (const cut of [Date.UTC(2026, 9, 12, 11), Date.UTC(2026, 9, 13, 8, 30, 12, 345)]) {
      const ended = runHeadless(
        {
          ...options,
          end: cut,
          injections: (options.injections ?? []).filter((injection) => injection.at < cut),
        },
        () => undefined,
      );
      const asOf = run.groundTruth(cut);
      expect(asOf.lineOee).toEqual(ended.lineOee);
      expect(asOf.lineOeeAsOf).toBe(new Date(cut).toISOString());
    }
    const shiftA = run.groundTruth(Date.UTC(2026, 9, 12, 11)).lineOee;
    expect(shiftA.line.shifts['2026-10-12/A']?.provisional).toBe(false);
    expect(Object.values(shiftA.orders).filter((o) => o.completedAt !== null)).toHaveLength(5);
    const inside = run.groundTruth(Date.UTC(2026, 9, 13, 8, 30, 12, 345)).lineOee;
    expect(inside.line.hours['2026-10-13T08:00:00.000Z']?.provisional).toBe(true);
    expect(inside.orders['PO-2610-007']?.open).toBe(true);
    expect(inside.orders['PO-2610-007']?.line?.provisional).toBe(true);
  });

  it('reads lineOee without asOf exactly as at simTime: events at simTime belong to the next read (#251 review)', async () => {
    const options = await scenarioOptions('orders-01');
    const run = createLiveRun({
      config: options.config,
      seed: options.seed,
      start: options.start,
      end: options.end,
      production: 'orders',
      dispatches: options.dispatches ?? [],
      clock: new ManualClock(),
    });
    for (const injection of options.injections ?? []) {
      expect(run.inject(injection).ok).toBe(true);
    }
    // PO-2610-001's `completed` fact and its 12th OP10 cycle (04:13:44.974Z), and its last pack
    // (04:32:11.237Z): the live run has processed the events at that instant when it is read.
    for (const at of [
      '2026-10-12T04:13:44.974Z',
      '2026-10-12T04:20:00.000Z',
      '2026-10-12T04:32:11.237Z',
    ]) {
      const now = Date.parse(at);
      run.simulation.runUntil(now, (event, sim) => {
        run.line.handle(event, sim);
      });
      expect(run.simulation.now).toBe(now);
      const ended = runHeadless(
        {
          ...options,
          end: now,
          injections: (options.injections ?? []).filter((injection) => injection.at < now),
        },
        () => undefined,
      );
      const read = run.groundTruth().lineOee;
      expect(read, at).toEqual(run.groundTruth(now).lineOee);
      expect(read, at).toEqual(ended.lineOee);
      const order = read.orders['PO-2610-001'];
      if (at === '2026-10-12T04:13:44.974Z') {
        // Its completion isn't seen yet: the window is open, and every cycle so far is planned.
        expect(order?.jobOee['PO-2610-001~OP10~1']?.window?.open).toBe(true);
        expect(order?.oee.unplanned.produced).toBe(0);
        expect(order?.oee.totals.produced).toBe(11);
      } else if (at === '2026-10-12T04:20:00.000Z') {
        // Every job completed, but units are still on the line: the order is open (ADR-0031
        // completion needs every unit terminal).
        expect(order?.jobOee['PO-2610-001~OP10~1']?.window?.open).toBe(false);
        expect(order?.completedAt).toBeNull();
        expect(read.inProgress.find((r) => r.orderId === 'PO-2610-001')?.open).toBe(true);
      } else {
        // The last pack at the cut-off is the next read's: still open, and every pack counted is
        // in an hour.
        expect(order?.completedAt).toBeNull();
        const inHours = Object.values(read.line.hours).reduce(
          (sum, hour) => sum + Object.values(hour.good).reduce((a, n) => a + n, 0),
          0,
        );
        const inOrders = Object.values(read.orders).reduce(
          (sum, o) => sum + Object.values(o.line?.good ?? {}).reduce((a, n) => a + n, 0),
          0,
        );
        expect(inOrders).toBe(inHours);
      }
    }
    // One step on, the completion and the last pack are seen.
    run.simulation.runUntil(Date.parse('2026-10-12T04:32:11.238Z'), (event, sim) => {
      run.line.handle(event, sim);
    });
    const later = run.groundTruth().lineOee;
    expect(later.orders['PO-2610-001']?.completedAt).toBe('2026-10-12T04:32:11.237Z');
  });
});
