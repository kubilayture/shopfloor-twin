import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import fc from 'fast-check';
import {
  AlarmWriteError,
  Alarms,
  alarmHourBuckets,
  alarmShiftBuckets,
  operatorMeasures,
  retrying,
  shelfIntervals,
  type EndReason,
} from './modules/alarms/index.ts';
import { DowntimeCoding, Equipment, downtimeRules } from './modules/equipment/index.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  type Delivery,
} from './modules/equipment/test-support.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import { Oee } from './modules/oee/index.ts';
import {
  WS_PATH,
  serverMessageSchema,
  type ApiSources,
  type ServerMessage,
} from './modules/realtime/index.ts';
import {
  acknowledgeResultSchema,
  alarmDetailSchema,
  alarmHistorySchema,
  alarmListSchema,
  alarmPointAuditSchema,
  alarmPointListSchema,
  bulkAcknowledgeResultSchema,
  commentResultSchema,
  problemSchema,
  operatorKpiListSchema,
  shelfResultSchema,
} from './modules/realtime/schemas.ts';
import { startDatabase } from './testing.ts';

/**
 * Alarm writes (#143, ADR-0023, ADR-0024 "Operator lifecycle"): acknowledge (single and bulk, with
 * ON CONFLICT DO NOTHING and audit rows only for the rows inserted), comments, shelve and unshelve
 * per point with a version and a limit in plant time, expiry by the plant clock and at a new
 * epoch, the append-only audit, the operator lists, push, every guard refusal, `MES_WRITES=off`,
 * and KPIs that no operator action changes.
 */

const E1 = 1_760_000_000;
const E2 = 1_760_050_000;
const MINUTE = 60_000;
/** Monday 2026-10-12 03:00 UTC (shift A starts) plus minutes. */
const T0 = Date.parse('2026-10-12T03:00:00.000Z');
const t = (minutes: number, ms = 0): number => T0 + minutes * MINUTE + ms;
const iso = (at: number): string => new Date(at).toISOString();
const PATH = { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-01' } as const;
const feed = new UnsFeed(new Map([['cnc-01', PATH]]));
const CP = 'COOLANT-PRESSURE';
const SO = 'SPINDLE-OVERLOAD';
const ID2 = `cnc-01~${String(E1)}~2`;
const ID4 = `cnc-01~${String(E1)}~4`;

const HOST = 'localhost:4700';
const ORIGIN = `http://${HOST}`;
const JSON_WRITE = { host: HOST, origin: ORIGIN, 'content-type': 'application/json' };

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
}, 180_000);

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

afterAll(async () => {
  await container.stop();
});

const state = (epoch: number, seq: number, at: number, value: 'Running' | 'Stopped' = 'Running') =>
  feed.state('cnc-01', epoch, seq, at, value, value === 'Stopped' ? 'PART-MISFEED' : null);
const raise = (epoch: number, seq: number, at: number, code = CP) =>
  feed.alarm('cnc-01', epoch, seq, at, code, 'active', 700);
const clear = (epoch: number, seq: number, at: number, code = CP) =>
  feed.alarm('cnc-01', epoch, seq, at, code, 'cleared', 700);

interface World {
  db: Kysely<Database>;
  alarms: Alarms;
  app: FastifyInstance;
  sources: ApiSources;
  send: (...deliveries: Delivery[]) => Promise<void>;
  /** Another HTTP front over the same modules. */
  front: (options: Parameters<typeof buildMesHttp>[0]) => Promise<FastifyInstance>;
}

/**
 * Per test: a database, the modules and an HTTP front, with cnc-01's facts: COOLANT-PRESSURE
 * raised 03:10 and cleared 03:12 (seq 2, 3), SPINDLE-OVERLOAD raised 03:20 and still active
 * (seq 4), and a state at 04:10, the plant clock.
 */
async function world(): Promise<World> {
  const db = await freshDatabase(serverUrl, 'alarm_writes');
  cleanup.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    sweepIntervalMs: 0,
  });
  const equipment = new Equipment({
    db,
    source: ingest,
    shiftPattern: plant.shifts,
    provisionalStepMs: 0,
    downtime: downtimeRules(plant),
  });
  await equipment.start();
  cleanup.push(() => equipment.stop());
  const alarms = new Alarms({
    db,
    ingest,
    equipment,
    masterData,
    shiftPattern: plant.shifts,
    config: plant.alarms.kpi,
    maxShelveMs: plant.alarms.maxShelveMs,
  });
  await alarms.start();
  cleanup.push(() => alarms.stop());
  const oee = new Oee({
    equipment,
    ingest,
    masterData,
    shiftPattern: plant.shifts,
    config: plant.oee,
    idealCycleMs: {},
  });
  await oee.start();
  cleanup.push(() => {
    oee.stop();
    return Promise.resolve();
  });
  const sources: ApiSources = {
    masterData,
    equipment,
    ingest,
    oee,
    coding: new DowntimeCoding({ db, equipment, codable: () => Promise.resolve(true) }),
    alarms,
  };
  const front = async (options: Parameters<typeof buildMesHttp>[0]) => {
    const http = await buildMesHttp(options);
    await http.realtime.attach(sources);
    cleanup.push(() => http.app.close());
    return http.app;
  };
  const app = await front({
    ready: () => Promise.resolve(true),
    push: { oeeMs: 100 },
    writeRate: { perSecond: 1000, burst: 1000 },
  });
  const send = async (...deliveries: Delivery[]) => {
    for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
  };
  await send(
    state(E1, 1, t(0)),
    raise(E1, 2, t(10)),
    clear(E1, 3, t(12)),
    raise(E1, 4, t(20), SO),
    state(E1, 5, t(70), 'Stopped'),
  );
  return { db, alarms, app, sources, send, front };
}

const post = (
  app: FastifyInstance,
  url: string,
  body: unknown,
  headers: Record<string, string> = JSON_WRITE,
) =>
  app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

