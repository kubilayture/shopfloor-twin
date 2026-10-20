import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ERP_PROBLEM_TYPES,
  confirmationKey,
  statusKey,
  confirmationListSchema,
  erpLotViewSchema,
  erpOrderViewSchema,
  erpProblemSchema,
  feedEntrySchema,
  lotListSchema,
  messageReceiptSchema,
  orderFeedSchema,
  qualityNotificationKey,
  qualityNotificationListSchema,
  statusMessageListSchema,
} from '@shopfloor/contracts/erp-api';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDataset, type Dataset } from './dataset.ts';
import { parseEnv, isWeakToken } from './env.ts';
import { Erp } from './erp.ts';
import { createLogger } from './log.ts';
import { bearerMatches, createErpServer, tokenDigest, type ErpApiRoute } from './server.ts';
import { ErpStore } from './store.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const TOKEN = 'test-token-0123456789abcdef';

let dataset: Dataset;
beforeAll(async () => {
  dataset = await loadDataset(join(REPO, 'config/erp/orders.yaml'), join(REPO, 'config/plant'));
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Running {
  readonly base: string;
  readonly logs: string[];
  readonly routes: readonly ErpApiRoute[];
  stop(): Promise<void>;
}

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'erp-server-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, 'erp.db');
}

async function start(file: string, admin = false): Promise<Running> {
  const store = new ErpStore(file);
  const logs: string[] = [];
  const server = createErpServer({
    erp: new Erp(dataset, store),
    store,
    token: TOKEN,
    admin,
    log: createLogger('debug', (line) => logs.push(line)),
    now: () => new Date('2026-10-16T08:00:00.000Z'),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    store.close();
  };
  cleanups.push(stop);
  return { base: `http://127.0.0.1:${String(port)}`, logs, routes: server.apiRoutes, stop };
}

const auth = { authorization: `Bearer ${TOKEN}` };

function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const confirmation = (extra: object = {}) => ({
  orderNumber: 'ORD-1001',
  revision: 1,
  operation: 'OP10',
  kind: 'final',
  confirmation: 1,
  yield: 58,
  scrap: [{ reason: 'DIMENSIONAL', quantity: 2 }],
  reworkPasses: 0,
  material: [{ material: 'BLANK-100', quantity: 60 }],
  confirmedAt: '2026-10-12T16:00:00+03:00',
  ...extra,
});

const status = (value: string, extra: object = {}) => ({
  orderNumber: 'ORD-1001',
  revision: 1,
  status: value,
  sentAt: '2026-10-12T06:01:00+03:00',
  ...extra,
});

async function problem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  return erpProblemSchema.parse(await response.json());
}

describe('ERP mock API', () => {
  it('refuses every API route without the bearer token, but not health and metrics', async () => {
    const { base } = await start(storePath());
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }]) {
      const response = await fetch(`${base}/api/v1/lots`, { headers });
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="erp-mock"');
      await problem(response, 401);
    }
    await problem(
      await post(base, '/api/v1/confirmations', confirmation(), { authorization: '' }),
      401,
    );
    await problem(await fetch(`${base}/api/v1/nothing`), 401);
    expect(await (await fetch(`${base}/health/live`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('erp_unauthorized_requests_total 5');
    expect(metrics).toContain('erp_feed_entries 6');
    await problem(await fetch(`${base}/health/live`, { method: 'POST' }), 405);
    await problem(await fetch(`${base}/elsewhere`), 404);
    // Scheme names are case-insensitive.
    expect(
      (await fetch(`${base}/api/v1/lots`, { headers: { authorization: `bearer ${TOKEN}` } }))
        .status,
    ).toBe(200);
  });

  it('serves the change feed in pages from a cursor', async () => {
    const { base } = await start(storePath());
    const page = async (query: string) => {
      const response = await fetch(`${base}/api/v1/orders${query}`, { headers: auth });
      expect(response.status).toBe(200);
      return orderFeedSchema.parse(await response.json());
    };
    const all = await page('');
    expect(all.entries.map((e) => e.feedSeq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(all).toMatchObject({ cursor: 6, more: false });
    const first = await page('?limit=4');
    expect(first).toMatchObject({ cursor: 4, more: true });
    const rest = await page(`?after=${String(first.cursor)}&limit=4`);
    expect(rest.entries.map((e) => `${e.order.orderNumber}/${String(e.order.revision)}`)).toEqual([
      'ORD-1003/2',
      'ORD-1005/1',
    ]);
    expect(rest).toMatchObject({ cursor: 6, more: false });
    expect(await page('?after=6')).toEqual({
      feedId: all.feedId,
      entries: [],
      cursor: 6,
      more: false,
    });
    // A cursor beyond the feed belongs to another feed.
    const ahead = await problem(
      await fetch(`${base}/api/v1/orders?after=7`, { headers: auth }),
      409,
    );
    expect(ahead.type).toBe(ERP_PROBLEM_TYPES.cursorAhead);
    expect(ahead.detail).toContain(all.feedId);
    for (const query of ['?after=-1', '?after=x', '?limit=0', '?limit=501']) {
      await problem(await fetch(`${base}/api/v1/orders${query}`, { headers: auth }), 400);
    }
  });

  it("serves the lots with the feed's identity", async () => {
    const { base } = await start(storePath());
    const lots = lotListSchema.parse(
      await (await fetch(`${base}/api/v1/lots`, { headers: auth })).json(),
    );
    expect(lots.lots).toEqual(dataset.lots);
    const feed = orderFeedSchema.parse(
      await (await fetch(`${base}/api/v1/orders`, { headers: auth })).json(),
    );
    expect(lots.feedId).toBe(feed.feedId);
  });

  it('changes the feed identity when only the lots change', () => {
    const store = new ErpStore(':memory:');
    cleanups.push(() => {
      store.close();
    });
    const before = new Erp(dataset, store).feedId;
    const fewer = new Erp({ ...dataset, lots: dataset.lots.slice(1) }, store).feedId;
    const smaller = new Erp(
      { ...dataset, lots: dataset.lots.map((lot, i) => (i === 0 ? { ...lot, quantity: 1 } : lot)) },
      store,
    ).feedId;
    expect(new Set([before, fewer, smaller]).size).toBe(3);
    expect(new Erp(dataset, store).feedId).toBe(before);
  });

  it('takes a confirmation once: 201, then 200 with the same receipt, 409 for another body', async () => {
    const { base, logs } = await start(storePath());
    const key = { 'idempotency-key': 'ORD-1001~OP10~conf~1' };
    const created = await post(base, '/api/v1/confirmations', confirmation(), key);
    expect(created.status).toBe(201);
    const receipt = messageReceiptSchema.parse(await created.json());
    expect(receipt).toEqual({
      idempotencyKey: 'ORD-1001~OP10~conf~1',
      kind: 'confirmation',
      orderNumber: 'ORD-1001',
      receivedSeq: 1,
      receivedAt: '2026-10-16T08:00:00.000Z',
    });
    // The same message again (keys in another order): the stored answer.
    const reordered = Object.fromEntries(Object.entries(confirmation()).reverse());
    const replay = await post(base, '/api/v1/confirmations', reordered, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const conflict = await problem(
      await post(base, '/api/v1/confirmations', confirmation({ yield: 57 }), key),
      409,
    );
    expect(conflict.type).toBe(ERP_PROBLEM_TYPES.idempotencyConflict);
    // A confirmation key on a status message is not that message's key.
    const other = await post(base, '/api/v1/order-status', status('accepted'), key);
    expect((await problem(other, 422)).type).toBe(ERP_PROBLEM_TYPES.keyMismatch);

    const list = confirmationListSchema.parse(
      await (
        await fetch(`${base}/api/v1/confirmations?orderNumber=ORD-1001`, { headers: auth })
      ).json(),
    );
    expect(list.confirmations).toHaveLength(1);
    expect(list.confirmations[0]?.receipt).toEqual(receipt);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('erp_message_posts_total{kind="confirmation",outcome="created"} 1');
    expect(metrics).toContain('erp_message_posts_total{kind="confirmation",outcome="replayed"} 1');
    expect(metrics).toContain('erp_message_posts_total{kind="confirmation",outcome="conflict"} 1');
    expect(metrics).toContain('erp_message_posts_total{kind="status",outcome="key-mismatch"} 1');
    expect(metrics).toContain('erp_messages_stored{kind="confirmation"} 1');
    // Nothing secret in the log: no token, no header.
    expect(logs.join('')).not.toContain(TOKEN);
    expect(logs.some((line) => line.includes('"msg":"message received"'))).toBe(true);
  });

  it('refuses messages without a key, of the wrong type, invalid, oversized or for unknown orders', async () => {
    const { base } = await start(storePath());
    const key = (k: string) => ({ 'idempotency-key': k });
    const k1 = (body: { orderNumber: string; operation: string; confirmation: number }) =>
      key(confirmationKey(body.orderNumber, body.operation, body.confirmation));
    expect(
      (await problem(await post(base, '/api/v1/confirmations', confirmation()), 400)).detail,
    ).toBe('the Idempotency-Key header is required');
    await problem(await post(base, '/api/v1/confirmations', confirmation(), key('has space')), 400);
    await problem(
      await post(base, '/api/v1/confirmations', confirmation(), {
        ...key('k1'),
        'content-type': 'text/plain',
      }),
      415,
    );
    await problem(await post(base, '/api/v1/confirmations', '{not json', key('k1')), 400);
    const invalid = await problem(
      await post(base, '/api/v1/confirmations', confirmation({ confirmation: 2 }), key('k1')),
      422,
    );
    expect(invalid.detail).toContain('confirmation:');
    await problem(
      await post(
        base,
        '/api/v1/confirmations',
        { ...confirmation(), filler: 'x'.repeat(70_000) },
        key('k1'),
      ),
      413,
    );
    for (const [body, detail] of [
      [confirmation({ orderNumber: 'ORD-9999' }), 'order ORD-9999 is unknown'],
      [confirmation({ revision: 3 }), 'order ORD-1001 has no revision 3'],
      [confirmation({ operation: 'OP60' }), 'order ORD-1001 revision 1 has no operation OP60'],
    ] as const) {
      const refused = await problem(await post(base, '/api/v1/confirmations', body, k1(body)), 422);
      expect(refused).toMatchObject({ type: ERP_PROBLEM_TYPES.unknownOrder, detail });
    }
    // None of the refusals used up the key.
    const final = confirmation();
    expect((await post(base, '/api/v1/confirmations', final, k1(final))).status).toBe(201);
    await problem(
      await fetch(`${base}/api/v1/confirmations?orderNumber=a~b`, { headers: auth }),
      400,
    );
    await problem(await fetch(`${base}/api/v1/lots`, { method: 'DELETE', headers: auth }), 405);
  });

  it('derives its view of an order from the status messages and confirmations, corrections included', async () => {
    const { base } = await start(storePath());
    const send = async (path: string, body: object, key: string) => {
      const response = await post(base, path, body, { 'idempotency-key': key });
      expect(response.status).toBe(201);
    };
    await send('/api/v1/order-status', status('accepted'), statusKey('ORD-1001', 1, 'accepted'));
    await send('/api/v1/order-status', status('released'), statusKey('ORD-1001', 1, 'released'));
    await send('/api/v1/confirmations', confirmation(), 'ORD-1001~OP10~conf~1');
    await send(
      '/api/v1/confirmations',
      confirmation({
        kind: 'correction',
        confirmation: 2,
        yield: -1,
        scrap: [
          { reason: 'DIMENSIONAL', quantity: 1 },
          { reason: 'CHIP', quantity: 0 },
        ],
        material: [],
      }),
      'ORD-1001~OP10~conf~2',
    );
    await send(
      '/api/v1/confirmations',
      confirmation({
        operation: 'OP30',
        yield: 55,
        scrap: [],
        reworkPasses: 2,
        material: [
          { material: 'SP-100', quantity: 55 },
          { material: 'SK-1', quantity: 57 },
        ],
      }),
      'ORD-1001~OP30~conf~1',
    );
    await send(
      '/api/v1/order-status',
      status('completed', { short: true }),
      statusKey('ORD-1001', 1, 'completed'),
    );

    const response = await fetch(`${base}/api/v1/orders/ORD-1001`, { headers: auth });
    expect(response.status).toBe(200);
    const view = erpOrderViewSchema.parse(await response.json());
    expect(view).toMatchObject({ status: 'completed', short: true, revisions: [1] });
    expect(view.statusHistory.map((s) => [s.status, s.receivedSeq])).toEqual([
      ['accepted', 1],
      ['released', 2],
      ['completed', 6],
    ]);
    const op = (id: string) => view.operations.find((o) => o.operation === id);
    expect(op('OP10')).toEqual({
      operation: 'OP10',
      workCenter: 'cell-m1',
      confirmations: 2,
      yield: 57,
      scrap: [
        { reason: 'CHIP', quantity: 0 },
        { reason: 'DIMENSIONAL', quantity: 3 },
      ],
      scrapTotal: 3,
      reworkPasses: 0,
      material: [{ material: 'BLANK-100', quantity: 60 }],
    });
    expect(op('OP30')).toMatchObject({
      workCenter: 'line-a1',
      yield: 55,
      reworkPasses: 2,
      material: [
        { material: 'SK-1', quantity: 57 },
        { material: 'SP-100', quantity: 55 },
      ],
    });
    expect(op('OP50')).toMatchObject({ confirmations: 0, yield: 0, scrap: [], material: [] });

    const statuses = statusMessageListSchema.parse(
      await (await fetch(`${base}/api/v1/order-status`, { headers: auth })).json(),
    );
    expect(statuses.messages.map((m) => m.body.status)).toEqual([
      'accepted',
      'released',
      'completed',
    ]);

    // An order with two revisions shows its latest; an order with no message has no status.
    const revised = erpOrderViewSchema.parse(
      await (await fetch(`${base}/api/v1/orders/ORD-1003`, { headers: auth })).json(),
    );
    expect(revised).toMatchObject({ status: null, short: false, revisions: [1, 2] });
    expect(revised.order).toMatchObject({ revision: 2, quantity: 100 });
    await problem(await fetch(`${base}/api/v1/orders/ORD-9999`, { headers: auth }), 404);
    await problem(await fetch(`${base}/api/v1/orders/%E0%A4%A`, { headers: auth }), 404);
  });

  it('keeps what it received across a restart: a replay after it answers 200', async () => {
    const file = storePath();
    const key = { 'idempotency-key': statusKey('ORD-1002', 1, 'accepted') };
    const body = status('accepted', { orderNumber: 'ORD-1002' });
    const first = await start(file);
    const created = await post(first.base, '/api/v1/order-status', body, key);
    expect(created.status).toBe(201);
    const receipt: unknown = await created.json();

    const feedId = async (base: string) =>
      orderFeedSchema.parse(await (await fetch(`${base}/api/v1/orders`, { headers: auth })).json())
        .feedId;
    const before = await feedId(first.base);
    await first.stop();

    const second = await start(file);
    const replay = await post(second.base, '/api/v1/order-status', body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    // Same dataset, same store: the same feed. A new store is another feed.
    expect(await feedId(second.base)).toBe(before);
    const fresh = await start(storePath());
    expect(await feedId(fresh.base)).not.toBe(before);
  });

  it('takes a message only under the key built from its body', async () => {
    const { base } = await start(storePath());
    const final = confirmation();
    // The final under a key of another number, and a status under the old key without revision.
    for (const [path, body, key, expected] of [
      [
        '/api/v1/confirmations',
        final,
        'ORD-1001~OP10~conf~7',
        confirmationKey('ORD-1001', 'OP10', 1),
      ],
      [
        '/api/v1/order-status',
        status('accepted'),
        'ORD-1001~status~accepted',
        statusKey('ORD-1001', 1, 'accepted'),
      ],
    ] as const) {
      const refused = await problem(await post(base, path, body, { 'idempotency-key': key }), 422);
      expect(refused).toMatchObject({ type: ERP_PROBLEM_TYPES.keyMismatch });
      expect(refused.detail).toContain(`expected ${expected}`);
    }
    // So the same (order, operation, number) can never be stored under two keys: the duplicate
    // with another body under its own key is the idempotency conflict.
    const key = { 'idempotency-key': confirmationKey('ORD-1001', 'OP10', 1) };
    expect((await post(base, '/api/v1/confirmations', final, key)).status).toBe(201);
    const twin = await post(base, '/api/v1/confirmations', confirmation({ yield: 50 }), key);
    expect((await problem(twin, 409)).type).toBe(ERP_PROBLEM_TYPES.idempotencyConflict);
    // `accepted` for two revisions of one order are two messages.
    for (const revision of [1, 2]) {
      const accepted = status('accepted', { orderNumber: 'ORD-1003', revision });
      const response = await post(base, '/api/v1/order-status', accepted, {
        'idempotency-key': statusKey('ORD-1003', revision, 'accepted'),
      });
      expect(response.status).toBe(201);
    }
  });

  it('refuses a correction with no final confirmation before it', async () => {
    const { base } = await start(storePath());
    const correction = confirmation({ kind: 'correction', confirmation: 2, yield: -1 });
    const key = { 'idempotency-key': confirmationKey('ORD-1001', 'OP10', 2) };
    const refused = await problem(await post(base, '/api/v1/confirmations', correction, key), 422);
    expect(refused.type).toBe(ERP_PROBLEM_TYPES.correctionWithoutFinal);
    // A final of another operation doesn't count.
    const op20 = confirmation({ operation: 'OP20' });
    expect(
      (
        await post(base, '/api/v1/confirmations', op20, {
          'idempotency-key': confirmationKey('ORD-1001', 'OP20', 1),
        })
      ).status,
    ).toBe(201);
    await problem(await post(base, '/api/v1/confirmations', correction, key), 422);
    const final = { 'idempotency-key': confirmationKey('ORD-1001', 'OP10', 1) };
    expect((await post(base, '/api/v1/confirmations', confirmation(), final)).status).toBe(201);
    expect((await post(base, '/api/v1/confirmations', correction, key)).status).toBe(201);
  });

  it('answers two concurrent posts of one key with one 201 and one 200 of the same receipt', async () => {
    const { base } = await start(storePath());
    const key = { 'idempotency-key': confirmationKey('ORD-1001', 'OP10', 1) };
    const responses = await Promise.all(
      Array.from({ length: 2 }, () => post(base, '/api/v1/confirmations', confirmation(), key)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const [a, b] = await Promise.all(responses.map((r) => r.json()));
    expect(a).toEqual(b);
    const list = confirmationListSchema.parse(
      await (await fetch(`${base}/api/v1/confirmations`, { headers: auth })).json(),
    );
    expect(list.confirmations).toHaveLength(1);
  });

  it('stores message times in UTC, so one instant in two offsets is one body', async () => {
    const { base } = await start(storePath());
    const key = { 'idempotency-key': confirmationKey('ORD-1001', 'OP10', 1) };
    const local = confirmation({ confirmedAt: '2026-10-12T16:00:00+03:00' });
    const utc = confirmation({ confirmedAt: '2026-10-12T13:00:00Z' });
    expect((await post(base, '/api/v1/confirmations', local, key)).status).toBe(201);
    expect((await post(base, '/api/v1/confirmations', utc, key)).status).toBe(200);
    const list = confirmationListSchema.parse(
      await (await fetch(`${base}/api/v1/confirmations`, { headers: auth })).json(),
    );
    expect(list.confirmations[0]?.body.confirmedAt).toBe('2026-10-12T13:00:00.000Z');
  });

  it('adds orders through POST /orders only with ERP_ADMIN=on, at the end of the feed', async () => {
    const order = {
      orderNumber: 'ORD-2001',
      revision: 1,
      product: 'VB-200',
      quantity: 5,
      plannedStart: '2026-10-14T06:00:00+03:00',
      dueDate: '2026-10-14T14:00:00+03:00',
    };
    const off = await start(storePath());
    const refused = await post(off.base, '/api/v1/orders', order);
    expect(refused.headers.get('allow')).toBe('GET');
    await problem(refused, 405);
    await off.stop();

    const file = storePath();
    const on = await start(file, true);
    const created = await post(on.base, '/api/v1/orders', order);
    expect(created.status).toBe(201);
    const entry = feedEntrySchema.parse(await created.json());
    expect(entry.feedSeq).toBe(7);
    expect(entry.order.routing).toHaveLength(5);
    expect(entry.order.plannedStart).toBe('2026-10-14T03:00:00.000Z');
    const again = await problem(await post(on.base, '/api/v1/orders', order), 409);
    expect(again.type).toBe(ERP_PROBLEM_TYPES.revisionConflict);
    await problem(await post(on.base, '/api/v1/orders', { ...order, revision: 0 }), 422);
    const revised = await post(on.base, '/api/v1/orders', { ...order, revision: 2, quantity: 6 });
    expect(feedEntrySchema.parse(await revised.json()).feedSeq).toBe(8);
    await on.stop();

    // The added orders survive a restart with their feed numbers.
    const after = await start(file);
    const feed = orderFeedSchema.parse(
      await (await fetch(`${after.base}/api/v1/orders?after=6`, { headers: auth })).json(),
    );
    expect(feed.entries.map((e) => [e.feedSeq, e.order.orderNumber, e.order.revision])).toEqual([
      [7, 'ORD-2001', 1],
      [8, 'ORD-2001', 2],
    ]);
  });

  it('refuses to start when the dataset changed under orders added before', () => {
    const store = new ErpStore(':memory:');
    cleanups.push(() => {
      store.close();
    });
    const [first] = dataset.feed;
    if (first === undefined) throw new Error('empty dataset');
    store.addAdminOrder({ feedSeq: 3, order: first.order }, new Date());
    expect(() => new Erp(dataset, store)).toThrow(
      /added at feed number 3, but the dataset now has 6/,
    );
  });

  it('answers 500 without details when a handler fails', async () => {
    const store = new ErpStore(':memory:');
    const logs: string[] = [];
    const erp = new Erp(dataset, store);
    const server = createErpServer({
      erp,
      store,
      token: TOKEN,
      admin: false,
      log: createLogger('info', (line) => logs.push(line)),
    });
    store.close(); // every store read now throws
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => {
            done();
          });
        }),
    );
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/confirmations`, {
      headers: auth,
    });
    expect((await problem(response, 500)).detail).toBe('internal error');
    expect(logs.some((line) => line.includes('"msg":"request failed"'))).toBe(true);
  });
});

const notification = (
  transition: 'opened' | 'released' | 'rejected',
  extra: Record<string, unknown> = {},
) => ({
  holdId: 'H-1',
  transition,
  transitionNo: transition === 'opened' ? 1 : 2,
  subject: { kind: 'lot', id: 'SK1-2610-01' },
  reason: transition === 'opened' ? 'SUSPECT-LOT' : 'USE-AS-IS',
  user: 'quality.anna',
  occurredAt: '2026-10-12T10:15:00+03:00',
  scope: { units: 42, cartons: 2, orders: 1 },
  scopeAsOf: '2026-10-12T10:14:30+03:00',
  scopeFinal: false,
  ...extra,
});

type Notification = ReturnType<typeof notification>;

const keyOf = (body: Notification) =>
  qualityNotificationKey(body.holdId, body.transition, body.transitionNo);

const notify = (base: string, body: Notification, key = keyOf(body)) =>
  post(base, '/api/v1/quality-notifications', body, { 'idempotency-key': key });

async function lotView(base: string, id: string) {
  const response = await fetch(`${base}/api/v1/lots/${id}`, { headers: auth });
  expect(response.status).toBe(200);
  return erpLotViewSchema.parse(await response.json());
}

describe('quality notifications and the lot view (Phase 8)', () => {
  it('takes a notification once: 201, then 200 with the same receipt, 409 for another body, also after a restart', async () => {
    const file = storePath();
    const first = await start(file);
    const opened = notification('opened');
    const created = await notify(first.base, opened);
    expect(created.status).toBe(201);
    const receipt = messageReceiptSchema.parse(await created.json());
    expect(receipt).toEqual({
      idempotencyKey: 'H-1~opened~1',
      kind: 'quality-notification',
      holdId: 'H-1',
      receivedSeq: 1,
      receivedAt: '2026-10-16T08:00:00.000Z',
    });
    // Keys in another order and the times in UTC: the same body.
    const sameInUtc = Object.fromEntries(
      Object.entries({
        ...opened,
        occurredAt: '2026-10-12T07:15:00Z',
        scopeAsOf: '2026-10-12T07:14:30.000Z',
      }).reverse(),
    ) as Notification;
    const replay = await notify(first.base, sameInUtc);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    // The scope counts grew: another body under the key of one transition.
    const grown = notification('opened', { scope: { units: 43, cartons: 2, orders: 1 } });
    const conflict = await problem(await notify(first.base, grown), 409);
    expect(conflict.type).toBe(ERP_PROBLEM_TYPES.idempotencyConflict);
    await first.stop();

    const second = await start(file);
    const again = await notify(second.base, opened);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(receipt);
    const list = qualityNotificationListSchema.parse(
      await (await fetch(`${second.base}/api/v1/quality-notifications`, { headers: auth })).json(),
    );
    expect(list.notifications).toEqual([
      {
        receipt,
        body: {
          ...opened,
          occurredAt: '2026-10-12T07:15:00.000Z',
          scopeAsOf: '2026-10-12T07:14:30.000Z',
        },
      },
    ]);
    const metrics = await (await fetch(`${second.base}/metrics`)).text();
    expect(metrics).toContain('erp_messages_stored{kind="quality-notification"} 1');
    expect(metrics).toContain(
      'erp_message_posts_total{kind="quality-notification",outcome="replayed"} 1',
    );
  });

  it('takes a notification only under the key built from its body', async () => {
    const { base } = await start(storePath());
    const opened = notification('opened');
    for (const key of ['H-1~opened~2', 'H-2~opened~1', 'H-1~released~1', 'ORD-1001~OP10~conf~1']) {
      const refused = await problem(await notify(base, opened, key), 422);
      expect(refused.type).toBe(ERP_PROBLEM_TYPES.keyMismatch);
      expect(refused.detail).toContain('expected H-1~opened~1');
    }
    expect((await notify(base, opened)).status).toBe(201);
    // A notification's key on a status message, and a status key here: neither is that message's key.
    const onStatus = await post(base, '/api/v1/order-status', status('accepted'), {
      'idempotency-key': 'H-1~opened~1',
    });
    expect((await problem(onStatus, 422)).type).toBe(ERP_PROBLEM_TYPES.keyMismatch);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain(
      'erp_message_posts_total{kind="quality-notification",outcome="key-mismatch"} 4',
    );
  });

  it('refuses invalid notifications, a comment among them, and subjects the ERP does not hold', async () => {
    const { base } = await start(storePath());
    const invalid = async (body: Record<string, unknown>, key = 'H-1~opened~1') =>
      problem(
        await post(base, '/api/v1/quality-notifications', body, { 'idempotency-key': key }),
        422,
      );
    // `opened` is transition 1, a decision 2 and above.
    expect((await invalid(notification('opened', { transitionNo: 2 }))).detail).toContain(
      'transitionNo',
    );
    await invalid(notification('released', { transitionNo: 1 }), 'H-1~released~1');
    // A comment is not notified; no other field is taken either.
    await invalid(notification('opened', { transition: 'commented' }), 'H-1~commented~1');
    await invalid({ ...notification('opened'), extra: 1 });
    await invalid(notification('opened', { holdId: 'H~1' }), 'H~1~opened~1');
    await invalid(notification('opened', { subject: { kind: 'pallet', id: 'P1' } }));
    await invalid(notification('opened', { user: 'Not A User' }));
    await invalid(notification('opened', { scope: { units: -1, cartons: 0, orders: 0 } }));
    await invalid(notification('opened', { scopeAsOf: '2026-10-12T10:14:30' }));
    expect(
      (
        await problem(
          await post(base, '/api/v1/quality-notifications', notification('opened')),
          400,
        )
      ).detail,
    ).toBe('the Idempotency-Key header is required');

    // A lot not in the lot list, an order not in the feed: refused, the key stays unused.
    for (const subject of [
      { kind: 'lot', id: 'SK1-9999-99' },
      { kind: 'order', id: 'ORD-9999' },
    ]) {
      const refused = await problem(await notify(base, notification('opened', { subject })), 422);
      expect(refused.type).toBe(ERP_PROBLEM_TYPES.unknownSubject);
    }
    expect((await notify(base, notification('opened'))).status).toBe(201);
    // Serials and cartons are the MES's own: not checked. An order of the feed is known.
    for (const [holdId, subject] of [
      ['H-2', { kind: 'serial', id: 'VB-100-000123' }],
      ['H-3', { kind: 'carton', id: 'ORD-1001-C07' }],
      ['H-4', { kind: 'order', id: 'ORD-1001' }],
    ] as const) {
      expect((await notify(base, notification('opened', { holdId, subject }))).status).toBe(201);
    }
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain(
      'erp_message_posts_total{kind="quality-notification",outcome="unknown-subject"} 2',
    );
    expect(metrics).toContain(
      'erp_message_posts_total{kind="quality-notification",outcome="created"} 4',
    );
  });

  it('takes one decision per hold, only after its opening, on the same subject', async () => {
    const { base } = await start(storePath());
    const released = notification('released');
    const early = await problem(await notify(base, released), 422);
    expect(early.type).toBe(ERP_PROBLEM_TYPES.holdSequence);
    const openedResponse = await notify(base, notification('opened'));
    expect(openedResponse.status).toBe(201);
    const openedReceipt = messageReceiptSchema.parse(await openedResponse.json());
    const elsewhere = notification('released', { subject: { kind: 'lot', id: 'SK2-2610-01' } });
    const moved = await problem(await notify(base, elsewhere), 422);
    expect(moved.type).toBe(ERP_PROBLEM_TYPES.holdSequence);
    expect(moved.detail).toContain('was opened on lot SK1-2610-01');
    // A decision on a subject the ERP doesn't hold is judged against the opening, not the lot list.
    const unknownLot = notification('released', { subject: { kind: 'lot', id: 'SK1-9999-99' } });
    expect((await problem(await notify(base, unknownLot), 422)).type).toBe(
      ERP_PROBLEM_TYPES.holdSequence,
    );
    const releasedResponse = await notify(base, released);
    expect(releasedResponse.status).toBe(201);
    const releasedReceipt = messageReceiptSchema.parse(await releasedResponse.json());
    // The outbox replaying both after the decision: the stored answers, no second hold.
    const openedAgain = await notify(base, notification('opened'));
    expect(openedAgain.status).toBe(200);
    expect(await openedAgain.json()).toEqual(openedReceipt);
    const releasedAgain = await notify(base, released);
    expect(releasedAgain.status).toBe(200);
    expect(await releasedAgain.json()).toEqual(releasedReceipt);
    const view = await lotView(base, 'SK1-2610-01');
    expect(view.holds).toHaveLength(1);
    expect(view.holds[0]).toMatchObject({
      holdId: 'H-1',
      state: 'released',
      notifications: [1, 2],
    });
    expect(view.blocked).toBe(false);
    // A second decision: under its own key (another transition or number) it is refused.
    for (const second of [
      notification('rejected'),
      notification('rejected', { transitionNo: 3 }),
      notification('released', { transitionNo: 3 }),
    ]) {
      const refused = await problem(await notify(base, second), 409);
      expect(refused.type).toBe(ERP_PROBLEM_TYPES.holdDecided);
    }
    const list = qualityNotificationListSchema.parse(
      await (
        await fetch(`${base}/api/v1/quality-notifications?holdId=H-1`, { headers: auth })
      ).json(),
    );
    expect(list.notifications.map((n) => n.receipt.idempotencyKey)).toEqual([
      'H-1~opened~1',
      'H-1~released~2',
    ]);
    const none = qualityNotificationListSchema.parse(
      await (
        await fetch(`${base}/api/v1/quality-notifications?holdId=H-9`, { headers: auth })
      ).json(),
    );
    expect(none.notifications).toEqual([]);
    await problem(
      await fetch(`${base}/api/v1/quality-notifications?holdId=H~1`, { headers: auth }),
      400,
    );
  });

  it('serves a lot with the holds on it: blocked while one is open or rejected', async () => {
    const { base } = await start(storePath());
    const feed = orderFeedSchema.parse(
      await (await fetch(`${base}/api/v1/orders`, { headers: auth })).json(),
    );
    const before = await lotView(base, 'SK1-2610-01');
    expect(before).toEqual({
      feedId: feed.feedId,
      lot: { id: 'SK1-2610-01', material: 'SK-1', quantity: 1800 },
      blocked: false,
      holds: [],
    });
    await problem(await fetch(`${base}/api/v1/lots/NO-SUCH-LOT`, { headers: auth }), 404);
    await problem(await fetch(`${base}/api/v1/lots/%E0%A4%A`, { headers: auth }), 404);

    expect((await notify(base, notification('opened'))).status).toBe(201);
    // A hold on a serial of that lot is not a hold on the lot.
    const serial = notification('opened', {
      holdId: 'H-2',
      subject: { kind: 'serial', id: 'VB-100-000001' },
    });
    expect((await notify(base, serial)).status).toBe(201);
    const open = await lotView(base, 'SK1-2610-01');
    expect(open.blocked).toBe(true);
    expect(open.holds).toEqual([
      {
        holdId: 'H-1',
        state: 'open',
        reason: 'SUSPECT-LOT',
        openedBy: 'quality.anna',
        openedAt: '2026-10-12T07:15:00.000Z',
        decidedBy: null,
        decidedAt: null,
        scope: { units: 42, cartons: 2, orders: 1 },
        scopeAsOf: '2026-10-12T07:14:30.000Z',
        scopeFinal: false,
        notifications: [1],
      },
    ]);

    // Released: used as is, no longer blocked; the scope is the release's.
    const released = notification('released', {
      user: 'quality.bert',
      occurredAt: '2026-10-12T12:00:00Z',
      scope: { units: 45, cartons: 3, orders: 2 },
      scopeAsOf: '2026-10-12T11:59:00Z',
      scopeFinal: true,
    });
    expect((await notify(base, released)).status).toBe(201);
    const after = await lotView(base, 'SK1-2610-01');
    expect(after.blocked).toBe(false);
    expect(after.holds[0]).toMatchObject({
      state: 'released',
      reason: 'USE-AS-IS',
      openedBy: 'quality.anna',
      decidedBy: 'quality.bert',
      decidedAt: '2026-10-12T12:00:00.000Z',
      scope: { units: 45, cartons: 3, orders: 2 },
      scopeFinal: true,
      notifications: [1, 3],
    });

    // A second hold, rejected: blocked again.
    const second = (transition: 'opened' | 'rejected') =>
      notification(transition, { holdId: 'H-5', reason: 'LEAK-RISK' });
    expect((await notify(base, second('opened'))).status).toBe(201);
    expect((await notify(base, second('rejected'))).status).toBe(201);
    const rejected = await lotView(base, 'SK1-2610-01');
    expect(rejected.blocked).toBe(true);
    expect(rejected.holds.map((h) => [h.holdId, h.state])).toEqual([
      ['H-1', 'released'],
      ['H-5', 'rejected'],
    ]);
    // Other lots are untouched.
    expect((await lotView(base, 'SK2-2610-01')).blocked).toBe(false);
  });
});

describe('the bearer token (#242, checklist S7)', () => {
  it('compares SHA-256 digests in constant time: never the raw token, whatever its length', () => {
    const expected = tokenDigest(TOKEN);
    expect(expected).toHaveLength(32);
    expect(bearerMatches(`Bearer ${TOKEN}`, expected)).toBe(true);
    expect(bearerMatches(`bearer  ${TOKEN} `, expected)).toBe(true);
    // A wrong token of any length (shorter, longer, the same length differing in the last
    // character, very long) is refused without throwing: `timingSafeEqual` on the raw values
    // would throw on a length mismatch, and so reveal the length.
    const sameLength = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('f') ? 'e' : 'f'}`;
    for (const header of [
      undefined,
      '',
      TOKEN,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN}0`,
      `Bearer ${sameLength}`,
      `Bearer ${'a'.repeat(100_000)}`,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN} ${TOKEN}`,
      'Bearer',
    ]) {
      expect(bearerMatches(header, expected), String(header).slice(0, 40)).toBe(false);
    }
    // The check is the only comparison of the token in the source: no `===` on it anywhere.
    const source = readFileSync(join(REPO, 'apps/erp-mock/src/server.ts'), 'utf8');
    expect(source).toContain('timingSafeEqual(tokenDigest(match[1]), expected)');
    expect(source).not.toMatch(/token\s*[!=]==|[!=]==\s*(options\.)?token\b/);
  });

  it('needs the token on every route and method of /api/v1, before routing (401, counted)', async () => {
    const { base, routes } = await start(storePath());
    // The route table as declared: a new route joins this list, and the loop below covers it.
    const declared = routes.flatMap((r) =>
      r.methods.map((m) => `${m} ${r.pattern.source.replaceAll('\\/', '/')}`),
    );
    expect(declared.sort()).toEqual(
      [
        'GET ^/api/v1/orders$',
        'POST ^/api/v1/orders$',
        'GET ^/api/v1/orders/([^/]+)$',
        'GET ^/api/v1/lots$',
        'GET ^/api/v1/lots/([^/]+)$',
        'GET ^/api/v1/quality-notifications$',
        'POST ^/api/v1/quality-notifications$',
        'GET ^/api/v1/confirmations$',
        'POST ^/api/v1/confirmations$',
        'GET ^/api/v1/order-status$',
        'POST ^/api/v1/order-status$',
      ].sort(),
    );
    const wrong = [
      {},
      { authorization: 'Bearer wrong' },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: TOKEN },
    ];
    let refused = 0;
    for (const route of routes) {
      const path = route.pattern.source
        .replace(/^\^/, '')
        .replace(/\$$/, '')
        .replaceAll('\\/', '/')
        .replace('([^/]+)', 'ORD-1001');
      for (const method of route.methods) {
        for (const headers of wrong) {
          const response = await fetch(`${base}${path}`, {
            method,
            headers: { ...headers, 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {}),
          });
          expect(response.headers.get('www-authenticate'), `${method} ${path}`).toBe(
            'Bearer realm="erp-mock"',
          );
          await problem(response, 401);
          refused++;
        }
        // With the token the same request gets past the check (whatever it answers then).
        const allowed = await fetch(`${base}${path}`, {
          method,
          headers: { ...auth, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(allowed.status, `${method} ${path}`).not.toBe(401);
        await allowed.body?.cancel();
      }
    }
    // Unknown /api/v1 paths and methods are refused for the token first: nothing about the
    // routes is learned without it.
    await problem(await fetch(`${base}/api/v1/nothing`), 401);
    await problem(await fetch(`${base}/api/v1/lots`, { method: 'DELETE' }), 401);
    refused += 2;
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain(`erp_unauthorized_requests_total ${String(refused)}`);
  });
});

describe('environment and log', () => {
  it('needs the token, defaults the rest and never echoes the token', () => {
    const ok = parseEnv({ ERP_API_TOKEN: 'secret-value' });
    expect(ok.ok && ok.env).toMatchObject({
      ERP_ADMIN: 'off',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 4600,
      ERP_STORE_PATH: '.store/erp.db',
    });
    expect(ok.ok && ok.env.ERP_DATASET.endsWith('config/erp/orders.yaml')).toBe(true);
    const missing = parseEnv({ HTTP_PORT: '70000' });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.issues.join('\n')).toMatch(/ERP_API_TOKEN: .*\(got \(hidden\)\)/);
    expect(!missing.ok && missing.issues.join('\n')).toMatch(/HTTP_PORT: .*\(got "70000"\)/);
    expect(parseEnv({ ERP_API_TOKEN: 'x', ERP_ADMIN: 'yes' }).ok).toBe(false);
    for (const token of ['with space', 'tab\there', ' leading', 'trailing\n']) {
      const refused = parseEnv({ ERP_API_TOKEN: token });
      expect(!refused.ok && refused.issues.join('\n')).toMatch(/ERP_API_TOKEN: .*\(hidden\)/);
    }
    expect(isWeakToken('change-me')).toBe(true);
    expect(isWeakToken('short')).toBe(true);
    expect(isWeakToken('0123456789abcdef0123')).toBe(false);
  });

  it('writes pino-shaped lines above its level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (line) => lines.push(line));
    log.info({ a: 1 }, 'hidden');
    log.warn({ a: 1 }, 'shown');
    log.error({ err: new Error('boom') }, 'failed');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      expect.objectContaining({ level: 40, a: 1, msg: 'shown' }),
      expect.objectContaining({ level: 50, err: { message: 'boom' }, msg: 'failed' }),
    ]);
    const silent: string[] = [];
    createLogger('silent', (line) => silent.push(line)).error({}, 'x');
    expect(silent).toEqual([]);
  });
});
