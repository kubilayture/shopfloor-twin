import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrendChartProps } from '../chart/trend-chart.tsx';
import { current, EPOCH, EQUIPMENT, PLANT, fakeFetch, json, problem } from '../test/fixtures.ts';
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
    // A band is the state's fill with 4 px top and bottom edges in its border colour (2.4): the
    // timeline's own look, not the badge's (#345 review).
    for (const band of bands) {
      const key = band.dataset.state?.toLowerCase();
      expect(band.className.split(' ')).toEqual(
        expect.arrayContaining(['border-y-4', `border-state-${key ?? ''}-border`]),
      );
    }

    const intervalQuery = requests.find((url) => url.pathname.endsWith('/intervals'));
    expect(intervalQuery?.searchParams.get('to')).toBe(PLANT.clock.watermark);
    expect(intervalQuery?.searchParams.get('from')).toBe(at(-50));

    const totals = screen.getByRole('table', { name: /time per state, last hour/i });
    expect(within(totals).getByRole('rowheader', { name: 'Running' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Last hour' }).getAttribute('aria-current')).toBe(
      'page',
    );

    // The page header: the name as the h1, the state's facts, the way back.
    expect(screen.getByRole('link', { name: '‹ Plant overview' }).getAttribute('href')).toBe('/');
    expect(screen.getByText(/Machining › Cell M1/)).toBeTruthy();
    // The axis: a tick every 10 min over the hour, at round times of day, no date on one day.
    const ticks = [
      ...screen.getByTestId('timeline-axis').querySelectorAll<HTMLElement>('[data-tick]'),
    ];
    expect(ticks.map((tick) => tick.textContent)).toEqual([
      '08:10',
      '08:20',
      '08:30',
      '08:40',
      '08:50',
      '09:00',
      '09:10',
    ]);
    // Below sm another axis with half the ticks takes its place (#359 review).
    expect(screen.getByTestId('timeline-axis').className).toContain('max-sm:hidden');
    const narrow = screen.getByTestId('timeline-axis-narrow');
    expect(narrow.className).toContain('sm:hidden');
    expect(
      [...narrow.querySelectorAll<HTMLElement>('[data-tick]')].map((tick) => tick.textContent),
    ).toEqual(['08:15', '08:30', '08:45', '09:00']);
  });

  it('dates the axis where the plant day changes on a range that spans days', async () => {
    vi.stubGlobal('fetch', routes());
    const app = await renderApp('/equipment/cnc-01?range=24h');
    await app.open();
    const axis = await screen.findByTestId('timeline-axis');
    const ticks = [...axis.querySelectorAll<HTMLElement>('[data-tick]')].map(
      (tick) => tick.textContent,
    );
    expect(ticks).toEqual([
      '12:00Wed 14 Oct',
      '15:00',
      '18:00',
      '21:00',
      '00:00Thu 15 Oct',
      '03:00',
      '06:00',
      '09:00',
    ]);
    expect(screen.getByTestId('state-timeline').getAttribute('aria-label')).toContain(
      'Wed 14 Oct, 09:10:00 to Thu 15 Oct, 09:10:00',
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
    // The metric by its name, its id beside it (M-02); the latest value is fresh: no age.
    expect(screen.getByRole('rowheader', { name: 'Spindle load spindle-load' })).toBeTruthy();
    expect(screen.queryByTestId('age-spindle-load')).toBeNull();
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

    // A sample whose binary form is not exact is shown without the noise (#295).
    await app.push({
      type: 'telemetry',
      equipment: 'cnc-01',
      metric: 'spindle-load',
      unit: 'percent',
      t: at(12),
      value: 0.1 + 0.2,
    });
    expect(screen.getByTestId('latest-spindle-load').textContent).toBe('0.3');
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
    // A row of links in a named group (SegmentedLinks, M-04), the current one aria-current.
    const picker = screen.getByRole('group', { name: 'Time range' });
    expect(
      within(picker).getByRole('link', { name: 'Last 8 h' }).getAttribute('aria-current'),
    ).toBe('page');
    fireEvent.click(within(picker).getByRole('link', { name: 'Last 24 h' }));
    await waitFor(() => {
      expect(app.history.location.search).toBe('?range=24h');
    });
  });

  it('says an unknown machine is not there, with the way back (M-06)', async () => {
    vi.stubGlobal('fetch', routes());
    const app = await renderApp('/equipment/nope');
    await app.open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Machine nope' })).toBeTruthy();
    expect(screen.getByText('The MES has no machine with this id.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Plant overview' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.title).toBe('Machine nope · ShopFloor Twin');
  });

  it('shows what the MES said when the machine cannot be read, under its heading', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/plant': () => json(PLANT),
        '/api/v1/equipment': () => json({ equipment: EQUIPMENT }),
        '/api/v1/equipment/cnc-01': () =>
          problem(503, 'Service Unavailable', 'the database is busy', '/api/v1/equipment/cnc-01'),
      }),
    );
    const app = await renderApp('/equipment/cnc-01');
    await app.open();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load machine cnc-01');
    expect(alert.textContent).toContain('the database is busy');
    expect(screen.getByRole('heading', { level: 1, name: 'Machine cnc-01' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says how old a latest value is, and when an empty trend last had a sample (M-02, M-05)', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/plant': () => json(PLANT),
        '/api/v1/equipment/cnc-01': () => json(CNC),
        '/api/v1/equipment/cnc-01/intervals': (url) =>
          json({
            equipment: 'cnc-01',
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            truncated: false,
            next: null,
            intervals: [],
          }),
        '/api/v1/equipment/cnc-01/telemetry/metrics': () =>
          json({
            equipment: 'cnc-01',
            metrics: [
              {
                metric: 'coolant-temperature',
                unit: '°C',
                latest: { t: at(-3 * 24 * 60 - 130), value: 22 },
              },
            ],
          }),
        '/api/v1/equipment/cnc-01/telemetry': (url) =>
          json({
            equipment: 'cnc-01',
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            bucketMs: 60_000,
            series: [{ metric: 'coolant-temperature', unit: '°C', points: [] }],
          }),
      }),
    );
    const app = await renderApp('/equipment/cnc-01?range=1h');
    await app.open();
    const age = await screen.findByTestId('age-coolant-temperature');
    // 3 d 2 h 20 min before the plant clock (06:10 on the 15th).
    // How long the value has been unchanged, as neutral text: never a warning (#359 review).
    expect(age.textContent).toBe('unchanged for 3 d 2 h');
    expect(age.className).toBe('text-ink-secondary');
    expect(screen.getByRole('rowheader', { name: /^Coolant temperature/ })).toBeTruthy();
    const empty = await screen.findByText('No samples in this range.');
    const figure = empty.closest('figure');
    expect(figure?.textContent).toContain('Coolant temperature');
    expect(figure?.textContent).toContain('The last sample was at Mon 12 Oct, 06:50:00');
    expect(figure?.textContent).toContain('before this range');
  });

  it('shows how long a quiet signal is unchanged as neutral text, running or standing (#359 review)', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/plant': () => json(PLANT),
        '/api/v1/equipment/cnc-01': () => json(CNC),
        '/api/v1/equipment/cnc-01/intervals': (url) =>
          json({
            equipment: 'cnc-01',
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            truncated: false,
            next: null,
            intervals: [],
          }),
        '/api/v1/equipment/cnc-01/telemetry/metrics': () =>
          json({
            equipment: 'cnc-01',
            // 20 min before the plant clock (at(10)), well inside the 8 h range.
            metrics: [{ metric: 'spindle-load', unit: '%', latest: { t: at(-10), value: 0 } }],
          }),
        '/api/v1/equipment/cnc-01/telemetry': (url) =>
          json({
            equipment: 'cnc-01',
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            bucketMs: 60_000,
            series: [{ metric: 'spindle-load', unit: '%', points: [] }],
          }),
      }),
    );
    const app = await renderApp('/equipment/cnc-01?range=8h');
    await app.open();
    // Running with a steady signal: telemetry is sent on change, so the value is simply
    // unchanged. Neutral text, no amber tag (#359 review, round 2).
    const running = await screen.findByTestId('age-spindle-load');
    expect(screen.getByTestId('current-state').dataset.state).toBe('Running');
    expect(running.textContent).toBe('unchanged for 20 min');
    expect(running.className).toBe('text-ink-secondary');
    expect(running.closest('td')?.querySelector('[class*="warn"]')).toBeNull();

    // The same when the machine stands.
    await app.push({
      type: 'state',
      equipment: 'cnc-01',
      current: current({ state: 'Idle', since: at(9), seq: 11 }),
    });
    const idle = screen.getByTestId('age-spindle-load');
    expect(idle.textContent).toBe('unchanged for 20 min');
    expect(idle.className).toBe('text-ink-secondary');
  });
});
