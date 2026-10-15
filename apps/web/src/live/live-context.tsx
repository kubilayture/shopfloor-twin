import { skipToken, useQuery } from '@tanstack/react-query';
import { createContext, use, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { liveKeys, type LiveStates, type LiveTelemetry } from './live-cache.ts';
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

/** The pushed states and plant clock (filled by `connectLiveToCache`). */
export function useLiveStates(): LiveStates | undefined {
  return useQuery<LiveStates>({ queryKey: liveKeys.states, queryFn: skipToken }).data;
}

export function useLiveTelemetry(equipment: string): LiveTelemetry | undefined {
  return useQuery<LiveTelemetry>({ queryKey: liveKeys.telemetry(equipment), queryFn: skipToken })
    .data;
}
