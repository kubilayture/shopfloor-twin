import type { Query } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/client.ts';
import { queryKeys } from './api/queries.ts';
import { QueryError } from './components/query-error.tsx';
import { formatClockSeconds } from './domain/time.ts';
import { SCOPES, alarmConfig } from './test/alarm-fixtures.ts';
import { EQUIPMENT, PLANT, fakeFetch, json } from './test/fixtures.ts';
import { network, resetNetwork } from './test/network.ts';
import { renderApp, settle } from './test/render-app.tsx';

vi.mock('./chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  resetNetwork();
});

/** The bar's own calls: the active reads in error, whatever their key (the live cache's leave out `live`). */
function barRefetches(calls: readonly (readonly unknown[])[]): number {
  const errored = { queryKey: ['live'], state: { status: 'error' } } as unknown as Query;
  return calls
    .map(([filters]) => filters as { type?: string; predicate?: (q: Query) => boolean } | undefined)
    .filter((f) => f?.type === 'active' && f.predicate?.(errored) === true).length;
}

/** The alarm list's one error with every read failed (#394). */
const EVERY_ALARM_READ =
  'Could not load the active alarms, the acknowledged alarms, the shelved alarms and the alarm points.';

const api = fakeFetch({
  '/api/v1/equipment': () => json({ equipment: EQUIPMENT }),
  '/api/v1/plant': () => json(PLANT),
  '/api/v1/alarms/scopes': () => json(SCOPES),
  '/api/v1/alarms/config': () => json(alarmConfig()),
  '/api/v1/alarm-points': () => json({ points: [] }),
  '/api/v1/alarms': (url) =>
    json({
      view: url.searchParams.get('view') ?? 'active',
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      next: null,
      alarms: [],
    }),
});