const get = async (app: FastifyInstance, url: string) => {
  const response = await app.inject({ url: `/api/v1${url}`, headers: { host: HOST } });
  return { status: response.statusCode, body: response.json<unknown>(), text: response.body };
};

const list = async (app: FastifyInstance, view: string) =>
  alarmListSchema
    .parse((await get(app, `/alarms?view=${view}&from=${iso(t(0))}&to=${iso(t(24 * 60))}`)).body)
    .alarms.map((a) => a.id);

const transitions = (db: Kysely<Database>) =>
  db
    .selectFrom('alarms.alarm_transition')
    .select(['action', 'equipment', 'code', 'epoch', 'seq', 'actor', 'authenticated'])
    .select(['plant_at', 'plant_epoch', 'request_id', 'version'])
    .orderBy('id')
    .execute();

/** Every alarm write route, with a valid body. */
const WRITES: readonly [string, unknown][] = [
  [`/alarms/${ID2}/ack`, { actor: 'guard test' }],
  ['/alarms/ack', { ids: [ID2], actor: 'guard test' }],
  [`/alarms/${ID2}/comments`, { actor: 'guard test', text: 'hello' }],
  [
    `/alarm-points/cnc-01/${CP}/shelve`,
    { actor: 'guard test', reason: 'r', durationMs: MINUTE, version: 0 },
  ],
  [`/alarm-points/cnc-01/${CP}/unshelve`, { actor: 'guard test', version: 0 }],
];

describe('alarm write guards (ADR-0023)', () => {
  it('refuses every alarm write without Origin, from another origin or site, not as JSON, too big or from a foreign Host', async () => {
    const { app, db } = await world();
    for (const [url, body] of WRITES) {
      for (const [name, headers, status] of [
        ['no Origin', { host: HOST, 'content-type': 'application/json' }, 403],
        ['foreign Origin', { ...JSON_WRITE, origin: 'http://evil.example' }, 403],
        ['other port', { ...JSON_WRITE, origin: 'http://localhost:5173' }, 403],
        ['cross-site fetch', { ...JSON_WRITE, 'sec-fetch-site': 'cross-site' }, 403],
        ['same-site fetch', { ...JSON_WRITE, 'sec-fetch-site': 'same-site' }, 403],
        ['foreign Host', { ...JSON_WRITE, host: 'evil.example:4700' }, 403],
        ['form', { ...JSON_WRITE, 'content-type': 'application/x-www-form-urlencoded' }, 415],
        ['text', { ...JSON_WRITE, 'content-type': 'text/plain' }, 415],
        ['no type', { host: HOST, origin: ORIGIN }, 415],
      ] as const) {
        const response = await post(app, url, body, { ...headers });
        expect([url, name, response.statusCode]).toEqual([url, name, status]);
        expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
        problemSchema.parse(response.json());
        expect(
          Object.keys(response.headers).filter((h) => h.startsWith('access-control-')),
        ).toEqual([]);
      }
      const big = await post(app, url, { ...(body as object), actor: 'x'.repeat(17 * 1024) });
      expect([url, big.statusCode]).toEqual([url, 413]);
      for (const bad of ['{not json', { ...(body as object), extra: 1 }, { actor: ' ' }]) {
        expect([url, (await post(app, url, bad)).statusCode]).toEqual([url, 400]);
      }
    }
    // Nothing reached the tables.
    expect(await transitions(db)).toEqual([]);
    expect(await db.selectFrom('alarms.occurrence_state').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('alarms.alarm_shelf').selectAll().execute()).toEqual([]);
  });

  it('answers every alarm write with 405 when MES_WRITES=off, and still reads', async () => {
    const { db, front } = await world();
    const off = await front({ ready: () => Promise.resolve(true), writes: false });
    for (const [url, body] of WRITES) {
      const response = await post(off, url, body);
      expect([url, response.statusCode]).toEqual([url, 405]);
      expect(response.headers.allow).toBe('GET, HEAD');
      expect(problemSchema.parse(response.json()).detail).toMatch(/MES_WRITES=off/);
    }
    expect(await transitions(db)).toEqual([]);
    expect(await list(off, 'active')).toEqual([ID4, ID2]);
    expect((await get(off, '/alarm-points')).status).toBe(200);
  });

  it('limits alarm writes globally; a bulk acknowledgement is one write', async () => {
    const { front } = await world();
    const limited = await front({
      ready: () => Promise.resolve(true),
      writeRate: { perSecond: 1, burst: 2 },
    });
    const statuses = [
      (await post(limited, '/alarms/ack', { ids: [ID2, ID4], actor: 'a' })).statusCode,
      (await post(limited, `/alarms/${ID2}/comments`, { actor: 'a', text: 'b' })).statusCode,
    ];
    const third = await post(limited, `/alarms/${ID4}/ack`, { actor: 'a' });
    expect([...statuses, third.statusCode]).toEqual([200, 200, 429]);
    expect(third.headers['retry-after']).toBe('1');
  });
});

