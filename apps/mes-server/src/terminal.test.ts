/**
 * The operator terminal (#177) against a real database (as `mes_app`), the real ingest store, the
 * orders and execution modules and the shifts module (with fake report inputs): an operator's
 * start, pause and resume on an order operation as activity intervals with a version (409
 * operation-stale) and their states (409 operation-state); sign-off only once the MES has the
 * operation complete, and a close only once every operation is signed off; crews (sign-on in a
 * running shift, the same session again, a sign-on from another session, sign-off, a session's
 * end, the shift's end, a session no longer live) and their audit; and the API and push:
 * a terminal session for sign-on, the crew check of every operation write, the view and the
 * `terminal:<workCenter>` topic.
 */
import { EventEmitter } from 'node:events';
import {
  expandErpDataset,
  statusKey,
  type FeedEntry,
  type MessageReceipt,
} from '@shopfloor/contracts/erp-api';
import {
  PROBLEM_TYPES,
  crewResultSchema,
  operationResultSchema,
  serverMessageSchema,
  shiftReportSchema,
  terminalViewSchema,
  type ServerMessage,
} from '@shopfloor/contracts/mes-api';
import type { EquipmentPath } from '@shopfloor/contracts';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import { PLANT_CONFIG, UnsFeed, freshDatabase } from './modules/equipment/test-support.ts';
import { Execution } from './modules/execution/index.ts';
import { Identity, type SessionUser } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData, erpMasterData } from './modules/master-data/index.ts';
import {
  OrderError,
  Orders,
  type CommandPublisher,
  type ErpApi,
  type FeedPage,
  type PostOutcome,
} from './modules/orders/index.ts';
import type { ApiSources, PushSocket } from './modules/realtime/index.ts';
import { memoizeOrderExecution } from './modules/realtime/terminal-view.ts';
import {
  ShiftError,
  Shifts,
  type ShiftChange,
  type ShiftsSources,
} from './modules/shifts/index.ts';
import { timed } from '@shopfloor/test-kit/timing';
import { startDatabase } from './testing.ts';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
/** Monday 2026-10-12 06:00 local: shift A (03:00–11:00Z) is running. */
const PLANT_T0 = Date.parse('2026-10-12T03:00:00.000Z');
const E1 = 1_760_000_000;
const PASSWORD = 'a-long-test-password';
const HOST = 'localhost:4700';
const HEADERS = { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' };

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
let paths: Map<string, EquipmentPath>;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  paths = new Map();
  for (const area of plant.plant.areas) {
    for (const wc of area.workCenters) {
      for (const item of wc.equipment) {
        paths.set(item.id, { area: area.id, workCenter: wc.id, equipment: item.id });
      }
    }
  }
}, 180_000);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

afterAll(async () => {
  await container.stop();
});

class FakeErp implements ErpApi {
  readonly entries: FeedEntry[] = [];
  readonly posts: { kind: string; key: string; body: unknown }[] = [];

  feed(after: number, limit: number): Promise<FeedPage> {
    const entries = this.entries.slice(after, after + limit);
    return Promise.resolve({
      kind: 'page',
      page: {
        feedId: 'd'.repeat(32),
        entries,
        cursor: entries.at(-1)?.feedSeq ?? after,
        more: after + entries.length < this.entries.length,
      },
    });
  }

  post(kind: 'status' | 'confirmation', key: string, body: unknown): Promise<PostOutcome> {
    this.posts.push({ kind, key, body });
    return Promise.resolve({
      kind: 'stored',
      status: 201,
      receipt: {
        idempotencyKey: key,
        kind: kind === 'status' ? 'status' : 'confirmation',
        orderNumber: key.split('~')[0] ?? '',
        receivedSeq: this.posts.length,
        receivedAt: new Date(T0).toISOString(),
      } satisfies MessageReceipt,
    });
  }
}

class Sink implements CommandPublisher {
  readonly connected = true;
  publish(): Promise<void> {
    return Promise.resolve();
  }
}

/** The facts of one simulator run, numbered per machine, at rising plant times. */
class Line {
  readonly #feed: UnsFeed;
  readonly #seqs = new Map<string, number>();
  #at = PLANT_T0;

  constructor(feed: UnsFeed) {
    this.#feed = feed;
  }

  #next(equipment: string): number {
    const seq = (this.#seqs.get(equipment) ?? 0) + 1;
    this.#seqs.set(equipment, seq);
    return seq;
  }

  #time(): number {
    this.#at += 60_000;
    return this.#at;
  }

  state(equipment: string, state: 'Idle' | 'Running', cause: string | null = null) {
    return this.#feed.state(equipment, E1, this.#next(equipment), this.#time(), state, cause);
  }

  cycle(equipment: string, partId: number, result: 'good' | 'scrap', reason: string | null) {
    return this.#feed.cycle(equipment, E1, this.#next(equipment), this.#time(), {
      product: 'VB-100',
      partId,
      serial: equipment.startsWith('cnc') ? `VB-100-${String(partId).padStart(6, '0')}` : '',
      result,
      reason,
    });
  }

  job(equipment: string, transition: 'accepted' | 'started' | 'completed', orderId: string) {
    return this.#feed.job(equipment, E1, this.#next(equipment), this.#time(), {
      transition,
      commandId: `${orderId}~OP10~1`,
      orderId,
      product: 'VB-100',
      quantity: 1,
    });
  }
}

/** The shifts module's report inputs: only the plant clock matters to crews. */
function shiftSources(clock: { at: number | undefined }): ShiftsSources {
  const none = () => () => undefined;
  return {
    equipment: {
      watermark: (epoch: number) =>
        epoch === E1 && clock.at !== undefined ? new Date(clock.at) : undefined,
      watermarks: () =>
        clock.at === undefined ? [] : [{ epoch: E1, watermark: new Date(clock.at) }],
      downtimeRecords: () => Promise.resolve([]),
      stateHourly: () => Promise.resolve([]),
      intervals: () => Promise.resolve([{ start: new Date(PLANT_T0) }]),
    },
    oee: {
      shift: () => Promise.resolve({ equipment: [], workCenters: [] }),
      paretoInputs: () => Promise.resolve({ losses: [], stops: [], members: [] }),
      reasonCodes: () => Promise.resolve([]),
      config: plant.oee,
      workCenters: () =>
        Promise.resolve([{ id: 'line-a1', name: 'Line A1', equipment: ['asm-01'] }]),
      onChange: none,
    },
    alarms: {
      scopes: () => [],
      kpis: () => Promise.resolve([]),
      badActors: () => Promise.resolve({ epoch: E1, actors: [] }),
      operatorMeasures: () => Promise.resolve({ epoch: E1, buckets: [] }),
      onChange: none,
    },
  } as unknown as ShiftsSources;
}

