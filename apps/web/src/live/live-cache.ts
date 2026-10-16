import type { Clock, CurrentStateDto, ServerMessage } from '@shopfloor/contracts/mes-api';
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

export const liveKeys = {
  all: ['live'] as const,
  states: ['live', 'states'] as const,
  telemetryAll: ['live', 'telemetry'] as const,
  telemetry: (equipment: string) => ['live', 'telemetry', equipment] as const,
};

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
        // OEE snapshots (#120) carry no samples; the OEE screens (#122) will cache them.
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
    // OEE and downtime topics (#120): the web app doesn't subscribe to them before #122.
    case 'subscribed':
    case 'unsubscribed':
    case 'error':
    case 'oee':
    case 'downtime':
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
