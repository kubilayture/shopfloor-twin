/**
 * Live playback of scenario timelines (#235, Phase 9 exit criterion 3, ADR-0037): a timeline with
 * every live action kind, played live at speeds from 1× to 60× with its own pauses and speed
 * changes, writes the event log of the headless run byte for byte; `dispatch` entries are refused
 * live; and the ordering of an action posted mid-run is the one documented in
 * docs/simulation-model.md ("Scenario timelines").
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCalendarBoundary,
  readScenarioFile,
  scenarioPlan,
  type ActionSpec,
  type PlantConfig,
  type Scenario,
} from '@shopfloor/plant-config';
import { HOUR, MINUTE, type SimTime } from '@shopfloor/sim-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventHub } from '../control/event-hub.ts';
import { runHeadless, type HeadlessOptions } from '../headless/run.ts';
import { EVENT_SCHEMA, isoTime, stableStringify } from '../headless/serialize.ts';
import { SCENARIOS, loadTimeline } from '../headless/timeline.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { EventLogWriter } from './event-log.ts';
import { createLiveRun, type LiveRun } from './run.ts';
import { ManualClock } from './testing.ts';

const EXAMPLE = join(SCENARIOS, 'monday-breakdown-and-recovery.yaml');
const HEADLESS_ONLY = join(SCENARIOS, 'monday-orders-dispatch.yaml');

let folder: string;
let config: PlantConfig;
let example: Scenario;
let headlessOptions: HeadlessOptions;
let headlessLog: string;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'sim-timeline-'));
  config = await loadDefaultConfig();
  const loaded = await loadTimeline(EXAMPLE);
  example = loaded.scenario;
  headlessOptions = loaded.options;
  headlessLog = headless(headlessOptions);
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** The headless `events.jsonl` without its header line. */
function headless(options: HeadlessOptions): string {
  const lines: string[] = [];
  runHeadless(options, (line) => lines.push(line));
  return lines
    .slice(1)
    .map((line) => `${line}\n`)
    .join('');
}

interface Calls {
  readonly infrastructure: string[];
  readonly pauses: SimTime[];
}

/** A live run of the example's seed and span writing `SIM_EVENT_LOG`'s file through the hub. */
function live(speed: number, file: string) {
  const clock = new ManualClock();
  const hub = new EventHub();
  const log = new EventLogWriter(join(folder, file), { flushBytes: 512 });
  hub.subscribe((line) => {
    log.append(line);
  });
  const calls: Calls = { infrastructure: [], pauses: [] };
  // The hooks run only while the pacer runs, after `holder.run` is set.
  const holder: { run?: LiveRun } = {};
  const now = () => isoTime(holder.run?.simulation.now ?? 0);
  const run = createLiveRun({
    config,
    seed: headlessOptions.seed,
    start: headlessOptions.start,
    end: headlessOptions.end,
    speed,
    clock,
    onEvent: (event) => {
      hub.record(event);
    },
    infrastructure: {
      opcuaOffline: (machine, offline) => {
        calls.infrastructure.push(`${now()} opcua ${machine} ${offline ? 'offline' : 'online'}`);
        return Promise.resolve(true);
      },
      modbusSilent: (silent) => {
        calls.infrastructure.push(`${now()} modbus ${silent ? 'silent' : 'answering'}`);
      },
    },
  });
  holder.run = run;
  /** Plays to the end, resuming after each of the timeline's pauses. */
  const play = (tick = 997) => {
    if (run.pacer.state === 'idle') run.pacer.start();
    while (run.pacer.state !== 'finished') {
      if (run.pacer.state === 'paused') {
        calls.pauses.push(run.simulation.now);
        expect(run.pacer.simNow()).toBe(run.simulation.now);
        clock.advance(5_000);
        run.pacer.resume();
      }
      clock.advance(tick);
    }
    log.close();
    return readFileSync(join(folder, file), 'utf8');
  };
  return { run, clock, calls, play, log };
}