interface Harness {
  readonly db: Kysely<Database>;
  readonly ingest: Ingest;
  readonly orders: Orders;
  readonly execution: Execution;
  readonly shifts: Shifts;
  readonly identity: Identity;
  readonly erp: FakeErp;
  readonly line: Line;
  readonly clock: { at: number | undefined };
  /** Session ids `live` answers false for. */
  readonly dead: Set<string>;
  readonly crewChanges: ShiftChange[];
  readonly sam: SessionUser;
  readonly olga: SessionUser;
  readonly omar: SessionUser;
}

async function harness(name: string): Promise<Harness> {
  const db = await freshDatabase(serverUrl, `terminal_${name}`);
  cleanups.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const identity = new Identity({ db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
  await identity.start();
  cleanups.push(() => {
    identity.stop();
    return Promise.resolve();
  });
  const user = async (username: string, role: 'supervisor' | 'operator' | 'quality') => {
    const created = await identity.createUser(
      { username, roles: [role], password: PASSWORD, mustChangePassword: false },
      { system: 'test' },
    );
    return { userId: created.id, username, roles: [role] } satisfies SessionUser;
  };
  const sam = await user('sam', 'supervisor');
  const olga = await user('olga', 'operator');
  const omar = await user('omar', 'operator');
  await user('quinn', 'quality');
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'x',
    sweepIntervalMs: 0,
    gapGraceMs: 3_600_000,
    now: () => T0,
  });
  const erp = new FakeErp();
  const clock = { at: (PLANT_T0 + 3 * 3_600_000) as number | undefined };
  const orders = new Orders({
    db,
    ingest,
    masterData,
    publisher: new Sink(),
    erp,
    clock: () => (clock.at === undefined ? undefined : new Date(clock.at)),
    now: () => T0,
    tickMs: 0,
    erpPollMs: 0,
    erpPostMs: 0,
    timings: { ttlMs: 3_600_000, failMarginMs: 3_600_000 },
  });
  await orders.start();
  cleanups.push(() => orders.stop());
  const execution = new Execution({
    db,
    ingest,
    masterData,
    orders,
    rework: { test: 'OP40', back: 'OP30' },
    clock: () => new Date(PLANT_T0),
    tickMs: 0,
  });
  await execution.start();
  cleanups.push(() => execution.stop());
  orders.useBlankCounter(execution);
  const dead = new Set<string>();
  const shifts = new Shifts({
    ...shiftSources(clock),
    db,
    shiftPattern: await masterData.shiftPattern(),
    tickMs: 3_600_000,
    sessions: { live: (id) => Promise.resolve(!dead.has(id)) },
    crewCheckMs: 0,
    afterCrewCheck: (signedOn, readAt) => orders.endOrphanedActivities(signedOn, readAt),
  });
  await shifts.start();
  cleanups.push(() => shifts.stop());
  const crewChanges: ShiftChange[] = [];
  // As main.ts wires them: an ended crew row closes its operator's activities there.
  shifts.onChange((change) => {
    if (change.type !== 'crew') return;
    crewChanges.push(change);
    if (change.event === 'ended') {
      void orders.endActivities({
        userId: change.crew.userId,
        workCenter: change.crew.workCenter,
        until: change.crew.to ?? new Date(),
      });
    }
  });
  identity.onSessionsEnded((ended) => {
    void shifts.endCrewForSessions(ended.ids);
  });
  return {
    db,
    ingest,
    orders,
    execution,
    shifts,
    identity,
    erp,
    line: new Line(new UnsFeed(paths)),
    clock,
    dead,
    crewChanges,
    sam,
    olga,
    omar,
  };
}

/** Imports, releases and dispatches an order of one VB-100 to CNC-01. */
async function dispatched(h: Harness, number: string): Promise<void> {
  const expanded = expandErpDataset(
    {
      orders: [
        {
          orderNumber: number,
          revision: 1,
          product: 'VB-100',
          quantity: 1,
          plannedStart: '2026-10-12T06:00:00+03:00',
          dueDate: '2026-10-12T14:00:00+03:00',
        },
      ],
    },
    erpMasterData(plant),
  );
  if (!expanded.ok) throw new Error(expanded.issues.join('\n'));
  h.erp.entries.push(...expanded.feed.map((e) => ({ ...e, feedSeq: h.erp.entries.length + 1 })));
  await h.orders.importNow();
  const by = { by: h.sam, requestId: 'req-s' };
  const imported = await h.orders.order(number);
  const released = await h.orders.release(number, { version: imported?.version ?? 0 }, by);
  await h.orders.dispatch(number, { version: released.version, equipment: 'cnc-01' }, by);
}

const send = async (h: Harness, deliveries: readonly { topic: string; payload: string }[]) => {
  for (const d of deliveries) await h.ingest.deliver(d.topic, d.payload);
};

/** The database's clock (the activity intervals' wall times are its). */
async function dbNow(h: Harness): Promise<Date> {
  const { rows } = await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(h.db);
  return rows[0]?.at ?? new Date();
}

async function settle(h: Harness): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await h.orders.tick();
    await h.execution.tick();
  }
  while ((await h.orders.postNow()) > 0) {
    // until nothing is pending
  }
}

/** An order dispatched and started (its job `started`): in progress, no operation complete. */
async function started(h: Harness, number: string): Promise<void> {
  await send(h, [h.line.state('cnc-01', 'Idle', 'NO-ORDER')]);
  await dispatched(h, number);
  await send(h, [
    h.line.job('cnc-01', 'accepted', number),
    h.line.job('cnc-01', 'started', number),
  ]);
  await settle(h);
}

