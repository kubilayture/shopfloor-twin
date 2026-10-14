import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductionLine, type LineEvent, type PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { runScenario, scenarioNames } from './golden.ts';
import { InvariantChecker, InvariantViolation } from './invariants.ts';
import { runHeadless } from './run.ts';

const MONDAY = Date.UTC(2026, 9, 12, 3);
const SATURDAY = MONDAY + 5 * 24 * HOUR;
let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

function partialRun(hours: number) {
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(3),
    startTime: MONDAY,
    onEvent: (e) => events.push(e),
  });
  const checker = new InvariantChecker(line, config, MONDAY);
  const simulation = new Simulation<LineEvent>(MONDAY);
  line.start(simulation);
  simulation.runUntil(MONDAY + hours * HOUR, (event, sim) => {
    line.handle(event, sim);
  });
  events.forEach((e) => {
    checker.record(e);
  });
  return { line, checker, now: simulation.now };
}

describe('invariants at every simulation step (plan section 4, exit criterion 2)', () => {
  it.each([1, 2, 3])(
    'hold over the 5-day production week, Monday 06:00 to Saturday 06:00, with seed %s',
    (seed) => {
      const result = runHeadless(
        { config, seed, start: MONDAY, end: SATURDAY, checkInvariants: true },
        () => undefined,
      );
      expect(result.invariantChecks).toBeGreaterThan(10_000);
    },
  );

  it('passes on an untouched run', () => {
    const { checker, now } = partialRun(6);
    expect(() => {
      checker.check(now);
    }).not.toThrow();
  });

  it('detects a lost part', () => {
    const { line, checker, now } = partialRun(6);
    line.finished.pop();
    expect(() => {
      checker.check(now);
    }).toThrow(InvariantViolation);
  });

  it('detects time accounting that does not add up', () => {
    const { line, now } = partialRun(6);
    const shifted = new InvariantChecker(line, config, MONDAY + 1);
    expect(() => {
      shifted.check(now);
    }).toThrow(/time in states/);
  });

  it('detects a material unit that was consumed without an event', () => {
    const { line, checker, now } = partialRun(6);
    line.inventory.consume('SK-1');
    expect(() => {
      checker.check(now);
    }).toThrow(/lot SK1-2610-01/);
  });
});

describe('golden scenarios (plan section 9)', () => {
  it('has at least one scenario and runs it deterministically', async () => {
    const names = scenarioNames();
    expect(names).toContain('week-01');
    const [a, b] = await Promise.all([runScenario('week-01'), runScenario('week-01')]);
    expect(b).toEqual(a);
    expect(a.events).toMatch(/^[0-9a-f]{64} {2}\d+ lines\n$/);
  });
});
