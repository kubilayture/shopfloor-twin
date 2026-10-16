import type { FloodEpisode } from '@shopfloor/alarm-core';
import { Counter, Gauge, type Registry } from 'prom-client';
import type {
  AlarmChange,
  AlarmFinalityChange,
  AlarmKpiBucket,
  AlarmScope,
} from '../alarms/index.ts';
import type { CurrentState, EquipmentChange } from '../equipment/index.ts';
import type { IngestNotice, TelemetryMetric } from '../ingest/index.ts';
import type { DowntimeChange, OeeBucket, OeeChange, OeeScope } from '../oee/index.ts';
import { alarmKpiDto, floodEpisodeDto, occurrenceDto } from './alarm-dto.ts';
import { bucketDto, recordDto } from './oee-dto.ts';
import {
  ALARMS_TOPIC,
  DOWNTIME_TOPIC,
  LIMITS,
  STATES_TOPIC,
  clientMessageSchema,
  type ClientMessage,
  type CurrentStateDto,
  type ServerMessage,
} from './schemas.ts';

/** The socket operations the hub uses; `ws`'s WebSocket satisfies it. */
export interface PushSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'pong' | 'close', listener: () => void): unknown;
}

/** What push needs from the equipment and ingest modules. */
export interface PushSources {
  readonly equipment: {
    currentStates(): CurrentState[];
    watermark(epoch: number): Date | undefined;
    watermarks(): { readonly epoch: number; readonly watermark: Date }[];
    onChange(listener: (change: EquipmentChange) => void): () => void;
  };
  readonly ingest: {
    onStored(listener: (notice: IngestNotice) => void | Promise<void>): () => void;
    telemetryMetrics(equipment: string): Promise<TelemetryMetric[]>;
  };
  /** Equipment ids from master data: subscriptions to others are refused. */
  readonly catalog: ReadonlySet<string>;
  /** OEE on read (#120): the current hour and shift bucket per equipment or work center. */
  readonly oee?: {
    current(
      scope: OeeScope,
      id: string,
    ): Promise<{ hour: OeeBucket | null; shift: OeeBucket | null }>;
    onChange(listener: (change: OeeChange) => void): () => void;
  };
  /** The ids `oee:<id>` may name, each with its scope and machines. */
  readonly oeeTopics?: ReadonlyMap<
    string,
    { readonly scope: OeeScope; readonly members: readonly string[] }
  >;
  /** Downtime record changes (#120). */
  readonly downtime?: {
    subscribe(listener: (change: DowntimeChange) => void): () => void;
  };
  /** Alarm occurrences and KPIs (#142). */
  readonly alarms?: {
    current(
      scope: AlarmScope,
      id: string,
    ): Promise<{
      hour: AlarmKpiBucket | null;
      shift: AlarmKpiBucket | null;
      floods: FloodEpisode[];
    }>;
    onChange(listener: (change: AlarmChange | AlarmFinalityChange) => void): () => void;
  };
  /** What `alarm-kpi:<key>` may name (`plant`, `position:<id>`, `equipment:<id>`). */
  readonly alarmKpiTopics?: ReadonlyMap<
    string,
    { readonly scope: AlarmScope; readonly id: string; readonly members: readonly string[] }
  >;
}

export interface PushOptions {
  /** Above this many bytes buffered for a client, its deltas wait and are coalesced (256 KiB). */
  readonly softLimitBytes?: number;
  /** Above this many, the client is disconnected (4 MiB). */
  readonly hardLimitBytes?: number;
  /** How often clients are pinged; one missed pong disconnects (15 s). */
  readonly heartbeatMs?: number;
  /** How often the plant clock is pushed when it moved (1 s). */
  readonly clockMs?: number;
  /** How soon deltas held for a slow client are tried again (100 ms). */
  readonly retryMs?: number;
  /** At most one OEE delta per topic this often (1 s, plan "API, push and web"). */
  readonly oeeMs?: number;
  /** OEE topics per client (16); alarm KPI topics count separately against the same limit. */
  readonly maxOeeTopics?: number;
  readonly maxClients?: number;
  /** Telemetry subscriptions per client, counted per metric (a whole equipment counts one). */
  readonly maxSubscriptions?: number;
  /** Client messages per second, on average (10); a burst may reach `requestBurst` (20). */
  readonly requestsPerSecond?: number;
  readonly requestBurst?: number;
  readonly registry?: Registry;
}

