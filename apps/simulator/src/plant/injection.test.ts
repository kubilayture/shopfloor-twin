/**
 * Failure injection (#140, Phase 6 plan "Fault injection"): an injection takes effect only while
 * the machine is Running; otherwise it is held and applied where the machine would next enter
 * Running, straight to Down. One test per state compares the injected run with the same run
 * without the injection: identical up to that instant, one breakdown exactly there, no Running
 * interval of zero length, and the invariant checker passes throughout.
 */
import { isCalendarBoundary, type PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { InvariantChecker } from '../headless/invariants.ts';
import {
  ProductionLine,
  type InjectFailureRequest,
  type InjectFailureResult,
  type LineEvent,
  type PlantEvent,
} from './line.ts';
import type { MachineState } from './machine-state.ts';
import { loadDefaultConfig } from './testing.ts';

const START = Date.UTC(2026, 9, 12, 3);
const DAY = 24 * HOUR;
const SEED = 20261012;
const REPAIR_MS = 90_000;

let config: PlantConfig;

interface Simulated {
  readonly events: PlantEvent[];
  readonly line: ProductionLine;
  readonly results: InjectFailureResult[];
}

/** A plant and a start: the default plant from Monday 06:00 Istanbul unless a test needs another. */
interface Variant {
  readonly config: PlantConfig;
  readonly start: SimTime;
}

function simulate(
  injections: readonly InjectFailureRequest[],
  until: SimTime,
  checkInvariants = false,
  variant: Variant = { config, start: START },
): Simulated {
  const events: PlantEvent[] = [];
  let checker: InvariantChecker | undefined;
  const line = new ProductionLine({
    config: variant.config,
    random: new RandomSource(SEED),
    startTime: variant.start,
    onEvent: (event) => {
      events.push(event);
      checker?.record(event);
    },
  });
  if (checkInvariants) {
    checker = new InvariantChecker(line, variant.config, variant.start);
  }
  const simulation = new Simulation<LineEvent>(variant.start);
  line.start(simulation);
  const results = injections.map((injection) => line.injectFailure(injection, simulation));
  simulation.runUntil(until, (event, sim) => {
    line.handle(event, sim);
    checker?.check(sim.now);
  });
  return { events, line, results };
}

type StateEvent = Extract<PlantEvent, { type: 'state' }>;

const stateEvents = (events: readonly PlantEvent[], machine: string): StateEvent[] =>
  events.filter((e): e is StateEvent => e.type === 'state' && e.machineId === machine);

/** Every machine's state intervals in a run: [from, to) per state entry. */
/** A machine's state intervals in a run, from its start (every machine starts Off). */
function intervals(events: readonly PlantEvent[], machine: string, start = START) {
  const changes = stateEvents(events, machine);
  const initial = { state: 'Off' as MachineState, from: start, to: changes[0]?.at ?? Infinity };
  return [
    ...(initial.to > start ? [initial] : []),
    ...changes.map((change, i) => ({
      state: change.to,
      from: change.at,
      to: changes[i + 1]?.at ?? Number.POSITIVE_INFINITY,
    })),
  ];
}

const isInjection = (event: PlantEvent): boolean =>
  event.type === 'injection-held' || event.type === 'injection-applied';

/** A Running interval of zero length: entered and left in the same millisecond. */
function zeroLengthRunning(events: readonly PlantEvent[]): StateEvent[] {
  const machines = new Set(events.flatMap((e) => (e.type === 'state' ? [e.machineId] : [])));
  return [...machines].flatMap((machine) => {
    const changes = stateEvents(events, machine);
    return changes.filter(
      (change, i) => change.to === 'Running' && changes[i + 1]?.at === change.at,
    );
  });
}

let reference: PlantEvent[];

beforeAll(async () => {
  config = await loadDefaultConfig();
  reference = simulate([], START + 2 * DAY).events;
}, 60_000);

const MACHINES = ['cnc-01', 'cnc-02', 'wsh-01', 'asm-01', 'lkt-01', 'pck-01'];

/** The first interval of `state` after `from`, on any machine (every one has a failure mode). */
function findInterval(state: MachineState, events = reference, from = START + HOUR) {
  for (const machine of MACHINES) {
    const found = intervals(events, machine, Math.min(from, START)).find(
      (interval) =>
        interval.state === state &&
        interval.from >= from &&
        interval.to - interval.from >= 4 &&
        Number.isFinite(interval.to),
    );
    if (found) {
      return { machine, ...found };
    }
  }
  throw new Error(`no ${state} interval in the reference run`);
}

/**
 * The runs a state needs: Off is the weekend before the golden Monday (the run starts on Sunday
 * 06:00 Istanbul, every machine Off until Monday 06:00); Maintenance is LKT-01's calibration,
 * due daily in this variant instead of weekly. Every other state comes from the default run.
 */
function variantFor(state: MachineState): Variant {
  if (state === 'Off') {
    return { config, start: START - DAY };
  }
  if (state === 'Maintenance') {
    const daily = structuredClone(config);
    daily.process.leakTest.calibrationIntervalDays = 1;
    return { config: daily, start: START };
  }
  return { config, start: START };
}

describe('failure injection per state (#140)', () => {
  it.each<MachineState>([
    'Running',
    'Stopped',
    'Starved',
    'Blocked',
    'Setup',
    'Down',
    'PlannedStop',
    'Off',
    'Maintenance',
  ])('injected in %s: one breakdown, exactly where the machine would enter Running', (state) => {
    const variant = variantFor(state);
    const plain =
      variant.config === config && variant.start === START
        ? reference
        : simulate([], START + 2 * DAY, false, variant).events;
    const interval = findInterval(
      state,
      plain,
      variant.start === START ? START + HOUR : START - DAY,
    );
    const { machine } = interval;
    let at = interval.from + Math.floor((interval.to - interval.from) / 2);
    while (isCalendarBoundary(config, at)) {
      at += 1;
    }
    const code = config.failures.equipment[machine]?.failureModes[0]?.code ?? '';
    // Where the plain run first enters Running at or after the injection.
    const enters =
      state === 'Running'
        ? at
        : stateEvents(plain, machine).find((e) => e.to === 'Running' && e.at >= at)?.at;
    if (enters === undefined) {
      throw new Error(`${machine} never runs again after ${new Date(at).toISOString()}`);
    }

    const injected = simulate(
      [{ machine, code, at, repairMs: REPAIR_MS }],
      enters + 3 * HOUR,
      true,
      variant,
    );
    expect(injected.results[0]?.ok).toBe(true);

    // Identical to the plain run up to that instant (the held event aside).
    const before = (events: readonly PlantEvent[]) =>
      events.filter((e) => e.at < enters && !isInjection(e));
    expect(before(injected.events)).toEqual(before(plain));

    // Held unless Running, then applied once, at that instant.
    const own = injected.events.filter((e) => 'machineId' in e && e.machineId === machine);
    expect(own.filter((e) => e.type === 'injection-held').map((e) => e.at)).toEqual(
      state === 'Running' ? [] : [at],
    );
    expect(own.filter((e) => e.type === 'injection-applied').map((e) => e.at)).toEqual([enters]);
    expect(injected.line.injections()).toEqual([
      {
        id: 1,
        machine,
        code,
        at,
        repairMs: REPAIR_MS,
        status: 'applied',
        appliedAt: enters,
        ...(state === 'Running' ? {} : { heldAt: at }),
      },
    ]);

    // Straight to Down with the code: no Running at that instant, one raise, one clear.
    const atEnters = stateEvents(injected.events, machine).filter((e) => e.at === enters);
    // From the state the plain run left for Running there (Down → Down after a natural repair).
    const plainEntry = stateEvents(plain, machine).find(
      (e) => e.at === enters && e.to === 'Running',
    );
    expect(atEnters.at(-1)).toMatchObject({
      to: 'Down',
      cause: code,
      from: state === 'Running' ? 'Running' : plainEntry?.from,
    });
    if (state === 'Down') {
      expect(atEnters.at(-1)?.from).toBe('Down');
    }
    expect(atEnters.some((e) => e.to === 'Running')).toBe(false);
    const alarms = own.filter(
      (e): e is Extract<PlantEvent, { type: 'alarm' }> => e.type === 'alarm' && e.code === code,
    );
    const raised = alarms.filter((e) => e.transition === 'active' && e.at >= at);
    expect(raised.map((e) => e.at)).toEqual([enters]);
    const cleared = alarms.find((e) => e.transition === 'cleared' && e.at > enters);
    expect(cleared?.at).toBeGreaterThanOrEqual(enters + REPAIR_MS);

    expect(zeroLengthRunning(injected.events)).toEqual([]);
  });
});

describe('failure injection mechanics (#140)', () => {
  it('applies several held injections in order, one per entry to Running (Down → Down)', () => {
    const interval = findInterval('Starved');
    const { machine } = interval;
    const at = interval.from + 1;
    const [first, second] = config.failures.equipment[machine]?.failureModes ?? [];
    const codes = [first?.code ?? '', second?.code ?? first?.code ?? ''];
    const { events, line } = simulate(
      codes.map((code) => ({ machine, code, at, repairMs: 30_000 })),
      at + 6 * HOUR,
      true,
    );
    const [one, two] = line.injections();
    expect(one?.status).toBe('applied');
    expect(two?.status).toBe('applied');
    const firstAt = one?.appliedAt ?? 0;
    // The second takes effect at the end of the first repair: the machine stays Down.
    const downs = stateEvents(events, machine).filter(
      (e) => e.to === 'Down' && e.at >= firstAt && e.at <= (two?.appliedAt ?? 0),
    );
    expect(downs.map((e) => [e.from, e.cause])).toEqual([
      [expect.any(String), codes[0]],
      ['Down', codes[1]],
    ]);
    expect(two?.appliedAt).toBeGreaterThanOrEqual(firstAt + 30_000);
    expect(zeroLengthRunning(events)).toEqual([]);
  });

  it('repairs an injected failure in exactly repairMs when a technician is free', () => {
    const machine = 'cnc-01';
    const running = intervals(reference, machine).find(
      (i) => i.state === 'Running' && i.from >= START + HOUR && i.to - i.from > 10_000,
    );
    if (!running) throw new Error('no running interval');
    const when = running.from + 5_000;
    const run = simulate(
      [{ machine, code: 'COOLANT-PRESSURE', at: when, repairMs: 2_345 }],
      when + HOUR,
    );
    const repairs = run.events.filter(
      (e) => (e.type === 'repair-start' || e.type === 'repair-end') && e.machineId === machine,
    );
    expect(repairs.slice(0, 2).map((e) => [e.type, e.at - when])).toEqual([
      ['repair-start', 0],
      ['repair-end', 2_345],
    ]);
  });

  it('refuses an unknown machine or code, a bad repair time, the past and calendar boundaries', () => {
    const line = new ProductionLine({ config, random: new RandomSource(1), startTime: START });
    const simulation = new Simulation<LineEvent>(START);
    line.start(simulation);
    simulation.runUntil(START + 10 * MINUTE, (event, sim) => {
      line.handle(event, sim);
    });
    const later = START + 20 * MINUTE + 7;
    const codeOf = (request: InjectFailureRequest) => {
      const result = line.injectFailure(request, simulation);
      return result.ok ? 'ok' : result.code;
    };
    expect(codeOf({ machine: 'cnc-09', code: 'COOLANT-PRESSURE', at: later })).toBe(
      'unknown-machine',
    );
    expect(codeOf({ machine: 'cnc-01', code: 'PRINTER-FAULT', at: later })).toBe('unknown-code');
    expect(codeOf({ machine: 'cnc-01', code: 'COOLANT-PRESSURE', at: later, repairMs: 0 })).toBe(
      'invalid-repair',
    );
    expect(codeOf({ machine: 'cnc-01', code: 'COOLANT-PRESSURE', at: later, repairMs: 1.5 })).toBe(
      'invalid-repair',
    );
    expect(codeOf({ machine: 'cnc-01', code: 'COOLANT-PRESSURE', at: START + MINUTE })).toBe(
      'in-the-past',
    );
    // 10:00 Istanbul on Monday: shift A's break starts.
    expect(codeOf({ machine: 'cnc-01', code: 'COOLANT-PRESSURE', at: START + 4 * HOUR })).toBe(
      'calendar-boundary',
    );
    expect(line.injections()).toEqual([]);
    // Without a time it is due now, at the next step.
    const now = line.injectFailure({ machine: 'cnc-01', code: 'COOLANT-PRESSURE' }, simulation);
    expect(now).toMatchObject({ ok: true, injection: { id: 1, at: START + 10 * MINUTE } });
    expect(line.injections()).toEqual([
      {
        id: 1,
        machine: 'cnc-01',
        code: 'COOLANT-PRESSURE',
        at: START + 10 * MINUTE,
        status: 'scheduled',
      },
    ]);
  });
});
