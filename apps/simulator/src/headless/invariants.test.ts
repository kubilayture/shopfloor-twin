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

function partialRun(
  hours: number,
  keep: (event: PlantEvent, index: number) => boolean = () => true,
) {
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
  return {
    line,
    checker,
    now: simulation.now,
    events,
    feed: () => {
      for (const event of events.filter(keep)) {
        checker.record(event);
      }
    },
  };
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
    const { checker, now, feed } = partialRun(6);
    feed();
    expect(() => {
      checker.check(now);
    }).not.toThrow();
  });

  it('detects a lost part', () => {
    const { line, checker, now, feed } = partialRun(6);
    feed();
    line.finished.pop();
    expect(() => {
      checker.check(now);
    }).toThrow(/was started but is nowhere/);
  });

  it('detects a part that is in two places, even when the count still matches', () => {
    const { line, checker, now, feed } = partialRun(6);
    feed();
    const [first] = line.finished;
    line.finished.pop();
    if (first) line.finished.push(first);
    expect(() => {
      checker.check(now);
    }).toThrow(/is both in finished and in finished|was started but is nowhere/);
  });

  it('detects a state change the machine made but the event log never got', () => {
    const { checker, now, feed, events } = partialRun(6, (event, index) => index !== 50);
    expect(events[50]?.type).toBe('state');
    expect(() => {
      feed();
      checker.check(now);
    }).toThrow(InvariantViolation);
  });

  it('detects time charged to the wrong state', () => {
    const { checker, now, feed } = partialRun(
      6,
      (event) => event.type !== 'state' || event.to !== 'Stopped',
    );
    expect(() => {
      feed();
      checker.check(now);
    }).toThrow(/in the machine but .* in the event log|the event log had it in/);
  });

  it('detects a material unit that was consumed without an event', () => {
    const { line, checker, now, feed } = partialRun(6);
    feed();
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
    const a = await runScenario('week-01');
    const b = await runScenario('week-01');
    expect(b).toEqual(a);
    expect(a.events).toMatch(/^[0-9a-f]{64} {2}\d+ lines\n$/);
  });
});