/** Its one unit scrapped at OP10 and its job completed: every operation complete. */
async function finished(h: Harness, number: string, partId: number): Promise<void> {
  await send(h, [
    h.line.cycle('cnc-01', partId, 'scrap', 'DIMENSIONAL'),
    h.line.job('cnc-01', 'completed', number),
    h.line.state('cnc-01', 'Idle', 'NO-ORDER'),
  ]);
  await settle(h);
}

const version = async (h: Harness, id: string, operation: string): Promise<number> =>
  (await h.orders.operations({ orderIds: [id], operation }))[0]?.version ?? 0;

/** The operator's own open interval on the operation (its id), null when none. */
const mine = async (h: Harness, id: string, operation: string, user: SessionUser) =>
  (await h.orders.operations({ orderIds: [id], operation }))[0]?.activities.find(
    (a) => a.userId === user.userId,
  )?.id ?? null;

describe('operator activity and operation sign-off (#177)', () => {
  it('keeps start, pause and resume as intervals checked against the operator’s own interval; signs off only complete operations; a close needs every sign-off', async () => {
    const h = await harness('activity');
    await started(h, 'A-1');
    expect((await h.orders.order('A-1'))?.status).toBe('in-progress');
    const olga = { by: h.olga, requestId: 'req-o' };
    const omar = { by: h.omar, requestId: 'req-m' };

    const v1 = await version(h, 'A-1', 'OP30');
    expect(v1).toBe(1);
    // Sign-off before the MES has the operation complete: refused.
    await expect(h.orders.signOff('A-1', 'OP30', { version: v1 }, olga)).rejects.toMatchObject({
      kind: 'conflict',
      type: PROBLEM_TYPES.operationState,
    });
    const working = await h.orders.startWork('A-1', 'OP30', { activity: null }, olga);
    expect(working).toMatchObject({ version: 2, completedAt: null, signedOff: null });
    expect(working.activities).toMatchObject([
      { username: 'olga', kind: 'work', reason: null, to: null },
    ]);
    const olgaWork = working.activities[0]?.id ?? 0;
    // A second operator works on it too: olga's writes never become stale through omar's.
    const both = await h.orders.startWork('A-1', 'OP30', { activity: null }, omar);
    expect(both.activities.map((a) => a.username)).toEqual(['olga', 'omar']);
    // Olga can't start twice (she read none, but one of hers is open: stale), nor resume work.
    await expect(h.orders.startWork('A-1', 'OP30', { activity: null }, olga)).rejects.toMatchObject(
      { type: PROBLEM_TYPES.operationStale },
    );
    await expect(
      h.orders.resumeWork('A-1', 'OP30', { activity: olgaWork }, olga),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.operationState });
    // An interval she didn't read: refused before any state check.
    const stale = await h.orders
      .pauseWork('A-1', 'OP30', { activity: olgaWork + 1000, reason: 'material' }, olga)
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(OrderError);
    expect(stale).toMatchObject({ kind: 'conflict', type: PROBLEM_TYPES.operationStale });
    // A version where an interval is expected (and the reverse): stale.
    await expect(
      h.orders.signOff('A-1', 'OP30', { activity: null } as never, olga),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.operationStale });
    const paused = await h.orders.pauseWork(
      'A-1',
      'OP30',
      { activity: olgaWork, reason: 'material', comment: 'no seals' },
      olga,
    );
    const olgaPause = paused.activities.find((a) => a.username === 'olga');
    expect(olgaPause).toMatchObject({ kind: 'pause', reason: 'material', comment: 'no seals' });
    await expect(
      h.orders.pauseWork('A-1', 'OP30', { activity: olgaPause?.id ?? 0, reason: 'break' }, olga),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.operationState });
    const resumed = await h.orders.resumeWork(
      'A-1',
      'OP30',
      { activity: olgaPause?.id ?? 0 },
      olga,
    );
    expect(resumed.version).toBe(5);
    const history = await h.orders.activities({
      orderId: 'A-1',
      operation: 'OP30',
      userId: h.olga.userId,
    });
    expect(history.map((a) => [a.kind, a.reason, a.endReason])).toEqual([
      ['work', null, null],
      ['pause', 'material', 'resumed'],
      ['work', null, 'paused'],
    ]);
    // The pause took the plant clock, never the machine's: the order's status is untouched.
    expect(history[1]?.fromPlant).toEqual(new Date(h.clock.at ?? 0));
    expect((await h.orders.order('A-1'))?.status).toBe('in-progress');

    // The unit is scrapped at OP10: every operation complete, the order completed.
    await finished(h, 'A-1', 1);
    const order = await h.orders.order('A-1');
    expect(order?.status).toBe('completed');
    const by = { by: h.sam, requestId: 'req-s' };
    const refused = await h.orders
      .close('A-1', { version: order?.version ?? 0 }, by)
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: 'conflict', type: PROBLEM_TYPES.signOffMissing });
    expect((refused as Error).message).toContain('OP10 (cell-m1)');
    const ops = await h.orders.operations({ orderIds: ['A-1'] });
    expect(ops.map((o) => [o.operation, o.completedAt !== null, o.signedOff])).toEqual(
      ['OP10', 'OP20', 'OP30', 'OP40', 'OP50'].map((op) => [op, true, null]),
    );
    // A sign-off decides for everyone: it names the operation's version.
    await expect(h.orders.signOff('A-1', 'OP30', { version: 4 }, olga)).rejects.toMatchObject({
      type: PROBLEM_TYPES.operationStale,
    });
    const signed = await h.orders.signOff('A-1', 'OP30', { version: 5 }, olga);
    expect(signed.signedOff).toMatchObject({ username: 'olga' });
    // The sign-off closed every open interval on it, olga's and omar's.
    expect(signed.activities).toEqual([]);
    expect(
      (await h.orders.activities({ orderId: 'A-1', operation: 'OP30' }))
        .filter((a) => a.endReason === 'signed-off')
        .map((a) => a.username)
        .sort(),
    ).toEqual(['olga', 'omar']);
    await expect(h.orders.startWork('A-1', 'OP30', { activity: null }, omar)).rejects.toMatchObject(
      { type: PROBLEM_TYPES.operationState },
    );
    await expect(h.orders.signOff('A-1', 'OP30', { version: 6 }, omar)).rejects.toMatchObject({
      type: PROBLEM_TYPES.operationState,
    });
    for (const op of ['OP10', 'OP20', 'OP40', 'OP50']) {
      await h.orders.signOff('A-1', op, { version: await version(h, 'A-1', op) }, omar);
    }
    const closed = await h.orders.close('A-1', { version: order?.version ?? 0 }, by);
    expect(closed.status).toBe('closed');
    expect(h.erp.posts.map((p) => p.key)).not.toContain(statusKey('A-1', 1, 'closed'));
    await settle(h);
    expect(h.erp.posts.map((p) => p.key)).toContain(statusKey('A-1', 1, 'closed'));
    // A closed order takes no terminal write.
    await expect(h.orders.startWork('A-1', 'OP40', { activity: null }, omar)).rejects.toMatchObject(
      { type: PROBLEM_TYPES.operationState },
    );
    // Every terminal write is audited with its operator, request id and plant time.
    const audit = await Identity.auditEntries(h.db, 'order_operation', ['A-1/OP30']);
    expect(audit.map((e) => [e.action, e.username, e.authenticated])).toEqual([
      ['operation.sign-off', 'olga', true],
      ['operation.resume', 'olga', true],
      ['operation.pause', 'olga', true],
      ['operation.start', 'omar', true],
      ['operation.start', 'olga', true],
    ]);
    expect(audit[2]).toMatchObject({
      requestId: 'req-o',
      roles: ['operator'],
      after: { reason: 'material', comment: 'no seals', workCenter: 'line-a1', version: 4 },
    });
    expect(audit[0]?.plantAt).toEqual(new Date(h.clock.at ?? 0));
  });

  it('closes an operator’s intervals when their crew row ends, never later work, and those left without a crew row', async () => {
    const h = await harness('crew_end');
    await started(h, 'B-1');
    const olga = { by: h.olga, requestId: 'r' };
    const omar = { by: h.omar, requestId: 'r' };
    await h.orders.startWork('B-1', 'OP30', { activity: null }, olga);
    await h.orders.startWork('B-1', 'OP40', { activity: null }, olga);
    await h.orders.startWork('B-1', 'OP10', { activity: null }, omar);
    const now = await dbNow(h);
    expect(
      await h.orders.endActivities({ userId: h.olga.userId, workCenter: 'line-a1', until: now }),
    ).toBe(2);
    expect(
      await h.orders.endActivities({ userId: h.olga.userId, workCenter: 'line-a1', until: now }),
    ).toBe(0);
    // A late notice of a crew row that ended before olga's new start never closes the new work.
    await h.orders.startWork('B-1', 'OP30', { activity: null }, olga);
    expect(
      await h.orders.endActivities({ userId: h.olga.userId, workCenter: 'line-a1', until: now }),
    ).toBe(0);
    expect(await mine(h, 'B-1', 'OP30', h.olga)).not.toBeNull();
    // Orphans: only intervals started before the crew rows were read. Read at `now`, omar's
    // (begun before) is judged and closed; olga's new work (begun after) is not.
    expect(await h.orders.endOrphanedActivities(new Set(), now)).toBe(1);
    expect(
      (await h.orders.activities({ orderId: 'B-1', open: true })).map((a) => a.username),
    ).toEqual(['olga']);
    // Read later with olga signed on: nothing is an orphan.
    const later = await dbNow(h);
    expect(
      await h.orders.endOrphanedActivities(new Set([`${String(h.olga.userId)}|line-a1`]), later),
    ).toBe(0);
  });

  it('refuses a write whose crew row is gone, holds a crew end until the write commits, and never rewrites a closed interval', async () => {
    const h = await harness('crew_lock');
    await started(h, 'D-1');
    await h.shifts.tick();
    const session = 'f'.repeat(64);
    await h.shifts.signOn('line-a1', h.olga, session);
    const lockCrew = (trx: Transaction<Database>, workCenter: string) =>
      h.shifts.lockCrew(trx, { userId: h.olga.userId, workCenter, sessionId: session });
    const olga = { by: h.olga, requestId: 'r', lockCrew };
    const working = await h.orders.startWork('D-1', 'OP30', { activity: null }, olga);
    // Signed on at line-a1 only: a write at cell-m1 is refused inside its transaction.
    await expect(h.orders.startWork('D-1', 'OP10', { activity: null }, olga)).rejects.toMatchObject(
      { type: PROBLEM_TYPES.notSignedOn },
    );
    // A transaction holding the crew row (as a terminal write does) makes a sign-off wait.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = h.db.transaction().execute(async (trx) => {
      expect(await lockCrew(trx, 'line-a1')).toBe(true);
      locked();
      await held;
    });
    await isLocked;
    let signedOff = false;
    const off = h.shifts.signOff('line-a1', h.olga, session).then((crew) => {
      signedOff = true;
      return crew;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(signedOff).toBe(false);
    release();
    await holder;
    const ended = await off;
    expect(ended.endReason).toBe('sign-off');
    // The crew row is gone: the next write is refused, whatever it names.
    await expect(
      h.orders.pauseWork(
        'D-1',
        'OP30',
        { activity: working.activities[0]?.id ?? 0, reason: 'break' },
        olga,
      ),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.notSignedOn });
    // A crew end that closes an interval while a write waits for it: the write finds it closed
    // (stale) and the interval keeps its end.
    const omarSession = 'e'.repeat(64);
    await h.shifts.signOn('line-a1', h.omar, omarSession);
    const omar = {
      by: h.omar,
      requestId: 'r',
      lockCrew: (trx: Transaction<Database>, workCenter: string) =>
        h.shifts.lockCrew(trx, { userId: h.omar.userId, workCenter, sessionId: omarSession }),
    };
    const work = await h.orders.startWork('D-1', 'OP40', { activity: null }, omar);
    const id = work.activities[0]?.id ?? 0;
    let closing: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      closing = resolve;
    });
    let go: () => void = () => undefined;
    const proceed = new Promise<void>((resolve) => {
      go = resolve;
    });
    const crewEnd = h.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('orders.operation_activity')
        .set({
          to_at: sql<Date>`clock_timestamp()`,
          to_plant_at: sql<Date>`from_plant_at`,
          end_reason: 'crew-ended',
        })
        .where('id', '=', id)
        .execute();
      closing();
      await proceed;
    });
    await closed;
    const pause = h.orders
      .pauseWork('D-1', 'OP40', { activity: id, reason: 'break' }, omar)
      .catch((e: unknown) => e);
    // Until the write waits for the crew end's lock, not a fixed 200 ms (#212).
    for (const deadline = Date.now() + 30_000; ;) {
      const waiting = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(h.db);
      if ((waiting.rows[0]?.n ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error('the pause never waited for the crew end');
      await new Promise((r) => setTimeout(r, 20));
    }
    go();
    await crewEnd;
    expect(await pause).toMatchObject({ type: PROBLEM_TYPES.operationStale });
    const [kept] = await h.orders.activities({ orderId: 'D-1', operation: 'OP40' });
    expect(kept).toMatchObject({ id, endReason: 'crew-ended' });
  });

  it('closes orphaned intervals on the crew-check tick', async () => {
    const h = await harness('orphans');
    await started(h, 'E-1');
    // Olga works without a crew row (a crew end whose notice was lost).
    await h.orders.startWork('E-1', 'OP30', { activity: null }, { by: h.olga, requestId: 'r' });
    await h.shifts.signOn('line-a1', h.omar, 'c'.repeat(64));
    await h.orders.startWork('E-1', 'OP40', { activity: null }, { by: h.omar, requestId: 'r' });
    await h.shifts.tick();
    const open = await h.orders.activities({ orderId: 'E-1', open: true });
    expect(open.map((a) => a.username)).toEqual(['omar']);
    expect((await h.orders.activities({ orderId: 'E-1', operation: 'OP30' }))[0]?.endReason).toBe(
      'crew-ended',
    );
  });
});

