import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import {
  ScreenError,
  SectionError,
  TRY_AGAIN_BUSY_MAX_MS,
  namesText,
  queryRead,
  screenErrors,
  selectionRead,
  useScreenErrors,
  type ReadKind,
  type ScreenRead,
} from './screen-error.tsx';

/** #394: one error for a screen whose reads failed, a section's own only when the rest loaded. */

const unavailable = (detail = 'database down') =>
  new ApiError(`Service Unavailable: ${detail}`, 503);

function read(
  key: string,
  kind: ReadKind,
  state: 'idle' | 'loading' | 'failed' | 'loaded' | 'stale',
  error: unknown = unavailable(),
): ScreenRead {
  return {
    key,
    what: `the ${key}`,
    kind,
    failed: state === 'failed' || state === 'stale',
    error: state === 'failed' || state === 'stale' ? error : null,
    hasData: state === 'loaded' || state === 'stale',
    loading: state === 'loading',
    retrying: false,
    failedAt: state === 'failed' || state === 'stale' ? 1 : 0,
    answeredAt: state === 'idle' || state === 'loading' ? 0 : 1,
    retry: vi.fn(),
  };
}

const keys = (reads: readonly ScreenRead[]) => reads.map((r) => r.key);

describe('screenErrors', () => {
  it('names every failed read once when nothing loaded, the whole screen', () => {
    const errors = screenErrors([
      read('shifts', 'base', 'failed'),
      read('equipment', 'base', 'loaded'),
      read('oee', 'main', 'failed'),
      read('hours', 'section', 'failed'),
      read('pareto', 'section', 'idle'),
    ]);
    expect(keys(errors.summary)).toEqual(['shifts', 'oee', 'hours']);
    expect(errors.whole).toBe(true);
    // A section of a screen that did not load says nothing of its own.
    expect(errors.inSection('hours')).toBe(false);
    expect(errors.section('hours')).toBeUndefined();
  });

  it('says nothing while nothing loaded and a read is still on its way', () => {
    const errors = screenErrors([read('shifts', 'base', 'failed'), read('oee', 'main', 'loading')]);
    expect(errors.summary).toEqual([]);
    expect(errors.whole).toBe(false);
    expect(errors.inSection('shifts')).toBe(false);
  });

  it('lets the one failed section of a loaded screen say it itself', () => {
    const errors = screenErrors([
      read('oee', 'main', 'loaded'),
      read('hours', 'section', 'failed'),
      read('pareto', 'section', 'loaded'),
      // Still on its way: the screen loaded, so the failure is said at once.
      read('line', 'section', 'loading'),
    ]);
    expect(errors.summary).toEqual([]);
    expect(errors.whole).toBe(false);
    expect(errors.inSection('hours')).toBe(true);
    expect(errors.section('hours')?.own).toBe(true);
    expect(errors.inSection('pareto')).toBe(false);
  });

  it('names several failures of a loaded screen in one error, the sections quietly', () => {
    const errors = screenErrors([
      read('oee', 'main', 'loaded'),
      read('hours', 'section', 'failed'),
      read('pareto', 'section', 'failed'),
    ]);
    expect(keys(errors.summary)).toEqual(['hours', 'pareto']);
    expect(errors.whole).toBe(false);
    expect(errors.section('hours')?.own).toBe(false);
    expect(errors.section('pareto')?.own).toBe(false);
  });

  it('names a failed screen read with the screen loaded, never in a section', () => {
    const errors = screenErrors([
      read('oee', 'main', 'failed'),
      read('hours', 'section', 'loaded'),
    ]);
    expect(keys(errors.summary)).toEqual(['oee']);
    expect(errors.whole).toBe(false);
    expect(errors.inSection('oee')).toBe(false);
    const base = screenErrors([read('reasons', 'base', 'failed'), read('list', 'main', 'loaded')]);
    expect(keys(base.summary)).toEqual(['reasons']);
  });

  it('counts a base answer alone as nothing loaded', () => {
    const errors = screenErrors([
      read('scopes', 'base', 'loaded'),
      read('kpis', 'section', 'failed'),
      read('floods', 'section', 'failed'),
    ]);
    expect(keys(errors.summary)).toEqual(['kpis', 'floods']);
    expect(errors.whole).toBe(true);
    // One failed section with only a base read in is the whole screen's error too.
    const one = screenErrors([read('scopes', 'base', 'loaded'), read('kpis', 'section', 'failed')]);
    expect(keys(one.summary)).toEqual(['kpis']);
    expect(one.whole).toBe(true);
    expect(one.inSection('kpis')).toBe(false);
  });

  it('counts an earlier answer kept by a failed read as loaded', () => {
    const errors = screenErrors([
      read('list', 'section', 'stale'),
      read('other', 'section', 'loaded'),
    ]);
    expect(errors.summary).toEqual([]);
    expect(errors.section('list')?.own).toBe(true);
  });

  it('is empty when nothing failed', () => {
    const errors = screenErrors([read('a', 'main', 'loaded'), read('b', 'section', 'idle')]);
    expect(errors.summary).toEqual([]);
    expect(errors.whole).toBe(false);
  });
});