interface Client {
  readonly socket: PushSocket;
  alive: boolean;
  states: boolean;
  /** Following `downtime`. */
  downtime: boolean;
  /** Following `alarms` (#142). */
  alarms: boolean;
  /** The paced topics followed: `oee:<id>` and `alarm-kpi:<scope>`. */
  readonly paced: Set<string>;
  /** Per equipment: the metrics subscribed, or null for all. */
  readonly telemetry: Map<string, Set<string> | null>;
  /** Deltas not yet sent, by key: a newer delta of the same key replaces the older one. */
  readonly pending: Map<string, string>;
  /** Telemetry snapshots being read, per equipment: that equipment's deltas wait behind them. */
  readonly holds: Map<string, number>;
  /** Request budget (token bucket) and when it was last refilled. */
  tokens: number;
  refilled: number;
}

const MAX_HOLDS = 4;

/**
 * One paced topic with subscribers (`oee:<id>`, `alarm-kpi:<scope>`): what it last pushed and
 * whether it must be computed. At most one delta per `oeeMs`.
 */
interface PacedTopic {
  /** The topic's name, e.g. `oee:cnc-01` or `alarm-kpi:plant`. */
  readonly name: string;
  readonly kind: 'oee' | 'alarm-kpi';
  readonly members: ReadonlySet<string>;
  /** The snapshot and the delta message, and their content as JSON (compared for deltas). */
  readonly compute: () => Promise<{ snapshot: ServerMessage; delta: ServerMessage; json: string }>;
  /** The plant clock it was last computed at (alarm KPIs grow with the clock). */
  clock: string | undefined;
  /** Its inputs changed since the last computation. */
  dirty: boolean;
  inFlight: boolean;
  /** Wall time of the last computation (deltas at most once per `oeeMs`). */
  computedAt: number;
  /** Wall time the last delta was computed for (at most one per `oeeMs`). */
  deltaAt: number;
  /** The last computed hour and shift buckets, as JSON: a delta is sent only when they differ. */
  last: string | undefined;
  /** Clients waiting for their snapshot. */
  readonly awaiting: Set<Client>;
}

/** Close codes (RFC 6455): 1013 try again later. */
const TRY_AGAIN_LATER = 1013;

export function currentStateDto(
  current: CurrentState,
  watermark: Date | undefined,
): CurrentStateDto {
  return {
    epoch: current.epoch,
    state: current.state,
    cause: current.cause,
    since: current.since.toISOString(),
    seq: current.seq,
    provisionalUntil: current.until?.toISOString() ?? null,
    ageMs:
      watermark === undefined ? null : Math.max(0, watermark.getTime() - current.since.getTime()),
  };
}

const message = (value: ServerMessage): string => JSON.stringify(value);

/**
 * WebSocket push (#97): clients subscribe to `states` and `telemetry:<equipment>`, get a snapshot
 * and then deltas from the equipment module's changes and ingest's stored telemetry.
 *
 * The listeners run inside ingest's notify, before the broker acknowledgement, so they only
 * record the delta per client and schedule a flush (`setImmediate`): sending never happens on
 * ingest's path. Deltas are keyed (state per equipment, telemetry per metric, the clock); while
 * a client's socket buffers more than the soft limit, its deltas wait and a newer one replaces
 * the older of the same key, so a slow client costs bounded memory and sees the latest values.
 */
export class PushHub {
  readonly #options: Required<Omit<PushOptions, 'registry'>>;
  readonly #clients = new Set<Client>();
  readonly #lastState = new Map<string, string>();
  readonly #metrics: ReturnType<typeof createMetrics> | undefined;
  #sources: PushSources | undefined;
  #detach: (() => void)[] = [];
  #timers: NodeJS.Timeout[] = [];
  #flushScheduled = false;
  #retry: NodeJS.Timeout | undefined;
  #lastClock: string | undefined;
  readonly #paced = new Map<string, PacedTopic>();

