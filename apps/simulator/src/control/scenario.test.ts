/**
 * The scenario routes of the control API (#235, 1.9): `POST /scenario` by name or inline while
 * idle, `GET /scenario` with each entry's progress, `GET /scenarios`, and their refusals.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlantConfig } from '@shopfloor/plant-config';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SCENARIOS } from '../headless/timeline.ts';
import { createLiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import { scenarioControl } from '../live/timeline.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { CONTROL_API_VERSION, buildControlApp } from './app.ts';
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
  it('is version 1.9', () => {
    expect(CONTROL_API_VERSION).toBe('1.9.0');
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

  it('refuses once the run has finished', async () => {
    const { app, run } = await setup();
    run.pacer.stop();
    const res = await post(app, { name: 'example' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toBe('the run has finished');
  });
});
