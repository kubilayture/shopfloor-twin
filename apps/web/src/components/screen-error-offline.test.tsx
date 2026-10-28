import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import { OfflineBar } from './offline-bar.tsx';
import { ScreenError, screenErrors, type ScreenRead } from './screen-error.tsx';

/** #394: a `ScreenError` of several reads under the offline bar, and after it. */

const live = vi.hoisted(() => ({ lost: true }));
vi.mock('../live/live-context.tsx', () => ({
  useConnectionLost: () => live.lost,
  useLiveConnection: () => ({ status: live.lost ? 'reconnecting' : 'open', offline: false }),
}));
vi.mock('../api/queries.ts', () => ({ usePlantClock: () => ({ clock: null, known: false }) }));

const unreachable = () => new ApiError('The MES cannot be reached', 0);
const failed = (key: string, error: unknown): ScreenRead => ({
  key,
  what: `the ${key}`,
  kind: 'main',
  failed: true,
  error,
  hasData: false,
  loading: false,
  retrying: false,
  failedAt: 1,
  answeredAt: 1,
  retry: () => undefined,
});

describe('ScreenError and the offline bar', () => {
  it('is quiet under the bar, stays quiet after it, and is loud once any of its reads failed anew', () => {
    const queryClient = new QueryClient();
    const a = unreachable();
    const b = unreachable();
    const view = (reads: readonly ScreenRead[]) => (
      <QueryClientProvider client={queryClient}>
        <OfflineBar />
        <ScreenError errors={screenErrors(reads)} testId="screen-error" />
      </QueryClientProvider>
    );
    const { rerender } = render(view([failed('a', a), failed('b', b)]));
    // The bar is the one alert; the screen's error one quiet line.
    expect(screen.getAllByRole('alert')).toEqual([screen.getByTestId('offline-bar')]);
    expect(screen.getByTestId('screen-error').dataset.error).toBe('quiet');

    // Back: the same failures stay quiet until their reads run again.
    live.lost = false;
    rerender(view([failed('a', a), failed('b', b)]));
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    expect(screen.getByTestId('screen-error').dataset.error).toBe('quiet');

    // One read failed again with the connection back: the error is said aloud.
    rerender(view([failed('a', a), failed('b', unreachable())]));
    expect(screen.getByRole('alert').dataset.testid).toBe('screen-error');
  });
});