describe('queryRead and selectionRead', () => {
  const query = (over: Partial<Parameters<typeof queryRead>[1]>) => ({
    status: 'pending' as const,
    fetchStatus: 'fetching' as const,
    data: undefined,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
    ...over,
  });

  it('reads a query: loading, disabled, failed, loaded, a failed read again', () => {
    expect(queryRead('the x', query({}), 'main')).toMatchObject({
      key: 'the x',
      what: 'the x',
      kind: 'main',
      loading: true,
      failed: false,
      hasData: false,
    });
    expect(queryRead('the x', query({ fetchStatus: 'idle' }), 'main', 'k')).toMatchObject({
      key: 'k',
      loading: false,
      failed: false,
    });
    const error = unavailable();
    expect(
      queryRead('the x', query({ status: 'error', fetchStatus: 'idle', error }), 'section'),
    ).toMatchObject({ failed: true, error, loading: false, hasData: false });
    expect(
      queryRead('the x', query({ status: 'success', fetchStatus: 'idle', data: [] }), 'section'),
    ).toMatchObject({ failed: false, hasData: true, loading: false });
    // Read again after a failure with nothing to show: TanStack sets it back to pending.
    expect(
      queryRead('the x', query({ fetchStatus: 'fetching', errorUpdateCount: 2 }), 'section'),
    ).toMatchObject({ failed: false, loading: false, retrying: true });
    expect(
      queryRead('the x', query({ fetchStatus: 'idle', errorUpdateCount: 2 }), 'section'),
    ).toMatchObject({ loading: false, retrying: false });
    // Read again after a failure: still failed until the answer comes.
    expect(
      queryRead('the x', query({ status: 'error', fetchStatus: 'fetching', error }), 'section'),
    ).toMatchObject({ failed: true, loading: false });
    const refetch = vi.fn();
    queryRead('the x', query({ refetch }), 'main').retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('reads the shift picker as the screen’s base', () => {
    const retry = vi.fn();
    expect(
      selectionRead({
        pending: true,
        error: null,
        current: undefined,
        retrying: false,
        failedAt: 0,
        answeredAt: 0,
        retry,
      }),
    ).toMatchObject({
      key: 'the shifts',
      what: 'the shifts',
      kind: 'base',
      loading: true,
      failed: false,
      hasData: false,
    });
    const error = unavailable();
    const failed = selectionRead({
      pending: false,
      error,
      current: undefined,
      retrying: false,
      failedAt: 0,
      answeredAt: 0,
      retry,
    });
    expect(failed).toMatchObject({ failed: true, error, loading: false });
    failed.retry();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(
      selectionRead({
        pending: false,
        error: undefined,
        current: { shift: null },
        retrying: false,
        failedAt: 0,
        answeredAt: 0,
        retry,
      }),
    ).toMatchObject({ failed: false, hasData: true });
    expect(
      selectionRead({
        pending: true,
        error: null,
        current: undefined,
        retrying: true,
        failedAt: 0,
        answeredAt: 0,
        retry,
      }),
    ).toMatchObject({ failed: false, loading: false, retrying: true });
    // The current shift failed while it was first read: failed, not loading.
    expect(
      selectionRead({
        pending: true,
        error,
        current: undefined,
        retrying: false,
        failedAt: 0,
        answeredAt: 0,
        retry,
      }).loading,
    ).toBe(false);
  });
});

describe('useScreenErrors', () => {
  const retrying = (key: string, kind: ReadKind): ScreenRead => ({
    ...read(key, kind, 'idle'),
    retrying: true,
    failedAt: 1,
  });

  it('keeps a failure while its read is read again, until it answers', () => {
    const first = unavailable('first');
    let reads = [read('oee', 'main', 'failed', first), read('hours', 'section', 'failed')];
    const { result, rerender } = renderHook(() => useScreenErrors(reads));
    expect(keys(result.current.summary)).toEqual(['oee', 'hours']);
    // A poll: TanStack Query shows the read as pending with no error meanwhile.
    reads = [retrying('oee', 'main'), retrying('hours', 'section')];
    rerender();
    expect(keys(result.current.summary)).toEqual(['oee', 'hours']);
    expect(result.current.summary[0]?.error).toBe(first);
    expect(result.current.whole).toBe(true);
    rerender();
    expect(keys(result.current.summary)).toEqual(['oee', 'hours']);
    // It answered: nothing kept.
    reads = [read('oee', 'main', 'loaded'), retrying('hours', 'section')];
    rerender();
    // The screen loaded: the one failure, kept, is its section's own.
    expect(result.current.summary).toEqual([]);
    expect(result.current.section('hours')?.own).toBe(true);
    reads = [read('oee', 'main', 'loaded'), read('hours', 'section', 'loaded')];
    rerender();
    reads = [read('oee', 'main', 'loaded'), retrying('hours', 'section')];
    rerender();
    expect(result.current.summary).toEqual([]);
    expect(result.current.inSection('hours')).toBe(false);
  });

  it('keeps a failure only for its own query: another one under the same name is loading (#394)', () => {
    let reads = [read('hours', 'section', 'failed'), read('oee', 'main', 'loaded')];
    const { result, rerender } = renderHook(() => useScreenErrors(reads));
    expect(result.current.section('hours')?.own).toBe(true);
    // Another focus whose query failed before (another time) is read again: not this error.
    reads = [{ ...retrying('hours', 'section'), failedAt: 2 }, read('oee', 'main', 'loaded')];
    rerender();
    expect(result.current.inSection('hours')).toBe(false);
    expect(result.current.summary).toEqual([]);
  });

  it('counts a re-read it saw no failure of as loading', () => {
    const reads = [retrying('oee', 'main'), read('hours', 'section', 'failed')];
    const { result } = renderHook(() => useScreenErrors(reads));
    expect(result.current.summary).toEqual([]);
    expect(result.current.whole).toBe(false);
  });
});

describe('namesText', () => {
  it('names each read once, in order', () => {
    expect(namesText([])).toBe('');
    expect(namesText(['the shifts'])).toBe('the shifts');
    expect(namesText(['the shifts', 'the equipment'])).toBe('the shifts and the equipment');
    expect(namesText(['a', 'b', 'a', 'c'])).toBe('a, b and c');
  });
});

describe('ScreenError', () => {
  it('is one alert naming every failed read, the shared detail once, one retry for all', () => {
    const reads = [
      read('shifts', 'base', 'failed'),
      read('equipment', 'base', 'failed'),
      read('oee', 'main', 'failed'),
    ];
    const before = document.activeElement;
    render(<ScreenError errors={screenErrors(reads)} testId="screen-error" />);
    const alert = screen.getByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(alert.dataset.testid).toBe('screen-error');
    expect(alert.dataset.error).toBe('shown');
    expect(alert.className).toContain('bg-alarm-soft');
    expect(
      within(alert).getByText('Could not load the shifts, the equipment and the oee.'),
    ).toBeTruthy();
    expect(within(alert).getAllByText('Service Unavailable: database down')).toHaveLength(1);
    expect(within(alert).queryByRole('list')).toBeNull();
    // Announced, not focused: as ErrorState.
    expect(document.activeElement).toBe(before);
    expect(
      within(alert)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Try again']);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    for (const r of reads) expect(r.retry).toHaveBeenCalledTimes(1);
  });

  it('lists each read’s own detail when they differ, and dedupes reads that share a name', () => {
    const reads = [
      { ...read('kpi-a', 'section', 'failed', unavailable('busy')), what: 'the KPIs' },
      { ...read('kpi-b', 'section', 'failed', unavailable('busy')), what: 'the KPIs' },
      read('floods', 'section', 'failed', new ApiError('Bad Request: no scope', 400)),
    ];
    render(<ScreenError errors={screenErrors(reads)} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Could not load the KPIs and the floods.')).toBeTruthy();
    const items = within(within(alert).getByRole('list')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'The KPIs: Service Unavailable: busy',
      'The floods: Bad Request: no scope',
    ]);
    // A retry can fix one of them: offered, and it reads every one again.
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    for (const r of reads) expect(r.retry).toHaveBeenCalledTimes(1);
  });

  it('shows "Try again" busy from the press until each read it named answered (#394)', () => {
    const view = (a: number, b: number) => (
      <ScreenError
        errors={screenErrors([
          { ...read('a', 'main', 'failed'), answeredAt: a },
          { ...read('b', 'main', 'failed'), answeredAt: b },
        ])}
      />
    );
    const button = () => screen.getByRole('button', { name: 'Try again' });
    const { rerender } = render(view(1, 1));
    expect(button().getAttribute('aria-busy')).toBeNull();
    fireEvent.click(button());
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().getAttribute('aria-disabled')).toBe('true');
    // One of the two answered: still busy.
    rerender(view(2, 1));
    expect(button().getAttribute('aria-busy')).toBe('true');
    // Both answered (failed again): ready for another try.
    rerender(view(2, 2));
    expect(button().getAttribute('aria-busy')).toBeNull();
    // A later answer (a poll) does not make it busy.
    rerender(view(3, 3));
    expect(button().getAttribute('aria-busy')).toBeNull();
  });

  it('lets go of a press that is never answered after the backstop', () => {
    vi.useFakeTimers();
    try {
      render(<ScreenError errors={screenErrors([read('a', 'main', 'failed')])} />);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy')).toBe(
        'true',
      );
      act(() => {
        vi.advanceTimersByTime(TRY_AGAIN_BUSY_MAX_MS - 1);
      });
      expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy')).toBe(
        'true',
      );
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(
        screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy'),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the press and its backstop once the reads answered', () => {
    vi.useFakeTimers();
    try {
      const view = (answeredAt: number) => (
        <ScreenError errors={screenErrors([{ ...read('a', 'main', 'failed'), answeredAt }])} />
      );
      const { rerender } = render(view(1));
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(vi.getTimerCount()).toBe(1);
      rerender(view(2));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a section’s own "Try again" busy after its press, until it answered', () => {
    const view = (answeredAt: number) => (
      <SectionError
        errors={screenErrors([
          read('oee', 'main', 'loaded'),
          { ...read('hours', 'section', 'failed'), answeredAt },
        ])}
        readKey="hours"
      />
    );
    const { rerender } = render(view(1));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy')).toBe(
      'true',
    );
    rerender(view(2));
    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy')).toBeNull();
  });

  it('recovers when real reads fail again at once, and a second press reads them again', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls = { a: 0, b: 0 };
    function Screen() {
      const a = useQuery({
        queryKey: ['a'],
        queryFn: () => {
          calls.a += 1;
          throw new ApiError('Service Unavailable: a', 503);
        },
      });
      const b = useQuery({
        queryKey: ['b'],
        queryFn: () => {
          calls.b += 1;
          throw new ApiError('Service Unavailable: b', 503);
        },
      });
      const errors = useScreenErrors([
        queryRead('the a', a, 'main'),
        queryRead('the b', b, 'main'),
      ]);
      return <ScreenError errors={errors} />;
    }
    render(
      <QueryClientProvider client={client}>
        <Screen />
      </QueryClientProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(calls).toEqual({ a: 2, b: 2 });
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy'),
      ).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(calls).toEqual({ a: 3, b: 3 });
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy'),
      ).toBeNull();
    });
  });

  it('offers a retry when a later read can be helped, the first one refused', () => {
    render(
      <ScreenError
        errors={screenErrors([
          read('a', 'main', 'failed', new ApiError('Forbidden: no', 403)),
          read('b', 'main', 'failed'),
        ])}
      />,
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offers no retry when none can help, and draws nothing without a failure', () => {
    const refused = new ApiError('Forbidden: no', 403);
    const { rerender, container } = render(
      <ScreenError
        errors={screenErrors([
          read('a', 'main', 'failed', refused),
          read('b', 'main', 'failed', refused),
        ])}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Could not load the a and the b.');
    expect(screen.queryByRole('button')).toBeNull();
    // Its frame (the page's spacing) only with an error.
    rerender(
      <ScreenError
        errors={screenErrors([read('a', 'main', 'failed', refused)])}
        className="mb-6"
      />,
    );
    expect(screen.getByRole('alert').parentElement?.className).toBe('mb-6');
    rerender(<ScreenError errors={screenErrors([read('a', 'main', 'loaded')])} className="mb-6" />);
    expect(container.innerHTML).toBe('');
    rerender(<ScreenError errors={screenErrors([read('a', 'main', 'loaded')])} />);
    expect(container.innerHTML).toBe('');
    rerender(
      <ScreenError
        errors={screenErrors([read('a', 'main', 'failed'), read('b', 'main', 'loading')])}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('stays an alert for a failure to reach the MES without the offline bar, as QueryError', () => {
    // Quiet under the bar: `offline.test.tsx` (the alarm list's one quiet line).
    const unreachable = new ApiError('The MES cannot be reached', 0);
    render(
      <ScreenError
        errors={screenErrors([
          read('a', 'main', 'failed', unreachable),
          read('b', 'main', 'failed', unreachable),
        ])}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Could not load the a and the b.');
  });
});

describe('SectionError', () => {
  it('is the section’s own alert with a retry when it is the screen’s only failure', () => {
    const failed = read('hours', 'section', 'failed');
    render(
      <SectionError
        errors={screenErrors([read('oee', 'main', 'loaded'), failed])}
        readKey="hours"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not load the hours.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(failed.retry).toHaveBeenCalledTimes(1);
  });

  it('is a quiet line when the screen’s error names it, and nothing when it did not fail', () => {
    const errors = screenErrors([
      read('oee', 'main', 'loaded'),
      read('hours', 'section', 'failed'),
      read('pareto', 'section', 'failed'),
    ]);
    const { container, rerender } = render(<SectionError errors={errors} readKey="hours" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    const line = container.querySelector('[data-error]');
    expect(line?.getAttribute('data-error')).toBe('quiet');
    expect(line?.textContent).toBe('Could not load the hours. Service Unavailable: database down');
    rerender(<SectionError errors={errors} readKey="oee" />);
    expect(container.innerHTML).toBe('');
  });
});