describe('a timeline played live (#235, exit criterion 3)', () => {
  it('uses every action kind a live run plays (dispatch is headless only)', () => {
    const actions = new Set((example.timeline ?? []).map((entry) => entry.action));
    expect([...actions].sort()).toEqual(
      [
        'failure',
        'leak-drift',
        'lot-block',
        'lot-release',
        'modbus-silent',
        'opcua-offline',
        'operators-absent',
        'pause',
        'speed',
        'tool-breakage',
      ].sort(),
    );
    // Both ASM-01 operators of shift B.
    expect(example.timeline).toContainEqual({
      action: 'operators-absent',
      shift: '2026-10-12/B',
      operators: ['op-b1', 'op-b2'],
    });
  });

  it.each([1, 7.5, 60])(
    'writes the headless event log byte for byte when started at %s×',
    (speed) => {
      const { run, calls, play } = live(speed, `live-${String(speed)}.jsonl`);
      const loaded = run.loadTimeline(example, 'monday-breakdown-and-recovery');
      expect(loaded.ok).toBe(true);
      const log = play();
      expect(log).toBe(headlessLog);
      expect(log.length).toBeGreaterThan(100_000);
      // The infrastructure entries happened at their simulation times, outside the event log.
      expect(calls.infrastructure).toEqual([
        '2026-10-12T04:40:00.000Z opcua cnc-02 offline',
        '2026-10-12T04:50:00.000Z opcua cnc-02 online',
        '2026-10-12T08:20:00.000Z modbus silent',
        '2026-10-12T08:30:00.000Z modbus answering',
      ]);
      // Paused exactly at each pause entry, with every event of that millisecond processed.
      expect(calls.pauses.map(isoTime)).toEqual([
        '2026-10-12T06:00:00.000Z',
        '2026-10-12T13:00:00.000Z',
      ]);
      expect(run.pacer.speed).toBe(60);
      const statuses = Object.fromEntries(
        run.timeline()?.entries.map((entry) => [entry.entry, entry.status]) ?? [],
      );
      expect(statuses).toEqual({
        'timeline[0]': 'applied',
        'timeline[1]': 'ended',
        'timeline[2]': 'applied',
        'timeline[3]': 'ended',
        'timeline[4]': 'applied',
        'timeline[5]': 'applied',
        'timeline[6]': 'applied',
        'timeline[7]': 'applied',
        'timeline[8]': 'ended',
        'timeline[9]': 'applied',
        'timeline[10]': 'applied',
        'timeline[11]': 'applied',
        'timeline[12]': 'applied',
        'timeline[13]': 'applied',
      });
    },
  );

  it('equals headless however the wall clock ticks, with steps and speed changes of its own', () => {
    const { run, clock, play } = live(1, 'live-mixed.jsonl');
    expect(run.loadTimeline(example).ok).toBe(true);
    run.pacer.start();
    clock.advance(3 * 60_000);
    run.pacer.pause();
    for (let i = 0; i < 40; i++) run.pacer.step();
    run.pacer.resume();
    run.pacer.setSpeed(13);
    clock.advance(10_000);
    run.pacer.setSpeed(0.5);
    clock.advance(1_234);
    run.pacer.setSpeed(60);
    expect(play(333)).toBe(headlessLog);
  });
});

describe('loading a live timeline (#235)', () => {
  it('refuses a dispatch entry (headless only), even in an orders run', async () => {
    const read = await readScenarioFile(HEADLESS_ONLY);
    if (!read.ok) throw new Error(read.message);
    const plan = scenarioPlan(read.scenario);
    const run = createLiveRun({
      config,
      seed: plan.seed,
      start: plan.start,
      production: 'orders',
      clock: new ManualClock(),
    });
    expect(run.loadTimeline(read.scenario)).toEqual({
      ok: false,
      code: 'dispatch',
      reason:
        'timeline[0], timeline[1], timeline[2]: dispatch entries are headless only (a live orders run is dispatched by the MES through LoadOrder)',
    });
    expect(run.injections()).toEqual([]);
    expect(run.actions()).toEqual([]);
    // The same file runs headless.
    expect((await loadTimeline(HEADLESS_ONLY)).options.dispatches).toHaveLength(3);
  });

  it('is accepted only while idle, once, for the run it names, and all or nothing', () => {
    const make = (seed = example.seed) =>
      createLiveRun({
        config,
        seed,
        start: headlessOptions.start,
        clock: new ManualClock(),
        infrastructure: { opcuaOffline: () => true, modbusSilent: () => undefined },
      });
    expect(make(1).loadTimeline(example)).toMatchObject({
      ok: false,
      code: 'mismatch',
      reason: "the timeline is for another run: seed 20261012 (the run's is 1)",
    });
    expect(make().loadTimeline({ ...example, start: '2026-10-12T07:00:00+03:00' })).toMatchObject({
      ok: false,
      code: 'mismatch',
    });
    expect(make().loadTimeline({ ...example, production: 'orders' })).toMatchObject({
      ok: false,
      code: 'mismatch',
    });

    const started = make();
    started.pacer.start();
    expect(started.loadTimeline(example)).toMatchObject({ ok: false, code: 'not-idle' });

    const twice = make();
    expect(twice.loadTimeline(example).ok).toBe(true);
    expect(twice.loadTimeline(example)).toMatchObject({ ok: false, code: 'already-loaded' });

    // An unknown lot late in the timeline: nothing before it is accepted either.
    const bad = make();
    const timeline = [
      ...(example.timeline ?? []),
      { at: '2026-10-12T17:00:00+03:00', action: 'lot-block' as const, lot: 'NOPE' },
    ];
    expect(bad.loadTimeline({ ...example, timeline })).toEqual({
      ok: false,
      code: 'invalid',
      reason: 'timeline[14]: unknown lot "NOPE"',
    });
    expect(bad.injections()).toEqual([]);
    expect(bad.actions()).toEqual([]);
    expect(bad.pacer.pendingCues).toBe(0);
    expect(bad.loadTimeline(example).ok).toBe(true);
  });

  it('refuses an infrastructure entry the run has no fault for', () => {
    const run = createLiveRun({
      config,
      seed: example.seed,
      start: headlessOptions.start,
      clock: new ManualClock(),
    });
    expect(run.loadTimeline(example)).toEqual({
      ok: false,
      code: 'unsupported',
      reason:
        'timeline[1]: this run has no opcua-offline fault; timeline[8]: this run has no modbus-silent fault',
    });
  });
});