describe('acknowledging alarms (#143)', () => {
  it('acknowledges one occurrence monotonically: the second time is changed: false and not audited', async () => {
    const { app, db } = await world();
    expect(await list(app, 'active')).toEqual([ID4, ID2]);
    const first = await post(app, `/alarms/${ID4}/ack`, { actor: 'Ayşe', comment: 'on it' });
    expect(first.statusCode).toBe(200);
    const requestId = first.headers['x-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const result = acknowledgeResultSchema.parse(first.json());
    expect(result).toMatchObject({
      changed: true,
      occurrence: {
        id: ID4,
        state: 'acked-active',
        acknowledged: { by: 'Ayşe', plantAt: iso(t(70)), comment: 'on it' },
      },
    });
    const again = acknowledgeResultSchema.parse(
      (await post(app, `/alarms/${ID4}/ack`, { actor: 'Bora' })).json(),
    );
    // Monotonic: the first acknowledgement stays.
    expect(again).toMatchObject({ changed: false, occurrence: { acknowledged: { by: 'Ayşe' } } });
    expect(await transitions(db)).toEqual([
      {
        action: 'ack',
        equipment: 'cnc-01',
        code: SO,
        epoch: E1,
        seq: 4,
        actor: 'Ayşe',
        authenticated: false,
        plant_at: new Date(t(70)),
        plant_epoch: E1,
        request_id: requestId,
        version: null,
      },
    ]);
    // The lists: acknowledged and still active; the cleared one stays active until acknowledged.
    expect(await list(app, 'acknowledged')).toEqual([ID4]);
    expect(await list(app, 'active')).toEqual([ID2]);
    expect((await post(app, `/alarms/${ID2}/ack`, { actor: 'Ayşe' })).statusCode).toBe(200);
    expect(await list(app, 'active')).toEqual([]);
    expect(await list(app, 'history')).toEqual([ID2]);
    // Unknown occurrences.
    for (const id of [`cnc-01~${String(E1)}~99`, `zzz~1~1`]) {
      expect((await post(app, `/alarms/${id}/ack`, { actor: 'a' })).statusCode).toBe(404);
    }
    expect((await post(app, '/alarms/nope/ack', { actor: 'a' })).statusCode).toBe(400);
  });

  it('acknowledges in bulk with ON CONFLICT DO NOTHING: audit rows only for the rows inserted, an unknown id changes nothing', async () => {
    const { app, db, alarms, send } = await world();
    await send(raise(E1, 6, t(71), 'TOOL-WEAR'), raise(E1, 7, t(72), 'WORKPIECE-PROBE'));
    const ID6 = `cnc-01~${String(E1)}~6`;
    const ID7 = `cnc-01~${String(E1)}~7`;
    await alarms.acknowledge([ID4], { actor: 'first' });
    // An unknown id: 404 and nothing at all changes (one transaction).
    const unknown = await post(app, '/alarms/ack', {
      ids: [ID2, `cnc-01~${String(E1)}~99`],
      actor: 'bulk',
    });
    expect(unknown.statusCode).toBe(404);
    expect((await transitions(db)).length).toBe(1);
    const bulk = await post(app, '/alarms/ack', { ids: [ID2, ID4, ID6, ID2], actor: 'bulk' });
    expect(bulk.statusCode).toBe(200);
    expect(bulkAcknowledgeResultSchema.parse(bulk.json())).toEqual({
      results: [
        { id: ID2, changed: true },
        { id: ID4, changed: false },
        { id: ID6, changed: true },
      ],
      acknowledged: 2,
    });
    // Concurrent overlapping bulk requests: each id is acknowledged and audited exactly once.
    const racing = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        alarms.acknowledge(i % 2 === 0 ? [ID7, ID6] : [ID6, ID7], { actor: `racer ${String(i)}` }),
      ),
    );
    expect(
      racing
        .flat()
        .filter((r) => r.changed)
        .map((r) => r.id),
    ).toEqual([ID7]);
    const audit = await transitions(db);
    expect(audit.map((a) => [a.action, a.seq, a.actor])).toEqual([
      ['ack', 4, 'first'],
      ['ack', 2, 'bulk'],
      ['ack', 6, 'bulk'],
      ['ack', 7, audit[3]?.actor],
    ]);
    expect(await db.selectFrom('alarms.occurrence_state').select('seq').execute()).toHaveLength(4);
    // At most 100 ids, at least one.
    const ids = Array.from({ length: 101 }, (_, i) => `cnc-01~${String(E1)}~${String(i + 1)}`);
    expect((await post(app, '/alarms/ack', { ids, actor: 'a' })).statusCode).toBe(400);
    expect((await post(app, '/alarms/ack', { ids: [], actor: 'a' })).statusCode).toBe(400);
  });

  it('keeps acknowledgements insert-only and the audit append-only', async () => {
    const { db, alarms } = await world();
    await alarms.acknowledge([ID2], { actor: 'a' });
    await alarms.comment(ID2, { actor: 'a', text: 'noted' });
    for (const statement of [
      sql`UPDATE alarms.alarm_transition SET actor = 'mallory'`,
      sql`DELETE FROM alarms.alarm_transition`,
      sql`TRUNCATE alarms.alarm_transition`,
    ]) {
      await expect(statement.execute(db)).rejects.toThrow(/alarm_transition is append-only/);
    }
    for (const statement of [
      sql`UPDATE alarms.occurrence_state SET acknowledged_by = 'mallory'`,
      sql`DELETE FROM alarms.occurrence_state`,
      sql`TRUNCATE alarms.occurrence_state`,
    ]) {
      await expect(statement.execute(db)).rejects.toThrow(/occurrence_state is insert-only/);
    }
    expect((await transitions(db)).map((a) => a.actor)).toEqual(['a', 'a']);
  });
});

describe('comments (#143)', () => {
  it('adds comments, lists them with the occurrence and in its history, audited', async () => {
    const { app } = await world();
    const response = await post(app, `/alarms/${ID4}/comments`, {
      actor: 'Ayşe',
      text: '  coolant low  ',
    });
    expect(response.statusCode).toBe(200);
    const result = commentResultSchema.parse(response.json());
    expect(result).toMatchObject({
      comment: { text: 'coolant low', actor: 'Ayşe', authenticated: false, plantAt: iso(t(70)) },
      occurrence: { id: ID4, comments: 1, state: 'unacked-active' },
    });
    expect(result.comment.requestId).toBe(response.headers['x-request-id']);
    await post(app, `/alarms/${ID4}/comments`, { actor: 'Bora', text: 'fixed' });
    const detail = alarmDetailSchema.parse((await get(app, `/alarms/${ID4}`)).body);
    expect(detail.comments.map((c) => [c.actor, c.text])).toEqual([
      ['Ayşe', 'coolant low'],
      ['Bora', 'fixed'],
    ]);
    expect(detail.occurrence.comments).toBe(2);
    const history = alarmHistorySchema.parse((await get(app, `/alarms/${ID4}/history`)).body);
    expect(history.entries.map((e) => [e.source, e.transition, e.actor, e.detail])).toEqual([
      ['fact', 'raised', null, null],
      ['audit', 'comment', 'Ayşe', { text: 'coolant low' }],
      ['audit', 'comment', 'Bora', { text: 'fixed' }],
    ]);
    for (const body of [
      { actor: 'a', text: '' },
      { actor: 'a', text: 'x'.repeat(501) },
      { actor: 'a' },
    ]) {
      expect((await post(app, `/alarms/${ID4}/comments`, body)).statusCode).toBe(400);
    }
    const missing = `/alarms/cnc-01~${String(E1)}~99/comments`;
    expect((await post(app, missing, { actor: 'a', text: 'b' })).statusCode).toBe(404);
  });
});

