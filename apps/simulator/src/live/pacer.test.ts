import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, SECOND, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductionLine, type LineEvent, type PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { LivePacer, MAX_SPEED, MIN_SPEED, systemClock } from './pacer.ts';
import { createLiveRun } from './run.ts';
import { ManualClock } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

function headlessEvents(end: number, seed = 4): PlantEvent[] {
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(seed),
    startTime: T0,
    onEvent: (e) => events.push(e),
  });
  const simulation = new Simulation<LineEvent>(T0);
  line.start(simulation);
  simulation.runUntil(end - 1, (event, sim) => {
    line.handle(event, sim);
  });
  return events;
}

describe('LivePacer (plan section 4, live mode)', () => {
  it('produces exactly the headless event stream, whatever the pacing, pauses, steps and speed changes', () => {
    const end = T0 + 6 * HOUR;
    const clock = new ManualClock();
    const events: PlantEvent[] = [];
    const { pacer } = createLiveRun({
      config,
      seed: 4,
      start: T0,
      end,
      speed: 60,
      clock,
      onEvent: (e) => events.push(e),
    });
    pacer.start();
    clock.advance(37_000);
    pacer.pause();
    for (let i = 0; i < 25; i++) {
      pacer.step();
    }
    clock.advance(10_000);
    pacer.resume();
    pacer.setSpeed(7.5);
    clock.advance(123_456);
    pacer.setSpeed(60);
    while (pacer.state === 'running') {
      clock.advance(997);
    }
    expect(pacer.state).toBe('finished');
    expect(JSON.stringify(events)).toBe(JSON.stringify(headlessEvents(end)));
  });

  it('advances simulation time at wall time × speed', () => {
    const clock = new ManualClock();
    const { pacer, simulation } = createLiveRun({ config, seed: 1, start: T0, speed: 60, clock });
    pacer.start();
    clock.advance(10_000);
    expect(pacer.simNow()).toBe(T0 + 10 * MINUTE);
    expect(simulation.now).toBeLessThanOrEqual(T0 + 10 * MINUTE);
    pacer.setSpeed(0.5);
    clock.advance(10_000);
    expect(pacer.simNow()).toBe(T0 + 10 * MINUTE + 5 * SECOND);
  });

  it('never processes an event before its time has come', () => {
    const clock = new ManualClock();
    const lateness: number[] = [];
    const holder: { pacer?: { simNow(): number } } = {};
    const { pacer } = createLiveRun({
      config,
      seed: 2,
      start: T0,
      speed: 30,
      clock,
      onEvent: (event) => {
        lateness.push((holder.pacer?.simNow() ?? event.at) - event.at);
      },
    });
    holder.pacer = pacer;
    pacer.start();
    for (let i = 0; i < 600; i++) {
      clock.advance(173);
    }
    expect(lateness.length).toBeGreaterThan(100);
    expect(Math.min(...lateness)).toBeGreaterThanOrEqual(0);
  });

  it('freezes simulation time while paused and steps one event at a time', () => {
    const clock = new ManualClock();
    const events: PlantEvent[] = [];
    const { pacer, simulation } = createLiveRun({
      config,
      seed: 3,
      start: T0,
      speed: 60,
      clock,
      onEvent: (e) => events.push(e),
    });
    pacer.start();
    clock.advance(5_000);
    pacer.pause();
    const frozen = pacer.simNow();
    clock.advance(60_000);
    expect(pacer.simNow()).toBe(frozen);
    expect(pacer.state).toBe('paused');
    const before = simulation.now;
    expect(pacer.step()).toBe(true);
    expect(simulation.now).toBeGreaterThanOrEqual(before);
    const afterStep = simulation.now;
    pacer.resume();
    expect(pacer.state).toBe('running');
    clock.advance(1_000);
    expect(pacer.simNow()).toBe(afterStep + 60 * SECOND);
  });

  it('allows single steps before the first start, then runs on resume', () => {
    const clock = new ManualClock();
    const { pacer } = createLiveRun({ config, seed: 3, start: T0, speed: 60, clock });
    expect(pacer.step()).toBe(true);
    expect(pacer.state).toBe('paused');
    pacer.resume();
    expect(pacer.state).toBe('running');
  });

  it('stops at the end time and refuses to step past it', () => {
    const clock = new ManualClock();
    const { pacer, simulation } = createLiveRun({
      config,
      seed: 5,
      start: T0,
      end: T0 + 30 * MINUTE,
      speed: 60,
      clock,
    });
    pacer.start();
    clock.advance(31_000);
    expect(pacer.state).toBe('finished');
    expect(simulation.now).toBeLessThan(T0 + 30 * MINUTE);
    expect(() => pacer.step()).toThrow(/only possible while paused/);
    expect(clock.pendingTimers).toBe(0);
  });

  it('reports status and keeps timers bounded so the clock stays fresh', () => {
    const clock = new ManualClock();
    const { pacer } = createLiveRun({ config, seed: 6, start: T0, speed: 1, clock });
    pacer.start();
    expect(clock.pendingTimers).toBe(1);
    expect(pacer.status()).toMatchObject({ state: 'running', speed: 1, simNow: T0 });
    pacer.stop();
    expect(pacer.status().state).toBe('finished');
    expect(clock.pendingTimers).toBe(0);
  });

  it.each([0, 0.4, 61, Number.NaN])('rejects the speed %s', (speed) => {
    const simulation = new Simulation<string>(T0);
    expect(() => new LivePacer({ simulation, handle: () => undefined, speed })).toThrow(RangeError);
    const pacer = new LivePacer({ simulation, handle: () => undefined });
    expect(() => {
      pacer.setSpeed(speed);
    }).toThrow(RangeError);
  });

  it('rejects starting twice and ignores pause or resume in the wrong state', () => {
    const simulation = new Simulation<string>(T0);
    const pacer = new LivePacer({ simulation, handle: () => undefined, clock: new ManualClock() });
    pacer.pause();
    pacer.resume();
    expect(pacer.state).toBe('idle');
    pacer.start();
    expect(() => {
      pacer.start();
    }).toThrow(/cannot start/);
    expect(pacer.step.bind(pacer)).toThrow(/only possible while paused/);
    expect([MIN_SPEED, MAX_SPEED]).toEqual([0.5, 60]);
    pacer.stop();
  });

  it('keeps real-clock pacing within a few percent at 60× (wall-clock measurement)', async () => {
    const { pacer, simulation } = createLiveRun({
      config,
      seed: 7,
      start: T0,
      speed: 60,
      clock: systemClock,
    });
    const wallStart = performance.now();
    pacer.start();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const wall = performance.now() - wallStart;
    const simulated = pacer.simNow() - T0;
    pacer.stop();
    expect(simulated / (wall * 60)).toBeGreaterThan(0.97);
    expect(simulated / (wall * 60)).toBeLessThan(1.03);
    expect(pacer.simNow() - simulation.now).toBeLessThanOrEqual(60 * SECOND + 100);
  });
});
