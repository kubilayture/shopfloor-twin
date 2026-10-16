import type {
  Clock,
  CurrentStateDto,
  DowntimeRecordDto,
  OeeBucketDto,
  ServerMessage,
} from '@shopfloor/contracts/mes-api';
import type { QueryClient } from '@tanstack/react-query';
import { appendSample, type LiveSample } from '../domain/series.ts';
import { isNewer, isNewerClock } from '../domain/states.ts';
import type { LiveClient } from './live-client.ts';

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

export const liveKeys = {
  all: ['live'] as const,
  states: ['live', 'states'] as const,
  telemetryAll: ['live', 'telemetry'] as const,
  telemetry: (equipment: string) => ['live', 'telemetry', equipment] as const,
  oee: (id: string) => ['live', 'oee', id] as const,
  downtime: ['live', 'downtime'] as const,
};

/** Pushed downtime records kept (the newest by start); a shift has a few hundred at most. */
export const LIVE_DOWNTIME_LIMIT = 5_000;

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

/** Applies one server message to the query cache; newer data always wins over older. */
export function applyMessage(queryClient: QueryClient, message: ServerMessage): void {
  switch (message.type) {
    case 'snapshot':
      if ('states' in message) {
        queryClient.setQueryData<LiveStates>(liveKeys.states, (live) =>
          mergeStates(live, message.clock, message.states),
        );
      } else if ('floods' in message) {
        // Alarm KPI topics (#142) have no screen yet (#145).
        return;
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
    case 'downtime':
      queryClient.setQueryData<LiveDowntime>(liveKeys.downtime, (live) =>
        mergeDowntime(live, message.record, message.event === 'removed'),
      );
      return;
    case 'alarm':
    case 'alarm-kpi':
    case 'alarm-point':
      // Alarm occurrences, shelves (#143) and KPIs (#142) have no screen yet (#145).
      return;
    case 'subscribed':
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
    if (client.status === 'reconnecting') wasLost = true;
    else if (client.status === 'open' && wasLost) {
      wasLost = false;
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
