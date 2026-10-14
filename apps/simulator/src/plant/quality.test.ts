import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, Simulation } from '@shopfloor/sim-core';
import { chiSquareTest, ksTest, normalCdf } from '@shopfloor/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductionLine, type LineEvent, type PlantEvent } from './line.ts';
import { LeakTester, ToolWear, interpolate } from './quality.ts';
import { continuousOperation, loadDefaultConfig, partsAccountedFor } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
const DAY = 24 * HOUR;
let defaults: PlantConfig;

beforeAll(async () => {
  defaults = await loadDefaultConfig();
});

function run(duration: number, configure: (c: PlantConfig) => void = () => undefined, seed = 11) {
  const config = structuredClone(defaults);
  continuousOperation(config);
  config.failures.equipment = {};
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
  return { line, events, config };
}

const cycles = (events: PlantEvent[], machineId: string) =>
  events.flatMap((e) => (e.type === 'cycle-complete' && e.machineId === machineId ? [e] : []));

describe('quality model units', () => {
  const curve = [
    { wear: 0, probability: 0.002 },
    { wear: 0.8, probability: 0.005 },
    { wear: 1, probability: 0.05 },
  ];

  it.each([
    [0, 0.002],
    [0.4, 0.0035],
    [0.8, 0.005],
    [0.9, 0.0275],
    [1, 0.05],
    [1.5, 0.05],
    [-1, 0.002],
  ])('interpolates the defect curve at wear %s to %s', (wear, expected) => {
    expect(interpolate(curve, wear)).toBeCloseTo(expected, 10);
  });

  it('asks for a tool change after its life and resets on change', () => {
    const tool = new ToolWear({ lifeCycles: 3, changeMinutes: 8, defectProbability: curve });
    tool.recordCycle();
    tool.recordCycle();
    expect(tool.needsChange).toBe(false);
    tool.recordCycle();
    expect(tool.needsChange).toBe(true);
    expect(tool.defectProbability()).toBeCloseTo(0.05, 10);
    tool.change();
    expect(tool.cycles).toBe(0);
  });

  it('drifts the leak reading by days since calibration and resets on calibration', () => {
    const tester = new LeakTester(
      { ...defaults.process.leakTest, driftPerDay: 0.1 },
      new RandomSource(1).stream('leak'),
      T0,
    );
    expect(tester.measure(T0 + 3 * DAY).drift).toBeCloseTo(0.3, 10);
    expect(tester.calibrationDue(T0 + 7 * DAY - 1)).toBe(false);
    expect(tester.calibrationDue(T0 + 7 * DAY)).toBe(true);
    tester.calibrate(T0 + 7 * DAY);
    expect(tester.measure(T0 + 7 * DAY).drift).toBe(0);
  });
});

describe('tool wear and OP10 scrap (plan section 3)', () => {
  it('changes the tool every 400 cycles on each CNC', () => {
    const { events } = run(10 * DAY);
    for (const cnc of ['cnc-01', 'cnc-02']) {
      const changes = events.filter(
        (e) => e.type === 'state' && e.machineId === cnc && e.cause === 'TOOL-CHANGE',
      );
      const done = cycles(events, cnc).length;
      expect(changes.length).toBe(Math.floor((done - 1) / 400));
    }
  });

  it('scraps at the rate the wear curve predicts, with reason DIMENSIONAL (chi-square)', () => {
    const { events, config } = run(40 * DAY, (c) => {
      c.process.tool.defectProbability = c.process.tool.defectProbability.map((point) => ({
        ...point,
        probability: point.probability * 10,
      }));
    });
    const op10 = [...cycles(events, 'cnc-01'), ...cycles(events, 'cnc-02')];
    const scrap = op10.filter((e) => e.result === 'scrap');
    expect(new Set(scrap.map((e) => e.reason))).toEqual(new Set(['DIMENSIONAL']));
    const life = config.process.tool.lifeCycles;
    const meanP =
      Array.from({ length: life }, (_, k) =>
        interpolate(config.process.tool.defectProbability, k / life),
      ).reduce((s, p) => s + p, 0) / life;
    const n = op10.length;
    expect(
      chiSquareTest([scrap.length, n - scrap.length], [n * meanP, n * (1 - meanP)]).pValue,
    ).toBeGreaterThan(0.01);
  });

  it('gives scrapped parts a serial but never sends them downstream', () => {
    const { events, line } = run(5 * DAY);
    const scrapped = new Set(line.scrapped.map((p) => p.serial));
    expect(scrapped.size).toBeGreaterThan(0);
    const downstream = events.filter(
      (e) => e.type === 'cycle-complete' && e.machineId === 'wsh-01' && scrapped.has(e.serial),
    );
    expect(downstream).toHaveLength(0);
  });
});

