/**
 * The console routes of the control API (#234, 1.7): lot and operator reads, lot block and
 * release, forced absences and tool breakage, with their refusals.
 */
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE } from '@shopfloor/sim-core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isoTime } from '../headless/serialize.ts';
import { createLiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { buildControlApp } from './app.ts';
import { EventHub } from './event-hub.ts';

/** Monday 2026-10-12 06:00 Istanbul, shift A's start; shift B starts at 11:00Z. */
const T0 = Date.UTC(2026, 9, 12, 3);
const SHIFT_B = Date.UTC(2026, 9, 12, 11);
let config: PlantConfig;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(end?: number) {
  const clock = new ManualClock();
  const hub = new EventHub();
  const events: PlantEvent[] = [];
  const run = createLiveRun({
    config,
    seed: 5,
    start: T0,
    speed: 60,
    clock,
    ...(end === undefined ? {} : { end }),
    onEvent: (event) => {
      events.push(event);
      hub.record(event);
    },
  });
  app = await buildControlApp({
    pacer: run.pacer,
    hub,
    ready: () => true,
    console: {
      act: (request) => run.act(request),
      actions: () => run.actions(),
      lots: () => run.lots(),
      operators: () => run.operators(),
    },
  });
  /** Runs paced until the simulation has processed every event before `until`. */
  const runTo = (until: number) => {
    if (run.pacer.state === 'idle') run.pacer.start();
    else run.pacer.resume();
    while (run.pacer.simNow() < until && run.pacer.state === 'running') {
      clock.advance(250);
    }
    if (run.pacer.state === 'running') run.pacer.pause();
  };
  return { app, run, events, runTo };
}

const post = (server: FastifyInstance, url: string, payload?: object) =>
  server.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload }) });