describe('crews (#177)', () => {
  it('signs on in the running shift, answers the same session again, replaces another session, and ends rows on sign-off, session end, shift end and dead sessions', async () => {
    const h = await harness('crew');
    await h.shifts.tick();
    const instance = h.shifts.currentInstance();
    expect(instance?.key).toBe('2026-10-12/A');
    const first = await h.shifts.signOn('line-a1', h.olga, 'a'.repeat(64), 'req-1');
    expect(first).toMatchObject({
      username: 'olga',
      workCenter: 'line-a1',
      shiftKey: '2026-10-12/A',
      epoch: E1,
      to: null,
      fromPlant: new Date(h.clock.at ?? 0),
    });
    const same = await h.shifts.signOn('line-a1', h.olga, 'a'.repeat(64));
    expect(same.id).toBe(first.id);
    // Several operators at one work center; one operator at two work centers.
    await h.shifts.signOn('line-a1', h.omar, 'b'.repeat(64));
    await h.shifts.signOn('cell-m1', h.olga, 'a'.repeat(64));
    expect(
      (await h.shifts.crew({ workCenter: 'line-a1', open: true })).map((c) => c.username),
    ).toEqual(['olga', 'omar']);
    // Olga on another tablet: the first row ends `replaced`.
    const moved = await h.shifts.signOn('line-a1', h.olga, 'c'.repeat(64));
    expect(moved.id).not.toBe(first.id);
    expect(
      (await h.shifts.crew({ userId: h.olga.userId, workCenter: 'line-a1' })).map(
        (c) => c.endReason,
      ),
    ).toEqual(['replaced', null]);
    // Only the session holding the row signs it off.
    await expect(h.shifts.signOff('line-a1', h.olga, 'a'.repeat(64))).rejects.toMatchObject({
      kind: 'conflict',
      type: PROBLEM_TYPES.notSignedOn,
    });
    const off = await h.shifts.signOff('line-a1', h.olga, 'c'.repeat(64), 'req-2');
    expect(off).toMatchObject({ id: moved.id, endReason: 'sign-off' });
    await expect(h.shifts.signOff('line-a1', h.olga, 'c'.repeat(64))).rejects.toMatchObject({
      kind: 'conflict',
      type: PROBLEM_TYPES.notSignedOn,
    });
    // Olga's session at cell-m1 ends (logout): its row ends.
    const ended = await h.shifts.endCrewForSessions(['a'.repeat(64)]);
    expect(ended.map((c) => [c.workCenter, c.endReason])).toEqual([['cell-m1', 'session-ended']]);
    // A session that expired (idle): the tick ends its row.
    h.dead.add('b'.repeat(64));
    await h.shifts.tick();
    expect((await h.shifts.crew({ userId: h.omar.userId }))[0]?.endReason).toBe('session-ended');
    // The shift's end: rows close at its end.
    await h.shifts.signOn('line-a1', h.olga, 'd'.repeat(64));
    h.clock.at = Date.parse('2026-10-12T11:30:00.000Z');
    await h.shifts.tick();
    const last = (await h.shifts.crew({ sessionId: 'd'.repeat(64) }))[0];
    expect(last).toMatchObject({
      endReason: 'shift-ended',
      toPlant: new Date('2026-10-12T11:00:00.000Z'),
    });
    expect(h.shifts.currentInstance()?.key).toBe('2026-10-12/B');
    // Without a plant clock nothing is running: sign-on is refused.
    h.clock.at = undefined;
    const noShift = await h.shifts
      .signOn('line-a1', h.olga, 'e'.repeat(64))
      .catch((e: unknown) => e);
    expect(noShift).toBeInstanceOf(ShiftError);
    expect(noShift).toMatchObject({ type: PROBLEM_TYPES.noShift });
    // Every crew row's start and end is audited; the operator's own with the operator.
    const audit = await Identity.auditEntries(h.db, 'crew_assignment', [
      String(first.id),
      String(moved.id),
    ]);
    expect(audit.map((e) => [e.action, e.username, e.authenticated])).toEqual([
      ['crew.sign-off', 'olga', true],
      ['crew.sign-on', 'olga', true],
      ['crew.end', 'shifts', false],
      ['crew.sign-on', 'olga', true],
    ]);
    expect(audit[3]).toMatchObject({
      requestId: 'req-1',
      after: { workCenter: 'line-a1', shiftKey: '2026-10-12/A' },
    });
    expect(h.crewChanges.map((c) => c.event)).toContain('ended');
    // The shift report's crew section.
    const report = await h.shifts.report('2026-10-12', 'A', E1);
    expect(report?.crew.map((c) => [c.username, c.workCenter, c.endReason])).toEqual([
      ['olga', 'cell-m1', 'session-ended'],
      ['olga', 'line-a1', 'replaced'],
      ['omar', 'line-a1', 'session-ended'],
      ['olga', 'line-a1', 'sign-off'],
      ['olga', 'line-a1', 'shift-ended'],
    ]);
  });
});