describe('leak test and rework (plan section 3)', () => {
  it('reports readings that follow the normal model with drift (KS on standardized values)', () => {
    const { events, config } = run(20 * DAY);
    const calibrations = events
      .filter((e) => e.type === 'state' && e.machineId === 'lkt-01' && e.cause === 'CALIBRATION')
      .map((e) => e.at);
    const calibrationEnds = calibrations.map(
      (at) => at + config.process.leakTest.calibrationMinutes * MINUTE,
    );
    const leak = config.process.leakTest;
    const standardized = cycles(events, 'lkt-01').flatMap((e) => {
      if (!e.measurement) return [];
      const since = [T0, ...calibrationEnds].filter((t) => t <= e.at).at(-1) ?? T0;
      const drift = (leak.driftPerDay * (e.at - since)) / DAY;
      return [(e.measurement.value - leak.mean - drift) / leak.sigma];
    });
    expect(standardized.length).toBeGreaterThan(5_000);
    expect(ksTest(standardized, normalCdf()).pValue).toBeGreaterThan(0.01);
  });

  it('calibrates every 7 days as planned maintenance', () => {
    const { events } = run(22 * DAY);
    const calibrations = events.flatMap((e) =>
      e.type === 'state' && e.machineId === 'lkt-01' && e.to === 'Maintenance' ? [e.cause] : [],
    );
    expect(calibrations).toEqual(['CALIBRATION', 'CALIBRATION', 'CALIBRATION']);
  });

  it('reworks a part once at OP30 and scraps it on a second leak failure', () => {
    const { events, line } = run(3 * DAY, (c) => {
      c.process.leakTest.upperLimit = c.process.leakTest.mean;
    });
    const byPart = new Map<string, string[]>();
    for (const e of events) {
      if (e.type === 'cycle-complete' && (e.machineId === 'asm-01' || e.machineId === 'lkt-01')) {
        byPart.set(e.serial, [...(byPart.get(e.serial) ?? []), `${e.machineId}:${e.result}`]);
      }
    }
    const histories = new Set([...byPart.values()].map((h) => h.join(' ')));
    expect(histories).toContain('asm-01:good lkt-01:good');
    expect(histories).toContain('asm-01:good lkt-01:rework asm-01:good lkt-01:good');
    expect(histories).toContain('asm-01:good lkt-01:rework asm-01:good lkt-01:scrap');
    for (const history of byPart.values()) {
      expect(history.filter((h) => h === 'lkt-01:rework').length).toBeLessThanOrEqual(1);
    }
    expect(line.scrapped.every((p) => p.serial !== undefined)).toBe(true);
    expect(line.producedParts).toBe(partsAccountedFor(line));
  });

  it('fails between 0.2 % and 3 % of first tests with the default limits', () => {
    const { events } = run(20 * DAY);
    const lkt = cycles(events, 'lkt-01');
    const failed = lkt.filter((e) => e.result !== 'good').length / lkt.length;
    expect(failed).toBeGreaterThan(0.002);
    expect(failed).toBeLessThan(0.03);
  });
});
