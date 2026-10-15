import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { CursorStore } from '../modbus/poller.ts';
import type { Publisher, UnsPublication } from '../publisher.ts';

/** The broker side of the outbox: in practice the gateway's `MqttLink`. */
export interface Transport extends Publisher {
  readonly connected: boolean;
  onConnect(listener: () => void): void;
}

export interface OutboxOptions {
  /** SQLite file; created with its folder if missing. */
  readonly path: string;
  readonly transport: Transport;
  /** Messages kept at most; beyond it the oldest are dropped and reported. */
  readonly maxMessages?: number;
  /** Messages arriving within this window share one durable commit (ADR-0014). */
  readonly flushMs?: number;
  /** A commit happens at the latest when this many messages wait. */
  readonly batchSize?: number;
  /** Messages handed to the broker and not yet acknowledged. */
  readonly inflight?: number;
  /** Pause after a transient send error while connected. */
  readonly retryMs?: number;
  readonly checkpointMs?: number;
  /** Messages removed without delivery: on overflow, or refused by the broker for good. */
  readonly onDrop?: (count: number, reason: 'overflow' | 'refused', detail: string) => void;
  readonly onError?: (error: unknown) => void;
}

interface Waiting {
  readonly publication: UnsPublication;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface Row {
  readonly id: number;
  readonly topic: string;
  readonly payload: string;
  readonly retain: number;
}

/**
 * MQTT 5 PUBACK reason codes that will never succeed for this message: not authorized, topic name
 * invalid, packet too large, payload format invalid. Others (server busy 0x89, rate 0x96, quota
 * 0x97, unspecified 0x80) are retried.
 */
const PERMANENT_REFUSALS = new Set([0x87, 0x90, 0x95, 0x99]);

const isRefusal = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'number' &&
  PERMANENT_REFUSALS.has(error.code);

/**
 * Store-and-forward (plan section 5, ADR-0014): every UNS message is committed to a SQLite outbox
 * first, then sent in insertion order while the broker is reachable, and deleted after its PUBACK.
 * After a broker outage or a gateway restart the rest is sent in the same order. A crash between
 * PUBACK and delete re-sends one message, which the consumers' dedup removes (ADR-0015).
 *
 * The outbox also keeps the Modbus poller's cursor, written in the same transaction as the
 * messages it produced, so a restart neither repeats nor skips washer facts.
 */
export class Outbox implements Publisher, CursorStore {
  readonly #options: OutboxOptions;
  readonly #db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #next: StatementSync;
  readonly #delete: StatementSync;
  readonly #trim: StatementSync;
  readonly #saveCursor: StatementSync;
  readonly #cursors = new Map<string, { epoch: number; seq: number }>();
  readonly #dirtyCursors = new Set<string>();
  #waiting: Waiting[] = [];
  readonly #acked = new Set<number>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #checkpointTimer: ReturnType<typeof setInterval> | undefined;
  /** Highest id handed to the transport; rows above it are still to be sent. */
  #sentUpTo = 0;
  readonly #inFlight = new Set<number>();
  #pausedUntilRetry = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #stopping = false;
  readonly #committedCursors = new Map<string, { epoch: number; seq: number }>();
  #depth: number;
  #dropped = 0;
  #delivered = 0;
  #closed = false;

