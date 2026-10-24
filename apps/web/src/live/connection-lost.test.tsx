import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { socketFactory } from '../test/fake-socket.ts';
import { LiveClient } from './live-client.ts';
import { LOST_AFTER_MS, LiveProvider, useConnectionLost } from './live-context.tsx';

/** #317 after #343: when the shell counts the live connection as lost. */
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const factory = socketFactory();
  // No jitter: the first reconnect goes after 375 ms (0.75 of 500).
  const live = new LiveClient({ url: 'ws://test', createSocket: factory.create, random: () => 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveProvider client={live}>{children}</LiveProvider>
  );
  const hook = renderHook(() => useConnectionLost(), { wrapper });
  return { live, factory, hook };
}

describe('useConnectionLost', () => {
  it('counts a reconnect that hangs for 5 s as lost, though no second attempt failed yet', () => {
    // Design system 4.11: 5 s.
    expect(LOST_AFTER_MS).toBe(5_000);
    const { live, factory, hook } = setup();
    act(() => {
      live.start();
      factory.last.open();
    });
    expect(hook.result.current).toBe(false);
    act(() => {
      factory.last.drop();
    });
    expect(live.connection).toMatchObject({ status: 'reconnecting', attempt: 1 });
    // The retry's handshake hangs (a proxy waiting on a stopped MES).
    act(() => {
      vi.advanceTimersByTime(LOST_AFTER_MS - 1);
    });
    expect(factory.sockets).toHaveLength(2);
    expect(hook.result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hook.result.current).toBe(true);
    // Back: not lost, and a new reconnect starts its own 5 s.
    act(() => {
      factory.last.open();
    });
    expect(hook.result.current).toBe(false);
    act(() => {
      factory.last.drop();
      vi.advanceTimersByTime(1_000);
    });
    expect(hook.result.current).toBe(false);
  });

  it('is lost at once when a retry failed too, and never outside a provider', () => {
    const { live, factory, hook } = setup();
    act(() => {
      live.start();
      factory.last.open();
      factory.last.drop();
      vi.advanceTimersByTime(400);
    });
    expect(factory.sockets).toHaveLength(2);
    act(() => {
      factory.last.drop();
    });
    expect(live.connection.attempt).toBe(2);
    expect(hook.result.current).toBe(true);
    expect(renderHook(() => useConnectionLost()).result.current).toBe(false);
  });

  it('counts a first connect that hangs for 5 s as lost too (#352 L1)', () => {
    const { live, hook } = setup();
    act(() => {
      live.start();
    });
    expect(live.connection.status).toBe('connecting');
    act(() => {
      vi.advanceTimersByTime(LOST_AFTER_MS - 1);
    });
    expect(hook.result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hook.result.current).toBe(true);
  });

  it('stays lost when a hung first connect finally fails into the first reconnect (#352 re-review)', () => {
    const { live, factory, hook } = setup();
    act(() => {
      live.start();
    });
    act(() => {
      vi.advanceTimersByTime(LOST_AFTER_MS);
    });
    expect(hook.result.current).toBe(true);
    // The proxy gives up (a 504 after its timeout): connecting turns into reconnecting, attempt 1.
    act(() => {
      factory.last.drop();
    });
    expect(live.connection).toMatchObject({ status: 'reconnecting', attempt: 1 });
    expect(hook.result.current).toBe(true);
    // The same trying since the start: no new 5 s before it counts.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(hook.result.current).toBe(true);
  });
});
