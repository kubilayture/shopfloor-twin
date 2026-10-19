import type { FloodEpisode } from '@shopfloor/alarm-core';
import { ORDERS_TOPIC, QUALITY_TOPIC, type TerminalViewDto } from '@shopfloor/contracts/mes-api';
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import type { AlarmEvent, AlarmKpiBucket, AlarmScope } from '../alarms/index.ts';
import type { CurrentState, EquipmentChange } from '../equipment/index.ts';
import type { ExecutionChange } from '../execution/index.ts';
import type { IngestNotice, TelemetryMetric } from '../ingest/index.ts';
import type {
  DowntimeChange,
  LineBucket,
  LineChange,
  LineModel,
  OeeBucket,
  OeeChange,
  OeeScope,
  OrderOeeChange,
  OrderOeeView,
  ProductionMode,
} from '../oee/index.ts';
import { alarmKpiDto, floodEpisodeDto, occurrenceDto, pointDto } from './alarm-dto.ts';
import type { OrderChange } from '../orders/index.ts';
import type { GenealogyChange } from '../genealogy/index.ts';
import type { HoldChange, QualityChange } from '../quality/index.ts';
import type { ShiftChange } from '../shifts/index.ts';
import { commandDto, orderDto } from './order-dto.ts';
import { holdDto } from './hold-routes.ts';
import { characteristicDto, signalDto } from './quality-dto.ts';
import { bucketDto, recordDto } from './oee-dto.ts';
import { orderOeeDto } from './order-oee-dto.ts';
import { bottleneckDtos, lineBucketDto } from './line-oee-dto.ts';
import { handoverNoteDto, shiftRecordDto } from './shift-dto.ts';
import {
  ALARMS_TOPIC,
  DOWNTIME_TOPIC,
  LIMITS,
  SHIFTS_TOPIC,
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
  /**
   * Order OEE (#231): `oee:order:<order number>`, paced like the buckets; a change names an order
   * or a CNC (whose orders' topics turn dirty).
   */
  readonly orderOee?: {
    order(orderId: string): Promise<OrderOeeView | undefined>;
    onChange(listener: (change: OrderOeeChange) => void): () => void;
  };
  /**
   * Line OEE (#232): `oee:line`, the hour and shift bucket the plant clock is in, paced like the
   * buckets; a change names a machine's hours (only the topic's own hours turn it dirty) or the
   * orders (orders mode).
   */
  readonly lineOee?: {
    readonly productionMode: ProductionMode;
    current(): Promise<{ hour: LineBucket | null; shift: LineBucket | null }>;
    model(): Promise<LineModel>;
    onChange(listener: (change: LineChange) => void): () => void;
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
    onChange(listener: (change: AlarmEvent) => void): () => void;
  };
  /** What `alarm-kpi:<key>` may name (`plant`, `position:<id>`, `equipment:<id>`). */
  readonly alarmKpiTopics?: ReadonlyMap<
    string,
    { readonly scope: AlarmScope; readonly id: string; readonly members: readonly string[] }
  >;
  /** Shift instance and handover note changes (#144). */
  readonly shifts?: {
    onChange(listener: (change: ShiftChange) => void): () => void;
  };
  /** Order and command changes (#174); operation changes of the terminal (#177). */
  readonly orders?: {
    onChange(listener: (change: OrderChange) => void): () => void;
  };
  /** SPC signal episodes and characteristic changes (#200): the `quality` topic. */
  readonly quality?: {
    onChange(listener: (change: QualityChange) => void): () => void;
  };
  /** Quality holds (#201): `quality-hold` messages on the `quality` topic. */
  readonly holds?: {
    onChange(listener: (change: HoldChange) => void): () => void;
  };
  /** Genealogy rebuilt units (#203): the terminal topics' lots in use follow it. */
  readonly genealogy?: {
    onChange(listener: (change: GenealogyChange) => void): () => void;
  };
  /** Units, quantities and scrap records changed (#175): the terminal topics follow them. */
  readonly execution?: {
    onChange(listener: (change: ExecutionChange) => void): () => void;
  };
  /**
   * The operator terminal (#177): the work centers `terminal:<id>` may name with their machines,
   * and the view of one.
   */
  readonly terminal?: {
    readonly topics: ReadonlyMap<string, { readonly members: readonly string[] }>;
    view(workCenter: string): Promise<TerminalViewDto>;
  };
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
  /** At most one terminal view per topic this often (500 ms; plan: counts within 2 s, #177). */
  readonly terminalMs?: number;
  /**
   * OEE topics per client (16); alarm KPI, terminal and the line topic count separately against
   * the same limit.
   */
  readonly maxOeeTopics?: number;
  /** Order OEE topics (`oee:order:<id>`) per client (16), a budget of their own (#232). */
  readonly maxOrderOeeTopics?: number;
  readonly maxClients?: number;
  /** Telemetry subscriptions per client, counted per metric (a whole equipment counts one). */
  readonly maxSubscriptions?: number;
  /** Client messages per second, on average (10); a burst may reach `requestBurst` (20). */
  readonly requestsPerSecond?: number;
  readonly requestBurst?: number;
  readonly registry?: Registry;
  /**
   * Called for every paced delta sent, with its topic, the wall time its computation started
   * (the time the pace is measured from) and the message. For tests: they check the pace and
   * what each computation read on the server's own clock, not on when a loaded machine happened
   * to deliver the messages (#212). An error it throws is ignored: an observer never changes
   * what is pushed.
   *
   * @internal
   */
  readonly onPacedDelta?: (topic: string, wallMs: number, delta: ServerMessage) => void;
}

