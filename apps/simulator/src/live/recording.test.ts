/**
 * Dispatch recording and headless replay (#236, Phase 9 plan P9-09, probe Q2, exit criterion 3,
 * ADR-0037 amendment): a live orders run whose jobs come through `LoadOrder` while it runs (the
 * line's `loadOrder` with the device's guard, the code path the OPC UA method calls) records every
 * accepted job with the point of the run it was accepted at, and the headless run of the recording
 * writes the live event log byte for byte. The OPC UA method itself is driven in
 * `opcua/live-dispatch.test.ts`.
 *
 * Probe Q2 compares three ways to replay a dispatch accepted mid-run: (A) the recorded time only,
 * pre-scheduled in the external lane; (B) the recorded time only, given once every event up to
 * that time has been processed; (C) the recorded time and the number of events processed before
 * the acceptance (`afterEvents`), the shape #236 records. Only (C) equals the live run in every
 * case.
 */
import {
  MAX_RECORDED_ENTRIES,
  parseScenario,
  scenarioPlan,
  type InjectionSpec,
  type PlantConfig,
} from '@shopfloor/plant-config';
import { MINUTE, RandomSource, Simulation, type SimTime } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { scenarioOptions } from '../headless/golden.ts';
import {
  applyDispatches,
  isRecorded,
  runHeadless,
  type DispatchSpec,
  type HeadlessOptions,
} from '../headless/run.ts';
import { EVENT_SCHEMA, isoTime, stableStringify } from '../headless/serialize.ts';
import { planOptions } from '../headless/timeline.ts';
import {
  ProductionLine,
  type LineEvent,
  type LoadOrderResult,
  type PlantEvent,
} from '../plant/line.ts';
import { createLiveRun, type LiveRun } from './run.ts';
import { RecordingTooLargeError, recordScenario, type RecordedScenario } from './recording.ts';
import { ManualClock } from './testing.ts';

const EPOCH = 1_791_000_000;
const WALL = Date.UTC(2026, 9, 16, 12);
const SPEED = 60;

let orders: HeadlessOptions;
let config: PlantConfig;
let dispatches: readonly DispatchSpec[];

beforeAll(async () => {
  orders = await scenarioOptions('orders-01');
  config = orders.config;
  dispatches = orders.dispatches ?? [];
  expect(dispatches.length).toBe(8);
});

const line = (event: PlantEvent, seq: number): string =>
  stableStringify({ ...event, schema: EVENT_SCHEMA, seq, at: isoTime(event.at) });

interface Live {
  readonly run: LiveRun;
  readonly clock: ManualClock;
  readonly lines: string[];
  /** `LoadOrder` as the OPC UA method calls it: the device's epoch and wall clock as the guard. */
  call(
    dispatch: DispatchSpec,
    change?: { deviceEpoch?: number; expiresAt?: number; quantity?: number },
  ): LoadOrderResult;
  /** Runs the paced clock on by `simMs` of simulation time. */
  advance(simMs: number): void;
  /**
   * Runs on, one wall millisecond at a time, until the run stands on the time of the plant event it
   * emitted last: a call now comes after events of its own millisecond.
   */
  advanceToEvent(): void;
}

function live(speed = SPEED): Live {
  const clock = new ManualClock();
  const lines: string[] = [];
  const run = createLiveRun({
    config,
    seed: orders.seed,
    start: orders.start,
    speed,
    clock,
    production: 'orders',
    onEvent: (event) => lines.push(line(event, lines.length + 1)),
  });
  return {
    run,
    clock,
    lines,
    call: (dispatch, change = {}) =>
      run.line.loadOrder(
        dispatch.machine,
        { ...dispatch, deviceEpoch: EPOCH, expiresAt: WALL + 60_000, ...change },
        run.simulation,
        { epoch: EPOCH, wallNow: WALL },
      ),
    advance: (simMs) => {
      clock.advance(Math.ceil(simMs / speed));
    },
    advanceToEvent: () => {
      const last = () => (JSON.parse(lines.at(-1) ?? '{}') as { at?: string }).at;
      for (let i = 0; i < 3_600_000 && last() !== isoTime(run.simulation.now); i++) {
        clock.advance(1);
      }
      expect(last()).toBe(isoTime(run.simulation.now));
    },
  };
}

