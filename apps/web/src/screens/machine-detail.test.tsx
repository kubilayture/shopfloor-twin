import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrendChartProps } from '../chart/trend-chart.tsx';
import { current, EPOCH, EQUIPMENT, PLANT, fakeFetch, json } from '../test/fixtures.ts';
import { renderApp } from '../test/render-app.tsx';

vi.mock('../chart/uplot-chart.tsx', () => ({
  UplotChart: ({ data, unit }: TrendChartProps) => (
    <output data-testid={`chart-${unit}`}>{JSON.stringify(data)}</output>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const T0 = Date.parse('2026-10-15T06:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const CNC = EQUIPMENT.find((item) => item.id === 'cnc-01');

function routes(requests: URL[] = []) {
  return fakeFetch({
    '/api/v1/plant': () => json(PLANT),
    '/api/v1/equipment': () => json({ equipment: EQUIPMENT }),
    '/api/v1/equipment/cnc-01': () => json(CNC),
    '/api/v1/equipment/cnc-01/intervals': (url) => {
      requests.push(url);
      return json({
        equipment: 'cnc-01',
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        truncated: false,
        next: null,
        intervals: [
          {
            epoch: EPOCH,
            start: url.searchParams.get('from'),
            end: at(5),
            state: 'Down',
            cause: 'spindle-fault',
            provisional: false,
            intervalStart: at(-30),
            startSeq: 9,
          },
          {
            epoch: EPOCH,
            start: at(5),
            end: at(10),
            state: 'Running',
            cause: null,
            provisional: true,
            intervalStart: at(5),
            startSeq: 10,
          },
        ],
      });
    },
    '/api/v1/equipment/cnc-01/telemetry/metrics': () =>
      json({
        equipment: 'cnc-01',
        metrics: [{ metric: 'spindle-load', unit: 'percent', latest: { t: at(10), value: 42.5 } }],
      }),
    '/api/v1/equipment/cnc-01/telemetry': (url) => {
      requests.push(url);
      return json({
        equipment: 'cnc-01',
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        bucketMs: 60_000,
        series: [
          {
            metric: 'spindle-load',
            unit: 'percent',
            points: [{ t: at(8), min: 40, max: 45, avg: 42, n: 60 }],
          },
        ],
      });
    },
  });
}

describe('machine detail', () => {
  it('shows the current state, a timeline up to the plant clock and totals', async () => {
    const requests: URL[] = [];
    vi.stubGlobal('fetch', routes(requests));
    const app = await renderApp('/equipment/cnc-01?range=1h');
    await app.open();

    await screen.findByTestId('current-state');
    expect(screen.getByRole('heading', { name: 'Machine cnc-01', level: 1 })).toBeTruthy();
    expect(screen.getByTestId('current-state').dataset.state).toBe('Running');
    const timeline = await screen.findByTestId('state-timeline');
    const bands = [...timeline.querySelectorAll<HTMLElement>('[data-state]')];
    const layout = bands.map((band) => [
      band.dataset.state,
      parseFloat(band.style.left),
      parseFloat(band.style.width),
    ]);
    expect(layout).toEqual([
      ['Down', 0, expect.closeTo((55 / 60) * 100, 6)],
      ['Running', expect.closeTo((55 / 60) * 100, 6), expect.closeTo((5 / 60) * 100, 6)],
    ]);
    expect(bands.map((band) => band.dataset.state)).toEqual(['Down', 'Running']);

    const intervalQuery = requests.find((url) => url.pathname.endsWith('/intervals'));
    expect(intervalQuery?.searchParams.get('to')).toBe(PLANT.clock.watermark);
    expect(intervalQuery?.searchParams.get('from')).toBe(at(-50));

    const totals = screen.getByRole('table', { name: /time per state, last hour/i });
    expect(within(totals).getByRole('rowheader', { name: 'Running' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Last hour' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('draws a pushed state change on the timeline and in the header, and rereads the intervals', async () => {
    const requests: URL[] = [];
    const intervalReads = () =>
      requests.filter((url) => url.pathname.endsWith('/intervals')).length;
    vi.stubGlobal('fetch', routes(requests));
    const app = await renderApp('/equipment/cnc-01?range=1h');
    await app.open();
    await screen.findByTestId('state-timeline');
    expect(intervalReads()).toBe(1);
    await app.push(
      {
        type: 'state',
        equipment: 'cnc-01',
        current: current({ state: 'Blocked', since: at(10), seq: 11 }),
      },
      { type: 'clock', epoch: EPOCH, watermark: at(12) },
    );
    expect(screen.getByTestId('current-state').textContent).toBe('Blocked');
    const states = [
      ...screen.getByTestId('state-timeline').querySelectorAll<HTMLElement>('[data-state]'),
    ].map((band) => band.dataset.state);
    expect(states).toEqual(['Down', 'Running', 'Blocked']);
    await waitFor(() => {
      expect(intervalReads()).toBe(2);
    });
  });

  it('lists metrics with units and charts min/max/avg with live samples appended', async () => {
    vi.stubGlobal('fetch', routes());
    const app = await renderApp('/equipment/cnc-01?range=1h');
    await app.open();
    expect((await screen.findByTestId('latest-spindle-load')).textContent).toBe('42.5');
    expect(screen.getByRole('rowheader', { name: 'spindle-load' })).toBeTruthy();
    expect(app.factory.last.sent).toContainEqual({ type: 'subscribe', topic: 'telemetry:cnc-01' });

    const chart = await screen.findByTestId('chart-percent');
    expect(JSON.parse(chart.textContent)).toEqual([[(T0 + 8 * 60_000) / 1000], [40], [45], [42]]);

    await app.push({
      type: 'telemetry',
      equipment: 'cnc-01',
      metric: 'spindle-load',
      unit: 'percent',
      t: at(9.5),
      value: 50,
    });
    expect((JSON.parse(screen.getByTestId('chart-percent').textContent) as number[][])[3]).toEqual([
      42, 50,
    ]);
    expect(screen.getByTestId('latest-spindle-load').textContent).toBe('42.5');

    await app.push({
      type: 'telemetry',
      equipment: 'cnc-01',
      metric: 'spindle-load',
      unit: 'percent',
      t: at(11),
      value: 51,
    });
    expect(screen.getByTestId('latest-spindle-load').textContent).toBe('51');
  });

  it("moves focus to the new screen's heading after navigating", async () => {
    vi.stubGlobal('fetch', routes());
    const app = await renderApp('/');
    await app.open();
    const link = within(await screen.findByTestId('machine-cnc-01')).getByRole('link');
    link.focus();
    fireEvent.click(link);
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Machine cnc-01');
    });
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('switches the range from the picker', async () => {
    vi.stubGlobal('fetch', routes());
    const app = await renderApp('/equipment/cnc-01');
    await app.open();
    await screen.findByTestId('current-state');
    const picker = screen.getByRole('navigation', { name: 'Time range' });
    expect(
      within(picker).getByRole('link', { name: 'Last 8 h' }).getAttribute('aria-current'),
    ).toBe('page');
    fireEvent.click(within(picker).getByRole('link', { name: 'Last 24 h' }));
    await waitFor(() => {
      expect(app.history.location.search).toBe('?range=24h');
    });
  });

  it('shows the problem the MES reported for an unknown machine', async () => {
    vi.stubGlobal('fetch', routes());
    const app = await renderApp('/equipment/nope');
    await app.open();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load machine nope');
    expect(alert.textContent).toContain('Unknown equipment, metric or route');
  });
});
