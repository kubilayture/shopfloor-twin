/**
 * The `orders` module (#174) against a real database (as `mes_app`) and the real ingest store,
 * with a fake ERP and a recording command sink in place of the broker: ERP import with the cursor
 * in the page's transaction, feed changes, revisions and validation; the ERP outbox (stored, 409
 * conflict, refusal, retry); the supervisor's writes with versions and the audit; the dispatch rule
 * reproducing `orders-01`'s dispatches; the command outbox (one in flight per CNC, resends, the
 * gateway offline, a restart between commit and publish); the reading of commands from `cmd-res`
 * and job facts (confirmation, `failed`, re-dispatch only when settled, `seqAfterExpiry`, the
 * epoch's end, `command-unconfirmed`, `unknown-job`); the API and the `orders` push topic.
 */
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  commandResultTopic,
  jobTopic,
  loadOrderCommandSchema,
  sysTopic,
  type CommandResultValue,
  type LoadOrderCommand,
} from '@shopfloor/contracts';
import {
  erpDatasetSchema,
  expandErpDataset,
  routingAndBom,
  statusKey,
  type ErpDataset,
  type FeedEntry,
  type MessageReceipt,
} from '@shopfloor/contracts/erp-api';
import {
  PROBLEM_TYPES,
  orderDetailSchema,
  orderListSchema,
  orderWriteResultSchema,
  serverMessageSchema,
  type ServerMessage,
} from '@shopfloor/contracts/mes-api';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { TEST_PASSWORDS, startBroker } from '@shopfloor/test-kit/broker';
import type { Kysely } from 'kysely';
import mqtt from 'mqtt';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import { PLANT_CONFIG, UnsFeed, freshDatabase } from './modules/equipment/test-support.ts';
import { Identity } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData, erpMasterData } from './modules/master-data/index.ts';
import {
  MqttCommandPublisher,
  OrderError,
  Orders,
  validateErpOrder,
  type CommandPublisher,
  type ErpApi,
  type FeedPage,
  type OrderChange,
  type OrdersIngest,
  type PostOutcome,
} from './modules/orders/index.ts';
import { PushHub, type ApiSources, type PushSocket } from './modules/realtime/index.ts';
import { startDatabase } from './testing.ts';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const PLANT_T0 = new Date('2026-10-12T03:00:00.000Z');
const E1 = 1_760_000_000;
const FEED = 'a'.repeat(32);
const GOLDEN = resolve(import.meta.dirname, '../../simulator/golden/orders-01');
const PATHS = new Map([
  ['cnc-01', { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-01' }],
  ['cnc-02', { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-02' }],
]);
/** The supervisor of the current harness (a real user: the audit log refers to it). */
let BY: { by: { userId: number; username: string; roles: 'supervisor'[] }; requestId: string } = {
  by: { userId: 0, username: 'sam', roles: ['supervisor'] },
  requestId: 'req-1',
};

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
}, 180_000);

// Each test's database and modules go with it: the server has few connection slots.
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

afterAll(async () => {
  await container.stop();
});

/** The ERP: a feed over entries, and message posts answered by `answer` (stored by default). */
class FakeErp implements ErpApi {
  feedId = FEED;
  entries: FeedEntry[] = [];
  readonly posts: { kind: string; key: string; body: unknown }[] = [];
  answer: (kind: string, key: string) => PostOutcome = (kind, key) => ({
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
  /** Serves this entry instead (an entry the database refuses). */
  poison: FeedEntry | undefined;
  pagesServed = 0;

  feed(after: number, limit: number): Promise<FeedPage> {
    this.pagesServed++;
    if (after > this.entries.length) {
      return Promise.resolve({ kind: 'cursor-ahead', detail: 'beyond the feed' });
    }
    const entries = this.entries.slice(after, after + limit);
    const page = this.poison && entries.length > 0 ? [this.poison] : entries;
    return Promise.resolve({
      kind: 'page',
      page: {
        feedId: this.feedId,
        entries: page,
        cursor: entries.at(-1)?.feedSeq ?? after,
        more: after + entries.length < this.entries.length,
      },
    });
  }

  post(kind: 'status' | 'confirmation', key: string, body: unknown): Promise<PostOutcome> {
    this.posts.push({ kind, key, body });
    return Promise.resolve(this.answer(kind, key));
  }
}

/** The broker as the outbox sees it: records every publish; `connected` can be turned off. */
class Sink implements CommandPublisher {
  connected = true;
  /** A PUBACK reason code the broker answers with (≥ 0x80 refuses), as MQTT.js reports it. */
  refuseWith: number | undefined;
  readonly published: { topic: string; message: LoadOrderCommand }[] = [];

  publish(topic: string, payload: string): Promise<void> {
    if (!this.connected) return Promise.reject(new Error('not connected'));
    if (this.refuseWith !== undefined) {
      return Promise.reject(
        Object.assign(new Error('Publish error: Not authorized'), { code: this.refuseWith }),
      );
    }
    this.published.push({ topic, message: loadOrderCommandSchema.parse(JSON.parse(payload)) });
    return Promise.resolve();
  }

  of(commandId: string): LoadOrderCommand[] {
    return this.published.map((p) => p.message).filter((m) => m.value.commandId === commandId);
  }
}

function dataset(orders: ErpDataset['orders']): FeedEntry[] {
  const expanded = expandErpDataset({ orders }, erpMasterData(plant));
  if (!expanded.ok) throw new Error(expanded.issues.join('\n'));
  return expanded.feed;
}

const order = (number: string, extra: Partial<ErpDataset['orders'][number]> = {}) => ({
  orderNumber: number,
  revision: 1,
  product: 'VB-100',
  quantity: 4,
  plannedStart: '2026-10-12T06:00:00+03:00',
  dueDate: '2026-10-12T14:00:00+03:00',
  ...extra,
});

interface Harness {
  readonly db: Kysely<Database>;
  readonly ingest: Ingest;
  readonly orders: Orders;
  readonly erp: FakeErp;
  readonly sink: Sink;
  readonly feed: UnsFeed;
  readonly changes: OrderChange[];
  readonly clock: { now: number; plant: Date | undefined };
  /** A new orders module on the same database (a restarted MES). */
  restart(): Promise<Orders>;
}

const gatewaySeq = new Map<string, number>();

async function harness(
  name: string,
  options: {
    readonly timings?: ConstructorParameters<typeof Orders>[0]['timings'];
    readonly beforePublish?: (commandId: string) => Promise<void>;
    /** What the orders module sees of ingest, around the real one (to script interleavings). */
    readonly ingest?: (ingest: Ingest) => OrdersIngest;
  } = {},
): Promise<Harness> {
  const db = await freshDatabase(serverUrl, `orders_${name}`);
  cleanups.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const user = await new Identity({
    db,
    sweepMs: 0,
    hashParams: { N: 1024, r: 8, p: 1 },
  }).createUser(
    {
      username: 'sam',
      roles: ['supervisor'],
      password: 'a-long-test-password',
      mustChangePassword: false,
    },
    { system: 'test' },
  );
  BY = { by: { userId: user.id, username: 'sam', roles: ['supervisor'] }, requestId: 'req-1' };
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'x',
    sweepIntervalMs: 0,
  });
  const erp = new FakeErp();
  const sink = new Sink();
  const clock = { now: T0, plant: PLANT_T0 as Date | undefined };
  const changes: OrderChange[] = [];
  const make = async () => {
    const orders = new Orders({
      db,
      ingest: options.ingest ? options.ingest(ingest) : ingest,
      masterData,
      publisher: sink,
      erp,
      clock: () => clock.plant,
      now: () => clock.now,
      tickMs: 0,
      erpPollMs: 0,
      erpPostMs: 0,
      mesEpoch: 1_800_000_000,
      ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
      timings: {
        ttlMs: 60_000,
        resendMs: 15_000,
        maxAttempts: 3,
        failMarginMs: 30_000,
        ...options.timings,
      },
    });
    orders.onChange((change) => changes.push(change));
    await orders.start();
    cleanups.push(() => orders.stop());
    return orders;
  };
  const orders = await make();
  return {
    db,
    ingest,
    orders,
    erp,
    sink,
    feed: new UnsFeed(PATHS),
    changes,
    clock,
    restart: make,
  };
}

const deliver = async (h: Harness, d: { topic: string; payload: string }) => {
  await h.ingest.deliver(d.topic, d.payload);
};

/** A device fact of the CNC's run (a state change at `seq`). */
const stateAt = (h: Harness, equipment: string, seq: number, epoch = E1) =>
  deliver(
    h,
    h.feed.state(equipment, epoch, seq, PLANT_T0.getTime() + seq * 1_000, 'Idle', 'NO-ORDER'),
  );

/** A job fact of the CNC's run. */
async function job(
  h: Harness,
  command: { commandId: string; orderId: string; product: string; quantity: number },
  equipment: string,
  seq: number,
  transition: 'accepted' | 'started' | 'completed',
  epoch = E1,
): Promise<void> {
  const path = PATHS.get(equipment);
  if (!path) throw new Error(equipment);
  await h.ingest.deliver(
    jobTopic(path),
    JSON.stringify({
      schema: 'uns.events.job/1',
      scope: 'device',
      epoch,
      seq,
      sourceTime: new Date(PLANT_T0.getTime() + seq * 1_000).toISOString(),
      receivedAt: new Date(T0).toISOString(),
      quality: 'good',
      source: { id: equipment, protocol: 'opcua' },
      value: {
        transition,
        commandId: command.commandId,
        orderId: command.orderId,
        product: command.product,
        quantity: command.quantity,
      },
    }),
  );
}

/** A cmd-res of the gateway for one delivery. */
async function result(
  h: Harness,
  delivery: LoadOrderCommand,
  equipment: string,
  answer:
    | { result: 'accepted' | 'duplicate'; acceptedSeq: number }
    | { result: 'rejected'; code: 'invalid-product' | 'epoch-mismatch' | 'command-conflict' }
    | { result: 'expired'; seqAfterExpiry: number | null }
    | { result: 'unknown'; seqAfterExpiry: number | null },
): Promise<void> {
  const path = PATHS.get(equipment);
  if (!path) throw new Error(equipment);
  const topic = commandResultTopic(path, 'load-order');
  const seq = (gatewaySeq.get(topic) ?? 0) + 1;
  gatewaySeq.set(topic, seq);
  const common = {
    commandId: delivery.value.commandId,
    orderId: delivery.value.orderId,
    deviceEpoch: delivery.value.deviceEpoch,
    expiresAt: delivery.expiresAt,
    statusCode: answer.result === 'unknown' ? null : 'Good',
  };
  let value: CommandResultValue;
  if ('acceptedSeq' in answer) {
    value = {
      ...common,
      result: answer.result,
      position: 1,
      acceptedSeq: answer.acceptedSeq,
      acceptedAt: new Date(PLANT_T0.getTime() + answer.acceptedSeq * 1_000).toISOString(),
    };
  } else if ('code' in answer) {
    value = { ...common, result: 'rejected', code: answer.code };
  } else if (answer.result === 'expired') {
    value = { ...common, result: 'expired', seqAfterExpiry: answer.seqAfterExpiry };
  } else {
    value = { ...common, result: 'unknown', seqAfterExpiry: answer.seqAfterExpiry, reason: 'test' };
  }
  await h.ingest.deliver(
    topic,
    JSON.stringify({
      schema: 'uns.cmd-res/1',
      scope: 'topic',
      epoch: 1_790_000_000,
      seq,
      source: { id: equipment, protocol: 'opcua' },
      respondedAt: new Date(T0).toISOString(),
      value,
    }),
  );
}

async function gateway(h: Harness, status: 'online' | 'offline', seq: number): Promise<void> {
  await h.ingest.deliver(
    sysTopic('edge-gateway', 'gw-01', 'status'),
    JSON.stringify({
      schema: 'uns.sys.status/1',
      scope: 'topic',
      epoch: 1_790_000_000,
      seq,
      sourceTime: new Date(T0).toISOString(),
      receivedAt: new Date(T0).toISOString(),
      quality: 'good',
      source: { id: 'gw-01', protocol: 'internal' },
      value: { status, startedAt: new Date(T0).toISOString(), version: '0.0.0' },
    }),
  );
}

/** Imports orders, releases and dispatches one; both CNCs have a known run. */
async function dispatched(
  h: Harness,
  number: string,
  extra: Partial<ErpDataset['orders'][number]> = {},
  equipment = 'cnc-01',
) {
  h.erp.entries.push(
    ...dataset([order(number, extra)]).map((e) => ({ ...e, feedSeq: h.erp.entries.length + 1 })),
  );
  await h.orders.importNow();
  const imported = await h.orders.order(number);
  if (!imported) throw new Error(number);
  const released = await h.orders.release(number, { version: imported.version }, BY);
  return h.orders.dispatch(number, { version: released.version, equipment }, BY);
}

const messages = (h: Harness, orderId?: string) => {
  let query = h.db.selectFrom('orders.erp_message_log').selectAll();
  if (orderId !== undefined) query = query.where('order_id', '=', orderId);
  return query.orderBy('id').execute();
};
const incidents = (h: Harness) =>
  h.db.selectFrom('orders.order_incident').selectAll().orderBy('id').execute();

describe('master data: routings and BOMs (#174)', () => {
  it('are seeded as the ERP builds them, and an ERP order from them is valid', async () => {
    const db = await freshDatabase(serverUrl, 'orders_master');
    cleanups.push(() => db.destroy());
    const master = new MasterData(db);
    await master.seed(plant);
    await master.seed(plant); // idempotent
    const routings = await master.routings();
    expect(routings.map((r) => r.product)).toEqual(['VB-100', 'VB-200']);
    for (const routing of routings) {
      const erp = routingAndBom(routing.product, erpMasterData(plant));
      expect(
        routing.operations.map((o) => ({ operation: o.operation, workCenter: o.workCenter })),
      ).toEqual(erp.routing);
      const key = (item: { material: string; usage: string }) => `${item.material}/${item.usage}`;
      expect([...routing.bom].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
        [...erp.bom].sort((a, b) => key(a).localeCompare(key(b))),
      );
      expect(routing.changeoverMs).toBe(25 * 60_000);
    }
    expect(routings[0]?.operations[0]).toMatchObject({ operation: 'OP10', idealCycleMs: 240_000 });
    const [entry] = dataset([order('X-1')]);
    if (!entry) throw new Error('no entry');
    expect(validateErpOrder(entry.order, routings[0])).toBeUndefined();
    expect(validateErpOrder({ ...entry.order, product: 'VB-999' }, undefined)).toMatch(
      /unknown product/,
    );
    expect(
      validateErpOrder({ ...entry.order, routing: entry.order.routing.slice(1) }, routings[0]),
    ).toMatch(/routing differs/);
    expect(
      validateErpOrder({ ...entry.order, bom: entry.order.bom.slice(1) }, routings[0]),
    ).toMatch(/BOM differs.*missing BLANK-100/);
    expect(() =>
      erpMasterData({
        ...plant,
        plant: {
          ...plant.plant,
          areas: plant.plant.areas.map((area, i) =>
            i === 1
              ? {
                  ...area,
                  workCenters: area.workCenters.map((wc) => ({
                    ...wc,
                    equipment: wc.equipment.map((e) => ({ ...e, operation: 'OP10' })),
                  })),
                }
              : area,
          ),
        },
      }),
    ).toThrow(/OP10 runs in two work centers/);
  });
});

describe('ERP import (ADR-0028)', () => {
  it('imports and validates, posts accepted or rejected, and reads a page again idempotently', async () => {
    const h = await harness('import');
    h.erp.entries = dataset([
      order('A-1'),
      order('A-2', { product: 'VB-200', quantity: 6 }),
      order('A-3', {
        product: 'VB-200',
        // A routing that differs from master data.
        routing: [{ operation: 'OP10', workCenter: 'line-a1' }],
      }),
      order('A-4', { status: 'cancelled' }),
      order('A-5', { product: 'VB-999' }),
    ]);
    expect(await h.orders.importNow()).toBe(5);
    const { orders } = await h.orders.list();
    expect(orders.map((o) => [o.id, o.status])).toEqual([
      ['A-1', 'imported'],
      ['A-2', 'imported'],
      ['A-3', 'rejected'],
      ['A-4', 'cancelled'],
      ['A-5', 'rejected'],
    ]);
    expect(orders.find((o) => o.id === 'A-3')?.rejection).toMatch(/routing differs/);
    expect(orders.find((o) => o.id === 'A-5')?.rejection).toMatch(/unknown product VB-999/);
    expect(orders[0]?.routing.map((r) => r.operation)).toEqual([
      'OP10',
      'OP20',
      'OP30',
      'OP40',
      'OP50',
    ]);
    const out = (await messages(h)).filter((m) => m.direction === 'out');
    expect(out.map((m) => m.idempotency_key)).toEqual([
      statusKey('A-1', 1, 'accepted'),
      statusKey('A-2', 1, 'accepted'),
      statusKey('A-3', 1, 'rejected'),
      statusKey('A-4', 1, 'cancelled'),
      statusKey('A-5', 1, 'rejected'),
    ]);
    expect(out[2]?.payload).toMatchObject({ status: 'rejected' });
    expect((out[2]?.payload as { reason?: string } | undefined)?.reason).toMatch(/routing/);
    const cursor = await h.db.selectFrom('orders.erp_cursor').selectAll().executeTakeFirst();
    expect(cursor).toMatchObject({ cursor: 5, feed_id: FEED });
    expect(h.changes.filter((c) => c.type === 'order' && c.event === 'imported')).toHaveLength(5);
    // Nothing new: the cursor is at the end.
    expect(await h.orders.importNow()).toBe(0);
    // The same feed from 0 again (a reset): every entry is unchanged, nothing posted twice.
    await h.db.updateTable('orders.erp_cursor').set({ cursor: 0 }).execute();
    expect(await h.orders.importNow()).toBe(5);
    const inbound = (await messages(h)).filter((m) => m.direction === 'in');
    expect(inbound.filter((m) => m.status === 'unchanged')).toHaveLength(5);
    expect((await messages(h)).filter((m) => m.direction === 'out')).toHaveLength(5);
    const history = await Identity.auditEntries(h.db, 'production_order', ['A-1']);
    expect(history).toMatchObject([
      { action: 'order.import', username: 'erp-import', authenticated: false },
    ]);
  });

  it('takes a new revision of an order only imported, refuses one after release, and a cancelled version', async () => {
    const h = await harness('revisions');
    h.erp.entries = dataset([order('R-1'), order('R-2')]);
    await h.orders.importNow();
    const r2 = await h.orders.order('R-2');
    await h.orders.release('R-2', { version: r2?.version ?? 0 }, BY);
    h.erp.entries = dataset([
      order('R-1'),
      order('R-2'),
      order('R-1', { revision: 2, quantity: 9 }),
      order('R-2', { revision: 2, quantity: 9 }),
      order('R-1', { revision: 3, status: 'cancelled' }),
    ]);
    await h.orders.importNow();
    const r1 = await h.orders.order('R-1');
    expect(r1).toMatchObject({
      revision: 3,
      status: 'cancelled',
      erpStatus: 'cancelled',
      quantity: 4,
    });
    expect(await h.orders.order('R-2')).toMatchObject({
      revision: 1,
      status: 'released',
      quantity: 4,
    });
    const log = await messages(h, 'R-2');
    expect(log.find((m) => m.status === 'revision-refused')?.detail).toMatch(
      /after the order was released/,
    );
    expect(log.map((m) => m.idempotency_key).filter(Boolean)).toEqual([
      statusKey('R-2', 1, 'accepted'),
      statusKey('R-2', 1, 'released'),
      statusKey('R-2', 2, 'rejected-revision'),
    ]);
    expect((await messages(h, 'R-1')).map((m) => m.idempotency_key).filter(Boolean)).toEqual([
      statusKey('R-1', 1, 'accepted'),
      statusKey('R-1', 2, 'accepted'),
      statusKey('R-1', 3, 'cancelled'),
    ]);
    const history = await Identity.auditEntries(h.db, 'production_order', ['R-1']);
    expect(history.map((e) => e.action)).toEqual(['order.revise', 'order.revise', 'order.import']);
  });

  it('resets the cursor to 0 with an incident when the feed changes or the cursor is ahead', async () => {
    const h = await harness('feed');
    h.erp.entries = dataset([order('F-1'), order('F-2')]);
    await h.orders.importNow();
    // The dataset was replaced: another feed id; re-imported idempotently.
    h.erp.feedId = 'b'.repeat(32);
    h.erp.entries = dataset([order('F-1'), order('F-3')]);
    await h.orders.importNow();
    expect((await h.orders.list()).orders.map((o) => o.id)).toEqual(['F-1', 'F-2', 'F-3']);
    expect(await h.db.selectFrom('orders.erp_cursor').selectAll().executeTakeFirst()).toMatchObject(
      {
        cursor: 2,
        feed_id: 'b'.repeat(32),
      },
    );
    // The ERP's store was emptied under the same id: our cursor is ahead (409).
    h.erp.entries = dataset([order('F-1')]);
    await h.orders.importNow();
    expect(await h.db.selectFrom('orders.erp_cursor').selectAll().executeTakeFirst()).toMatchObject(
      {
        cursor: 1,
      },
    );
    const found = (await incidents(h)).filter((i) => i.type === 'erp-feed-changed');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ resolution: 'cursor-reset' });
    expect(found[0]?.message).toMatch(/feed changed from a+ to b+/);
    expect(found[1]?.message).toMatch(/erp-cursor-ahead/);
    expect(await h.orders.incidents({ open: true })).toEqual([]);
  });

  it('records an entry the database refuses as rejected with an incident, and commits the page', async () => {
    const h = await harness('cursor');
    h.erp.entries = dataset([order('C-1'), order('C-2')]);
    const [first] = h.erp.entries;
    if (!first) throw new Error('no entry');
    // A version the database refuses (priority out of range, as no ERP would send): not even its
    // rejected row can be stored, so the log, the status message and the incident hold it.
    h.erp.poison = { ...first, order: { ...first.order, priority: 0 } };
    expect(await h.orders.importNow()).toBe(1);
    expect(await h.db.selectFrom('orders.erp_cursor').selectAll().executeTakeFirst()).toMatchObject(
      { cursor: 2 },
    );
    expect((await h.orders.list()).orders).toEqual([]);
    const inbound = (await messages(h, 'C-1')).filter((m) => m.direction === 'in');
    expect(inbound).toMatchObject([{ status: 'rejected', feed_seq: 1 }]);
    expect(inbound[0]?.detail).toMatch(/could not be stored/);
    expect(await h.orders.incidents({ open: true })).toMatchObject([{ type: 'erp-invalid-entry' }]);
    expect((await messages(h, 'C-1')).map((m) => m.idempotency_key).filter(Boolean)).toEqual([
      statusKey('C-1', 1, 'rejected'),
    ]);
  });

  it('rejects a routing with an operation twice and keeps importing (no operation rows)', async () => {
    const h = await harness('dup_ops');
    const [base] = dataset([order('Q-1')]);
    if (!base) throw new Error('no entry');
    h.erp.entries = [
      {
        ...base,
        order: {
          ...base.order,
          routing: [...base.order.routing, ...base.order.routing.slice(0, 1)],
        },
      },
      ...dataset([order('Q-1', { revision: 2 }), order('Q-2')]).map((e, i) => ({
        ...e,
        feedSeq: i + 2,
      })),
    ];
    expect(await h.orders.importNow()).toBe(3);
    expect(await h.orders.order('Q-2')).toMatchObject({ status: 'imported' });
    const q1 = await h.orders.order('Q-1');
    expect(q1).toMatchObject({ status: 'imported', revision: 2 });
    expect(q1?.routing.map((r) => r.operation)).toEqual(['OP10', 'OP20', 'OP30', 'OP40', 'OP50']);
    const log = await messages(h, 'Q-1');
    expect(log[0]).toMatchObject({ status: 'rejected' });
    expect(log[0]?.detail).toMatch(/routing repeats OP10/);
    // A version only refused leaves no operation rows behind.
    h.erp.entries = [h.erp.entries[0] ?? base];
    const lone = await harness('dup_ops_alone');
    lone.erp.entries = [h.erp.entries[0] ?? base];
    await lone.orders.importNow();
    expect(await lone.orders.order('Q-1')).toMatchObject({ status: 'rejected', routing: [] });
  });
});

