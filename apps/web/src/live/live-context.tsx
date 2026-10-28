import {
  ALARMS_TOPIC,
  LINE_OEE_TOPIC,
  ORDERS_TOPIC,
  QUALITY_TOPIC,
  SHIFTS_TOPIC,
  terminalTopic,
  type OrderOeeDto,
  type TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  holdOrderOee,
  liveKeys,
  orderOeeTopic,
  resetLiveAlarms,
  ORDER_READS,
  resetLiveOrders,
  resetLiveShifts,
  TRACE_READS,
  type LiveAlarmKpi,
  type LiveAlarms,
  type LiveDowntime,
  type LiveLineOee,
  type LiveOee,
  type LiveOrders,
  type LiveShifts,
  type LiveStates,
  type LiveTelemetry,
} from './live-cache.ts';
import type { LiveClient, LiveConnectionState } from './live-client.ts';
import {
  QUALITY_READS,
  liveQualityKey,
  resetLiveQuality,
  type LiveQuality,
} from './live-quality.ts';

const LiveContext = createContext<LiveClient | undefined>(undefined);

/**
 * Gives the screens the live client, and tells it when the browser says the network went or came
 * back (#312): the socket of a lost network may look open for a long while, so the header would
 * keep "Live" over figures that no longer update.
 */
export function LiveProvider({ client, children }: { client: LiveClient; children: ReactNode }) {
  useEffect(() => {
    const lost = () => {
      client.connectionLost();
    };
    const found = () => {
      client.connectionFound();
    };
    window.addEventListener('offline', lost);
    window.addEventListener('online', found);
    if (!navigator.onLine) lost();
    return () => {
      window.removeEventListener('offline', lost);
      window.removeEventListener('online', found);
    };
  }, [client]);
  return <LiveContext value={client}>{children}</LiveContext>;
}

export function useLiveClient(): LiveClient {
  const client = use(LiveContext);
  if (!client) throw new Error('useLiveClient needs a LiveProvider');
  return client;
}

export type LiveConnection = LiveConnectionState;

/**
 * Reconnecting this long counts as lost even before a second attempt failed: behind the stack's
 * nginx a handshake to a stopped MES hangs until its 60 s timeout, so the attempt count alone
 * would show nothing for a minute.
 */
export const LOST_AFTER_MS = 5_000;

/**
 * The connection counts as lost (design system 4.11; #317 after #343): the browser is offline,
 * or the socket failed to come back at least once since it was last open (attempt 2 onwards, as
 * the header counts them). Connecting or reconnecting for `LOST_AFTER_MS` counts too
 * (`useConnectionLost`).
 * A single quick reconnect, after a blip or right after the network returns, is not a loss.
 */
export function isConnectionLost(connection: LiveConnectionState): boolean {
  return connection.offline || (connection.status === 'reconnecting' && connection.attempt >= 2);
}

const NO_CLIENT = () => () => undefined;
const IDLE: LiveConnectionState = { status: 'stopped', attempt: 0, offline: false };

/**
 * Whether the connection is lost: `isConnectionLost`, or connecting or reconnecting for
 * `LOST_AFTER_MS` since the client started to (one clock for every caller, so the bar and the error views agree). False
 * outside a `LiveProvider`, so a view that only adapts to it (the error view) works anywhere.
 */
