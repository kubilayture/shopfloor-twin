import type {
  AlarmKpiBucketDto,
  AlarmOccurrenceDto,
  AlarmPointDto,
  BottleneckDto,
  Clock,
  CommandDto,
  CurrentStateDto,
  DowntimeRecordDto,
  FloodEpisodeDto,
  HandoverNoteDto,
  LineBucketDto,
  LineOeeDto,
  OeeBucketDto,
  OrderDto,
  OrderOeeDto,
  ServerMessage,
  ShiftRecordDto,
  TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import type { QueryClient } from '@tanstack/react-query';
import { newerOccurrence, newerPoint, pointKey } from '../domain/alarms.ts';
import { isNewerCommand, isNewerOrder } from '../domain/orders.ts';
import { instanceKey, isNewerShift } from '../domain/shifts.ts';
import { appendSample, type LiveSample } from '../domain/series.ts';
import { isNewer, isNewerClock } from '../domain/states.ts';
import type { LiveClient } from './live-client.ts';
import { QUALITY_READS, applyQualityMessage, resetLiveQuality } from './live-quality.ts';

/** The pushed equipment states and plant clock, kept in the query cache. */
export interface LiveStates {
  readonly clock: Clock | null;
  readonly states: Readonly<Record<string, CurrentStateDto>>;
}

/**
 * Pushed samples of one metric. `samples` is a buffer the cache appends to in place (copying it
 * per sample made a long session quadratic); every update wraps it in a new object with a new
 * `version`, so readers re-render, and they only read it.
 */
export interface LiveMetric {
  readonly unit: string;
  readonly samples: readonly LiveSample[];
  readonly version: number;
}

/** Pushed telemetry of one equipment, by metric. */
export type LiveTelemetry = Readonly<Record<string, LiveMetric>>;

/**
 * The pushed OEE of one topic (`oee:<id>`): the whole hour and shift buckets the plant clock is
 * in, as last pushed (null without data). Older buckets are not kept: REST serves them.
 */
export interface LiveOee {
  readonly hour: OeeBucketDto | null;
  readonly shift: OeeBucketDto | null;
}

/** A pushed downtime record; `removed` when the MES said it no longer exists. */
export interface LiveRecord {
  readonly record: DowntimeRecordDto;
  readonly removed: boolean;
}

/** Pushed downtime records by id (upserts), and a counter that moves with every message. */
export interface LiveDowntime {
  readonly records: Readonly<Record<string, LiveRecord>>;
  readonly seq: number;
}

/**
 * Pushed alarm occurrences by id and alarm points by `equipment/code` (upserts, #145), since the
 * last (re)connect, and a counter that moves with every message.
 */
export interface LiveAlarms {
  readonly occurrences: Readonly<Record<string, AlarmOccurrenceDto>>;
  readonly points: Readonly<Record<string, AlarmPointDto>>;
  readonly seq: number;
}

/**
 * The pushed alarm KPIs of one scope (`alarm-kpi:<scope>`): the hour and shift buckets the plant
 * clock is in, as last pushed, and the flood episodes still in flood.
 */
export interface LiveAlarmKpi {
  readonly hour: AlarmKpiBucketDto | null;
  readonly shift: AlarmKpiBucketDto | null;
  readonly floods: readonly FloodEpisodeDto[];
}

export const liveKeys = {
  all: ['live'] as const,
  states: ['live', 'states'] as const,
  telemetryAll: ['live', 'telemetry'] as const,
  telemetry: (equipment: string) => ['live', 'telemetry', equipment] as const,
  oee: (id: string) => ['live', 'oee', id] as const,
  downtime: ['live', 'downtime'] as const,
  alarms: ['live', 'alarms'] as const,
  /** `plant`, `position:<id>` or `equipment:<id>`: the topic without `alarm-kpi:`. */
  alarmKpi: (scope: string) => ['live', 'alarm-kpi', scope] as const,
  shifts: ['live', 'shifts'] as const,
  orders: ['live', 'orders'] as const,
  /** A work center's terminal view as last pushed on `terminal:<id>` (#177). */
  terminal: (workCenter: string) => ['live', 'terminal', workCenter] as const,
  /** An order's OEE as last pushed on `oee:order:<id>` (#233); null for an unknown order. */
  orderOee: (orderId: string) => ['live', 'oee-order', orderId] as const,
  /** The line OEE of the current hour and shift as last pushed on `oee:line` (#233). */
  lineOee: ['live', 'oee-line'] as const,
};

/** `oee:order:<order number>` (docs/api/realtime.md, #231). */
export const orderOeeTopic = (orderId: string): string => `oee:order:${orderId}`;

/**
 * The pushed line throughput OEE (`oee:line`, #233): the production mode, the bottleneck per
 * product and the hour and shift buckets the plant clock is in (null without a clock or shift).
 */
export interface LiveLineOee {
  readonly productionMode: LineOeeDto['productionMode'];
  readonly bottlenecks: readonly BottleneckDto[];
  readonly hour: LineBucketDto | null;
  readonly shift: LineBucketDto | null;
}

/**
 * Pushed orders and dispatch commands by id (upserts on the `orders` topic, #176), since the topic
 * was taken, and a counter that moves with every message.
 */
export interface LiveOrders {
  readonly orders: Readonly<Record<string, OrderDto>>;
  readonly commands: Readonly<Record<string, CommandDto>>;
  readonly seq: number;
}

/**
 * Pushed shift instances by `instanceKey` (epoch, shift key) and handover notes by id (upserts
 * on the `shifts` topic, #146), since the topic was taken, and a counter that moves with every
 * message.
 */
export interface LiveShifts {
  readonly instances: Readonly<Record<string, ShiftRecordDto>>;
  readonly notes: Readonly<Record<string, HandoverNoteDto>>;
  readonly seq: number;
}

/** Pushed downtime records kept (the newest by start); a shift has a few hundred at most. */
export const LIVE_DOWNTIME_LIMIT = 5_000;

/** Pushed alarm occurrences kept (the newest by raise); a flood is a few dozen a minute. */
export const LIVE_ALARM_LIMIT = 5_000;

export const TELEMETRY_GC_MS = 60_000;

/** Live samples kept per metric for a chart (about an hour of 1 s samples), at least. */
export const LIVE_SAMPLE_LIMIT = 4_000;

const EMPTY: LiveStates = { clock: null, states: {} };

function mergeStates(
  live: LiveStates | undefined,
  clock: Clock | null | undefined,
  states: readonly { equipment: string; current: CurrentStateDto }[],
): LiveStates {
  const base = live ?? EMPTY;
  let merged: Record<string, CurrentStateDto> | undefined;
  for (const { equipment, current } of states) {
    if (!isNewer(current, base.states[equipment])) continue;
    merged ??= { ...base.states };
    merged[equipment] = current;
  }
  const newClock = clock && isNewerClock(clock, base.clock) ? clock : base.clock;
  if (merged === undefined && newClock === base.clock && live !== undefined) return live;
  return { clock: newClock, states: merged ?? base.states };
}

function mergeSamples(
  telemetry: LiveTelemetry | undefined,
  samples: readonly { metric: string; unit: string; t: string; value: number }[],
): LiveTelemetry {
  const next: Record<string, LiveMetric> = { ...telemetry };
  for (const sample of samples) {
    const known = next[sample.metric];
    const buffer = (known?.samples ?? []) as LiveSample[];
    appendSample(buffer, { t: Date.parse(sample.t), value: sample.value }, LIVE_SAMPLE_LIMIT);
    next[sample.metric] = {
      unit: sample.unit,
      samples: buffer,
      version: (known?.version ?? 0) + 1,
    };
  }
  return next;
}

/**
 * REST reads that a clock moving into a new hour or shift makes stale (prefixes of
 * `queryKeys` in api/queries.ts, which imports this module): the hourly OEE, and with a new shift
 * also the shift's OEE and the shifts (current one and list).
 */
const HOUR_READS = [['oee']] as const;
const SHIFT_READS = [['oee'], ['shift-oee'], ['shifts']] as const;

const movedOn = (known: OeeBucketDto | null | undefined, next: OeeBucketDto | null): boolean =>
  known !== null && known !== undefined && next !== null && next.key !== known.key;

/**
 * A pushed OEE pair replaces what the topic held: only the buckets the plant clock is in are
 * kept, so a bucket the clock has left is read from REST again (its last push may be older than
 * what REST answers now, e.g. not yet final).
 */
function applyOee(
  queryClient: QueryClient,
  topic: string,
  hour: OeeBucketDto | null,
  shift: OeeBucketDto | null,
): void {
  const key = liveKeys.oee(topic.slice('oee:'.length));
  const known = queryClient.getQueryData<LiveOee>(key);
  queryClient.setQueryData<LiveOee>(key, { hour, shift });
  const reads = movedOn(known?.shift, shift)
    ? SHIFT_READS
    : movedOn(known?.hour, hour)
      ? HOUR_READS
      : [];
  for (const queryKey of reads) void queryClient.invalidateQueries({ queryKey });
}

/** REST reads of line OEE (`queryKeys.lineOeeAll`), stale when the clock moves on an hour. */
const LINE_READS = [['line-oee']] as const;

const lineMovedOn = (known: LineBucketDto | null | undefined, next: LineBucketDto | null) =>
  known !== null && known !== undefined && next !== null && next.key !== known.key;

/**
 * A pushed line OEE (#233) replaces what `oee:line` held: only the hour and shift the plant clock
 * is in are kept, so a bucket the clock has left is read from REST again, as for `applyOee`.
 */
function applyLineOee(queryClient: QueryClient, value: LiveLineOee): void {
  const known = queryClient.getQueryData<LiveLineOee>(liveKeys.lineOee);
  queryClient.setQueryData<LiveLineOee>(liveKeys.lineOee, value);
  if (lineMovedOn(known?.hour, value.hour) || lineMovedOn(known?.shift, value.shift)) {
    for (const queryKey of LINE_READS) void queryClient.invalidateQueries({ queryKey });
  }
}

/** A pushed order OEE (#233) is the whole body of `GET /oee/orders/{id}`: it replaces the last. */
function applyOrderOee(queryClient: QueryClient, topic: string, order: OrderOeeDto | null): void {
  queryClient.setQueryData<OrderOeeDto | null>(
    liveKeys.orderOee(topic.slice('oee:order:'.length)),
    order,
  );
}

/**
 * Whether `incoming` is at least as new as `known`, for the same record id: a higher coding-set
 * `version` wins; at the same version a closed record beats an open one, then the longer one.
 */
export function isNewerRecord(incoming: DowntimeRecordDto, known: DowntimeRecordDto): boolean {
  if (incoming.version !== known.version) return incoming.version > known.version;
  if ((incoming.end === null) !== (known.end === null)) return incoming.end !== null;
  return incoming.ms >= known.ms;
}

function mergeDowntime(
  live: LiveDowntime | undefined,
  record: DowntimeRecordDto,
  removed: boolean,
): LiveDowntime {
  const base = live ?? { records: {}, seq: 0 };
  const known = base.records[record.id];
  // Deltas are upserts by id (docs/api/realtime.md); a removal always applies.
  if (known && !removed && !known.removed && !isNewerRecord(record, known.record)) {
    return { records: base.records, seq: base.seq + 1 };
  }
  let records: Record<string, LiveRecord> = { ...base.records, [record.id]: { record, removed } };
  const ids = Object.keys(records);
  if (ids.length > LIVE_DOWNTIME_LIMIT) {
    const kept = Object.values(records)
      .sort((a, b) => Date.parse(b.record.start) - Date.parse(a.record.start))
      .slice(0, LIVE_DOWNTIME_LIMIT);
    records = Object.fromEntries(kept.map((entry) => [entry.record.id, entry]));
  }
  return { records, seq: base.seq + 1 };
}

/** A record the app learned otherwise (a write's answer), merged like a pushed upsert. */
export function upsertRecord(queryClient: QueryClient, record: DowntimeRecordDto): void {
  queryClient.setQueryData<LiveDowntime>(liveKeys.downtime, (live) =>
    mergeDowntime(live, record, false),
  );
}

const NO_ALARMS: LiveAlarms = { occurrences: {}, points: {}, seq: 0 };

/**
 * An occurrence upsert by id under the monotonic rule (`newerOccurrence`): a copy that lacks a
 * step the known one has taken (acknowledged, ended, closed, final, a comment) never replaces it.
 */
function mergeOccurrence(live: LiveAlarms | undefined, occurrence: AlarmOccurrenceDto): LiveAlarms {
  const base = live ?? NO_ALARMS;
  const known = base.occurrences[occurrence.id];
  const kept = known ? newerOccurrence(known, occurrence) : occurrence;
  if (kept === known) return { ...base, seq: base.seq + 1 };
  let occurrences: Record<string, AlarmOccurrenceDto> = {
    ...base.occurrences,
    [occurrence.id]: kept,
  };
  if (!known && Object.keys(occurrences).length > LIVE_ALARM_LIMIT) {
    // One new entry can push the set over the limit by one: drop the oldest, in one linear pass
    // (sorting the whole set on every push would be O(n log n) per message at the limit).
    let oldest: AlarmOccurrenceDto | undefined;
    for (const item of Object.values(occurrences)) {
      if (!oldest || Date.parse(item.raisedAt) < Date.parse(oldest.raisedAt)) oldest = item;
    }
    if (oldest) {
      const dropId = oldest.id;
      occurrences = Object.fromEntries(Object.entries(occurrences).filter(([id]) => id !== dropId));
    }
  }
  return { occurrences, points: base.points, seq: base.seq + 1 };
}

/** A point upsert: the higher shelf `version` wins (the MES raises it with every change). */
function mergePoint(live: LiveAlarms | undefined, point: AlarmPointDto): LiveAlarms {
  const base = live ?? NO_ALARMS;
  const key = pointKey(point.equipment, point.code);
  const known = base.points[key];
  const kept = known ? newerPoint(known, point) : point;
  if (kept === known) return { ...base, seq: base.seq + 1 };
  return {
    occurrences: base.occurrences,
    points: { ...base.points, [key]: kept },
    seq: base.seq + 1,
  };
}

/** An occurrence the app learned otherwise (a write's answer), merged like a pushed upsert. */
export function upsertOccurrence(queryClient: QueryClient, occurrence: AlarmOccurrenceDto): void {
  queryClient.setQueryData<LiveAlarms>(liveKeys.alarms, (live) =>
    mergeOccurrence(live, occurrence),
  );
}

/**
 * Forgets every pushed alarm and point. The `alarms` topic has no snapshot, so pushed copies are
 * only current while the topic is held: a screen starts from an empty set and the REST reads when
 * it subscribes, and drops the set when it lets go (`useAlarmsTopic`).
 */
export function resetLiveAlarms(queryClient: QueryClient): void {
  if (queryClient.getQueryData(liveKeys.alarms) === undefined) return;
  queryClient.setQueryData<LiveAlarms>(liveKeys.alarms, (live) => ({
    ...NO_ALARMS,
    seq: (live?.seq ?? 0) + 1,
  }));
}

/** Forgets the pushed copies of some occurrences, so the next REST read (or push) decides. */
export function dropLiveOccurrences(queryClient: QueryClient, ids: readonly string[]): void {
  const live = queryClient.getQueryData<LiveAlarms>(liveKeys.alarms);
  if (!live || !ids.some((id) => id in live.occurrences)) return;
  const dropped = new Set(ids);
  const occurrences = Object.fromEntries(
    Object.entries(live.occurrences).filter(([id]) => !dropped.has(id)),
  );
  queryClient.setQueryData<LiveAlarms>(liveKeys.alarms, {
    occurrences,
    points: live.points,
    seq: live.seq + 1,
  });
}

/** A point the app learned from a shelve or unshelve answer, merged like a pushed one. */
export function upsertPoint(queryClient: QueryClient, point: AlarmPointDto): void {
  queryClient.setQueryData<LiveAlarms>(liveKeys.alarms, (live) => mergePoint(live, point));
}

/** REST reads of the alarm KPI page; a clock moving into a new hour or shift makes them stale. */
const ALARM_KPI_READS = [['alarm-kpi']] as const;

const kpiMovedOn = (
  known: AlarmKpiBucketDto | null | undefined,
  next: AlarmKpiBucketDto | null,
): boolean => known !== null && known !== undefined && next !== null && next.key !== known.key;

/** A pushed alarm KPI triple replaces what the topic held, as for OEE (`applyOee`). */
function applyAlarmKpi(queryClient: QueryClient, topic: string, value: LiveAlarmKpi): void {
  const key = liveKeys.alarmKpi(topic.slice('alarm-kpi:'.length));
  const known = queryClient.getQueryData<LiveAlarmKpi>(key);
  queryClient.setQueryData<LiveAlarmKpi>(key, value);
  if (kpiMovedOn(known?.hour, value.hour) || kpiMovedOn(known?.shift, value.shift)) {
    for (const queryKey of ALARM_KPI_READS) void queryClient.invalidateQueries({ queryKey });
  }
}

const NO_SHIFTS: LiveShifts = { instances: {}, notes: {}, seq: 0 };

/** An instance upsert: kept only when newer by the MES's push rule (`isNewerShift`). */
function mergeShift(live: LiveShifts | undefined, record: ShiftRecordDto): LiveShifts {
  const base = live ?? NO_SHIFTS;
  const key = instanceKey(record.epoch, record.key);
  const known = base.instances[key];
  if (known && !isNewerShift(record, known)) return { ...base, seq: base.seq + 1 };
  return { ...base, instances: { ...base.instances, [key]: record }, seq: base.seq + 1 };
}

/** A note upsert: the higher `version` wins (every edit raises it). */
function mergeNote(live: LiveShifts | undefined, note: HandoverNoteDto): LiveShifts {
  const base = live ?? NO_SHIFTS;
  const known = base.notes[String(note.id)];
  if (known && known.version >= note.version) return { ...base, seq: base.seq + 1 };
  return { ...base, notes: { ...base.notes, [String(note.id)]: note }, seq: base.seq + 1 };
}

/** An instance the app learned otherwise (a note write's answer), merged like a push. */
export function upsertShift(queryClient: QueryClient, record: ShiftRecordDto): void {
  queryClient.setQueryData<LiveShifts>(liveKeys.shifts, (live) => mergeShift(live, record));
}

/** A note the app learned from a write's answer, merged like a pushed one. */
export function upsertNote(queryClient: QueryClient, note: HandoverNoteDto): void {
  queryClient.setQueryData<LiveShifts>(liveKeys.shifts, (live) => mergeNote(live, note));
}

/**
 * Forgets every pushed instance and note. The `shifts` topic has no snapshot (as `alarms`, the
 * lesson of #145): pushed copies are only current while the topic is held, so a screen starts
 * from an empty set and its REST reads when it subscribes, and drops the set when it lets go.
 */
export function resetLiveShifts(queryClient: QueryClient): void {
  if (queryClient.getQueryData(liveKeys.shifts) === undefined) return;
  queryClient.setQueryData<LiveShifts>(liveKeys.shifts, (live) => ({
    ...NO_SHIFTS,
    seq: (live?.seq ?? 0) + 1,
  }));
}

const NO_ORDERS: LiveOrders = { orders: {}, commands: {}, seq: 0 };

/** An order upsert: kept only when at least as new (`version`, then `updatedAt`). */
function mergeOrder(live: LiveOrders | undefined, order: OrderDto): LiveOrders {
  const base = live ?? NO_ORDERS;
  const known = base.orders[order.id];
  if (known && !isNewerOrder(order, known)) return { ...base, seq: base.seq + 1 };
  return { ...base, orders: { ...base.orders, [order.id]: order }, seq: base.seq + 1 };
}

/** A command upsert: kept only when at least as new (`updatedAt`). */
function mergeCommand(live: LiveOrders | undefined, command: CommandDto): LiveOrders {
  const base = live ?? NO_ORDERS;
  const known = base.commands[command.commandId];
  if (known && !isNewerCommand(command, known)) return { ...base, seq: base.seq + 1 };
  return {
    ...base,
    commands: { ...base.commands, [command.commandId]: command },
    seq: base.seq + 1,
  };
}

/** An order the app learned from a write's answer, merged like a pushed one. */
export function upsertOrder(queryClient: QueryClient, order: OrderDto): void {
  queryClient.setQueryData<LiveOrders>(liveKeys.orders, (live) => mergeOrder(live, order));
}

/** A command the app learned from a write's answer, merged like a pushed one. */
export function upsertCommand(queryClient: QueryClient, command: CommandDto): void {
  queryClient.setQueryData<LiveOrders>(liveKeys.orders, (live) => mergeCommand(live, command));
}

/**
 * Forgets every pushed order and command. The `orders` topic has no snapshot (the client reads
 * first, then applies upserts, #174): pushed copies are only current while the topic is held, so
 * a screen starts from an empty set and its REST reads when it subscribes, and drops the set when
 * it lets go (the lesson of #145 and #146).
 */
export function resetLiveOrders(queryClient: QueryClient): void {
  if (queryClient.getQueryData(liveKeys.orders) === undefined) return;
  queryClient.setQueryData<LiveOrders>(liveKeys.orders, (live) => ({
    ...NO_ORDERS,
    seq: (live?.seq ?? 0) + 1,
  }));
}

/**
 * Every read of the orders screens (prefixes of `queryKeys.orders`, `order`, `orderExecution`,
 * `orderScrap` and `executionIncidents` in api/queries.ts, which imports this module).
 */
export const ORDER_READS = [
  'orders',
  'order',
  'order-execution',
  'order-scrap',
  'execution-incidents',
] as const;

/**
 * Reads of one order a push makes stale: the push carries the order and its commands, not the
 * deliveries, results, confirmations, ERP messages, history or execution (no execution push yet),
 * so the order's open screen reads them again (only active queries refetch). Prefixes of
 * `queryKeys` in api/queries.ts, which imports this module.
 */
function orderReadsStale(queryClient: QueryClient, orderId: string): void {
  for (const prefix of ['order', 'order-execution', 'order-scrap', 'execution-incidents']) {
    void queryClient.invalidateQueries({ queryKey: [prefix, orderId] });
  }
}

/**
 * The trace reads (#202, `queryKeys.traceAll` in api/queries.ts, which imports this module): a
 * hold push, an order pushed `completed` or `closed`, or a confirmed subscription makes them stale; only an open trace page
 * refetches (a read under way is restarted, so it can't answer from before the change).
 */
export const TRACE_READS = ['trace'] as const;

function traceReadsStale(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: TRACE_READS });
}

