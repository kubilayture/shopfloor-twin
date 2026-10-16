import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { idealCycleMs, loadPlantConfig } from '@shopfloor/plant-config';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import { DowntimeCoding, Equipment, downtimeRules } from './modules/equipment/index.ts';
import { PLANT_CONFIG, UnsFeed, freshDatabase } from './modules/equipment/test-support.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import { DowntimeFeed, Oee } from './modules/oee/index.ts';
import { WS_PATH, serverMessageSchema, type ServerMessage } from './modules/realtime/index.ts';
import {
  currentShiftSchema,
  downtimeListSchema,
  equipmentListSchema,
  intervalsSchema,
  metricsSchema,
  oeeListSchema,
  paretoSchema,
  plantSchema,
  problemSchema,
  reasonCodesSchema,
  seriesSchema,
  shiftListSchema,
  shiftOeeSchema,
  shiftTotalsSchema,
} from './modules/realtime/schemas.ts';
import {
  OPENAPI_FILE,
  REALTIME_SCHEMA_FILE,
  generateOpenApi,
  generateRealtimeSchema,
} from './openapi.ts';
import { startDatabase } from './testing.ts';

const E1 = 1_760_000_000;
/** Monday 2026-10-12, shift A (06:00 Istanbul) starts at 03:00 UTC. */
const at = (time: string): number => Date.parse(`2026-10-12T${time}:00.000Z`);
const iso = (time: string): string => new Date(at(time)).toISOString();
const MINUTE = 60_000;

const feed = new UnsFeed(new Map());

let container: StartedTestContainer;
let db: Kysely<Database>;
/** The API's own pool, with a short statement timeout (as main.ts wires it). */
let readDb: Kysely<Database>;
let app: FastifyInstance;
let ingest: Ingest;
let equipment: Equipment;
let oee: Oee;
let downtime: DowntimeFeed;
let attach: () => Promise<void>;
let base: string;
let seq = 10;

const send = async (...deliveries: { topic: string; payload: string }[]): Promise<void> => {
  for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
};

beforeAll(async () => {
  let serverUrl: string;
  ({ url: serverUrl, container } = await startDatabase());
  const plant = await loadPlantConfig(PLANT_CONFIG);
  if (!plant.ok) throw new Error('plant config');
  db = await freshDatabase(serverUrl, 'realtime');
  const masterData = new MasterData(db);
  await masterData.seed(plant.config);
  const name = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows[0]
    ?.name;
  readDb = createDatabase(serverUrl.replace(/\/shopfloor$/, `/${String(name)}`), 2, {
    statementTimeoutMs: 500,
    connectionTimeoutMs: 500,
  });
  ingest = new Ingest({
    db,
    readDb,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
  });
  equipment = new Equipment({
    db,
    readDb,
    source: ingest,
    shiftPattern: await masterData.shiftPattern(),
    provisionalStepMs: 0,
    downtime: downtimeRules(plant.config),
  });
  await equipment.start();
  oee = new Oee({
    equipment,
    ingest,
    masterData: new MasterData(readDb),
    shiftPattern: await masterData.shiftPattern(),
    config: plant.config.oee,
    idealCycleMs: idealCycleMs(plant.config),
  });
  await oee.start();
  downtime = new DowntimeFeed({ equipment, debounceMs: 20 });
  const http = await buildMesHttp({
    ready: () => Promise.resolve(true),
    push: { clockMs: 50, oeeMs: 200 },
  });
  app = http.app;
  attach = () =>
    http.realtime.attach({
      masterData: new MasterData(readDb),
      equipment,
      ingest,
      oee,
      downtime,
      coding: new DowntimeCoding({ db, equipment, codable: () => Promise.resolve(true) }),
    });
}, 180_000);

afterAll(async () => {
  await app.close();
  oee.stop();
  downtime.stop();
  await equipment.stop();
  await db.destroy();
  await readDb.destroy();
  await container.stop();
});

const get = async (url: string) => {
  const response = await app.inject({ url: `/api/v1${url}` });
  return {
    status: response.statusCode,
    type: response.headers['content-type'],
    body: response.json<unknown>(),
  };
};

