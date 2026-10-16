/**
 * Downtime coding writes (#121, ADR-0023): the write guards with each refusal, coding with
 * splits and optimistic concurrency, clipping and orphaning after a re-cut, the append-only
 * audit, the Pareto changing while OEE does not, the `recoded` push, and `MES_WRITES=off`.
 */
import { idealCycleMs, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import {
  DowntimeCoding,
  Equipment,
  clipToRecords,
  downtimeRules,
  type CodingChange,
} from './modules/equipment/index.ts';
import { PLANT_CONFIG, UnsFeed, freshDatabase } from './modules/equipment/test-support.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import { DowntimeFeed, Oee } from './modules/oee/index.ts';
import {
  WS_PATH,
  WriteLimiter,
  serverMessageSchema,
  type ApiSources,
  type ServerMessage,
} from './modules/realtime/index.ts';
import {
  codingResultSchema,
  downtimeAuditSchema,
  downtimeListSchema,
  oeeListSchema,
  paretoSchema,
  problemSchema,
} from './modules/realtime/schemas.ts';
import { startDatabase } from './testing.ts';

const E1 = 1_760_000_000;
const MINUTE = 60_000;
/** Monday 2026-10-12, shift A (06:00 Istanbul) starts at 03:00 UTC. */
const at = (time: string): number => Date.parse(`2026-10-12T${time}:00.000Z`);
const iso = (time: string): string => new Date(at(time)).toISOString();
const feed = new UnsFeed(new Map());

const HOST = 'localhost:4700';
const ORIGIN = `http://${HOST}`;
const JSON_WRITE = { host: HOST, origin: ORIGIN, 'content-type': 'application/json' };

let container: StartedTestContainer;
let plant: PlantConfig;
let db: Kysely<Database>;
let ingest: Ingest;
let equipment: Equipment;
let oee: Oee;
let downtime: DowntimeFeed;
let coding: DowntimeCoding;
let sources: ApiSources;
let app: FastifyInstance;
const apps: FastifyInstance[] = [];

const send = async (...deliveries: { topic: string; payload: string }[]): Promise<void> => {
  for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
};

/** Another MES HTTP front over the same modules (other options). */
async function front(options: Parameters<typeof buildMesHttp>[0]): Promise<FastifyInstance> {
  const http = await buildMesHttp(options);
  await http.realtime.attach(sources);
  apps.push(http.app);
  return http.app;
}

beforeAll(async () => {
  let url: string;
  ({ url, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  db = await freshDatabase(url, 'coding');
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  ingest = new Ingest({ db, url: 'mqtt://127.0.0.1:1', username: 'mes', password: 'unused' });
  equipment = new Equipment({
    db,
    source: ingest,
    shiftPattern: await masterData.shiftPattern(),
    provisionalStepMs: 0,
    downtime: downtimeRules(plant),
  });
  await equipment.start();
  oee = new Oee({
    equipment,
    ingest,
    masterData,
    shiftPattern: await masterData.shiftPattern(),
    config: plant.oee,
    idealCycleMs: idealCycleMs(plant),
  });
  await oee.start();
  coding = new DowntimeCoding({
    db,
    equipment,
    codable: async (reason) =>
      (await masterData.reasonCodes()).some((r) => r.id === reason && r.active),
    debounceMs: 10,
  });
  await coding.start();
  downtime = new DowntimeFeed({ equipment, codings: coding, debounceMs: 20 });
  sources = {
    masterData,
    equipment,
    ingest,
    oee,
    downtime,
    coding: {
      code: (key, request) => coding.code(key, request),
      audit: (key) => coding.audit(key),
    },
  };
  // A high write rate here: the global limit has its own test below.
  app = await front({
    ready: () => Promise.resolve(true),
    push: { clockMs: 50, oeeMs: 100 },
    writeRate: { perSecond: 1000, burst: 1000 },
  });

  // CNC-01 in shift A: a breakdown 03:40-04:20, a long stop 05:00-05:30 (UNCODED), cycles.
  await send(
    feed.state('cnc-01', E1, 1, at('03:00'), 'Running'),
    feed.cycle('cnc-01', E1, 2, at('03:20')),
    feed.state('cnc-01', E1, 3, at('03:40'), 'Down', 'SPINDLE-OVERLOAD'),
    feed.state('cnc-01', E1, 4, at('04:20'), 'Running'),
    feed.cycle('cnc-01', E1, 5, at('04:40')),
    feed.state('cnc-01', E1, 6, at('05:00'), 'Stopped', 'jam'),
    feed.state('cnc-01', E1, 7, at('05:30'), 'Running'),
    feed.cycle('cnc-01', E1, 8, at('05:50'), {
      product: 'VB-100',
      partId: 8,
      serial: 'S-8',
      result: 'scrap',
    }),
    feed.telemetry('wsh-01', at('06:00'), E1),
  );
  await equipment.flush();
}, 180_000);

afterAll(async () => {
  for (const each of apps) await each.close();
  coding.stop();
  downtime.stop();
  oee.stop();
  await equipment.stop();
  await db.destroy();
  await container.stop();
});

const STOP_ID = `cnc-01~${String(E1)}~${String(at('05:00'))}`;
const DOWN_ID = `cnc-01~${String(E1)}~${String(at('03:40'))}`;

const records = async (equipmentId = 'cnc-01', target = app) => {
  const response = await target.inject({
    url: `/api/v1/downtime?equipment=${equipmentId}&from=${iso('03:00')}&to=${iso('07:00')}`,
    headers: { host: HOST },
  });
  return downtimeListSchema.parse(response.json()).records;
};

const put = (
  id: string,
  body: unknown,
  headers: Record<string, string> = JSON_WRITE,
  target = app,
) =>
  target.inject({
    method: 'PUT',
    url: `/api/v1/downtime/${id}/coding`,
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

const version = async (id: string): Promise<number> =>
  (await records(id.split('~')[0])).find((r) => r.id === id)?.version ?? -1;

describe('write guards (ADR-0023)', () => {
  const valid = () => ({ segments: [], codedBy: 'guard test', version: 0 });

  it('refuses a write without Origin, from another origin or site, or not as JSON', async () => {
    for (const [name, headers, status, detail] of [
      ['no Origin', { host: HOST, 'content-type': 'application/json' }, 403, /needs an Origin/],
      [
        'foreign Origin',
        { ...JSON_WRITE, origin: 'http://evil.example' },
        403,
        /origin not allowed/,
      ],
      ['other port', { ...JSON_WRITE, origin: 'http://localhost:5173' }, 403, /origin not allowed/],
      ['null Origin', { ...JSON_WRITE, origin: 'null' }, 403, /origin not allowed/],
      ['Origin with a path', { ...JSON_WRITE, origin: `${ORIGIN}/` }, 403, /origin not allowed/],
      [
        'Origin with userinfo',
        { ...JSON_WRITE, origin: `http://u@${HOST}` },
        403,
        /origin not allowed/,
      ],
      [
        'cross-site fetch',
        { ...JSON_WRITE, 'sec-fetch-site': 'cross-site' },
        403,
        /Sec-Fetch-Site/,
      ],
      ['same-site fetch', { ...JSON_WRITE, 'sec-fetch-site': 'same-site' }, 403, /Sec-Fetch-Site/],
      ['foreign Host', { ...JSON_WRITE, host: 'evil.example:4700' }, 403, /host not allowed/],
      [
        'form',
        { ...JSON_WRITE, 'content-type': 'application/x-www-form-urlencoded' },
        415,
        /application\/json/,
      ],
      ['text', { ...JSON_WRITE, 'content-type': 'text/plain' }, 415, /application\/json/],
      [
        'multipart',
        { ...JSON_WRITE, 'content-type': 'multipart/form-data; boundary=x' },
        415,
        /json/,
      ],
      ['no type', { host: HOST, origin: ORIGIN }, 415, /application\/json/],
    ] as const) {
      const response = await put(STOP_ID, valid(), { ...headers });
      expect([name, response.statusCode]).toEqual([name, status]);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemSchema.parse(response.json()).detail).toMatch(detail);
      // No CORS: nothing tells a browser another origin may read or send.
      expect(Object.keys(response.headers).filter((h) => h.startsWith('access-control-'))).toEqual(
        [],
      );
    }
    // Nothing was written by any of them.
    expect(await version(STOP_ID)).toBe(0);
  });

  it('accepts its own origin whatever the scheme, JSON with a charset, and same-origin fetches', async () => {
    for (const headers of [
      JSON_WRITE,
      { ...JSON_WRITE, origin: `https://${HOST}` },
      { ...JSON_WRITE, 'content-type': 'application/json; charset=utf-8' },
      { ...JSON_WRITE, 'sec-fetch-site': 'same-origin' },
    ]) {
      const response = await put(STOP_ID, { ...valid(), version: await version(STOP_ID) }, headers);
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('answers a CORS preflight and other methods without CORS headers', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: `/api/v1/downtime/${STOP_ID}/coding`,
      headers: {
        host: HOST,
        origin: 'http://evil.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/downtime/${STOP_ID}/coding`,
      headers: JSON_WRITE,
      payload: '{}',
    });
    expect(post.statusCode).toBe(404);
  });

  it('limits the body to 16 KiB and parses it strictly', async () => {
    const big = await put(STOP_ID, { ...valid(), codedBy: 'x'.repeat(17 * 1024) });
    expect(big.statusCode).toBe(413);
    expect(big.headers['content-type']).toMatch(/^application\/problem\+json/);
    for (const body of [
      '{not json',
      { ...valid(), extra: 1 },
      { ...valid(), codedBy: ' ' },
      { ...valid(), version: -1 },
      {
        segments: [{ from: 'yesterday', to: iso('05:10'), reason: 'MATERIAL' }],
        codedBy: 'a',
        version: 0,
      },
    ]) {
      const response = await put(STOP_ID, body);
      expect([body, response.statusCode]).toEqual([body, 400]);
    }
    expect((await put('nope', valid())).statusCode).toBe(400);
    for (const id of [`cnc-01~${String(E1)}~${String(at('05:01'))}`, `zzz~1~1`]) {
      expect((await put(id, valid())).statusCode).toBe(404);
    }
  });

  it('takes an allowlisted origin, and limits writes globally', async () => {
    const limited = await front({
      ready: () => Promise.resolve(true),
      allowedOrigins: ['http://127.0.0.1:5173'],
      writeRate: { perSecond: 1, burst: 2 },
    });
    const headers = { ...JSON_WRITE, origin: 'http://127.0.0.1:5173' };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await put(
        STOP_ID,
        { ...valid(), version: await version(STOP_ID) },
        headers,
        limited,
      );
      statuses.push(response.statusCode);
      if (response.statusCode === 429) expect(response.headers['retry-after']).toBe('1');
    }
    expect(statuses).toEqual([200, 200, 429]);
    // Reads are not limited.
    expect((await records('cnc-01', limited)).length).toBeGreaterThan(0);
  });

  it('refills the write bucket over time', () => {
    const bucket = new WriteLimiter(2, 2, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([undefined, undefined, 1]);
    expect(bucket.take(499)).toBe(1);
    expect(bucket.take(500)).toBeUndefined();
  });

  it('answers every write with 405 when MES_WRITES=off, and still reads', async () => {
    const off = await front({ ready: () => Promise.resolve(true), writes: false });
    const before = await version(STOP_ID);
    const response = await put(STOP_ID, { ...valid(), version: before }, JSON_WRITE, off);
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
    expect(problemSchema.parse(response.json()).detail).toMatch(/MES_WRITES=off/);
    // Before any other write guard (but after the Host check).
    const foreign = { ...JSON_WRITE, origin: 'http://evil.example' };
    expect((await put(STOP_ID, valid(), foreign, off)).statusCode).toBe(405);
    expect(
      (await put(STOP_ID, valid(), { ...foreign, host: 'evil.example' }, off)).statusCode,
    ).toBe(403);
    const other = await off.inject({
      method: 'DELETE',
      url: '/api/v1/equipment',
      headers: JSON_WRITE,
    });
    expect(other.statusCode).toBe(405);
    expect(await version(STOP_ID)).toBe(before);
    expect((await records('cnc-01', off)).length).toBe(2);
  });
});

describe('coding downtime records (#121)', () => {
  it('shows records with their reasons in effect, codings and version', async () => {
    const list = await records();
    const stop = list.find((r) => r.id === STOP_ID);
    // Records with uncoded time come first.
    expect(list.map((r) => r.id)).toEqual([STOP_ID, DOWN_ID]);
    expect(stop).toMatchObject({
      autoReason: 'UNCODED',
      reason: 'UNCODED',
      uncoded: true,
      codings: [],
      segments: [{ from: iso('05:00'), to: iso('05:30'), reason: 'UNCODED', coded: false }],
    });
  });

  it('codes, splits, refuses a stale version with 409, and clears', async () => {
    const v0 = await version(STOP_ID);
    // One reason for part of the stop: the rest keeps the auto reason.
    const first = await put(STOP_ID, {
      segments: [
        { from: iso('05:00'), to: iso('05:10'), reason: 'MATERIAL', comment: 'no blanks' },
      ],
      codedBy: 'Ayşe',
      version: v0,
    });
    expect(first.statusCode).toBe(200);
    const coded = codingResultSchema.parse(first.json());
    expect(coded.version).toBe(v0 + 1);
    expect(coded.record).toMatchObject({
      id: STOP_ID,
      reason: 'UNCODED',
      uncoded: true,
      version: v0 + 1,
      segments: [
        { from: iso('05:00'), to: iso('05:10'), reason: 'MATERIAL', coded: true },
        { from: iso('05:10'), to: iso('05:30'), reason: 'UNCODED', coded: false },
      ],
      codings: [
        {
          from: iso('05:00'),
          to: iso('05:10'),
          reason: 'MATERIAL',
          comment: 'no blanks',
          codedBy: 'Ayşe',
        },
      ],
    });

    // A second client still holding v0 loses.
    const stale = await put(STOP_ID, {
      segments: [{ from: iso('05:00'), to: iso('05:30'), reason: 'MINOR-STOP/CHIP-JAM' }],
      codedBy: 'Mehmet',
      version: v0,
    });
    expect(stale.statusCode).toBe(409);
    expect(problemSchema.parse(stale.json()).detail).toMatch(/version is \d+, not \d+/);

    // A split: two codings cover the whole stop; the larger names the record.
    const split = codingResultSchema.parse(
      (
        await put(STOP_ID, {
          segments: [
            { from: iso('05:10'), to: iso('05:30'), reason: 'MINOR-STOP/CHIP-JAM' },
            { from: iso('05:00'), to: iso('05:10'), reason: 'MATERIAL' },
          ],
          codedBy: 'Mehmet',
          version: v0 + 1,
        })
      ).json(),
    );
    expect(split.record).toMatchObject({
      reason: 'MINOR-STOP/CHIP-JAM',
      uncoded: false,
      segments: [
        { from: iso('05:00'), to: iso('05:10'), reason: 'MATERIAL', coded: true },
        { from: iso('05:10'), to: iso('05:30'), reason: 'MINOR-STOP/CHIP-JAM', coded: true },
      ],
    });
    // A fully coded record is no longer in the uncoded list.
    const uncoded = await app.inject({
      url: `/api/v1/downtime?from=${iso('03:00')}&to=${iso('07:00')}&uncoded=true`,
      headers: { host: HOST },
    });
    expect(downtimeListSchema.parse(uncoded.json()).records.map((r) => r.id)).toEqual([]);

    // Clearing restores the auto reason.
    const cleared = codingResultSchema.parse(
      (await put(STOP_ID, { segments: [], codedBy: 'Mehmet', version: split.version })).json(),
    );
    expect(cleared.record).toMatchObject({ reason: 'UNCODED', codings: [], uncoded: true });
  });

  it('refuses segments outside the record, overlapping, or with a reason that is not codable', async () => {
    const v = await version(DOWN_ID);
    for (const [segments, detail] of [
      [[{ from: iso('03:30'), to: iso('03:50'), reason: 'MATERIAL' }], /lie in the record/],
      [[{ from: iso('04:00'), to: iso('04:30'), reason: 'MATERIAL' }], /lie in the record/],
      [[{ from: iso('04:00'), to: iso('04:00'), reason: 'MATERIAL' }], /end after it starts/],
      [
        [
          { from: iso('03:40'), to: iso('04:00'), reason: 'MATERIAL' },
          { from: iso('03:50'), to: iso('04:20'), reason: 'MATERIAL' },
        ],
        /overlap/,
      ],
      [[{ from: iso('03:40'), to: iso('04:00'), reason: 'UNCODED' }], /not an active reason/],
      [[{ from: iso('03:40'), to: iso('04:00'), reason: 'NO-SUCH' }], /not an active reason/],
    ] as const) {
      const response = await put(DOWN_ID, { segments, codedBy: 'x', version: v });
      expect([segments, response.statusCode]).toEqual([segments, 422]);
      expect(problemSchema.parse(response.json()).detail).toMatch(detail);
    }
    expect(await version(DOWN_ID)).toBe(v);
  });

  it('audits every write with actor, request id and before/after, append-only', async () => {
    const v = await version(DOWN_ID);
    const response = await put(DOWN_ID, {
      segments: [{ from: iso('03:40'), to: iso('04:20'), reason: 'BREAKDOWN/COOLANT-PRESSURE' }],
      codedBy: 'Zeynep',
      version: v,
    });
    expect(response.statusCode).toBe(200);
    const audit = downtimeAuditSchema.parse(
      (
        await app.inject({ url: `/api/v1/downtime/${DOWN_ID}/audit`, headers: { host: HOST } })
      ).json(),
    );
    expect(audit.record).toBe(DOWN_ID);
    expect(audit.entries[0]).toMatchObject({
      recordId: DOWN_ID,
      action: 'coded',
      actor: 'Zeynep',
      authenticated: false,
      requestId: response.headers['x-request-id'],
      version: v + 1,
      from: iso('03:40'),
      to: iso('04:20'),
      before: [],
      after: [
        {
          from: iso('03:40'),
          to: iso('04:20'),
          reason: 'BREAKDOWN/COOLANT-PRESSURE',
          codedBy: 'Zeynep',
        },
      ],
    });
    const stopAudit = downtimeAuditSchema.parse(
      (
        await app.inject({ url: `/api/v1/downtime/${STOP_ID}/audit`, headers: { host: HOST } })
      ).json(),
    );
    // Newest first: the clear of the test above, after its split and its first coding.
    expect(stopAudit.entries.slice(0, 3).map((e) => [e.action, e.actor])).toEqual([
      ['cleared', 'Mehmet'],
      ['coded', 'Mehmet'],
      ['coded', 'Ayşe'],
    ]);
    expect(stopAudit.entries[1]?.before.map((c) => c.reason)).toEqual(['MATERIAL']);
    const missing = await app.inject({
      url: `/api/v1/downtime/cnc-01~${String(E1)}~1/audit`,
      headers: { host: HOST },
    });
    expect(missing.statusCode).toBe(404);

    // Append-only, whoever connects (the MES owns the table, so REVOKE would not bind it).
    await expect(
      sql`UPDATE equipment.downtime_audit SET actor = 'mallory'`.execute(db),
    ).rejects.toThrow(/append-only \(UPDATE refused\)/);
    await expect(sql`DELETE FROM equipment.downtime_audit`.execute(db)).rejects.toThrow(
      /append-only \(DELETE refused\)/,
    );
    await expect(sql`TRUNCATE equipment.downtime_audit`.execute(db)).rejects.toThrow(
      /append-only \(TRUNCATE refused\)/,
    );
  });

  it('changes the Pareto and the reason view, never OEE', async () => {
    const shiftQuery = `/api/v1/oee?scope=equipment&id=cnc-01&bucket=shift&from=${iso('03:00')}&to=${iso('11:00')}`;
    const hourQuery = `/api/v1/oee?scope=equipment&id=cnc-01&bucket=hour&from=${iso('03:00')}&to=${iso('07:00')}`;
    const paretoQuery = `/api/v1/downtime/pareto?scope=work-center&id=cell-m1&from=${iso('03:00')}&to=${iso('11:00')}`;
    const read = async () => ({
      shift: oeeListSchema.parse(
        (await app.inject({ url: shiftQuery, headers: { host: HOST } })).json(),
      ),
      hours: oeeListSchema.parse(
        (await app.inject({ url: hourQuery, headers: { host: HOST } })).json(),
      ),
      pareto: paretoSchema.parse(
        (await app.inject({ url: paretoQuery, headers: { host: HOST } })).json(),
      ),
    });
    const before = await read();
    expect(before.pareto.reasons.map((r) => [r.reason, r.ms, r.records])).toEqual([
      ['BREAKDOWN/COOLANT-PRESSURE', 40 * MINUTE, 1],
      ['UNCODED', 30 * MINUTE, 1],
    ]);
    // A recode and a split of the stop.
    await put(STOP_ID, {
      segments: [
        { from: iso('05:00'), to: iso('05:05'), reason: 'MINOR-STOP/PART-MISFEED' },
        { from: iso('05:05'), to: iso('05:25'), reason: 'BREAKDOWN/COOLANT-PRESSURE' },
      ],
      codedBy: 'Ayşe',
      version: await version(STOP_ID),
    });
    const after = await read();
    expect(after.pareto.reasons.map((r) => [r.reason, r.loss, r.ms, r.records])).toEqual([
      ['BREAKDOWN/COOLANT-PRESSURE', 'own', 60 * MINUTE, 2],
      ['MINOR-STOP/PART-MISFEED', 'own', 5 * MINUTE, 1],
      ['UNCODED', 'own', 5 * MINUTE, 1],
    ]);
    // The availability loss is the same time, attributed differently.
    expect(after.pareto.availability).toEqual(before.pareto.availability);
    expect(after.pareto.availability.own).toBe(70 * MINUTE);
    // OEE, A, P, Q and every loss stay exactly as they were, per shift and per hour.
    expect(after.shift).toEqual(before.shift);
    expect(after.hours).toEqual(before.hours);
    expect(after.shift.buckets[0]?.result.availability).not.toBeNull();
    const direct = await oee.buckets({
      scope: 'work-center',
      id: 'cell-m1',
      bucket: 'shift',
      from: new Date(at('03:00')),
      to: new Date(at('11:00')),
    });
    expect(direct[0]?.result.losses?.availability.own.total).toBe(BigInt(70 * MINUTE));
  });

  it('pushes a recoded record on the downtime topic', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${WS_PATH}`);
    const messages: ServerMessage[] = [];
    socket.addEventListener('message', (event) => {
      messages.push(serverMessageSchema.parse(JSON.parse(String(event.data))));
    });
    await new Promise((resolve) => {
      socket.addEventListener('open', resolve, { once: true });
    });
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'downtime' }));
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'oee:cnc-01' }));
    const until = async (predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
      for (let i = 0; i < 100; i++) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no such message in ${JSON.stringify(messages)}`);
    };
    await until((m) => m.type === 'subscribed' && m.topic === 'downtime');
    await until((m) => m.type === 'snapshot' && m.topic === 'oee:cnc-01');
    const response = await put(DOWN_ID, {
      segments: [{ from: iso('03:40'), to: iso('04:20'), reason: 'SETUP/TOOL-CHANGE' }],
      codedBy: 'Zeynep',
      version: await version(DOWN_ID),
    });
    expect(response.statusCode).toBe(200);
    const pushed = await until(
      (m) => m.type === 'downtime' && m.event === 'recoded' && m.record.id === DOWN_ID,
    );
    expect(pushed).toMatchObject({
      record: {
        reason: 'SETUP/TOOL-CHANGE',
        autoReason: 'BREAKDOWN/SPINDLE-OVERLOAD',
        // The coding set's new version, as the PUT answered it.
        version: codingResultSchema.parse(response.json()).version,
      },
    });
    // OEE did not change, so its topic sends nothing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages.filter((m) => m.type === 'oee')).toEqual([]);
    socket.close();
  });
});

describe('codings after a re-cut (#121)', () => {
  const RECUT_ID = `cnc-02~${String(E1)}~${String(at('03:40'))}`;

  it('clips a coding to the loss time it still covers and orphans the rest, audited', async () => {
    // CNC-02 breaks down at 03:40; the fact that it ran again at 04:00 (seq 3) arrives late.
    await send(
      feed.state('cnc-02', E1, 1, at('03:00'), 'Running'),
      feed.state('cnc-02', E1, 2, at('03:40'), 'Down', 'SPINDLE-OVERLOAD'),
      feed.state('cnc-02', E1, 4, at('04:20'), 'Running'),
    );
    await equipment.flush();
    const [record] = await records('cnc-02');
    expect(record).toMatchObject({ id: RECUT_ID, end: iso('04:20') });
    const coded = await put(RECUT_ID, {
      segments: [
        { from: iso('03:50'), to: iso('04:10'), reason: 'BREAKDOWN/COOLANT-PRESSURE' },
        { from: iso('04:10'), to: iso('04:20'), reason: 'SETUP/TOOL-CHANGE', comment: 'swap' },
      ],
      codedBy: 'Ayşe',
      version: record?.version ?? -1,
    });
    expect(coded.statusCode).toBe(200);
    const version = codingResultSchema.parse(coded.json()).version;

    await send(feed.state('cnc-02', E1, 3, at('04:00'), 'Running'));
    await equipment.flush();
    await coding.settle();

    // The record now ends at 04:00: the first coding keeps 03:50-04:00, the rest is orphaned.
    const [after] = await records('cnc-02');
    expect(after).toMatchObject({
      id: RECUT_ID,
      end: iso('04:00'),
      version: version + 1,
      // A tie (10 min each): the earlier reason names the record.
      reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
      segments: [
        {
          from: iso('03:40'),
          to: iso('03:50'),
          reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
          coded: false,
        },
        { from: iso('03:50'), to: iso('04:00'), reason: 'BREAKDOWN/COOLANT-PRESSURE', coded: true },
      ],
    });
    expect(after?.codings.map((c) => [c.from, c.to, c.codedBy, c.version])).toEqual([
      [iso('03:50'), iso('04:00'), 'Ayşe', version + 1],
    ]);
    const stored = await db
      .selectFrom('equipment.downtime_coding')
      .select(['from_time', 'to_time', 'reason', 'orphaned'])
      .where('equipment', '=', 'cnc-02')
      .orderBy('from_time')
      .execute();
    expect(
      stored.map((c) => [c.from_time.toISOString(), c.to_time.toISOString(), c.orphaned]),
    ).toEqual([
      [iso('03:50'), iso('04:00'), false],
      [iso('04:00'), iso('04:10'), true],
      [iso('04:10'), iso('04:20'), true],
    ]);
    const audit = downtimeAuditSchema.parse(
      (
        await app.inject({ url: `/api/v1/downtime/${RECUT_ID}/audit`, headers: { host: HOST } })
      ).json(),
    );
    const clips = audit.entries.filter((e) => e.action === 'orphaned');
    expect(
      clips.map((e) => [e.actor, e.recordId, e.from, e.to, e.after.map((c) => c.orphaned)]),
    ).toEqual([
      ['system', null, iso('04:10'), iso('04:20'), [true]],
      ['system', null, iso('03:50'), iso('04:10'), [false, true]],
    ]);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'coded', actor: 'Ayşe' });

    // The Pareto counts only the kept coding; the auto reason keeps the rest of the record.
    const pareto = paretoSchema.parse(
      (
        await app.inject({
          url: `/api/v1/downtime/pareto?scope=equipment&id=cnc-02&from=${iso('03:00')}&to=${iso('05:00')}`,
          headers: { host: HOST },
        })
      ).json(),
    );
    expect(pareto.reasons.map((r) => [r.reason, r.ms])).toEqual([
      ['BREAKDOWN/COOLANT-PRESSURE', 10 * MINUTE],
      ['BREAKDOWN/SPINDLE-OVERLOAD', 10 * MINUTE],
    ]);
    // An old version is refused after the clip moved it on.
    const stale = await put(RECUT_ID, { segments: [], codedBy: 'Ayşe', version });
    expect(stale.statusCode).toBe(409);
  });

  it('orphans a whole coding when its record disappears, also across a restart', async () => {
    // CNC-02 stops 05:00-05:30 (a long stop: a record), coded; the fact that it ran again at
    // 05:01 (seq 6) arrives late, while the coding module is away.
    await send(
      feed.state('cnc-02', E1, 5, at('05:00'), 'Stopped', 'jam'),
      feed.state('cnc-02', E1, 7, at('05:30'), 'Running'),
    );
    await equipment.flush();
    const stopId = `cnc-02~${String(E1)}~${String(at('05:00'))}`;
    const stop = (await records('cnc-02')).find((r) => r.id === stopId);
    expect(stop?.end).toBe(iso('05:30'));
    const response = await put(stopId, {
      segments: [{ from: iso('05:00'), to: iso('05:30'), reason: 'MINOR-STOP/CHIP-JAM' }],
      codedBy: 'Ayşe',
      version: stop?.version ?? -1,
    });
    expect(response.statusCode).toBe(200);
    coding.stop();
    await send(feed.state('cnc-02', E1, 6, at('05:01'), 'Running'));
    await equipment.flush();
    // A one-minute stop is a micro-stop: no record any more.
    expect((await records('cnc-02')).map((r) => r.id)).toEqual([RECUT_ID]);
    // Start-up clips every coding once.
    await coding.start();
    const stored = await db
      .selectFrom('equipment.downtime_coding')
      .select(['from_time', 'to_time', 'orphaned'])
      .where('equipment', '=', 'cnc-02')
      .where('reason', '=', 'MINOR-STOP/CHIP-JAM')
      .execute();
    expect(
      stored.map((c) => [c.from_time.toISOString(), c.to_time.toISOString(), c.orphaned]),
    ).toEqual([[iso('05:00'), iso('05:30'), true]]);
    const clip = await db
      .selectFrom('equipment.downtime_audit')
      .select(['action', 'actor', 'before', 'after'])
      .where('equipment', '=', 'cnc-02')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    expect(clip).toMatchObject({ action: 'orphaned', actor: 'system' });
    expect(clip?.after).toEqual([expect.objectContaining({ from: iso('05:00'), orphaned: true })]);
    // The Pareto has no trace of it.
    const pareto = paretoSchema.parse(
      (
        await app.inject({
          url: `/api/v1/downtime/pareto?scope=equipment&id=cnc-02&from=${iso('05:00')}&to=${iso('06:00')}`,
          headers: { host: HOST },
        })
      ).json(),
    );
    expect(pareto.reasons).toEqual([]);
  });

  it('holds a re-cut of the record back until the write committed (FOR SHARE)', async () => {
    // ASM-01 is down 06:00-06:30.
    await send(
      feed.state('asm-01', E1, 1, at('03:00'), 'Running'),
      feed.state('asm-01', E1, 2, at('06:00'), 'Down', 'PRESS-FAULT'),
      feed.state('asm-01', E1, 3, at('06:30'), 'Running'),
    );
    await equipment.flush();
    const id = `asm-01~${String(E1)}~${String(at('06:00'))}`;
    const first = codingResultSchema.parse(
      (await put(id, { segments: [], codedBy: 'x', version: await version(id) })).json(),
    );
    // Another write holds the coding set, so this one waits after reading its record.
    let release = (): void => undefined;
    let locked = (): void => undefined;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('equipment.downtime_coding_set')
        .select('version')
        .where('equipment', '=', 'asm-01')
        .forUpdate()
        .execute();
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await isLocked;
    const write = put(id, {
      segments: [{ from: iso('06:00'), to: iso('06:30'), reason: 'BREAKDOWN/PRESS-FAULT' }],
      codedBy: 'Ayşe',
      version: first.version,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // A rebuild deleting the record must wait for the write (here: give up after 300 ms).
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '300ms'`.execute(trx);
        await trx
          .deleteFrom('equipment.downtime_record')
          .where('equipment', '=', 'asm-01')
          .where('start_time', '=', new Date(at('06:00')))
          .execute();
      }),
    ).rejects.toThrow(/lock timeout/);
    release();
    await holder;
    expect((await write).statusCode).toBe(200);
    expect((await records('asm-01')).find((r) => r.id === id)?.codings).toHaveLength(1);
  });
});

describe('clipping (pure)', () => {
  it('keeps the parts inside records, one per record, and orphans the rest', () => {
    expect(
      clipToRecords({ from: 0, to: 100 }, [
        { start: 10, end: 20 },
        { start: 20, end: null },
      ]),
    ).toEqual({
      kept: [
        { from: 10, to: 20 },
        { from: 20, to: 100 },
      ],
      orphaned: [{ from: 0, to: 10 }],
    });
    expect(clipToRecords({ from: 0, to: 10 }, [])).toEqual({
      kept: [],
      orphaned: [{ from: 0, to: 10 }],
    });
    expect(clipToRecords({ from: 0, to: 30 }, [{ start: 10, end: 20 }])).toEqual({
      kept: [{ from: 10, to: 20 }],
      orphaned: [
        { from: 0, to: 10 },
        { from: 20, to: 30 },
      ],
    });
  });

  it('backs failed clips off exponentially, up to 30 s, and resets after a success', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let healthy = false;
      const changed: ((change: CodingChange) => void)[] = [];
      const failing = new DowntimeCoding({
        // Only `transaction` is used by a clip; it fails until `healthy`.
        db: {
          transaction: () => ({
            execute: () => {
              attempts++;
              return healthy ? Promise.resolve(undefined) : Promise.reject(new Error('down'));
            },
          }),
        } as unknown as Kysely<Database>,
        equipment: {
          onPiecesChanged: (listener) => {
            changed.push(listener);
            return () => undefined;
          },
          watermark: () => undefined,
        },
        codable: () => Promise.resolve(true),
        debounceMs: 100,
      });
      const notify = () => {
        for (const listener of changed) {
          listener({ equipment: 'cnc-01', epoch: 1, from: new Date(0), to: new Date(3_600_000) });
        }
      };
      const attemptsAt = async (ms: number): Promise<number> => {
        await vi.advanceTimersByTimeAsync(ms);
        return attempts;
      };
      // start() subscribes, then fails reading the coding sets from the fake database.
      await failing.start().catch(() => undefined);
      attempts = 0;
      notify();
      // 100 ms debounce, then 200, 400, 800 ms, …
      expect(await attemptsAt(100)).toBe(1);
      expect(await attemptsAt(199)).toBe(1);
      expect(await attemptsAt(1)).toBe(2);
      expect(await attemptsAt(400)).toBe(3);
      // More changes don't shorten the backoff.
      notify();
      expect(await attemptsAt(799)).toBe(3);
      expect(await attemptsAt(1)).toBe(4);
      // The wait is capped at 30 s.
      await attemptsAt(60_000);
      const before = attempts;
      expect(await attemptsAt(30_000)).toBe(before + 1);
      // A success resets it: the next change waits only the debounce.
      healthy = true;
      await attemptsAt(30_000);
      notify();
      const settled = attempts;
      expect(await attemptsAt(100)).toBe(settled + 1);
      failing.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
