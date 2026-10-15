import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { current, EPOCH, EQUIPMENT, PLANT, fakeFetch, json, problem } from '../test/fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const api = {
  '/api/v1/equipment': () => json({ equipment: EQUIPMENT }),
  '/api/v1/plant': () => json(PLANT),
};

describe('plant overview', () => {
  it('shows every machine by area and work center with its state as text', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    const app = await renderApp('/');
    await app.open();

    await screen.findByTestId('state-cnc-01');
    expect(screen.getByRole('heading', { name: 'Machining', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Line A1', level: 3 })).toBeTruthy();
    const cnc = screen.getByTestId('state-cnc-01');
    expect(cnc.textContent).toBe('Running');
    expect(cnc.dataset.state).toBe('Running');
    expect(screen.getByTestId('state-wsh-01').textContent).toBe('Idle');
    const asm = screen.getByTestId('state-asm-01');
    expect(asm.textContent).toBe('No data');
    expect(asm.dataset.state).toBe('no-data');
    expect(screen.getByTestId('time-in-state-cnc-01').textContent).toBe('10 min 00 s');
    expect(screen.getByTestId('plant-clock').textContent).toContain('Gebze plant time');
    expect(screen.getByRole('status').textContent).toContain('Live');

    const card = screen.getByTestId('machine-cnc-01');
    const link = within(card).getByRole('link', { name: 'Machine cnc-01' });
    expect(link.getAttribute('href')).toBe('/equipment/cnc-01?range=8h');
  });

  it('subscribes to states and applies the snapshot and pushed deltas', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    const app = await renderApp('/');
    await app.open();
    await screen.findByTestId('state-cnc-01');
    expect(app.factory.last.sent).toEqual([{ type: 'subscribe', topic: 'states' }]);

    await app.push(
      { type: 'subscribed', topic: 'states', metric: null },
      {
        type: 'snapshot',
        topic: 'states',
        clock: { epoch: EPOCH, watermark: '2026-10-15T06:20:00.000Z' },
        states: [
          {
            equipment: 'asm-01',
            current: current({ state: 'Starved', cause: 'no-parts', seq: null }),
          },
        ],
      },
    );
    expect(screen.getByTestId('state-asm-01').dataset.state).toBe('Starved');
    expect(screen.getByText('no-parts')).toBeTruthy();
    expect(screen.getByText('Provisional')).toBeTruthy();
    expect(screen.getByTestId('time-in-state-cnc-01').textContent).toBe('20 min 00 s');

    await app.push({
      type: 'state',
      equipment: 'cnc-01',
      current: current({
        state: 'Down',
        cause: 'spindle-fault',
        seq: 11,
        since: '2026-10-15T06:19:00.000Z',
      }),
    });
    expect(screen.getByTestId('state-cnc-01').textContent).toBe('Down');
    expect(screen.getByTestId('time-in-state-cnc-01').textContent).toBe('1 min 00 s');

    await app.push({ type: 'clock', epoch: EPOCH, watermark: '2026-10-15T06:21:30.000Z' });
    expect(screen.getByTestId('time-in-state-cnc-01').textContent).toBe('2 min 30 s');
  });

  it('does not call states stale while it connects the first time', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/');
    expect((await screen.findByTestId('state-cnc-01')).textContent).toBe('Running');
    expect(screen.getByTestId('connection-status').textContent).toContain('Connecting…');
    expect(screen.queryByTestId('stale-cnc-01')).toBeNull();
  });

  it('marks states stale while the connection is lost and reconnects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.stubGlobal('fetch', fakeFetch(api));
      const app = await renderApp('/');
      await app.open();
      await screen.findByTestId('state-cnc-01');
      expect(screen.queryByTestId('stale-cnc-01')).toBeNull();

      await app.drop();
      expect(screen.getByRole('status').textContent).toContain('Reconnecting');
      expect(screen.getByTestId('stale-cnc-01').textContent).toBe('Stale: live connection lost');

      await settle(() => {
        vi.advanceTimersByTime(1_000);
      });
      await app.open();
      expect(app.factory.sockets).toHaveLength(2);
      expect(app.factory.last.sent).toEqual([{ type: 'subscribe', topic: 'states' }]);
      expect(screen.queryByTestId('stale-cnc-01')).toBeNull();

      await app.push({ type: 'clock', epoch: EPOCH + 60, watermark: '2026-10-15T06:00:00.000Z' });
      expect(screen.getByTestId('stale-cnc-01').textContent).toBe('Stale: from an earlier run');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows what the MES said when the equipment cannot be read, and retries', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        ...api,
        '/api/v1/equipment': () =>
          fail
            ? problem(
                503,
                'Service Unavailable',
                'the database is busy; try again',
                '/api/v1/equipment',
              )
            : json({ equipment: EQUIPMENT }),
      }),
    );
    await renderApp('/');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('the database is busy; try again');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.getByTestId('state-cnc-01').textContent).toBe('Running');
    });
  });

  it('says when master data is empty and when nothing reported yet', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/equipment': () => json({ equipment: [] }),
        '/api/v1/plant': () => json({ site: null, clock: null, epochs: [] }),
      }),
    );
    await renderApp('/');
    expect(await screen.findByText(/master data is not seeded/)).toBeTruthy();
    expect(screen.getByTestId('plant-clock').textContent).toContain('no data yet');
  });

  it('shows a page for unknown paths', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/nowhere');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});
