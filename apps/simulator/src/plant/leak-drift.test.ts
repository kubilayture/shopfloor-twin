/**
 * The leak-test drift injection (#196, Phase 8 plan "Leak drift injection and scenario stock",
 * ADR-0033): a bounded sensor fault that adds `shift` to LKT-01's readings from `at` until `until`
 * or the next calibration. It draws no random number, so the run before `at` is the run without
 * it, and every reading inside the drift is the reading without it plus exactly `shift`.
 */
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { InvariantChecker } from '../headless/invariants.ts';
import {
  ProductionLine,
  type InjectDriftRequest,
  type InjectDriftResult,
  type LineEvent,
  type PlantEvent,
} from './line.ts';
import { loadDefaultConfig } from './testing.ts';

const START = Date.UTC(2026, 9, 12, 3);
const SEED = 20261012;
const SHIFT_STEPS = 600;

let defaults: PlantConfig;

beforeAll(async () => {
  defaults = await loadDefaultConfig();
});

interface Simulated {
  readonly events: PlantEvent[];
  readonly line: ProductionLine;
  readonly results: InjectDriftResult[];
}

function simulate(
  config: PlantConfig,
  drifts: readonly InjectDriftRequest[],
  until: SimTime,
  runEnd?: SimTime,
): Simulated {
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(SEED),
    startTime: START,
    onEvent: (event) => {
      events.push(event);
      checker.record(event);
    },
  });
  const checker = new InvariantChecker(line, config, START);
  const simulation = new Simulation<LineEvent>(START);
  line.start(simulation);
  const results = drifts.map((drift) => line.injectLeakDrift(drift, simulation, runEnd));
  simulation.runUntil(until, (event, sim) => {
    line.handle(event, sim);
    checker.check(sim.now);
  });
  return { events, line, results };
}

type Cycle = Extract<PlantEvent, { type: 'cycle-complete' }>;
type DriftLine = Extract<PlantEvent, { type: 'leak-drift' }>;

const readings = (events: readonly PlantEvent[]): Cycle[] =>
  events.filter((e): e is Cycle => e.type === 'cycle-complete' && e.measurement !== undefined);

const driftLines = (events: readonly PlantEvent[]): DriftLine[] =>
  events.filter((e): e is DriftLine => e.type === 'leak-drift');

const steps = (value: number): number => Math.round(value / 0.001);

