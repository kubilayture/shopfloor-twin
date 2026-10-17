import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { PlantConfig } from '@shopfloor/plant-config';
import { MINUTE } from '@shopfloor/sim-core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { InjectDriftRequest, InjectFailureRequest, PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { EVENT_SCHEMA, isoTime, stableStringify } from '../headless/serialize.ts';
import { EVENTS_PATH, buildControlApp, type GroundTruthReport } from './app.ts';
import { parseEnv } from './env.ts';
import { EventHub } from './event-hub.ts';
import { OPENAPI_FILE, generateOpenApi } from './openapi.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
let config: PlantConfig;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(ready = true, withGroundTruth = false, withFailure = false, seed = 3) {
  const clock = new ManualClock();
  const hub = new EventHub();
  const events: PlantEvent[] = [];
  const run: LiveRun = createLiveRun({
    config,
    seed,
    start: T0,
    speed: 60,
    clock,
    onEvent: (event) => {
      events.push(event);
      hub.record(event);
    },
  });
  app = await buildControlApp({
    pacer: run.pacer,
    hub,
    ready: () => ready,
    ...(withFailure
      ? {
          faults: {
            failure: {
              inject: (request: InjectFailureRequest) => run.injectFailure(request),
              list: () => run.injections(),
            },
            drift: {
              inject: (request: InjectDriftRequest) => run.injectLeakDrift(request),
              list: () => run.drifts(),
            },
          },
        }
      : {}),
    ...(withGroundTruth
      ? {
          groundTruth: (traceAsOf?: number) => ({
            epoch: 1_760_000_000,
            ...run.groundTruth(traceAsOf),
          }),
        }
      : {}),
  });
  return { app, run, clock, hub, events };
}