  constructor(options: PushOptions = {}) {
    this.#options = {
      softLimitBytes: options.softLimitBytes ?? 256 * 1024,
      hardLimitBytes: options.hardLimitBytes ?? 4 * 1024 * 1024,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      clockMs: options.clockMs ?? 1_000,
      retryMs: options.retryMs ?? 100,
      oeeMs: options.oeeMs ?? 1_000,
      maxOeeTopics: options.maxOeeTopics ?? LIMITS.oeeTopics,
      maxClients: options.maxClients ?? 64,
      maxSubscriptions: options.maxSubscriptions ?? 64,
      requestsPerSecond: options.requestsPerSecond ?? 10,
      requestBurst: options.requestBurst ?? 20,
    };
    this.#metrics = options.registry && createMetrics(options.registry, () => this.#clients.size);
    this.#timers.push(
      setInterval(() => {
        this.#heartbeat();
      }, this.#options.heartbeatMs).unref(),
    );
  }

  get clients(): number {
    return this.#clients.size;
  }

  /** Starts following the modules' changes. */
  attach(sources: PushSources): void {
    this.#sources = sources;
    this.#detach.push(
      sources.equipment.onChange((change) => {
        this.#onChange(change);
      }),
      sources.ingest.onStored((notice) => {
        this.#onStored(notice);
      }),
    );
    this.#timers.push(
      setInterval(() => {
        this.#clock();
      }, this.#options.clockMs).unref(),
    );
    if (sources.oee) {
      this.#detach.push(
        sources.oee.onChange((change) => {
          this.#onOeeChange(change);
        }),
      );
      this.#timers.push(
        setInterval(
          () => {
            this.#oeeTick();
          },
          Math.max(10, Math.floor(this.#options.oeeMs / 4)),
        ).unref(),
      );
    }
    if (sources.downtime) {
      this.#detach.push(
        sources.downtime.subscribe((change) => {
          this.#onDowntime(change);
        }),
      );
    }
    if (sources.alarms) {
      this.#detach.push(
        sources.alarms.onChange((change) => {
          this.#onAlarm(change);
        }),
      );
      if (!sources.oee) {
        this.#timers.push(
          setInterval(
            () => {
              this.#oeeTick();
            },
            Math.max(10, Math.floor(this.#options.oeeMs / 4)),
          ).unref(),
        );
      }
    }
  }

  /** Stops following and disconnects every client. */
  close(): void {
    for (const detach of this.#detach.splice(0)) detach();
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    clearTimeout(this.#retry);
    for (const client of this.#clients) client.socket.terminate();
    this.#clients.clear();
    this.#paced.clear();
  }

  connect(socket: PushSocket): void {
    if (this.#clients.size >= this.#options.maxClients) {
      socket.close(TRY_AGAIN_LATER, 'too many clients');
      return;
    }
    const client: Client = {
      socket,
      alive: true,
      states: false,
      downtime: false,
      alarms: false,
      paced: new Set(),
      telemetry: new Map(),
      pending: new Map(),
      holds: new Map(),
      tokens: this.#options.requestBurst,
      refilled: Date.now(),
    };
    this.#clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      this.#receive(client, data, isBinary);
    });
    socket.on('close', () => {
      this.#clients.delete(client);
      this.#leavePaced(client);
    });
  }

  /** Takes one request from the client's budget; false when it is spent. */
  #admit(client: Client): boolean {
    const now = Date.now();
    client.tokens = Math.min(
      this.#options.requestBurst,
      client.tokens + ((now - client.refilled) / 1_000) * this.#options.requestsPerSecond,
    );
    client.refilled = now;
    if (client.tokens < 1) return false;
    client.tokens--;
    return true;
  }

  #receive(client: Client, data: unknown, isBinary: boolean): void {
    if (!this.#admit(client)) {
      this.#send(client, {
        type: 'error',
        code: 'rate-limited',
        detail: `at most ${String(this.#options.requestsPerSecond)} messages per second`,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = isBinary ? undefined : JSON.parse(String(data));
    } catch {
      parsed = undefined;
    }
    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.#send(client, {
        type: 'error',
        code: 'invalid-message',
        detail: 'expected a subscribe or unsubscribe message as JSON text (docs/api/realtime.md)',
      });
      return;
    }
    const sources = this.#sources;
    if (!sources) {
      this.#send(client, { type: 'error', code: 'unavailable', detail: 'the MES is starting' });
      return;
    }
    const request = result.data;
    if (request.metric !== undefined && !request.topic.startsWith('telemetry:')) {
      this.#send(client, {
        type: 'error',
        code: 'invalid-message',
        detail: '`metric` applies to telemetry topics only',
      });
      return;
    }
    if (request.topic === DOWNTIME_TOPIC) {
      this.#downtimeRequest(client, sources, request);
      return;
    }
    if (request.topic.startsWith('oee:')) {
      this.#oeeRequest(client, sources, request);
      return;
    }
    if (request.topic === ALARMS_TOPIC) {
      this.#alarmsRequest(client, sources, request);
      return;
    }
    if (request.topic.startsWith('alarm-kpi:')) {
      this.#alarmKpiRequest(client, sources, request);
      return;
    }
    if (request.topic === STATES_TOPIC) {
      if (request.type === 'subscribe') {
        this.#subscribeStates(client, sources);
      } else {
        client.states = false;
        this.#dropPending(client, 'state:');
        this.#dropPending(client, 'clock');
        this.#send(client, { type: 'unsubscribed', topic: STATES_TOPIC, metric: null });
      }
      return;
    }
    const equipment = request.topic.slice('telemetry:'.length);
    if (!sources.catalog.has(equipment)) {
      this.#send(client, {
        type: 'error',
        code: 'unknown-equipment',
        detail: `no equipment ${equipment}`,
      });
      return;
    }
    if (request.type === 'subscribe') {
      this.#subscribeTelemetry(client, sources, equipment, request);
    } else {
      this.#unsubscribeTelemetry(client, equipment, request);
    }
  }

  #downtimeRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    if (!sources.downtime) {
      this.#send(client, {
        type: 'error',
        code: 'unknown-topic',
        detail: 'downtime push is not available',
      });
      return;
    }
    client.downtime = request.type === 'subscribe';
    if (!client.downtime) this.#dropPending(client, 'downtime:');
    this.#send(client, {
      type: request.type === 'subscribe' ? 'subscribed' : 'unsubscribed',
      topic: DOWNTIME_TOPIC,
      metric: null,
    });
  }

  #oeeRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    const id = request.topic.slice('oee:'.length);
    const known = sources.oeeTopics?.get(id);
    const oee = sources.oee;
    if (!oee || !known) {
      this.#send(client, {
        type: 'error',
        code: oee ? 'unknown-equipment' : 'unknown-topic',
        detail: oee ? `no equipment or work center ${id}` : 'OEE push is not available',
      });
      return;
    }
    const name = request.topic;
    this.#pacedRequest(client, request, 'oee', known.members, async () => {
      const current = await oee.current(known.scope, id);
      const hour = current.hour && bucketDto(current.hour);
      const shift = current.shift && bucketDto(current.shift);
      return {
        snapshot: { type: 'snapshot', topic: name, hour, shift },
        delta: { type: 'oee', topic: name, hour, shift },
        json: JSON.stringify({ hour, shift }),
      };
    });
  }

  #alarmsRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    if (!sources.alarms) {
      this.#send(client, {
        type: 'error',
        code: 'unknown-topic',
        detail: 'alarm push is not available',
      });
      return;
    }
    client.alarms = request.type === 'subscribe';
    if (!client.alarms) this.#dropPending(client, 'alarm:');
    this.#send(client, {
      type: request.type === 'subscribe' ? 'subscribed' : 'unsubscribed',
      topic: ALARMS_TOPIC,
      metric: null,
    });
  }

  #alarmKpiRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    const key = request.topic.slice('alarm-kpi:'.length);
    const known = sources.alarmKpiTopics?.get(key);
    const alarms = sources.alarms;
    if (!alarms || !known) {
      this.#send(client, {
        type: 'error',
        code: alarms ? 'unknown-equipment' : 'unknown-topic',
        detail: alarms ? `no alarm scope ${key}` : 'alarm push is not available',
      });
      return;
    }
    const name = request.topic;
    this.#pacedRequest(client, request, 'alarm-kpi', known.members, async () => {
      const current = await alarms.current(known.scope, known.id);
      const hour = current.hour && alarmKpiDto(current.hour);
      const shift = current.shift && alarmKpiDto(current.shift);
      const floods = current.floods.map(floodEpisodeDto);
      return {
        snapshot: { type: 'snapshot', topic: name, hour, shift, floods },
        delta: { type: 'alarm-kpi', topic: name, hour, shift, floods },
        json: JSON.stringify({ hour, shift, floods }),
      };
    });
  }

  /** Subscribes or unsubscribes a paced topic; a subscriber gets a snapshot, then deltas. */
  #pacedRequest(
    client: Client,
    request: ClientMessage,
    kind: PacedTopic['kind'],
    members: readonly string[],
    compute: PacedTopic['compute'],
  ): void {
    const name = request.topic;
    if (request.type === 'unsubscribe') {
      client.paced.delete(name);
      this.#paced.get(name)?.awaiting.delete(client);
      this.#dropPending(client, name);
      this.#send(client, { type: 'unsubscribed', topic: name, metric: null });
      return;
    }
    const followed = [...client.paced].filter((topic) => topic.startsWith(`${kind}:`)).length;
    if (!client.paced.has(name) && followed >= this.#options.maxOeeTopics) {
      this.#send(client, {
        type: 'error',
        code: 'too-many-subscriptions',
        detail: `at most ${String(this.#options.maxOeeTopics)} ${kind === 'oee' ? 'OEE' : 'alarm KPI'} topics`,
      });
      return;
    }
    client.paced.add(name);
    let topic = this.#paced.get(name);
    if (!topic) {
      topic = {
        name,
        kind,
        members: new Set(members),
        compute,
        clock: undefined,
        dirty: true,
        inFlight: false,
        computedAt: 0,
        deltaAt: 0,
        last: undefined,
        awaiting: new Set(),
      };
      this.#paced.set(name, topic);
    }
    this.#send(client, { type: 'subscribed', topic: name, metric: null });
    // The snapshot is newer than a delta waiting; the next computation brings it.
    this.#dropPending(client, name);
    topic.awaiting.add(client);
    this.#computePaced(topic);
  }

  #onOeeChange(change: OeeChange): void {
    for (const topic of this.#paced.values()) {
      if (topic.kind === 'oee' && topic.members.has(change.equipment)) topic.dirty = true;
    }
  }

  /** An occurrence upsert goes to `alarms` followers (keyed by id); KPI topics turn dirty. */
  #onAlarm(change: AlarmChange | AlarmFinalityChange): void {
    const equipment = change.type === 'occurrence' ? change.occurrence.equipment : change.equipment;
    for (const topic of this.#paced.values()) {
      if (topic.kind === 'alarm-kpi' && topic.members.has(equipment)) topic.dirty = true;
    }
    if (change.type !== 'occurrence') return;
    let data: string | undefined;
    const key = `alarm:${change.occurrence.id}`;
    for (const client of this.#clients) {
      if (!client.alarms) continue;
      data ??= message({
        type: 'alarm',
        event: change.event,
        occurrence: occurrenceDto(change.occurrence),
      });
      this.#enqueue(client, key, data);
    }
  }

  /**
   * Computes the dirty topics whose last computation is at least `oeeMs` old (off ingest's path).
   * Alarm KPIs also change while the plant clock moves (active time, the hour in progress).
   */
  #oeeTick(): void {
    const now = Date.now();
    const clock = this.#sources?.equipment.watermarks()[0];
    const clockKey = clock && `${String(clock.epoch)}|${String(clock.watermark.getTime())}`;
    for (const topic of this.#paced.values()) {
      if (topic.kind === 'alarm-kpi' && topic.clock !== clockKey) topic.dirty = true;
      if (
        topic.awaiting.size > 0 ||
        (topic.dirty && now - topic.computedAt >= this.#options.oeeMs)
      ) {
        topic.clock = clockKey;
        this.#computePaced(topic);
      }
    }
  }

  #computePaced(topic: PacedTopic): void {
    if (!this.#sources || topic.inFlight) return;
    // A snapshot for a new subscriber may come early; deltas to the others keep their pace.
    const now = Date.now();
    const deltaDue = now - topic.deltaAt >= this.#options.oeeMs;
    topic.inFlight = true;
    topic.dirty = false;
    topic.computedAt = now;
    topic
      .compute()
      .then(
        ({ snapshot, delta: update, json }) => {
          let delta: string | undefined;
          for (const client of this.#clients) {
            if (!client.paced.has(topic.name)) continue;
            if (topic.awaiting.has(client)) {
              this.#send(client, snapshot);
            } else if (json !== topic.last && deltaDue) {
              delta ??= message(update);
              this.#enqueue(client, topic.name, delta);
            }
          }
          topic.awaiting.clear();
          if (delta !== undefined) topic.deltaAt = now;
          if (deltaDue || json === topic.last) topic.last = json;
          // A change held back for the pace goes out with the next computation.
          else topic.dirty = true;
        },
        () => {
          // Tried again at the next tick; waiting clients keep waiting.
          topic.dirty = true;
        },
      )
      .finally(() => {
        topic.inFlight = false;
        this.#prunePaced();
      });
  }

  /** Drops the topics nobody follows any more. */
  #prunePaced(): void {
    for (const [name, topic] of this.#paced) {
      if (![...this.#clients].some((client) => client.paced.has(name)) && !topic.inFlight) {
        this.#paced.delete(name);
      }
    }
  }

  #leavePaced(client: Client): void {
    for (const name of client.paced) this.#paced.get(name)?.awaiting.delete(client);
    client.paced.clear();
    this.#prunePaced();
  }

  #onDowntime(change: DowntimeChange): void {
    const sources = this.#sources;
    if (!sources) return;
    let data: string | undefined;
    let key: string | undefined;
    for (const client of this.#clients) {
      if (!client.downtime) continue;
      const dto = recordDto(change.record, sources.equipment.watermark(change.record.epoch));
      key ??= `downtime:${dto.id}`;
      data ??= message({ type: 'downtime', event: change.event, record: dto });
      this.#enqueue(client, key, data);
    }
  }

  #subscribeStates(client: Client, sources: PushSources): void {
    client.states = true;
    // The snapshot is newer than anything waiting.
    this.#dropPending(client, 'state:');
    this.#dropPending(client, 'clock');
    this.#send(client, { type: 'subscribed', topic: STATES_TOPIC, metric: null });
    const clock = sources.equipment.watermarks()[0];
    this.#send(client, {
      type: 'snapshot',
      topic: STATES_TOPIC,
      clock: clock ? { epoch: clock.epoch, watermark: clock.watermark.toISOString() } : null,
      states: sources.equipment.currentStates().map((current) => ({
        equipment: current.equipment,
        current: currentStateDto(current, sources.equipment.watermark(current.epoch)),
      })),
    });
  }

  #subscribeTelemetry(
    client: Client,
    sources: PushSources,
    equipment: string,
    request: ClientMessage,
  ): void {
    const existing = client.telemetry.get(equipment);
    const metric = request.metric;
    // Counted per metric, an equipment subscribed whole as one.
    const count = (map: ReadonlyMap<string, ReadonlySet<string> | null>) =>
      [...map.values()].reduce((n, set) => n + (set?.size ?? 1), 0);
    const next = new Map(client.telemetry);
    if (metric === undefined) next.set(equipment, null);
    else if (existing === undefined) next.set(equipment, new Set([metric]));
    else if (existing !== null) next.set(equipment, new Set([...existing, metric]));
    const before = count(client.telemetry);
    const after = count(next);
    if (after > before && after > this.#options.maxSubscriptions) {
      this.#send(client, {
        type: 'error',
        code: 'too-many-subscriptions',
        detail: `at most ${String(this.#options.maxSubscriptions)} telemetry subscriptions`,
      });
      return;
    }
    const holds = [...client.holds.values()].reduce((n, h) => n + h, 0);
    if (holds >= MAX_HOLDS) {
      this.#send(client, { type: 'error', code: 'busy', detail: 'too many snapshots in flight' });
      return;
    }
    client.telemetry.set(equipment, next.get(equipment) ?? null);
    this.#send(client, { type: 'subscribed', topic: request.topic, metric: metric ?? null });
    client.holds.set(equipment, (client.holds.get(equipment) ?? 0) + 1);
    sources.ingest
      .telemetryMetrics(equipment)
      .then(
        (metrics) => {
          // Unsubscribed (or gone) while the snapshot was read: nothing to send.
          const wanted = metrics.filter(
            (m) =>
              (metric === undefined || m.metric === metric) &&
              this.#wants(client, equipment, m.metric),
          );
          if (!this.#clients.has(client) || !this.#wants(client, equipment, metric)) return;
          this.#send(client, {
            type: 'snapshot',
            topic: request.topic,
            samples: wanted.map((m) => ({
              equipment,
              metric: m.metric,
              unit: m.unit,
              t: m.latest.sourceTime.toISOString(),
              value: m.latest.value,
            })),
          });
        },
        () => {
          if (!this.#clients.has(client)) return;
          this.#send(client, {
            type: 'error',
            code: 'unavailable',
            detail: 'the telemetry snapshot could not be read; deltas follow',
          });
        },
      )
      .finally(() => {
        const left = (client.holds.get(equipment) ?? 1) - 1;
        if (left > 0) client.holds.set(equipment, left);
        else client.holds.delete(equipment);
        this.#scheduleFlush();
      });
  }

  /** Whether the client follows this metric (any metric of the equipment when undefined). */
  #wants(client: Client, equipment: string, metric: string | undefined): boolean {
    const subscribed = client.telemetry.get(equipment);
    if (subscribed === undefined) return false;
    return subscribed === null || metric === undefined || subscribed.has(metric);
  }

  #unsubscribeTelemetry(client: Client, equipment: string, request: ClientMessage): void {
    const metric = request.metric;
    const existing = client.telemetry.get(equipment);
    if (metric !== undefined && existing === null) {
      this.#send(client, {
        type: 'error',
        code: 'invalid-message',
        detail:
          'subscribed to every metric of this equipment: unsubscribe the topic, ' +
          'then subscribe the metrics wanted',
      });
      return;
    }
    if (metric === undefined) {
      client.telemetry.delete(equipment);
      this.#dropPending(client, `telemetry:${equipment}:`);
    } else if (existing) {
      existing.delete(metric);
      if (existing.size === 0) client.telemetry.delete(equipment);
      this.#dropPending(client, `telemetry:${equipment}:${metric}`);
    }
    this.#send(client, { type: 'unsubscribed', topic: request.topic, metric: metric ?? null });
  }

  #onChange(change: EquipmentChange): void {
    const current = change.current;
    const sources = this.#sources;
    if (!current || !sources) return;
    // Rewrites of the open interval (the watermark moving) change no state: the clock covers them.
    const key = [current.epoch, current.seq, current.since.getTime(), current.state, current.cause]
      .map(String)
      .join('|');
    if (this.#lastState.get(current.equipment) === key) return;
    this.#lastState.set(current.equipment, key);
    let data: string | undefined;
    for (const client of this.#clients) {
      if (!client.states) continue;
      data ??= message({
        type: 'state',
        equipment: current.equipment,
        current: currentStateDto(current, sources.equipment.watermark(current.epoch)),
      });
      this.#enqueue(client, `state:${current.equipment}`, data);
    }
  }

  #onStored(notice: IngestNotice): void {
    if (notice.type !== 'sample' || !notice.sample.telemetry) return;
    const { equipment, sourceTime } = notice.sample;
    const { metric, value, unit } = notice.sample.telemetry;
    let data: string | undefined;
    for (const client of this.#clients) {
      const subscribed = client.telemetry.get(equipment);
      if (subscribed === undefined || (subscribed !== null && !subscribed.has(metric))) continue;
      data ??= message({
        type: 'telemetry',
        equipment,
        metric,
        unit,
        t: sourceTime.toISOString(),
        value,
      });
      this.#enqueue(client, `telemetry:${equipment}:${metric}`, data);
    }
  }

  #clock(): void {
    const clock = this.#sources?.equipment.watermarks()[0];
    if (!clock) return;
    const key = `${String(clock.epoch)}|${String(clock.watermark.getTime())}`;
    if (key === this.#lastClock) return;
    this.#lastClock = key;
    const data = message({
      type: 'clock',
      epoch: clock.epoch,
      watermark: clock.watermark.toISOString(),
    });
    for (const client of this.#clients) {
      if (client.states) this.#enqueue(client, 'clock', data);
    }
  }

  #enqueue(client: Client, key: string, data: string): void {
    if (client.pending.delete(key)) this.#metrics?.coalesced.inc();
    client.pending.set(key, data);
    this.#scheduleFlush();
  }

  #dropPending(client: Client, prefix: string): void {
    for (const key of client.pending.keys()) {
      if (key.startsWith(prefix)) client.pending.delete(key);
    }
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    setImmediate(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    let held = false;
    for (const client of this.#clients) {
      if (client.pending.size === 0) continue;
      const buffered = client.socket.bufferedAmount;
      if (buffered > this.#options.hardLimitBytes) {
        this.#drop(client, 'slow');
        continue;
      }
      if (buffered > this.#options.softLimitBytes) {
        held = true;
        continue;
      }
      for (const [key, data] of client.pending) {
        // A telemetry delta waits while its equipment's snapshot is read; others flow.
        if (key.startsWith('telemetry:') && client.holds.has(key.split(':')[1] ?? '')) continue;
        client.socket.send(data);
        client.pending.delete(key);
        this.#metrics?.sent.inc({ type: key.split(':', 1)[0] ?? key });
      }
    }
    if (held && this.#retry === undefined) {
      this.#retry = setTimeout(() => {
        this.#retry = undefined;
        this.#flush();
      }, this.#options.retryMs).unref();
    }
  }

  #send(client: Client, value: ServerMessage): void {
    if (client.socket.bufferedAmount > this.#options.hardLimitBytes) {
      this.#drop(client, 'slow');
      return;
    }
    client.socket.send(message(value));
    this.#metrics?.sent.inc({ type: value.type });
  }

  #drop(client: Client, reason: 'slow' | 'heartbeat'): void {
    // A close frame would queue behind the backlog the client isn't reading.
    client.socket.terminate();
    this.#clients.delete(client);
    this.#leavePaced(client);
    this.#metrics?.dropped.inc({ reason });
  }

  #heartbeat(): void {
    for (const client of this.#clients) {
      if (!client.alive) {
        this.#drop(client, 'heartbeat');
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }
}

function createMetrics(registry: Registry, clients: () => number) {
  new Gauge({
    name: 'mes_ws_clients',
    help: 'Connected WebSocket clients',
    registers: [registry],
    collect() {
      this.set(clients());
    },
  });
  return {
    sent: new Counter({
      name: 'mes_push_messages_total',
      help: 'WebSocket messages sent, by type',
      labelNames: ['type'] as const,
      registers: [registry],
    }),
    coalesced: new Counter({
      name: 'mes_push_coalesced_total',
      help: 'Deltas replaced by a newer one of the same key before a slow client took them',
      registers: [registry],
    }),
    dropped: new Counter({
      name: 'mes_ws_dropped_total',
      help: 'WebSocket clients disconnected, by reason (slow: buffer over the limit; heartbeat)',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
  };
}
