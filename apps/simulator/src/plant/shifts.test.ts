import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, SECOND, Simulation } from '@shopfloor/sim-core';
import { chiSquareTest } from '@shopfloor/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { shiftAt } from './calendar.ts';
import { ProductionLine, type LineEvent, type PlantEvent } from './line.ts';
import { loadDefaultConfig, runningTimeBetween, partsAccountedFor } from './testing.ts';

const MONDAY_0600 = Date.UTC(2026, 9, 12, 3);
const WEEK = 7 * 24 * HOUR;
let defaults: PlantConfig;

beforeAll(async () => {
  defaults = await loadDefaultConfig();
});

function run(duration: number, configure: (c: PlantConfig) => void = () => undefined, seed = 5) {
  const config = structuredClone(defaults);
  configure(config);
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(seed),
    startTime: MONDAY_0600,
    onEvent: (event) => events.push(event),
  });
  const simulation = new Simulation<LineEvent>(MONDAY_0600);
  line.start(simulation);
  simulation.runUntil(MONDAY_0600 + duration, (event, sim) => {
    line.handle(event, sim);
  });
  const durations = (id: string) => {
    const station = line.stations.find((s) => s.id === id);
    if (!station) throw new Error(id);
    return station.machine.durations(MONDAY_0600 + duration);
  };
  return { line, events, durations, config };
}

const steady = (c: PlantConfig): void => {
  c.failures.equipment = {};
  c.schedule.machines = {
    'cnc-01': [{ product: 'VB-100', quantity: 1_000_000 }],
    'cnc-02': [{ product: 'VB-100', quantity: 1_000_000 }],
  };
  c.operators.absenceProbabilityPerShift = 0;
};

describe('shift calendar in the running plant (plan section 3)', () => {
  it('works 15 shifts a week and stays Off from Saturday 06:00 to Monday 06:00', () => {
    const { events, durations, line } = run(WEEK, steady);
    const shifts = events.filter((e) => e.type === 'shift');
    const starts = shifts.filter((e) => e.action === 'shift-start').map((e) => e.at);
    expect(starts.filter((at) => at < MONDAY_0600 + WEEK)).toHaveLength(14);
    expect(starts.at(-1)).toBe(MONDAY_0600 + WEEK);
    expect(shifts.filter((e) => e.action === 'shift-end').map((e) => e.at)).toEqual([
      MONDAY_0600 + 5 * 24 * HOUR,
    ]);
    for (const station of line.stations) {
      const d = durations(station.id);
      expect(d.Off).toBe(48 * HOUR);
      expect(d.PlannedStop).toBe(15 * 30 * MINUTE);
    }
  });

  it('enters PlannedStop only during breaks and Off only outside shifts', () => {
    const { events, config } = run(2 * WEEK);
    for (const e of events) {
      if (e.type !== 'state') continue;
      const shift = shiftAt(config.shifts, e.at);
      if (e.to === 'PlannedStop') expect(shift?.inBreak).toBe(true);
      if (e.to === 'Off') expect(shift).toBeUndefined();
    }
  });

  it('resumes interrupted cycles after breaks: running time per OP10 cycle stays 240 s', () => {
    const { events } = run(WEEK, (c) => {
      steady(c);
      c.process.cycleTimeCv.OP10 = 0;
    });
    const perCycle = runningTimeBetween(events, 'cnc-01', (e) => e.type === 'cycle-complete');
    expect(perCycle.length).toBeGreaterThan(500);
    expect(new Set(perCycle)).toEqual(new Set([240 * SECOND]));
    expect(
      events.some(
        (e) =>
          e.type === 'state' &&
          e.machineId === 'cnc-01' &&
          e.from === 'Running' &&
          e.to === 'PlannedStop',
      ),
    ).toBe(true);
  });

  it('keeps a repair going through a break and ends it in PlannedStop', () => {
    const { events } = run(2 * WEEK, (c) => {
      for (const equipment of Object.values(c.failures.equipment)) {
        for (const mode of equipment.failureModes) {
          mode.weibullScaleHours = 3;
          mode.repairMedianMinutes = 40;
        }
      }
    });
    const transitions = events.flatMap((e) => (e.type === 'state' ? [`${e.from}->${e.to}`] : []));
    expect(transitions).toContain('Down->PlannedStop');
    expect(transitions).not.toContain('Down->Stopped');
  });
});

describe('operators at ASM-01 (plan section 3)', () => {
  it('scales the manual cycle by the assigned operator speed factor', () => {
    const { events } = run(WEEK, (c) => {
      steady(c);
      c.process.cycleTimeCv.OP30 = 0;
      c.operators.operators = c.operators.operators.map((op) => ({ ...op, speedFactor: 1.2 }));
    });
    const perCycle = runningTimeBetween(events, 'asm-01', (e) => e.type === 'cycle-complete');
    expect(new Set(perCycle)).toEqual(new Set([180 * SECOND]));
    const assigned = events.flatMap((e) => (e.type === 'operator' ? [e.operatorId] : []));
    expect(assigned.slice(0, 3)).toEqual(['op-a1', 'op-b1', 'op-c1']);
  });

  it('stops ASM-01 with NO-OPERATOR when nobody qualified is present', () => {
    const { durations, events, line } = run(24 * HOUR, (c) => {
      steady(c);
      c.operators.absenceProbabilityPerShift = 1;
    });
    expect(line.finished).toHaveLength(0);
    expect(durations('asm-01').Running).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'state',
        machineId: 'asm-01',
        to: 'Idle',
        cause: 'NO-OPERATOR',
      }),
    );
    expect(durations('cnc-01').Blocked).toBeGreaterThan(10 * HOUR);
  });

  it('draws absences at the configured rate (chi-square)', () => {
    const { events } = run(20 * WEEK, (c) => {
      steady(c);
      c.operators.absenceProbabilityPerShift = 0.2;
    });
    const shifts = events.filter((e) => e.type === 'operator');
    const absent = shifts.reduce((n, e) => n + e.absent.length, 0);
    const total = shifts.length * 2;
    expect(
      chiSquareTest([absent, total - absent], [total * 0.2, total * 0.8]).pValue,
    ).toBeGreaterThan(0.01);
  });
});

describe('full model over two weeks', () => {
  it('keeps time accounting and conservation exact and is deterministic', () => {
    const duration = 2 * WEEK + 13 * MINUTE;
    const a = run(duration);
    for (const station of a.line.stations) {
      const total = Object.values(a.durations(station.id)).reduce((s, d) => s + d, 0);
      expect(total).toBe(duration);
    }
    expect(a.line.producedParts).toBe(partsAccountedFor(a.line));
    expect(JSON.stringify(run(duration).events)).toBe(JSON.stringify(a.events));
  });
});
