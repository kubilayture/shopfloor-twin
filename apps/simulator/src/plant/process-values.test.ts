import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, SECOND, Simulation } from '@shopfloor/sim-core';
import { ksTest, normalCdf } from '@shopfloor/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import { ProductionLine, type LineEvent, type PlantEvent } from './line.ts';
import { ProcessValues } from './process-values.ts';
import { loadDefaultConfig } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

const state = (machineId: string, at: number, from: string, to: string): PlantEvent =>
  ({ type: 'state', machineId, at, from, to }) as PlantEvent;

describe('process values (phase 2 plan)', () => {
  it('reads 0 % spindle load unless the machine is Running', () => {
    const values = new ProcessValues(config.process.processValues, 1, T0);
    expect(values.read('cnc-01', T0)?.spindleLoadPercent).toBe(0);
    values.record(state('cnc-01', T0 + MINUTE, 'Off', 'Running'));
    expect(values.read('cnc-01', T0 + 2 * MINUTE)?.spindleLoadPercent).toBeGreaterThan(30);
    values.record(state('cnc-01', T0 + 3 * MINUTE, 'Running', 'Stopped'));
    expect(values.read('cnc-01', T0 + 4 * MINUTE)?.spindleLoadPercent).toBe(0);
  });

  it('draws running spindle load from the configured normal distribution (KS test)', () => {
    const values = new ProcessValues(config.process.processValues, 3, T0);
    values.record(state('cnc-02', T0, 'Off', 'Running'));
    const samples = Array.from(
      { length: 5_000 },
      (_, i) => values.read('cnc-02', T0 + i * SECOND)?.spindleLoadPercent ?? 0,
    );
    const { meanPercent, sigmaPercent } = config.process.processValues.spindleLoad;
    expect(ksTest(samples, normalCdf(meanPercent, sigmaPercent)).pValue).toBeGreaterThan(0.01);
  });

  it('gives the same value for the same time, however often and in whatever order it is read', () => {
    const a = new ProcessValues(config.process.processValues, 5, T0);
    const b = new ProcessValues(config.process.processValues, 5, T0);
    for (const v of [a, b]) v.record(state('cnc-01', T0, 'Off', 'Running'));
    const times = Array.from({ length: 200 }, (_, i) => T0 + i * 1_337);
    const once = times.map((t) => a.read('cnc-01', t));
    const reversedOften = [...times]
      .reverse()
      .flatMap((t) => [b.read('cnc-01', t), b.read('cnc-01', t)]);
    expect(reversedOften.filter((_, i) => i % 2 === 0).reverse()).toEqual(once);
  });

  it('moves coolant temperature towards its target with the configured time constant', () => {
    const values = new ProcessValues(config.process.processValues, 1, T0);
    const { ambientCelsius, runningCelsius, tauMinutes } = config.process.processValues.coolant;
    values.record(state('cnc-01', T0, 'Off', 'Running'));
    const atTau = values.read('cnc-01', T0 + tauMinutes * MINUTE)?.coolantCelsius ?? 0;
    expect(atTau).toBeCloseTo(runningCelsius - (runningCelsius - ambientCelsius) * Math.exp(-1), 1);
    expect(values.read('cnc-01', T0 + 10 * HOUR)?.coolantCelsius).toBe(runningCelsius);
    values.record(state('cnc-01', T0 + 10 * HOUR, 'Running', 'Idle'));
    expect(values.read('cnc-01', T0 + 10 * HOUR)?.coolantCelsius).toBe(runningCelsius);
    expect(values.read('cnc-01', T0 + 20 * HOUR)?.coolantCelsius).toBe(ambientCelsius);
  });

  it('reports values at sensor resolution and ignores machines without process values', () => {
    const values = new ProcessValues(config.process.processValues, 1, T0);
    values.record(state('cnc-01', T0, 'Off', 'Running'));
    values.record(state('asm-01', T0, 'Off', 'Running'));
    for (let i = 0; i < 100; i++) {
      const reading = values.read('cnc-01', T0 + i * 7_919);
      expect(String(reading?.spindleLoadPercent)).toMatch(/^\d+(\.\d)?$/);
      expect(String(reading?.coolantCelsius)).toMatch(/^\d+(\.\d)?$/);
    }
    expect(values.read('asm-01', T0)).toBeUndefined();
    expect(() => values.read('cnc-01', T0 - 1)).toThrow(RangeError);
  });

  it('yields identical readings in a paced live run and in a headless run fed the same events', () => {
    const end = T0 + 4 * HOUR;
    const clock = new ManualClock();
    const samples: [number, number, number][] = [];
    const { pacer, processValues } = createLiveRun({
      config,
      seed: 8,
      start: T0,
      end,
      speed: 60,
      clock,
    });
    pacer.start();
    while (pacer.state !== 'finished') {
      clock.advance(1_234);
      const now = pacer.simNow();
      const reading = processValues.read('cnc-01', now);
      if (reading) samples.push([now, reading.spindleLoadPercent, reading.coolantCelsius]);
    }
    const headlessValues = new ProcessValues(config.process.processValues, 8, T0);
    const events: PlantEvent[] = [];
    const line = new ProductionLine({
      config,
      random: new RandomSource(8),
      startTime: T0,
      onEvent: (e) => events.push(e),
    });
    const simulation = new Simulation<LineEvent>(T0);
    line.start(simulation);
    simulation.runUntil(end - 1, (event, sim) => {
      line.handle(event, sim);
    });
    let next = 0;
    const replay = samples.map(([t]) => {
      while (next < events.length && (events[next]?.at ?? Infinity) <= t) {
        const event = events[next++];
        if (event) headlessValues.record(event);
      }
      const reading = headlessValues.read('cnc-01', t);
      return [t, reading?.spindleLoadPercent, reading?.coolantCelsius];
    });
    expect(samples.length).toBeGreaterThan(100);
    expect(replay).toEqual(samples);
  });
});
