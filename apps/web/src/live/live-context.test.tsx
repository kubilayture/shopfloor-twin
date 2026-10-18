import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { signal } from '../test/quality-fixtures.ts';
import { socketFactory } from '../test/fake-socket.ts';
import { applyMessage, connectLiveToCache } from './live-cache.ts';
import { LiveClient } from './live-client.ts';
import { LiveProvider, useQualityTopic, useTraceTopics } from './live-context.tsx';
import { liveQualityKey, type LiveQuality } from './live-quality.ts';

afterEach(cleanup);

const pushed = (client: QueryClient) =>
  Object.keys(client.getQueryData<LiveQuality>(liveQualityKey)?.signals ?? {});

function setup() {
  const queryClient = new QueryClient();
  const factory = socketFactory();
  const live = new LiveClient({ url: 'ws://test', createSocket: factory.create });
  connectLiveToCache(live, queryClient);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <LiveProvider client={live}>{children}</LiveProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('the quality topic held by a screen (#203 final review)', () => {
  for (const [name, hook] of [
    ['useQualityTopic', useQualityTopic],
    ['useTraceTopics', useTraceTopics],
  ] as const) {
    it(`${name} empties the pushed quality set when it mounts and again when it lets go`, () => {
      const { queryClient, wrapper } = setup();
      // Pushed while another screen held the topic.
      applyMessage(queryClient, { type: 'spc-signal', event: 'opened', signal: signal(1) });
      expect(pushed(queryClient)).toEqual(['1']);
      const { unmount } = renderHook(
        () => {
          hook();
        },
        { wrapper },
      );
      expect(pushed(queryClient)).toEqual([]);
      applyMessage(queryClient, { type: 'spc-signal', event: 'opened', signal: signal(2) });
      expect(pushed(queryClient)).toEqual(['2']);
      unmount();
      // Nothing pushed while nobody holds the topic survives to the next screen.
      expect(pushed(queryClient)).toEqual([]);
    });
  }
});
