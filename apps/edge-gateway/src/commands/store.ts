import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { CommandResultValue } from '@shopfloor/contracts';

/** One command delivery, recorded before its PUBACK (#173, ADR-0029). */
export interface InboxEntry {
  readonly id: number;
  readonly equipment: string;
  readonly topic: string;
  readonly payload: string;
  /** Gateway wall time of the recording. */
  readonly receivedAt: number;
}

/** A definitive answer kept for resends, with the job it was given for. */
export interface StoredResult {
  /** `jobKey` of the command the device answered. */
  readonly job: string;
  readonly value: CommandResultValue;
}

/** The key of the results that hold for a command id whatever its `expiresAt`. */
const ANY_EXPIRY = '';

/**
 * The gateway's command records, in the same SQLite file as the outbox (ADR-0014), on a
 * connection of their own:
 *
 * - `command_inbox`: every delivery, committed before the PUBACK, deleted once its answer is in
 *   the outbox. What is left after a crash is processed again at start-up.
 * - `command_result`: definitive answers only. `accepted`, `duplicate` and `rejected` are kept by
 *   command id; `expired` by command id and `expiresAt`, so a resend with a new `expiresAt` is
 *   called again. `unknown` is never stored: it is settled again.
 */
export class CommandStore {
  readonly #db: DatabaseSync;
  readonly #record: StatementSync;
  readonly #pending: StatementSync;
  readonly #done: StatementSync;
  readonly #save: StatementSync;
  readonly #find: StatementSync;
  #closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA fullfsync = ON;
      PRAGMA checkpoint_fullfsync = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS command_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment TEXT NOT NULL,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_result (
        command_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        job TEXT NOT NULL,
        value TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        PRIMARY KEY (command_id, expires_at)
      );
    `);
    this.#db = db;
    this.#record = db.prepare(
      'INSERT INTO command_inbox (equipment, topic, payload, received_at) VALUES (?, ?, ?, ?)',
    );
    this.#pending = db.prepare(
      'SELECT id, equipment, topic, payload, received_at FROM command_inbox ORDER BY id',
    );
    this.#done = db.prepare('DELETE FROM command_inbox WHERE id = ?');
    this.#save = db.prepare(
      'INSERT OR IGNORE INTO command_result (command_id, expires_at, job, value, stored_at) ' +
        'VALUES (?, ?, ?, ?, ?)',
    );
    this.#find = db.prepare(
      'SELECT job, value FROM command_result WHERE command_id = ? AND expires_at = ?',
    );
  }

  /** Commits one delivery (synchronously, durably); throws if it can't, and then nothing is kept. */
  record(equipment: string, topic: string, payload: string, now = Date.now()): InboxEntry {
    const result = this.#record.run(equipment, topic, payload, now);
    return { id: Number(result.lastInsertRowid), equipment, topic, payload, receivedAt: now };
  }

  /** Deliveries not answered yet, in arrival order. */
  pending(): InboxEntry[] {
    return this.#pending.all().map((row) => ({
      id: Number(row.id),
      equipment: String(row.equipment),
      topic: String(row.topic),
      payload: String(row.payload),
      receivedAt: Number(row.received_at),
    }));
  }

  /** The delivery's answer is in the outbox. */
  done(id: number): void {
    this.#done.run(id);
  }

  /** Keeps a definitive answer; the first one for a key wins. `unknown` is refused. */
  saveResult(job: string, value: CommandResultValue, now = Date.now()): void {
    if (value.result === 'unknown') throw new Error('an unknown outcome is never stored');
    const key = value.result === 'expired' ? value.expiresAt : ANY_EXPIRY;
    this.#save.run(value.commandId, key, job, JSON.stringify(value), now);
  }

  /** The answer kept for a command id (`accepted`, `duplicate`, `rejected`). */
  result(commandId: string): StoredResult | undefined {
    return this.#lookup(commandId, ANY_EXPIRY);
  }

  /** The device's `expired` for exactly this `expiresAt`. */
  expired(commandId: string, expiresAt: string): StoredResult | undefined {
    return this.#lookup(commandId, expiresAt);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #lookup(commandId: string, key: string): StoredResult | undefined {
    const row = this.#find.get(commandId, key);
    if (!row) return undefined;
    return { job: String(row.job), value: JSON.parse(String(row.value)) as CommandResultValue };
  }
}
