import {
  SYS_SEGMENT,
  UNS_ROOT,
  type Alarm,
  type JobEvent,
  type MachineState,
} from '@shopfloor/contracts';
import { sql, type Kysely } from 'kysely';
import mqtt, { type IClientOptions, type IPublishPacket, type MqttClient } from 'mqtt';
import { Counter, Gauge, type Registry } from 'prom-client';
import {
  AggregateRefresher,
  type AggregateStatus,
  type RefreshOptions,
} from '../../db/aggregate-refresh.ts';
import type { Database } from '../../db/database.ts';
import { resolveAlarmBaseline, type AlarmPointState } from './alarm-baseline.ts';
import { settledThrough } from './ranges.ts';
import { classify } from './classify.ts';
import {
  IngestStore,
  toAlarmAnchor,
  toAlarmSnapshot,
  toAnchor,
  toCommandResult,
  toJobFact,
  type AlarmAnchor,
  type AlarmFact,
  type JobFact,
  type StoredCommandResult,
  type StoredAlarmSnapshot,
  type IngestNotice,
  type SettledState,
  type StateAnchor,
  type StateFact,
} from './store.ts';
import {
  telemetryMetrics,
  telemetrySeries,
  type TelemetryMetric,
  type TelemetrySeries,
} from './telemetry.ts';

/** QoS 1 subscriptions of the MES: every machine topic it ingests, and the gateways' `_sys`. */
export const INGEST_TOPICS = [
  `${UNS_ROOT}/+/+/+/state/+`,
  `${UNS_ROOT}/+/+/+/telemetry/+`,
  `${UNS_ROOT}/+/+/+/events/+`,
  `${UNS_ROOT}/+/+/+/alarms/+`,
  // The gateway's answers to the MES's commands (#174, UNS contract 1.3).
  `${UNS_ROOT}/+/+/+/cmd-res/+`,
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
  /** The pool for the API's telemetry reads; default `db` (see `EquipmentOptions.readDb`). */
  readonly readDb?: Kysely<Database>;
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
   * Retries of a delivery after any error other than a data error, before the session is dropped
   * until the database answers again (ADR-0017).
   */
  readonly retry?: {
    readonly attempts?: number;
    readonly baseMs?: number;
    /** First wait before reconnecting after a suspension; doubles while suspensions repeat. */
    readonly resumeMs?: number;
  };
  /**
   * Refresh `ingest.cycle_hourly` explicitly (ADR-0022): debounced, off the acknowledgement path,
   * on `refresh.db`. Without it the aggregate is never materialised: it reads the raw facts, and
   * no hour counts as refreshed.
   */
  readonly refresh?: RefreshOptions;
  /** Test seam: runs inside each fact's transaction, just before the commit. */
  readonly beforeCommit?: (topic: string) => Promise<void>;
  /** Test seam: runs after a delivery is stored, just before its acknowledgement. */
  readonly beforeAck?: (topic: string) => Promise<void>;
}

/**
 * How a failed attempt to store a delivery is handled. Only a data exception (22), an integrity
 * violation (23) or a program limit (54) means this message can never be stored. Anything else
 * (a lost connection, a lock timeout, a missing table during a deploy, a bug) may pass later, so
 * it is retried and never acknowledged: dropping a good fact is worse than waiting (ADR-0017).
 */
export type FailureKind = 'transient' | 'data';

const DATA_CLASSES = new Set(['22', '23', '54']);

export function failureKind(error: unknown): FailureKind {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' &&
    /^[0-9A-Z]{5}$/.test(code) &&
    DATA_CLASSES.has(code.slice(0, 2))
    ? 'data'
    : 'transient';
}

class Suspended extends Error {
  constructor() {
    super('session dropped until the database answers');
    this.name = 'Suspended';
  }
}

/** Completed cycles of one (equipment, epoch, UTC hour, product, result): `ingest.cycle_hourly`. */
export interface CycleHour {
  readonly equipment: string;
  readonly epoch: number;
  readonly hour: Date;
  readonly product: string;
  readonly result: 'good' | 'scrap' | 'rework';
  readonly count: number;
}

