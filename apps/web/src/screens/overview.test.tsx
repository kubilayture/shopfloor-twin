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
    // The top bar is a dark surface: its focus ring is focus-on-dark (UX-1a, design system 7).
    expect(screen.getByRole('banner').dataset.surface).toBe('dark');
    // The skip link shows over the top bar, above it (z-popover over z-topbar).
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip.dataset.surface).toBe('dark');
    expect(skip.className).toContain('focus:z-popover');
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
    expect(card.tagName).toBe('ARTICLE');
    const link = within(card).getByRole('link', { name: 'Machine cnc-01' });
    expect(link.getAttribute('href')).toBe('/equipment/cnc-01?range=8h');
    expect(within(card).getByRole('heading', { level: 4, name: 'Machine cnc-01' })).toBeTruthy();
    // Normal states have no colour on the card (ISA-101): no left bar.
    expect(card.className).not.toContain('border-l-4');
    // No cause, no "Cause —" (O-02).
    expect(within(card).queryByText('Cause')).toBeNull();
    // The walkthrough counts the cards by `article[data-testid^="machine-"]`: only the cards.
    expect(document.querySelectorAll('[data-testid^="machine-"]')).toHaveLength(EQUIPMENT.length);
    expect(document.querySelectorAll('article[data-testid^="machine-"]')).toHaveLength(
      EQUIPMENT.length,
    );
  });

  it('sums the machines per state, the abnormal ones first, and raises an abnormal card', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    const app = await renderApp('/');
    await app.open();
    await screen.findByTestId('state-cnc-01');
    const summary = screen.getByTestId('overview-summary');
    expect(
      within(summary).getByRole('heading', { level: 2, name: 'Machines by state' }),
    ).toBeTruthy();
    const tiles = () =>
      [...summary.querySelectorAll<HTMLElement>('[data-testid^="summary-state-"]')].map((tile) => [
        tile.dataset.state,
        tile.dataset.count,
      ]);
    expect(tiles()).toEqual([
      ['Running', '1'],
      ['Idle', '1'],
      ['no-data', '1'],
    ]);
    expect(summary.textContent).toContain('3 machines; none needs attention');
    expect(within(summary).getByText('Running: 1 machine')).toBeTruthy();

    await app.push({
      type: 'state',
      equipment: 'asm-01',
      current: current({ state: 'Starved', cause: 'MATERIAL:BLANK-VB', seq: 12 }),
    });
    await app.push({
      type: 'state',
      equipment: 'wsh-01',
      current: current({ state: 'Down', cause: 'HEATER-FAULT', seq: 13 }),
    });
    expect(tiles()).toEqual([
      ['Down', '1'],
      ['Starved', '1'],
      ['Running', '1'],
    ]);
    expect(summary.textContent).toContain('3 machines; 2 need attention');
    expect(screen.getByTestId('summary-state-Down').className).toContain('border-l-alarm-border');
    expect(screen.getByTestId('summary-state-Running').className).not.toContain('border-l-4');
    // The abnormal card's 4 px bar in its state's border colour (G-13).
    const asm = screen.getByTestId('machine-asm-01');
    expect(asm.className.split(' ')).toEqual(
      expect.arrayContaining(['border-l-4', 'border-l-warn-border']),
    );
    expect(screen.getByTestId('machine-wsh-01').className).toContain('border-l-alarm-border');
    // Causes as words, the code beside them.
    expect(within(asm).getByText('Material missing: BLANK-VB')).toBeTruthy();
    expect(within(asm).getByText('MATERIAL:BLANK-VB')).toBeTruthy();
    expect(within(screen.getByTestId('machine-wsh-01')).getByText('Heater fault')).toBeTruthy();
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
    expect(screen.getByText('No parts')).toBeTruthy();
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
    expect(screen.getByText('No machines yet')).toBeTruthy();
    expect(screen.queryByTestId('overview-summary')).toBeNull();
    expect(screen.getByTestId('plant-clock').textContent).toContain('no data yet');
  });

  it('shows a page for unknown paths', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/nowhere');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});
