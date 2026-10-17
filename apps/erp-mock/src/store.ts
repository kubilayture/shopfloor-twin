import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  FeedEntry,
  MessageKind,
  MessageReceipt,
  OrderMessageKind,
  OrderMessageReceipt,
  QualityNotificationReceipt,
} from '@shopfloor/contracts/erp-api';

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

/** A quality notification's identity: at most one stored notification per (hold, transition number). */
export interface HoldTransitionIdentity {
  readonly holdId: string;
  readonly transitionNo: number;
}

/** A confirmation's identity: at most one stored message per (order, operation, number). */
export interface ConfirmationIdentity {
  readonly operation: string;
  readonly confirmation: number;
}

/** The store refused a second confirmation with the same order, operation and number. */
export class DuplicateConfirmationError extends Error {
  constructor(orderNumber: string, identity: ConfirmationIdentity) {
    super(
      `order ${orderNumber} already has confirmation ${String(identity.confirmation)} of ${identity.operation}`,
    );
    this.name = 'DuplicateConfirmationError';
  }
}

/** The store refused a second notification with the same hold and transition number. */
export class DuplicateTransitionError extends Error {
  constructor(identity: HoldTransitionIdentity) {
    super(
      `hold ${identity.holdId} already has a notification of transition ${String(identity.transitionNo)}`,
    );
    this.name = 'DuplicateTransitionError';
  }
}

const isUniqueViolation = (error: unknown, column: string): boolean =>
  error instanceof Error && error.message.includes(`UNIQUE constraint failed: message.${column}`);

export interface StoredMessage<R extends MessageReceipt = MessageReceipt> {
  readonly receipt: R;
  readonly body: unknown;
}

interface MessageRow {
  readonly received_seq: number;
  readonly idempotency_key: string;
  readonly kind: string;
  readonly order_number: string;
  readonly hold_id: string | null;
  readonly body: string;
  readonly received_at: string;
}

const receiptOf = (row: MessageRow): MessageReceipt =>
  row.kind === 'quality-notification'
    ? {
        idempotencyKey: row.idempotency_key,
        kind: 'quality-notification',
        holdId: row.hold_id ?? '',
        receivedSeq: row.received_seq,
        receivedAt: row.received_at,
      }
    : {
        idempotencyKey: row.idempotency_key,
        kind: row.kind as OrderMessageKind,
        orderNumber: row.order_number,
        receivedSeq: row.received_seq,
        receivedAt: row.received_at,
      };