describe('shelving alarm points (#143)', () => {
  const shelvePath = `/alarm-points/cnc-01/${SO}/shelve`;
  const unshelvePath = `/alarm-points/cnc-01/${SO}/unshelve`;

  it('shelves and unshelves a point with a version (409 when stale), and moves its occurrences between the lists', async () => {
    const { app, db } = await world();
    const points = alarmPointListSchema.parse(
      (await get(app, '/alarm-points?equipment=cnc-01')).body,
    );
    expect(points.points.find((p) => p.code === SO)).toMatchObject({
      defined: true,
      priority: 'high',
      shelf: { shelved: false, version: 0 },
      activeOccurrence: ID4,
    });
    const shelved = await post(app, shelvePath, {
      actor: 'Ayşe',
      reason: 'sensor fault, maintenance called',
      durationMs: 60 * MINUTE,
      version: 0,
    });
    expect(shelved.statusCode).toBe(200);
    expect(shelfResultSchema.parse(shelved.json()).point.shelf).toMatchObject({
      shelved: true,
      version: 1,
      by: 'Ayşe',
      epoch: E1,
      plantAt: iso(t(70)),
      until: iso(t(130)),
      durationMs: 60 * MINUTE,
    });
    expect(await list(app, 'active')).toEqual([ID2]);
    expect(await list(app, 'shelved')).toEqual([ID4]);
    // A stale version is 409 and changes nothing.
    const stale = await post(app, unshelvePath, { actor: 'Bora', version: 0 });
    expect(stale.statusCode).toBe(409);
    expect(problemSchema.parse(stale.json()).detail).toMatch(/version is 1, not 0/);
    expect(
      (await post(app, shelvePath, { actor: 'B', reason: 'r', durationMs: MINUTE, version: 0 }))
        .statusCode,
    ).toBe(409);
    // Shelving a shelved point replaces its shelf.
    const longer = await post(app, shelvePath, {
      actor: 'Bora',
      reason: 'longer',
      durationMs: 2 * 60 * MINUTE,
      version: 1,
    });
    expect(shelfResultSchema.parse(longer.json()).point.shelf).toMatchObject({
      version: 2,
      until: iso(t(190)),
    });
    const unshelved = await post(app, unshelvePath, { actor: 'Bora', version: 2 });
    expect(shelfResultSchema.parse(unshelved.json()).point.shelf).toMatchObject({
      shelved: false,
      version: 3,
      by: null,
      until: null,
    });
    expect(await list(app, 'active')).toEqual([ID4, ID2]);
    expect(await list(app, 'shelved')).toEqual([]);
    // Not shelved: 422.
    expect((await post(app, unshelvePath, { actor: 'B', version: 3 })).statusCode).toBe(422);
    const audit = alarmPointAuditSchema.parse(
      (await get(app, `/alarm-points/cnc-01/${SO}/audit`)).body,
    );
    expect(audit.entries.map((e) => [e.action, e.actor, e.version, e.authenticated])).toEqual([
      ['unshelve', 'Bora', 3, false],
      ['shelve', 'Bora', 2, false],
      ['shelve', 'Ayşe', 1, false],
    ]);
    expect(audit.entries[2]?.requestId).toBe(shelved.headers['x-request-id']);
    expect(audit.entries[1]?.before).toMatchObject({
      shelved: true,
      reason: 'sensor fault, maintenance called',
    });
    expect((await transitions(db)).every((row) => !row.authenticated)).toBe(true);
    // The occurrence's history holds the shelf transitions while it was active.
    const history = alarmHistorySchema.parse((await get(app, `/alarms/${ID4}/history`)).body);
    expect(history.entries.map((e) => [e.transition, e.actor])).toEqual([
      ['raised', null],
      ['shelve', 'Ayşe'],
      ['shelve', 'Bora'],
      ['unshelve', 'Bora'],
    ]);
  });

  it('caps the duration at maxShelveMs and needs a known point', async () => {
    const { app } = await world();
    const body = { actor: 'a', reason: 'r', version: 0 };
    for (const [durationMs, status] of [
      [plant.alarms.maxShelveMs + 1, 422],
      [plant.alarms.maxShelveMs, 200],
      [MINUTE - 1, 400],
      [1.5 * MINUTE + 0.5, 400],
    ] as const) {
      const response = await post(app, `/alarm-points/cnc-01/${CP}/shelve`, {
        ...body,
        durationMs,
        version: status === 200 ? 0 : 1,
      });
      expect([durationMs, response.statusCode]).toEqual([durationMs, status]);
    }
    for (const path of ['/alarm-points/cnc-01/NO-SUCH-CODE', '/alarm-points/nowhere/CODE']) {
      const response = await post(app, `${path}/shelve`, { ...body, durationMs: MINUTE });
      expect([path, response.statusCode]).toEqual([path, 404]);
      expect((await get(app, `${path}/audit`)).status).toBe(404);
    }
    expect((await get(app, '/alarm-points?position=nowhere')).status).toBe(404);
    const shelvedOnly = alarmPointListSchema.parse(
      (await get(app, '/alarm-points?shelved=true')).body,
    );
    expect(shelvedOnly.points.map((p) => `${p.equipment}/${p.code}`)).toEqual([`cnc-01/${CP}`]);
  });

  it('ends a shelf when the plant clock passes its limit, in plant time, audited by system', async () => {
    const { app, db, send } = await world();
    await post(app, shelvePath, { actor: 'Ayşe', reason: 'r', durationMs: 5 * MINUTE, version: 0 });
    // Wall time means nothing: only the plant clock (04:10 + 5 min = 04:15) ends it.
    await send(state(E1, 6, t(75, -1)));
    expect(await list(app, 'shelved')).toEqual([ID4]);
    await send(state(E1, 7, t(75), 'Stopped'));
    expect(await list(app, 'shelved')).toEqual([]);
    expect(await list(app, 'active')).toEqual([ID4, ID2]);
    const audit = (await transitions(db)).filter((a) => a.action !== 'shelve');
    expect(audit).toEqual([
      {
        action: 'expire',
        equipment: 'cnc-01',
        code: SO,
        epoch: null,
        seq: null,
        actor: 'system',
        authenticated: false,
        plant_at: new Date(t(75)),
        plant_epoch: E1,
        request_id: null,
        version: 2,
      },
    ]);
    const point = alarmPointListSchema
      .parse((await get(app, '/alarm-points?equipment=cnc-01')).body)
      .points.find((p) => p.code === SO);
    expect(point?.shelf).toMatchObject({ shelved: false, version: 2 });
  });

  it('ends every shelf of an old epoch when a newer epoch begins (plant time starts over), also across a restart', async () => {
    const { app, db, send, alarms, sources } = await world();
    await post(app, shelvePath, { actor: 'a', reason: 'r', durationMs: 60 * MINUTE, version: 0 });
    await alarms.stop();
    // The new run starts while the MES is away; at start-up the shelf ends.
    await send(state(E2, 1, t(80)));
    const restarted = new Alarms({
      db,
      ingest: sources.ingest as Ingest,
      equipment: sources.equipment as Equipment,
      masterData: sources.masterData as MasterData,
      shiftPattern: plant.shifts,
      config: plant.alarms.kpi,
    });
    await restarted.start();
    cleanup.push(() => restarted.stop());
    const ended = (await transitions(db)).filter((a) => a.action !== 'shelve');
    expect(ended.map((a) => [a.action, a.actor, a.plant_at, a.plant_epoch, a.version])).toEqual([
      ['epoch-ended', 'system', new Date(t(70)), E1, 2],
    ]);
    // And while running: a shelf of E2 ends when E3 begins.
    await restarted.shelve('cnc-01', CP, {
      actor: 'a',
      reason: 'r',
      durationMs: MINUTE,
      version: 0,
    });
    await send(state(E2 + 1, 1, t(90)));
    expect(
      (await transitions(db)).filter((a) => a.code === CP).map((a) => [a.action, a.plant_epoch]),
    ).toEqual([
      ['shelve', E2],
      ['epoch-ended', E2],
    ]);
  });

  it("books an unshelve that lands after a newer epoch began, before the shelf was ended, to the shelf's own epoch (#156)", async () => {
    const { app, db, send, alarms, sources } = await world();
    // Shelved at 04:10 (E1) for an hour; the E1 clock reaches 04:13.
    await post(app, shelvePath, { actor: 'a', reason: 'r', durationMs: 60 * MINUTE, version: 0 });
    await send(state(E1, 6, t(73)));
    await alarms.flush();
    // The window: E2 begins, and the unshelve lands before `endShelves` has run for it.
    await alarms.stop();
    await send(state(E2, 1, t(100)));
    await alarms.unshelve('cnc-01', SO, { actor: 'b', version: 1 });
    // cnc-02 is still in E1: its fact moves E1's clock on to 04:30 after the unshelve.
    const cnc02 = new UnsFeed(new Map([['cnc-02', { ...PATH, equipment: 'cnc-02' }]]));
    await send(cnc02.state('cnc-02', E1, 1, t(90), 'Running', null));
    expect(sources.equipment.watermark(E1)).toEqual(new Date(t(90)));
    const restarted = new Alarms({
      db,
      ingest: sources.ingest as Ingest,
      equipment: sources.equipment as Equipment,
      masterData: sources.masterData as MasterData,
      shiftPattern: plant.shifts,
      config: plant.alarms.kpi,
    });
    await restarted.start();
    cleanup.push(() => restarted.stop());
    const measures = (epoch: number) =>
      restarted.operatorMeasures({
        scope: 'equipment',
        id: 'cnc-01',
        bucket: 'range',
        from: new Date(t(0)),
        to: new Date(t(240)),
        epoch,
      });
    // E1's shelved time ends at the unshelve (3 minutes), not at E1's end or later.
    expect((await measures(E1)).buckets[0]?.shelvedMs).toEqual([
      { equipment: 'cnc-01', code: SO, ms: 3 * MINUTE },
    ]);
    expect((await measures(E2)).buckets.flatMap((b) => b.shelvedMs)).toEqual([]);
    // Audited at E1's last plant time, in E1.
    expect(
      (await transitions(db))
        .filter((a) => a.code === SO)
        .map((a) => [a.action, a.plant_epoch, a.plant_at]),
    ).toEqual([
      ['shelve', E1, new Date(t(70))],
      ['unshelve', E1, new Date(t(73))],
    ]);
  });
});

