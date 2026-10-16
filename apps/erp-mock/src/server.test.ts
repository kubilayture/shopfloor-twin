import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ERP_PROBLEM_TYPES,
  confirmationListSchema,
  erpOrderViewSchema,
  erpProblemSchema,
  feedEntrySchema,
  lotListSchema,
  messageReceiptSchema,
  orderFeedSchema,
  statusMessageListSchema,
} from '@shopfloor/contracts/erp-api';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDataset, type Dataset } from './dataset.ts';
import { parseEnv, isWeakToken } from './env.ts';
import { Erp } from './erp.ts';
import { createLogger } from './log.ts';
import { createErpServer } from './server.ts';
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
  return { base: `http://127.0.0.1:${String(port)}`, logs, stop };
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
    expect(await page('?after=6')).toEqual({ entries: [], cursor: 6, more: false });
    expect(await page('?after=99')).toEqual({ entries: [], cursor: 99, more: false });
    for (const query of ['?after=-1', '?after=x', '?limit=0', '?limit=501']) {
      await problem(await fetch(`${base}/api/v1/orders${query}`, { headers: auth }), 400);
    }
  });

  it('serves the lots', async () => {
    const { base } = await start(storePath());
    const lots = lotListSchema.parse(
      await (await fetch(`${base}/api/v1/lots`, { headers: auth })).json(),
    );
    expect(lots.lots).toEqual(dataset.lots);
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
    // The same key on the status endpoint is a conflict as well.
    const other = await post(base, '/api/v1/order-status', status('accepted'), key);
    expect((await problem(other, 409)).type).toBe(ERP_PROBLEM_TYPES.idempotencyConflict);

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
    expect(metrics).toContain('erp_message_posts_total{kind="status",outcome="conflict"} 1');
    expect(metrics).toContain('erp_messages_stored{kind="confirmation"} 1');
    // Nothing secret in the log: no token, no header.
    expect(logs.join('')).not.toContain(TOKEN);
    expect(logs.some((line) => line.includes('"msg":"message received"'))).toBe(true);
  });

  it('refuses messages without a key, of the wrong type, invalid, oversized or for unknown orders', async () => {
    const { base } = await start(storePath());
    const key = (k: string) => ({ 'idempotency-key': k });
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
      const refused = await problem(
        await post(base, '/api/v1/confirmations', body, key('k1')),
        422,
      );
      expect(refused).toMatchObject({ type: ERP_PROBLEM_TYPES.unknownOrder, detail });
    }
    // None of the refusals used up the key.
    expect((await post(base, '/api/v1/confirmations', confirmation(), key('k1'))).status).toBe(201);
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
    await send('/api/v1/order-status', status('accepted'), 'ORD-1001~status~accepted');
    await send('/api/v1/order-status', status('released'), 'ORD-1001~status~released');
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
      'ORD-1001~status~completed',
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
    const key = { 'idempotency-key': 'ORD-1002~status~accepted' };
    const body = status('accepted', { orderNumber: 'ORD-1002' });
    const first = await start(file);
    const created = await post(first.base, '/api/v1/order-status', body, key);
    expect(created.status).toBe(201);
    const receipt: unknown = await created.json();
    await first.stop();

    const second = await start(file);
    const replay = await post(second.base, '/api/v1/order-status', body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
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