/** The headless replay of a recording: its event log without the header line. */
function replay(recorded: RecordedScenario): string[] {
  // Through the document as JSON, as `GET /scenario/recorded` serves it and the CLI reads it.
  const parsed = parseScenario(JSON.parse(JSON.stringify(recorded)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const options = planOptions(config, scenarioPlan(parsed.scenario), 'recorded');
  const lines: string[] = [];
  runHeadless(options, (text) => lines.push(text));
  return lines.slice(1);
}

type Strategy = 'external-lane' | 'after-instant' | 'after-events';

/**
 * Probe Q2: the run of a recording with each replay strategy, the start-time dispatches and the
 * injections given as a headless run gives them. Lines as the headless log writes them.
 */
function replayWith(
  recorded: readonly DispatchSpec[],
  injections: readonly InjectionSpec[],
  end: SimTime,
  strategy: Strategy,
): string[] {
  const lines: string[] = [];
  const plant = new ProductionLine({
    config,
    random: new RandomSource(orders.seed),
    startTime: orders.start,
    production: 'orders',
    onEvent: (event) => lines.push(line(event, lines.length + 1)),
  });
  const simulation = new Simulation<LineEvent>(orders.start);
  plant.start(simulation);
  applyDispatches(
    plant,
    simulation,
    recorded.filter((d) => !isRecorded(d)),
  );
  for (const injection of injections) {
    if (injection.kind === 'leak-drift') throw new Error('not in this probe');
    expect(plant.injectFailure(injection, simulation).ok).toBe(true);
  }
  const timed = recorded.filter(isRecorded);
  const handle = (event: LineEvent, sim: Simulation<LineEvent>) => {
    const marker = (event as unknown as { probeDispatch?: number }).probeDispatch;
    if (marker === undefined) {
      plant.handle(event, sim);
      return;
    }
    const dispatch = timed[marker];
    if (!dispatch) throw new Error('unknown marker');
    expect(plant.loadOrder(dispatch.machine, dispatch, sim).ok).toBe(true);
  };
  switch (strategy) {
    case 'external-lane':
      timed.forEach((dispatch, index) => {
        simulation.schedule(
          dispatch.acceptedAt,
          { probeDispatch: index } as unknown as LineEvent,
          'external',
        );
      });
      break;
    case 'after-instant':
      for (const dispatch of timed) {
        simulation.runUntil(dispatch.acceptedAt, handle);
        expect(plant.loadOrder(dispatch.machine, dispatch, simulation).ok).toBe(true);
      }
      break;
    case 'after-events':
      for (const dispatch of timed) {
        while (simulation.processed < dispatch.afterEvents) simulation.step(handle);
        if (simulation.now < dispatch.acceptedAt) simulation.runUntil(dispatch.acceptedAt, handle);
        expect(plant.loadOrder(dispatch.machine, dispatch, simulation).ok).toBe(true);
      }
      break;
  }
  simulation.runUntil(end - 1, handle);
  return lines;
}

/** The recording's dispatches as run options (integer ms), through the scenario schema. */
const recordedDispatches = (recorded: RecordedScenario): DispatchSpec[] => {
  const parsed = parseScenario(JSON.parse(JSON.stringify(recorded)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return [...scenarioPlan(parsed.scenario).dispatches];
};

const ofDispatch = (index: number): DispatchSpec => {
  const dispatch = dispatches[index];
  if (!dispatch) throw new Error(`no dispatch ${String(index)}`);
  return dispatch;
};

/** A copy of a recording without one key (a test of what that key does). */
const without = (recorded: RecordedScenario, key: keyof RecordedScenario): RecordedScenario =>
  Object.fromEntries(
    Object.entries(recorded).filter(([k]) => k !== key),
  ) as unknown as RecordedScenario;

/** The first line where two logs differ, or -1. */
const firstDifference = (a: readonly string[], b: readonly string[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
};

describe('dispatch recording and headless replay (#236)', () => {
  it('replays a live orders run with mid-run, duplicate, refused and same-millisecond LoadOrder calls byte for byte', () => {
    const run = live();
    // Idle at the start: two jobs (written as plain start-time dispatches) and the injections.
    expect(run.call(ofDispatch(0))).toMatchObject({ ok: true, duplicate: false });
    expect(run.call(ofDispatch(1))).toMatchObject({ ok: true, duplicate: false });
    // A call for another run's epoch is refused and changes nothing.
    expect(run.call(ofDispatch(2), { deviceEpoch: EPOCH - 1 })).toMatchObject({
      ok: false,
      code: 'epoch-mismatch',
    });
    for (const injection of orders.injections ?? []) {
      expect(run.run.inject(injection).ok).toBe(true);
    }
    run.run.pacer.start();
    run.advance(40 * MINUTE);
    // Mid-run: accepted, then the same call again (a retried command) answers duplicate.
    expect(run.call(ofDispatch(2))).toMatchObject({ ok: true, duplicate: false });
    expect(run.call(ofDispatch(2))).toMatchObject({ ok: true, duplicate: true });
    // An expired command and a conflicting reuse of a command id are refused.
    expect(run.call(ofDispatch(3), { expiresAt: WALL - 1 })).toMatchObject({
      ok: false,
      code: 'expired',
    });
    expect(run.call(ofDispatch(2), { quantity: 99 })).toMatchObject({
      ok: false,
      code: 'command-conflict',
    });
    run.advance(95 * MINUTE);
    // Two calls in the same millisecond, with no event between them.
    const sameMs = run.run.simulation.now;
    expect(run.call(ofDispatch(3)).ok).toBe(true);
    expect(run.call(ofDispatch(4)).ok).toBe(true);
    // Paused and stepped: a call between two events of one millisecond is possible here.
    run.advance(17 * MINUTE);
    run.run.pacer.pause();
    run.run.pacer.step();
    run.run.pacer.step();
    expect(run.call(ofDispatch(5)).ok).toBe(true);
    // A full queue is refused too (not recorded); the queue holds at most 50 jobs.
    run.run.pacer.resume();
    run.advance(3 * 60 * MINUTE);
    expect(run.call(ofDispatch(6)).ok).toBe(true);
    run.advance(2 * 60 * MINUTE);
    run.run.pacer.pause();

    const recorded = run.run.recorded({ config: 'config/plant' });
    // What was recorded: every accepted job once, in acceptance order, the idle ones plain.
    expect(recorded.production).toBe('orders');
    expect(recorded.end).toBe(isoTime(run.run.simulation.now + 1));
    expect(recorded.dispatches?.map((d) => d.commandId)).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((i) => ofDispatch(i).commandId),
    );
    expect(recorded.dispatches?.slice(0, 2).every((d) => d.acceptedAt === undefined)).toBe(true);
    const [, , mid, same1, same2, stepped] = recorded.dispatches ?? [];
    expect(mid?.afterEvents).toBeGreaterThan(0);
    expect([same1?.acceptedAt, same2?.acceptedAt]).toEqual([isoTime(sameMs), isoTime(sameMs)]);
    expect(same1?.afterEvents).toBe(same2?.afterEvents);
    expect(stepped?.afterEvents).toBeGreaterThan(same2?.afterEvents ?? Infinity);
    expect(recorded.injections).toHaveLength(orders.injections?.length ?? 0);

    const replayed = replay(recorded);
    expect(run.lines.length).toBeGreaterThan(1_000);
    expect(firstDifference(replayed, run.lines)).toBe(-1);
    expect(replayed.join('\n')).toBe(run.lines.join('\n'));
  }, 60_000);

  it('records nothing for a run without jobs or inputs, and its replay is the live log', () => {
    const run = live();
    run.run.pacer.start();
    run.advance(30 * MINUTE);
    run.run.pacer.pause();
    const recorded = run.run.recorded({ config: 'config/plant', stock: 'stock.yaml' });
    expect(recorded).toMatchObject({ production: 'orders', stock: 'stock.yaml', days: 1 });
    expect(recorded.dispatches).toBeUndefined();
    expect(recorded.injections).toBeUndefined();
    expect(recorded.actions).toBeUndefined();
    expect(replay(run.run.recorded({ config: 'config/plant' }))).toEqual(run.lines);
  });

  it('ends the recording after a not yet due input, and the replay still stops where the run stood', () => {
    const run = live();
    expect(run.call(ofDispatch(0)).ok).toBe(true);
    run.run.pacer.start();
    run.advance(20 * MINUTE);
    const lot = config.stock.lots[0]?.id ?? '';
    const later = run.run.simulation.now + 3 * 60 * MINUTE + 7;
    expect(run.run.act({ kind: 'lot-block', lot, at: later }).ok).toBe(true);
    expect(run.call(ofDispatch(1)).ok).toBe(true);
    run.advance(10 * MINUTE);
    run.run.pacer.pause();
    const recorded = run.run.recorded({ config: 'config/plant' });
    expect(recorded.end).toBe(isoTime(later + 1));
    expect(recorded.actions).toEqual([{ kind: 'lot-block', at: isoTime(later), lot }]);
    expect(recorded.endAfterEvents).toBe(run.run.simulation.processed);
    expect(replay(recorded)).toEqual(run.lines);
    // Without the stop the replay runs on to `end`: the live log is only its prefix.
    const longer = replay(without(recorded, 'endAfterEvents'));
    expect(longer.length).toBeGreaterThan(run.lines.length);
    expect(longer.slice(0, run.lines.length)).toEqual(run.lines);
  });

  it('stops exactly where a stepped run stood, an event of that millisecond still due', () => {
    const run = live();
    expect(run.call(ofDispatch(0)).ok).toBe(true);
    run.run.pacer.start();
    run.advance(25 * MINUTE);
    run.run.pacer.pause();
    let steps = 0;
    do {
      run.run.pacer.step();
      steps++;
    } while (run.run.simulation.nextEventTime !== run.run.simulation.now && steps < 5_000);
    expect(run.run.simulation.nextEventTime).toBe(run.run.simulation.now);
    expect(replay(run.run.recorded({ config: 'config/plant' }))).toEqual(run.lines);
  });

  describe('injections and actions in acceptance order (#236 review)', () => {
    /** The replay of a recording without its `inputOrder`: every injection before every action. */
    const groupOrder = (recorded: RecordedScenario): string[] => {
      return replay(without(recorded, 'inputOrder'));
    };

    it('replays a tool breakage then a failure posted at the paused time, in that order', () => {
      const run = live();
      expect(run.call(ofDispatch(0)).ok).toBe(true);
      run.run.pacer.start();
      run.advance(47 * MINUTE);
      run.run.pacer.pause();
      const now = run.run.simulation.now;
      // No event of this millisecond was processed (#235's limit for a post at "now").
      expect(run.lines.some((l) => l.includes(`"at":"${isoTime(now)}"`))).toBe(false);
      expect(run.run.act({ kind: 'tool-breakage', machine: 'cnc-01' }).ok).toBe(true);
      expect(run.run.injectFailure({ machine: 'cnc-01', code: 'SPINDLE-OVERLOAD' }).ok).toBe(true);
      // And two more actions later, one after the other (each list keeps its own order).
      const lot = config.stock.lots[0]?.id ?? '';
      expect(run.run.act({ kind: 'lot-block', lot, at: now + 20 * MINUTE + 3 }).ok).toBe(true);
      expect(run.run.act({ kind: 'lot-release', lot, at: now + 50 * MINUTE + 3 }).ok).toBe(true);
      run.run.pacer.resume();
      run.advance(90 * MINUTE);
      run.run.pacer.pause();
      const recorded = run.run.recorded({ config: 'config/plant' });
      expect(recorded.inputOrder).toEqual(['action', 'injection', 'action', 'action']);
      expect(recorded.actions?.map((a) => a.kind)).toEqual([
        'tool-breakage',
        'lot-block',
        'lot-release',
      ]);
      expect(replay(recorded)).toEqual(run.lines);
      // The order matters here: injections first gives another log.
      expect(firstDifference(groupOrder(recorded), run.lines)).toBeGreaterThanOrEqual(0);
    });

    it("replays a lot block accepted before a drift whose until is the block's time", () => {
      const run = live();
      expect(run.call(ofDispatch(0)).ok).toBe(true);
      run.run.pacer.start();
      run.advance(10 * MINUTE);
      run.run.pacer.pause();
      const now = run.run.simulation.now;
      const at = now + 30 * MINUTE + 11;
      const lot = config.stock.lots[0]?.id ?? '';
      expect(run.run.act({ kind: 'lot-block', lot, at }).ok).toBe(true);
      const drift = run.run.injectLeakDrift({
        machine: 'lkt-01',
        shift: 0.5,
        at: now + 5 * MINUTE + 1,
        until: at,
      });
      expect(drift.ok).toBe(true);
      run.run.pacer.resume();
      run.advance(60 * MINUTE);
      run.run.pacer.pause();
      const recorded = run.run.recorded({ config: 'config/plant' });
      expect(recorded.inputOrder).toEqual(['action', 'injection']);
      expect(replay(recorded)).toEqual(run.lines);
      expect(firstDifference(groupOrder(recorded), run.lines)).toBeGreaterThanOrEqual(0);
    });

    it('keeps failures and drifts in their one numbering when accepted interleaved', () => {
      const run = live();
      expect(run.call(ofDispatch(0)).ok).toBe(true);
      expect(run.call(ofDispatch(1)).ok).toBe(true);
      const t = (minutes: number) => orders.start + minutes * MINUTE + 7;
      expect(
        run.run.injectFailure({
          machine: 'cnc-01',
          code: 'COOLANT-PRESSURE',
          at: t(50),
          repairMs: 4_000,
        }).ok,
      ).toBe(true);
      expect(
        run.run.injectLeakDrift({ machine: 'lkt-01', shift: 0.25, at: t(20), until: t(80) }).ok,
      ).toBe(true);
      expect(
        run.run.injectFailure({ machine: 'cnc-02', code: 'SPINDLE-OVERLOAD', at: t(30) }).ok,
      ).toBe(true);
      run.run.pacer.start();
      run.advance(120 * MINUTE);
      run.run.pacer.pause();
      const recorded = run.run.recorded({ config: 'config/plant' });
      expect(recorded.injections).toEqual([
        { at: isoTime(t(50)), machine: 'cnc-01', code: 'COOLANT-PRESSURE', repairMs: 4_000 },
        {
          kind: 'leak-drift',
          at: isoTime(t(20)),
          until: isoTime(t(80)),
          machine: 'lkt-01',
          shift: 0.25,
        },
        { at: isoTime(t(30)), machine: 'cnc-02', code: 'SPINDLE-OVERLOAD' },
      ]);
      expect(recorded.inputOrder).toBeUndefined();
      expect(replay(recorded)).toEqual(run.lines);
    });
  });

  it('refuses to record a list past MAX_RECORDED_ENTRIES (the route answers 413)', () => {
    const dispatch = {
      ...ofDispatch(0),
      acceptedAt: orders.start,
      afterEvents: 0,
    };
    const input = {
      seed: 1,
      start: orders.start,
      simNow: orders.start,
      production: 'orders' as const,
      configSha256: 'a'.repeat(64),
      config: 'config/plant',
      processed: 0,
      inputOrder: [],
      injections: [],
      drifts: [],
      actions: [],
    };
    expect(() =>
      recordScenario({
        ...input,
        dispatches: Array.from({ length: MAX_RECORDED_ENTRIES }, () => dispatch),
      }),
    ).not.toThrow();
    expect(() =>
      recordScenario({
        ...input,
        dispatches: Array.from({ length: MAX_RECORDED_ENTRIES + 1 }, () => dispatch),
      }),
    ).toThrow(RecordingTooLargeError);
  });

  it('refuses a recording made with another configuration', () => {
    const run = live();
    run.run.pacer.start();
    run.advance(5 * MINUTE);
    run.run.pacer.pause();
    const recorded = run.run.recorded({ config: 'config/plant' });
    expect(() => replay({ ...recorded, configSha256: '0'.repeat(64) })).toThrow(
      /configSha256: the recording was made with configuration 0{64}, this configuration is [0-9a-f]{64}/,
    );
  });

  describe('probe Q2: which recorded shape replays a mid-run dispatch', () => {
    it('only the time with the event count equals the live run in every case', () => {
      // Case 1, running at 60x: the paced clock between ticks rarely stands on an event's time.
      const running = live();
      expect(running.call(ofDispatch(0)).ok).toBe(true);
      running.run.pacer.start();
      for (const index of [1, 2, 3, 4, 5]) {
        running.advance(41 * MINUTE);
        expect(running.call(ofDispatch(index)).ok).toBe(true);
      }
      running.advance(60 * MINUTE);
      running.run.pacer.pause();
      // Case 2, running at 1x: a tick fires at the next event's time, so a call between ticks
      // comes right after the events of its own millisecond.
      const onEvent = live(1);
      expect(onEvent.call(ofDispatch(0)).ok).toBe(true);
      onEvent.run.pacer.start();
      for (const index of [1, 2, 3]) {
        onEvent.advance(23 * MINUTE);
        onEvent.advanceToEvent();
        expect(onEvent.call(ofDispatch(index)).ok).toBe(true);
      }
      onEvent.advance(30 * MINUTE);
      onEvent.run.pacer.pause();
      // Case 3, stepped: paused and stepped to a millisecond with another event still due in it.
      const stepped = live();
      expect(stepped.call(ofDispatch(0)).ok).toBe(true);
      expect(stepped.call(ofDispatch(1)).ok).toBe(true);
      stepped.run.pacer.start();
      stepped.advance(30 * MINUTE);
      stepped.run.pacer.pause();
      let steps = 0;
      do {
        stepped.run.pacer.step();
        steps++;
      } while (
        stepped.run.simulation.nextEventTime !== stepped.run.simulation.now &&
        steps < 5_000
      );
      expect(stepped.run.simulation.nextEventTime).toBe(stepped.run.simulation.now);
      expect(stepped.call(ofDispatch(2)).ok).toBe(true);
      stepped.run.pacer.resume();
      stepped.advance(2 * 60 * MINUTE);
      stepped.run.pacer.pause();

      const outcomes = [running, onEvent, stepped].map((run) => {
        const recorded = run.run.recorded({ config: 'config/plant' });
        const timed = recordedDispatches(recorded);
        const end = run.run.simulation.now + 1;
        return Object.fromEntries(
          (['external-lane', 'after-instant', 'after-events'] as const).map((strategy) => [
            strategy,
            firstDifference(replayWith(timed, [], end, strategy), run.lines),
          ]),
        );
      });
      // -1: the replay equals the live log; otherwise the first line that differs.
      expect(outcomes.map((o) => Object.values(o).map((d) => d >= 0))).toEqual([
        // Off event times every shape works.
        [false, false, false],
        // (A) The external lane runs the dispatch before the events of its millisecond the live
        // run had processed before the call: wrong once a call stands on an event's time.
        [true, false, false],
        // (B) After every event of the time: wrong after a step left one of that millisecond.
        [true, true, false],
      ]);
      // (C) The time and the event count, through the headless run itself: right in every case.
      for (const run of [running, onEvent, stepped]) {
        expect(replay(run.run.recorded({ config: 'config/plant' }))).toEqual(run.lines);
      }
    }, 60_000);
  });

  describe('a recording that does not fit the run is refused, never replayed differently', () => {
    const base = (): DispatchSpec & { acceptedAt: SimTime; afterEvents: number } => ({
      ...ofDispatch(0),
      acceptedAt: orders.start + 30 * MINUTE,
      afterEvents: 10,
    });
    const options = (list: readonly DispatchSpec[]): HeadlessOptions => ({
      config,
      seed: orders.seed,
      start: orders.start,
      end: orders.start + 60 * MINUTE,
      production: 'orders',
      // A start-time job, so the run has events in its first hour.
      dispatches: [ofDispatch(1), ...list],
    });
    const run = (list: readonly DispatchSpec[]) => () =>
      runHeadless(options(list), () => undefined);

    it('refuses an event count the run reaches only after the recorded time', () => {
      expect(run([{ ...base(), afterEvents: 1_000_000 }])).toThrow(/does not fit this run/);
    });

    it('refuses an event count the run has passed before the recorded time', () => {
      expect(run([{ ...base(), afterEvents: 0 }])).toThrow(/does not fit this run/);
    });

    it('refuses recorded dispatches out of acceptance order, or before a start-time one', () => {
      const later = { ...ofDispatch(3), acceptedAt: orders.start + 20 * MINUTE, afterEvents: 5 };
      expect(run([base(), later])).toThrow(/acceptance order/);
      expect(run([base(), ofDispatch(2)])).toThrow(/before every recorded dispatch/);
      expect(run([{ ...base(), acceptedAt: orders.start + 2 * 60 * MINUTE }])).toThrow(
        /outside the run/,
      );
      expect(run([{ ...ofDispatch(0), afterEvents: 3 }])).toThrow(
        /both acceptedAt and afterEvents/,
      );
    });

    it('refuses a duplicate recorded command', () => {
      const first = { ...base(), afterEvents: 0, acceptedAt: orders.start };
      expect(run([first, { ...first }])).toThrow(/listed twice/);
    });
  });
});