export function useConnectionLost(): boolean {
  const client = use(LiveContext);
  const connection = useSyncExternalStore(
    client ? (listener) => client.onStatus(listener) : NO_CLIENT,
    client ? () => client.connection : () => IDLE,
  );
  // A first connect that hangs counts as much as a reconnect that does (#352 review L1).
  const reconnecting = connection.status === 'reconnecting' || connection.status === 'connecting';
  const since = client?.statusSince ?? 0;
  // The `since` of the reconnect that has lasted `LOST_AFTER_MS`: set by a timer, never in render.
  const [late, setLate] = useState<number | null>(null);
  useEffect(() => {
    if (!reconnecting) return undefined;
    const timer = setTimeout(
      () => {
        setLate(since);
      },
      Math.max(0, since + LOST_AFTER_MS - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [reconnecting, since]);
  return isConnectionLost(connection) || (reconnecting && late === since);
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
 * Holds `oee:order:<id>` (#233) for the order detail and returns the order OEE it pushes (null
 * for an order the MES doesn't know). One topic per open detail, against the MES's own budget of
 * 16 order OEE topics (#232), never the dashboard's 16 `oee:<id>` topics. The pushed copy is
 * dropped when the screen lets go, so a later visit starts from a fresh snapshot. `enabled`
 * false holds nothing (the order is not read yet, or the MES has no such order: #394 review).
 */
export function useLiveOrderOee(orderId: string, enabled = true): OrderOeeDto | null | undefined {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return undefined;
    // Counted per order (`holdOrderOee`): two screens on one order share the copy.
    const letGo = holdOrderOee(queryClient, orderId);
    const release = client.subscribe(orderOeeTopic(orderId));
    return () => {
      release();
      letGo();
    };
  }, [client, queryClient, orderId, enabled]);
  const pushed = useQuery<OrderOeeDto | null>({
    queryKey: liveKeys.orderOee(orderId),
    queryFn: skipToken,
  }).data;
  return enabled ? pushed : undefined;
}

/**
 * Holds `oee:line` (#233) for the OEE dashboard and returns what it pushes: the bottleneck per
 * product and the line OEE of the hour and shift the plant clock is in. Its own budget at the MES
 * (#232). Dropped when the screen lets go. One consumer at a time: only the OEE dashboard uses it
 * (one route), so its copy is not counted; a second consumer would need a count as
 * `holdOrderOee` keeps for order topics.
 */
export function useLiveLineOee(): LiveLineOee | undefined {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.removeQueries({ queryKey: liveKeys.lineOee, exact: true });
    const release = client.subscribe(LINE_OEE_TOPIC);
    return () => {
      release();
      queryClient.removeQueries({ queryKey: liveKeys.lineOee, exact: true });
    };
  }, [client, queryClient]);
  return useQuery<LiveLineOee>({ queryKey: liveKeys.lineOee, queryFn: skipToken }).data;
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
 * its pushed set starts empty and is emptied again when the page lets go; the quality topic's
 * pushed set likewise.
 */
export function useTraceTopics(): void {
  const client = useLiveClient();
  const queryClient = useQueryClient();
  useOrdersTopic();
  useEffect(() => {
    // The quality topic has no snapshot either (#203 final review): its pushed set is emptied
    // before subscribing and again when the page lets go, as `useQualityTopic` does, so a screen
    // visited later never shows episodes or holds pushed while nobody held the topic for it.
    resetLiveQuality(queryClient);
    void queryClient.invalidateQueries({ queryKey: TRACE_READS });
    const release = client.subscribe(QUALITY_TOPIC);
    return () => {
      release();
      resetLiveQuality(queryClient);
    };
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

/** Pushed OEE buckets of several work centers or machines, in the order of `ids` (UX-3). */
export function useLiveOees(ids: readonly string[]): readonly (LiveOee | undefined)[] {
  return useQueries({
    queries: ids.map((id) => ({ queryKey: liveKeys.oee(id), queryFn: skipToken })),
    combine: (results) => results.map((result) => result.data as LiveOee | undefined),
  });
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

/** `useLiveAlarmKpi` for several scopes at once, in the order of `scopes` (UX-4b: one section's cards). */
export function useLiveAlarmKpis(scopes: readonly string[]): readonly (LiveAlarmKpi | undefined)[] {
  return useQueries({
    queries: scopes.map((scope) => ({ queryKey: liveKeys.alarmKpi(scope), queryFn: skipToken })),
    combine: (results) => results.map((result) => result.data as LiveAlarmKpi | undefined),
  });
}

export function useLiveTelemetry(equipment: string): LiveTelemetry | undefined {
  return useQuery<LiveTelemetry>({ queryKey: liveKeys.telemetry(equipment), queryFn: skipToken })
    .data;
}