describe('leak-drift injection (#196, ADR-0033)', () => {
  it('shifts exactly the readings between applied and ended, and changes no draw', () => {
    // No reading can fail, so the drifted run makes the same parts as the plain one.
    const config = structuredClone(defaults);
    config.process.leakTest.upperLimit = 1_000;
    const at = START + 2 * HOUR + 17 * MINUTE;
    const until = START + 5 * HOUR + 3 * MINUTE;
    const end = START + 8 * HOUR - 1;
    const plain = simulate(config, [], end);
    const drifted = simulate(config, [{ machine: 'lkt-01', shift: 0.6, at, until }], end);
    expect(drifted.results).toEqual([
      {
        ok: true,
        drift: { id: 1, machine: 'lkt-01', shift: 0.6, at, until, status: 'scheduled' },
      },
    ]);
    // The same events but the readings' values.
    const shape = (events: readonly PlantEvent[]) =>
      events
        .filter((e) => e.type !== 'leak-drift')
        .map((e) =>
          e.type === 'cycle-complete' && e.measurement
            ? { ...e, measurement: { ...e.measurement, value: 0 } }
            : e,
        );
    expect(shape(drifted.events)).toEqual(shape(plain.events));
    expect(driftLines(drifted.events)).toEqual([
      {
        type: 'leak-drift',
        at,
        machineId: 'lkt-01',
        injection: 1,
        transition: 'applied',
        shift: 0.6,
      },
      {
        type: 'leak-drift',
        at: until,
        machineId: 'lkt-01',
        injection: 1,
        transition: 'ended',
        shift: 0.6,
        endedBy: 'until',
      },
    ]);
    const a = readings(plain.events);
    const b = readings(drifted.events);
    expect(b.length).toBe(a.length);
    const inside = b.filter((r) => r.at >= at && r.at < until).length;
    expect(inside).toBeGreaterThan(20);
    b.forEach((reading, i) => {
      const before = a[i]?.measurement?.value ?? Number.NaN;
      const after = reading.measurement?.value ?? Number.NaN;
      const active = reading.at >= at && reading.at < until;
      expect(steps(after) - steps(before)).toBe(active ? SHIFT_STEPS : 0);
    });
    expect(drifted.line.drifts()).toEqual([
      {
        id: 1,
        machine: 'lkt-01',
        shift: 0.6,
        at,
        until,
        status: 'ended',
        appliedAt: at,
        endedAt: until,
        endedBy: 'until',
      },
    ]);
  });

  it('is identical to the run without it up to its start, then fails more parts', () => {
    const at = START + 2 * HOUR + 17 * MINUTE;
    const end = START + 8 * HOUR - 1;
    const plain = simulate(defaults, [], end);
    const drifted = simulate(
      defaults,
      [{ machine: 'lkt-01', shift: 1.2, at, until: START + 7 * HOUR }],
      end,
    );
    const before = (events: readonly PlantEvent[]) => events.filter((e) => e.at < at);
    expect(before(drifted.events)).toEqual(before(plain.events));
    const failed = (events: readonly PlantEvent[]) =>
      readings(events).filter((r) => r.result !== 'good').length;
    expect(failed(drifted.events)).toBeGreaterThan(failed(plain.events));
  });

  it('writes no ended line for a drift still active at the end of the run', () => {
    const at = START + HOUR + 1;
    const end = START + 3 * HOUR;
    const drifted = simulate(
      defaults,
      [{ machine: 'lkt-01', shift: 0.3, at, until: end }],
      end - 1,
      end,
    );
    expect(driftLines(drifted.events).map((e) => e.transition)).toEqual(['applied']);
    expect(drifted.line.drifts()[0]?.status).toBe('active');
  });

  it('ends at the start of a calibration before until', () => {
    // A calibration every 1.2 hours; the first one falls inside the drift.
    const config = structuredClone(defaults);
    config.process.leakTest.calibrationIntervalDays = 0.05;
    const at = START + 30 * MINUTE;
    const until = START + 6 * HOUR + 1;
    const drifted = simulate(
      config,
      [{ machine: 'lkt-01', shift: -0.25, at, until }],
      until + HOUR,
    );
    const lines = driftLines(drifted.events);
    expect(lines.map((e) => [e.transition, e.endedBy])).toEqual([
      ['applied', undefined],
      ['ended', 'calibration'],
    ]);
    const ended = lines[1];
    const index = drifted.events.indexOf(ended as PlantEvent);
    // At the calibration's start: the next event is LKT-01 entering Maintenance CALIBRATION.
    expect(drifted.events[index + 1]).toMatchObject({
      type: 'state',
      machineId: 'lkt-01',
      to: 'Maintenance',
      cause: 'CALIBRATION',
      at: ended?.at,
    });
    expect(ended?.at).toBeLessThan(until);
    // Readings after the calibration carry no shift; its until does nothing more.
    const after = readings(drifted.events).filter((r) => r.at > (ended?.at ?? 0));
    expect(after.length).toBeGreaterThan(0);
    expect(drifted.line.drifts()[0]).toMatchObject({
      status: 'ended',
      endedBy: 'calibration',
      endedAt: ended?.at,
    });
  });

  it('adds overlapping drifts up, and one calibration ends them all', () => {
    // A calibration every 1.2 hours; readings can't fail, so both runs make the same parts.
    const config = structuredClone(defaults);
    config.process.leakTest.calibrationIntervalDays = 0.05;
    config.process.leakTest.upperLimit = 1_000;
    const first = {
      machine: 'lkt-01',
      shift: 0.3,
      at: START + 10 * MINUTE,
      until: START + 5 * HOUR + 1,
    };
    const second = {
      machine: 'lkt-01',
      shift: 0.2,
      at: START + 40 * MINUTE,
      until: START + 5 * HOUR + 1,
    };
    const end = START + 3 * HOUR;
    const plain = simulate(config, [], end);
    const drifted = simulate(config, [first, second], end);
    const lines = driftLines(drifted.events);
    expect(lines.map((e) => [e.injection, e.transition, e.endedBy])).toEqual([
      [1, 'applied', undefined],
      [2, 'applied', undefined],
      [1, 'ended', 'calibration'],
      [2, 'ended', 'calibration'],
    ]);
    const calibration = lines[2]?.at ?? 0;
    expect(lines[3]?.at).toBe(calibration);
    expect(calibration).toBeLessThan(first.until);
    const a = readings(plain.events);
    const b = readings(drifted.events);
    expect(b.length).toBe(a.length);
    // The cycle that frees the tester for its calibration ends at the calibration's instant,
    // before it starts, so its reading still carries the drift.
    const expected = (at: number): number =>
      at > calibration ? 0 : at >= second.at ? 500 : at >= first.at ? 300 : 0;
    expect(b.filter((r) => r.at >= second.at && r.at < calibration).length).toBeGreaterThan(5);
    b.forEach((reading, i) => {
      const delta = steps(reading.measurement?.value ?? 0) - steps(a[i]?.measurement?.value ?? 0);
      expect(delta).toBe(expected(reading.at));
    });
    expect(drifted.line.drifts().map((d) => [d.status, d.endedBy])).toEqual([
      ['ended', 'calibration'],
      ['ended', 'calibration'],
    ]);
  });

  it('survives the calibration it is applied in, and ends at the next one', () => {
    const config = structuredClone(defaults);
    config.process.leakTest.calibrationIntervalDays = 0.05;
    config.process.leakTest.upperLimit = 1_000;
    const end = START + 5 * HOUR;
    const plain = simulate(config, [], end);
    const calibrations = plain.events.filter(
      (e) => e.type === 'state' && e.machineId === 'lkt-01' && e.to === 'Maintenance',
    );
    const during = calibrations[0];
    expect(during).toBeDefined();
    // Five minutes into the first calibration (20 minutes long).
    const at = (during?.at ?? 0) + 5 * MINUTE + 1;
    const drifted = simulate(
      config,
      [{ machine: 'lkt-01', shift: 0.4, at, until: START + 7 * HOUR + 1 }],
      end,
    );
    const lines = driftLines(drifted.events);
    expect(lines.map((e) => [e.transition, e.endedBy])).toEqual([
      ['applied', undefined],
      ['ended', 'calibration'],
    ]);
    expect(lines[0]?.at).toBe(at);
    const next = calibrations.find((c) => c.at > at);
    expect(lines[1]?.at).toBe(next?.at);
    const a = readings(plain.events);
    const b = readings(drifted.events);
    expect(b.filter((r) => r.at > at && r.at < (next?.at ?? 0)).length).toBeGreaterThan(5);
    b.forEach((reading, i) => {
      const delta = steps(reading.measurement?.value ?? 0) - steps(a[i]?.measurement?.value ?? 0);
      expect(delta).toBe(reading.at >= at && reading.at <= (next?.at ?? 0) ? 400 : 0);
    });
  });

  it('numbers drifts with the failure injections, in acceptance order', () => {
    const line = new ProductionLine({
      config: defaults,
      random: new RandomSource(SEED),
      startTime: START,
    });
    const simulation = new Simulation<LineEvent>(START);
    line.start(simulation);
    const failure = line.injectFailure(
      { machine: 'cnc-01', code: 'COOLANT-PRESSURE', at: START + HOUR },
      simulation,
    );
    const drift = line.injectLeakDrift(
      { machine: 'lkt-01', shift: 0.6, at: START + HOUR, until: START + 2 * HOUR },
      simulation,
    );
    const second = line.injectFailure(
      { machine: 'cnc-02', code: 'SPINDLE-OVERLOAD', at: START + HOUR },
      simulation,
    );
    expect([failure, drift, second].map((r) => r.ok)).toEqual([true, true, true]);
    expect(line.injections().map((i) => i.id)).toEqual([1, 3]);
    expect(line.drifts().map((d) => d.id)).toEqual([2]);
  });

  it('refuses another machine, a bad shift, a time in the past and a calendar boundary', () => {
    const line = new ProductionLine({
      config: defaults,
      random: new RandomSource(SEED),
      startTime: START,
    });
    const simulation = new Simulation<LineEvent>(START);
    line.start(simulation);
    simulation.runUntil(START + HOUR, (event, sim) => {
      line.handle(event, sim);
    });
    const code = (request: InjectDriftRequest) => {
      const result = line.injectLeakDrift(request, simulation);
      return result.ok ? 'ok' : result.code;
    };
    const until = START + 3 * HOUR + 1;
    expect(code({ machine: 'asm-01', shift: 0.6, until })).toBe('not-a-leak-tester');
    expect(code({ machine: 'lkt-01', shift: 0.0004, until })).toBe('invalid-shift');
    expect(code({ machine: 'lkt-01', shift: 0.6, at: START + 1, until })).toBe('in-the-past');
    expect(code({ machine: 'lkt-01', shift: 0.6, until: START + 4 * HOUR })).toBe(
      'calendar-boundary',
    );
    expect(code({ machine: 'lkt-01', shift: 0.6, until })).toBe('ok');
    expect(line.drifts()).toHaveLength(1);
    expect(line.drifts()[0]?.at).toBe(simulation.now);
  });
});