describe('offline (#312)', () => {
  it('shows Offline at once, fails a read instead of loading for ever, and recovers without a reload', async () => {
    const net = network(api);
    vi.stubGlobal('fetch', net.fetch);
    const app = await renderApp('/');
    await app.open();
    await screen.findByTestId('state-cnc-01');
    const status = screen.getByTestId('connection-status');
    expect(status.dataset.status).toBe('open');
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    const socket = app.factory.last;

    await net.cut();
    // The socket may still look open to the browser: it is let go and not retried while offline.
    expect(socket.closedByClient).toBe(true);
    expect(status.dataset.status).toBe('stopped');
    expect(status.textContent).toBe('Offline');
    const bar = screen.getByTestId('offline-bar');
    expect(bar.getAttribute('role')).toBe('alert');
    // On the shell's widths and gutters (UX-1b).
    expect(bar.firstElementChild?.className).toMatch(/max-w-360 .*px-4 .*md:px-6 xl:px-8/);
    expect(bar.textContent).toContain(
      `the figures on this page stopped updating at ${formatClockSeconds(PLANT.clock.watermark)} plant time.`,
    );

    // A late answer moves the header's clock, not the time the figures stopped updating.
    await settle(() => {
      app.queryClient.setQueryData(queryKeys.plant, {
        ...PLANT,
        clock: { ...PLANT.clock, watermark: '2026-10-15T06:11:00.000Z' },
      });
    });
    expect(bar.textContent).toContain(formatClockSeconds(PLANT.clock.watermark));
    // The same alert, its text unchanged: announced once per outage, not on every render.
    expect(screen.getByTestId('offline-bar')).toBe(bar);
    expect(screen.getAllByRole('alert')).toEqual([bar]);

    // A screen opened now says it cannot read, instead of "Loading…" for as long as it lasts.
    await settle(() => {
      app.history.push('/alarms');
    });
    await screen.findByText(/Could not load the active alarms/);
    expect(screen.getAllByText(/The MES cannot be reached/).length).toBeGreaterThan(0);
    // One alert for the outage, the bar's (#317 after #343): the failed reads are one quiet line
    // without "Try again" (#394: one error for the screen, naming every read), not an alert each.
    await waitFor(() => {
      expect(screen.getByText(/^Could not load /).textContent).toBe(EVERY_ALARM_READ);
    });
    expect(screen.getAllByText(/^Could not load /)).toHaveLength(1);
    expect(screen.getAllByRole('alert')).toEqual([screen.getByTestId('offline-bar')]);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(
      screen
        .getByText(/Could not load the active alarms/)
        .closest('[data-error]')
        ?.getAttribute('data-error'),
    ).toBe('quiet');
    expect(app.factory.sockets).toHaveLength(1);

    await net.restore();
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    // Reconnects within its first delay (jittered), not after the backoff it had reached.
    expect(status.dataset.status).toBe('reconnecting');
    await waitFor(() => {
      expect(app.factory.sockets).toHaveLength(2);
    });
    await app.open();
    expect(status.dataset.status).toBe('open');
    expect(status.textContent).toBe('Live');
    // The failed reads are read again.
    await waitFor(() => {
      expect(screen.queryByText(/Could not load the active alarms/)).toBeNull();
    });

    // Lost again later: the bar says the new time, not the first one.
    await settle(() => {
      app.queryClient.setQueryData(queryKeys.plant, {
        ...PLANT,
        clock: { ...PLANT.clock, watermark: '2026-10-15T06:12:00.000Z' },
      });
    });
    await net.cut();
    expect(screen.getByTestId('offline-bar').textContent).toContain(
      formatClockSeconds('2026-10-15T06:12:00.000Z'),
    );
  });

  it('says so when the network goes before the plant clock is known', async () => {
    // No plant answer and nothing pushed: the clock is not known.
    const net = network(fakeFetch({ '/api/v1/equipment': () => json({ equipment: EQUIPMENT }) }));
    vi.stubGlobal('fetch', net.fetch);
    await renderApp('/');
    await screen.findByTestId('state-cnc-01');
    await net.cut();
    expect(screen.getByTestId('offline-bar').textContent).toContain(
      'Offline: the figures on this page stopped updating when the network was lost.',
    );
    expect(screen.getByTestId('connection-status').dataset.status).toBe('stopped');
  });

  it('shows the bar when the live connection is lost with the browser online, not on one reconnect', async () => {
    vi.stubGlobal('fetch', api);
    const app = await renderApp('/');
    await app.open();
    await screen.findByTestId('state-cnc-01');
    const status = screen.getByTestId('connection-status');

    // Dropped once: one reconnect after a blip is not a loss.
    await app.drop();
    expect(status.dataset.status).toBe('reconnecting');
    expect(screen.queryByTestId('offline-bar')).toBeNull();

    // The reconnect fails too: the connection is lost, though the browser is online.
    await waitFor(() => {
      expect(app.factory.sockets).toHaveLength(2);
    });
    await app.drop();
    expect(status.textContent).toBe('Reconnecting… (attempt 2)');
    const bar = screen.getByTestId('offline-bar');
    expect(bar.dataset.reason).toBe('connection');
    expect(bar.getAttribute('role')).toBe('alert');
    expect(bar.textContent).toContain(
      `Connection lost: the figures on this page stopped updating at ${formatClockSeconds(PLANT.clock.watermark)} plant time.`,
    );
    expect(bar.textContent).toContain('Reconnecting to the MES');

    // Back: the bar goes.
    await waitFor(
      () => {
        expect(app.factory.sockets).toHaveLength(3);
      },
      { timeout: 5_000 },
    );
    await app.open();
    expect(status.dataset.status).toBe('open');
    expect(screen.queryByTestId('offline-bar')).toBeNull();
  });

  it('reads again what failed while the MES was unreachable once the connection is back, quietly (#352 M4)', async () => {
    let down = false;
    // Held answers: the reads run again with the connection back, and answer when released.
    let release: () => void = () => undefined;
    let held: Promise<void> | undefined;
    const routes = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down) return new Response('Bad Gateway', { status: 502 });
      if (held) await held;
      return api(input, init);
    };
    vi.stubGlobal('fetch', routes);
    const app = await renderApp('/alarms');
    await app.open();
    await screen.findByTestId('alarm-list-empty');
    // The MES goes: the socket fails twice, the bar is up, and the reads fail with the proxy's 502.
    down = true;
    await app.drop();
    await waitFor(() => {
      expect(app.factory.sockets).toHaveLength(2);
    });
    await app.drop();
    expect(screen.getByTestId('offline-bar').dataset.reason).toBe('connection');
    await settle(() => {
      void app.queryClient.refetchQueries({ type: 'active' });
    });
    await waitFor(() => {
      expect(screen.getByText(/^Could not load /).textContent).toBe(EVERY_ALARM_READ);
    });
    expect(screen.getAllByRole('alert')).toEqual([screen.getByTestId('offline-bar')]);

    // Back: the bar goes, the failed reads run again at once and nothing turns into an alert,
    // also while they are on their way.
    down = false;
    held = new Promise((resolve) => {
      release = resolve;
    });
    const refetch = vi.spyOn(app.queryClient, 'refetchQueries');
    await waitFor(
      () => {
        expect(app.factory.sockets).toHaveLength(3);
      },
      { timeout: 5_000 },
    );
    await app.open();
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    // Read again once: by the live cache's invalidation after the dropped connection, not a
    // second time by the bar (#352 re-review), which keeps its own call for a hung first connect.
    expect(barRefetches(refetch.mock.calls)).toBe(0);
    expect(refetch.mock.calls.length).toBeGreaterThan(0);
    expect(screen.getByText(/^Could not load /).textContent).toBe(EVERY_ALARM_READ);
    expect(screen.queryAllByRole('alert')).toEqual([]);
    held = undefined;
    release();
    await waitFor(() => {
      expect(screen.queryByText(/^Could not load /)).toBeNull();
    });

    // A later outage of another kind on the same screen, a first connect that hangs (the client
    // started again): the bar reads again itself this time, the earlier drop forgotten.
    down = true;
    await settle(() => {
      app.live.stop();
      app.live.start();
    });
    await screen.findByTestId('offline-bar', {}, { timeout: 8_000 });
    await settle(() => {
      void app.queryClient.refetchQueries({ type: 'active' });
    });
    down = false;
    refetch.mockClear();
    await app.open();
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    expect(barRefetches(refetch.mock.calls)).toBe(1);
  }, 20_000);

  it('keeps the errors loud on a screen without the bar (the terminal before sign-on)', () => {
    render(<QueryError what="the terminal" error={new ApiError('HTTP 502', 502)} />);
    expect(screen.getByRole('alert').textContent).toContain('Could not load the terminal.');
  });

  it('reads again what failed while a first connect hung, once the socket gets through', async () => {
    let down = true;
    const routes = (input: RequestInfo | URL, init?: RequestInit) =>
      down ? Promise.resolve(new Response('Gateway Timeout', { status: 504 })) : api(input, init);
    vi.stubGlobal('fetch', routes);
    const app = await renderApp('/alarms');
    // The handshake hangs: after 5 s of connecting the bar is up and the reads are quiet.
    await screen.findByTestId('offline-bar', {}, { timeout: 8_000 });
    await waitFor(() => {
      expect(screen.getByText(/^Could not load /).textContent).toBe(EVERY_ALARM_READ);
    });
    expect(screen.getAllByRole('alert')).toEqual([screen.getByTestId('offline-bar')]);
    down = false;
    const refetch = vi.spyOn(app.queryClient, 'refetchQueries');
    await app.open();
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    // The live cache does not read again after a first connect: the bar does, once.
    expect(barRefetches(refetch.mock.calls)).toBe(1);
    expect(screen.queryAllByRole('alert')).toEqual([]);
    await waitFor(() => {
      expect(screen.queryByText(/^Could not load /)).toBeNull();
    });
  }, 20_000);
});
