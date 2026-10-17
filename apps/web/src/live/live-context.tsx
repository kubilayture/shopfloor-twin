import {
  ALARMS_TOPIC,
  ORDERS_TOPIC,
  QUALITY_TOPIC,
  SHIFTS_TOPIC,
  terminalTopic,
  type TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import {
  liveKeys,
  resetLiveAlarms,
  ORDER_READS,
  resetLiveOrders,
  resetLiveShifts,
  TRACE_READS,
  type LiveAlarmKpi,
  type LiveAlarms,
  type LiveDowntime,
  type LiveOee,
  type LiveOrders,
  type LiveShifts,
  type LiveStates,
  type LiveTelemetry,
} from './live-cache.ts';
import type { LiveClient, LiveStatus } from './live-client.ts';
import {
  QUALITY_READS,
  liveQualityKey,
  resetLiveQuality,
  type LiveQuality,
} from './live-quality.ts';

const LiveContext = createContext<LiveClient | undefined>(undefined);

export function LiveProvider({ client, children }: { client: LiveClient; children: ReactNode }) {
  return <LiveContext value={client}>{children}</LiveContext>;
}

export function useLiveClient(): LiveClient {
  const client = use(LiveContext);
  if (!client) throw new Error('useLiveClient needs a LiveProvider');
  return client;
}

export interface LiveConnection {
  readonly status: LiveStatus;
  readonly attempt: number;
}

export function useLiveConnection(): LiveConnection {
  const client = useLiveClient();
  return useSyncExternalStore(
    (listener) => client.onStatus(listener),
    () => client.connection,
  );
}

/** Holds a subscription while the component is mounted. */
export function useLiveSubscription(topic: string | undefined, metric?: string): void {
  const client = useLiveClient();
  useEffect(() => {
    if (topic === undefined) return undefined;
    return client.subscribe(topic, metric);
  }, [client, topic, metric]);
}

/**
 * Holds the `alarms` topic for the alarm list. The topic has no snapshot, so pushed copies kept
 * from an earlier visit may be stale (changes made while nobody was subscribed never arrive):
 * the pushed set is emptied and the REST lists read again before subscribing, and emptied again
 * when the screen lets go.
 */
export function useAlarmsTopic(): void {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useEffect(() => {
    resetLiveAlarms(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['alarms'] });
    void queryClient.invalidateQueries({ queryKey: ['alarm-points'] });
    const release = client.subscribe(ALARMS_TOPIC);
    return () => {
      release();
      resetLiveAlarms(queryClient);
    };
  }, [client, queryClient]);
}

/**
 * Holds the `shifts` topic for the shift screens (#146), as `useAlarmsTopic`: the topic has no
 * snapshot, so the pushed instances and notes are emptied and the REST reads (instances, reports,
 * notes) read again before subscribing, and emptied again when the screen lets go.
 */
export function useShiftsTopic(): void {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useEffect(() => {
    resetLiveShifts(queryClient);
    for (const prefix of ['shift-instance', 'shift-report', 'shift-notes', 'note-audit']) {
      void queryClient.invalidateQueries({ queryKey: [prefix] });
    }
    const release = client.subscribe(SHIFTS_TOPIC);
    return () => {
      release();
      resetLiveShifts(queryClient);
    };
  }, [client, queryClient]);
}

/**
 * Holds `terminal:<workCenter>` (#177) and returns the view it pushes. The pushed copy is dropped
 * when the screen lets go, so a later visit (perhaps by someone else) starts from a fresh
 * snapshot, never from what was shown before.
 */
export function useLiveTerminal(workCenter: string): TerminalViewDto | undefined {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useEffect(() => {
    const key = liveKeys.terminal(workCenter);
    queryClient.removeQueries({ queryKey: key, exact: true });
    const release = client.subscribe(terminalTopic(workCenter));
    return () => {
      release();
      queryClient.removeQueries({ queryKey: key, exact: true });
    };
  }, [client, queryClient, workCenter]);
  return useQuery<TerminalViewDto>({ queryKey: liveKeys.terminal(workCenter), queryFn: skipToken })
    .data;
}

/**
 * Holds the `orders` topic for the orders screens (#176), as `useAlarmsTopic`: the topic has no
 * snapshot, so the pushed orders and commands are emptied and the order reads (list, detail,
 * execution) read again before subscribing, and emptied again when the screen lets go.
 */