describe('ERP outbox (ADR-0028)', () => {
  it('posts in order: stored, a 409 conflict and a refusal as incidents never retried, a transient failure retried with backoff', async () => {
    const h = await harness('outbox');
    h.erp.entries = dataset([order('O-1'), order('O-2'), order('O-3'), order('O-4')]);
    await h.orders.importNow();
    const outcomes: PostOutcome[] = [
      { kind: 'conflict', status: 409, detail: '409 urn:shopfloor:erp-idempotency-conflict: x' },
      { kind: 'refused', status: 422, detail: '422 urn:shopfloor:erp-unknown-order: y' },
      { kind: 'retry', detail: 'ECONNREFUSED' },
    ];
    const stored = h.erp.answer;
    h.erp.answer = (kind, key) =>
      key.startsWith('O-1') ? stored(kind, key) : (outcomes.shift() ?? stored(kind, key));
    expect(await h.orders.postNow()).toBe(3);
    const statuses = (await messages(h)).filter((m) => m.direction === 'out').map((m) => m.status);
    expect(statuses).toEqual(['sent', 'conflict', 'refused', 'pending']);
    const retried = (await messages(h, 'O-4')).find((m) => m.direction === 'out');
    expect(retried).toMatchObject({ attempts: 1, last_error: 'ECONNREFUSED' });
    expect(retried?.next_attempt_at?.getTime()).toBe(T0 + 1_000);
    // Not before its backoff.
    expect(await h.orders.postNow()).toBe(0);
    h.clock.now += 1_000;
    expect(await h.orders.postNow()).toBe(1);
    expect(h.erp.posts.map((p) => p.key)).toEqual([
      statusKey('O-1', 1, 'accepted'),
      statusKey('O-2', 1, 'accepted'),
      statusKey('O-3', 1, 'accepted'),
      statusKey('O-4', 1, 'accepted'),
      statusKey('O-4', 1, 'accepted'),
    ]);
    expect((await incidents(h)).map((i) => [i.type, i.order_id])).toEqual([
      ['erp-conflict', 'O-2'],
      ['erp-refused', 'O-3'],
    ]);
    expect(h.erp.posts[0]?.body).toEqual({
      orderNumber: 'O-1',
      revision: 1,
      status: 'accepted',
      sentAt: PLANT_T0.toISOString(),
    });
  });
});