describe('crews at the edges (#177 review)', () => {
  it('lets two racing sign-ons of one user end with one open row, ends a past instance’s row at its end, and keeps a report with an open crew row from being final', async () => {
    const h = await harness('crew_edges');
    await h.shifts.tick();
    // Two sign-ons of olga at once (two tablets): one insert loses on the open-row index and is
    // tried again; both answer, one row stays open.
    const [x, y] = await Promise.all([
      h.shifts.signOn('line-a1', h.olga, '1'.repeat(64)),
      h.shifts.signOn('line-a1', h.olga, '2'.repeat(64)),
    ]);
    expect(x.id).not.toBe(y.id);
    const rows = await h.shifts.crew({ userId: h.olga.userId, workCenter: 'line-a1' });
    expect(rows.filter((r) => r.to === null)).toHaveLength(1);
    expect(rows.filter((r) => r.endReason === 'replaced')).toHaveLength(1);
    // The shift ends with the crew row still open and no tick yet: the report is not final.
    h.clock.at = Date.parse('2026-10-12T11:30:00.000Z');
    const early = await h.shifts.report('2026-10-12', 'A', E1);
    expect(early?.instance.status).toBe('ended');
    expect(early?.crew.some((c) => c.to === null)).toBe(true);
    await h.shifts.tick();
    const late = await h.shifts.report('2026-10-12', 'A', E1);
    expect(late?.instance.status).toBe('final');
    expect(late?.crew.every((c) => c.to !== null)).toBe(true);
    // A row of the past instance still open (its end missed): a sign-on in the new shift ends it
    // at that instance's end, as `shift-ended`, not `replaced` at the plant clock.
    await h.db
      .insertInto('shifts.crew_assignment')
      .values({
        user_id: h.omar.userId,
        username: 'omar',
        work_center: 'line-a1',
        epoch: E1,
        shift_key: '2026-10-12/A',
        session_id: '3'.repeat(64),
        from_at: new Date(T0),
        from_plant_at: new Date('2026-10-12T09:00:00.000Z'),
      })
      .execute();
    await h.shifts.signOn('line-a1', h.omar, '4'.repeat(64));
    const omarRows = await h.shifts.crew({ userId: h.omar.userId, workCenter: 'line-a1' });
    const past = omarRows.find((r) => r.shiftKey === '2026-10-12/A');
    const now = omarRows.find((r) => r.shiftKey === '2026-10-12/B');
    expect(past).toMatchObject({
      shiftKey: '2026-10-12/A',
      endReason: 'shift-ended',
      toPlant: new Date('2026-10-12T11:00:00.000Z'),
    });
    expect(now).toMatchObject({ shiftKey: '2026-10-12/B', to: null });
  });
});

