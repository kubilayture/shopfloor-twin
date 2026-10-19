/**
 * The scenario routes of the control API (#235, 1.9): `POST /scenario` by name or inline while
 * idle, `GET /scenario` with each entry's progress, `GET /scenarios`, and their refusals; and the
 * recording of the run, `GET /scenario/recorded` (#236, 1.10).
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_RECORDED_ENTRIES,
  MAX_TIMELINE_ENTRIES,
  parseScenario,
  scenarioPlan,
  type PlantConfig,
} from '@shopfloor/plant-config';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SCENARIOS } from '../headless/timeline.ts';
import { RecordingTooLargeError } from '../live/recording.ts';
import { createLiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import { scenarioControl } from '../live/timeline.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { CONTROL_API_VERSION, SCENARIO_BODY_LIMIT, buildControlApp } from './app.ts';
import { EventHub } from './event-hub.ts';

/** Monday 2026-10-12 06:00 Istanbul, the example timeline's start. */
const T0 = Date.UTC(2026, 9, 12, 3);
const SEED = 20261012;
const folder = mkdtempSync(join(tmpdir(), 'sim-scenarios-api-'));
let config: PlantConfig;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  config = await loadDefaultConfig();
  copyFileSync(join(SCENARIOS, 'monday-breakdown-and-recovery.yaml'), join(folder, 'example.yaml'));
  copyFileSync(join(SCENARIOS, 'monday-orders-dispatch.yaml'), join(folder, 'orders.yaml'));
  writeFileSync(join(folder, 'broken.yaml'), 'seed: one\n');
  writeFileSync(join(folder, 'README.md'), 'not a timeline\n');
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(seed = SEED) {
  const clock = new ManualClock();
  const run = createLiveRun({
    config,
    seed,
    start: T0,
    end: T0 + 24 * 3_600_000,
    speed: 60,
    clock,
    infrastructure: { opcuaOffline: () => true, modbusSilent: () => undefined },
  });
  app = await buildControlApp({
    token: null,
    pacer: run.pacer,
    hub: new EventHub(),
    ready: () => true,
    scenario: scenarioControl(run, folder),
  });
  return { app, run, clock };
}

const post = (server: FastifyInstance, payload: object) =>
  server.inject({ method: 'POST', url: '/api/v1/scenario', payload });

