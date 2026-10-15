import { SYS_SEGMENT, UNS_ROOT, type MachineState } from '@shopfloor/contracts';
import type { Kysely } from 'kysely';
import mqtt, { type IClientOptions, type IPublishPacket, type MqttClient } from 'mqtt';
import { Counter, Gauge, type Registry } from 'prom-client';
import type { Database } from '../../db/database.ts';
import { classify } from './classify.ts';
import {
  IngestStore,
  toAnchor,
  type IngestNotice,
  type StateAnchor,
  type StateFact,
} from './store.ts';

/** QoS 1 subscriptions of the MES: every machine topic it ingests, and the gateways' `_sys`. */
export const INGEST_TOPICS = [
  `${UNS_ROOT}/+/+/+/state/+`,
  `${UNS_ROOT}/+/+/+/telemetry/+`,
  `${UNS_ROOT}/+/+/+/events/+`,
  `${UNS_ROOT}/+/+/+/alarms/+`,
  `${UNS_ROOT}/${SYS_SEGMENT}/edge-gateway/+/status`,
  `${UNS_ROOT}/${SYS_SEGMENT}/edge-gateway/+/incidents`,
] as const;

export interface IngestLog {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface IngestOptions {
  readonly db: Kysely<Database>;
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** The persistent session's client id (default `mes-server`). */
  readonly clientId?: string;
  /** MQTT 5 session expiry: how long the broker keeps queuing while the MES is away. */
  readonly sessionExpirySeconds?: number;
  /** How long a sequence hole may stay open before it becomes an incident (wall time). */
  readonly gapGraceMs?: number;
  /** How often holes are checked; 0 turns the timer off (tests call `sweep()`). */
  readonly sweepIntervalMs?: number;
  readonly reconnectPeriodMs?: number;
  /** Wall clock for incident times and the grace period (tests inject one). */
  readonly now?: () => number;
  readonly registry?: Registry;
  readonly log?: IngestLog;
  /**
   * Retries of a delivery after a transient database error (connection, shutdown, deadlock,
   * resources) before the session is dropped until the database answers again (ADR-0017).
   */
  readonly retry?: { readonly attempts?: number; readonly baseMs?: number };
  /** Test seam: runs inside each fact's transaction, just before the commit. */
  readonly beforeCommit?: (topic: string) => Promise<void>;
  /** Test seam: runs after a delivery is stored, just before its acknowledgement. */
  readonly beforeAck?: (topic: string) => Promise<void>;
}

/** How a failed attempt to store a delivery is handled. */
export type FailureKind = 'transient' | 'data' | 'unknown';

/** SQLSTATE classes that a retry can fix: connection (08), shutdown (57), rollback (40), resources (53, 58). */
const TRANSIENT_CLASSES = new Set(['08', '57', '40', '53', '58']);
/** Data exception (22), integrity violation (23), program limit (54): the same message fails again. */
const DATA_CLASSES = new Set(['22', '23', '54']);

export function failureKind(error: unknown): FailureKind {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (typeof code === 'string') {
    if (/^[0-9A-Z]{5}$/.test(code)) {
      const sqlClass = code.slice(0, 2);
      if (TRANSIENT_CLASSES.has(sqlClass)) return 'transient';
      if (DATA_CLASSES.has(sqlClass)) return 'data';
      return 'unknown';
    }
    if (code.startsWith('E')) return 'transient'; // ECONNREFUSED, ECONNRESET, ETIMEDOUT, …
  }
  if (
    error instanceof Error &&
    /connection terminated|connection timeout|timeout exceeded when trying to connect|connection error/i.test(
      error.message,
    )
  ) {
    return 'transient';
  }
  return 'unknown';
}

class Suspended extends Error {
  constructor() {
    super('session dropped until the database answers');
    this.name = 'Suspended';
  }
}

export type IngestOutcome = 'stored' | 'duplicate' | 'rejected' | 'anchor' | 'status' | 'retained';

const RETRY_MAX_MS = 10_000;
const STOP_WAIT_MS = 2_000;
/** An error of unknown kind is retried this often before the message counts as unstorable. */
const UNKNOWN_ATTEMPTS = 3;

const silent: IngestLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * The `ingest` module (#95): a persistent MQTT 5 session as user `mes`, every delivery validated
 * and stored idempotently, one at a time in arrival order. A QoS 1 message is acknowledged only
 * after its transaction committed, so a crash before the commit means redelivery, never loss.
 */
export class Ingest {
  readonly #options: IngestOptions;
  readonly #store: IngestStore;
  readonly #now: () => number;
  readonly #log: IngestLog;
  readonly #listeners = new Set<(notice: IngestNotice) => void | Promise<void>>();
  readonly #counts = new Map<IngestOutcome, number>();
  readonly #messages: Counter<'outcome'> | undefined;
  readonly #incidents: Counter<'origin'> | undefined;
  readonly #errors: Counter | undefined;
  readonly #suspensions: Counter | undefined;
  #client: MqttClient | undefined;
  #subscribed = false;
  #stopping = false;
  #queue: Promise<unknown> = Promise.resolve();
  #sweepTimer: NodeJS.Timeout | undefined;
  #wake: (() => void) | undefined;
  #suspended = false;

  constructor(options: IngestOptions) {
    this.#options = options;
    this.#store = new IngestStore(options.db, options.beforeCommit);
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? silent;
    const registers = options.registry ? [options.registry] : [];
    if (registers.length > 0) {
      this.#messages = new Counter({
        name: 'mes_ingest_messages_total',
        help: 'UNS deliveries by outcome: stored, duplicate, rejected, anchor, status, retained',
        labelNames: ['outcome'],
        registers,
      });
      this.#incidents = new Counter({
        name: 'mes_ingest_incidents_total',
        help: 'Data-quality incidents recorded: sequence gaps found by the MES, or gateway reports',
        labelNames: ['origin'],
        registers,
      });
      this.#errors = new Counter({
        name: 'mes_ingest_store_errors_total',
        help: 'Failed attempts to store a delivery (retried, or recorded as unstorable)',
        registers,
      });
      this.#suspensions = new Counter({
        name: 'mes_ingest_suspensions_total',
        help: 'Times the UNS session was dropped because the database stayed unreachable',
        registers,
      });
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- read by the collect callback
      const self = this;
      new Gauge({
        name: 'mes_ingest_subscribed',
        help: '1 while the persistent UNS session is connected and subscribed',
        registers,
        collect() {
          this.set(self.subscribed ? 1 : 0);
        },
      });
    }
  }

  /** Connected and every subscription granted with QoS 1: part of readiness. */
  get subscribed(): boolean {
    return this.#subscribed && this.#client?.connected === true;
  }

  /** Deliveries handled since start, by outcome. */
  count(outcome: IngestOutcome): number {
    return this.#counts.get(outcome) ?? 0;
  }

  /**
   * Listens for what each committed message adds: state facts, anchors (with their device epoch)
   * and other facts' times. Called after the commit and before the acknowledgement, one message
   * at a time; a listener's failure is logged and doesn't stop ingest. After a restart, catch up
   * from the queries (`stateFacts`, `anchor`) rather than relying on notices. Returns an unsubscribe.
   */
  onStored(listener: (notice: IngestNotice) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Loads the cursors and opens the persistent session. Readiness follows `subscribed`. */
  async start(): Promise<void> {
    await this.#store.load();
    const options = this.#options;
    this.#connect();
    if (options.sweepIntervalMs !== 0) {
      this.#sweepTimer = setInterval(() => {
        this.sweep().catch((error: unknown) => {
          this.#log.error({ err: error }, 'gap sweep failed');
        });
      }, options.sweepIntervalMs ?? 1_000);
      this.#sweepTimer.unref();
    }
  }

  #connect(): void {
    const options = this.#options;
    const clientOptions: IClientOptions = {
      clientId: options.clientId ?? 'mes-server',
      username: options.username,
      password: options.password,
      protocolVersion: 5,
      // Persistent session: the broker keeps the subscriptions and queues QoS 1 messages while
      // the MES is away, for the session expiry interval (without it, MQTT 5 ends the session
      // on disconnect).
      clean: false,
      properties: {
        sessionExpiryInterval: options.sessionExpirySeconds ?? 7 * 24 * 3600,
        // Unacknowledged deliveries in flight; they arrive again after a crash.
        receiveMaximum: 100,
      },
      // Subscriptions are renewed on every connect below, so the grant can be checked.
      resubscribe: false,
      reconnectPeriod: options.reconnectPeriodMs ?? 1_000,
      connectTimeout: 5_000,
      manualConnect: true,
    };
    const client = mqtt.connect(options.url, clientOptions);
    this.#client = client;
    // MQTT.js sends the PUBACK only once this callback runs, and handles the next packet only
    // after that: so storing here gives ack-after-commit and arrival order.
    client.handleMessage = (packet, callback) => {
      this.#enqueue(() => this.#handle(client, packet)).then(
        () => {
          callback();
        },
        () => {
          // Stopping or suspended: unacknowledged, so the broker delivers it again.
        },
      );
    };
    client.on('connect', () => {
      this.#subscribe(client).catch((error: unknown) => {
        this.#log.error({ err: error }, 'UNS subscription failed');
      });
    });
    client.on('close', () => {
      if (this.#client === client) this.#subscribed = false;
    });
    client.on('error', (error) => {
      this.#log.warn({ err: error.message }, 'MQTT error');
    });
    client.connect();
  }

  /**
   * The database stayed unreachable: while a delivery waits, MQTT.js processes no other packet,
   * not even PINGRESP, so the session would time out and reconnect over and over. Drop it
   * deliberately (nothing unstored acknowledged), wait until the database answers, reconnect.
   */
  #suspend(client: MqttClient): void {
    if (this.#suspended || this.#client !== client) return;
    this.#suspended = true;
    this.#subscribed = false;
    this.#suspensions?.inc();
    this.#log.error({}, 'database unreachable: UNS session dropped until it answers');
    const resume = async (): Promise<void> => {
      await client.endAsync(true);
      for (let attempt = 0; !this.#isStopping(); attempt++) {
        const ok = await this.#store.ping();
        if (ok) break;
        await this.#sleep(Math.min(250 * 2 ** attempt, RETRY_MAX_MS));
      }
      this.#suspended = false;
      if (this.#isStopping()) return;
      this.#log.info({}, 'database answers again: reconnecting to the UNS');
      this.#connect();
    };
    resume().catch((error: unknown) => {
      this.#log.error({ err: error }, 'resuming the UNS session failed');
    });
  }

  /** Resolves once subscribed (for tests and start-up ordering). */
  async waitSubscribed(timeoutMs = 30_000): Promise<void> {
    for (const deadline = Date.now() + timeoutMs; !this.subscribed;) {
      if (Date.now() > deadline) throw new Error('UNS subscription not granted in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * Records sequence holes older than the grace period as incidents. Runs in the message queue,
   * so it never interleaves with a message's transaction. Returns the incidents recorded.
   */
  async sweep(): Promise<number> {
    const recorded = await this.#enqueue(() =>
      this.#store.sweep(this.#now(), this.#options.gapGraceMs ?? 30_000),
    );
    if (recorded > 0) {
      this.#incidents?.inc({ origin: 'mes' }, recorded);
      this.#log.warn({ incidents: recorded }, 'sequence gaps recorded as incidents');
    }
    return recorded;
  }

  /**
   * Ends the session without acknowledging anything not yet stored. The session stays on the
   * broker, which queues messages until the next start.
   */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    clearInterval(this.#sweepTimer);
    this.#wake?.();
    await this.#client?.endAsync(true);
    this.#subscribed = false;
    await Promise.race([
      this.#queue.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref()),
    ]);
  }

  /** State changes of one equipment in one device epoch, by `seq` (optionally a window). */
  async stateFacts(
    equipment: string,
    epoch: number,
    window: { readonly fromSeq?: number; readonly toSeq?: number } = {},
  ): Promise<StateFact[]> {
    let query = this.#options.db
      .selectFrom('ingest.equipment_event')
      .select(['equipment', 'epoch', 'seq', 'source_time', 'state', 'cause', 'quality'])
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .where('event_type', '=', 'state');
    if (window.fromSeq !== undefined) query = query.where('seq', '>=', window.fromSeq);
    if (window.toSeq !== undefined) query = query.where('seq', '<=', window.toSeq);
    const rows = await query.orderBy('seq').execute();
    return rows.map((row) => ({
      equipment: row.equipment,
      epoch: row.epoch,
      seq: row.seq,
      sourceTime: row.source_time,
      state: row.state as MachineState,
      cause: row.cause,
      quality: row.quality,
    }));
  }

  /** Device epochs with stored facts for one equipment, oldest first by arrival. */
  async epochs(equipment: string): Promise<number[]> {
    const rows = await this.#options.db
      .selectFrom('ingest.equipment_event')
      .select('epoch')
      .where('equipment', '=', equipment)
      .groupBy('epoch')
      .orderBy((eb) => eb.fn.min('ingested_at'))
      .execute();
    return rows.map((row) => row.epoch);
  }

  /** The anchor of (equipment, device epoch): the first one to arrive wins. */
  async anchor(equipment: string, deviceEpoch: number): Promise<StateAnchor | undefined> {
    const row = await this.#options.db
      .selectFrom('ingest.state_anchor')
      .selectAll()
      .where('equipment', '=', equipment)
      .where('device_epoch', '=', deviceEpoch)
      .where('superseded', '=', false)
      .orderBy('arrival')
      .limit(1)
      .executeTakeFirst();
    return row && toAnchor(row);
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #subscribe(client: MqttClient): Promise<void> {
    const grants = await client.subscribeAsync(
      Object.fromEntries(INGEST_TOPICS.map((topic) => [topic, { qos: 1 as const }])),
    );
    const refused = grants.filter((grant) => grant.qos !== 1);
    if (refused.length > 0) {
      this.#log.error({ refused: refused.map((g) => g.topic) }, 'UNS subscription refused');
      return;
    }
    this.#subscribed = true;
    this.#log.info({ topics: INGEST_TOPICS.length }, 'subscribed to the UNS');
  }

  /**
   * Stores one delivery. A transient database error is retried a few times, then the session is
   * suspended (no acknowledgement). A data or integrity error, which no retry fixes, is recorded
   * in `rejected_message` as `unstorable` and acknowledged, so one message can't block the rest.
   */
  async #handle(client: MqttClient, packet: IPublishPacket): Promise<void> {
    const attempts = this.#options.retry?.attempts ?? 4;
    const baseMs = this.#options.retry?.baseMs ?? 250;
    for (let attempt = 0; ; attempt++) {
      // A delivery of a session that was dropped arrives again in the next one.
      if (this.#isStopping() || this.#client !== client || this.#suspended) throw new Suspended();
      try {
        const notices = await this.#process(packet);
        for (const notice of notices) await this.#notify(notice);
        await this.#options.beforeAck?.(packet.topic);
        return;
      } catch (error) {
        if (this.#isStopping()) throw error;
        this.#errors?.inc();
        const kind = failureKind(error);
        this.#log.error(
          { err: error, topic: packet.topic, attempt, kind },
          'storing a UNS message failed',
        );
        if (kind === 'data' || (kind === 'unknown' && attempt + 1 >= UNKNOWN_ATTEMPTS)) {
          if (await this.#unstorable(packet, error)) return;
        }
        if (kind === 'transient' && attempt + 1 >= attempts) {
          this.#suspend(client);
          throw new Suspended();
        }
        await this.#sleep(Math.min(baseMs * 2 ** attempt, RETRY_MAX_MS));
      }
    }
  }

  /** Records a delivery the database can't store; false if even that failed. */
  async #unstorable(packet: IPublishPacket, error: unknown): Promise<boolean> {
    const text =
      typeof packet.payload === 'string' ? packet.payload : packet.payload.toString('utf8');
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'none';
    const detail = `${error instanceof Error ? error.message : String(error)} (SQLSTATE ${code})`;
    for (const payload of [text, '(payload not storable either)']) {
      try {
        await this.#store.reject(packet.topic, payload, packet.retain, 'unstorable', detail);
        this.#counted('rejected');
        this.#log.warn(
          { topic: packet.topic, detail },
          'UNS message unstorable, recorded and acknowledged',
        );
        return true;
      } catch (recordError) {
        if (failureKind(recordError) === 'transient') return false;
      }
    }
    return false;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async #process(packet: IPublishPacket): Promise<readonly IngestNotice[]> {
    const { topic } = packet;
    const retained = packet.retain;
    const text =
      typeof packet.payload === 'string' ? packet.payload : packet.payload.toString('utf8');
    // A NUL in the raw text can't even be stored as the rejected payload.
    const item = text.includes('\u0000')
      ? ({
          kind: 'rejected',
          reason: 'invalid-payload',
          detail: 'contains NUL characters',
        } as const)
      : classify(topic, text, retained);
    switch (item.kind) {
      case 'rejected':
        await this.#store.reject(
          topic,
          text.replaceAll('\u0000', '\uFFFD'),
          retained,
          item.reason,
          item.detail,
        );
        this.#log.warn({ topic, reason: item.reason, detail: item.detail }, 'UNS message rejected');
        this.#counted('rejected');
        return [];
      case 'retained':
        this.#counted('retained');
        return [];
      case 'status':
        await this.#store.status(item.component, item.instance, item.message);
        this.#counted('status');
        return [];
      case 'anchor': {
        const anchor = await this.#store.anchor(item.equipment, item.message, retained);
        this.#counted('anchor');
        return anchor && anchor.deviceEpoch !== null ? [{ type: 'anchor', anchor }] : [];
      }
      case 'event':
      case 'telemetry':
      case 'incident': {
        const outcome = await this.#store.fact(item, topic, new Date(this.#now()));
        if (outcome.status === 'stale') {
          const current = this.#store.cursor(item.stream)?.epoch;
          await this.#store.reject(
            topic,
            text,
            retained,
            'stale-epoch',
            `epoch ${String(item.message.epoch)} is older than the stream's current epoch ${String(current)}`,
          );
          this.#log.warn(
            { topic, epoch: item.message.epoch, current },
            'stale UNS message refused',
          );
          this.#counted('rejected');
          return [];
        }
        if (outcome.status === 'duplicate') {
          this.#counted('duplicate');
          return [];
        }
        this.#counted('stored');
        if (item.kind === 'incident') {
          this.#incidents?.inc({ origin: 'gateway' });
          this.#log.warn({ incident: item.message.value }, 'gateway incident');
        }
        return outcome.notices;
      }
    }
  }

  /** A method, so that the check is repeated after every await. */
  #isStopping(): boolean {
    return this.#stopping;
  }

  #counted(outcome: IngestOutcome): void {
    this.#counts.set(outcome, this.count(outcome) + 1);
    this.#messages?.inc({ outcome });
  }

  async #notify(notice: IngestNotice): Promise<void> {
    for (const listener of this.#listeners) {
      try {
        await listener(notice);
      } catch (error) {
        this.#log.error({ err: error }, 'ingest listener failed');
      }
    }
  }
}
