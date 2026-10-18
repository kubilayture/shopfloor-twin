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

  it('processes events on time with the real clock: lateness in wall time stays small at 60×', async () => {
    const lateness: number[] = [];
    const holder: { pacer?: { simNow(): number } } = {};
    const { pacer } = createLiveRun({
      config,
      seed: 7,
      start: T0,
      speed: 60,
      clock: systemClock,
      onEvent: (event) => {
        if (holder.pacer) {
          lateness.push((holder.pacer.simNow() - event.at) / 60);
        }
      },
    });
    while (pacer.simNow() < T0 + 2 * HOUR) {
      pacer.step();
    }
    holder.pacer = pacer;
    pacer.resume();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    pacer.stop();
    expect(lateness.length).toBeGreaterThan(5);
    expect(Math.min(...lateness)).toBeGreaterThanOrEqual(0);
    const sorted = [...lateness].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length * 0.95)]).toBeLessThan(100);
  });

  it('property: random pacing operations never change the event stream', () => {
    const random = new RandomSource(99).stream('pacer-ops');
    for (let trial = 0; trial < 40; trial++) {
      const seed = 1 + (trial % 5);
      const hours = 1 + Math.floor(random.nextFloat() * 4);
      const reference = headlessEvents(T0 + hours * HOUR, seed);
      const endOnEvent = trial % 2 === 0 ? reference.at(-1)?.at : undefined;
      const end = endOnEvent ?? T0 + hours * HOUR;
      const expected = endOnEvent === undefined ? reference : headlessEvents(end, seed);
      const clock = new ManualClock();
      const events: PlantEvent[] = [];
      const { pacer } = createLiveRun({
        config,
        seed,
        start: T0,
        end,
        speed: 0.5 + random.nextFloat() * 59.5,
        clock,
        onEvent: (e) => events.push(e),
      });
      if (random.nextFloat() < 0.5) {
        pacer.step();
        pacer.resume();
      } else {
        pacer.start();
      }
      let guard = 0;
      while (pacer.state !== 'finished' && guard++ < 100_000) {
        const op = random.nextFloat();
        if (op < 0.6 || pacer.state === 'idle') {
          clock.advance(Math.floor(random.nextFloat() * 5_000));
        } else if (op < 0.7) {
          pacer.pause();
        } else if (op < 0.8 && pacer.state === 'paused') {
          pacer.step();
        } else if (op < 0.9) {
          pacer.resume();
        } else {
          pacer.setSpeed(0.5 + random.nextFloat() * 59.5);
        }
        if (pacer.state === 'paused' && random.nextFloat() < 0.3) {
          pacer.resume();
        }
      }
      expect(pacer.state).toBe('finished');
      expect(clock.pendingTimers).toBe(0);
      expect(JSON.stringify(events)).toBe(JSON.stringify(expected));
    }
  });

  it('defers control calls made from inside an event handler', () => {
    const clock = new ManualClock();
    const events: PlantEvent[] = [];
    const holder: { pacer?: { pause(): void; resume(): void } } = {};
    const end = T0 + 3 * HOUR;
    const { pacer } = createLiveRun({
      config,
      seed: 4,
      start: T0,
      end,
      speed: 60,
      clock,
      onEvent: (event) => {
        events.push(event);
        if (events.length % 50 === 0) {
          holder.pacer?.pause();
        }
      },
    });
    holder.pacer = pacer;
    pacer.start();
    let guard = 0;
    while (pacer.state !== 'finished' && guard++ < 10_000) {
      if (pacer.state === 'paused') {
        pacer.resume();
      }
      clock.advance(1_000);
    }
    expect(JSON.stringify(events)).toBe(JSON.stringify(headlessEvents(end)));
  });

  it('leaves no timer behind when stopped from a callback', () => {
    const clock = new ManualClock();
    const holder: { pacer?: { stop(): void } } = {};
    const { pacer } = createLiveRun({
      config,
      seed: 4,
      start: T0,
      speed: 60,
      clock,
      onAdvance: (simNow) => {
        if (simNow > T0 + 10 * MINUTE) {
          holder.pacer?.stop();
        }
      },
    });
    holder.pacer = pacer;
    pacer.start();
    clock.advance(20_000);
    expect(pacer.state).toBe('finished');
    expect(clock.pendingTimers).toBe(0);
  });

  it('refuses a step from inside an event handler', () => {
    const clock = new ManualClock();
    const holder: { pacer?: { step(): boolean } } = {};
    const errors: unknown[] = [];
    const { pacer } = createLiveRun({
      config,
      seed: 4,
      start: T0,
      speed: 60,
      clock,
      onAdvance: () => {
        try {
          holder.pacer?.step();
        } catch (error) {
          errors.push(error);
        }
      },
    });
    holder.pacer = pacer;
    pacer.start();
    expect(String(errors[0])).toMatch(/while an event is being processed/);
    pacer.stop();
  });
});

