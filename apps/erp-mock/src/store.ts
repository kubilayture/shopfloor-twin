import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { FeedEntry, MessageKind, MessageReceipt } from '@shopfloor/contracts/erp-api';

/** JSON with object keys sorted at every level: two bodies are the same when these strings are. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

export interface ReceiveResult {
  readonly outcome: 'created' | 'replayed' | 'conflict';
  readonly receipt: MessageReceipt;
}

export interface StoredMessage {
  readonly receipt: MessageReceipt;
  readonly body: unknown;
}

interface MessageRow {
  readonly received_seq: number;
  readonly idempotency_key: string;
  readonly kind: string;
  readonly order_number: string;
  readonly body: string;
  readonly received_at: string;
}

const receiptOf = (row: MessageRow): MessageReceipt => ({
  idempotencyKey: row.idempotency_key,
  kind: row.kind as MessageKind,
  orderNumber: row.order_number,
  receivedSeq: row.received_seq,
  receivedAt: row.received_at,
});

/**
 * What the ERP mock keeps across restarts (ADR-0028, SQLite through `node:sqlite` as the gateway's
 * outbox, ADR-0014): every message the MES posted, keyed by its `Idempotency-Key`, and the orders
 * added through the dev-only `POST /orders`. Each write is one durable transaction; node:sqlite is
 * synchronous, so a lookup and the insert that follows it can't interleave with another request.
 */
export class ErpStore {
  readonly #db: DatabaseSync;
  readonly #byKey: StatementSync;
  readonly #insert: StatementSync;
  readonly #list: StatementSync;
  readonly #listOrder: StatementSync;
  readonly #count: StatementSync;
  readonly #insertOrder: StatementSync;
  #closed = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA fullfsync = ON;
      PRAGMA checkpoint_fullfsync = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS message (
        received_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        order_number TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_order ON message (order_number, received_seq);
      CREATE TABLE IF NOT EXISTS admin_order (
        feed_seq INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.#db = db;
    this.#byKey = db.prepare('SELECT * FROM message WHERE idempotency_key = ?');
    this.#insert = db.prepare(
      'INSERT INTO message (idempotency_key, kind, order_number, body, received_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.#list = db.prepare('SELECT * FROM message WHERE kind = ? ORDER BY received_seq');
    this.#listOrder = db.prepare(
      'SELECT * FROM message WHERE kind = ? AND order_number = ? ORDER BY received_seq',
    );
    this.#count = db.prepare('SELECT kind, count(*) AS n FROM message GROUP BY kind');
    this.#insertOrder = db.prepare(
      'INSERT INTO admin_order (feed_seq, body, created_at) VALUES (?, ?, ?)',
    );
  }

  /**
   * A message key seen before: `replayed` with the stored receipt when it came with the same kind
   * and body, `conflict` (with the stored receipt) when with another body or kind. Bodies are
   * compared as canonical JSON. Undefined for a new key.
   */
  lookup(kind: MessageKind, key: string, body: unknown): ReceiveResult | undefined {
    const existing = this.#byKey.get(key) as MessageRow | undefined;
    if (existing === undefined) return undefined;
    const same = existing.kind === kind && existing.body === canonicalJson(body);
    return { outcome: same ? 'replayed' : 'conflict', receipt: receiptOf(existing) };
  }

  /** Stores a message under a new key (one durable commit); a used key throws. */
  insert(
    kind: MessageKind,
    key: string,
    orderNumber: string,
    body: unknown,
    now: Date,
  ): MessageReceipt {
    const receivedAt = now.toISOString();
    const result = this.#insert.run(key, kind, orderNumber, canonicalJson(body), receivedAt);
    return {
      idempotencyKey: key,
      kind,
      orderNumber,
      receivedSeq: Number(result.lastInsertRowid),
      receivedAt,
    };
  }

  /** `lookup`, and `insert` for a new key: `created`, `replayed` or `conflict`. */
  receive(
    kind: MessageKind,
    key: string,
    orderNumber: string,
    body: unknown,
    now: Date,
  ): ReceiveResult {
    return (
      this.lookup(kind, key, body) ?? {
        outcome: 'created',
        receipt: this.insert(kind, key, orderNumber, body, now),
      }
    );
  }

  /** Messages of one kind in the order received, optionally of one order only. */
  messages(kind: MessageKind, orderNumber?: string): StoredMessage[] {
    const rows = (orderNumber === undefined
      ? this.#list.all(kind)
      : this.#listOrder.all(kind, orderNumber)) as unknown as MessageRow[];
    return rows.map((row) => ({ receipt: receiptOf(row), body: JSON.parse(row.body) as unknown }));
  }

  /** Messages stored per kind. */
  counts(): Record<MessageKind, number> {
    const counts: Record<MessageKind, number> = { confirmation: 0, status: 0 };
    for (const row of this.#count.all() as unknown as { kind: MessageKind; n: number }[]) {
      counts[row.kind] = row.n;
    }
    return counts;
  }

  /** Orders added through `POST /orders`, in feed order. */
  adminOrders(): FeedEntry[] {
    return (
      this.#db
        .prepare('SELECT feed_seq, body FROM admin_order ORDER BY feed_seq')
        .all() as unknown as {
        feed_seq: number;
        body: string;
      }[]
    ).map((row) => ({
      feedSeq: row.feed_seq,
      order: JSON.parse(row.body) as FeedEntry['order'],
    }));
  }

  addAdminOrder(entry: FeedEntry, now: Date): void {
    this.#insertOrder.run(entry.feedSeq, canonicalJson(entry.order), now.toISOString());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
