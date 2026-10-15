import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CALIBRATION_ALARM_CODE,
  CALIBRATION_ALARM_SEVERITY,
  FAILURE_ALARM_SEVERITY,
  ProductionLine,
  type LineEvent,
  type PlantEvent,
} from './line.ts';
import { continuousOperation, loadDefaultConfig, unlimitedMaterial } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
const DAY = 24 * HOUR;
let defaults: PlantConfig;

beforeAll(async () => {
  defaults = await loadDefaultConfig();
});

function endless(c: PlantConfig): void {
  continuousOperation(c);
  c.schedule.machines = {
    'cnc-01': [{ product: 'VB-100', quantity: 1_000_000 }],
    'cnc-02': [{ product: 'VB-100', quantity: 1_000_000 }],
  };
}

function run(duration: number, seed = 5, configure: (c: PlantConfig) => void = endless) {
  const config = structuredClone(defaults);
  configure(config);
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(seed),
    startTime: T0,
    onEvent: (event) => events.push(event),
  });
  const simulation = new Simulation<LineEvent>(T0);
  line.start(simulation);
  simulation.runUntil(T0 + duration, (event, sim) => {
    line.handle(event, sim);
  });
  return { config, line, events };
}

type AlarmEvent = Extract<PlantEvent, { type: 'alarm' }>;
const alarms = (events: readonly PlantEvent[]): AlarmEvent[] =>
  events.flatMap((e) => (e.type === 'alarm' ? [e] : []));

describe('alarms (ADR-0010)', () => {
  it('raises the failure code when a machine breaks down and clears it when the repair ends', () => {
    const { config, events } = run(3 * DAY, 5, (c) => {
      endless(c);
      for (const machine of Object.values(c.failures.equipment)) {
        for (const mode of machine.failureModes) {
          mode.weibullScaleHours /= 10;
        }
      }
    });
    const breakdowns = events.flatMap((e) => (e.type === 'state' && e.to === 'Down' ? [e] : []));
    const repairEnds = events.flatMap((e) => (e.type === 'repair-end' ? [e] : []));
    expect(new Set(breakdowns.map((b) => b.machineId)).size).toBe(
      Object.keys(config.failures.equipment).length,
    );
    expect(breakdowns.length).toBeGreaterThan(20);
    const raised = alarms(events).filter(
      (a) => a.transition === 'active' && a.code !== CALIBRATION_ALARM_CODE,
    );
    expect(raised.map((a) => [a.at, a.machineId, a.code])).toEqual(
      breakdowns.map((b) => [b.at, b.machineId, b.cause]),
    );
    const cleared = alarms(events).filter(
      (a) => a.transition === 'cleared' && a.code !== CALIBRATION_ALARM_CODE,
    );
    expect(cleared.map((a) => [a.at, a.machineId, a.code])).toEqual(
      repairEnds.map((r) => [r.at, r.machineId, r.failureCode]),
    );
    expect(new Set(raised.map((a) => a.severity))).toEqual(new Set([FAILURE_ALARM_SEVERITY]));
  });

  it('raises CALIBRATION-DUE on the leak tester when calibration falls due and clears it after calibrating', () => {
    const { config, events } = run(15 * DAY);
    const interval = config.process.leakTest.calibrationIntervalDays * DAY;
    const calibration = alarms(events).filter((a) => a.code === CALIBRATION_ALARM_CODE);
    expect(new Set(calibration.map((a) => a.machineId))).toEqual(new Set(['lkt-01']));
    expect(new Set(calibration.map((a) => a.severity))).toEqual(
      new Set([CALIBRATION_ALARM_SEVERITY]),
    );
    expect(calibration.map((a) => a.transition)).toEqual([
      'active',
      'cleared',
      'active',
      'cleared',
    ]);
    const ends = events.flatMap((e) =>
      e.type === 'state' && e.machineId === 'lkt-01' && e.from === 'Maintenance' ? [e.at] : [],
    );
    expect(calibration[0]?.at).toBe(T0 + interval);
    expect(calibration[1]?.at).toBe(ends[0]);
    expect(calibration[2]?.at).toBe((ends[0] ?? 0) + interval);
    expect(calibration[3]?.at).toBe(ends[1]);
  });

  it('keeps CALIBRATION-DUE active while the line is off until the calibration actually happens', () => {
    // Due Sunday 00:00 Istanbul, while the line is off for the weekend.
    const { events } = run(8 * DAY, 5, (c) => {
      unlimitedMaterial(c);
      c.schedule.machines = {
        'cnc-01': [{ product: 'VB-100', quantity: 1_000_000 }],
        'cnc-02': [{ product: 'VB-100', quantity: 1_000_000 }],
      };
      c.process.leakTest.calibrationIntervalDays = 5.75;
    });
    const calibration = alarms(events).filter((a) => a.code === CALIBRATION_ALARM_CODE);
    const first = calibration[0];
    const second = calibration[1];
    expect(first?.transition).toBe('active');
    expect(second?.transition).toBe('cleared');
    const maintenance = events.find(
      (e) => e.type === 'state' && e.machineId === 'lkt-01' && e.to === 'Maintenance',
    );
    expect(maintenance?.at).toBeGreaterThanOrEqual(first?.at ?? 0);
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThan(24 * HOUR);
  });

  it('alternates active and cleared per machine and code, and agrees with the station view', () => {
    for (const seed of [1, 2, 3]) {
      const { line, events } = run(10 * DAY, seed);
      const open = new Map<string, boolean>();
      for (const alarm of alarms(events)) {
        const key = `${alarm.machineId}/${alarm.code}`;
        expect(open.get(key) ?? false).toBe(alarm.transition === 'cleared');
        open.set(key, alarm.transition === 'active');
      }
      for (const station of line.stations) {
        const expected = [...open]
          .filter(([key, active]) => active && key.startsWith(`${station.id}/`))
          .map(([key]) => key.slice(station.id.length + 1))
          .sort();
        expect([...station.activeAlarms].sort()).toEqual(expected);
      }
    }
  });
});