describe('supervisor writes (#174)', () => {
  it('release, cancel and close with a version (409 order-stale) and in their statuses (409 order-state), audited', async () => {
    const h = await harness('writes');
    h.erp.entries = dataset([order('W-1'), order('W-2'), order('W-3')]);
    await h.orders.importNow();
    const w1 = await h.orders.order('W-1');
    if (!w1) throw new Error('W-1');
    const stale = await h.orders
      .release('W-1', { version: w1.version + 1 }, BY)
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(OrderError);
    expect(stale).toMatchObject({ kind: 'conflict', type: PROBLEM_TYPES.orderStale });
    const released = await h.orders.release('W-1', { version: w1.version }, BY);
    expect(released).toMatchObject({ status: 'released', version: w1.version + 1 });
    expect(released.releasedAt).toEqual(PLANT_T0);
    await expect(h.orders.release('W-1', { version: released.version }, BY)).rejects.toMatchObject({
      type: PROBLEM_TYPES.orderState,
    });
    await expect(h.orders.close('W-1', { version: released.version }, BY)).rejects.toMatchObject({
      type: PROBLEM_TYPES.orderState,
    });
    await expect(h.orders.release('NOPE', { version: 1 }, BY)).rejects.toMatchObject({
      kind: 'not-found',
    });
    const cancelled = await h.orders.cancel('W-2', { version: 1, reason: 'customer withdrew' }, BY);
    expect(cancelled.status).toBe('cancelled');
    expect((await messages(h, 'W-2')).at(-1)?.payload).toMatchObject({
      status: 'cancelled',
      reason: 'customer withdrew',
    });
    const history = await Identity.auditEntries(h.db, 'production_order', ['W-1', 'W-2']);
    expect(history.filter((e) => e.action !== 'order.import')).toMatchObject([
      {
        action: 'order.cancel',
        username: 'sam',
        roles: ['supervisor'],
        authenticated: true,
        requestId: 'req-1',
        after: { status: 'cancelled', reason: 'customer withdrew' },
      },
      { action: 'order.release', entityId: 'W-1', plantAt: PLANT_T0 },
    ]);
    // Completion is #175's (from final data); close follows it and posts `closed`.
    await stateAt(h, 'cnc-01', 1);
    const w3 = await h.orders.order('W-3');
    const r3 = await h.orders.release('W-3', { version: w3?.version ?? 0 }, BY);
    const { order: d3 } = await h.orders.dispatch('W-3', { version: r3.version }, BY);
    await expect(h.orders.complete('W-1', { short: false, at: PLANT_T0 })).rejects.toMatchObject({
      type: PROBLEM_TYPES.orderState,
    });
    const completed = await h.orders.complete('W-3', { short: true, at: PLANT_T0 });
    expect(completed).toMatchObject({ status: 'completed', short: true, version: d3.version + 1 });
    // #177: a close needs every operation signed off at its terminal, and a sign-off needs the
    // operation complete (its final confirmation, #175).
    await expect(h.orders.close('W-3', { version: completed.version }, BY)).rejects.toMatchObject({
      type: PROBLEM_TYPES.signOffMissing,
    });
    for (const operation of ['OP10', 'OP20', 'OP30', 'OP40', 'OP50']) {
      const totals = { yield: 0, scrap: {}, reworkPasses: 0, material: {} };
      await h.orders.confirm('W-3', operation, totals, PLANT_T0);
      await h.orders.signOff('W-3', operation, { version: 1 }, BY);
    }
    const closed = await h.orders.close('W-3', { version: completed.version }, BY);
    expect(closed.status).toBe('closed');
    const keys = (await messages(h, 'W-3')).map((m) => m.idempotency_key).filter(Boolean);
    expect(keys.filter((k) => k?.includes('~status~')).slice(-2)).toEqual([
      statusKey('W-3', 1, 'completed'),
      statusKey('W-3', 1, 'closed'),
    ]);
    expect(
      (await messages(h, 'W-3')).find((m) => m.idempotency_key === statusKey('W-3', 1, 'completed'))
        ?.payload,
    ).toMatchObject({ short: true });
    const close = (await Identity.auditEntries(h.db, 'production_order', ['W-3']))[0];
    expect(close).toMatchObject({ action: 'order.close', username: 'sam', authenticated: true });
  });
});

