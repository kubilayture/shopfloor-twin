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
  /** Test seam: runs inside each fact's transaction, just before the commit. */
  readonly beforeCommit?: (topic: string) => Promise<void>;
}

export type IngestOutcome = 'stored' | 'duplicate' | 'rejected' | 'anchor' | 'status' | 'retained';

const RETRY_MAX_MS = 10_000;
const STOP_WAIT_MS = 2_000;

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
  #client: MqttClient | undefined;
  #subscribed = false;
  #stopping = false;
  #queue: Promise<unknown> = Promise.resolve();
  #sweepTimer: NodeJS.Timeout | undefined;
  #wake: (() => void) | undefined;

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
        help: 'Failed attempts to store a delivery (it is retried, never acknowledged unstored)',
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
      this.#enqueue(() => this.#handle(packet)).then(
        () => {
          callback();
        },
        () => {
          // Stopping: leave it unacknowledged; the broker delivers it again to the next session.
        },
      );
    };
    client.on('connect', () => {
      this.#subscribe(client).catch((error: unknown) => {
        this.#log.error({ err: error }, 'UNS subscription failed');
      });
    });
    client.on('close', () => {
      this.#subscribed = false;
    });
    client.on('error', (error) => {
      this.#log.warn({ err: error.message }, 'MQTT error');
    });
    client.connect();
    if (options.sweepIntervalMs !== 0) {
      this.#sweepTimer = setInterval(() => {
        this.sweep().catch((error: unknown) => {
          this.#log.error({ err: error }, 'gap sweep failed');
        });
      }, options.sweepIntervalMs ?? 1_000);
      this.#sweepTimer.unref();
    }
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

  /** Stores one delivery, retrying until it is stored (or the module stops). */
  async #handle(packet: IPublishPacket): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (this.#isStopping()) throw new Error('stopping');
      try {
        const notices = await this.#process(packet);
        for (const notice of notices) await this.#notify(notice);
        return;
      } catch (error) {
        if (this.#isStopping()) throw error;
        this.#errors?.inc();
        this.#log.error(
          { err: error, topic: packet.topic, attempt },
          'storing a UNS message failed',
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(250 * 2 ** attempt, RETRY_MAX_MS));
          this.#wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }

  async #process(packet: IPublishPacket): Promise<readonly IngestNotice[]> {
    const { topic } = packet;
    const retained = packet.retain;
    const text =
      typeof packet.payload === 'string' ? packet.payload : packet.payload.toString('utf8');
    // PostgreSQL text and jsonb can't hold NUL characters: such a message could never be stored.
    const item =
      text.includes('\u0000') || text.includes('\\u0000')
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