describe('the terminal view after a change (#190 re-review)', () => {
  it('drops the kept order execution on a change, so a view computed in the same pace window is fresh', async () => {
    let reads = 0;
    let clock = 0;
    const memo = memoizeOrderExecution(
      {
        orderExecution: () => Promise.resolve({ orderId: 'X', read: ++reads } as unknown as never),
        scrapRecords: () => Promise.resolve({ records: [], truncated: false }),
      },
      1_000,
      () => clock,
    );
    await memo.orderExecution('X');
    await memo.orderExecution('X');
    expect(reads).toBe(1);
    memo.clear();
    await memo.orderExecution('X');
    expect(reads).toBe(2);
    clock = 1_000;
    await memo.orderExecution('X');
    expect(reads).toBe(3);
  });

  it('pushes the counts of a change within a pace with terminalMs > 0, also after the last cycle', async () => {
    const h = await harness('memo');
    await h.shifts.tick();
    await started(h, 'M-1');
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity: h.identity,
      auth: true,
      push: { heartbeatMs: 3_600_000, clockMs: 3_600_000, terminalMs: 2_000 },
    });
    cleanups.push(() => http.app.close());
    const none = () => () => undefined;
    await http.realtime.attach({
      masterData: new MasterData(h.db),
      equipment: {
        currentStates: () => [],
        currentState: () => undefined,
        onChange: none,
        watermark: () => undefined,
        watermarks: () => [],
      },
      ingest: { onStored: none, telemetryMetrics: () => Promise.resolve([]) },
      oee: { workCenters: () => Promise.resolve([]), onChange: none },
      coding: {},
      orders: h.orders,
      execution: h.execution,
      shifts: h.shifts,
    } as unknown as ApiSources);
    const sent: ServerMessage[] = [];
    const emitter = new EventEmitter();
    const socket = Object.assign(emitter, {
      bufferedAmount: 0,
      send: (data: string) => {
        sent.push(serverMessageSchema.parse(JSON.parse(data)));
      },
      ping: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
    }) as unknown as PushSocket;
    http.realtime.push.connect(socket);
    const subscribe = (topic: string) => {
      emitter.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', topic })), false);
    };
    const until = async (check: () => boolean, ms: number) => {
      for (let deadline = Date.now() + ms; !check();) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const scrapAtCell = (m: ServerMessage) =>
      'view' in m &&
      m.topic === 'terminal:cell-m1' &&
      m.view.orders[0]?.operations[0]?.counts.scrap === 1;
    // Cell M1's view first; a pace later Line A1's, which keeps the order's execution in the memo.
    subscribe('terminal:cell-m1');
    await until(() => sent.some((m) => m.type === 'snapshot'), 60_000);
    await new Promise((r) => setTimeout(r, 2_100));
    subscribe('terminal:line-a1');
    await until(() => sent.filter((m) => m.type === 'snapshot').length === 2, 60_000);
    expect(sent.some(scrapAtCell)).toBe(false);
    // The order's last cycle (a scrap at OP10), inside Line A1's window: Cell M1 is due at once
    // and must not read the kept execution. Nothing changes afterwards.
    await finished(h, 'M-1', 1);
    // Within a pace (2 s), plus whatever a loaded machine delayed the scheduler meanwhile (#212):
    // a wide deadline to wait, and the bound checked on what was measured.
    const { elapsedMs, maxLagMs } = await timed(() => until(() => sent.some(scrapAtCell), 60_000));
    expect(elapsedMs).toBeLessThan(2_000 + maxLagMs);
  }, 180_000);
});