describe('the dispatch rule (plan "Orders", ADR-0030)', () => {
  it("reproduces orders-01's dispatches from its released orders in planned-start order", async () => {
    const h = await harness('rule');
    // The ERP dataset schema the ERP mock serves (#175 fixed the file's format).
    const raw = erpDatasetSchema.parse(
      JSON.parse(await readFile(resolve(GOLDEN, 'orders.json'), 'utf8')),
    );
    const scenario = JSON.parse(await readFile(resolve(GOLDEN, 'scenario.json'), 'utf8')) as {
      erp: { release: string[] };
      dispatches: {
        commandId: string;
        machine: string;
        orderId: string;
        product: string;
        quantity: number;
        notBefore: string;
      }[];
    };
    h.erp.entries = dataset(raw.orders);
    await h.orders.importNow();
    // Both CNCs are attached and idle at the start time: their runs are known.
    await stateAt(h, 'cnc-01', 1);
    await stateAt(h, 'cnc-02', 1);
    for (const id of scenario.erp.release) {
      const found = await h.orders.order(id);
      await h.orders.release(id, { version: found?.version ?? 0 }, BY);
    }
    const released = (await h.orders.list({ status: ['released'] })).orders;
    expect(released.map((o) => o.id).sort()).toEqual([...scenario.erp.release].sort());
    // Released orders in planned-start order, ties by order number (the list's order).
    for (const o of released) await h.orders.dispatch(o.id, { version: o.version }, BY);
    const commands = await h.orders.commands();
    expect(
      commands.map((c) => ({
        commandId: c.commandId,
        machine: c.equipment,
        orderId: c.orderId,
        product: c.product,
        quantity: c.quantity,
        notBefore: c.notBefore.toISOString(),
      })),
    ).toEqual(scenario.dispatches);
    expect(commands.every((c) => c.deviceEpoch === E1 && !c.settled)).toBe(true);
    // The never-released order and the revision before release.
    expect(await h.orders.order('PO-2610-008')).toMatchObject({ status: 'imported' });
    expect(await h.orders.order('PO-2610-006')).toMatchObject({ revision: 2, quantity: 6 });
  });

  it('refuses a dispatch to a machine that is no CNC or has no known run', async () => {
    const h = await harness('rule_refusals');
    h.erp.entries = dataset([order('D-1')]);
    await h.orders.importNow();
    const released = await h.orders.release('D-1', { version: 1 }, BY);
    await expect(
      h.orders.dispatch('D-1', { version: released.version, equipment: 'wsh-01' }, BY),
    ).rejects.toThrow(/not a CNC/);
    await expect(
      h.orders.dispatch('D-1', { version: released.version, equipment: 'cnc-01' }, BY),
    ).rejects.toThrow(/no device run of cnc-01/);
    await expect(h.orders.dispatch('D-1', { version: released.version }, BY)).rejects.toThrow(
      /no CNC has a known device run/,
    );
    expect(await h.orders.order('D-1')).toMatchObject({
      status: 'released',
      version: released.version,
    });
  });
});