  constructor(options: OutboxOptions) {
    this.#options = options;
    mkdirSync(dirname(options.path), { recursive: true });
    const db = new DatabaseSync(options.path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA fullfsync = ON;
      PRAGMA checkpoint_fullfsync = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        retain INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (
        machine TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
    `);
    this.#db = db;
    this.#insert = db.prepare('INSERT INTO outbox (topic, payload, retain) VALUES (?, ?, ?)');
    this.#next = db.prepare(
      'SELECT id, topic, payload, retain FROM outbox WHERE id > ? ORDER BY id LIMIT ?',
    );
    this.#delete = db.prepare('DELETE FROM outbox WHERE id = ?');
    this.#trim = db.prepare(
      'DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE id > ? ORDER BY id LIMIT ?)',
    );
    this.#saveCursor = db.prepare(
      'INSERT INTO cursors (machine, epoch, seq) VALUES (?, ?, ?) ' +
        'ON CONFLICT (machine) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq',
    );
    for (const row of db.prepare('SELECT machine, epoch, seq FROM cursors').all()) {
      const cursor = { epoch: Number(row.epoch), seq: Number(row.seq) };
      this.#cursors.set(String(row.machine), cursor);
      this.#committedCursors.set(String(row.machine), { ...cursor });
    }
    this.#depth = Number(db.prepare('SELECT count(*) AS n FROM outbox').get()?.n ?? 0);
    this.#checkpointTimer = setInterval(() => {
      this.#run(() => {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      });
    }, options.checkpointMs ?? 60_000);
    this.#checkpointTimer.unref();
    options.transport.onConnect(() => {
      // Messages in flight when the connection dropped are re-sent by MQTT.js itself; those
      // refused while disconnected rewound #sentUpTo. Continue from there.
      this.#drain();
    });
  }

  /** Messages stored and not yet acknowledged by the broker. */
  get depth(): number {
    return this.#depth + this.#waiting.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  /** Messages acknowledged by the broker. */
  get delivered(): number {
    return this.#delivered;
  }

  /** Resolves once the message is durably stored; delivery follows whenever the broker is up. */
  publish(publication: UnsPublication): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('outbox closed'));
    }
    return new Promise<void>((resolve, reject) => {
      this.#waiting.push({ publication, resolve, reject });
      if (this.#waiting.length >= (this.#options.batchSize ?? 100)) {
        this.#flush();
      } else {
        this.#flushTimer ??= setTimeout(() => {
          this.#flush();
        }, this.#options.flushMs ?? 20);
      }
    });
  }

  get(machineId: string): { readonly epoch: number; readonly seq: number } | undefined {
    return this.#cursors.get(machineId);
  }

  /** Kept in memory and written with the next commit, together with the messages it produced. */
  set(machineId: string, cursor: { readonly epoch: number; readonly seq: number }): void {
    this.#cursors.set(machineId, { ...cursor });
    this.#dirtyCursors.add(machineId);
  }

  /**
   * Stops sending, commits what waits, waits briefly for the acknowledgement of what is in flight,
   * and closes the file. Unsent messages stay for the next start.
   */
  async close(graceMs = 2_000): Promise<void> {
    if (this.#closed || this.#stopping) return;
    this.#stopping = true;
    clearTimeout(this.#retryTimer);
    this.#flush();
    for (const deadline = Date.now() + graceMs; this.#inFlight.size > 0 && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.#flush();
    this.#closed = true;
    clearTimeout(this.#flushTimer);
    clearInterval(this.#checkpointTimer);
    this.#db.close();
  }

  /** One durable transaction per tick: the waiting messages, acknowledged deletes, dirty cursors. */
  #flush(): void {
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    if (this.#closed) return;
    const waiting = this.#waiting;
    this.#waiting = [];
    try {
      this.#db.exec('BEGIN');
      for (const { publication } of waiting) {
        this.#insert.run(
          publication.topic,
          JSON.stringify(publication.message),
          publication.retain ? 1 : 0,
        );
      }
      for (const id of this.#acked) this.#delete.run(id);
      for (const machine of this.#dirtyCursors) {
        const cursor = this.#cursors.get(machine);
        if (cursor) this.#saveCursor.run(machine, cursor.epoch, cursor.seq);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#run(() => {
        this.#db.exec('ROLLBACK');
      });
      for (const w of waiting) w.reject(error);
      // The messages are lost; a cursor saved later must not claim they were handled.
      for (const machine of this.#dirtyCursors) {
        const committed = this.#committedCursors.get(machine);
        if (committed) this.#cursors.set(machine, { ...committed });
        else this.#cursors.delete(machine);
      }
      this.#dirtyCursors.clear();
      this.#options.onError?.(error);
      this.#scheduleFlush(); // acknowledged deletes are still pending
      return;
    }
    for (const machine of this.#dirtyCursors) {
      const cursor = this.#cursors.get(machine);
      if (cursor) this.#committedCursors.set(machine, { ...cursor });
    }
    this.#depth += waiting.length - this.#acked.size;
    this.#acked.clear();
    this.#dirtyCursors.clear();
    for (const w of waiting) w.resolve();
    this.#enforceBound();
    this.#drain();
  }

  #enforceBound(): void {
    const max = this.#options.maxMessages ?? 200_000;
    const excess = this.#depth - max;
    if (excess <= 0) return;
    // Only rows not yet handed to the broker: those in flight will be delivered anyway.
    const removed = Number(this.#trim.run(this.#sentUpTo, excess).changes);
    if (removed === 0) return;
    this.#depth -= removed;
    this.#dropped += removed;
    this.#options.onDrop?.(
      removed,
      'overflow',
      `outbox full (${String(max)} messages): oldest unsent dropped`,
    );
  }

  /** Sends stored messages in id order, keeping at most `inflight` unacknowledged. */
  #drain(): void {
    const transport = this.#options.transport;
    const limit = this.#options.inflight ?? 100;
    if (this.#stopping || this.#pausedUntilRetry || !transport.connected) return;
    while (this.#inFlight.size < limit) {
      const rows = this.#next.all(this.#sentUpTo, limit - this.#inFlight.size) as unknown as Row[];
      if (rows.length === 0) return;
      for (const row of rows) {
        this.#sentUpTo = row.id;
        // After a rewind, rows already acknowledged or still with the broker are not sent again.
        if (this.#acked.has(row.id) || this.#inFlight.has(row.id)) continue;
        this.#send(transport, row);
      }
    }
  }

  #send(transport: Transport, row: Row): void {
    this.#inFlight.add(row.id);
    transport
      .publish({
        topic: row.topic,
        message: JSON.parse(row.payload) as UnsPublication['message'],
        retain: row.retain === 1,
      })
      .then(
        () => {
          if (!this.#acked.has(row.id)) this.#delivered++;
          this.#acked.add(row.id);
        },
        (error: unknown) => {
          if (isRefusal(error)) {
            this.#acked.add(row.id); // never deliverable: retrying would block everything behind it
            this.#dropped++;
            this.#options.onDrop?.(1, 'refused', `${row.topic}: ${String(error)}`);
            return;
          }
          // Not sent: continue from here, after a pause. While disconnected, the reconnect resumes
          // sending; while connected (a transient error) a back-off timer does, so a persistent
          // error can't spin.
          this.#sentUpTo = Math.min(this.#sentUpTo, row.id - 1);
          if (transport.connected && !this.#pausedUntilRetry) {
            this.#pausedUntilRetry = true;
            this.#retryTimer = setTimeout(() => {
              this.#pausedUntilRetry = false;
              this.#drain();
            }, this.#options.retryMs ?? 1_000);
          }
        },
      )
      .finally(() => {
        this.#inFlight.delete(row.id);
        this.#scheduleFlush();
        this.#drain();
      });
  }

  #scheduleFlush(): void {
    if (this.#closed) return;
    if (this.#acked.size >= (this.#options.batchSize ?? 100)) {
      this.#flush();
    } else {
      this.#flushTimer ??= setTimeout(() => {
        this.#flush();
      }, this.#options.flushMs ?? 20);
    }
  }

  #run(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.#options.onError?.(error);
    }
  }
}