describe('the terminal API and push (#177)', () => {
  it('signs on with a terminal session, checks the crew on every write, serves the view and pushes it', async () => {
    const h = await harness('api');
    await h.shifts.tick();
    await started(h, 'C-1');
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity: h.identity,
      auth: true,
      userWriteRate: { perSecond: 1e6, burst: 1e6 },
      writeRate: { perSecond: 1e6, burst: 1e6 },
      push: { heartbeatMs: 3_600_000, clockMs: 3_600_000, terminalMs: 0 },
    });
    cleanups.push(() => http.app.close());
    const none = () => () => undefined;
    await http.realtime.attach({
      masterData: new MasterData(h.db),
      equipment: {
        currentStates: () => [
          {
            equipment: 'asm-01',
            epoch: E1,
            state: 'Running',
            cause: null,
            since: new Date(PLANT_T0),
            seq: 1,
            until: null,
          },
        ],
        currentState: () => undefined,
        onChange: none,
        watermark: () => undefined,
        watermarks: () => [],
      },
      ingest: { onStored: none, telemetryMetrics: () => Promise.resolve([]) },
      oee: { workCenters: () => Promise.resolve([]), onChange: none },
      coding: {},
      orders: h.orders,
      execution: h.execution,
      shifts: h.shifts,
    } as unknown as ApiSources);
    const login = async (username: string, kind: 'desk' | 'terminal') => {
      const response = await http.app.inject({
        method: 'POST',
        url: '/api/v1/session',
        headers: HEADERS,
        payload: { username, password: PASSWORD, kind },
      });
      expect(response.statusCode, response.body).toBe(200);
      return String(response.headers['set-cookie']).split(';')[0] ?? '';
    };
    const call = (
      cookie: string,
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      payload?: unknown,
    ) =>
      http.app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { ...HEADERS, cookie },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const desk = await login('olga', 'desk');
    const signOnDesk = await call(desk, 'POST', '/terminal/line-a1/sign-on', {});
    expect(signOnDesk.statusCode).toBe(409);
    expect(signOnDesk.json()).toMatchObject({ type: PROBLEM_TYPES.terminalSessionRequired });
    const olga = await login('olga', 'terminal');
    expect((await call(olga, 'POST', '/terminal/nowhere/sign-on', {})).statusCode).toBe(404);
    const signOn = await call(olga, 'POST', '/terminal/line-a1/sign-on', {});
    expect(signOn.statusCode, signOn.body).toBe(200);
    expect(crewResultSchema.parse(signOn.json()).crew).toMatchObject({
      username: 'olga',
      workCenter: 'line-a1',
    });
    // A quality user may code scrap but not operate a terminal (403, before anything else).
    const quinn = await login('quinn', 'terminal');
    expect((await call(quinn, 'POST', '/terminal/line-a1/sign-on', {})).json()).toMatchObject({
      type: PROBLEM_TYPES.forbidden,
    });
    // Omar holds a terminal session but is not signed on here: every operation write refused.
    const omar = await login('omar', 'terminal');
    const start = '/terminal/line-a1/orders/C-1/operations/OP30/start';
    const notOn = await call(omar, 'POST', start, { activity: null });
    expect(notOn.statusCode).toBe(409);
    expect(notOn.json()).toMatchObject({ type: PROBLEM_TYPES.notSignedOn });
    // Signed on at Cell M1 is not signed on at Line A1.
    expect((await call(omar, 'POST', '/terminal/cell-m1/sign-on', {})).statusCode).toBe(200);
    expect((await call(omar, 'POST', start, { activity: null })).json()).toMatchObject({
      type: PROBLEM_TYPES.notSignedOn,
    });
    expect((await call(omar, 'POST', '/terminal/cell-m1/sign-off', {})).statusCode).toBe(200);
    // Olga's desk session is not the session she signed on with: refused too.
    expect((await call(desk, 'POST', start, { activity: null })).json()).toMatchObject({
      type: PROBLEM_TYPES.notSignedOn,
    });
    // Nor may her desk session sign off her terminal's crew row.
    expect((await call(desk, 'POST', '/terminal/line-a1/sign-off', {})).json()).toMatchObject({
      type: PROBLEM_TYPES.notSignedOn,
    });
    // OP10 is not at Line A1.
    expect(
      (
        await call(olga, 'POST', '/terminal/line-a1/orders/C-1/operations/OP10/start', {
          activity: null,
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(olga, 'POST', start, { activity: null, actor: 'x' })).statusCode).toBe(400);
    expect((await call(olga, 'POST', start, { version: 1 })).statusCode).toBe(400);

    // Push: the work center's view as a snapshot, then whenever it changed.
    const sent: ServerMessage[] = [];
    const emitter = new EventEmitter();
    const socket = Object.assign(emitter, {
      bufferedAmount: 0,
      send: (data: string) => {
        sent.push(serverMessageSchema.parse(JSON.parse(data)));
      },
      ping: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
    }) as unknown as PushSocket;
    http.realtime.push.connect(socket);
    const subscribe = (topic: string) => {
      emitter.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', topic })), false);
    };
    subscribe('terminal:nowhere');
    subscribe('terminal:line-a1');
    const until = async (check: () => boolean) => {
      for (let deadline = Date.now() + 60_000; !check();) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await until(() => sent.some((m) => m.type === 'snapshot'));
    expect(sent.find((m) => m.type === 'error')).toMatchObject({ code: 'unknown-equipment' });
    const snapshot = sent.find((m) => m.type === 'snapshot');
    expect(snapshot && 'view' in snapshot ? snapshot.view.crew.map((c) => c.username) : []).toEqual(
      ['olga'],
    );

    const started1 = await call(olga, 'POST', start, { activity: null });
    expect(started1.statusCode, started1.body).toBe(200);
    expect(operationResultSchema.parse(started1.json()).operation).toMatchObject({
      version: 2,
      complete: false,
      activities: [{ username: 'olga', kind: 'work' }],
    });
    await until(() =>
      sent.some(
        (m) => m.type === 'terminal' && m.view.orders[0]?.operations[0]?.activities.length === 1,
      ),
    );
    const work = operationResultSchema.parse(started1.json()).operation.activities[0]?.id ?? 0;
    const pause = await call(olga, 'POST', '/terminal/line-a1/orders/C-1/operations/OP30/pause', {
      activity: work,
      reason: 'break',
    });
    expect(pause.statusCode, pause.body).toBe(200);
    // Resuming the work interval she read (closed now): stale.
    const stalePause = await call(
      olga,
      'POST',
      '/terminal/line-a1/orders/C-1/operations/OP30/resume',
      { activity: work },
    );
    expect(stalePause.json()).toMatchObject({ type: PROBLEM_TYPES.operationStale });
    expect(
      (
        await call(olga, 'POST', '/terminal/line-a1/orders/C-1/operations/OP30/pause', {
          activity: work,
          reason: 'nap',
        })
      ).statusCode,
    ).toBe(400);

    // The view.
    const view = terminalViewSchema.parse((await call(olga, 'GET', '/terminal/line-a1')).json());
    expect(view.workCenter).toEqual({ id: 'line-a1', name: 'Line A1' });
    expect(view.shift?.key).toBe('2026-10-12/A');
    expect(view.machines.map((m) => [m.id, m.state?.state ?? null])).toEqual([
      ['asm-01', 'Running'],
      ['lkt-01', null],
      ['pck-01', null],
    ]);
    expect(view.crew.map((c) => c.username)).toEqual(['olga']);
    expect(view.orders.map((o) => o.order.id)).toEqual(['C-1']);
    expect(
      view.orders[0]?.operations.map((o) => [o.operation, o.complete, o.activities[0]?.kind]),
    ).toEqual([
      ['OP30', false, 'pause'],
      ['OP40', false, undefined],
      ['OP50', false, undefined],
    ]);
    expect(view.queue).toEqual([]);
    const cell = terminalViewSchema.parse((await call(olga, 'GET', '/terminal/cell-m1')).json());
    expect(cell.machines.find((m) => m.id === 'cnc-01')?.job).toMatchObject({ orderId: 'C-1' });
    expect(cell.orders.map((o) => o.operations.map((op) => op.operation))).toEqual([
      ['OP10', 'OP20'],
    ]);

    // The unit is scrapped at OP10: its scrap record waits for coding at Cell M1.
    await finished(h, 'C-1', 1);
    const after = terminalViewSchema.parse((await call(olga, 'GET', '/terminal/cell-m1')).json());
    expect(after.scrapRecords.map((r) => [r.operation, r.machineReason])).toEqual([
      ['OP10', 'DIMENSIONAL'],
    ]);
    expect(
      terminalViewSchema.parse((await call(olga, 'GET', '/terminal/line-a1')).json()).scrapRecords,
    ).toEqual([]);
    const signOff = await call(
      olga,
      'POST',
      '/terminal/line-a1/orders/C-1/operations/OP30/sign-off',
      { version: 3 },
    );
    expect(signOff.statusCode, signOff.body).toBe(200);
    expect(operationResultSchema.parse(signOff.json()).operation).toMatchObject({
      complete: true,
      signedOff: { username: 'olga' },
      activities: [],
    });

    // Logging out ends the session, its crew row, and so the operator's intervals there.
    await call(olga, 'POST', start.replace('OP30', 'OP40'), { activity: null });
    const out = await call(olga, 'DELETE', '/session', {});
    expect(out.statusCode).toBe(200);
    await until(() => h.crewChanges.some((c) => c.event === 'ended'));
    for (let deadline = Date.now() + 60_000; ;) {
      const open = await h.orders.activities({ orderId: 'C-1', operation: 'OP40', open: true });
      if (open.length === 0) break;
      if (Date.now() > deadline) throw new Error('activity still open');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await h.shifts.crew({ workCenter: 'line-a1' }))[0]?.endReason).toBe('session-ended');
    // Signed off at the terminal: the crew row ends and the next write needs a sign-on again.
    const omarOn = await call(omar, 'POST', '/terminal/line-a1/sign-on', {});
    expect(omarOn.statusCode).toBe(200);
    expect((await call(omar, 'POST', '/terminal/line-a1/sign-off', {})).statusCode).toBe(200);
    expect((await call(omar, 'POST', '/terminal/line-a1/sign-off', {})).json()).toMatchObject({
      type: PROBLEM_TYPES.notSignedOn,
    });
    // The shift report shows the crew.
    const report = await call(omar, 'GET', '/shifts/2026-10-12/A/report');
    expect(report.statusCode, report.body).toBe(200);
    expect(
      shiftReportSchema.parse(report.json()).crew.map((c) => `${c.username}@${c.workCenter}`),
    ).toEqual(['omar@cell-m1', 'olga@line-a1', 'omar@line-a1']);
  });
});