export function useOrdersTopic(): void {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useEffect(() => {
    resetLiveOrders(queryClient);
    for (const prefix of ORDER_READS) {
      void queryClient.invalidateQueries({ queryKey: [prefix] });
    }
    const release = client.subscribe(ORDERS_TOPIC);
    return () => {
      release();
      resetLiveOrders(queryClient);
    };
  }, [client, queryClient]);
}

/**
 * Holds what the trace pages follow (#202). Genealogy has no push: `quality` brings hold changes
 * (opened, decided, scope grown) and `orders` an order completed or closed (its last carton
 * closes); each
 * reads the trace answers again (`connectLiveToCache`), and so does the confirmed subscription,
 * as neither topic has a snapshot. Everything else a trace shows grows with facts and is polled
 * (`tracePollMs`). The orders topic is held as the orders screens hold it (`useOrdersTopic`), so
 * its pushed set starts empty and is emptied again when the page lets go.
 */
export function useTraceTopics(): void {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useOrdersTopic();
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: TRACE_READS });
    return client.subscribe(QUALITY_TOPIC);
  }, [client, queryClient]);
}

/**
 * Holds the `quality` topic for the SPC, holds and order screens (#203), as `useOrdersTopic`: no
 * snapshot, so the pushed episodes, holds and characteristics are emptied and the quality reads
 * read again before subscribing, and emptied again when the screen lets go.
 */
export function useQualityTopic(): void {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useEffect(() => {
    resetLiveQuality(queryClient);
    for (const queryKey of QUALITY_READS) void queryClient.invalidateQueries({ queryKey });
    const release = client.subscribe(QUALITY_TOPIC);
    return () => {
      release();
      resetLiveQuality(queryClient);
    };
  }, [client, queryClient]);
}

/** Pushed episodes, holds and characteristics (hold the topic with `useQualityTopic`). */
export function useLiveQuality(): LiveQuality | undefined {
  return useQuery<LiveQuality>({ queryKey: liveQualityKey, queryFn: skipToken }).data;
}

/** Pushed orders and commands (hold the topic with `useOrdersTopic`). */
export function useLiveOrders(): LiveOrders | undefined {
  return useQuery<LiveOrders>({ queryKey: liveKeys.orders, queryFn: skipToken }).data;
}

/** Pushed shift instances and handover notes (hold the topic with `useShiftsTopic`). */
export function useLiveShifts(): LiveShifts | undefined {
  return useQuery<LiveShifts>({ queryKey: liveKeys.shifts, queryFn: skipToken }).data;
}

/** Holds several topics' subscriptions while the component is mounted. */
export function useLiveSubscriptions(topics: readonly string[]): void {
  const client = useLiveClient();
  const key = topics.join('\n');
  useEffect(() => {
    if (key === '') return undefined;
    const releases = key.split('\n').map((topic) => client.subscribe(topic));
    return () => {
      for (const release of releases) release();
    };
  }, [client, key]);
}

/** The pushed states and plant clock (filled by `connectLiveToCache`). */
export function useLiveStates(): LiveStates | undefined {
  return useQuery<LiveStates>({ queryKey: liveKeys.states, queryFn: skipToken }).data;
}

/** Pushed OEE buckets of `oee:<id>` (subscribe with `useLiveSubscription`). */
export function useLiveOee(id: string): LiveOee | undefined {
  return useQuery<LiveOee>({ queryKey: liveKeys.oee(id), queryFn: skipToken }).data;
}

/** Pushed downtime records (subscribe to `downtime` with `useLiveSubscription`). */
export function useLiveDowntime(): LiveDowntime | undefined {
  return useQuery<LiveDowntime>({ queryKey: liveKeys.downtime, queryFn: skipToken }).data;
}

/** Pushed alarm occurrences and points (subscribe to `alarms` with `useLiveSubscription`). */
export function useLiveAlarms(): LiveAlarms | undefined {
  return useQuery<LiveAlarms>({ queryKey: liveKeys.alarms, queryFn: skipToken }).data;
}

/** Pushed alarm KPIs of `alarm-kpi:<scope>` (`plant`, `position:<id>`, `equipment:<id>`). */
export function useLiveAlarmKpi(scope: string): LiveAlarmKpi | undefined {
  return useQuery<LiveAlarmKpi>({ queryKey: liveKeys.alarmKpi(scope), queryFn: skipToken }).data;
}

export function useLiveTelemetry(equipment: string): LiveTelemetry | undefined {
  return useQuery<LiveTelemetry>({ queryKey: liveKeys.telemetry(equipment), queryFn: skipToken })
    .data;
}