/** Completed cycles of one (equipment, epoch, UTC hour), all products and results. */
export interface CycleCount {
  readonly equipment: string;
  readonly epoch: number;
  readonly hour: Date;
  readonly count: number;
}

/** How far a device stream has arrived (`Ingest.deviceProgress`, #174). */
export interface DeviceProgress {
  readonly equipment: string;
  readonly epoch: number | null;
  readonly receivedThrough: number | null;
  /** The highest number seen in the epoch. */
  readonly lastSeq: number | null;
  /** The numbers seen in the epoch, as sorted ranges (a reported gap is not seen). */
  readonly seen: readonly (readonly [number, number])[];
  readonly settledSeq: number | null;
  readonly settledTime: Date | null;
}

/** Per (equipment, device epoch): what `factSummary` reports. */
export interface FactSummary {
  readonly equipment: string;
  readonly epoch: number;
  readonly stateFacts: number;
  readonly lastStateSeq: number | null;
  readonly latestSourceTime: Date;
}

/** Alarm facts of one (equipment, device epoch) (#141). */
export interface AlarmFactCount {
  readonly equipment: string;
  readonly epoch: number;
  readonly facts: number;
}

/**
 * What the anchors and the snapshot of an equipment's newest epoch say about its alarms (#141).
 * `points` lists the codes an anchor or the snapshot names. The snapshot says more: **every code it
 * doesn't name was inactive at its `asOfSeq`**, so an occurrence raised by a fact below `asOfSeq`
 * whose code is not listed active had its clear lost (`baselineState` answers per code).
 */
export interface AlarmBaseline {
  readonly equipment: string;
  readonly epoch: number;
  readonly points: readonly AlarmPointState[];
  /** The latest snapshot of the epoch, if any. */
  readonly snapshot: { readonly asOfSeq: number; readonly sourceTime: Date } | undefined;
}

/**
 * One code's state by the baseline (#141): its point when listed; otherwise inactive at the
 * snapshot's `asOfSeq` when there is a snapshot (it names every active code); otherwise unknown.
 */
export function baselineState(
  baseline: AlarmBaseline,
  code: string,
): Pick<AlarmPointState, 'active' | 'source' | 'seq' | 'sourceTime'> | undefined {
  const point = baseline.points.find((p) => p.code === code);
  if (point) return point;
  if (!baseline.snapshot) return undefined;
  return {
    active: false,
    source: 'snapshot',
    seq: baseline.snapshot.asOfSeq,
    sourceTime: baseline.snapshot.sourceTime,
  };
}

export type IngestOutcome = 'stored' | 'duplicate' | 'rejected' | 'anchor' | 'status' | 'retained';