describe('the command outbox and the reading of commands (ADR-0029)', () => {
  it('publishes one command at a time per CNC, confirms it by its accepted fact, and the order runs', async () => {
    const h = await harness('outbox_cnc');
    await stateAt(h, 'cnc-01', 1);
    const one = await dispatched(h, 'P-1');
    const two = await dispatched(h, 'P-2');
    expect(one.command).toMatchObject({ commandId: 'P-1~OP10~1', state: 'queued', n: 1 });
    await h.orders.tick();
    // Only the first: the second waits until the first is settled.
    expect(h.sink.published.map((p) => p.message.value.commandId)).toEqual(['P-1~OP10~1']);
    const [first] = h.sink.of('P-1~OP10~1');
    if (!first) throw new Error('not published');
    expect(h.sink.published[0]?.topic).toBe('orbis/gebze/machining/cell-m1/cnc-01/cmd/load-order');
    expect(first).toMatchObject({
      epoch: 1_800_000_000,
      seq: 1,
      expiresAt: new Date(T0 + 60_000).toISOString(),
      value: {
        orderId: 'P-1',
        operation: 'OP10',
        product: 'VB-100',
        quantity: 4,
        notBefore: '2026-10-12T03:00:00.000Z',
        deviceEpoch: E1,
      },
    });
    await h.orders.tick();
    expect(h.sink.published).toHaveLength(1);
    // The gateway's answer is the fast path; the fact is the proof.
    await result(h, first, 'cnc-01', { result: 'accepted', acceptedSeq: 2 });
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'P-1' }))[0]).toMatchObject({
      state: 'accepted',
      settled: true,
      confirmed: false,
      acceptedBy: 'result',
      job: 'accepted',
    });
    expect(h.sink.of('P-2~OP10~1')).toHaveLength(1);
    expect(two.command.queuePosition).toBeGreaterThan(one.command.queuePosition);
    await job(h, first.value, 'cnc-01', 2, 'accepted');
    await job(h, first.value, 'cnc-01', 3, 'started');
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'P-1' }))[0]).toMatchObject({
      confirmed: true,
      acceptedBy: 'fact',
      acceptedSeq: 2,
      job: 'started',
    });
    expect(await h.orders.order('P-1')).toMatchObject({
      status: 'in-progress',
      startedAt: new Date(PLANT_T0.getTime() + 3_000),
      dispatched: 4,
    });
    expect((await messages(h, 'P-1')).map((m) => m.idempotency_key).filter(Boolean)).toContain(
      statusKey('P-1', 1, 'in-progress'),
    );
    await job(h, first.value, 'cnc-01', 9, 'completed');
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'P-1' }))[0]?.job).toBe('completed');
    expect(
      h.changes.some(
        (c) => c.type === 'command' && c.command.commandId === 'P-1~OP10~1' && c.command.confirmed,
      ),
    ).toBe(true);
    expect(await h.orders.incidents()).toEqual([]);
  });

  it('raises the order version and pushes it when an acceptance changes its dispatched blanks', async () => {
    const h = await harness('outbox_blanks');
    await stateAt(h, 'cnc-01', 1);
    const one = await dispatched(h, 'P-1');
    expect(one.order).toMatchObject({ dispatched: 0, inFlight: 4 });
    await h.orders.tick();
    const [first] = h.sink.of('P-1~OP10~1');
    if (!first) throw new Error('not published');
    h.changes.length = 0;
    // Accepted: no status or flag changes (still `dispatched`), only the counted blanks.
    await result(h, first, 'cnc-01', { result: 'accepted', acceptedSeq: 2 });
    await h.orders.tick();
    const after = await h.orders.order('P-1');
    expect(after).toMatchObject({ status: 'dispatched', dispatched: 4, inFlight: 0 });
    expect(after?.version).toBeGreaterThan(one.order.version);
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(one.order.updatedAt.getTime());
    const pushed = h.changes.filter((c) => c.type === 'order' && c.order.id === 'P-1');
    expect(pushed.at(-1)).toMatchObject({
      type: 'order',
      order: { dispatched: 4, version: after?.version },
    });
    // Nothing moved since: no further version or push.
    h.changes.length = 0;
    await h.orders.tick();
    expect((await h.orders.order('P-1'))?.version).toBe(after?.version);
    expect(h.changes.filter((c) => c.type === 'order')).toEqual([]);
  });

  it('resends without an answer, pauses while the gateway is offline or the broker away, and publishes after a restart', async () => {
    const h = await harness('resend');
    await stateAt(h, 'cnc-01', 1);
    await gateway(h, 'offline', 1);
    await dispatched(h, 'S-1');
    await h.orders.tick();
    expect(h.sink.published).toEqual([]);
    await gateway(h, 'online', 2);
    h.sink.connected = false;
    await h.orders.tick();
    expect(h.sink.published).toEqual([]);
    // The MES restarts between the outbox commit and the publish: the new instance sends it.
    await h.orders.stop();
    h.sink.connected = true;
    const restarted = await h.restart();
    expect(h.sink.of('S-1~OP10~1')).toHaveLength(1);
    h.clock.now += 14_999;
    await restarted.tick();
    expect(h.sink.of('S-1~OP10~1')).toHaveLength(1);
    h.clock.now += 1;
    await restarted.tick();
    const sent = h.sink.of('S-1~OP10~1');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.expiresAt).toBe(new Date(T0 + 15_000 + 60_000).toISOString());
    expect(sent[1]?.value).toEqual(sent[0]?.value);
    h.clock.now += 15_000;
    await restarted.tick();
    h.clock.now += 15_000;
    await restarted.tick();
    // maxAttempts (3).
    expect(h.sink.of('S-1~OP10~1')).toHaveLength(3);
    const [command] = await restarted.commands({ orderId: 'S-1' });
    expect(command?.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    // An expired answer to the last delivery settles it without a job.
    const last = sent.at(-1) ?? h.sink.of('S-1~OP10~1')[2];
    const third = h.sink.of('S-1~OP10~1')[2];
    if (!last || !third) throw new Error('no delivery');
    await result(h, third, 'cnc-01', { result: 'expired', seqAfterExpiry: 5 });
    await restarted.tick();
    expect((await restarted.commands({ orderId: 'S-1' }))[0]).toMatchObject({
      state: 'expired',
      settled: true,
      job: null,
    });
    expect(await restarted.order('S-1')).toMatchObject({ dispatchFailed: true, dispatched: 0 });
  });

  it('declares a command failed, refuses a re-dispatch until it is settled, and never makes a second job', async () => {
    const h = await harness('failed', { timings: { maxAttempts: 1 } });
    await stateAt(h, 'cnc-01', 1);
    await dispatched(h, 'X-1');
    await h.orders.tick();
    const [delivery] = h.sink.of('X-1~OP10~1');
    if (!delivery) throw new Error('not published');
    h.clock.now = Date.parse(delivery.expiresAt) + 30_000;
    await h.orders.tick();
    const failed = (await h.orders.commands({ orderId: 'X-1' }))[0];
    expect(failed).toMatchObject({ state: 'failed', failed: true, settled: false });
    const order = await h.orders.order('X-1');
    expect(order).toMatchObject({ dispatchFailed: true, status: 'dispatched' });
    expect(await h.orders.incidents({ open: true })).toMatchObject([
      { type: 'command-failed', commandId: 'X-1~OP10~1' },
    ]);
    const refused = await h.orders
      .redispatch('X-1', { version: order?.version ?? 0 }, BY)
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: 'conflict', type: PROBLEM_TYPES.commandsUnsettled });
    // The gateway settles: unknown, with the device sequence read after the expiry.
    await result(h, delivery, 'cnc-01', { result: 'unknown', seqAfterExpiry: 6 });
    await h.orders.tick();
    const current = await h.orders.order('X-1');
    await expect(
      h.orders.redispatch('X-1', { version: current?.version ?? 0 }, BY),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.commandsUnsettled });
    // The CNC's facts arrive up to 5: not yet seqAfterExpiry.
    for (const seq of [2, 3, 4, 5]) await stateAt(h, 'cnc-01', seq);
    await expect(
      h.orders.redispatch('X-1', { version: current?.version ?? 0 }, BY),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.commandsUnsettled });
    // 6 arrives, and it is the job's accepted fact: the job exists, nothing remains.
    await job(h, delivery.value, 'cnc-01', 6, 'accepted');
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'X-1' }))[0]).toMatchObject({
      state: 'accepted',
      confirmed: true,
      failed: true,
    });
    const after = await h.orders.order('X-1');
    await expect(h.orders.redispatch('X-1', { version: after?.version ?? 0 }, BY)).rejects.toThrow(
      /nothing to dispatch/,
    );
    expect((await h.orders.incidents()).find((i) => i.type === 'command-failed')).toMatchObject({
      resolution: 'accepted',
    });
    expect(h.sink.published).toHaveLength(1);
  });

  it('re-dispatches the remainder once every fact through seqAfterExpiry arrived without the acceptance', async () => {
    const h = await harness('settled', { timings: { maxAttempts: 1 } });
    await stateAt(h, 'cnc-01', 1);
    await dispatched(h, 'Y-1');
    await h.orders.tick();
    const [delivery] = h.sink.of('Y-1~OP10~1');
    if (!delivery) throw new Error('not published');
    await result(h, delivery, 'cnc-01', { result: 'unknown', seqAfterExpiry: 3 });
    for (const seq of [2, 3]) await stateAt(h, 'cnc-01', seq);
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'Y-1' }))[0]).toMatchObject({
      state: 'not-accepted',
      settled: true,
      seqAfterExpiry: 3,
    });
    const order = await h.orders.order('Y-1');
    expect(order).toMatchObject({ dispatchFailed: true, dispatched: 0 });
    await expect(
      h.orders.redispatch('Y-1', { version: order?.version ?? 0, quantity: 5 }, BY),
    ).rejects.toThrow(/at most 4/);
    const again = await h.orders.redispatch('Y-1', { version: order?.version ?? 0 }, BY);
    expect(again.command).toMatchObject({
      commandId: 'Y-1~OP10~2',
      n: 2,
      quantity: 4,
      state: 'queued',
    });
    expect(again.order).toMatchObject({ dispatchFailed: false });
    await h.orders.tick();
    expect(h.sink.of('Y-1~OP10~2')).toHaveLength(1);
    const history = await Identity.auditEntries(h.db, 'production_order', ['Y-1']);
    expect(history[0]).toMatchObject({
      action: 'order.redispatch',
      after: { commandId: 'Y-1~OP10~2', quantity: 4, remainingBefore: 4 },
    });
  });

  it('marks jobs of an ended run lost (an incident, dispatch-lost) and re-dispatches to the new run', async () => {
    const h = await harness('epoch');
    await stateAt(h, 'cnc-01', 1);
    await stateAt(h, 'cnc-02', 1);
    const { command } = await dispatched(h, 'E-1', { quantity: 3 }, 'cnc-01');
    await dispatched(h, 'E-2', { quantity: 2 }, 'cnc-02');
    await h.orders.tick();
    const [delivery] = h.sink.of(command.commandId);
    if (!delivery) throw new Error('not published');
    await job(h, delivery.value, 'cnc-01', 2, 'accepted');
    await job(h, delivery.value, 'cnc-01', 3, 'started');
    await deliver(h, h.feed.cycle('cnc-01', E1, 4, PLANT_T0.getTime() + 4_000));
    // A new run of cnc-01 (the simulator restarted): its first fact.
    await stateAt(h, 'cnc-01', 1, E1 + 50);
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'E-1' }))[0]).toMatchObject({
      job: 'lost',
      lostStarted: 2,
    });
    // E-2's command on cnc-02, never answered, is unaffected; cnc-02's run goes on.
    expect((await h.orders.commands({ orderId: 'E-2' }))[0]?.state).toBe('sent');
    const order = await h.orders.order('E-1');
    expect(order).toMatchObject({ dispatchLost: true, dispatched: 2, status: 'in-progress' });
    expect(await h.orders.incidents({ open: true })).toMatchObject([
      { type: 'dispatch-lost', commandId: 'E-1~OP10~1' },
    ]);
    const again = await h.orders.redispatch(
      'E-1',
      { version: order?.version ?? 0, equipment: 'cnc-01' },
      BY,
    );
    expect(again.command).toMatchObject({ n: 2, quantity: 1, deviceEpoch: E1 + 50 });
    expect(await h.orders.incidents({ open: true })).toEqual([]);
    expect(again.order).toMatchObject({ dispatchLost: false });
  });

  it('settles a command never answered when its run ends, and a rejected one flags the order', async () => {
    const h = await harness('ended');
    await stateAt(h, 'cnc-01', 1);
    await stateAt(h, 'cnc-02', 1);
    await dispatched(h, 'G-1', {}, 'cnc-01');
    await dispatched(h, 'G-2', {}, 'cnc-02');
    await h.orders.tick();
    const [g2] = h.sink.of('G-2~OP10~1');
    if (!g2) throw new Error('not published');
    await result(h, g2, 'cnc-02', { result: 'rejected', code: 'invalid-product' });
    // cnc-01's run ends before its command was answered (a snapshot of the new run is enough).
    await deliver(h, h.feed.snapshot('cnc-01', E1 + 7, PLANT_T0.getTime(), 'Idle'));
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'G-1' }))[0]).toMatchObject({
      state: 'epoch-ended',
      settled: true,
      job: null,
    });
    expect(await h.orders.order('G-1')).toMatchObject({ dispatchLost: true });
    expect((await h.orders.commands({ orderId: 'G-2' }))[0]).toMatchObject({
      state: 'rejected',
      rejection: 'invalid-product',
    });
    expect(await h.orders.order('G-2')).toMatchObject({ dispatchFailed: true });
  });

  it('raises command-unconfirmed, unknown-job and duplicate-job, and closes command-unconfirmed when the fact arrives', async () => {
    const h = await harness('incidents');
    await stateAt(h, 'cnc-01', 1);
    await dispatched(h, 'U-1');
    await h.orders.tick();
    const [delivery] = h.sink.of('U-1~OP10~1');
    if (!delivery) throw new Error('not published');
    await result(h, delivery, 'cnc-01', { result: 'accepted', acceptedSeq: 3 });
    await stateAt(h, 'cnc-01', 2);
    await h.orders.tick();
    expect(await h.orders.incidents()).toEqual([]);
    // The CNC's facts pass the acceptance (seq 3 lost in a gap written off, then 4 arrives).
    await stateAt(h, 'cnc-01', 4);
    await h.ingest.sweep();
    await h.db
      .updateTable('ingest.source_cursor')
      .set({ reported: JSON.stringify([[3, 3]]) })
      .where('stream', '=', 'device:cnc-01')
      .execute();
    await h.orders.tick();
    expect(await h.orders.incidents({ open: true })).toMatchObject([
      { type: 'command-unconfirmed', commandId: 'U-1~OP10~1' },
    ]);
    // The late fact fills the gap: confirmed, the incident closed.
    await job(h, delivery.value, 'cnc-01', 3, 'accepted');
    await h.orders.tick();
    expect(await h.orders.incidents({ open: true })).toEqual([]);
    expect((await h.orders.incidents())[0]).toMatchObject({ resolution: 'confirmed' });
    // A job of a command the MES never issued; a second accepted fact for one id.
    await job(
      h,
      { ...delivery.value, commandId: 'Z-9~OP10~1', orderId: 'Z-9' },
      'cnc-01',
      5,
      'accepted',
    );
    await job(h, delivery.value, 'cnc-01', 6, 'accepted');
    await h.orders.tick();
    expect((await h.orders.incidents({ open: true })).map((i) => i.type).sort()).toEqual([
      'duplicate-job',
      'unknown-job',
    ]);
    // A restarted MES knows the open incidents and raises none again.
    await h.orders.stop();
    const restarted = await h.restart();
    await restarted.tick();
    expect(await restarted.incidents({ open: true })).toHaveLength(2);
  });
});