interface Client {
  readonly socket: PushSocket;
  alive: boolean;
  states: boolean;
  /** Following `downtime`. */
  downtime: boolean;
  /** Following `alarms` (#142). */
  alarms: boolean;
  /** Following `shifts` (#144). */
  shifts: boolean;
  /** Following `orders` (#174). */
  orders: boolean;
  /** Following `quality` (#200). */
  quality: boolean;
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

/** The order OEE topics (#231): `oee:order:<order number>`. */
const ORDER_OEE_PREFIX = 'oee:order:';
/** The line OEE topic (#232). */
const LINE_OEE_TOPIC = 'oee:line';

const PACED_NAMES = {
  oee: 'OEE',
  'oee-order': 'order OEE',
  'oee-line': 'line OEE',
  'alarm-kpi': 'alarm KPI',
  terminal: 'terminal',
} as const;

type PacedKind = keyof typeof PACED_NAMES;

/** The budget a paced topic counts against, from its name. */
function pacedKind(name: string): PacedKind {
  if (name.startsWith(ORDER_OEE_PREFIX)) return 'oee-order';
  if (name === LINE_OEE_TOPIC) return 'oee-line';
  if (name.startsWith('alarm-kpi:')) return 'alarm-kpi';
  if (name.startsWith('terminal:')) return 'terminal';
  return 'oee';
}

/**
 * One paced topic with subscribers (`oee:<id>`, `alarm-kpi:<scope>`): what it last pushed and
 * whether it must be computed. At most one delta per `oeeMs`.
 */
interface PacedTopic {
  /** The topic's name, e.g. `oee:cnc-01` or `alarm-kpi:plant`. */
  readonly name: string;
  readonly kind: PacedKind;
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
  readonly #options: Required<Omit<PushOptions, 'registry' | 'onPacedDelta'>>;
  readonly #onPacedDelta: PushOptions['onPacedDelta'];
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
  /** Per `oee:order:<id>` topic, the CNCs its order had jobs on when last computed. */
  readonly #orderMachines = new Map<string, ReadonlySet<string>>();
  /**
   * The `oee:order:<id>` topics whose last body was not final in every part (the order OEE, its
   * first-pass yield or its own line OEE, #233 review): the line value and the yield read machines
   * beyond the order's CNCs (ASM-01's pieces, PCK-01's cycles, the units at every station) and the
   * line value's `to` follows the plant clock while open, so any machine's change and the clock
   * moving turn them dirty.
   */
  readonly #orderOpen = new Set<string>();
  /** The hours `oee:line` covered when last computed (its hour and shift bucket). */
  #lineSpan: { from: number; to: number } | undefined;