/**
 * Options of the `['live', …]` queries. Pushed data changes many times a second: structural
 * sharing would compare whole sample buffers on every message (and, as buffers are appended in
 * place, would keep the old object). States live as long as the tab; a machine's telemetry is
 * dropped a minute after its detail screen, the only reader and subscriber, is gone.
 */
export function setLiveQueryDefaults(queryClient: QueryClient): void {
  queryClient.setQueryDefaults(liveKeys.all, {
    staleTime: Infinity,
    gcTime: Infinity,
    structuralSharing: false,
  });
  queryClient.setQueryDefaults(liveKeys.telemetryAll, { gcTime: TELEMETRY_GC_MS });
}

/** A pushed terminal view replaces what the topic held: it is the whole view (#177). */
function applyTerminal(queryClient: QueryClient, topic: string, view: TerminalViewDto): void {
  queryClient.setQueryData<TerminalViewDto>(
    liveKeys.terminal(topic.slice('terminal:'.length)),
    view,
  );
}

/** Applies one server message to the query cache; newer data always wins over older. */
export function applyMessage(queryClient: QueryClient, message: ServerMessage): void {
  switch (message.type) {
    case 'snapshot':
      if ('states' in message) {
        queryClient.setQueryData<LiveStates>(liveKeys.states, (live) =>
          mergeStates(live, message.clock, message.states),
        );
      } else if ('floods' in message) {
        applyAlarmKpi(queryClient, message.topic, {
          hour: message.hour,
          shift: message.shift,
          floods: message.floods,
        });
      } else if ('view' in message) {
        applyTerminal(queryClient, message.topic, message.view);
      } else if ('bottlenecks' in message) {
        // Line OEE (#232), followed by the OEE dashboard (#233).
        applyLineOee(queryClient, {
          productionMode: message.productionMode,
          bottlenecks: message.bottlenecks,
          hour: message.hour,
          shift: message.shift,
        });
      } else if ('order' in message) {
        // An order's OEE (#231), followed by the order detail (#233).
        applyOrderOee(queryClient, message.topic, message.order);
      } else if ('hour' in message) {
        applyOee(queryClient, message.topic, message.hour, message.shift);
      } else if ('samples' in message && message.samples.length > 0) {
        const equipment = message.topic.slice('telemetry:'.length);
        queryClient.setQueryData<LiveTelemetry>(liveKeys.telemetry(equipment), (telemetry) =>
          mergeSamples(telemetry, message.samples),
        );
      }
      return;
    case 'state':
      queryClient.setQueryData<LiveStates>(liveKeys.states, (live) =>
        mergeStates(live, undefined, [message]),
      );
      return;
    case 'clock':
      queryClient.setQueryData<LiveStates>(liveKeys.states, (live) =>
        mergeStates(live, { epoch: message.epoch, watermark: message.watermark }, []),
      );
      return;
    case 'telemetry':
      queryClient.setQueryData<LiveTelemetry>(liveKeys.telemetry(message.equipment), (telemetry) =>
        mergeSamples(telemetry, [message]),
      );
      return;
    case 'oee':
      applyOee(queryClient, message.topic, message.hour, message.shift);
      return;
    // Order OEE (#231) on the order detail, line OEE (#232) on the OEE dashboard (#233).
    case 'oee-order':
      applyOrderOee(queryClient, message.topic, message.order);
      return;
    case 'oee-line':
      applyLineOee(queryClient, {
        productionMode: message.productionMode,
        bottlenecks: message.bottlenecks,
        hour: message.hour,
        shift: message.shift,
      });
      return;
    case 'downtime':
      queryClient.setQueryData<LiveDowntime>(liveKeys.downtime, (live) =>
        mergeDowntime(live, message.record, message.event === 'removed'),
      );
      return;
    case 'alarm':
      upsertOccurrence(queryClient, message.occurrence);
      return;
    case 'alarm-point':
      upsertPoint(queryClient, message.point);
      return;
    case 'alarm-kpi':
      applyAlarmKpi(queryClient, message.topic, {
        hour: message.hour,
        shift: message.shift,
        floods: message.floods,
      });
      return;
    case 'shift':
      upsertShift(queryClient, message.shift);
      return;
    case 'handover-note':
      upsertNote(queryClient, message.note);
      return;
    case 'terminal':
      applyTerminal(queryClient, message.topic, message.view);
      return;
    // The `orders` topic (#174, #176): upserts, and the open order's other reads again.
    case 'order':
      upsertOrder(queryClient, message.order);
      orderReadsStale(queryClient, message.order.id);
      // An order completing closes its last carton (ADR-0034); genealogy has no push of its own.
      // Other order changes (release, dispatch, start) change no trace answer.
      if (message.order.status === 'completed' || message.order.status === 'closed') {
        traceReadsStale(queryClient);
      }
      return;
    case 'command':
      upsertCommand(queryClient, message.command);
      orderReadsStale(queryClient, message.command.orderId);
      // The list shows the order's `dispatched`: read it again too (#176 review H1).
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      return;
    // The `quality` topic (#200, holds #201; screens #203): upserts by id (live-quality.ts).
    case 'spc-signal':
    case 'spc-characteristic':
    case 'quality-hold':
      applyQualityMessage(queryClient, message);
      // A hold opened, decided or its scope grew: the trace pages name holds on every node and
      // a carton's `held` (#202).
      if (message.type === 'quality-hold') traceReadsStale(queryClient);
      return;
    case 'subscribed':
      // `orders` has no snapshot: a change between the screen's read and the subscription taking
      // effect would never arrive, so the order reads are read again once it has (#176 review).
      if (message.topic === 'orders') {
        for (const prefix of ORDER_READS)
          void queryClient.invalidateQueries({ queryKey: [prefix] });
      }
      // Nor has `quality`: a hold change before the subscription took effect is read again.
      if (message.topic === 'quality' || message.topic === 'orders') traceReadsStale(queryClient);
      // `quality` has no snapshot either (#203).
      if (message.topic === 'quality') {
        for (const queryKey of QUALITY_READS) void queryClient.invalidateQueries({ queryKey });
      }
      return;
    case 'unsubscribed':
    case 'error':
      return;
  }
}