describe('operator writes never change KPIs (#143)', () => {
  const kpiUrls = [
    `/alarms/kpi?scope=plant&bucket=hour&from=${iso(t(0))}&to=${iso(t(8 * 60))}`,
    `/alarms/kpi?scope=position&id=cell-m1&bucket=shift&from=${iso(t(0))}&to=${iso(t(24 * 60))}`,
    `/alarms/kpi?scope=equipment&id=cnc-01&bucket=hour&from=${iso(t(0))}&to=${iso(t(8 * 60))}`,
    `/alarms/floods?scope=plant&from=${iso(t(0))}&to=${iso(t(8 * 60))}`,
    `/alarms/bad-actors?scope=plant&from=${iso(t(0))}&to=${iso(t(8 * 60))}`,
  ];
  const snapshot = async (app: FastifyInstance) => {
    const bodies: string[] = [];
    for (const url of kpiUrls) {
      const answer = await get(app, url);
      expect(answer.status).toBe(200);
      bodies.push(answer.text);
    }
    return bodies;
  };

  it('answers /alarms/kpi byte for byte the same after acknowledging, commenting, shelving and unshelving', async () => {
    const { app, db } = await world();
    const before = await snapshot(app);
    const revisionsBefore = await db.selectFrom('alarms.kpi_revision').selectAll().execute();
    expect((await post(app, '/alarms/ack', { ids: [ID2, ID4], actor: 'a' })).statusCode).toBe(200);
    expect((await post(app, `/alarms/${ID4}/comments`, { actor: 'a', text: 'b' })).statusCode).toBe(
      200,
    );
    for (const [path, body] of [
      [
        `/alarm-points/cnc-01/${SO}/shelve`,
        { actor: 'a', reason: 'r', durationMs: MINUTE, version: 0 },
      ],
      [`/alarm-points/cnc-01/${SO}/unshelve`, { actor: 'a', version: 1 }],
      [
        `/alarm-points/cnc-01/${CP}/shelve`,
        { actor: 'a', reason: 'r', durationMs: MINUTE, version: 0 },
      ],
    ] as const) {
      expect((await post(app, path, body)).statusCode).toBe(200);
    }
    expect(await snapshot(app)).toEqual(before);
    expect(await db.selectFrom('alarms.kpi_revision').selectAll().execute()).toEqual(
      revisionsBefore,
    );
  });

  it('equals a twin without operator writes after a shelf expired and the clock moved on', async () => {
    const shelvedWorld = await world();
    const plainWorld = await world();
    await shelvedWorld.alarms.acknowledge([ID4], { actor: 'a' });
    await shelvedWorld.alarms.shelve('cnc-01', SO, {
      actor: 'a',
      reason: 'r',
      durationMs: MINUTE,
      version: 0,
    });
    // A raise of the shelved point while shelved, then the expiry: every raise still counts.
    const later = [raise(E1, 6, t(70, 30_000), SO), state(E1, 7, t(72)), clear(E1, 8, t(73), SO)];
    await shelvedWorld.send(...later);
    await plainWorld.send(...later);
    expect((await transitions(shelvedWorld.db)).map((a) => a.action)).toEqual([
      'ack',
      'shelve',
      'expire',
    ]);
    expect(await snapshot(shelvedWorld.app)).toEqual(await snapshot(plainWorld.app));
  });
});