describe('reading commands safely (#174 review)', () => {
  it('measures seqAfterExpiry from what was stored when the delivery was written, not by clocks', async () => {
    const h = await harness('skew', { timings: { maxAttempts: 1 } });
    // The MES joined cnc-01's stream late (first seen at 5): no `receivedThrough`.
    await stateAt(h, 'cnc-01', 5);
    const { command } = await dispatched(h, 'SK-1');
    await h.orders.tick();
    const [delivery] = h.sink.of(command.commandId);
    if (!delivery) throw new Error('not published');
    expect((await h.orders.commands({ orderId: 'SK-1' }))[0]?.attempts).toHaveLength(1);
    // The device accepted it at 6 (that fact never arrived); 7 and 8 arrived after the delivery,
    // but the database's clock lags: their `ingested_at` reads as before it.
    await stateAt(h, 'cnc-01', 7);
    await stateAt(h, 'cnc-01', 8);
    await h.db
      .updateTable('ingest.equipment_event')
      .set({ ingested_at: new Date('2000-01-01T00:00:00.000Z') })
      .where('equipment', '=', 'cnc-01')
      .execute();
    await result(h, delivery, 'cnc-01', { result: 'unknown', seqAfterExpiry: 8 });
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'SK-1' }))[0]).toMatchObject({
      state: 'unknown',
      settled: false,
    });
    // 6 arrives and is no acceptance (a state change): every number from 5 through 8 is in.
    await stateAt(h, 'cnc-01', 6);
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'SK-1' }))[0]).toMatchObject({
      state: 'not-accepted',
      settled: true,
    });
  });

  // #218: a tick reads the command's results and job facts and its CNC's progress as separate
  // statements, and the acceptance (the one number missing up to seqAfterExpiry) is stored in the
  // middle. `during`: before the progress is read, i.e. after the facts were in the order before
  // #218, which then counted the acceptance as received while the facts lacked it: `not-accepted`,
  // settled, with the job on the device (fails with that order). `after`: once the progress is
  // read, so it can't count the fact: nothing is settled wrongly with either order (passes with
  // both; with the fix the facts read after the progress have it at once). The stream either starts at 1
  // (`receivedThrough`) or the MES joined it late at 5 (no `receivedThrough`: only the `seen`
  // range holding `stored_seq` counts, the path of the failing e2e run).
  it.each([
    { name: 'during', from: 1, store: 'before' as const },
    { name: 'during_late', from: 5, store: 'before' as const },
    { name: 'after', from: 1, store: 'after' as const },
    { name: 'after_late', from: 5, store: 'after' as const },
  ])(
    'never settles not-accepted when the acceptance is stored while a tick reads (#218): $store the progress read, stream first seen at $from',
    async ({ name, from, store }) => {
      let race: (() => Promise<void>) | undefined;
      const h = await harness(`read_race_${name}`, {
        timings: { maxAttempts: 1 },
        ingest: (real) =>
          new Proxy(real, {
            get(target, property) {
              if (property === 'deviceProgress') {
                return async (equipment: string) => {
                  const pending = race;
                  race = undefined;
                  if (store === 'before') await pending?.();
                  const progress = await target.deviceProgress(equipment);
                  if (store === 'after') await pending?.();
                  return progress;
                };
              }
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === 'function'
                ? ((value as (...args: unknown[]) => unknown).bind(target) as unknown)
                : value;
            },
          }),
      });
      await stateAt(h, 'cnc-01', from);
      const progress = await h.ingest.deviceProgress('cnc-01');
      expect(progress.receivedThrough).toBe(from === 1 ? 1 : null);
      const orderId = `RR-${name}`;
      const { command } = await dispatched(h, orderId, { quantity: 2 });
      await h.orders.tick();
      const [delivery] = h.sink.of(command.commandId);
      if (!delivery) throw new Error('not published');
      expect(
        (
          await h.db
            .selectFrom('orders.command_attempt')
            .select('stored_seq')
            .where('command_id', '=', command.commandId)
            .executeTakeFirst()
        )?.stored_seq,
      ).toBe(from);
      // The device accepted it at from + 1 (that fact held on the way); the gateway's settle step
      // read the device's sequence after the expiry: from + 1.
      const accepted = from + 1;
      await result(h, delivery, 'cnc-01', { result: 'unknown', seqAfterExpiry: accepted });
      await h.orders.tick();
      expect((await h.orders.commands({ orderId }))[0]).toMatchObject({
        state: 'unknown',
        settled: false,
      });
      // The held fact arrives in the middle of the next tick's reads.
      race = () => job(h, delivery.value, 'cnc-01', accepted, 'accepted');
      await h.orders.tick();
      expect(race).toBeUndefined();
      if (store === 'after') {
        // Stored once the progress was read: whatever the order of the other reads, the progress
        // can't count it, so this tick settles nothing (an older order reads the facts first and
        // sees it a tick later). Never `not-accepted`.
        expect((await h.orders.commands({ orderId }))[0]?.state).toMatch(/^(accepted|unknown)$/);
        await h.orders.tick();
      }
      expect((await h.orders.commands({ orderId }))[0]).toMatchObject({
        state: 'accepted',
        acceptedBy: 'fact',
        acceptedSeq: accepted,
        settled: true,
      });
      await h.orders.tick();
      expect(await h.orders.incidents()).toEqual([]);
      expect(await h.orders.order(orderId)).toMatchObject({
        dispatched: 2,
        dispatchFailed: false,
      });
    },
  );

  it('raises command-publish-refused when the broker refuses a delivery, backs off, fails, and recovers once the ACL is fixed', async () => {
    const h = await harness('refused', { timings: { maxAttempts: 2 } });
    await stateAt(h, 'cnc-01', 1);
    h.sink.refuseWith = 0x87;
    const { command } = await dispatched(h, 'RF-1');
    await h.orders.tick();
    await h.orders.tick();
    expect(h.sink.published).toEqual([]);
    expect(await h.orders.incidents({ open: true })).toMatchObject([
      { type: 'command-publish-refused', commandId: command.commandId },
    ]);
    expect((await h.orders.commands({ orderId: 'RF-1' }))[0]?.attempts).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      h.clock.now += 15_000;
      await h.orders.tick();
    }
    const [after] = await h.orders.commands({ orderId: 'RF-1' });
    // Backed off (15 s, 30 s, 60 s, …, at most 120 s apart); failed from the first one's expiresAt.
    expect(after?.attempts).toHaveLength(3);
    expect(after?.attempts.every((a) => a.publishedAt === null)).toBe(true);
    expect(after).toMatchObject({ state: 'failed', failed: true, settled: false });
    expect((await h.orders.incidents({ open: true })).map((i) => i.type).sort()).toEqual([
      'command-failed',
      'command-publish-refused',
    ]);
    // The ACL is fixed: the next delivery after the backoff goes out, the refusal closes.
    h.sink.refuseWith = undefined;
    // The third unpublished delivery (at +45 s) waits 60 s: none before +105 s.
    h.clock.now += 14_000;
    await h.orders.tick();
    expect(h.sink.of(command.commandId)).toEqual([]);
    h.clock.now += 1_000;
    await h.orders.tick();
    const [delivery] = h.sink.of(command.commandId);
    if (!delivery) throw new Error('not published after the backoff');
    expect((await h.orders.incidents({ open: true })).map((i) => i.type)).toEqual([
      'command-failed',
    ]);
    await result(h, delivery, 'cnc-01', { result: 'accepted', acceptedSeq: 2 });
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'RF-1' }))[0]).toMatchObject({
      state: 'accepted',
      settled: true,
    });
    expect(await h.orders.incidents({ open: true })).toEqual([]);
  });

  it('counts one blank for a lost job accepted at the head of its CNC, none once the CNC went Idle for want of an order', async () => {
    const h = await harness('head');
    await stateAt(h, 'cnc-01', 1);
    await stateAt(h, 'cnc-02', 1);
    const one = await dispatched(h, 'HD-1', { quantity: 4 }, 'cnc-01');
    const two = await dispatched(h, 'HD-2', { quantity: 4 }, 'cnc-02');
    await h.orders.tick();
    const [d1] = h.sink.of(one.command.commandId);
    const [d2] = h.sink.of(two.command.commandId);
    if (!d1 || !d2) throw new Error('not published');
    await job(h, d1.value, 'cnc-01', 2, 'accepted');
    await job(h, d2.value, 'cnc-02', 2, 'accepted');
    // cnc-02 shows it moved on: Idle for want of a startable order after the acceptance.
    await deliver(h, h.feed.state('cnc-02', E1, 3, PLANT_T0.getTime() + 3_000, 'Idle', 'NO-ORDER'));
    await deliver(h, h.feed.snapshot('cnc-01', E1 + 2, PLANT_T0.getTime(), 'Idle'));
    await deliver(h, h.feed.snapshot('cnc-02', E1 + 2, PLANT_T0.getTime(), 'Idle'));
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'HD-1' }))[0]).toMatchObject({
      job: 'lost',
      lostStarted: 1,
    });
    expect((await h.orders.commands({ orderId: 'HD-2' }))[0]).toMatchObject({
      job: 'lost',
      lostStarted: 0,
    });
  });

  it('keeps a command-conflict unsettled with an incident until its run ends, then counts its quantity', async () => {
    const h = await harness('conflict');
    await stateAt(h, 'cnc-01', 1);
    const { command } = await dispatched(h, 'CF-1', { quantity: 3 });
    await h.orders.tick();
    const [delivery] = h.sink.of(command.commandId);
    if (!delivery) throw new Error('not published');
    await result(h, delivery, 'cnc-01', { result: 'rejected', code: 'command-conflict' });
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'CF-1' }))[0]).toMatchObject({
      state: 'conflict',
      settled: false,
      rejection: 'command-conflict',
    });
    expect(await h.orders.incidents({ open: true })).toMatchObject([
      { type: 'command-conflict', commandId: command.commandId },
    ]);
    const order = await h.orders.order('CF-1');
    expect(order).toMatchObject({ dispatchFailed: true, dispatched: 3 });
    await expect(
      h.orders.redispatch('CF-1', { version: order?.version ?? 0 }, BY),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.commandsUnsettled });
    // No resend while it conflicts.
    h.clock.now += 60_000;
    await h.orders.tick();
    expect(h.sink.of(command.commandId)).toHaveLength(1);
    // The run ends: settled, but the job under its id counts (short, never over).
    await stateAt(h, 'cnc-01', 1, E1 + 9);
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'CF-1' }))[0]).toMatchObject({
      state: 'epoch-ended',
      settled: true,
    });
    const after = await h.orders.order('CF-1');
    await expect(h.orders.redispatch('CF-1', { version: after?.version ?? 0 }, BY)).rejects.toThrow(
      /nothing to dispatch/,
    );
    expect(await h.orders.incidents({ open: true })).toMatchObject([{ type: 'dispatch-lost' }]);
  });

  it('turns a command settled without a job into an acceptance when its accepted fact arrives (duplicate-job)', async () => {
    const h = await harness('late_fact', { timings: { maxAttempts: 1 } });
    await stateAt(h, 'cnc-01', 1);
    const { command } = await dispatched(h, 'LF-1', { quantity: 2 });
    await h.orders.tick();
    const [delivery] = h.sink.of(command.commandId);
    if (!delivery) throw new Error('not published');
    // A wrong answer (as a defect could give): expired, settled without a job.
    await result(h, delivery, 'cnc-01', { result: 'expired', seqAfterExpiry: 1 });
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'LF-1' }))[0]?.state).toBe('expired');
    expect(await h.orders.order('LF-1')).toMatchObject({ dispatched: 0 });
    await job(h, delivery.value, 'cnc-01', 2, 'accepted');
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'LF-1' }))[0]).toMatchObject({
      state: 'accepted',
      job: 'accepted',
    });
    expect(await h.orders.order('LF-1')).toMatchObject({ dispatched: 2 });
    expect(await h.orders.incidents({ open: true })).toMatchObject([
      { type: 'duplicate-job', commandId: command.commandId },
    ]);
  });

  it('counts a lost job whole while its facts are not fully known, and as a running maximum', async () => {
    const h = await harness('lost_unknown');
    await stateAt(h, 'cnc-01', 1);
    await stateAt(h, 'cnc-02', 1);
    const one = await dispatched(h, 'LU-1', { quantity: 5 }, 'cnc-01');
    const two = await dispatched(h, 'LU-2', { quantity: 4 }, 'cnc-02');
    await h.orders.tick();
    const [d1] = h.sink.of(one.command.commandId);
    const [d2] = h.sink.of(two.command.commandId);
    if (!d1 || !d2) throw new Error('not published');
    // LU-1: accepted by the gateway's answer only (its fact never came).
    await result(h, d1, 'cnc-01', { result: 'accepted', acceptedSeq: 2 });
    // LU-2: accepted and started, then a hole after its start (seq 4 missing).
    await job(h, d2.value, 'cnc-02', 2, 'accepted');
    await job(h, d2.value, 'cnc-02', 3, 'started');
    await stateAt(h, 'cnc-02', 5);
    // Both runs end (snapshots of new runs; the old streams are still current).
    await deliver(h, h.feed.snapshot('cnc-01', E1 + 3, PLANT_T0.getTime(), 'Idle'));
    await deliver(h, h.feed.snapshot('cnc-02', E1 + 3, PLANT_T0.getTime(), 'Idle'));
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'LU-1' }))[0]).toMatchObject({
      job: 'lost',
      lostStarted: 5,
    });
    expect((await h.orders.commands({ orderId: 'LU-2' }))[0]).toMatchObject({
      job: 'lost',
      lostStarted: 4,
    });
    // The missing fact arrives (a cycle): known now, but the count never goes down.
    await deliver(h, h.feed.cycle('cnc-02', E1, 4, PLANT_T0.getTime() + 4_000));
    await h.orders.tick();
    expect((await h.orders.commands({ orderId: 'LU-2' }))[0]?.lostStarted).toBe(4);
    const order = await h.orders.order('LU-2');
    await expect(h.orders.redispatch('LU-2', { version: order?.version ?? 0 }, BY)).rejects.toThrow(
      /nothing to dispatch/,
    );
  });

  it('resends a delivery that was never published, without counting it', async () => {
    let refuse = true;
    const h = await harness('unpublished', {
      timings: { maxAttempts: 1 },
      beforePublish: () => {
        if (!refuse) return Promise.resolve();
        refuse = false;
        return Promise.reject(new Error('crash before the publish'));
      },
    });
    await stateAt(h, 'cnc-01', 1);
    const { command } = await dispatched(h, 'UP-1');
    await h.orders.tick();
    expect(h.sink.of(command.commandId)).toEqual([]);
    const [written] = await h.orders.commands({ orderId: 'UP-1' });
    expect(written?.attempts).toMatchObject([{ attempt: 1, publishedAt: null }]);
    // Resent only after resendMs.
    await h.orders.tick();
    expect(h.sink.of(command.commandId)).toEqual([]);
    h.clock.now += 15_000;
    await h.orders.tick();
    expect(h.sink.of(command.commandId)).toHaveLength(1);
    const [after] = await h.orders.commands({ orderId: 'UP-1' });
    expect(after?.attempts.map((a) => a.publishedAt !== null)).toEqual([false, true]);
    // One published delivery is maxAttempts: no more.
    h.clock.now += 20_000;
    await h.orders.tick();
    expect(h.sink.of(command.commandId)).toHaveLength(1);
  });

  it('abandons a command only after its run ended, audited, counting its quantity', async () => {
    const h = await harness('abandon');
    await stateAt(h, 'cnc-01', 1);
    const { command, order } = await dispatched(h, 'AB-1', { quantity: 3 });
    await h.orders.tick();
    await expect(
      h.orders.abandon('AB-1', { version: order.version, commandId: command.commandId }, BY),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.orderState });
    await expect(
      h.orders.abandon('AB-1', { version: order.version, commandId: 'AB-1~OP10~9' }, BY),
    ).rejects.toMatchObject({ kind: 'not-found' });
    await deliver(h, h.feed.snapshot('cnc-01', E1 + 4, PLANT_T0.getTime(), 'Idle'));
    await h.orders.tick();
    const current = await h.orders.order('AB-1');
    const abandoned = await h.orders.abandon(
      'AB-1',
      { version: current?.version ?? 0, commandId: command.commandId },
      BY,
    );
    expect(abandoned).toMatchObject({ dispatched: 3, dispatchLost: true });
    expect((await h.orders.commands({ orderId: 'AB-1' }))[0]).toMatchObject({
      state: 'abandoned',
      settled: true,
    });
    expect(await h.orders.incidents({ open: true })).toEqual([]);
    await expect(
      h.orders.abandon('AB-1', { version: abandoned.version, commandId: command.commandId }, BY),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.orderState });
    const [entry] = await Identity.auditEntries(h.db, 'production_order', ['AB-1']);
    expect(entry).toMatchObject({
      action: 'order.abandon-command',
      username: 'sam',
      after: { commandId: command.commandId, counted: 3 },
    });
  });
});