describe('pacer cues (#235, the infrastructure entries of a live timeline)', () => {
  /** One event a second for an hour, so a cue between two events shows the boundary. */
  function ticking(speed = 10) {
    const clock = new ManualClock();
    const simulation = new Simulation<number>(T0);
    for (let i = 0; i <= 3600; i++) simulation.schedule(T0 + i * SECOND, i);
    const handled: number[] = [];
    const pacer = new LivePacer<number>({
      simulation,
      handle: (event) => handled.push(event),
      speed,
      end: T0 + HOUR,
      clock,
    });
    return { clock, simulation, pacer, handled };
  }

  it('pauses exactly at a pause cue, with every event of that millisecond processed', () => {
    const { clock, simulation, pacer, handled } = ticking();
    pacer.cue({ at: T0 + 90 * SECOND, kind: 'pause' });
    pacer.start();
    clock.advance(60_000);
    expect(pacer.state).toBe('paused');
    expect(simulation.now).toBe(T0 + 90 * SECOND);
    expect(pacer.simNow()).toBe(T0 + 90 * SECOND);
    expect(handled.at(-1)).toBe(90);
    expect(clock.pendingTimers).toBe(0);
    pacer.resume();
    while (pacer.state === 'running') clock.advance(1_000);
    expect(handled).toHaveLength(3600);
  });

  it('changes the speed at a speed cue, keeping the paced clock continuous', () => {
    const { clock, simulation, pacer } = ticking(10);
    pacer.cue({ at: T0 + 100 * SECOND, kind: 'speed', speed: 60 });
    pacer.start();
    // 10 wall seconds at 10× reach the cue; 1 more at 60× is 60 simulated seconds.
    clock.advance(11_000);
    expect(pacer.speed).toBe(60);
    expect(pacer.simNow()).toBe(T0 + 160 * SECOND);
    expect(simulation.now).toBeLessThanOrEqual(T0 + 160 * SECOND);
    expect(pacer.pendingCues).toBe(0);
  });

  it('runs call cues in time order, stepping included, and never one at or after the end', () => {
    const { clock, pacer } = ticking();
    const calls: string[] = [];
    const seen: string[] = [];
    pacer.onCue = (cue) => seen.push(`${cue.kind}@${String((cue.at - T0) / SECOND)}`);
    pacer.cue({ at: T0 + 2 * SECOND, kind: 'call', run: () => calls.push('b') });
    pacer.cue({ at: T0 + SECOND, kind: 'call', run: () => calls.push('a') });
    pacer.cue({ at: T0 + 2 * SECOND, kind: 'call', run: () => calls.push('c') });
    pacer.cue({ at: T0 + HOUR, kind: 'call', run: () => calls.push('never') });
    pacer.step();
    pacer.step();
    expect(calls).toEqual(['a']);
    pacer.step();
    expect(calls).toEqual(['a', 'b', 'c']);
    pacer.resume();
    while (pacer.state === 'running') clock.advance(1_000);
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(seen).toEqual(['call@1', 'call@2', 'call@2']);
  });

  it('applies cues between sparse events on time, the paced clock never jumping or going back', () => {
    const clock = new ManualClock();
    const simulation = new Simulation<number>(T0);
    simulation.schedule(T0, 0);
    simulation.schedule(T0 + HOUR, 1);
    const calls: number[] = [];
    const pacer = new LivePacer<number>({
      simulation,
      handle: () => undefined,
      speed: 10,
      end: T0 + 2 * HOUR,
      clock,
    });
    pacer.cue({ at: T0 + 30 * SECOND, kind: 'speed', speed: 60 });
    pacer.cue({ at: T0 + 90 * SECOND, kind: 'call', run: () => calls.push(clock.now()) });
    pacer.cue({ at: T0 + 150 * SECOND, kind: 'pause' });
    pacer.start();
    let last = pacer.simNow();
    while (pacer.state === 'running' && clock.now() < 60_000) {
      clock.advance(7);
      const now = pacer.simNow();
      expect(now).toBeGreaterThanOrEqual(last);
      // At 10× until 30 s (3 s of wall time), then 60×: never ahead of that schedule.
      const wall = clock.now();
      const expected = wall <= 3_000 ? wall * 10 : 30_000 + (wall - 3_000) * 60;
      expect(now - T0).toBeLessThanOrEqual(Math.min(expected, 150_000));
      last = now;
    }
    // 3 s at 10× to 30 s, then 1 s at 60× to 90 s and 2 s more to 150 s: due at 4 s and 5 s.
    expect(calls).toEqual([4_000]);
    expect(pacer.state).toBe('paused');
    expect(pacer.simNow()).toBe(T0 + 150 * SECOND);
    expect(clock.now()).toBeLessThanOrEqual(5_007);
  });

  it('refuses a cue in the past or with a speed out of range', () => {
    const { clock, pacer } = ticking();
    pacer.start();
    clock.advance(5_000);
    expect(() => {
      pacer.cue({ at: T0, kind: 'pause' });
    }).toThrow(/at or after the simulation time/);
    expect(() => {
      pacer.cue({ at: T0 + HOUR, kind: 'speed', speed: 61 });
    }).toThrow(/speed must be between/);
  });

  it('leaves no stray timer when a pause cue is reached inside setSpeed', () => {
    // A clock whose timers fire 50 ms late, so the paced time can pass a cue before its timer.
    const manual = new ManualClock();
    const clock = {
      now: () => manual.now(),
      setTimeout: (callback: () => void, ms: number) => manual.setTimeout(callback, ms + 50),
      clearTimeout: (handle: unknown) => {
        manual.clearTimeout(handle);
      },
    };
    const simulation = new Simulation<number>(T0);
    simulation.schedule(T0 + HOUR, 0);
    const pacer = new LivePacer<number>({ simulation, handle: () => undefined, speed: 10, clock });
    pacer.cue({ at: T0 + 5_050, kind: 'pause' });
    pacer.start();
    // Due at 505 ms of wall time; its timer fires at 555 ms.
    manual.advance(520);
    expect(pacer.state).toBe('running');
    // setSpeed first advances to the paced time, past the cue, which pauses the run there.
    pacer.setSpeed(20);
    expect(pacer.state).toBe('paused');
    expect(pacer.simNow()).toBe(T0 + 5_050);
    expect(manual.pendingTimers).toBe(0);
  });
});