  constructor(options: PushOptions = {}) {
    this.#options = {
      softLimitBytes: options.softLimitBytes ?? 256 * 1024,
      hardLimitBytes: options.hardLimitBytes ?? 4 * 1024 * 1024,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      clockMs: options.clockMs ?? 1_000,
      retryMs: options.retryMs ?? 100,
      oeeMs: options.oeeMs ?? 1_000,
      terminalMs: options.terminalMs ?? 500,
      maxOeeTopics: options.maxOeeTopics ?? LIMITS.oeeTopics,
      maxOrderOeeTopics: options.maxOrderOeeTopics ?? LIMITS.oeeOrderTopics,
      maxClients: options.maxClients ?? 64,
      maxSubscriptions: options.maxSubscriptions ?? 64,
      requestsPerSecond: options.requestsPerSecond ?? 10,
      requestBurst: options.requestBurst ?? 20,
    };
    this.#onPacedDelta = options.onPacedDelta;
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
    if (sources.lineOee) {
      this.#detach.push(
        sources.lineOee.onChange((change) => {
          this.#onLineOeeChange(change);
        }),
      );
      if (!sources.oee && !sources.orderOee) {
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
    if (sources.orderOee) {
      this.#detach.push(
        sources.orderOee.onChange((change) => {
          this.#onOrderOeeChange(change);
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
    if (sources.downtime) {
      this.#detach.push(
        sources.downtime.subscribe((change) => {
          this.#onDowntime(change);
        }),
      );
    }
    if (sources.shifts) {
      this.#detach.push(
        sources.shifts.onChange((change) => {
          this.#onShift(change);
        }),
      );
    }
    if (sources.orders) {
      this.#detach.push(
        sources.orders.onChange((change) => {
          this.#onOrder(change);
        }),
      );
    }
    if (sources.quality) {
      this.#detach.push(
        sources.quality.onChange((change) => {
          this.#onQuality(change);
          // The terminal views show their machines' episodes (#203).
          if (change.type === 'signal') this.#terminalsDirty();
        }),
      );
    }
    if (sources.holds) {
      this.#detach.push(
        sources.holds.onChange((change) => {
          this.#onHold(change);
          // The terminal views show the open holds touching their orders (#203).
          this.#terminalsDirty();
        }),
      );
    }
    if (sources.genealogy) {
      this.#detach.push(
        sources.genealogy.onChange(() => {
          this.#terminalsDirty();
        }),
      );
    }
    if (sources.execution) {
      this.#detach.push(
        sources.execution.onChange((change) => {
          // A scrap record names its machine: only that work center's view changes. An order's
          // units may be anywhere on the line.
          if (change.type === 'scrap') this.#terminalsOf(change.record.equipment);
          else this.#terminalsDirty();
        }),
      );
    }
    if (sources.terminal && !sources.oee && !sources.alarms) {
      this.#timers.push(
        setInterval(
          () => {
            this.#oeeTick();
          },
          Math.max(10, Math.floor(this.#options.terminalMs / 4)),
        ).unref(),
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
      shifts: false,
      orders: false,
      quality: false,
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
    if (request.topic === SHIFTS_TOPIC) {
      this.#shiftsRequest(client, sources, request);
      return;
    }
    if (request.topic === ORDERS_TOPIC) {
      this.#ordersRequest(client, sources, request);
      return;
    }
    if (request.topic === QUALITY_TOPIC) {
      this.#qualityRequest(client, sources, request);
      return;
    }
    if (request.topic.startsWith('alarm-kpi:')) {
      this.#alarmKpiRequest(client, sources, request);
      return;
    }
    if (request.topic.startsWith('terminal:')) {
      this.#terminalRequest(client, sources, request);
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
    if (request.topic.startsWith(ORDER_OEE_PREFIX)) {
      this.#orderOeeRequest(client, sources, request);
      return;
    }
    if (request.topic === LINE_OEE_TOPIC) {
      this.#lineOeeRequest(client, sources, request);
      return;
    }
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

  /**
   * `oee:order:<id>` (#231): the order OEE, its jobs and first-pass yield, as
   * `GET /oee/orders/{id}` answers it; a snapshot, then `oee-order` deltas paced like the buckets
   * (at most one per `oeeMs`, only when the body changed). An unknown order is null.
   */
  #orderOeeRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    const source = sources.orderOee;
    if (!source) {
      this.#send(client, {
        type: 'error',
        code: 'unknown-topic',
        detail: 'order OEE push is not available',
      });
      return;
    }
    const name = request.topic as `oee:order:${string}`;
    const orderId = name.slice(ORDER_OEE_PREFIX.length);
    this.#pacedRequest(client, request, 'oee-order', [], async () => {
      const view = await source.order(orderId);
      // The CNCs the order has jobs on: their states and commands turn the topic dirty.
      this.#orderMachines.set(name, new Set(view?.jobs.map((job) => job.machine) ?? []));
      const order = view === undefined ? null : orderOeeDto(view);
      if (order && !(order.final && order.firstPassYield.final && order.line?.final === true)) {
        this.#orderOpen.add(name);
      } else {
        this.#orderOpen.delete(name);
      }
      return {
        snapshot: { type: 'snapshot', topic: name, order },
        delta: { type: 'oee-order', topic: name, order },
        json: JSON.stringify(order),
      };
    });
  }

  /**
   * `oee:line` (#232): the line OEE of the hour and shift bucket the plant clock is in, with the
   * designed bottleneck per product, as `GET /oee/line` answers them; a snapshot, then `oee-line`
   * deltas paced like the buckets (at most one per `oeeMs`, only when the body changed).
   */
  #lineOeeRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    const source = sources.lineOee;
    if (!source) {
      this.#send(client, {
        type: 'error',
        code: 'unknown-topic',
        detail: 'line OEE push is not available',
      });
      return;
    }
    this.#pacedRequest(client, request, 'oee-line', [], async () => {
      const [model, current] = await Promise.all([source.model(), source.current()]);
      const spans = [current.hour, current.shift].flatMap((b) => (b ? [b.value] : []));
      this.#lineSpan =
        spans.length === 0
          ? undefined
          : {
              from: Math.min(...spans.map((v) => v.from)),
              to: Math.max(...spans.map((v) => v.to)),
            };
      const body = {
        productionMode: source.productionMode,
        bottlenecks: bottleneckDtos(model.bottlenecks),
        hour: current.hour && lineBucketDto(current.hour),
        shift: current.shift && lineBucketDto(current.shift),
      };
      return {
        snapshot: { type: 'snapshot', topic: LINE_OEE_TOPIC, ...body },
        delta: { type: 'oee-line', topic: LINE_OEE_TOPIC, ...body },
        json: JSON.stringify(body),
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

  /**
   * `shifts` (#144): instance upserts (created, status, revised) keyed by (epoch, shift key) and
   * note upserts keyed by note id. A client reads `GET /shifts/{date}/{shift}/report` first and
   * again when its instance's revision or status moves; the live numbers of a running shift come
   * from `oee:<id>` and `alarm-kpi:<scope>`.
   */
  #shiftsRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    if (!sources.shifts) {
      this.#send(client, {
        type: 'error',
        code: 'unknown-topic',
        detail: 'shift push is not available',
      });
      return;
    }
    client.shifts = request.type === 'subscribe';
    if (!client.shifts) {
      this.#dropPending(client, 'shift:');
      this.#dropPending(client, 'note:');
    }
    this.#send(client, {
      type: request.type === 'subscribe' ? 'subscribed' : 'unsubscribed',
      topic: SHIFTS_TOPIC,
      metric: null,
    });
  }

  /**
   * `orders` (#174): order upserts keyed by order id and command upserts keyed by command id. A
   * client reads `GET /orders` (and `GET /orders/{id}`) first, then applies upserts by id; it
   * resets its copy on (re)subscribe.
   */
  #ordersRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    if (!sources.orders) {
      this.#send(client, {
        type: 'error',
        code: 'unknown-topic',
        detail: 'order push is not available',
      });
      return;
    }
    client.orders = request.type === 'subscribe';
    if (!client.orders) {
      this.#dropPending(client, 'order:');
      this.#dropPending(client, 'command:');
    }
    this.#send(client, {
      type: request.type === 'subscribe' ? 'subscribed' : 'unsubscribed',
      topic: ORDERS_TOPIC,
      metric: null,
    });
  }

  /**
   * `quality` (#200): signal upserts keyed by signal id, and a characteristic's summary keyed by
   * its id when its readings, limits or notice changed (coalesced: a client reads the chart
   * again). A client reads first, then applies them; it resets its copy on (re)subscribe.
   */
  #qualityRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    if (!sources.quality) {
      this.#send(client, {
        type: 'error',
        code: 'unknown-topic',
        detail: 'quality push is not available',
      });
      return;
    }
    client.quality = request.type === 'subscribe';
    if (!client.quality) {
      this.#dropPending(client, 'spc-signal:');
      this.#dropPending(client, 'spc-characteristic:');
      this.#dropPending(client, 'quality-hold:');
    }
    this.#send(client, {
      type: request.type === 'subscribe' ? 'subscribed' : 'unsubscribed',
      topic: QUALITY_TOPIC,
      metric: null,
    });
  }

  /** A hold's transition, comment or scope change (#201), keyed by hold id. */
  #onHold(change: HoldChange): void {
    let data: string | undefined;
    for (const client of this.#clients) {
      if (!client.quality) continue;
      data ??= message({ type: 'quality-hold', event: change.event, hold: holdDto(change.hold) });
      this.#enqueue(client, `quality-hold:${change.hold.id}`, data);
    }
  }

  #onQuality(change: QualityChange): void {
    let data: string | undefined;
    const key =
      change.type === 'signal'
        ? `spc-signal:${String(change.signal.id)}`
        : `spc-characteristic:${change.characteristic.id}`;
    for (const client of this.#clients) {
      if (!client.quality) continue;
      data ??= message(
        change.type === 'signal'
          ? { type: 'spc-signal', event: change.event, signal: signalDto(change.signal) }
          : {
              type: 'spc-characteristic',
              event: change.event,
              characteristic: characteristicDto(change.characteristic),
            },
      );
      this.#enqueue(client, key, data);
    }
  }

  /**
   * `terminal:<workCenter>` (#177): the work center's whole terminal view as a snapshot, then as an
   * update whenever it changed (orders, operations, execution, crew, its machines' states), at most
   * once per `terminalMs`.
   */
  #terminalRequest(client: Client, sources: PushSources, request: ClientMessage): void {
    const id = request.topic.slice('terminal:'.length);
    const terminal = sources.terminal;
    const known = terminal?.topics.get(id);
    if (!terminal || !known) {
      this.#send(client, {
        type: 'error',
        code: terminal ? 'unknown-equipment' : 'unknown-topic',
        detail: terminal ? `no work center ${id}` : 'terminal push is not available',
      });
      return;
    }
    const name = request.topic;
    this.#pacedRequest(client, request, 'terminal', known.members, async () => {
      const view = await terminal.view(id);
      return {
        snapshot: { type: 'snapshot', topic: name, view },
        delta: { type: 'terminal', topic: name, view },
        json: JSON.stringify(view),
      };
    });
  }

  /** The terminal topics whose work center holds the machine are computed again. */
  #terminalsOf(equipment: string): void {
    for (const topic of this.#paced.values()) {
      if (topic.kind === 'terminal' && topic.members.has(equipment)) topic.dirty = true;
    }
  }

  /** Every terminal topic is computed again (an order, operation or execution change). */
  #terminalsDirty(workCenter?: string): void {
    for (const topic of this.#paced.values()) {
      if (topic.kind !== 'terminal') continue;
      if (workCenter === undefined || topic.name === `terminal:${workCenter}`) topic.dirty = true;
    }
  }

  #onOrder(change: OrderChange): void {
    this.#terminalsDirty();
    if (change.type === 'operation') return;
    let data: string | undefined;
    const key =
      change.type === 'order' ? `order:${change.order.id}` : `command:${change.command.commandId}`;
    for (const client of this.#clients) {
      if (!client.orders) continue;
      data ??= message(
        change.type === 'order'
          ? { type: 'order', event: change.event, order: orderDto(change.order) }
          : { type: 'command', event: change.event, command: commandDto(change.command) },
      );
      this.#enqueue(client, key, data);
    }
  }

  #onShift(change: ShiftChange): void {
    if (change.type === 'crew') {
      this.#terminalsDirty(change.crew.workCenter);
      return;
    }
    let data: string | undefined;
    const key =
      change.type === 'instance'
        ? `shift:${String(change.instance.epoch)}:${change.instance.key}`
        : `note:${String(change.note.id)}`;
    for (const client of this.#clients) {
      if (!client.shifts) continue;
      data ??= message(
        change.type === 'instance'
          ? { type: 'shift', event: change.event, shift: shiftRecordDto(change.instance) }
          : { type: 'handover-note', event: change.event, note: handoverNoteDto(change.note) },
      );
      this.#enqueue(client, key, data);
    }
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
    const followed = [...client.paced].filter((topic) => pacedKind(topic) === kind).length;
    const budget =
      kind === 'oee-order' ? this.#options.maxOrderOeeTopics : this.#options.maxOeeTopics;
    if (!client.paced.has(name) && followed >= budget) {
      this.#send(client, {
        type: 'error',
        code: 'too-many-subscriptions',
        detail: `at most ${String(budget)} ${PACED_NAMES[kind]} topics`,
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

  /**
   * An order's OEE may have moved: its own topic, or for a machine every order topic with a job on
   * it (one not computed yet too) and every order topic not final in every part (`#orderOpen`: its
   * line value and yield read the bottleneck, the packing machine and every station); with
   * neither, every order topic.
   */
  #onOrderOeeChange(change: OrderOeeChange): void {
    for (const topic of this.#paced.values()) {
      if (topic.kind !== 'oee-order') continue;
      const machines = this.#orderMachines.get(topic.name);
      const touched =
        change.orderId !== undefined
          ? topic.name === `${ORDER_OEE_PREFIX}${change.orderId}`
          : change.machine !== undefined
            ? machines === undefined ||
              machines.has(change.machine) ||
              this.#orderOpen.has(topic.name)
            : true;
      if (touched) topic.dirty = true;
    }
  }

  /**
   * The line topic turns dirty when a contributing machine's hours reach into or past the hours it
   * covered last (its hour and shift bucket: a later hour means the clock moved on; any while it
   * has none), or the orders changed (orders mode). A late fact of an earlier hour leaves it alone.
   */
  #onLineOeeChange(change: LineChange): void {
    const topic = this.#paced.get(LINE_OEE_TOPIC);
    if (!topic) return;
    const span = this.#lineSpan;
    if ('orders' in change || span === undefined || change.to.getTime() > span.from) {
      topic.dirty = true;
    }
  }

  #onOeeChange(change: OeeChange): void {
    for (const topic of this.#paced.values()) {
      if (topic.kind === 'oee' && topic.members.has(change.equipment)) topic.dirty = true;
    }
  }

  /**
   * An occurrence upsert goes to `alarms` followers (keyed by id), and so does a point's shelf
   * change (#143, keyed by point); a device change or a finality move turns KPI topics dirty, an
   * operator's never does (operator actions don't change KPIs).
   */
  #onAlarm(change: AlarmEvent): void {
    if (change.type === 'point') {
      let point: string | undefined;
      const key = `alarm:point/${change.point.equipment}/${change.point.code}`;
      for (const client of this.#clients) {
        if (!client.alarms) continue;
        point ??= message({
          type: 'alarm-point',
          event: change.event,
          point: pointDto(change.point),
        });
        this.#enqueue(client, key, point);
      }
      return;
    }
    const device =
      change.type === 'finality' ||
      change.event === 'raised' ||
      change.event === 'cleared' ||
      change.event === 'updated';
    const equipment = change.type === 'occurrence' ? change.occurrence.equipment : change.equipment;
    for (const topic of this.#paced.values()) {
      if (device && topic.kind === 'alarm-kpi' && topic.members.has(equipment)) topic.dirty = true;
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
      // An open order line value runs to the plant clock (#233 review).
      if (
        topic.kind === 'oee-order' &&
        this.#orderOpen.has(topic.name) &&
        topic.clock !== clockKey
      ) {
        topic.dirty = true;
      }
      if (topic.awaiting.size > 0 || (topic.dirty && now - topic.computedAt >= this.#pace(topic))) {
        topic.clock = clockKey;
        this.#computePaced(topic);
      }
    }
  }

  /** How often a paced topic may push: `terminalMs` for terminal views, else `oeeMs`. */
  #pace(topic: PacedTopic): number {
    return topic.kind === 'terminal' ? this.#options.terminalMs : this.#options.oeeMs;
  }

  #computePaced(topic: PacedTopic): void {
    if (!this.#sources || topic.inFlight) return;
    // A snapshot for a new subscriber may come early; deltas to the others keep their pace.
    const now = Date.now();
    const deltaDue = now - topic.deltaAt >= this.#pace(topic);
    const started = performance.now();
    topic.inFlight = true;
    topic.dirty = false;
    // The plant clock this computation reads (a snapshot computed off the tick too).
    const clock = this.#sources.equipment.watermarks()[0];
    topic.clock = clock && `${String(clock.epoch)}|${String(clock.watermark.getTime())}`;
    topic.computedAt = now;
    topic
      .compute()
      .then(
        ({ snapshot, delta: update, json }) => {
          this.#metrics?.compute.observe(
            { kind: topic.kind },
            (performance.now() - started) / 1000,
          );
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
          if (delta !== undefined) {
            topic.deltaAt = now;
            try {
              this.#onPacedDelta?.(topic.name, now, update);
            } catch {
              // An observer's error is not the push's.
            }
          }
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
        this.#orderMachines.delete(name);
        this.#orderOpen.delete(name);
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
    // A terminal view shows its machines' states (#177).
    for (const topic of this.#paced.values()) {
      if (topic.kind === 'terminal' && topic.members.has(current.equipment)) topic.dirty = true;
    }
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
    compute: new Histogram({
      name: 'mes_push_paced_compute_seconds',
      help: 'Duration of one paced topic computation (oee, alarm-kpi), by kind',
      labelNames: ['kind'] as const,
      buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2],
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
