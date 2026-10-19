/**
 * Dispatches given mid-run through the OPC UA `LoadOrder` method replay headless (#236, Phase 9
 * exit criterion 3, ADR-0037 amendment): a live orders run on its five OPC UA servers gets MES-like
 * calls while it runs (accepted, retried as a duplicate, expired, for another epoch, two in one
 * millisecond, one after a single step), and the headless run of `GET /scenario/recorded`'s
 * document writes the live event log byte for byte.
 */
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { parseScenario, scenarioPlan } from '@shopfloor/plant-config';
import { MINUTE } from '@shopfloor/sim-core';
import { afterAll, describe, expect, it } from 'vitest';
import { scenarioOptions } from '../headless/golden.ts';
import { runHeadless, type DispatchSpec } from '../headless/run.ts';
import { EVENT_SCHEMA, isoTime, stableStringify } from '../headless/serialize.ts';
import { planOptions } from '../headless/timeline.ts';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { PlantEvent } from '../plant/line.ts';
import { onFreeOpcuaPorts, temporaryPki } from '../testing.ts';
import { PlantServers } from './plant-servers.ts';
import { callLoadOrder, connect } from './testing.ts';

const EPOCH = 1_791_000_000;
const WALL = Date.UTC(2026, 9, 16, 12);
const SPEED = 60;
let servers: PlantServers | undefined;
let run: LiveRun | undefined;
let removePki: (() => Promise<void>) | undefined;

afterAll(async () => {
  try {
    run?.pacer.stop();
    await servers?.stop();
  } finally {
    await removePki?.();
  }
});

describe('mid-run LoadOrder calls over OPC UA replay headless (#236)', () => {
  it('records the accepted calls only, and the recording replays the live log byte for byte', async () => {
    const options = await scenarioOptions('orders-01');
    const dispatches = options.dispatches ?? [];
    const pki = await temporaryPki('live-dispatch-replay');
    removePki = pki.remove;
    const clock = new ManualClock();
    let live: LiveRun | undefined;
    let events: PlantEvent[] = [];
    const { portOffset, value: plant } = await onFreeOpcuaPorts((portOffset) => {
      const attempt = new PlantServers({
        config: options.config,
        start: options.start,
        portOffset,
        epoch: EPOCH,
        production: 'orders',
        wallClock: () => WALL,
        pkiFolder: pki.folder,
        security: { mode: 'none' },
      });
      const attemptEvents: PlantEvent[] = [];
      live = createLiveRun({
        config: options.config,
        seed: options.seed,
        start: options.start,
        speed: SPEED,
        clock,
        production: 'orders',
        onEvent: (event) => {
          attemptEvents.push(event);
          attempt.record(event);
        },
      });
      events = attemptEvents;
      attempt.attach(live);
      return attempt;
    });
    servers = plant;
    if (!live) throw new Error('the run was not created');
    run = live;
    const current = live;

    const sessions = new Map<string, Awaited<ReturnType<typeof connect>>>();
    const call = async (
      dispatch: DispatchSpec,
      change: { deviceEpoch?: number; expiresAt?: number } = {},
    ) => {
      let session = sessions.get(dispatch.machine);
      if (!session) {
        const port = OPCUA_MACHINES.find((m) => m.id === dispatch.machine)?.port ?? 0;
        session = await connect(port + portOffset);
        sessions.set(dispatch.machine, session);
      }
      return callLoadOrder(session.session, dispatch.machine, {
        ...dispatch,
        deviceEpoch: EPOCH,
        expiresAt: WALL + 60_000,
        ...change,
      });
    };
    const of = (index: number): DispatchSpec => {
      const dispatch = dispatches[index];
      if (!dispatch) throw new Error(`no dispatch ${String(index)}`);
      return dispatch;
    };
    const advance = (simMs: number) => {
      clock.advance(Math.ceil(simMs / SPEED));
    };
    const accepted = { status: 'Good', flagged: [] };

    try {
      // Idle at the start, as the MES dispatches its first released orders.
      expect(await call(of(0))).toMatchObject(accepted);
      expect(await call(of(1))).toMatchObject(accepted);
      current.pacer.start();
      advance(35 * MINUTE);
      // Mid-run: accepted, then retried (Duplicate = true, the original sequence number).
      const first = await call(of(2));
      expect(first).toMatchObject(accepted);
      const retry = await call(of(2));
      expect(retry).toMatchObject(accepted);
      expect(retry.outputs[1]).toBe(true);
      expect(retry.outputs[2]).toBe(first.outputs[2]);
      // Refused: expired, another run's epoch. Neither leaves a trace in the line.
      expect(await call(of(3), { expiresAt: WALL - 1 })).toMatchObject({
        status: 'BadInvalidState',
        flagged: ['ExpiresAt BadInvalidState'],
      });
      expect(await call(of(3), { deviceEpoch: EPOCH + 1 })).toMatchObject({
        status: 'BadInvalidState',
        flagged: ['DeviceEpoch BadInvalidState'],
      });
      advance(80 * MINUTE);
      // Two calls in one millisecond: the clock doesn't move between them.
      const sameMs = current.simulation.now;
      expect(await call(of(3))).toMatchObject(accepted);
      expect(await call(of(4))).toMatchObject(accepted);
      expect(current.simulation.now).toBe(sameMs);
      // Paused and stepped once, then a call.
      advance(25 * MINUTE);
      current.pacer.pause();
      current.pacer.step();
      expect(await call(of(5))).toMatchObject(accepted);
      current.pacer.resume();
      advance(150 * MINUTE);
      expect(await call(of(6))).toMatchObject(accepted);
      advance(90 * MINUTE);
      current.pacer.pause();
    } finally {
      await Promise.all([...sessions.values()].map((session) => session.close()));
    }

    const recorded = current.recorded({ config: 'config/plant' });
    expect(recorded.dispatches?.map((d) => d.commandId)).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((i) => of(i).commandId),
    );
    // The two calls of one millisecond: one time, one event count, in call order.
    const [, , , third, fourth] = recorded.dispatches ?? [];
    expect(third?.acceptedAt).toBeDefined();
    expect([fourth?.acceptedAt, fourth?.afterEvents]).toEqual([
      third?.acceptedAt,
      third?.afterEvents,
    ]);

    // The document as the endpoint serves it, read as the headless CLI reads a timeline file.
    const parsed = parseScenario(JSON.parse(JSON.stringify(recorded)));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const headless: string[] = [];
    runHeadless(planOptions(options.config, scenarioPlan(parsed.scenario), 'recorded'), (line) =>
      headless.push(line),
    );
    const lines = events.map((event, i) =>
      stableStringify({ ...event, schema: EVENT_SCHEMA, seq: i + 1, at: isoTime(event.at) }),
    );
    expect(lines.length).toBeGreaterThan(500);
    expect(headless.slice(1).join('\n')).toBe(lines.join('\n'));
  }, 120_000);
});