/**
 * Feeds every message of the live client into the query cache, and after a reconnect refetches
 * what was read over REST (intervals and series may have grown while pushes were missed); the
 * resubscription brings fresh snapshots. Returns the disconnect.
 */
export function connectLiveToCache(client: LiveClient, queryClient: QueryClient): () => void {
  setLiveQueryDefaults(queryClient);
  let wasLost = false;
  const stopStatus = client.onStatus(() => {
    // Lost: a dropped connection (reconnecting) or a stop, such as a 4401 close or a logout
    // (#170 review M2): pushes in between are missed either way.
    if (client.status === 'reconnecting' || client.status === 'stopped') wasLost = true;
    else if (client.status === 'open' && wasLost) {
      wasLost = false;
      // Alarm upserts missed while the connection was lost may have changed fields the
      // monotonic rule can't order (a shelf, an end reason): start again from the REST reads
      // below and the pushes from now on (the `alarms` topic has no snapshot).
      resetLiveAlarms(queryClient);
      // The same for shift instances and notes (#146): no snapshot, so missed pushes are lost.
      resetLiveShifts(queryClient);
      // And for orders and commands (#176): the `orders` topic has no snapshot either.
      resetLiveOrders(queryClient);
      // And for SPC episodes, holds and characteristics (#203).
      resetLiveQuality(queryClient);
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'live' });
    }
  });
  const stopMessages = client.onMessage((message) => {
    applyMessage(queryClient, message);
  });
  return () => {
    stopStatus();
    stopMessages();
  };
}