describe('console routes (1.7, #234)', () => {
  it('lists the lots and the roster of the current shift', async () => {
    const { app } = await setup();
    const lots = (await app.inject({ method: 'GET', url: '/api/v1/lots' })).json<{
      lots: { lot: string; material: string; remaining: number; blocked: boolean }[];
    }>().lots;
    expect(lots.map((lot) => lot.lot)).toEqual(config.stock.lots.map((lot) => lot.id));
    expect(lots[0]).toEqual({
      lot: 'BL100-2610-01',
      material: 'BLANK-100',
      // Both CNCs took a blank at the start.
      remaining: 898,
      blocked: false,
    });
    const operators = (await app.inject({ method: 'GET', url: '/api/v1/operators' })).json<{
      currentShift: string | null;
      operators: { id: string; status: string; station: string | null }[];
      absences: unknown[];
    }>();
    expect(operators.currentShift).toBe('2026-10-12/A');
    expect(operators.operators).toHaveLength(config.operators.operators.length);
    expect(operators.operators.find((op) => op.id === 'op-b1')?.status).toBe('off-shift');
    expect(
      operators.operators.filter((op) => op.station === 'asm-01').map((op) => op.status),
    ).toEqual(['present']);
    expect(operators.absences).toEqual([]);
  });

  it('blocks and releases a lot, now or at a time, and refuses what it must', async () => {
    const { app, run, events, runTo } = await setup();
    runTo(T0 + HOUR);
    const now = run.simulation.now;
    // No body: due now, applied at the next step.
    const blocked = await post(app, '/api/v1/lots/SK1-2610-01/block');
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toEqual({
      action: {
        id: 1,
        kind: 'lot-block',
        lot: 'SK1-2610-01',
        material: 'SK-1',
        at: isoTime(now),
        status: 'scheduled',
      },
    });
    const releaseAt = T0 + 2 * HOUR + 7 * MINUTE;
    const released = await post(app, '/api/v1/lots/SK1-2610-01/release', {
      at: isoTime(releaseAt),
    });
    expect(released.json()).toMatchObject({ action: { id: 2, status: 'scheduled' } });

    const refusals = [
      [await post(app, '/api/v1/lots/NOPE/block', {}), 404],
      [await post(app, '/api/v1/lots/SK1-2610-01/block', { at: 'monday' }), 400],
      [await post(app, '/api/v1/lots/SK1-2610-01/block', { at: isoTime(now), x: 1 }), 400],
      [await post(app, '/api/v1/lots/SK1-2610-01/block', { at: isoTime(T0 + MINUTE) }), 409],
      [await post(app, '/api/v1/lots/SK1-2610-01/block', { at: isoTime(T0 + 4 * HOUR) }), 409],
    ] as const;
    for (const [response, code] of refusals) {
      expect(response.statusCode).toBe(code);
      expect(Object.keys(response.json<object>()).sort()).toEqual(['error', 'message']);
    }

    runTo(T0 + 2 * HOUR);
    const lots = (await app.inject({ method: 'GET', url: '/api/v1/lots' })).json<{
      lots: { lot: string; blocked: boolean }[];
    }>().lots;
    expect(lots.find((lot) => lot.lot === 'SK1-2610-01')?.blocked).toBe(true);
    expect(events.find((e) => e.type === 'lot')).toEqual({
      type: 'lot',
      at: now,
      lotId: 'SK1-2610-01',
      material: 'SK-1',
      transition: 'blocked',
      action: 1,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'state',
        machineId: 'asm-01',
        to: 'Starved',
        cause: 'MATERIAL:SK-1',
      }),
    );
    runTo(T0 + 3 * HOUR);
    const actions = (await app.inject({ method: 'GET', url: '/api/v1/actions' })).json<{
      actions: { id: number; status: string; appliedAt?: string }[];
    }>().actions;
    expect(actions).toMatchObject([
      { id: 1, status: 'applied', appliedAt: isoTime(now) },
      { id: 2, status: 'applied', appliedAt: isoTime(releaseAt) },
    ]);
  });

  it('marks both ASM-01 operators of shift B absent: ASM-01 is Idle NO-OPERATOR at its start', async () => {
    const { app, events, runTo } = await setup();
    const absent = await post(app, '/api/v1/operators/absent', {
      shift: '2026-10-12/B',
      operators: ['op-b1', 'op-b2'],
    });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({
      action: {
        id: 1,
        kind: 'operators-absent',
        shift: '2026-10-12/B',
        start: isoTime(SHIFT_B),
        operators: ['op-b1', 'op-b2'],
        status: 'planned',
      },
    });
    const refusals = [
      [{ shift: '2026-10-12/B', operators: ['op-zz'] }, 404],
      [{ shift: '2026-10-17/B', operators: ['op-b1'] }, 404],
      [{ shift: '2026-10-12/B', operators: ['op-a1'] }, 400],
      [{ shift: '2026-10-12/B', operators: [] }, 400],
      [{ shift: 'B', operators: ['op-b1'] }, 400],
      [{ shift: '2026-10-12/A', operators: ['op-a1'] }, 409],
    ] as const;
    for (const [body, code] of refusals) {
      const response = await post(app, '/api/v1/operators/absent', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(code);
    }
    runTo(SHIFT_B + HOUR);
    expect(events).toContainEqual({
      type: 'absence',
      at: SHIFT_B,
      shiftId: 'B',
      shiftDate: '2026-10-12',
      operators: ['op-b1', 'op-b2'],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'state',
        at: SHIFT_B,
        machineId: 'asm-01',
        to: 'Idle',
        cause: 'NO-OPERATOR',
      }),
    );
    const operators = (await app.inject({ method: 'GET', url: '/api/v1/operators' })).json<{
      currentShift: string;
      operators: { id: string; status: string; forced: boolean }[];
      absences: { status: string; appliedAt?: string }[];
    }>();
    expect(operators.currentShift).toBe('2026-10-12/B');
    expect(
      operators.operators
        .filter((op) => op.id.startsWith('op-b'))
        .map((op) => [op.id, op.status, op.forced]),
    ).toEqual([
      ['op-b1', 'absent', true],
      ['op-b2', 'absent', true],
    ]);
    expect(operators.absences).toMatchObject([{ status: 'applied', appliedAt: isoTime(SHIFT_B) }]);
  });

  it('breaks a CNC tool and refuses machines without one', async () => {
    const { app, events, runTo } = await setup();
    const at = T0 + HOUR + 3 * MINUTE;
    const broken = await post(app, '/api/v1/faults/tool/cnc-01', { at: isoTime(at) });
    expect(broken.statusCode).toBe(200);
    expect(broken.json()).toEqual({
      action: {
        id: 1,
        kind: 'tool-breakage',
        machine: 'cnc-01',
        at: isoTime(at),
        status: 'scheduled',
      },
    });
    expect((await post(app, '/api/v1/faults/tool/asm-01', {})).statusCode).toBe(400);
    expect((await post(app, '/api/v1/faults/tool/cnc-09', {})).statusCode).toBe(404);
    // At the start time (a shift start) "now" is a calendar boundary.
    expect((await post(app, '/api/v1/faults/tool/cnc-02')).statusCode).toBe(409);
    runTo(T0 + 2 * HOUR);
    const breakage = events.find((e) => e.type === 'tool-breakage');
    expect(breakage).toMatchObject({ at, machineId: 'cnc-01', action: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'state',
        machineId: 'cnc-01',
        to: 'Setup',
        cause: 'TOOL-CHANGE',
      }),
    );
  });

  it('refuses every console action once the run has finished', async () => {
    const end = T0 + 30 * MINUTE;
    const { app, run, runTo } = await setup(end);
    runTo(end + MINUTE);
    expect(run.pacer.state).toBe('finished');
    for (const [url, body] of [
      ['/api/v1/lots/SK1-2610-01/block', {}],
      ['/api/v1/lots/SK1-2610-01/release', {}],
      ['/api/v1/faults/tool/cnc-01', {}],
      ['/api/v1/operators/absent', { shift: '2026-10-12/B', operators: ['op-b1'] }],
    ] as const) {
      const response = await post(app, url, body);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Conflict', message: 'the run has finished' });
    }
  });
});