describe('scenario routes (1.9, #235)', () => {
  it('is version 1.11 (#237)', () => {
    expect(CONTROL_API_VERSION).toBe('1.11.0');
  });

  it('lists the committed timelines', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/v1/scenarios' });
    expect(res.statusCode).toBe(200);
    const { scenarios } = res.json<{ scenarios: { name: string; description: string | null }[] }>();
    expect(scenarios.map((s) => s.name)).toEqual(['broken', 'example', 'orders']);
    expect(scenarios[0]?.description).toBeNull();
    expect(scenarios[1]?.description).toMatch(/^Monday at Gebze/);
  });

  it('loads a committed timeline while idle and shows its progress', async () => {
    const { app, run, clock } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/v1/scenario' })).json()).toEqual({
      scenario: null,
    });
    const res = await post(app, { name: 'example' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      scenario: { name: string; entries: { entry: string; action: string; status: string }[] };
    }>();
    expect(body.scenario.name).toBe('example');
    expect(body.scenario.entries).toHaveLength(14);
    expect(body.scenario.entries[0]).toEqual({
      entry: 'timeline[0]',
      action: 'failure',
      at: '2026-10-12T04:15:00.000Z',
      status: 'scheduled',
      id: 1,
    });
    expect(body.scenario.entries[11]).toEqual({
      entry: 'timeline[11]',
      action: 'operators-absent',
      status: 'planned',
      id: 4,
    });
    // Played to the first pause (09:00 Istanbul): every entry before it has happened.
    run.pacer.start();
    while (run.pacer.state === 'running') clock.advance(1_000);
    const progress = (await app.inject({ method: 'GET', url: '/api/v1/scenario' })).json<{
      scenario: { entries: { status: string }[] };
    }>().scenario.entries;
    expect(progress.slice(0, 6).map((e) => e.status)).toEqual([
      'applied',
      'ended',
      'applied',
      'active',
      'applied',
      'applied',
    ]);
    expect(progress[6]?.status).toBe('scheduled');
    // Not idle any more.
    expect((await post(app, { name: 'example' })).statusCode).toBe(409);
  });

  it('loads an inline timeline', async () => {
    const { app, run } = await setup();
    const res = await post(app, {
      timeline: {
        seed: SEED,
        start: '2026-10-12T06:00:00+03:00',
        days: 1,
        config: 'config/plant',
        timeline: [{ at: '2026-10-12T08:05:00+03:00', action: 'lot-block', lot: 'SK1-2610-01' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ scenario: { name: string | null } }>().scenario.name).toBeNull();
    expect(run.actions()).toHaveLength(1);
  });

  it('refuses with the status each refusal calls for', async () => {
    const { app } = await setup();
    const refusal = async (payload: object) => {
      const res = await post(app, payload);
      return [res.statusCode, res.json<{ message: string }>().message] as const;
    };
    expect(await refusal({ name: 'nope' })).toEqual([404, 'no committed timeline "nope"']);
    expect((await refusal({ name: 'broken' }))[0]).toBe(400);
    expect(await refusal({ name: 'orders' })).toEqual([
      400,
      'timeline[0], timeline[1], timeline[2]: dispatch entries are headless only (a live orders run is dispatched by the MES through LoadOrder)',
    ]);
    expect((await refusal({ name: 'example', extra: 1 }))[0]).toBe(400);
    expect((await refusal({}))[0]).toBe(400);
    const inline = (extra: object) => ({
      timeline: {
        seed: SEED,
        start: '2026-10-12T06:00:00+03:00',
        days: 1,
        config: 'config/plant',
        timeline: [],
        ...extra,
      },
    });
    expect(await refusal(inline({ stock: 'lots.yaml' }))).toEqual([
      400,
      'stock: an inline timeline has no folder for its stock file',
    ]);
    expect(
      await refusal(
        inline({ timeline: [{ at: '2026-10-12T08:05:00+03:00', action: 'lot-block', lot: 'X' }] }),
      ),
    ).toEqual([400, 'timeline[0]: unknown lot "X"']);
    expect(await refusal(inline({ seed: 3 }))).toEqual([
      409,
      "the timeline is for another run: seed 3 (the run's is 20261012)",
    ]);
    expect((await post(app, { name: 'example' })).statusCode).toBe(200);
    expect(await refusal({ name: 'example' })).toEqual([409, 'the run has a timeline already']);
  });

  it('takes a timeline of the largest size quickly, and refuses a longer one or a large body', async () => {
    const { app } = await setup();
    // Lot blocks 37 s apart from 06:00:01 Istanbul, off every boundary of the first day.
    const entries = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        at: new Date(T0 + 1_000 + i * 37_000).toISOString(),
        action: 'lot-block',
        lot: 'SK1-2610-01',
      }));
    const doc = (n: number) => ({
      timeline: {
        seed: SEED,
        start: '2026-10-12T06:00:00+03:00',
        days: 1,
        config: 'config/plant',
        timeline: entries(n),
      },
    });
    const tooMany = await post(app, doc(MAX_TIMELINE_ENTRIES + 1));
    expect(tooMany.statusCode).toBe(400);
    const big = await app.inject({
      method: 'POST',
      url: '/api/v1/scenario',
      payload: { name: 'x'.repeat(SCENARIO_BODY_LIMIT) },
    });
    expect(big.statusCode).toBe(413);
    const started = performance.now();
    expect((await post(app, doc(MAX_TIMELINE_ENTRIES))).statusCode).toBe(200);
    const read = await app.inject({ method: 'GET', url: '/api/v1/scenario' });
    expect(read.json<{ scenario: { entries: unknown[] } }>().scenario.entries).toHaveLength(
      MAX_TIMELINE_ENTRIES,
    );
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses a load after a console action posted while idle', async () => {
    const { app, run } = await setup();
    expect(run.act({ kind: 'lot-block', lot: 'SK1-2610-01', at: T0 + 3_600_000 }).ok).toBe(true);
    const res = await post(app, { name: 'example' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/a timeline is loaded first/);
  });

  it('refuses once the run has finished', async () => {
    const { app, run } = await setup();
    run.pacer.stop();
    const res = await post(app, { name: 'example' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toBe('the run has finished');
  });
});

describe('the recorded run (1.10, #236)', () => {
  it('serves the accepted dispatches at their points and the inputs, as a scenario document', async () => {
    const clock = new ManualClock();
    const run = createLiveRun({
      config,
      seed: SEED,
      start: T0,
      speed: 60,
      clock,
      production: 'orders',
    });
    app = await buildControlApp({
      token: null,
      pacer: run.pacer,
      hub: new EventHub(),
      ready: () => true,
      recorded: () => run.recorded({ config: 'config/plant', stock: 'stock-01.yaml' }),
    });
    const job = (commandId: string, product: string) => ({
      commandId,
      orderId: commandId,
      product,
      quantity: 3,
      notBefore: T0,
    });
    expect(run.line.loadOrder('cnc-01', job('C-1', 'VB-100'), run.simulation).ok).toBe(true);
    expect(
      run.injectFailure({
        machine: 'cnc-01',
        code: 'COOLANT-PRESSURE',
        at: T0 + 7_200_123,
        repairMs: 4_000,
      }).ok,
    ).toBe(true);
    // An action accepted between two injections, and a drift: `inputOrder` keeps the order.
    expect(run.act({ kind: 'tool-breakage', machine: 'cnc-02', at: T0 + 3_600_007 }).ok).toBe(true);
    expect(
      run.injectLeakDrift({
        machine: 'lkt-01',
        shift: 0.5,
        at: T0 + 1_800_009,
        until: T0 + 5_400_009,
      }).ok,
    ).toBe(true);
    run.pacer.start();
    clock.advance(60_000);
    run.pacer.pause();
    const now = run.simulation.now;
    expect(run.line.loadOrder('cnc-02', job('C-2', 'VB-200'), run.simulation).ok).toBe(true);
    // A retried call: the same job, nothing added, nothing recorded.
    expect(run.line.loadOrder('cnc-02', job('C-2', 'VB-200'), run.simulation)).toMatchObject({
      ok: true,
      duplicate: true,
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/scenario/recorded' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toEqual(
      JSON.parse(JSON.stringify(run.recorded({ config: 'config/plant', stock: 'stock-01.yaml' }))),
    );
    expect(body).toMatchObject({
      seed: SEED,
      start: '2026-10-12T03:00:00.000Z',
      days: 1,
      end: new Date(T0 + 7_200_124).toISOString(),
      endAfterEvents: run.simulation.processed,
      configSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      config: 'config/plant',
      stock: 'stock-01.yaml',
      production: 'orders',
      dispatches: [
        { commandId: 'C-1', machine: 'cnc-01', notBefore: '2026-10-12T03:00:00.000Z' },
        {
          commandId: 'C-2',
          machine: 'cnc-02',
          acceptedAt: new Date(now).toISOString(),
          afterEvents: run.simulation.processed,
        },
      ],
      injections: [
        {
          at: '2026-10-12T05:00:00.123Z',
          machine: 'cnc-01',
          code: 'COOLANT-PRESSURE',
          repairMs: 4_000,
        },
        {
          kind: 'leak-drift',
          at: '2026-10-12T03:30:00.009Z',
          until: '2026-10-12T04:30:00.009Z',
          machine: 'lkt-01',
          shift: 0.5,
        },
      ],
      actions: [{ kind: 'tool-breakage', at: '2026-10-12T04:00:00.007Z', machine: 'cnc-02' }],
      inputOrder: ['injection', 'action', 'injection'],
    });
    expect((body.dispatches as object[])[0]).not.toHaveProperty('acceptedAt');
    // The schema a headless run reads takes it as it is.
    const parsed = parseScenario(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(scenarioPlan(parsed.scenario).end).toBe(T0 + 7_200_124);
  });

  it('answers 413 for a run past the recording bound', async () => {
    app = await buildControlApp({
      token: null,
      pacer: createLiveRun({ config, seed: SEED, start: T0, clock: new ManualClock() }).pacer,
      hub: new EventHub(),
      ready: () => true,
      recorded: () => {
        throw new RecordingTooLargeError('dispatches', MAX_RECORDED_ENTRIES + 1);
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/scenario/recorded' });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ message: string }>().message).toBe(
      `the run has ${String(MAX_RECORDED_ENTRIES + 1)} dispatches, more than a recording takes (${String(MAX_RECORDED_ENTRIES)})`,
    );
  });

  it('refuses to load a recording live: it is replayed headless', async () => {
    const { app } = await setup();
    const res = await post(app, {
      timeline: {
        seed: SEED,
        start: '2026-10-12T03:00:00.000Z',
        days: 1,
        config: 'config/plant',
        configSha256: 'a'.repeat(64),
        endAfterEvents: 0,
        stopAt: '2026-10-12T03:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/replayed headless/);
  });

  it('exists only when the run gives its recording', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/v1/scenario/recorded' })).statusCode).toBe(
      404,
    );
  });
});