/**
 * Mid-run posts (#234 review, #235): an action accepted while the run is under way is an
 * external event, so at its time it runs before every model event not yet processed, after the
 * external events accepted before it. For a time after the simulation time that is exactly
 * where the headless run, which accepts everything first, puts it. For a post at the simulation
 * time itself (`at` = now, or no `at`), the events already processed in that millisecond stay
 * before it.
 */
describe('an action posted mid-run (#235)', () => {
  const START = Date.UTC(2026, 9, 12, 3);
  const END = START + 8 * HOUR;
  const SEED = 11;

  function liveRun() {
    const clock = new ManualClock();
    const lines: string[] = [];
    let seq = 0;
    const run = createLiveRun({
      config,
      seed: SEED,
      start: START,
      end: END,
      speed: 60,
      clock,
      onEvent: (event) => {
        seq++;
        lines.push(stableStringify({ ...event, schema: EVENT_SCHEMA, seq, at: isoTime(event.at) }));
      },
    });
    const finish = () => {
      if (run.pacer.state === 'paused') run.pacer.resume();
      while (run.pacer.state === 'running') clock.advance(997);
      return lines;
    };
    const runTo = (until: SimTime) => {
      run.pacer.start();
      while (run.pacer.simNow() < until) clock.advance(250);
      run.pacer.pause();
    };
    return { run, lines, finish, runTo };
  }

  const headlessLines = (actions: readonly ActionSpec[]) => {
    const lines: string[] = [];
    runHeadless({ config, seed: SEED, start: START, end: END, actions }, (line) =>
      lines.push(line),
    );
    return lines.slice(1);
  };

  it('for a later time, lands where the headless run puts it, even on a queued model event', () => {
    const { run, finish, runTo } = liveRun();
    runTo(START + 2 * HOUR + 17 * MINUTE);
    // The next queued model event's exact millisecond: a FIFO queue would run the action after
    // it; the external lane runs it first, as the headless run does.
    let next = run.simulation.nextEventTime ?? 0;
    while (isCalendarBoundary(config, next)) {
      run.pacer.step();
      next = run.simulation.nextEventTime ?? 0;
    }
    expect(next).toBeGreaterThan(run.simulation.now);
    const actions: ActionSpec[] = [
      { kind: 'lot-block', at: next, lot: 'BL100-2610-01' },
      { kind: 'tool-breakage', at: next, machine: 'cnc-01' },
      { kind: 'lot-release', at: next + 20 * MINUTE, lot: 'BL100-2610-01' },
    ];
    for (const action of actions) expect(run.act(action).ok).toBe(true);
    expect(finish()).toEqual(headlessLines(actions));
  });

  it('at the simulation time, runs after the events already processed in that millisecond', () => {
    // After a paced pause no event of the pause's millisecond is left: with none processed at
    // it either, the post equals the headless run.
    const quiet = liveRun();
    quiet.runTo(START + 1 * HOUR + 3 * MINUTE);
    const pausedAt = quiet.run.simulation.now;
    expect(quiet.lines.some((line) => line.includes(`"at":"${isoTime(pausedAt)}"`))).toBe(false);
    expect(quiet.run.act({ kind: 'tool-breakage', machine: 'cnc-02' }).ok).toBe(true);
    expect(quiet.finish()).toEqual(
      headlessLines([{ kind: 'tool-breakage', at: pausedAt, machine: 'cnc-02' }]),
    );

    // A step lands on an event's millisecond and processes it: a post now comes after it.
    const busy = liveRun();
    busy.runTo(START + 1 * HOUR + 3 * MINUTE);
    // Step until a step has written a line in the millisecond it landed on.
    do {
      busy.run.pacer.step();
    } while (!busy.lines.at(-1)?.includes(`"at":"${isoTime(busy.run.simulation.now)}"`));
    const t = busy.run.simulation.now;
    const before = busy.lines.length;
    expect(busy.run.act({ kind: 'tool-breakage', machine: 'cnc-02' })).toMatchObject({
      ok: true,
      action: { at: t },
    });
    const live = busy.finish();
    const breakage = live.findIndex((line) => line.includes('"type":"tool-breakage"'));
    expect(breakage).toBe(before);
    // The headless run of the same action at t puts it before the events the live run had
    // already processed at t.
    const reference = headlessLines([{ kind: 'tool-breakage', at: t, machine: 'cnc-02' }]);
    const first = reference.findIndex((line) => line.includes(`"at":"${isoTime(t)}"`));
    expect(reference[first]).toContain('"type":"tool-breakage"');
    expect(first).toBeLessThan(before);
  });
});