describe('control API (#54)', () => {
  it('starts, pauses, steps, changes speed and resumes the run', async () => {
    const { app, run, clock, events } = await setup();
    const status = await app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(status.json()).toEqual({
      state: 'idle',
      speed: 60,
      simTime: '2026-10-12T03:00:00.000Z',
      lagMs: 0,
      events: events.length,
    });

    expect((await app.inject({ method: 'POST', url: '/api/v1/resume' })).json()).toMatchObject({
      state: 'running',
    });
    clock.advance(10_000);
    expect(run.pacer.simNow()).toBe(T0 + 10 * MINUTE);

    const paused = await app.inject({ method: 'POST', url: '/api/v1/pause' });
    expect(paused.json()).toMatchObject({ state: 'paused', simTime: '2026-10-12T03:10:00.000Z' });
    expect(paused.json<{ events: number }>().events).toBeGreaterThan(0);
    clock.advance(60_000);
    expect(run.pacer.simNow()).toBe(T0 + 10 * MINUTE);

    const next = run.simulation.nextEventTime;
    const step = await app.inject({ method: 'POST', url: '/api/v1/step' });
    expect(step.statusCode).toBe(200);
    expect(step.json<{ stepped: boolean }>().stepped).toBe(true);
    expect(run.simulation.now).toBe(next);
    expect(next).toBeGreaterThan(T0);

    const speed = await app.inject({ method: 'PUT', url: '/api/v1/speed', payload: { speed: 2 } });
    expect(speed.json()).toMatchObject({ speed: 2, state: 'paused' });
    await app.inject({ method: 'POST', url: '/api/v1/resume' });
    const resumedAt = run.pacer.simNow();
    clock.advance(1_000);
    expect(run.pacer.simNow()).toBe(resumedAt + 2_000);
  });

  it('refuses a step while running, a bad speed, and control after the end, with clear errors', async () => {
    const { app, run } = await setup();
    await app.inject({ method: 'POST', url: '/api/v1/resume' });
    const step = await app.inject({ method: 'POST', url: '/api/v1/step' });
    expect(step.statusCode).toBe(409);
    expect(step.json()).toEqual({
      error: 'Conflict',
      message: 'step is only possible while paused, the run is running',
    });
    for (const payload of [
      { speed: 0.4 },
      { speed: 61 },
      { speed: 'fast' },
      { speed: '5' },
      { speed: true },
      { speed: 5, extra: 1 },
      {},
    ]) {
      const response = await app.inject({ method: 'PUT', url: '/api/v1/speed', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(Object.keys(response.json<object>()).sort()).toEqual(['error', 'message']);
    }
    const badJson = await app.inject({
      method: 'PUT',
      url: '/api/v1/speed',
      headers: { 'content-type': 'application/json' },
      payload: '{"speed":',
    });
    expect(badJson.statusCode).toBe(400);
    expect(Object.keys(badJson.json<object>()).sort()).toEqual(['error', 'message']);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/nothing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Not Found', message: 'no route GET /api/v1/nothing' });
    expect(run.pacer.speed).toBe(60);
    run.pacer.stop();
    for (const url of ['/api/v1/pause', '/api/v1/resume']) {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(409);
    }
  });

  it('serves the live ground truth, which follows the run without moving it (#100)', async () => {
    expect(
      (await (await setup()).app.inject({ method: 'GET', url: '/api/v1/ground-truth' })).statusCode,
    ).toBe(404);
    await app?.close();
    const { app: served, run, clock } = await setup(true, true);
    const read = async () => {
      const response = await served.inject({ method: 'GET', url: '/api/v1/ground-truth' });
      expect(response.statusCode).toBe(200);
      return response.json<GroundTruthReport>();
    };
    const idle = await read();
    expect(idle).toMatchObject({
      epoch: 1_760_000_000,
      start: '2026-10-12T03:00:00.000Z',
      simTime: '2026-10-12T03:00:00.000Z',
      pacedTime: '2026-10-12T03:00:00.000Z',
    });
    expect(Object.keys(idle.machines).sort()).toEqual(Object.keys(idle.current).sort());
    expect(idle.current['cnc-01']?.since).toBe('2026-10-12T03:00:00.000Z');
    // 1.4 (#172): the production mode, and an empty orders section in schedule mode.
    expect(idle.productionMode).toBe('schedule');
    expect(idle.orders).toMatchObject({ jobs: [], orders: {}, units: { count: 0 } });

    // A drift in shift A (#208), so the trace's drift section goes through the response schema.
    expect(
      run.injectLeakDrift({
        machine: 'lkt-01',
        shift: 0.6,
        at: Date.parse('2026-10-12T07:40:00Z'),
        until: Date.parse('2026-10-12T09:40:00Z'),
      }).ok,
    ).toBe(true);
    await served.inject({ method: 'POST', url: '/api/v1/resume' });
    clock.advance(8 * 60_000 + 10_000);
    await served.inject({ method: 'POST', url: '/api/v1/pause' });
    const paused = await read();
    expect(paused.simTime).toBe('2026-10-12T11:10:00.000Z');
    expect(paused.pacedTime).toBe(paused.simTime);
    expect(paused.currentBucket).toBe('2026-10-12/B');
    expect(paused.buckets).toEqual({
      '2026-10-12/A': { complete: true },
      '2026-10-12/B': { complete: false },
    });
    // Time per state adds up to the time run, per machine, and the response carries every state.
    const ran = Date.parse(paused.simTime) - Date.parse(paused.start);
    for (const machine of Object.values(paused.machines)) {
      expect(Object.values(machine.stateMs).reduce((sum, ms) => sum + ms, 0)).toBe(ran);
      expect(Object.keys(machine.byShift['2026-10-12/A'] ?? {})).toHaveLength(10);
    }
    expect(await read()).toEqual(paused);
    // The OEE section survives the response schema whole (#117).
    expect(paused.oee).toEqual(JSON.parse(JSON.stringify(run.groundTruth().oee)));
    expect(paused.oee.machines['cnc-01']?.shifts['2026-10-12/A']?.result.oee).not.toBeNull();
    expect(Object.keys(paused.oee.machines['cnc-01']?.hours ?? {})).toHaveLength(9);
    expect(run.pacer.state).toBe('paused');
    // The trace section (1.5, #208) survives it whole too, its drift included.
    expect(paused.trace).toEqual(JSON.parse(JSON.stringify(run.groundTruth().trace)));
    expect(paused.trace.drifts).toHaveLength(1);
    expect(paused.trace.drifts[0]?.window.readings.length).toBeGreaterThan(20);
    expect(paused.trace.spc.limits).toHaveLength(1);
    // ?asOf (1.6): the trace cut at an earlier plant time, served whole; refused when invalid or
    // after the simulation time.
    const asOf = '2026-10-12T09:00:00.000Z';
    const cut = await served.inject({ method: 'GET', url: `/api/v1/ground-truth?asOf=${asOf}` });
    expect(cut.statusCode).toBe(200);
    const cutBody = cut.json<GroundTruthReport>();
    expect(cutBody.traceAsOf).toBe(asOf);
    expect(cutBody.trace).toEqual(
      JSON.parse(JSON.stringify(run.groundTruth(Date.parse(asOf)).trace)),
    );
    expect(cutBody.trace.units.count).toBeLessThan(paused.trace.units.count);
    expect(cutBody.trace.drifts[0]).toMatchObject({ endedAt: null, endedBy: null });
    expect(cutBody.machines).toEqual(paused.machines);
    for (const bad of ['2026-10-12T09:00:00', 'yesterday', '2026-10-12T11:10:00.001Z']) {
      const refused = await served.inject({
        method: 'GET',
        url: `/api/v1/ground-truth?asOf=${encodeURIComponent(bad)}`,
      });
      expect(refused.statusCode, bad).toBe(400);
    }
  });

  it('refuses control until every OPC UA server listens, but reports status', async () => {
    const { app, run } = await setup(false);
    for (const [method, url] of [
      ['POST', '/api/v1/resume'],
      ['POST', '/api/v1/pause'],
      ['POST', '/api/v1/step'],
      ['PUT', '/api/v1/speed'],
    ] as const) {
      const response = await app.inject({ method, url, payload: { speed: 2 } });
      expect(response.statusCode, url).toBe(503);
      expect(response.json()).toEqual({
        error: 'Service Unavailable',
        message: 'the simulator is starting',
      });
    }
    expect(run.pacer.state).toBe('idle');
    expect(run.pacer.speed).toBe(60);
    expect((await app.inject({ url: '/api/v1/status' })).statusCode).toBe(200);
  });

  it('resumes an idle run, leaves a running one alone, and zeroes the lag when paused', async () => {
    const { app, run, clock } = await setup();
    await app.inject({ method: 'POST', url: '/api/v1/resume' });
    clock.advance(5_000);
    const again = await app.inject({ method: 'POST', url: '/api/v1/resume' });
    expect(again.json()).toMatchObject({ state: 'running', simTime: '2026-10-12T03:05:00.000Z' });
    const paused = await app.inject({ method: 'POST', url: '/api/v1/pause' });
    expect(paused.json()).toMatchObject({ state: 'paused', lagMs: 0 });
    expect(run.pacer.status().lagMs).toBe(0);
  });

  it('closes promptly even when a WebSocket client has stopped reading', async () => {
    const { app } = await setup();
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const raw = connect(Number(address.port), address.hostname);
    await new Promise((resolve) => raw.once('connect', resolve));
    raw.write(
      `GET ${EVENTS_PATH} HTTP/1.1\r\nHost: ${address.host}\r\nUpgrade: websocket\r\n` +
        'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    await new Promise((resolve) => raw.once('data', resolve));
    raw.pause();
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    raw.destroy();
  });

  it('switches the Modbus device silent and back through the fault route, which exists only when wired', async () => {
    const { app: plain } = await setup();
    expect(
      (
        await plain.inject({
          method: 'POST',
          url: '/api/v1/faults/modbus',
          payload: { silent: true },
        })
      ).statusCode,
    ).toBe(404);
    await plain.close();
    const calls: boolean[] = [];
    const run = createLiveRun({ config, seed: 1, start: T0, clock: new ManualClock() });
    app = await buildControlApp({
      pacer: run.pacer,
      hub: new EventHub(),
      ready: () => true,
      faults: { modbusSilent: (silent) => calls.push(silent) },
    });
    for (const silent of [true, false]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/faults/modbus',
        payload: { silent },
      });
      expect(response.json()).toEqual({ silent });
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/faults/modbus',
          payload: { silent: 'yes' },
        })
      ).statusCode,
    ).toBe(400);
    expect(calls).toEqual([true, false]);
  });

  it('reports liveness, readiness and Prometheus metrics', async () => {
    const { app, clock } = await setup();
    expect((await app.inject({ url: '/health/live' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/v1/resume' });
    clock.advance(30_000);
    const metrics = await app.inject({ url: '/metrics' });
    expect(metrics.headers['content-type']).toMatch(/^text\/plain/);
    expect(metrics.body).toMatch(/^sim_speed_ratio 60$/m);
    expect(metrics.body).toMatch(/^sim_pacer_state\{state="running"\} 1$/m);
    expect(metrics.body).toMatch(/^sim_events_total\{type="state"\} [1-9]\d*$/m);
    expect(metrics.body).toMatch(/^sim_time_seconds \d+/m);
    expect(metrics.body).toMatch(/^process_cpu_user_seconds_total /m);

    const notReady = await setup(false);
    const response = await notReady.app.inject({ url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    await notReady.app.close();
  });

  it('streams every plant event over WebSocket in the headless event-log format', async () => {
    const { app, clock, events } = await setup();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(`${address.replace('http', 'ws')}${EVENTS_PATH}`);
    const lines: string[] = [];
    socket.addEventListener('message', (message: MessageEvent) => {
      lines.push(String(message.data));
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Events emitted before the client connected (the run's start-up events) are not replayed.
    const missed = events.length;
    expect(missed).toBeGreaterThan(0);
    await app.inject({ method: 'POST', url: '/api/v1/resume' });
    clock.advance(60_000);
    await app.inject({ method: 'POST', url: '/api/v1/pause' });
    for (let i = 0; i < 100 && lines.length < events.length - missed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(events.length - missed).toBeGreaterThan(10);
    const live = events.slice(missed);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((p) => p.seq)).toEqual(live.map((_, i) => missed + i + 1));
    expect(parsed.every((p) => p.schema === EVENT_SCHEMA)).toBe(true);
    expect(parsed.map((p) => [p.type, p.at])).toEqual(
      live.map((e) => [e.type, new Date(e.at).toISOString()]),
    );
    const metrics = await app.inject({ url: '/metrics' });
    expect(metrics.body).toMatch(/^sim_websocket_clients 1$/m);
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener('close', resolve);
    });
    socket.send('hello');
    expect((await closed).code).toBe(1003);
  });

  it('injects failures (1.3, #140): a live run with alarms-01 shift A injections equals the headless alarms-01', async () => {
    const { app: served, run, clock, events } = await setup(true, true, true, 20261012);
    const post = (machine: string, body: object) =>
      served.inject({ method: 'POST', url: `/api/v1/faults/failure/${machine}`, payload: body });

    // Refusals: unknown machine or code 404, the past or a calendar boundary 409, bad bodies 400.
    expect((await post('cnc-09', { code: 'COOLANT-PRESSURE' })).statusCode).toBe(404);
    expect((await post('cnc-01', { code: 'PRINTER-FAULT' })).statusCode).toBe(404);
    expect(
      (await post('cnc-01', { code: 'COOLANT-PRESSURE', at: '2026-10-12T02:00:00Z' })).statusCode,
    ).toBe(409);
    const boundary = await post('cnc-01', {
      code: 'COOLANT-PRESSURE',
      at: '2026-10-12T10:00:00+03:00',
    });
    expect(boundary.statusCode).toBe(409);
    expect(boundary.json<{ message: string }>().message).toMatch(/calendar boundary/);
    for (const body of [
      { code: 'COOLANT-PRESSURE', at: 'tomorrow' },
      { code: 'COOLANT-PRESSURE', repairMs: 0 },
      { code: 'COOLANT-PRESSURE', repairMs: '5' },
      { code: 'COOLANT-PRESSURE', extra: true },
      {},
    ]) {
      expect((await post('cnc-01', body)).statusCode).toBe(400);
    }

    // alarms-01's injections in shift A, posted in list order before the run starts, as the
    // headless run schedules them after line.start.
    const { readScenario, scenarioOptions } = await import('../headless/golden.ts');
    const { runHeadless } = await import('../headless/run.ts');
    const shiftAEnd = Date.parse('2026-10-12T11:00:00Z');
    const injections = (readScenario('alarms-01').injections ?? []).flatMap((i) =>
      i.kind === undefined && Date.parse(i.at) < shiftAEnd ? [i] : [],
    );
    expect(injections).toHaveLength(14);
    for (const injection of injections) {
      const { machine, ...body } = injection;
      const response = await post(machine, body);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        injection: { machine, code: body.code, status: 'scheduled' },
      });
    }
    await served.inject({ method: 'POST', url: '/api/v1/resume' });
    clock.advance(8 * 60_000 + 10_000);
    await served.inject({ method: 'POST', url: '/api/v1/pause' });
    const live = (
      await served.inject({ method: 'GET', url: '/api/v1/ground-truth' })
    ).json<GroundTruthReport>();
    expect(live.simTime).toBe('2026-10-12T11:10:00.000Z');

    const listed = (await served.inject({ method: 'GET', url: '/api/v1/faults/injections' })).json<{
      injections: { status: string; heldAt?: string; appliedAt?: string }[];
    }>().injections;
    expect(listed).toHaveLength(14);
    expect(listed.every((i) => i.status === 'applied')).toBe(true);
    expect(listed.filter((i) => i.heldAt !== undefined)).toHaveLength(2);

    // The alarm section survives the response schema whole, and shift A equals the headless run.
    expect(live.alarms).toEqual(JSON.parse(JSON.stringify(run.groundTruth().alarms)));
    const options = await scenarioOptions('alarms-01');
    const headlessLines: string[] = [];
    // Shift A only: the injections inside it, the same ones the test posted.
    const headless = runHeadless(
      {
        ...options,
        end: shiftAEnd,
        injections: (options.injections ?? []).filter((i) => i.at < shiftAEnd),
      },
      (line) => headlessLines.push(line),
    );
    // Event for event: the live run's lines up to 11:00Z are the headless run's lines.
    const liveLines = events
      .map((event, i) =>
        stableStringify({ ...event, schema: EVENT_SCHEMA, seq: i + 1, at: isoTime(event.at) }),
      )
      .filter((line) => Date.parse((JSON.parse(line) as { at: string }).at) < shiftAEnd);
    expect(liveLines.length).toBeGreaterThan(2_000);
    expect(liveLines).toEqual(headlessLines.slice(1));
    for (const scope of ['plant', 'cell-m1', 'line-a1']) {
      expect(live.alarms.scopes[scope]?.shifts['2026-10-12/A']).toEqual(
        headless.summary.alarms.scopes[scope]?.shifts['2026-10-12/A'],
      );
    }
    expect(live.alarms.scopes['cell-m1']?.shifts['2026-10-12/A']?.raises).toBe(13);
    for (const [id, machine] of Object.entries(headless.summary.machines)) {
      expect(live.machines[id]?.byShift['2026-10-12/A']).toEqual(machine.byShift['2026-10-12/A']);
    }
    // The hour in progress is listed, provisional, even with nothing in it.
    expect(live.alarms.scopes.plant?.hours['2026-10-12T11:00:00.000Z']).toMatchObject({
      raises: 0,
      provisional: true,
    });

    // After the run has finished, nothing can be injected.
    run.pacer.stop();
    const late = await post('cnc-01', { code: 'COOLANT-PRESSURE' });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ message: string }>().message).toBe('the run has finished');
  });

  it('injects a leak drift (1.5, #196): refusals, its outcome, and the live run equals the headless one', async () => {
    const { app: served, run, clock, events } = await setup(true, false, true, 20261012);
    const post = (machine: string, body: object) =>
      served.inject({ method: 'POST', url: `/api/v1/faults/drift/${machine}`, payload: body });
    const at = '2026-10-12T04:00:05Z';
    const until = '2026-10-12T06:30:00Z';

    expect((await post('lkt-09', { shift: 0.6, until })).statusCode).toBe(404);
    // The machine first: an unknown machine is 404 even with an invalid until.
    expect((await post('lkt-09', { shift: 0.6, at, until: at })).statusCode).toBe(404);
    for (const [machine, body] of [
      ['asm-01', { shift: 0.6, until }],
      ['lkt-01', { shift: 0.0005, until }],
      ['lkt-01', { shift: 0, until }],
      ['lkt-01', { shift: 0.6 }],
      ['lkt-01', { shift: 0.6, until: 'later' }],
      ['lkt-01', { shift: 0.6, at: 'soon', until }],
      ['lkt-01', { shift: '0.6', until }],
      ['lkt-01', { shift: 0.6, at, until: at }],
      ['lkt-01', { shift: 0.6, until, extra: true }],
    ] as const) {
      expect((await post(machine, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await post('lkt-01', { shift: 0.6, at: '2026-10-12T02:00:00Z', until })).statusCode,
    ).toBe(409);
    const boundary = await post('lkt-01', { shift: 0.6, at, until: '2026-10-12T10:00:00+03:00' });
    expect(boundary.statusCode).toBe(409);
    expect(boundary.json<{ message: string }>().message).toMatch(/calendar boundary/);

    const accepted = await post('lkt-01', { shift: 0.6, at, until });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      drift: {
        id: 1,
        machine: 'lkt-01',
        shift: 0.6,
        at: '2026-10-12T04:00:05.000Z',
        until: '2026-10-12T06:30:00.000Z',
        status: 'scheduled',
      },
    });
    const end = T0 + 4 * 60 * MINUTE;
    await served.inject({ method: 'POST', url: '/api/v1/resume' });
    clock.advance((end - T0) / 60);
    await served.inject({ method: 'POST', url: '/api/v1/pause' });
    const listed = (await served.inject({ method: 'GET', url: '/api/v1/faults/drifts' })).json<{
      drifts: unknown[];
    }>().drifts;
    expect(listed).toEqual([
      {
        id: 1,
        machine: 'lkt-01',
        shift: 0.6,
        at: '2026-10-12T04:00:05.000Z',
        until: '2026-10-12T06:30:00.000Z',
        status: 'ended',
        appliedAt: '2026-10-12T04:00:05.000Z',
        endedAt: '2026-10-12T06:30:00.000Z',
        endedBy: 'until',
      },
    ]);

    const { runHeadless } = await import('../headless/run.ts');
    const headlessLines: string[] = [];
    runHeadless(
      {
        config,
        seed: 20261012,
        start: T0,
        end,
        injections: [
          {
            kind: 'leak-drift',
            machine: 'lkt-01',
            shift: 0.6,
            at: Date.parse(at),
            until: Date.parse(until),
          },
        ],
      },
      (line) => headlessLines.push(line),
    );
    const liveLines = events
      .map((event, i) =>
        stableStringify({ ...event, schema: EVENT_SCHEMA, seq: i + 1, at: isoTime(event.at) }),
      )
      .filter((line) => Date.parse((JSON.parse(line) as { at: string }).at) < end);
    expect(liveLines.filter((line) => line.includes('"leak-drift"'))).toHaveLength(2);
    expect(liveLines).toEqual(headlessLines.slice(1));

    run.pacer.stop();
    const late = await post('lkt-01', { shift: 0.6, until: '2026-10-13T04:00:05Z' });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ message: string }>().message).toBe('the run has finished');
  });

  it('injects a leak drift without at while the run is running: it starts at the current time', async () => {
    const { app: served, run, clock } = await setup(true, false, true, 20261012);
    await served.inject({ method: 'POST', url: '/api/v1/resume' });
    clock.advance((90 * MINUTE) / 60);
    expect(run.pacer.state).toBe('running');
    const now = run.simulation.now;
    const until = '2026-10-12T05:30:00.001Z';
    const response = await served.inject({
      method: 'POST',
      url: '/api/v1/faults/drift/lkt-01',
      payload: { shift: 0.6, until },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      drift: { id: 1, at: isoTime(now), until, status: 'scheduled' },
    });
    clock.advance((10 * MINUTE) / 60);
    await served.inject({ method: 'POST', url: '/api/v1/pause' });
    const listed = (await served.inject({ method: 'GET', url: '/api/v1/faults/drifts' })).json<{
      drifts: { status: string; appliedAt?: string }[];
    }>().drifts;
    expect(listed).toMatchObject([{ status: 'active', appliedAt: isoTime(now) }]);
  });

  it('keeps the committed OpenAPI description in step with the routes', async () => {
    const generated = await generateOpenApi();
    expect(await readFile(OPENAPI_FILE, 'utf8')).toBe(generated);
    const document = JSON.parse(generated) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths).sort()).toEqual([
      '/api/v1/faults/drift/{machine}',
      '/api/v1/faults/drifts',
      '/api/v1/faults/failure/{machine}',
      '/api/v1/faults/injections',
      '/api/v1/faults/modbus',
      '/api/v1/faults/opcua/{machine}',
      '/api/v1/ground-truth',
      '/api/v1/pause',
      '/api/v1/resume',
      '/api/v1/speed',
      '/api/v1/status',
      '/api/v1/step',
      '/health/live',
      '/health/ready',
      '/metrics',
    ]);
  });
});