/**
 * What the ERP mock keeps across restarts (ADR-0028, SQLite through `node:sqlite` as the gateway's
 * outbox, ADR-0014): every message the MES posted, keyed by its `Idempotency-Key` (one table for
 * every kind, so a key is unique across kinds; a quality notification has no order, its
 * `order_number` is empty and `hold_id` names its hold), and the orders added through the dev-only
 * `POST /orders`. Each write is one durable transaction; node:sqlite is
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
  readonly #confirmation: StatementSync;
  readonly #insertNotification: StatementSync;
  readonly #listHold: StatementSync;
  /** Created with the store and never changed: part of the feed's identity (`feedId`). */
  readonly storeId: string;
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
        received_at TEXT NOT NULL,
        operation TEXT,
        confirmation_no INTEGER
      );
      CREATE INDEX IF NOT EXISTS message_order ON message (order_number, received_seq);
      CREATE TABLE IF NOT EXISTS admin_order (
        feed_seq INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // A store from the first #171 commit has no confirmation identity columns yet.
    const columns = new Set(
      (db.prepare('PRAGMA table_info(message)').all() as unknown as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!columns.has('operation')) db.exec('ALTER TABLE message ADD COLUMN operation TEXT');
    if (!columns.has('confirmation_no')) {
      db.exec('ALTER TABLE message ADD COLUMN confirmation_no INTEGER');
    }
    // A store from before Phase 8 (#198) has no quality notification columns yet.
    if (!columns.has('hold_id')) db.exec('ALTER TABLE message ADD COLUMN hold_id TEXT');
    if (!columns.has('transition_no')) {
      db.exec('ALTER TABLE message ADD COLUMN transition_no INTEGER');
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS message_confirmation
        ON message (order_number, operation, confirmation_no) WHERE kind = 'confirmation';
      CREATE UNIQUE INDEX IF NOT EXISTS message_hold_transition
        ON message (hold_id, transition_no) WHERE kind = 'quality-notification';
      INSERT OR IGNORE INTO meta (key, value) VALUES ('store_id', '${randomUUID()}');
    `);
    const storeId = db.prepare("SELECT value FROM meta WHERE key = 'store_id'").get()?.value;
    if (typeof storeId !== 'string') throw new Error('the store has no store id');
    this.storeId = storeId;
    this.#db = db;
    this.#byKey = db.prepare('SELECT * FROM message WHERE idempotency_key = ?');
    this.#insert = db.prepare(
      'INSERT INTO message (idempotency_key, kind, order_number, body, received_at, operation, confirmation_no) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.#confirmation = db.prepare(
      "SELECT 1 AS found FROM message WHERE kind = 'confirmation' AND order_number = ? AND operation = ? AND confirmation_no = ?",
    );
    this.#list = db.prepare('SELECT * FROM message WHERE kind = ? ORDER BY received_seq');
    this.#listOrder = db.prepare(
      'SELECT * FROM message WHERE kind = ? AND order_number = ? ORDER BY received_seq',
    );
    this.#count = db.prepare('SELECT kind, count(*) AS n FROM message GROUP BY kind');
    this.#insertNotification = db.prepare(
      'INSERT INTO message (idempotency_key, kind, order_number, body, received_at, hold_id, transition_no) ' +
        "VALUES (?, 'quality-notification', '', ?, ?, ?, ?)",
    );
    this.#listHold = db.prepare(
      "SELECT * FROM message WHERE kind = 'quality-notification' AND hold_id = ? ORDER BY received_seq",
    );
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

  /**
   * Stores a message under a new key (one durable commit). A used key throws; a confirmation
   * (`identity` given) whose order, operation and number are stored already throws
   * `DuplicateConfirmationError`, whatever its key.
   */
  insert(
    kind: OrderMessageKind,
    key: string,
    orderNumber: string,
    body: unknown,
    now: Date,
    identity?: ConfirmationIdentity,
  ): OrderMessageReceipt {
    const receivedAt = now.toISOString();
    let result: ReturnType<StatementSync['run']>;
    try {
      result = this.#insert.run(
        key,
        kind,
        orderNumber,
        canonicalJson(body),
        receivedAt,
        identity?.operation ?? null,
        identity?.confirmation ?? null,
      );
    } catch (error) {
      if (identity !== undefined && isUniqueViolation(error, 'order_number')) {
        throw new DuplicateConfirmationError(orderNumber, identity);
      }
      throw error;
    }
    return {
      idempotencyKey: key,
      kind,
      orderNumber,
      receivedSeq: Number(result.lastInsertRowid),
      receivedAt,
    };
  }

  /**
   * Stores a quality notification under a new key (one durable commit). A used key throws; a
   * second notification with the same hold and transition number throws `DuplicateTransitionError`,
   * whatever its key.
   */
  insertNotification(
    key: string,
    identity: HoldTransitionIdentity,
    body: unknown,
    now: Date,
  ): QualityNotificationReceipt {
    const receivedAt = now.toISOString();
    let result: ReturnType<StatementSync['run']>;
    try {
      result = this.#insertNotification.run(
        key,
        canonicalJson(body),
        receivedAt,
        identity.holdId,
        identity.transitionNo,
      );
    } catch (error) {
      if (isUniqueViolation(error, 'hold_id')) throw new DuplicateTransitionError(identity);
      throw error;
    }
    return {
      idempotencyKey: key,
      kind: 'quality-notification',
      holdId: identity.holdId,
      receivedSeq: Number(result.lastInsertRowid),
      receivedAt,
    };
  }

  /** `lookup`, and `insert` for a new key: `created`, `replayed` or `conflict`. */
  receive(
    kind: OrderMessageKind,
    key: string,
    orderNumber: string,
    body: unknown,
    now: Date,
    identity?: ConfirmationIdentity,
  ): ReceiveResult {
    return (
      this.lookup(kind, key, body) ?? {
        outcome: 'created',
        receipt: this.insert(kind, key, orderNumber, body, now, identity),
      }
    );
  }

  /** Whether a confirmation with this order, operation and number is stored. */
  hasConfirmation(orderNumber: string, identity: ConfirmationIdentity): boolean {
    return (
      this.#confirmation.get(orderNumber, identity.operation, identity.confirmation) !== undefined
    );
  }

  /** Messages of one kind in the order received, optionally of one order only. */
  messages(kind: OrderMessageKind, orderNumber?: string): StoredMessage<OrderMessageReceipt>[] {
    const rows = (orderNumber === undefined
      ? this.#list.all(kind)
      : this.#listOrder.all(kind, orderNumber)) as unknown as MessageRow[];
    return rows.map((row) => ({
      receipt: receiptOf(row) as OrderMessageReceipt,
      body: JSON.parse(row.body) as unknown,
    }));
  }

  /** Quality notifications in the order received, optionally of one hold only. */
  notifications(holdId?: string): StoredMessage<QualityNotificationReceipt>[] {
    const rows = (holdId === undefined
      ? this.#list.all('quality-notification')
      : this.#listHold.all(holdId)) as unknown as MessageRow[];
    return rows.map((row) => ({
      receipt: receiptOf(row) as QualityNotificationReceipt,
      body: JSON.parse(row.body) as unknown,
    }));
  }

  /** Messages stored per kind. */
  counts(): Record<MessageKind, number> {
    const counts: Record<MessageKind, number> = {
      confirmation: 0,
      status: 0,
      'quality-notification': 0,
    };
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