describe('alarm push (#143)', () => {
  it('pushes acknowledged, commented and shelf upserts, and point shelf changes, on `alarms`', async () => {
    const { app, send } = await world();
    const base = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http', 'ws');
    const socket = new WebSocket(`${base}${WS_PATH}`);
    const messages: ServerMessage[] = [];
    socket.addEventListener('message', (event) => {
      messages.push(serverMessageSchema.parse(JSON.parse(String(event.data))));
    });
    await new Promise((resolve) => {
      socket.addEventListener('open', resolve, { once: true });
    });
    const until = async (predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`not received: ${JSON.stringify(messages)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'alarms' }));
    await until((m) => m.type === 'subscribed');
    await post(app, `/alarms/${ID4}/ack`, { actor: 'Ayşe' });
    expect(await until((m) => m.type === 'alarm' && m.event === 'acknowledged')).toMatchObject({
      occurrence: { id: ID4, state: 'acked-active', acknowledged: { by: 'Ayşe' } },
    });
    await post(app, `/alarms/${ID4}/comments`, { actor: 'Ayşe', text: 'x' });
    expect(await until((m) => m.type === 'alarm' && m.event === 'commented')).toMatchObject({
      occurrence: { id: ID4, comments: 1 },
    });
    await post(app, `/alarm-points/cnc-01/${SO}/shelve`, {
      actor: 'Ayşe',
      reason: 'r',
      durationMs: MINUTE,
      version: 0,
    });
    expect(await until((m) => m.type === 'alarm-point' && m.event === 'shelved')).toMatchObject({
      point: { code: SO, shelf: { shelved: true, version: 1 } },
    });
    expect(await until((m) => m.type === 'alarm' && m.event === 'shelf')).toMatchObject({
      occurrence: { id: ID4, shelved: true, acknowledged: { by: 'Ayşe' } },
    });
    // A device upsert carries the operator's state too; the clock passing `until` unshelves.
    await send(clear(E1, 6, t(70, 30_000), SO));
    expect(await until((m) => m.type === 'alarm' && m.event === 'cleared')).toMatchObject({
      occurrence: { id: ID4, state: 'closed', shelved: true, acknowledged: { by: 'Ayşe' } },
    });
    await send(state(E1, 7, t(71)));
    expect(await until((m) => m.type === 'alarm-point' && m.event === 'expire')).toMatchObject({
      point: { code: SO, shelf: { shelved: false, version: 2 } },
    });
    socket.close();
  });
});

describe('acknowledgements racing rebuilds (#143 review)', () => {
  it('retries an acknowledgement that deadlocks with a rebuild of its occurrences (probe A)', async () => {
    const { db, alarms } = await world();
    // Shaped like `#rederive` before the fix: a row with a higher seq first, a lower one later.
    const rebuild = db.transaction().execute(async (trx) => {
      await sql`UPDATE alarms.alarm_occurrence SET updated_at = now()
        WHERE equipment = 'cnc-01' AND epoch = ${E1} AND seq = 4`.execute(trx);
      await sql`SELECT pg_sleep(0.3)`.execute(trx);
      await sql`DELETE FROM alarms.alarm_occurrence
        WHERE equipment = 'cnc-01' AND epoch = ${E1} AND seq = 2`.execute(trx);
      return 'rebuilt';
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ack = alarms.acknowledge([ID4, ID2], { actor: 'racer' }).then(
      (results) => results,
      (error: unknown) => error,
    );
    expect(await rebuild).toBe('rebuilt');
    const result = await ack;
    // Never a deadlock (500): retried, the acknowledgement sees the rebuild's result, where the
    // occurrence it named is gone (404, nothing acknowledged), or it went through first.
    if (result instanceof Error) {
      expect(result).toBeInstanceOf(AlarmWriteError);
      expect((result as AlarmWriteError).kind).toBe('not-found');
      expect(await db.selectFrom('alarms.occurrence_state').selectAll().execute()).toEqual([]);
    } else {
      expect(result).toEqual([
        { id: ID4, changed: true },
        { id: ID2, changed: true },
      ]);
    }
  });

  it('retries a deadlock or serialization failure up to three times, nothing else', async () => {
    const failing = (codes: (string | undefined)[]) => {
      let calls = 0;
      return {
        work: () => {
          const code = codes[calls++];
          return code === undefined
            ? Promise.resolve(calls)
            : Promise.reject(Object.assign(new Error(code), { code }));
        },
        calls: () => calls,
      };
    };
    const twice = failing(['40P01', '40001']);
    expect(await retrying(twice.work)).toBe(3);
    const thrice = failing(['40P01', '40P01', '40P01']);
    await expect(retrying(thrice.work)).rejects.toThrow('40P01');
    expect(thrice.calls()).toBe(3);
    const other = failing(['23505']);
    await expect(retrying(other.work)).rejects.toThrow('23505');
    expect(other.calls()).toBe(1);
  });
});

describe('operator measures (#143)', () => {
  it('cuts shelves from the audit: a reshelve replaces, an end closes, an open one runs to until or the clock', () => {
    const shelve = (plantAt: number, until: number) => ({
      equipment: 'cnc-01',
      code: CP,
      action: 'shelve' as const,
      plantAt,
      until,
    });
    const end = (action: 'unshelve' | 'expire' | 'epoch-ended', plantAt: number | null) => ({
      equipment: 'cnc-01',
      code: CP,
      action,
      plantAt,
      until: null,
    });
    expect(
      shelfIntervals(
        [
          shelve(0, 100),
          shelve(50, 300),
          end('unshelve', 80),
          shelve(200, 250),
          end('expire', 250),
          shelve(400, 600),
          end('epoch-ended', null),
          shelve(700, 900),
        ],
        800,
      ).get(`cnc-01/${CP}`),
    ).toEqual([
      { from: 0, to: 50 },
      { from: 50, to: 80 },
      { from: 200, to: 250 },
      { from: 400, to: 600 },
      { from: 700, to: 800 },
    ]);
  });

  it('reports shelved and annunciated raises, time to acknowledge, unacknowledged at the end and shelved time, apart from the KPIs', async () => {
    const { app, alarms, send } = await world();
    const kpiUrl = `/alarms/kpi?scope=equipment&id=cnc-01&bucket=hour&from=${iso(t(0))}&to=${iso(t(120))}`;
    // Acknowledged at the plant clock 04:10, 60 minutes after its raise.
    await alarms.acknowledge([ID2], { actor: 'a' });
    // SPINDLE-OVERLOAD shelved 04:10 for 5 minutes; it raises again (shelved) at 04:12.
    await alarms.shelve('cnc-01', SO, {
      actor: 'a',
      reason: 'r',
      durationMs: 5 * MINUTE,
      version: 0,
    });
    await send(raise(E1, 6, t(72), SO), state(E1, 7, t(76)));
    const url = (bucket: string, extra = '') =>
      `/alarms/operator-kpi?scope=equipment&id=cnc-01&bucket=${bucket}&from=${iso(t(0))}&to=${iso(t(120))}${extra}`;
    const hours = operatorKpiListSchema.parse((await get(app, url('hour'))).body);
    expect(hours.epoch).toBe(E1);
    expect(hours.buckets).toEqual([
      {
        key: iso(t(0)),
        from: iso(t(0)),
        to: iso(t(60)),
        raises: 2,
        shelvedRaises: 0,
        annunciatedRaises: 2,
        timeToAck: { count: 1, sumMs: 60 * MINUTE, maxMs: 60 * MINUTE },
        // At 04:00 neither was acknowledged yet.
        unacknowledgedAtEnd: 2,
        shelvedMs: [],
        provisional: false,
      },
      {
        key: iso(t(60)),
        from: iso(t(60)),
        to: iso(t(120)),
        raises: 1,
        shelvedRaises: 1,
        annunciatedRaises: 0,
        timeToAck: { count: 0, sumMs: 0, maxMs: null },
        // At the plant clock (04:16): seq 4 (superseded) and seq 6.
        unacknowledgedAtEnd: 2,
        shelvedMs: [{ equipment: 'cnc-01', code: SO, ms: 5 * MINUTE }],
        provisional: true,
      },
    ]);
    // The occurrence raised while shelved shows the shelf in effect at its raise.
    const history = alarmHistorySchema.parse(
      (await get(app, `/alarms/cnc-01~${String(E1)}~6/history`)).body,
    );
    expect(history.entries.map((e) => [e.source, e.transition, e.at])).toEqual([
      ['audit', 'shelve', iso(t(70))],
      ['fact', 'raised', iso(t(72))],
      ['audit', 'expire', iso(t(75))],
    ]);
    // A new epoch: an acknowledgement then is in a later epoch and never counts as time to ack.
    await send(state(E2, 1, t(80)));
    await alarms.acknowledge([ID4], { actor: 'late' });
    const range = operatorKpiListSchema.parse(
      (await get(app, url('range', `&epoch=${String(E1)}`))).body,
    );
    expect(range.buckets).toMatchObject([
      {
        key: 'range',
        raises: 3,
        shelvedRaises: 1,
        annunciatedRaises: 2,
        timeToAck: { count: 1, sumMs: 60 * MINUTE },
        // Seq 6 ended with its epoch (closed); seq 4 was acknowledged only in the next epoch.
        unacknowledgedAtEnd: 1,
      },
    ]);
    const shifts = operatorKpiListSchema.parse(
      (await get(app, url('shift', `&epoch=${String(E1)}`))).body,
    );
    expect(shifts.buckets.map((b) => [b.key, b.raises, b.shelvedRaises])).toEqual([
      ['2026-10-12/A', 3, 1],
    ]);
    // The KPIs of the closed epoch read the same with and without the operator's tables.
    const before = (await get(app, `${kpiUrl}&epoch=${String(E1)}`)).text;
    await alarms.comment(ID4, { actor: 'a', text: 'after the fact' });
    expect((await get(app, `${kpiUrl}&epoch=${String(E1)}`)).text).toBe(before);
    for (const [bad, status] of [
      [url('week'), 400],
      [
        '/alarms/operator-kpi?scope=position&id=nowhere&bucket=hour&from=2026-10-12T00:00:00Z&to=2026-10-12T06:00:00Z',
        404,
      ],
    ] as const) {
      expect((await get(app, bad)).status).toBe(status);
    }
  });
});

describe('the bounded operator measures query (#156)', () => {
  /** An epoch no device fed: no watermark, so its clock is its latest raise or end. */
  const E9 = 1_760_090_000;
  const occurrenceArb = fc.record({
    equipment: fc.constantFrom('cnc-01', 'cnc-02', 'wsh-01'),
    code: fc.constantFrom(CP, SO),
    raisedAt: fc.integer({ min: t(-12 * 60), max: t(12 * 60) }),
    end: fc.option(
      fc.record({
        after: fc.integer({ min: 0, max: 3 * 60 * MINUTE }),
        reason: fc.constantFrom<EndReason>('cleared', 'lost', 'superseded', 'epoch-ended'),
      }),
    ),
    ack: fc.option(
      fc.record({
        after: fc.option(fc.integer({ min: 0, max: 4 * 60 * MINUTE })),
        epoch: fc.constantFrom(E9, E9 + 1),
      }),
    ),
  });
  const queryArb = fc.record({
    bucket: fc.constantFrom('hour' as const, 'shift' as const, 'range' as const),
    from: fc.integer({ min: t(-14 * 60), max: t(14 * 60) }),
    hours: fc.integer({ min: 1, max: 12 }),
    scope: fc.integer({ min: 0, max: 100 }),
  });

  it('answers exactly as the unbounded computation over random occurrences and acknowledgements', async () => {
    const { db, alarms } = await world();
    const generated = fc.sample(fc.array(occurrenceArb, { minLength: 200, maxLength: 200 }), {
      numRuns: 1,
      seed: 156,
    })[0];
    if (!generated) throw new Error('no sample');
    // Acknowledged early but ended last of all: left out of most queries, yet it sets the clock.
    generated.push({
      equipment: 'cnc-02',
      code: CP,
      raisedAt: t(-13 * 60),
      end: { after: 33 * 60 * MINUTE, reason: 'cleared' },
      ack: { after: MINUTE, epoch: E9 },
    });
    const rows = generated.map((o, seq) => {
      const ackAfter = o.ack?.after ?? null;
      return {
        equipment: o.equipment,
        seq,
        code: o.code,
        raisedAt: o.raisedAt,
        endedAt: o.end === null ? null : o.raisedAt + o.end.after,
        endReason: o.end?.reason ?? null,
        ackPlantAt: ackAfter === null ? null : o.raisedAt + ackAfter,
        ackPlantEpoch: ackAfter === null ? null : (o.ack?.epoch ?? null),
        acknowledged: o.ack !== null,
      };
    });
    await db
      .insertInto('alarms.alarm_occurrence')
      .values(
        rows.map((o) => ({
          equipment: o.equipment,
          epoch: E9,
          seq: o.seq,
          code: o.code,
          severity: 700,
          priority: 'high' as const,
          defined: true,
          source: 'fact' as const,
          raised_at: new Date(o.raisedAt),
          ended_at: o.endedAt === null ? null : new Date(o.endedAt),
          end_reason: o.endReason,
          end_seq: null,
        })),
      )
      .execute();
    await db
      .insertInto('alarms.occurrence_state')
      .values(
        rows
          .filter((o) => o.acknowledged)
          .map((o) => ({
            equipment: o.equipment,
            epoch: E9,
            seq: o.seq,
            acknowledged_by: 'property',
            acknowledged_at: new Date(),
            plant_at: o.ackPlantAt === null ? null : new Date(o.ackPlantAt),
            plant_epoch: o.ackPlantEpoch,
          })),
      )
      .execute();
    const scopes = alarms.scopes();
    for (const query of fc.sample(queryArb, { numRuns: 60, seed: 1156 })) {
      const { from, bucket } = query;
      const to = from + query.hours * 60 * MINUTE;
      const scope = scopes[query.scope % scopes.length];
      if (!scope) throw new Error('no scope');
      // The computation before #156: every occurrence of the scope raised before the last end.
      const defs =
        bucket === 'range'
          ? [{ key: 'range', from, to }]
          : bucket === 'hour'
            ? alarmHourBuckets(from, to)
            : alarmShiftBuckets(plant.shifts, from, to);
      const last = defs.reduce((max, def) => Math.max(max, def.to), to);
      const all = rows.filter((o) => scope.equipment.includes(o.equipment) && o.raisedAt < last);
      let asOf = -Infinity;
      for (const o of all) asOf = Math.max(asOf, o.raisedAt, o.endedAt ?? -Infinity);
      const expected = Number.isFinite(asOf)
        ? operatorMeasures(
            all,
            [],
            E9,
            asOf,
            defs.filter((def) => def.from < asOf),
          )
        : [];
      const actual = await alarms.operatorMeasures({
        scope: scope.scope,
        id: scope.id,
        bucket,
        from: new Date(from),
        to: new Date(to),
        epoch: E9,
      });
      expect([query, scope.id, actual.buckets]).toEqual([query, scope.id, expected]);
    }
  });
});