describe('the orders API and push (#174)', () => {
  it('refuses a write without a session also with MES_AUTH=off (401) and audits a session user; 503 without the module', async () => {
    const h = await harness('api_off');
    h.erp.entries = dataset([order('K-1')]);
    await h.orders.importNow();
    const none = () => () => undefined;
    const headers = {
      host: 'localhost:4700',
      origin: 'http://localhost:4700',
      'content-type': 'application/json',
    };
    const sources = {
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
    };
    const without = await buildMesHttp({ ready: () => Promise.resolve(true) });
    cleanups.push(() => without.app.close());
    await without.realtime.attach(sources as unknown as ApiSources);
    expect(
      (await without.app.inject({ method: 'GET', url: '/api/v1/orders', headers })).statusCode,
    ).toBe(503);
    const identity = new Identity({ db: h.db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
    await identity.start();
    cleanups.push(() => {
      identity.stop();
      return Promise.resolve();
    });
    const http = await buildMesHttp({ ready: () => Promise.resolve(true), identity, auth: false });
    cleanups.push(() => http.app.close());
    await http.realtime.attach({ ...sources, orders: h.orders } as unknown as ApiSources);
    const release = (cookie?: string) =>
      http.app.inject({
        method: 'POST',
        url: '/api/v1/orders/K-1/release',
        headers: { ...headers, ...(cookie === undefined ? {} : { cookie }) },
        payload: JSON.stringify({ version: 1 }),
      });
    // No session: refused, as #170 makes every write (no anonymous actor).
    const anonymous = await release();
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ type: PROBLEM_TYPES.unauthenticated });
    expect((await h.orders.order('K-1'))?.status).toBe('imported');
    const login = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: { username: 'sam', password: 'a-long-test-password' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const response = await release(cookie);
    expect(response.statusCode, response.body).toBe(200);
    const [entry] = await Identity.auditEntries(h.db, 'production_order', ['K-1']);
    expect(entry).toMatchObject({
      action: 'order.release',
      username: 'sam',
      authenticated: true,
    });
    expect(entry?.requestId).toBe(response.headers['x-request-id']);
  });

  it('serves list, detail and incidents; writes with the session user, 409 types; push upserts', async () => {
    const h = await harness('api');
    await stateAt(h, 'cnc-01', 1);
    h.erp.entries = dataset([order('H-1'), order('H-2')]);
    await h.orders.importNow();
    const identity = new Identity({ db: h.db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
    await identity.start();
    const password = 'a-long-test-password';
    await identity.createUser(
      { username: 'sup', roles: ['supervisor'], password },
      { system: 'test' },
    );
    const none = () => () => undefined;
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      userWriteRate: { perSecond: 1e6, burst: 1e6 },
      writeRate: { perSecond: 1e6, burst: 1e6 },
    });
    cleanups.push(() => http.app.close());
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
    } as unknown as ApiSources);
    const HOST = 'localhost:4700';
    const headers = { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' };
    const login = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: { username: 'sup', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    // Changing the temporary password first.
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const changed = await http.app.inject({
      method: 'POST',
      url: '/api/v1/account/password',
      headers: { ...headers, cookie },
      payload: { currentPassword: password, newPassword: `${password}-2` },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const session = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: { username: 'sup', password: `${password}-2` },
    });
    const sup = String(session.headers['set-cookie']).split(';')[0] ?? '';
    const get = (url: string) =>
      http.app.inject({ method: 'GET', url, headers: { host: HOST, cookie: sup } });
    const post = (url: string, payload: unknown) =>
      http.app.inject({
        method: 'POST',
        url,
        headers: { ...headers, cookie: sup },
        payload: JSON.stringify(payload),
      });

    const list = orderListSchema.parse((await get('/api/v1/orders?status=imported')).json());
    expect(list.orders.map((o) => o.id)).toEqual(['H-1', 'H-2']);
    expect(list.orders[0]).toMatchObject({ remaining: 4, dispatched: 0, flags: { short: false } });
    expect((await get('/api/v1/orders?status=bogus')).statusCode).toBe(400);
    expect(
      orderListSchema.parse((await get('/api/v1/orders?from=2026-10-13T00:00:00Z')).json()).orders,
    ).toEqual([]);
    const v1 = list.orders[0]?.version ?? 0;
    const stale = await post('/api/v1/orders/H-1/release', { version: v1 + 5 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ type: PROBLEM_TYPES.orderStale });
    const released = orderWriteResultSchema.parse(
      (await post('/api/v1/orders/H-1/release', { version: v1 })).json(),
    );
    expect(released).toMatchObject({ order: { status: 'released' }, command: null });
    expect(
      (await post('/api/v1/orders/H-1/release', { version: released.order.version })).json(),
    ).toMatchObject({
      type: PROBLEM_TYPES.orderState,
    });
    expect((await post('/api/v1/orders/NOPE/release', { version: 1 })).statusCode).toBe(404);
    expect(
      (
        await post('/api/v1/orders/H-1/dispatch', {
          version: released.order.version,
          equipment: 'pck-01',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await post('/api/v1/orders/H-1/dispatch', { version: released.order.version, actor: 'x' }))
        .statusCode,
    ).toBe(400);
    const dispatchedOrder = orderWriteResultSchema.parse(
      (await post('/api/v1/orders/H-1/dispatch', { version: released.order.version })).json(),
    );
    expect(dispatchedOrder.command).toMatchObject({
      commandId: 'H-1~OP10~1',
      equipment: 'cnc-01',
      state: 'queued',
    });
    await h.orders.tick();
    expect(
      (await post('/api/v1/orders/H-1/redispatch', { version: dispatchedOrder.order.version + 0 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await post('/api/v1/orders/H-2/cancel', { version: 1, reason: 'not needed' })).statusCode,
    ).toBe(200);
    expect((await post('/api/v1/orders/H-2/close', { version: 2 })).json()).toMatchObject({
      type: PROBLEM_TYPES.orderState,
    });

    const detail = orderDetailSchema.parse((await get('/api/v1/orders/H-1')).json());
    expect(detail.commands[0]).toMatchObject({
      commandId: 'H-1~OP10~1',
      state: 'sent',
      attempts: 1,
      attemptList: [{ attempt: 1 }],
      results: [],
    });
    expect(detail.routing).toHaveLength(5);
    expect(detail.bom.map((b) => b.material)).toContain('BLANK-100');
    expect(detail.history.map((e) => e.action)).toEqual([
      'order.dispatch',
      'order.release',
      'order.import',
    ]);
    expect(detail.history[0]).toMatchObject({
      actor: 'sup',
      authenticated: true,
      roles: ['supervisor'],
    });
    expect(detail.erpMessages.map((m) => m.status)).toEqual(['imported', 'pending', 'pending']);
    expect((await get('/api/v1/orders/NOPE')).statusCode).toBe(404);
    const [delivery] = h.sink.of('H-1~OP10~1');
    if (!delivery) throw new Error('not published');
    await result(h, delivery, 'cnc-01', { result: 'accepted', acceptedSeq: 2 });
    await h.orders.tick();
    const after = orderDetailSchema.parse((await get('/api/v1/orders/H-1')).json());
    expect(after.commands[0]?.results).toMatchObject([
      { result: 'accepted', acceptedSeq: 2, code: null },
    ]);
    expect(after.order).toMatchObject({ dispatched: 4, remaining: 0 });
    const incidentList = await get('/api/v1/order-incidents?open=true');
    expect(incidentList.json()).toEqual({ incidents: [] });

    // Push: order and command upserts on the `orders` topic.
    const hub = new PushHub({ heartbeatMs: 3_600_000, clockMs: 3_600_000 });
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
    hub.attach({
      equipment: {
        currentStates: () => [],
        watermark: () => undefined,
        watermarks: () => [],
        onChange: none,
      },
      ingest: { onStored: none, telemetryMetrics: () => Promise.resolve([]) },
      catalog: new Set(),
      orders: h.orders,
    });
    hub.connect(socket);
    emitter.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'subscribe', topic: 'orders' })),
      false,
    );
    await job(h, delivery.value, 'cnc-01', 2, 'accepted');
    await h.orders.tick();
    await new Promise((r) => setImmediate(r));
    expect(sent[0]).toMatchObject({ type: 'subscribed', topic: 'orders' });
    expect(sent.filter((m) => m.type === 'command').at(-1)).toMatchObject({
      event: 'updated',
      command: { commandId: 'H-1~OP10~1', confirmed: true },
    });
    emitter.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'unsubscribe', topic: 'orders' })),
      false,
    );
    hub.close();
    identity.stop();
  });
});

