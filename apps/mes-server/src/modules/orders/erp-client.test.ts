/**
 * The ERP client (#174, ADR-0028) against a small HTTP server that answers as the ERP mock does:
 * the bearer token, the feed page and its 409 `erp-cursor-ahead`, message posts with their
 * `Idempotency-Key`, and how each answer maps to the outbox's stored, conflict, refused or retry.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ERP_PROBLEM_TYPES } from '@shopfloor/contracts/erp-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErpClient } from './erp-client.ts';

const TOKEN = 'test-token-0123456789';
let server: Server;
let url: string;
const requests: { method: string; url: string; auth: string; key: string; body: string }[] = [];
let answer: (req: IncomingMessage, res: ServerResponse) => void;

const problem = (res: ServerResponse, status: number, type: string, detail: string) => {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type, title: 'x', status, detail, instance: '/' }));
};
const receipt = {
  idempotencyKey: 'PO-1~r1~status~accepted',
  kind: 'status',
  orderNumber: 'PO-1',
  receivedSeq: 1,
  receivedAt: '2026-10-17T10:00:00.000Z',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization ?? '',
        key: String(req.headers['idempotency-key'] ?? ''),
        body,
      });
      answer(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  url = `http://127.0.0.1:${String(address.port)}/`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('ErpClient (ADR-0028)', () => {
  const client = () => new ErpClient({ url, token: TOKEN, timeoutMs: 2_000 });

  it('reads a feed page with the bearer token, and tells a cursor ahead from other errors', async () => {
    const page = { feedId: 'c'.repeat(32), entries: [], cursor: 7, more: false };
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(page));
    };
    expect(await client().feed(7, 100)).toEqual({ kind: 'page', page });
    expect(requests.at(-1)).toMatchObject({
      method: 'GET',
      url: '/api/v1/orders?after=7&limit=100',
      auth: `Bearer ${TOKEN}`,
    });
    answer = (_req, res) => {
      problem(res, 409, ERP_PROBLEM_TYPES.cursorAhead, 'after 9 is beyond the feed');
    };
    expect(await client().feed(9, 100)).toEqual({
      kind: 'cursor-ahead',
      detail: 'after 9 is beyond the feed',
    });
    answer = (_req, res) => {
      problem(res, 409, 'about:blank', 'other');
    };
    await expect(client().feed(9, 100)).rejects.toThrow(/409 other/);
    answer = (_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer' });
      res.end('no');
    };
    await expect(client().feed(0, 100)).rejects.toThrow(/401 no/);
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ feedId: 'x' }));
    };
    await expect(client().feed(0, 100)).rejects.toThrow(/invalid page/);
  });

  it('posts messages with their key and maps every answer for the outbox', async () => {
    const body = {
      orderNumber: 'PO-1',
      revision: 1,
      status: 'accepted',
      sentAt: receipt.receivedAt,
    };
    const post = () => client().post('status', receipt.idempotencyKey, body);
    answer = (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(receipt));
    };
    expect(await post()).toEqual({ kind: 'stored', status: 201, receipt });
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v1/order-status',
      key: receipt.idempotencyKey,
      body: JSON.stringify(body),
    });
    await client().post('confirmation', 'PO-1~OP10~conf~1', {});
    expect(requests.at(-1)?.url).toBe('/api/v1/confirmations');
    // A quality notification (#201), answered with its own receipt kind.
    const notified = {
      idempotencyKey: 'h-1~opened~1',
      kind: 'quality-notification',
      holdId: 'h-1',
      receivedSeq: 2,
      receivedAt: receipt.receivedAt,
    };
    answer = (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(notified));
    };
    expect(await client().post('quality-notification', 'h-1~opened~1', {})).toEqual({
      kind: 'stored',
      status: 201,
      receipt: notified,
    });
    expect(requests.at(-1)).toMatchObject({
      url: '/api/v1/quality-notifications',
      key: 'h-1~opened~1',
    });
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"not":"a receipt"}');
    };
    expect(await post()).toMatchObject({ kind: 'retry', detail: 'invalid receipt' });
    const cases: [number, string, string][] = [
      [409, ERP_PROBLEM_TYPES.idempotencyConflict, 'conflict'],
      [422, ERP_PROBLEM_TYPES.unknownOrder, 'refused'],
      [400, 'about:blank', 'refused'],
      [401, 'about:blank', 'retry'],
      [429, 'about:blank', 'retry'],
      [503, 'about:blank', 'retry'],
    ];
    for (const [status, type, kind] of cases) {
      answer = (_req, res) => {
        problem(res, status, type, `answer ${String(status)}`);
      };
      const outcome = await post();
      expect(outcome.kind, String(status)).toBe(kind);
      expect('detail' in outcome ? outcome.detail : '').toContain(`${String(status)} ${type}`);
    }
    answer = (_req, res) => {
      res.writeHead(500);
      res.end('not json');
    };
    expect(await post()).toMatchObject({ kind: 'retry', detail: '500 about:blank: not json' });
    // Nobody listening: retried.
    const away = new ErpClient({ url: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 500 });
    expect((await away.post('status', 'k', {})).kind).toBe('retry');
  });

  it('reads the lot list with the bearer token (#199) and refuses an invalid one', async () => {
    const list = {
      feedId: 'd'.repeat(32),
      lots: [{ id: 'BL100-2610-01', material: 'BLANK-100', quantity: 900 }],
    };
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(list));
    };
    expect(await client().lots()).toEqual(list);
    expect(requests.at(-1)).toMatchObject({
      method: 'GET',
      url: '/api/v1/lots',
      auth: `Bearer ${TOKEN}`,
    });
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"lots":[]}');
    };
    await expect(client().lots()).rejects.toThrow(/invalid list/);
    answer = (_req, res) => {
      problem(res, 503, 'about:blank', 'down');
    };
    await expect(client().lots()).rejects.toThrow('ERP lots: 503 down');
  });
});
