import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from './api/queries.ts';
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

    // A screen opened now says it cannot read, instead of "Loading…" for as long as it lasts.
    await settle(() => {
      app.history.push('/alarms');
    });
    await screen.findByText(/Could not load the active alarms/);
    expect(screen.getAllByText(/The MES cannot be reached/).length).toBeGreaterThan(0);
    expect(app.factory.sockets).toHaveLength(1);

    await net.restore();
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    // Reconnects at once, not after the backoff it had reached.
    expect(app.factory.sockets).toHaveLength(2);
    expect(status.dataset.status).toBe('reconnecting');
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
});