describe('the command connection (#174)', () => {
  it('publishes commands as `mes` with its own client id, QoS 1, and refuses while disconnected', async () => {
    const { url, container: broker } = await startBroker();
    cleanups.push(async () => {
      await broker.stop();
    });
    const listener = await mqtt.connectAsync(url, {
      username: 'mes',
      password: TEST_PASSWORDS.mes,
      protocolVersion: 5,
      clientId: 'orders-test-listener',
    });
    cleanups.push(() => listener.endAsync(true));
    const received: string[] = [];
    listener.on('message', (topic, payload) => received.push(`${topic} ${payload.toString()}`));
    await listener.subscribeAsync('orbis/gebze/+/+/+/cmd/#', { qos: 1 });
    const publisher = new MqttCommandPublisher({
      url,
      username: 'mes',
      password: TEST_PASSWORDS.mes,
      clientId: 'mes-server-cmd',
    });
    for (let deadline = Date.now() + 10_000; !publisher.connected;) {
      if (Date.now() > deadline) throw new Error('not connected');
      await new Promise((r) => setTimeout(r, 50));
    }
    const topic = 'orbis/gebze/machining/cell-m1/cnc-01/cmd/load-order';
    await publisher.publish(topic, '{"x":1}');
    for (let deadline = Date.now() + 5_000; received.length === 0;) {
      if (Date.now() > deadline) throw new Error('not received');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(received).toEqual([`${topic} {"x":1}`]);
    await publisher.close();
    expect(publisher.connected).toBe(false);
    await expect(publisher.publish(topic, '{}')).rejects.toThrow(/not connected/);
  }, 120_000);
});
