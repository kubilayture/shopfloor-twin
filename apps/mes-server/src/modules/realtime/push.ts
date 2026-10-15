import { Counter, Gauge, type Registry } from 'prom-client';
import type { CurrentState, EquipmentChange } from '../equipment/index.ts';
import type { IngestNotice, TelemetryMetric } from '../ingest/index.ts';
import {
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
  readonly maxClients?: number;
  /** Telemetry subscriptions per client. */
  readonly maxSubscriptions?: number;
  readonly registry?: Registry;
}

interface Client {
  readonly socket: PushSocket;
  alive: boolean;
  states: boolean;
  /** Per equipment: the metrics subscribed, or null for all. */
  readonly telemetry: Map<string, Set<string> | null>;
  /** Deltas not yet sent, by key: a newer delta of the same key replaces the older one. */
  readonly pending: Map<string, string>;
  /** Snapshots being read: deltas wait behind them. */
  holds: number;
}

const MAX_HOLDS = 4;

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

  constructor(options: PushOptions = {}) {
    this.#options = {
      softLimitBytes: options.softLimitBytes ?? 256 * 1024,
      hardLimitBytes: options.hardLimitBytes ?? 4 * 1024 * 1024,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      clockMs: options.clockMs ?? 1_000,
      retryMs: options.retryMs ?? 100,
      maxClients: options.maxClients ?? 64,
      maxSubscriptions: options.maxSubscriptions ?? 64,
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
  }

  /** Stops following and disconnects every client. */
  close(): void {
    for (const detach of this.#detach.splice(0)) detach();
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    clearTimeout(this.#retry);
    for (const client of this.#clients) client.socket.terminate();
    this.#clients.clear();
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
      telemetry: new Map(),
      pending: new Map(),
      holds: 0,
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
    });
  }

  #receive(client: Client, data: unknown, isBinary: boolean): void {
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
    if (request.topic === STATES_TOPIC) {
      if (request.metric !== undefined) {
        this.#send(client, {
          type: 'error',
          code: 'invalid-message',
          detail: '`metric` applies to telemetry topics only',
        });
      } else if (request.type === 'subscribe') {
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
    const size = [...client.telemetry.values()].reduce((n, set) => n + (set?.size ?? 1), 0);
    if (existing === undefined && size >= this.#options.maxSubscriptions) {
      this.#send(client, {
        type: 'error',
        code: 'too-many-subscriptions',
        detail: `at most ${String(this.#options.maxSubscriptions)} telemetry subscriptions`,
      });
      return;
    }
    if (client.holds >= MAX_HOLDS) {
      this.#send(client, { type: 'error', code: 'busy', detail: 'too many snapshots in flight' });
      return;
    }
    const metric = request.metric;
    if (metric === undefined) client.telemetry.set(equipment, null);
    else if (existing === undefined) client.telemetry.set(equipment, new Set([metric]));
    else existing?.add(metric);
    this.#send(client, { type: 'subscribed', topic: request.topic, metric: metric ?? null });
    client.holds++;
    sources.ingest
      .telemetryMetrics(equipment)
      .then(
        (metrics) => {
          this.#send(client, {
            type: 'snapshot',
            topic: request.topic,
            samples: metrics
              .filter((m) => metric === undefined || m.metric === metric)
              .map((m) => ({
                equipment,
                metric: m.metric,
                unit: m.unit,
                t: m.latest.sourceTime.toISOString(),
                value: m.latest.value,
              })),
          });
        },
        () => {
          this.#send(client, {
            type: 'error',
            code: 'unavailable',
            detail: 'the telemetry snapshot could not be read; deltas follow',
          });
        },
      )
      .finally(() => {
        client.holds--;
        this.#scheduleFlush();
      });
  }

  #unsubscribeTelemetry(client: Client, equipment: string, request: ClientMessage): void {
    const metric = request.metric;
    const existing = client.telemetry.get(equipment);
    if (metric === undefined || existing === null) {
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
      if (client.pending.size === 0 || client.holds > 0) continue;
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
        client.socket.send(data);
        this.#metrics?.sent.inc({ type: key.split(':', 1)[0] ?? key });
      }
      client.pending.clear();
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
