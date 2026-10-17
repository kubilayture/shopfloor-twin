import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DuplicateConfirmationError,
  DuplicateTransitionError,
  ErpStore,
  canonicalJson,
} from './store.ts';

const dirs: string[] = [];
const stores: ErpStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function path(): string {
  const dir = mkdtempSync(join(tmpdir(), 'erp-store-'));
  dirs.push(dir);
  return join(dir, 'nested', 'erp.db');
}

function open(file: string): ErpStore {
  const store = new ErpStore(file);
  stores.push(store);
  return store;
}

const t0 = new Date('2026-10-16T08:00:00.000Z');
const t1 = new Date('2026-10-16T09:00:00.000Z');

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });
});

describe('ErpStore', () => {
  it('answers a key once as created, then replayed with the first receipt, or conflict', () => {
    const store = open(':memory:');
    const first = store.receive('status', 'A~status~accepted', 'A', { s: 1, t: 2 }, t0);
    expect(first).toEqual({
      outcome: 'created',
      receipt: {
        idempotencyKey: 'A~status~accepted',
        kind: 'status',
        orderNumber: 'A',
        receivedSeq: 1,
        receivedAt: t0.toISOString(),
      },
    });
    // Same body, keys in another order, later: the stored answer.
    expect(store.receive('status', 'A~status~accepted', 'A', { t: 2, s: 1 }, t1)).toEqual({
      outcome: 'replayed',
      receipt: first.receipt,
    });
    expect(store.receive('status', 'A~status~accepted', 'A', { s: 2, t: 2 }, t1).outcome).toBe(
      'conflict',
    );
    // The same key on the other kind is a conflict too.
    expect(
      store.receive('confirmation', 'A~status~accepted', 'A', { s: 1, t: 2 }, t1).outcome,
    ).toBe('conflict');
    expect(store.counts()).toEqual({ confirmation: 0, status: 1, 'quality-notification': 0 });
  });

  it('refuses a second confirmation of one order, operation and number under another key', () => {
    const store = open(':memory:');
    const op10 = { operation: 'OP10', confirmation: 1 };
    store.insert('confirmation', 'A~OP10~conf~1', 'A', { n: 1 }, t0, op10);
    expect(() => store.insert('confirmation', 'other-key', 'A', { n: 2 }, t1, op10)).toThrow(
      DuplicateConfirmationError,
    );
    expect(() => store.receive('confirmation', 'other-key', 'A', { n: 2 }, t1, op10)).toThrow(
      'order A already has confirmation 1 of OP10',
    );
    // Another number, operation or order is another confirmation; status messages carry none.
    store.insert('confirmation', 'k2', 'A', { n: 3 }, t1, { operation: 'OP10', confirmation: 2 });
    store.insert('confirmation', 'k3', 'A', { n: 4 }, t1, { operation: 'OP20', confirmation: 1 });
    store.insert('confirmation', 'k4', 'B', { n: 5 }, t1, op10);
    store.insert('status', 's1', 'A', { n: 6 }, t1);
    store.insert('status', 's2', 'A', { n: 7 }, t1);
    expect(store.hasConfirmation('A', op10)).toBe(true);
    expect(store.hasConfirmation('A', { operation: 'OP30', confirmation: 1 })).toBe(false);
    expect(store.counts()).toEqual({ confirmation: 4, status: 2, 'quality-notification': 0 });
  });

  it('keeps quality notifications by hold, one per transition number, keys unique across kinds', () => {
    const store = open(':memory:');
    const opened = { holdId: 'H1', transitionNo: 1 };
    const receipt = store.insertNotification('H1~opened~1', opened, { b: 1, a: 2 }, t0);
    expect(receipt).toEqual({
      idempotencyKey: 'H1~opened~1',
      kind: 'quality-notification',
      holdId: 'H1',
      receivedSeq: 1,
      receivedAt: t0.toISOString(),
    });
    expect(store.lookup('quality-notification', 'H1~opened~1', { a: 2, b: 1 })).toEqual({
      outcome: 'replayed',
      receipt,
    });
    // The key of a notification used for another kind: a conflict, never a second message.
    expect(store.lookup('status', 'H1~opened~1', { a: 2, b: 1 })?.outcome).toBe('conflict');
    expect(() => store.insertNotification('other-key', opened, {}, t1)).toThrow(
      DuplicateTransitionError,
    );
    expect(() =>
      store.insertNotification('H1~opened~1', { holdId: 'H2', transitionNo: 1 }, {}, t1),
    ).toThrow(/UNIQUE/);
    store.insert('status', 's1', 'A', { n: 1 }, t1);
    store.insertNotification('H2~opened~1', { holdId: 'H2', transitionNo: 1 }, { n: 2 }, t1);
    store.insertNotification('H1~released~2', { holdId: 'H1', transitionNo: 2 }, { n: 3 }, t1);
    expect(store.notifications().map((n) => n.receipt.idempotencyKey)).toEqual([
      'H1~opened~1',
      'H2~opened~1',
      'H1~released~2',
    ]);
    expect(store.notifications('H1').map((n) => [n.receipt.receivedSeq, n.body])).toEqual([
      [1, { a: 2, b: 1 }],
      [4, { n: 3 }],
    ]);
    expect(store.notifications('H9')).toEqual([]);
    // Notifications are not messages of an order.
    expect(store.messages('status').map((m) => m.receipt.idempotencyKey)).toEqual(['s1']);
    expect(store.counts()).toEqual({ confirmation: 0, status: 1, 'quality-notification': 3 });
  });

  it('upgrades a store of the first schema, keeping its messages', () => {
    const file = path();
    mkdirSync(join(file, '..'), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE message (
        received_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        order_number TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      INSERT INTO message (idempotency_key, kind, order_number, body, received_at)
        VALUES ('k1', 'status', 'A', '{}', '2026-10-16T08:00:00.000Z');
    `);
    old.close();
    const store = open(file);
    expect(store.messages('status').map((m) => m.receipt.idempotencyKey)).toEqual(['k1']);
    const op10 = { operation: 'OP10', confirmation: 1 };
    store.insert('confirmation', 'c1', 'A', {}, t0, op10);
    expect(() => store.insert('confirmation', 'c2', 'A', {}, t0, op10)).toThrow(
      DuplicateConfirmationError,
    );
    // The quality notification columns are added too.
    const h1 = { holdId: 'H1', transitionNo: 1 };
    store.insertNotification('H1~opened~1', h1, {}, t0);
    expect(() => store.insertNotification('n2', h1, {}, t0)).toThrow(DuplicateTransitionError);
    expect(store.notifications('H1')).toHaveLength(1);
  });

  it('keeps one store id for its life', () => {
    const file = path();
    const id = open(file).storeId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(open(file).storeId).toBe(id);
    expect(open(path()).storeId).not.toBe(id);
  });

  it('keeps messages and added orders across a restart, in the order received', () => {
    const file = path();
    const store = open(file);
    store.receive('confirmation', 'k1', 'A', { n: 1 }, t0);
    store.receive('status', 'k2', 'B', { n: 2 }, t0);
    store.receive('confirmation', 'k3', 'B', { n: 3 }, t1);
    const order = {
      orderNumber: 'C',
      revision: 1,
      product: 'VB-100',
      quantity: 1,
      priority: 5,
      status: 'open' as const,
      plannedStart: t0.toISOString(),
      dueDate: t1.toISOString(),
      routing: [],
      bom: [],
    };
    store.addAdminOrder({ feedSeq: 7, order }, t0);
    store.close();

    const reopened = open(file);
    expect(reopened.messages('confirmation').map((m) => m.receipt.idempotencyKey)).toEqual([
      'k1',
      'k3',
    ]);
    expect(reopened.messages('confirmation', 'B')).toEqual([
      {
        receipt: {
          idempotencyKey: 'k3',
          kind: 'confirmation',
          orderNumber: 'B',
          receivedSeq: 3,
          receivedAt: t1.toISOString(),
        },
        body: { n: 3 },
      },
    ]);
    expect(reopened.receive('confirmation', 'k1', 'A', { n: 1 }, t1).outcome).toBe('replayed');
    expect(reopened.receive('confirmation', 'k4', 'A', { n: 4 }, t1).receipt.receivedSeq).toBe(4);
    expect(reopened.adminOrders()).toEqual([{ feedSeq: 7, order }]);
    expect(() => {
      reopened.insert('status', 'k2', 'B', { n: 2 }, t1);
    }).toThrow();
    reopened.close();
    reopened.close(); // closing twice is harmless
  });
});