const RETRY_MAX_MS = 10_000;
const STOP_WAIT_MS = 2_000;
const RESUME_MAX_MS = 60_000;

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
  readonly #history: Counter | undefined;
  #client: MqttClient | undefined;
  #subscribed = false;
  #stopping = false;
  #queue: Promise<unknown> = Promise.resolve();
  #sweepTimer: NodeJS.Timeout | undefined;
  #wake: (() => void) | undefined;
  #suspended = false;
  /** Suspensions since the last stored delivery: the wait before reconnecting grows with them. */
  #failedResumes = 0;
  #loaded = false;
  readonly #cycles: AggregateRefresher | undefined;

  constructor(options: IngestOptions) {
    this.#options = options;
    this.#store = new IngestStore(options.db, options.beforeCommit);
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? silent;
    this.#cycles =
      options.refresh &&
      new AggregateRefresher(
        'ingest.cycle_hourly',
        options.refresh.db ?? options.db,
        options.refresh.debounceMs,
        this.#log,
      );
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
      this.#history = new Counter({
        name: 'mes_ingest_history_written_off_total',
        help: 'Streams first seen above seq 1 whose lower numbers were written off as history after the gap grace period (not an incident)',
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
    this.#loaded = true;
    // The start-up catch-up refresh of `cycle_hourly` (if the equipment module's catch-up didn't
    // ask for it first); it runs beside the session, not before it.
    this.#cycles?.catchUp().catch(() => undefined);
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
    this.#log.error({}, 'storing keeps failing: UNS session dropped until the database answers');
    const resumeMs = this.#options.retry?.resumeMs ?? 1_000;
    const wait = Math.min(resumeMs * 2 ** this.#failedResumes, RESUME_MAX_MS);
    this.#failedResumes++;
    const resume = async (): Promise<void> => {
      await client.endAsync(true);
      // The cause may not be the connection (a lock, a deploy), so wait even if it answers.
      await this.#sleep(wait);
      for (let attempt = 0; !this.#isStopping(); attempt++) {
        // A commit that failed on the way back may have been applied: the cursors are reloaded
        // from the table (in the queue, never beside a sweep), so its redelivery is a duplicate.
        const ok =
          (await this.#store.ping()) &&
          (await this.#enqueue(() => this.#store.load()).then(
            () => true,
            () => false,
          ));
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
   * so it never interleaves with a message's transaction; listeners hear of each device stream
   * whose gaps were recorded (`gaps`, #113) in that queue too. Returns the incidents recorded.
   */
  async sweep(): Promise<number> {
    const recorded = await this.#enqueue(async () => {
      const result = await this.#store.sweep(this.#now(), this.#options.gapGraceMs ?? 30_000);
      for (const history of result.history) {
        this.#history?.inc();
        this.#log.warn(
          history,
          'numbers below a stream’s first one written off as history (no incident)',
        );
      }
      await this.#announce(result.notices);
      return result.recorded;
    });
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
    await this.#cycles?.stop();
  }

  /**
   * Completed cycles per (equipment, epoch, UTC hour, product, result) of the hours in [from, to),
   * from `ingest.cycle_hourly` (#118): materialised below the aggregate's watermark, raw above it.
   * An hour is current only where `cyclesRefreshed` says so, or above the watermark.
   */
  async cycleHourly(
    from: Date,
    to: Date,
    options: { readonly equipment?: string; readonly epoch?: number } = {},
  ): Promise<CycleHour[]> {
    let query = (this.#options.readDb ?? this.#options.db)
      .selectFrom('ingest.cycle_hourly')
      .selectAll()
      .where('hour', '>=', from)
      .where('hour', '<', to);
    if (options.equipment !== undefined) query = query.where('equipment', '=', options.equipment);
    if (options.epoch !== undefined) query = query.where('epoch', '=', options.epoch);
    const rows = await query
      .orderBy('equipment')
      .orderBy('epoch')
      .orderBy('hour')
      .orderBy('product')
      .orderBy('result')
      .execute();
    return rows.map((row) => ({
      equipment: row.equipment,
      epoch: row.epoch,
      hour: row.hour,
      product: row.product,
      result: row.result,
      count: row.cycles,
    }));
  }

  /**
   * Whether `cycle_hourly` holds the hour as it is now: a refresh covered it and no cycle changed it
   * since. With `Equipment.stateHourly`'s `final`, what makes an hour final for OEE (ADR-0022).
   */
  cyclesRefreshed(hour: Date): boolean {
    return this.#cycles?.isRefreshed(hour.getTime()) ?? false;
  }

  /** How far `cycle_hourly` is refreshed; undefined when this instance doesn't refresh it. */
  cycleAggregate(): AggregateStatus | undefined {
    return this.#cycles?.status();
  }

  /**
   * Buckets are final up to `end` (the equipment module's latest final hour + 1 h): `cycle_hourly`
   * is refreshed up to it, debounced. Never waits.
   */
  refreshCyclesThrough(end: Date): void {
    this.#cycles?.through(end.getTime());
  }

  /** Runs the pending refresh of `cycle_hourly` now and waits for it (tests, replays). */
  async refreshAggregates(): Promise<void> {
    await this.#cycles?.flush();
  }

  /**
   * Completed cycles per UTC hour of one (equipment, epoch) in [from, to), counted from the stored
   * facts (not the aggregate, which may lag a second): the count an hour has when it becomes final.
   */
  async cycleCounts(
    equipment: string,
    epoch: number,
    from: Date | null,
    to: Date | null,
  ): Promise<CycleCount[]> {
    let query = this.#options.db
      .selectFrom('ingest.equipment_event')
      .select((eb) => [
        sql<Date>`time_bucket(INTERVAL '1 hour', source_time)`.as('hour'),
        eb.fn.countAll<string>().as('count'),
      ])
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .where('event_type', '=', 'cycle');
    if (from) query = query.where('source_time', '>=', from);
    if (to) query = query.where('source_time', '<', to);
    const rows = await query
      .groupBy(sql`1`)
      .orderBy(sql`1`)
      .execute();
    return rows.map((row) => ({ equipment, epoch, hour: row.hour, count: Number(row.count) }));
  }

  /**
   * Completed cycles per (equipment, epoch, UTC hour) of every hour, from `cycle_hourly` once its
   * catch-up and any pending refresh have run, so they equal the stored facts. For the equipment
   * module's start-up check of the counts remembered with the final hours (#118); never on the
   * acknowledgement path.
   */
  async hourlyCycleTotals(): Promise<CycleCount[]> {
    await this.#cycles?.flush();
    const rows = await this.#options.db
      .selectFrom('ingest.cycle_hourly')
      .select((eb) => ['equipment', 'epoch', 'hour', eb.fn.sum<string>('cycles').as('count')])
      .groupBy(['equipment', 'epoch', 'hour'])
      .orderBy('equipment')
      .orderBy('epoch')
      .orderBy('hour')
      .execute();
    return rows.map((row) => ({
      equipment: row.equipment,
      epoch: row.epoch,
      hour: row.hour,
      count: Number(row.count),
    }));
  }

  /**
   * Stores one delivery as if the broker had delivered it, without a session: the same
   * validation, dedup, tables and notices, in the same queue. For tests and replays (the equipment
   * module's reconciliation feeds the simulator's facts through it); errors are thrown, not retried.
   */
  async deliver(topic: string, payload: string | Buffer, retained = false): Promise<void> {
    await this.#enqueue(async () => {
      if (!this.#loaded) {
        await this.#store.load();
        this.#loaded = true;
      }
      const notices = await this.#process(topic, payload, retained);
      await this.#announce(notices);
    });
  }

  /** One equipment's telemetry metrics, each with its unit and latest sample (API, #97). */
  async telemetryMetrics(equipment: string): Promise<TelemetryMetric[]> {
    return telemetryMetrics(this.#options.readDb ?? this.#options.db, equipment);
  }

  /** Telemetry of [from, to) decimated into buckets of `bucketMs` per metric (API, #97). */
  async telemetrySeries(
    equipment: string,
    metrics: readonly string[],
    from: Date,
    to: Date,
    bucketMs: number,
  ): Promise<TelemetrySeries[]> {
    return telemetrySeries(
      this.#options.readDb ?? this.#options.db,
      equipment,
      metrics,
      from,
      to,
      bucketMs,
    );
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

  /**
   * The state changes around `seq` in (equipment, epoch): from the one before it to the one after
   * it (by `seq`), inclusive, each where it exists. The window a late fact changes.
   */
  async stateFactWindow(equipment: string, epoch: number, seq: number): Promise<StateFact[]> {
    const states = () =>
      this.#options.db
        .selectFrom('ingest.equipment_event')
        .where('equipment', '=', equipment)
        .where('epoch', '=', epoch)
        .where('event_type', '=', 'state');
    const row = await this.#options.db
      .selectNoFrom(() => [
        states()
          .select((eb) => eb.fn.max<number | null>('seq').as('s'))
          .where('seq', '<', seq)
          .$asScalar()
          .as('before'),
        states()
          .select((eb) => eb.fn.min<number | null>('seq').as('s'))
          .where('seq', '>', seq)
          .$asScalar()
          .as('after'),
      ])
      .executeTakeFirstOrThrow();
    return this.stateFacts(equipment, epoch, {
      fromSeq: row.before ?? seq,
      toSeq: row.after ?? seq,
    });
  }

  /**
   * Per (equipment, device epoch) with stored facts: how many state changes, the last one's `seq`,
   * and the latest `sourceTime` of any fact (state, cycle, alarm). One pass over the facts, for
   * the equipment module's catch-up at start-up.
   */
  async factSummary(): Promise<FactSummary[]> {
    const rows = await this.#options.db
      .selectFrom('ingest.equipment_event')
      .select((eb) => [
        'equipment',
        'epoch',
        eb.fn.countAll<string>().filterWhere('event_type', '=', 'state').as('state_facts'),
        eb.fn.max('seq').filterWhere('event_type', '=', 'state').as('last_state_seq'),
        eb.fn.max('source_time').as('latest'),
      ])
      .groupBy(['equipment', 'epoch'])
      .orderBy('equipment')
      .orderBy('epoch')
      .execute();
    return rows.map((row) => ({
      equipment: row.equipment,
      epoch: row.epoch,
      stateFacts: Number(row.state_facts),
      lastStateSeq: row.last_state_seq,
      latestSourceTime: row.latest,
    }));
  }

  /**
   * How far one equipment's device stream is settled in a device epoch (#113): the highest `seq`
   * with no open gap at or below it (a gap reported as an incident counts as closed), the latest
   * fact time up to it (only facts above `afterSeq` are read, when given), and the epoch's gap
   * incidents. For the equipment module's interval finality.
   */
  async settled(equipment: string, epoch: number, afterSeq?: number): Promise<SettledState> {
    return this.#store.settled(equipment, epoch, afterSeq);
  }

  /**
   * Alarm transitions of one equipment in one device epoch, by `seq` (#141), optionally of one
   * code and within `fromSeq`..`toSeq` (inclusive): for the alarms module's rebuilds and catch-up.
   */
  async alarmFacts(
    equipment: string,
    epoch: number,
    options: { readonly code?: string; readonly fromSeq?: number; readonly toSeq?: number } = {},
  ): Promise<AlarmFact[]> {
    let query = this.#options.db
      .selectFrom('ingest.equipment_event')
      .select(['equipment', 'epoch', 'seq', 'source_time', 'quality', 'payload'])
      .select(['received_at', 'source_protocol'])
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .where('event_type', '=', 'alarm');
    if (options.code !== undefined) {
      query = query.where(sql<string>`payload -> 'value' ->> 'code'`, '=', options.code);
    }
    if (options.fromSeq !== undefined) query = query.where('seq', '>=', options.fromSeq);
    if (options.toSeq !== undefined) query = query.where('seq', '<=', options.toSeq);
    const rows = await query.orderBy('seq').execute();
    return rows.map((row) => {
      const value = (row.payload as Alarm).value;
      return {
        equipment: row.equipment,
        epoch: row.epoch,
        seq: row.seq,
        sourceTime: row.source_time,
        code: value.code,
        transition: value.transition,
        severity: value.severity,
        quality: row.quality,
        receivedAt: row.received_at,
        protocol: row.source_protocol,
      };
    });
  }

  /** Alarm facts per (equipment, device epoch) (#141): the alarms module's catch-up compares them. */
  async alarmFactCounts(): Promise<AlarmFactCount[]> {
    const rows = await this.#options.db
      .selectFrom('ingest.equipment_event')
      .select((eb) => ['equipment', 'epoch', eb.fn.countAll<string>().as('facts')])
      .where('event_type', '=', 'alarm')
      .groupBy(['equipment', 'epoch'])
      .orderBy('equipment')
      .orderBy('epoch')
      .execute();
    return rows.map((row) => ({
      equipment: row.equipment,
      epoch: row.epoch,
      facts: Number(row.facts),
    }));
  }

  /**
   * Alarm anchors (#141), by equipment, epoch and code. Stale ones (an epoch older than the newest
   * known for the equipment) only with `stale: true`; they are never to be used.
   */
  async alarmAnchors(
    options: { readonly equipment?: string; readonly stale?: boolean } = {},
  ): Promise<AlarmAnchor[]> {
    let query = this.#options.db.selectFrom('ingest.alarm_anchor').selectAll();
    if (options.equipment !== undefined) query = query.where('equipment', '=', options.equipment);
    if (options.stale !== true) query = query.where('stale', '=', false);
    const rows = await query.orderBy('equipment').orderBy('epoch').orderBy('code').execute();
    return rows.map(toAlarmAnchor);
  }

  /** The latest alarm snapshot per (equipment, device epoch) (#141); stale ones as for anchors. */
  async alarmSnapshots(
    options: { readonly equipment?: string; readonly stale?: boolean } = {},
  ): Promise<StoredAlarmSnapshot[]> {
    let query = this.#options.db.selectFrom('ingest.alarm_snapshot').selectAll();
    if (options.equipment !== undefined) query = query.where('equipment', '=', options.equipment);
    if (options.stale !== true) query = query.where('stale', '=', false);
    const rows = await query.orderBy('equipment').orderBy('device_epoch').execute();
    return rows.map(toAlarmSnapshot);
  }

  /**
   * The alarm state of an equipment's newest epoch from its anchors and latest snapshot, by
   * sequence (`resolveAlarmBaseline`, #141); undefined when it has none that isn't stale. Facts
   * with a higher `seq` than both are the alarms module's to apply.
   */
  async alarmBaseline(equipment: string): Promise<AlarmBaseline | undefined> {
    const [anchors, snapshots] = await Promise.all([
      this.alarmAnchors({ equipment }),
      this.alarmSnapshots({ equipment }),
    ]);
    const epoch = Math.max(...anchors.map((a) => a.epoch), ...snapshots.map((s) => s.deviceEpoch));
    if (!Number.isFinite(epoch)) return undefined;
    const snapshot = snapshots.find((s) => s.deviceEpoch === epoch);
    return {
      equipment,
      epoch,
      points: resolveAlarmBaseline(
        anchors.filter((a) => a.epoch === epoch),
        snapshot,
      ),
      snapshot: snapshot && { asOfSeq: snapshot.asOfSeq, sourceTime: snapshot.sourceTime },
    };
  }

  /**
   * Job facts (#174), by equipment, epoch and `seq`: of some command ids, or of one equipment (and
   * epoch), or all. The orders module's proof that a command made a job.
   */
  async jobFacts(
    options: {
      readonly commandIds?: readonly string[];
      readonly equipment?: string;
      readonly epoch?: number;
    } = {},
    db: Kysely<Database> = this.#options.db,
  ): Promise<JobFact[]> {
    if (options.commandIds?.length === 0) return [];
    let query = db
      .selectFrom('ingest.equipment_event')
      .select(['equipment', 'payload'])
      .where('event_type', '=', 'job');
    if (options.commandIds !== undefined) {
      query = query.where(sql<string>`payload -> 'value' ->> 'commandId'`, 'in', [
        ...options.commandIds,
      ]);
    }
    if (options.equipment !== undefined) query = query.where('equipment', '=', options.equipment);
    if (options.epoch !== undefined) query = query.where('epoch', '=', options.epoch);
    const rows = await query.orderBy('equipment').orderBy('epoch').orderBy('seq').execute();
    return rows.map((row) => toJobFact(row.equipment, row.payload as JobEvent));
  }

  /** Every `cmd-res` stored for some command ids (#174), in the order they arrived. */
  async commandResults(
    commandIds: readonly string[],
    db: Kysely<Database> = this.#options.db,
  ): Promise<StoredCommandResult[]> {
    if (commandIds.length === 0) return [];
    const rows = await db
      .selectFrom('ingest.command_result')
      .selectAll()
      .where('command_id', 'in', [...commandIds])
      .orderBy('arrival')
      .execute();
    return rows.map(toCommandResult);
  }

  /** The latest `_sys` status of each instance of a component (`edge-gateway`), #174. */
  async componentStatuses(
    component: string,
  ): Promise<{ readonly instance: string; readonly status: 'online' | 'offline' }[]> {
    return this.#options.db
      .selectFrom('ingest.component_status')
      .select(['instance', 'status'])
      .where('component', '=', component)
      .orderBy('instance')
      .execute();
  }

  /**
   * How far one equipment's device stream has arrived (#174), per the cursor: its current epoch;
   * `receivedThrough`, the highest `seq` with every number from the stream's first one up to it
   * received (a gap written off as an incident does not count as received); `settledSeq`, the
   * final-through of ADR-0018 (a reported gap counts as closed), and the source time of the fact
   * at or below it with the highest `seq`; `lastSeq`, the highest number seen. Null fields when the
   * stream has no cursor; `receivedThrough` is null for a stream first seen above 1.
   */
  async deviceProgress(equipment: string): Promise<DeviceProgress> {
    const cursor = await this.#options.db
      .selectFrom('ingest.source_cursor')
      .select(['epoch', 'seen', 'reported'])
      .where('stream', '=', `device:${equipment}`)
      .executeTakeFirst();
    if (!cursor) {
      return {
        equipment,
        epoch: null,
        receivedThrough: null,
        lastSeq: null,
        seen: [],
        settledSeq: null,
        settledTime: null,
      };
    }
    const settledSeq = settledThrough(cursor.seen, cursor.reported);
    const time =
      settledSeq === null
        ? undefined
        : await this.#options.db
            .selectFrom('ingest.equipment_event')
            .select('source_time')
            .where('equipment', '=', equipment)
            .where('epoch', '=', cursor.epoch)
            .where('seq', '<=', settledSeq)
            .orderBy('seq', 'desc')
            .limit(1)
            .executeTakeFirst();
    // Only a stream received from its start (1, or the new epoch's sentinel 0): a stream the MES
    // joined late may miss any number below its first one.
    const first = cursor.seen[0];
    return {
      equipment,
      epoch: cursor.epoch,
      receivedThrough: first !== undefined && first[0] <= 1 ? first[1] : null,
      lastSeq: cursor.seen.at(-1)?.[1] ?? null,
      seen: cursor.seen,
      settledSeq,
      settledTime: time?.source_time ?? null,
    };
  }

  /**
   * The newest device epoch ingest knows for each equipment (#174): from its facts, state anchors
   * (retained events and snapshots), alarm anchors and alarm snapshots. A command for an older
   * epoch can't be accepted any more (the device refuses it, ADR-0030).
   */
  async newestDeviceEpochs(): Promise<Map<string, number>> {
    const result = await sql<{ equipment: string; epoch: number }>`
      SELECT equipment, max(epoch)::bigint AS epoch FROM (
        SELECT substr(stream, 8) AS equipment, epoch FROM ingest.source_cursor
          WHERE stream LIKE 'device:%'
        UNION ALL
        SELECT equipment, device_epoch FROM ingest.state_anchor WHERE device_epoch IS NOT NULL
        UNION ALL
        SELECT equipment, epoch FROM ingest.alarm_anchor
        UNION ALL
        SELECT equipment, device_epoch FROM ingest.alarm_snapshot
      ) known
      GROUP BY equipment`.execute(this.#options.db);
    return new Map(result.rows.map((row) => [row.equipment, row.epoch]));
  }

  /**
   * The highest `seq` of one equipment's device epoch stored before a wall time (#174): a number
   * the device emitted before then. Null when none.
   */
  async seqStoredBefore(equipment: string, epoch: number, at: Date): Promise<number | null> {
    const row = await this.#options.db
      .selectFrom('ingest.equipment_event')
      .select((eb) => eb.fn.max<number | null>('seq').as('seq'))
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .where('ingested_at', '<', at)
      .executeTakeFirstOrThrow();
    return row.seq;
  }

  /**
   * Completed cycles of one equipment's device epoch with `seq` in (afterSeq, beforeSeq): the
   * blanks a job started that its run then lost (#174), counted between its `started` fact and
   * the next job's.
   */
  async cyclesBetween(
    equipment: string,
    epoch: number,
    afterSeq: number,
    beforeSeq: number | null,
  ): Promise<number> {
    let query = this.#options.db
      .selectFrom('ingest.equipment_event')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .where('event_type', '=', 'cycle')
      .where('seq', '>', afterSeq);
    if (beforeSeq !== null) query = query.where('seq', '<', beforeSeq);
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** The anchor of every (equipment, device epoch) that has one (see `anchor`). */
  async anchors(): Promise<StateAnchor[]> {
    const rows = await this.#options.db
      .selectFrom('ingest.state_anchor')
      .selectAll()
      .distinctOn(['equipment', 'device_epoch'])
      .where('device_epoch', 'is not', null)
      .where('superseded', '=', false)
      .orderBy('equipment')
      .orderBy('device_epoch')
      .orderBy('arrival')
      .execute();
    return rows.map(toAnchor);
  }

  /** How many state changes (equipment, epoch) has. */
  async stateFactCount(equipment: string, epoch: number): Promise<number> {
    const row = await this.#options.db
      .selectFrom('ingest.equipment_event')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .where('event_type', '=', 'state')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** The latest `sourceTime` of the state changes of (equipment, epoch) before `seq`, if any. */
  async latestStateTime(equipment: string, epoch: number, beforeSeq: number): Promise<Date | null> {
    const row = await this.#options.db
      .selectFrom('ingest.equipment_event')
      .select((eb) => eb.fn.max<Date | null>('source_time').as('t'))
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .where('event_type', '=', 'state')
      .where('seq', '<', beforeSeq)
      .executeTakeFirstOrThrow();
    return row.t;
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
   * Stores one delivery. Any error but a data error is retried a few times, then the session is
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
        const notices = await this.#process(packet.topic, packet.payload, packet.retain);
        await this.#announce(notices);
        await this.#options.beforeAck?.(packet.topic);
        this.#failedResumes = 0;
        return;
      } catch (error) {
        if (this.#isStopping()) throw error;
        this.#errors?.inc();
        const kind = failureKind(error);
        this.#log.error(
          { err: error, topic: packet.topic, attempt, kind },
          'storing a UNS message failed',
        );
        if (kind === 'data' && (await this.#unstorable(packet, error))) return;
        if (attempt + 1 >= attempts) {
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
        if (failureKind(recordError) !== 'data') return false;
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

  async #process(
    topic: string,
    payload: string | Buffer,
    retained: boolean,
  ): Promise<readonly IngestNotice[]> {
    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
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
        const { anchor, notices } = await this.#store.anchor(
          item.equipment,
          item.message,
          retained,
        );
        this.#counted('anchor');
        return anchor && anchor.deviceEpoch !== null
          ? [...notices, { type: 'anchor', anchor }]
          : notices;
      }
      case 'alarm-anchor': {
        const notices = await this.#store.alarmAnchor(item.equipment, item.message);
        this.#counted('anchor');
        return notices;
      }
      case 'alarm-snapshot': {
        const notices = await this.#store.alarmSnapshot(item.equipment, item.message);
        this.#counted('anchor');
        return notices;
      }
      case 'event':
      case 'telemetry':
      case 'incident':
      case 'command-result': {
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
          // Non-empty only for a row the table had but the cursor didn't (a commit that failed on
          // the way back): its listeners never heard of it, so it is announced now.
          return outcome.notices ?? [];
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

  /**
   * Tells listeners what one committed message (or sweep) added. Every hour of `cycle_hourly` it
   * changes is marked first, before any listener runs: a listener (equipment) may record a final
   * hour's new revision, and from then on the hour must not count as refreshed while the aggregate
   * still holds the old count (#118). The refresh is only scheduled, never awaited.
   */
  async #announce(notices: readonly IngestNotice[]): Promise<void> {
    for (const notice of notices) {
      const at =
        notice.type === 'cycle'
          ? notice.cycle.sourceTime.getTime()
          : notice.type === 'epoch'
            ? notice.sourceTime.getTime()
            : undefined;
      if (at !== undefined) this.#cycles?.changed(at, at + 1);
    }
    for (const notice of notices) await this.#notify(notice);
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
