import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, SECOND, Simulation } from '@shopfloor/sim-core';
import { exponentialCdf, ksTest, logNormalCdf, weibullCdf } from '@shopfloor/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductionLine, type LineEvent, type PlantEvent } from './line.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
const ALPHA = 0.01;
let defaults: PlantConfig;

beforeAll(async () => {
  const result = await loadPlantConfig(resolve(import.meta.dirname, '../../../../config/plant'));
  if (!result.ok) {
    throw new Error(formatIssues(result.issues));
  }
  defaults = result.config;
});

function run(duration: number, configure: (c: PlantConfig) => void = () => undefined, seed = 3) {
  const config = structuredClone(defaults);
  config.schedule.machines = {
    'cnc-01': [{ product: 'VB-100', quantity: 1_000_000 }],
    'cnc-02': [{ product: 'VB-100', quantity: 1_000_000 }],
  };
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
  return { line, events };
}

const stateEvents = (events: PlantEvent[], machineId: string) =>
  events.flatMap((e) => (e.type === 'state' && e.machineId === machineId ? [e] : []));

function runningTimeBetween(
  events: PlantEvent[],
  machineId: string,
  isMark: (e: PlantEvent) => boolean,
): number[] {
  const gaps: number[] = [];
  let running = 0;
  let runningSince: number | undefined;
  for (const event of events) {
    if (event.machineId !== machineId) {
      continue;
    }
    if (event.type === 'state') {
      if (runningSince !== undefined) {
        running += event.at - runningSince;
        runningSince = undefined;
      }
      if (event.to === 'Running') {
        runningSince = event.at;
      }
    }
    if (isMark(event)) {
      const extra = runningSince === undefined ? 0 : event.at - runningSince;
      gaps.push(running + extra);
      running = -extra;
    }
  }
  return gaps;
}

const singleCncModel = (c: PlantConfig): void => {
  c.failures.equipment = {
    'cnc-01': {
      failureModes: [
        {
          code: 'SPINDLE-OVERLOAD',
          weibullShape: 1.4,
          weibullScaleHours: 0.5,
          repairMedianMinutes: 2,
          repairSpread: 0.5,
        },
      ],
      minorStops: { ratePerHour: 6, meanSeconds: 30, causes: ['DOOR-INTERLOCK', 'CHIP-JAM'] },
    },
  };
};

describe('breakdowns, minor stops and repairs (plan section 4)', () => {
  it('produces Down and Stopped time with the configured causes on the default plant', () => {
    const { events } = run(7 * 24 * HOUR);
    const downCauses = new Set<string>();
    const stopCauses = new Set<string>();
    for (const e of stateEvents(events, 'cnc-01')) {
      if (e.to === 'Down') downCauses.add(e.cause ?? '');
      if (e.to === 'Stopped') stopCauses.add(e.cause ?? '');
    }
    expect([...downCauses].every((c) => ['SPINDLE-OVERLOAD', 'COOLANT-PRESSURE'].includes(c))).toBe(
      true,
    );
    expect(downCauses.size).toBeGreaterThan(0);
    expect([...stopCauses].sort()).toEqual(['CHIP-JAM', 'DOOR-INTERLOCK']);
  });

  it('measures time to failure in running hours: it follows the Weibull (KS test)', () => {
    const { events } = run(400 * HOUR, singleCncModel);
    const ttf = runningTimeBetween(events, 'cnc-01', (e) => e.type === 'state' && e.to === 'Down');
    expect(ttf.length).toBeGreaterThan(300);
    expect(ksTest(ttf, weibullCdf(1.4, 0.5 * HOUR)).pValue).toBeGreaterThan(ALPHA);
  });

  it('draws repair times from the log-normal around the median (KS test)', () => {
    const { events } = run(400 * HOUR, singleCncModel);
    const starts = events.filter((e) => e.type === 'repair-start').map((e) => e.at);
    const ends = events.filter((e) => e.type === 'repair-end').map((e) => e.at);
    const repairs = ends.map((end, i) => end - (starts[i] ?? end));
    expect(repairs.length).toBeGreaterThan(300);
    expect(ksTest(repairs, logNormalCdf(Math.log(2 * MINUTE), 0.5)).pValue).toBeGreaterThan(ALPHA);
  });

  it('spaces minor stops by exponential running time and makes them exponential long', () => {
    const { events } = run(400 * HOUR, singleCncModel);
    const gaps = runningTimeBetween(
      events,
      'cnc-01',
      (e) => e.type === 'state' && e.to === 'Stopped',
    );
    expect(gaps.length).toBeGreaterThan(1_000);
    expect(ksTest(gaps, exponentialCdf(HOUR / 6)).pValue).toBeGreaterThan(ALPHA);
    const states = stateEvents(events, 'cnc-01');
    const durations = states.flatMap((e, i) =>
      e.to === 'Stopped' && states[i + 1] ? [(states[i + 1]?.at ?? 0) - e.at] : [],
    );
    expect(ksTest(durations, exponentialCdf(30 * SECOND)).pValue).toBeGreaterThan(ALPHA);
  });

  it('resumes an interrupted cycle: running time per cycle stays exactly the ideal time', () => {
    const { events } = run(100 * HOUR, (c) => {
      singleCncModel(c);
      c.process.cycleTimeCv.OP10 = 0;
    });
    const perCycle = runningTimeBetween(events, 'cnc-01', (e) => e.type === 'cycle-complete');
    expect(perCycle.length).toBeGreaterThan(500);
    expect(new Set(perCycle)).toEqual(new Set([240 * SECOND]));
  });

  it('never runs more repairs at once than there are technicians', () => {
    const { events } = run(200 * HOUR, (c) => {
      c.plant.maintenanceTechnicians = 1;
      for (const equipment of Object.values(c.failures.equipment)) {
        for (const mode of equipment.failureModes) {
          mode.weibullScaleHours = 2;
          mode.repairMedianMinutes = 30;
        }
      }
    });
    let active = 0;
    let waited = false;
    const downSince = new Map<string, number>();
    for (const e of events) {
      if (e.type === 'state' && e.to === 'Down') downSince.set(e.machineId, e.at);
      if (e.type === 'repair-start') {
        active++;
        expect(active).toBe(1);
        waited ||= e.at > (downSince.get(e.machineId) ?? e.at);
      }
      if (e.type === 'repair-end') active--;
    }
    expect(waited).toBe(true);
  });

  it('only breaks down while running: no failure starts from Blocked, Starved or Idle', () => {
    const { events } = run(7 * 24 * HOUR);
    const downFrom = events.flatMap((e) => (e.type === 'state' && e.to === 'Down' ? [e.from] : []));
    expect(downFrom.length).toBeGreaterThan(0);
    expect(new Set(downFrom)).toEqual(new Set(['Running']));
  });

  it('keeps time accounting and part conservation exact with failures on', () => {
    const duration = 7 * 24 * HOUR + 17 * MINUTE;
    const { line } = run(duration);
    line.stations.forEach((station) => {
      const durations = station.machine.durations(T0 + duration);
      expect(Object.values(durations).reduce((s, d) => s + d, 0)).toBe(duration);
    });
    const inBuffers = line.buffers.reduce((s, b) => s + b.size, 0);
    const inMachines = line.stations.filter((s) => s.part !== undefined).length;
    expect(line.producedParts).toBe(line.finished.length + inBuffers + inMachines);
  });

  it('is deterministic with failures on', () => {
    const a = run(48 * HOUR).events;
    const b = run(48 * HOUR).events;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