/** A WebSocket client that keeps every message and waits for the ones a test expects. */
async function client() {
  const socket = new WebSocket(`${base}${WS_PATH}`);
  const messages: ServerMessage[] = [];
  const received: number[] = [];
  let wake: (() => void) | undefined;
  socket.addEventListener('message', (event) => {
    messages.push(serverMessageSchema.parse(JSON.parse(String(event.data))));
    received.push(performance.now());
    wake?.();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const until = async (
    predicate: (m: ServerMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<ServerMessage> => {
    const deadline = Date.now() + timeoutMs;
    for (let seen = 0; ;) {
      const found = messages.slice(seen).find(predicate);
      if (found) return found;
      seen = messages.length;
      if (Date.now() > deadline) throw new Error(`no such message in ${JSON.stringify(messages)}`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 50);
      });
    }
  };
  return {
    socket,
    messages,
    received,
    until,
    send: (value: unknown) => {
      socket.send(JSON.stringify(value));
    },
  };
}

describe('MES API before the modules are attached', () => {
  it('answers 503 as problem details', async () => {
    const response = await get('/equipment');
    expect(response.status).toBe(503);
    expect(response.type).toMatch(/^application\/problem\+json/);
    expect(problemSchema.parse(response.body)).toMatchObject({
      status: 503,
      instance: '/api/v1/equipment',
    });
  });
});

describe('MES REST API (#97)', () => {
  beforeAll(async () => {
    await attach();
    await send(
      feed.state('cnc-01', E1, 1, at('03:00'), 'Running'),
      feed.state('cnc-01', E1, 2, at('03:40'), 'Stopped', 'jam'),
      feed.state('cnc-01', E1, 3, at('04:20'), 'Running'),
    );
    for (let minute = 0; minute <= 120; minute++) {
      await send(
        feed.telemetry(
          'wsh-01',
          at('03:00') + minute * MINUTE,
          E1,
          'bath-temperature',
          '°C',
          50 + (minute % 30),
        ),
      );
    }
    await send(feed.telemetry('wsh-01', at('04:00'), E1, 'conveyor-speed', 'm/min', 2.5));
  });

  it('lists every equipment of master data with its hierarchy and current state', async () => {
    const response = await get('/equipment');
    expect(response.status).toBe(200);
    const { equipment: list } = equipmentListSchema.parse(response.body);
    expect(list.map((e) => e.id)).toEqual([
      'cnc-01',
      'cnc-02',
      'wsh-01',
      'asm-01',
      'lkt-01',
      'pck-01',
    ]);
    expect(list[0]).toMatchObject({
      site: { id: 'gebze' },
      area: { id: 'machining' },
      workCenter: { id: 'cell-m1' },
      interface: 'opcua',
      current: {
        epoch: E1,
        state: 'Running',
        cause: null,
        since: iso('04:20'),
        seq: 3,
        provisionalUntil: iso('05:00'),
        ageMs: 40 * MINUTE,
      },
    });
    expect(list[1]?.current).toBeNull();
    expect((await get('/equipment/cnc-01')).body).toEqual(list[0]);
  });

  it('answers unknown equipment, routes and bad parameters with problem details', async () => {
    for (const [url, status] of [
      ['/equipment/nope', 404],
      ['/equipment/nope/intervals?from=2026-10-12T03:00:00Z&to=2026-10-12T04:00:00Z', 404],
      ['/nothing', 404],
      ['/equipment/bad%20id', 400],
      ['/equipment?x=1', 400],
      ['/equipment/cnc-01/intervals?from=2026-10-12T04:00:00Z&to=2026-10-12T03:00:00Z', 400],
      ['/equipment/cnc-01/intervals?from=2026-10-01T00:00:00Z&to=2026-10-12T00:00:00Z', 400],
      ['/equipment/cnc-01/intervals?from=yesterday&to=2026-10-12T00:00:00Z', 400],
      [
        '/equipment/wsh-01/telemetry?from=2026-10-12T03:00:00Z&to=2026-10-12T05:00:00Z&maxPoints=1',
        400,
      ],
      [
        '/equipment/wsh-01/telemetry?from=2026-10-12T03:00:00Z&to=2026-10-12T05:00:00Z&metric=x',
        404,
      ],
      ['/shifts/12-10-2026/A/totals', 400],
      ['/shifts/2026-13-45/A/totals', 400],
      ['/shifts/2026-02-30/A/totals', 400],
      ['/shifts/2026-10-12/Z/totals', 404],
    ] as const) {
      const response = await get(url);
      expect([url, response.status]).toEqual([url, status]);
      expect(response.type).toMatch(/^application\/problem\+json/);
      const body = problemSchema.parse(response.body);
      expect(body.detail).not.toMatch(/postgres|password|select/i);
    }
    expect(problemSchema.parse((await get('/equipment?x=1')).body).detail).toMatch(/querystring/);
  });

  it('returns state intervals with the hour and shift pieces merged, clipped to the range', async () => {
    const response = await get(
      `/equipment/cnc-01/intervals?from=${iso('03:10')}&to=${iso('05:00')}`,
    );
    expect(response.status).toBe(200);
    const body = intervalsSchema.parse(response.body);
    expect(body.truncated).toBe(false);
    expect(body.next).toBeNull();
    expect(
      body.intervals.map((i) => [
        i.start,
        i.end,
        i.state,
        i.cause,
        i.provisional,
        i.intervalStart,
        i.startSeq,
      ]),
    ).toEqual([
      [iso('03:10'), iso('03:40'), 'Running', null, false, iso('03:00'), 1],
      // Stored as two pieces, cut at 04:00 UTC; returned as one interval.
      [iso('03:40'), iso('04:20'), 'Stopped', 'jam', false, iso('03:40'), 2],
      [iso('04:20'), iso('05:00'), 'Running', null, true, iso('04:20'), 3],
    ]);
  });

  it('lists telemetry metrics and returns series decimated into time buckets', async () => {
    const metrics = metricsSchema.parse((await get('/equipment/wsh-01/telemetry/metrics')).body);
    expect(metrics.metrics).toEqual([
      { metric: 'bath-temperature', unit: '°C', latest: { t: iso('05:00'), value: 50 } },
      { metric: 'conveyor-speed', unit: 'm/min', latest: { t: iso('04:00'), value: 2.5 } },
    ]);
    const response = await get(
      `/equipment/wsh-01/telemetry?metric=bath-temperature&from=${iso('03:00')}&to=${iso('05:00')}&maxPoints=4`,
    );
    expect(response.status).toBe(200);
    const series = seriesSchema.parse(response.body);
    expect(series.bucketMs).toBe(30 * MINUTE);
    expect(series.series).toHaveLength(1);
    expect(series.series[0]?.unit).toBe('°C');
    expect(series.series[0]?.points.map((p) => [p.t, p.min, p.max, p.n])).toEqual([
      [iso('03:00'), 50, 79, 30],
      [iso('03:30'), 50, 79, 30],
      [iso('04:00'), 50, 79, 30],
      [iso('04:30'), 50, 79, 30],
    ]);
    expect(series.series[0]?.points[0]?.avg).toBeCloseTo(64.5, 9);
    const both = seriesSchema.parse(
      (await get(`/equipment/wsh-01/telemetry?from=${iso('03:00')}&to=${iso('05:01')}`)).body,
    );
    expect(both.series.map((s) => [s.metric, s.points.reduce((n, p) => n + p.n, 0)])).toEqual([
      ['bath-temperature', 121],
      ['conveyor-speed', 1],
    ]);
  });

  it('returns time per state of a shift, and the plant clock', async () => {
    const totals = shiftTotalsSchema.parse(
      (await get('/shifts/2026-10-12/A/totals?equipment=cnc-01')).body,
    );
    expect(totals).toEqual({
      shiftKey: '2026-10-12/A',
      totals: [
        {
          equipment: 'cnc-01',
          epoch: E1,
          state: 'Running',
          ms: 80 * MINUTE,
          provisionalMs: 40 * MINUTE,
          revision: 0,
          incidents: 0,
        },
        {
          equipment: 'cnc-01',
          epoch: E1,
          state: 'Stopped',
          ms: 40 * MINUTE,
          provisionalMs: 0,
          revision: 0,
          incidents: 0,
        },
      ],
    });
    expect(plantSchema.parse((await get('/plant')).body)).toEqual({
      site: { id: 'gebze', name: 'Gebze', enterprise: { id: 'orbis', name: 'Orbis Components' } },
      clock: { epoch: E1, watermark: iso('05:00') },
      epochs: [{ epoch: E1, watermark: iso('05:00') }],
    });
  });

  it('answers 503 when a read hits the statement timeout, and never delays ingest', async () => {
    // A lock held elsewhere makes the API's read wait past its 500 ms statement timeout.
    await db.transaction().execute(async (trx) => {
      await sql`LOCK TABLE equipment.equipment_state_interval IN ACCESS EXCLUSIVE MODE`.execute(
        trx,
      );
      const response = await get(
        `/equipment/cnc-01/intervals?from=${iso('03:00')}&to=${iso('05:00')}`,
      );
      expect(response.status).toBe(503);
      expect(problemSchema.parse(response.body).detail).toBe('the database is busy; try again');
    });
    expect((await get(`/shifts/2026-10-12/A/totals`)).status).toBe(200);
  });

  it('returns OEE per hour and per shift, for an equipment and a work center (#120)', async () => {
    const hours = oeeListSchema.parse(
      (
        await get(
          `/oee?scope=equipment&id=cnc-01&bucket=hour&from=${iso('03:00')}&to=${iso('05:00')}`,
        )
      ).body,
    );
    // No aggregate refresher in this test: nothing is final.
    expect(hours.buckets.map((b) => [b.key, b.shiftKey, b.final])).toEqual([
      [iso('03:00'), '2026-10-12/A', false],
      [iso('04:00'), '2026-10-12/A', false],
    ]);
    // 03:00: Running 40 min and 20 min of a 40-min stop (availability loss); nothing produced.
    expect(hours.buckets[0]?.inputs.stateMs).toMatchObject({
      Running: 40 * MINUTE,
      Stopped: 20 * MINUTE,
      Down: 0,
    });
    expect(hours.buckets[0]?.result.availability).toEqual({ fraction: '2/3', decimal: '0.6667' });
    expect(hours.buckets[0]?.result.quality).toBeNull();
    expect(hours.buckets[0]?.result.oee).toEqual({ fraction: '0/1', decimal: '0.0000' });
    expect(hours.buckets[0]?.result.losses?.availability.own.stopped).toBe(20 * MINUTE);

    const shift = oeeListSchema.parse(
      (
        await get(
          `/oee?scope=work-center&id=cell-m1&bucket=shift&from=${iso('03:00')}&to=${iso('04:00')}`,
        )
      ).body,
    );
    expect(
      shift.buckets.map((b) => [b.key, b.start, b.end, b.members.map((m) => m.equipment)]),
    ).toEqual([['2026-10-12/A', iso('03:00'), iso('11:00'), ['cnc-01']]]);
    expect(shift.buckets[0]?.result.totals.plannedBusyMs).toBe(120 * MINUTE);

    const all = shiftOeeSchema.parse((await get('/shifts/2026-10-12/A/oee')).body);
    expect([all.shiftKey, all.start, all.end]).toEqual([
      '2026-10-12/A',
      iso('03:00'),
      iso('11:00'),
    ]);
    expect(all.equipment.map((b) => b.id)).toEqual(['cnc-01']);
    expect(all.workCenters.map((b) => b.id)).toEqual(['cell-m1']);
    // Cell M1 has data of CNC-01 only: the same result, not final (its machines are missing).
    expect(all.workCenters[0]?.result).toEqual(all.equipment[0]?.result);
    expect(all.workCenters[0]?.final).toBe(false);
  });

  it('lists shifts, the current shift, reason codes, downtime records and the Pareto (#120)', async () => {
    const shifts = shiftListSchema.parse(
      (await get('/shifts?from=2026-10-16T00:00:00Z&to=2026-10-19T00:00:00Z')).body,
    );
    // Friday: Thursday's night shift ends at 06:00 Istanbul; the weekend has none.
    expect(shifts.shifts.map((s) => s.key)).toEqual([
      '2026-10-15/C',
      '2026-10-16/A',
      '2026-10-16/B',
      '2026-10-16/C',
    ]);
    expect(shifts.shifts[1]).toEqual({
      key: '2026-10-16/A',
      date: '2026-10-16',
      shift: 'A',
      start: '2026-10-16T03:00:00.000Z',
      end: '2026-10-16T11:00:00.000Z',
      breaks: [{ start: '2026-10-16T07:00:00.000Z', end: '2026-10-16T07:30:00.000Z' }],
    });
    const current = currentShiftSchema.parse((await get('/shifts/current')).body);
    expect(current).toMatchObject({
      clock: { epoch: E1, watermark: iso('05:00') },
      shiftKey: '2026-10-12/A',
      shift: { key: '2026-10-12/A', start: iso('03:00') },
    });

    const reasons = reasonCodesSchema.parse((await get('/reason-codes')).body).reasons;
    expect(reasons.find((r) => r.id === 'BREAKDOWN/SPINDLE-OVERLOAD')).toMatchObject({
      parent: 'BREAKDOWN',
      active: true,
    });
    expect(reasons.some((r) => r.id === 'UNCODED')).toBe(true);

    const records = downtimeListSchema.parse(
      (await get(`/downtime?equipment=cnc-01&from=${iso('03:00')}&to=${iso('05:00')}`)).body,
    );
    expect(records.truncated).toBe(false);
    expect(records.records).toEqual([
      {
        id: `cnc-01~${String(E1)}~${String(at('03:40'))}`,
        equipment: 'cnc-01',
        epoch: E1,
        start: iso('03:40'),
        end: iso('04:20'),
        intervalStart: iso('03:40'),
        shiftKey: '2026-10-12/A',
        state: 'Stopped',
        cause: 'jam',
        loss: 'own',
        autoReason: 'UNCODED',
        reason: 'UNCODED',
        provisional: false,
        ms: 40 * MINUTE,
        segments: [{ from: iso('03:40'), to: iso('04:20'), reason: 'UNCODED', coded: false }],
        codings: [],
        uncoded: true,
        version: 0,
      },
    ]);
    const uncoded = downtimeListSchema.parse(
      (await get(`/downtime?from=${iso('03:00')}&to=${iso('05:00')}&uncoded=true`)).body,
    );
    expect(uncoded.records.map((r) => r.id)).toEqual(records.records.map((r) => r.id));

    const loss = paretoSchema.parse(
      (
        await get(
          `/downtime/pareto?scope=work-center&id=cell-m1&from=${iso('03:00')}&to=${iso('04:00')}`,
        )
      ).body,
    );
    expect(loss).toMatchObject({
      members: [{ equipment: 'cnc-01', epoch: E1 }],
      availability: { own: 20 * MINUTE, external: 0 },
      reasons: [{ reason: 'UNCODED', name: 'Not coded', loss: 'own', ms: 20 * MINUTE, records: 1 }],
      microStops: [],
    });
  });

  it('answers bad OEE, shift and downtime requests with problem details (#120)', async () => {
    const range = `from=${iso('03:00')}&to=${iso('05:00')}`;
    const week = 'from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:00Z';
    for (const [url, status] of [
      [`/oee?scope=equipment&id=nope&bucket=hour&${range}`, 404],
      [`/oee?scope=work-center&id=cnc-01&bucket=hour&${range}`, 404],
      [`/oee?scope=machine&id=cnc-01&bucket=hour&${range}`, 400],
      [`/oee?scope=equipment&id=cnc-01&bucket=day&${range}`, 400],
      [`/oee?scope=equipment&id=cnc-01&bucket=hour&${week}`, 400],
      [`/oee?scope=equipment&id=cnc-01&bucket=shift&${week}`, 200],
      [`/oee?scope=equipment&id=cnc-01&bucket=hour&${range}&epoch=x`, 400],
      ['/shifts/2026-10-17/A/oee', 404],
      ['/shifts/2026-10-12/Z/oee', 404],
      ['/shifts?from=2026-10-12T05:00:00Z&to=2026-10-12T03:00:00Z', 400],
      [`/downtime?equipment=nope&${range}`, 404],
      [`/downtime?${range}&uncoded=yes`, 400],
      [`/downtime/pareto?scope=work-center&id=nope&${range}`, 404],
      ['/reason-codes?inactive=1', 400],
    ] as const) {
      const response = await get(url);
      expect([url, response.status]).toEqual([url, status]);
      if (status !== 200) expect(response.type).toMatch(/^application\/problem\+json/);
    }
  });

  it('refuses Host headers outside the allowlist (DNS rebinding)', async () => {
    for (const [host, status] of [
      ['evil.example', 403],
      ['evil.example:4700', 403],
      ['127.0.0.1:4700', 200],
      ['[::1]:4700', 200],
    ] as const) {
      const response = await app.inject({ url: '/api/v1/plant', headers: { host } });
      expect([host, response.statusCode]).toEqual([host, status]);
    }
  });

  it('keeps the committed OpenAPI description and message schemas in step with the code', async () => {
    expect(await readFile(OPENAPI_FILE, 'utf8')).toBe(await generateOpenApi());
    expect(await readFile(REALTIME_SCHEMA_FILE, 'utf8')).toBe(generateRealtimeSchema());
  });
});

describe('MES WebSocket push (#97)', () => {
  beforeAll(async () => {
    base = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http', 'ws');
  });

  it('sends snapshots, then state and telemetry deltas, until unsubscribed and closed', async () => {
    const ws = await client();
    ws.send({ type: 'subscribe', topic: 'states' });
    const snapshot = await ws.until((m) => m.type === 'snapshot');
    expect(snapshot).toMatchObject({
      topic: 'states',
      clock: { epoch: E1 },
      states: [{ equipment: 'cnc-01', current: { state: 'Running', seq: 3 } }],
    });
    await send(feed.state('cnc-01', E1, 4, at('05:10'), 'Down', 'spindle'));
    expect(await ws.until((m) => m.type === 'state')).toMatchObject({
      equipment: 'cnc-01',
      current: { state: 'Down', cause: 'spindle', since: iso('05:10'), seq: 4 },
    });
    expect(await ws.until((m) => m.type === 'clock' && m.watermark === iso('05:10'))).toBeDefined();

    ws.send({ type: 'subscribe', topic: 'telemetry:wsh-01', metric: 'bath-temperature' });
    expect(
      await ws.until((m) => m.type === 'snapshot' && m.topic === 'telemetry:wsh-01'),
    ).toMatchObject({
      samples: [{ equipment: 'wsh-01', metric: 'bath-temperature', t: iso('05:00'), value: 50 }],
    });
    await send(
      feed.telemetry('wsh-01', at('05:11'), E1, 'conveyor-speed', 'm/min', 3),
      feed.telemetry('wsh-01', at('05:11'), E1, 'bath-temperature', '°C', 61.5),
    );
    expect(await ws.until((m) => m.type === 'telemetry')).toEqual({
      type: 'telemetry',
      equipment: 'wsh-01',
      metric: 'bath-temperature',
      unit: '°C',
      t: iso('05:11'),
      value: 61.5,
    });

    ws.send({ type: 'unsubscribe', topic: 'telemetry:wsh-01' });
    await ws.until((m) => m.type === 'unsubscribed');
    const mark = ws.messages.length;
    await send(
      feed.telemetry('wsh-01', at('05:12'), E1, 'bath-temperature', '°C', 62),
      feed.state('cnc-01', E1, 5, at('05:12'), 'Running'),
    );
    await ws.until((m) => m.type === 'state' && m.current.seq === 5);
    expect(ws.messages.slice(mark).some((m) => m.type === 'telemetry')).toBe(false);

    ws.send({ type: 'subscribe', topic: 'telemetry:nope' });
    expect(await ws.until((m) => m.type === 'error')).toMatchObject({ code: 'unknown-equipment' });
    expect(app.websocketServer.clients.size).toBe(1);
    ws.socket.close();
    await expect.poll(() => app.websocketServer.clients.size).toBe(0);
  });

  it('pushes the 60x live rate (about 25 messages/s) within the 2 s budget of exit criterion 3', async () => {
    const ws = await client();
    ws.send({ type: 'subscribe', topic: 'states' });
    ws.send({ type: 'subscribe', topic: 'telemetry:wsh-01' });
    await ws.until((m) => m.type === 'snapshot' && m.topic === 'telemetry:wsh-01');
    const sentAt = new Map<string, number>();
    const states = ['Running', 'Stopped'] as const;
    const t0 = at('06:00');
    const started = performance.now();
    for (let i = 0; i < 75; i++) {
      // Paced at 25 messages/s: two of three are telemetry, one a state change.
      const due = started + i * 40;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - performance.now())));
      const time = t0 + i * 1_000;
      if (i % 3 === 0) {
        seq++;
        sentAt.set(`state:${String(seq)}`, performance.now());
        await send(feed.state('cnc-02', E1, seq, time, states[seq % 2] ?? 'Running'));
      } else {
        sentAt.set(`telemetry:${new Date(time).toISOString()}`, performance.now());
        await send(feed.telemetry('wsh-01', time, E1, 'bath-temperature', '°C', i));
      }
    }
    const keyOf = (m: ServerMessage): string | undefined =>
      m.type === 'state' && m.equipment === 'cnc-02'
        ? `state:${String(m.current.seq)}`
        : m.type === 'telemetry'
          ? `telemetry:${m.t}`
          : undefined;
    await expect
      .poll(() => ws.messages.filter((m) => keyOf(m) !== undefined).length, { timeout: 5_000 })
      .toBe(75);
    const latencies = ws.messages.flatMap((m, index) => {
      const key = keyOf(m);
      const sent = key === undefined ? undefined : sentAt.get(key);
      return sent === undefined ? [] : [(ws.received[index] ?? Infinity) - sent];
    });
    expect(latencies).toHaveLength(75);
    expect(Math.max(...latencies)).toBeLessThan(2_000);
    ws.socket.close();
  });

  it('pushes OEE buckets at most once per interval per topic, and downtime records (#120)', async () => {
    const ws = await client();
    ws.send({ type: 'subscribe', topic: 'oee:cell-m1' });
    const snapshot = await ws.until((m) => m.type === 'snapshot' && m.topic === 'oee:cell-m1');
    expect(snapshot).toMatchObject({
      hour: { scope: 'work-center', id: 'cell-m1', bucket: 'hour' },
      shift: { scope: 'work-center', id: 'cell-m1', bucket: 'shift' },
    });
    ws.send({ type: 'subscribe', topic: 'downtime' });
    await ws.until((m) => m.type === 'subscribed' && m.topic === 'downtime');
    ws.send({ type: 'subscribe', topic: 'oee:nope' });
    expect(await ws.until((m) => m.type === 'error')).toMatchObject({ code: 'unknown-equipment' });
    ws.send({ type: 'subscribe', topic: 'downtime', metric: 'x' });
    expect(await ws.until((m) => m.type === 'error' && m.code === 'invalid-message')).toBeDefined();

    // A breakdown of CNC-01 is a downtime record as soon as it has a length (the clock moves).
    await send(
      feed.state('cnc-01', E1, 6, at('08:00'), 'Down', 'SPINDLE-OVERLOAD'),
      feed.telemetry('wsh-01', at('08:05'), E1),
    );
    expect(
      await ws.until((m) => m.type === 'downtime' && m.record.equipment === 'cnc-01'),
    ).toMatchObject({
      event: 'created',
      record: { equipment: 'cnc-01', end: null, autoReason: 'BREAKDOWN/SPINDLE-OVERLOAD' },
    });
    const delta = await ws.until((m) => m.type === 'oee' && m.hour?.key === iso('08:00'));
    expect(delta).toMatchObject({ topic: 'oee:cell-m1', shift: { key: '2026-10-12/A' } });
    await send(feed.state('cnc-01', E1, 7, at('08:10'), 'Running'));
    expect(
      await ws.until(
        (m) => m.type === 'downtime' && m.event === 'closed' && m.record.equipment === 'cnc-01',
      ),
    ).toMatchObject({ record: { end: iso('08:10'), ms: 10 * MINUTE } });
    // Changes keep coming every 60 ms; the topic's deltas don't.
    for (let i = 1; i <= 6; i++) {
      await send(
        feed.state('cnc-01', E1, 7 + i, at('08:10') + i * MINUTE, i % 2 ? 'Idle' : 'Running'),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await ws.until((m) => m.type === 'oee' && m.hour?.inputs.stateMs.Idle === 3 * MINUTE);
    // At most one delta per topic per interval (200 ms here, 1 s by default).
    const times = ws.messages.flatMap((m, i) => (m.type === 'oee' ? [ws.received[i] ?? 0] : []));
    expect(times.length).toBeGreaterThan(1);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(150);
    }
    ws.socket.close();
  });

  it('refuses a WebSocket from another origin, accepts one from its own host or without Origin', async () => {
    const { hostname, port } = new URL(base.replace('ws', 'http'));
    const upgrade = (origin?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: hostname,
          port,
          path: WS_PATH,
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
            ...(origin === undefined ? {} : { Origin: origin }),
          },
        });
        req.on('upgrade', (response, socket) => {
          socket.destroy();
          resolve(response.statusCode ?? 0);
        });
        req.on('response', (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await upgrade('http://evil.example')).toBe(403);
    expect(await upgrade(`http://${hostname}:${port}`)).toBe(101);
    expect(await upgrade()).toBe(101);
  });
});