describe('environment configuration (#54)', () => {
  it('applies defaults and coerces values', () => {
    const result = parseEnv({ SIM_SPEED: '30', CONTROL_PORT: '9000', SIM_SEED: '' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).toMatchObject({
        SIM_SEED: 1,
        SIM_SPEED: 30,
        SIM_START: Date.UTC(2026, 9, 12, 3),
        CONTROL_HOST: '127.0.0.1',
        CONTROL_PORT: 9000,
        OPCUA_PORT_OFFSET: 0,
        SIM_AUTOSTART: 'true',
        SIM_PRODUCTION: 'schedule',
        LOG_LEVEL: 'info',
      });
    }
    // The production mode (#172): orders only on request.
    const orders = parseEnv({ SIM_PRODUCTION: 'orders' });
    expect(orders.ok && orders.env.SIM_PRODUCTION).toBe('orders');
    // A scenario's own stock file (#196): the configuration's stock.yaml unless set.
    expect(result.ok && result.env.SIM_STOCK).toBeUndefined();
    const stock = parseEnv({ SIM_STOCK: 'apps/simulator/golden/quality-01/stock.yaml' });
    expect(stock.ok && stock.env.SIM_STOCK).toBe('apps/simulator/golden/quality-01/stock.yaml');
  });

  it.each([
    ['SIM_SEED', '0x10'],
    ['SIM_SEED', '1e3'],
    ['SIM_SEED', ' 5 '],
    ['SIM_SEED', '1.5'],
    ['CONTROL_PORT', '0x1F40'],
    ['CONTROL_PORT', '0'],
    ['SIM_SPEED', 'Infinity'],
    ['CONTROL_HOST', ' '],
    ['SIM_CONFIG_DIR', '  '],
    ['SIM_PRODUCTION', 'campaigns'],
    ['SIM_STOCK', '   '],
  ])('refuses %s=%j', (key, value) => {
    const result = parseEnv({ [key]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatch(new RegExp(`^${key}: `));
    }
  });

  it('refuses invalid values and names every offending variable', () => {
    const result = parseEnv({
      SIM_SPEED: '100',
      SIM_START: '2026-10-12T06:00:00',
      CONTROL_PORT: 'http',
      SIM_SEED: '-1',
      LOG_LEVEL: 'loud',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.split(':')[0]).sort()).toEqual([
        'CONTROL_PORT',
        'LOG_LEVEL',
        'SIM_SEED',
        'SIM_SPEED',
        'SIM_START',
      ]);
      expect(result.issues.join('\n')).toMatch(/SIM_START: expected ISO 8601 with an offset/);
    }
  });
});
