import { skipToken, useQuery } from '@tanstack/react-query';
import { createContext, use, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import {
  liveKeys,
  type LiveDowntime,
  type LiveOee,
  type LiveStates,
  type LiveTelemetry,
} from './live-cache.ts';
import type { LiveClient, LiveStatus } from './live-client.ts';

const LiveContext = createContext<LiveClient | undefined>(undefined);

export function LiveProvider({ client, children }: { client: LiveClient; children: ReactNode }) {
  return <LiveContext value={client}>{children}</LiveContext>;
}

function useLiveClient(): LiveClient {
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

export function useLiveTelemetry(equipment: string): LiveTelemetry | undefined {
  return useQuery<LiveTelemetry>({ queryKey: liveKeys.telemetry(equipment), queryFn: skipToken })
    .data;
}
