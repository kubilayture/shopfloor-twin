import type { AlarmConfig, AlarmKpiBucketDto } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCOPES,
  alarmConfig,
  episode,
  hourKpi,
  kpiBucket,
  operatorBucket,
} from '../test/alarm-fixtures.ts';
import { EQUIPMENT, PLANT, json, problem } from '../test/fixtures.ts';
import { CURRENT_SHIFT, SHIFT, SHIFT_END, SHIFT_START, requestUrl } from '../test/oee-fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';
import { expectDecimals } from '../test/decimals.ts';

/** The chart options drawn (jsdom has no canvas): the threshold line is checked on them. */
const charts = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('../chart/echarts-view.tsx', () => ({
  EChartsView: ({ option }: { option: unknown }) => {
    charts.options.push(option);
    return null;
  },
}));

interface Series {
  readonly markLine?: { readonly data: readonly { readonly yAxis: number }[] };
}
const thresholdLine = (option: unknown) =>
  ((option as { series: Series[] }).series[1]?.markLine?.data ?? []).map((d) => d.yAxis);

interface Options {
  /** Shift buckets per scope key (`plant`, `position:cell-m1`); missing: none. */
  readonly shift?: Readonly<Record<string, AlarmKpiBucketDto[]>>;
  readonly hours?: AlarmKpiBucketDto[];
  readonly operator?: Response;
  /** `GET /alarms/config` (#160); default alarms.yaml's. */
  readonly config?: AlarmConfig;
}

function mes(options: Options) {
  const paths: string[] = [];
  const fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(requestUrl(input), 'http://localhost');
    paths.push(url.pathname + url.search);
    const scope = url.searchParams.get('scope');
    const key = scope === 'plant' ? 'plant' : `${scope ?? ''}:${url.searchParams.get('id') ?? ''}`;
    const base = {
      scope,
      id: url.searchParams.get('id') ?? 'plant',
      from: SHIFT_START,
      to: SHIFT_END,
    };
    switch (url.pathname) {
      case '/api/v1/equipment':
        return Promise.resolve(json({ equipment: EQUIPMENT }));
      case '/api/v1/plant':
        return Promise.resolve(json(PLANT));
      case '/api/v1/shifts/current':
        return Promise.resolve(json(CURRENT_SHIFT));
      case '/api/v1/shifts':
        return Promise.resolve(json({ from: SHIFT_START, to: SHIFT_END, shifts: [SHIFT] }));
      case '/api/v1/alarms/scopes':
        return Promise.resolve(json(SCOPES));
      case '/api/v1/alarms/config':
        return Promise.resolve(json(options.config ?? alarmConfig()));
      case '/api/v1/alarms/kpi': {
        const bucket = url.searchParams.get('bucket');
        const buckets = bucket === 'hour' ? (options.hours ?? []) : (options.shift?.[key] ?? []);
        return Promise.resolve(json({ ...base, bucket, buckets }));
      }
      case '/api/v1/alarms/floods':
        return Promise.resolve(
          json({
            ...base,
            epoch: 1,
            episodes: [
              episode({ endAt: '2026-10-15T05:04:00.000Z' }),
              episode({ id: 'x', endAt: null }),
            ],
          }),
        );
      case '/api/v1/alarms/bad-actors':
        return Promise.resolve(
          json({
            ...base,
            epoch: 1,
            actors: [
              {
                equipment: 'cnc-01',
                code: 'COOLANT-PRESSURE',
                raises: 12,
                share: { fraction: '6/7', decimal: '0.8571' },
                activeMs: 600_000,
                chatteringRaises: 3,
              },
            ],
          }),
        );
      case '/api/v1/alarms/operator-kpi':
        return Promise.resolve(
          options.operator ??
            json({ ...base, bucket: 'range', epoch: 1, buckets: [operatorBucket()] }),
        );
      default:
        return Promise.resolve(problem(404, 'Not Found', 'unknown', url.pathname));
    }
  };
  return { paths, fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  charts.options.length = 0;
});

const measure = (card: HTMLElement, name: string) =>
  card.querySelector<HTMLElement>(`[data-measure="${name}"]`)?.textContent;

describe('alarm KPI page', () => {
  it('shows each scope of the shift exactly, with its status, and a dash without data', async () => {
    const server = mes({
      shift: {
        plant: [kpiBucket({ final: true, provisional: false, revision: 1 })],
        'position:cell-m1': [kpiBucket({ scope: 'position', id: 'cell-m1' })],
      },
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms/kpi');
    const plant = await screen.findByTestId('kpi-card-plant');
    await waitFor(() => {
      expect(plant.dataset.raises).toBe('14');
    });
    expect(plant.dataset.final).toBe('true');
    expect(plant.dataset.revision).toBe('1');
    // The raises with their priorities under them (K-01: no wrapping "(high / medium / low)").
    expect(measure(plant, 'raises')).toBe('14');
    expect(plant.querySelector('[data-measure="raises"]')?.nextElementSibling?.textContent).toBe(
      '2 high · 11 medium · 1 low',
    );
    expect(measure(plant, 'average-rate')).toContain('0.2917');
    await waitFor(() => {
      expect(measure(plant, 'average-rate')).toContain('Acceptable (≤ 1 per 10 min)');
    });
    expect(measure(plant, 'peak10')).toBe('12');
    // The shift is running: the average is over the whole shift, which is not over (review).
    expect(plant.textContent).toContain('Over the whole shift; the shift is not over');
    expect(measure(plant, 'flood-windows')).toBe('1 of 48');
    expect(measure(plant, 'flood-episodes')).toBe('1 (4.0 min)');
    expect(measure(plant, 'chattering')).toBe('3 (1)');
    expect(measure(plant, 'fleeting')).toBe('1');
    expect(measure(plant, 'standing')).toBe('0 (1)');
    expect(measure(plant, 'active-time')).toBe('25.5 min');
    expect(
      within(plant)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Final', 'Revision 1']);
    const cell = screen.getByTestId('kpi-card-position-cell-m1');
    await waitFor(() => {
      expect(within(cell).getByText('Provisional')).toBeTruthy();
    });
    // Line A1 has no bucket for the shift: no measure, never 0; the headline is a dash with its
    // reason (E-01, UX-4b), the raw marker stays `n/a`.
    const line = screen.getByTestId('kpi-card-position-line-a1');
    await waitFor(() => {
      expect(line.dataset.raises).toBe('n/a');
    });
    expect(measure(line, 'peak10')).toBeUndefined();
    const empty = await screen.findByTestId('kpi-empty-position-line-a1');
    expect(empty.textContent).toContain('No alarm KPIs for this shift yet');
    expect(within(line).queryByText(/n\/a/)).toBeNull();
    // The section says the finality once (E-03): a mix here, so each card says its own.
    expect(screen.getByTestId('kpi-finality').dataset.finality).toBe('mixed');
    expect(screen.getByTestId('kpi-finality').textContent).toBe('1 of 2 final');
    // Equipment scopes have no card.
    expect(screen.queryByTestId('kpi-card-equipment-cnc-01')).toBeNull();
    // The card reads the plant's shift bucket over the shift (the hours are the details' read).
    const read = server.paths.find(
      (path) => path.startsWith('/api/v1/alarms/kpi?scope=plant') && path.includes('bucket=shift'),
    );
    expect(read).toContain(`from=${encodeURIComponent(SHIFT_START)}`);
    expect(read).toContain(`to=${encodeURIComponent(SHIFT_END)}`);
  });

  it('shows the details of the focus: hours, floods, bad actors and operator measures', async () => {
    const server = mes({
      hours: [
        hourKpi('2026-10-15T04:00:00.000Z', { raises: 2, peak10: 1, final: true }),
        hourKpi('2026-10-15T05:00:00.000Z', { raises: 12, peak10: 12, fleetingUndecided: 1 }),
      ],
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms/kpi?focus=position:cell-m1');
    expect((await screen.findByTestId<HTMLSelectElement>('kpi-focus')).value).toBe(
      'position:cell-m1',
    );
    const rows = await screen.findAllByTestId(/^kpi-row-/);
    expect(rows.map((row) => row.dataset.final)).toEqual(['true', 'false']);
    expect(rows[1]?.textContent).toContain('12');
    expect(rows[1]?.textContent).toContain('+1?');
    expect(rows[0]?.textContent).toContain('07:00–08:00');
    expect(screen.getByTestId('kpi-hourly')).toBeTruthy();

    const floods = await screen.findByTestId('flood-x');
    expect(floods.dataset.open).toBe('true');
    expect(floods.textContent).toContain('In flood');
    const actor = await screen.findByTestId('bad-actor-cnc-01-COOLANT-PRESSURE');
    expect(actor.textContent).toContain('85.71 %');
    // UX-1c (#315): the share's raw four decimals.
    expect(within(actor).getByText('85.71 %').dataset.decimal).toBe('0.8571');
    expect(expectDecimals(document.body).length).toBeGreaterThanOrEqual(1);
    expect(actor.textContent).toContain('10.0 min');

    const operator = screen.getByTestId('kpi-operator');
    await waitFor(() => {
      expect(measure(operator, 'mean-time-to-ack')).toBe('0.6 min');
    });
    expect(operator.dataset.provisional).toBe('true');
    expect(measure(operator, 'max-time-to-ack')).toBe('1.0 min');
    expect(measure(operator, 'shelved-raises')).toBe('2');
    expect(measure(operator, 'unacknowledged')).toBe('4');
    expect(screen.getByTestId('kpi-shelved-points').textContent).toContain('15.0 min');
    expect(
      server.paths.some(
        (path) =>
          path.startsWith('/api/v1/alarms/operator-kpi?scope=position&id=cell-m1') &&
          path.includes('bucket=range'),
      ),
    ).toBe(true);

    // Shift buckets of the last week instead of hours.
    fireEvent.change(screen.getByTestId('kpi-bucket'), { target: { value: 'shift' } });
    await waitFor(() => {
      expect(screen.getByTestId('kpi-buckets').dataset.bucket).toBe('shift');
    });
    expect(screen.queryByTestId('kpi-hourly')).toBeNull();
  });

  /** The hour rows of the bucket table, in order, by test id. */
  const hourRows = (table: HTMLElement) =>
    [...table.querySelectorAll<HTMLElement>('tbody tr')].map((row) => row.dataset.testid);
  const hour = (h: number) => `2026-10-15T0${String(h)}:00:00.000Z`;
  interface Bars {
    readonly xAxis: { readonly data: readonly string[] };
    readonly series: readonly { readonly data: readonly unknown[] }[];
  }

  it('fills the hours the MES leaves out as no alarm activity, up to the plant clock (K-02)', async () => {
    // The shift is 03:00–11:00 UTC, the plant clock at 06:10. The MES lists 04:00 (alarms) and
    // the hour in progress, 06:00 (ADR-0024); 03:00 and 05:00 were quiet.
    const server = mes({
      hours: [
        hourKpi(hour(4), { raises: 2, peak10: 1, final: true }),
        hourKpi(hour(6), { raises: 1, peak10: 1 }),
      ],
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms/kpi?focus=plant');
    const table = await screen.findByTestId('kpi-buckets');
    await waitFor(() => {
      expect(hourRows(table)).toEqual([
        `kpi-quiet-${hour(3)}`,
        `kpi-row-${hour(4)}`,
        `kpi-quiet-${hour(5)}`,
        `kpi-row-${hour(6)}`,
      ]);
    });
    // A filled hour: "No alarm activity", the empty bucket's zeros, no invented finality.
    const quiet = screen.getByTestId(`kpi-quiet-${hour(3)}`);
    expect(quiet.textContent).toContain('06:00–07:00');
    expect(quiet.textContent).toContain('No alarm activity');
    expect(quiet.dataset.quiet).toBe('true');
    expect(quiet.dataset.final).toBeUndefined();
    expect(quiet.dataset.revision).toBeUndefined();
    expect(within(quiet).queryByText(/Final|Provisional/)).toBeNull();
    // The rows differ in finality, so the table has a status column: the dash for a filled hour.
    expect(quiet.querySelector('[data-missing]')?.getAttribute('title')).toContain('no finality');
    // The hour in progress is the MES's own bucket, provisional.
    expect(screen.getByTestId(`kpi-row-${hour(6)}`).dataset.final).toBe('false');
    // No hour after the plant clock's.
    expect(screen.queryByTestId(`kpi-quiet-${hour(7)}`)).toBeNull();
    expect(screen.getByTestId('kpi-quiet-note').textContent).toContain('No alarm activity');
    // The section's finality counts the MES's buckets only.
    expect(screen.getByTestId('kpi-buckets-finality').textContent).toBe('1 of 2 final');
    // The chart covers the shift so far, with a zero bar for each quiet hour.
    await waitFor(() => {
      const option = charts.options.at(-1) as Bars | undefined;
      expect(option?.xAxis.data).toEqual(['06:00', '07:00', '08:00', '09:00']);
      expect(option?.series[0]?.data).toEqual([0, 2, 0, 1]);
    });
  });

  it('fills a past shift to its end and lets a pushed hour replace a filled one', async () => {
    // The plant clock is past the shift's end (12:30): every hour of the shift, 03:00 to 10:00,
    // and none after it. The MES's list lacks 10:00 (quiet when read); a push then brings it.
    const server = mes({ hours: [hourKpi(hour(4), { raises: 2, peak10: 1 })] });
    vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
      new URL(requestUrl(input), 'http://localhost').pathname === '/api/v1/plant'
        ? Promise.resolve(
            json({
              ...PLANT,
              clock: { ...PLANT.clock, watermark: '2026-10-15T12:30:00.000Z' },
              epochs: [{ ...PLANT.clock, watermark: '2026-10-15T12:30:00.000Z' }],
            }),
          )
        : server.fetch(input),
    );
    const app = await renderApp('/alarms/kpi?focus=plant');
    await app.open();
    const table = await screen.findByTestId('kpi-buckets');
    const ten = '2026-10-15T10:00:00.000Z';
    await waitFor(() => {
      expect(hourRows(table)).toHaveLength(8);
    });
    expect(hourRows(table).at(-1)).toBe(`kpi-quiet-${ten}`);
    await waitFor(() => {
      expect(app.factory.last.sent.map((message) => message.topic)).toContain('alarm-kpi:plant');
    });
    await app.push({
      type: 'alarm-kpi',
      topic: 'alarm-kpi:plant',
      hour: hourKpi(ten, { raises: 5, peak10: 4 }),
      shift: kpiBucket(),
      floods: [],
    });
    await waitFor(() => {
      expect(hourRows(table).at(-1)).toBe(`kpi-row-${ten}`);
    });
    expect(hourRows(table)).toHaveLength(8);
    expect(screen.queryByTestId(`kpi-quiet-${ten}`)).toBeNull();
    expect(screen.getByTestId(`kpi-row-${ten}`).textContent).toContain('5');
  });

  it('bands the rate and draws the threshold with the configuration the MES serves (#160)', async () => {
    // A 1-minute window: 7/24 raises per window are 70/24 per 10 minutes, over 2; with a
    // manageable benchmark of 3 they are manageable. Threshold 6 instead of 10.
    const config = alarmConfig({
      kpi: { windowMs: 60_000, floodThreshold: 6 },
      benchmarks: { manageablePer10Min: 3 },
    });
    const server = mes({
      config,
      shift: { plant: [kpiBucket()] },
      hours: [hourKpi('2026-10-15T05:00:00.000Z', { raises: 12, peak10: 8 })],
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms/kpi?focus=plant');
    const plant = await screen.findByTestId('kpi-card-plant');
    await waitFor(() => {
      expect(measure(plant, 'average-rate')).toContain('Manageable (≤ 3 per 10 min)');
    });
    expect(plant.querySelector('[data-band]')?.getAttribute('data-band')).toBe('manageable');
    // Colour only for abnormal: manageable is a warning; acceptable stays neutral (UX-4b).
    expect(within(plant).getByText(/^Manageable/).className).toContain('warn');
    await waitFor(() => {
      expect(charts.options.length).toBeGreaterThan(0);
      expect(thresholdLine(charts.options.at(-1))).toEqual([6]);
    });
    // The labels, the chart's title and its peak series name the served window (#147).
    const label = (name: string) =>
      plant.querySelector(`[data-measure="${name}"]`)?.previousElementSibling?.textContent;
    expect([label('average-rate'), label('peak10')]).toEqual([
      'Average per 1 min',
      'Peak per 1 min',
    ]);
    expect(screen.getByTestId('kpi-hourly').textContent).toContain('Raises and peak per 1 min');
    expect(within(screen.getByTestId('kpi-buckets')).getByText('Avg / 1 min')).toBeTruthy();
    expect((charts.options.at(-1) as { series: { name: string }[] }).series[1]?.name).toBe(
      'Peak per 1 min',
    );
    expect(server.paths.filter((path) => path === '/api/v1/alarms/config')).toHaveLength(1);
  });

  it('hands the chart the same option when it re-renders without new data (UX-1f)', async () => {
    // A new option redraws the chart (`notMerge`) and drops an open tooltip: a push that changes
    // only the shift's card re-renders the hourly chart but must not build its option again.
    const server = mes({
      shift: { plant: [kpiBucket()] },
      hours: [hourKpi('2026-10-15T05:00:00.000Z', { raises: 12, peak10: 8 })],
    });
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/alarms/kpi?focus=plant');
    await app.open();
    await waitFor(() => {
      expect(thresholdLine(charts.options.at(-1))).toEqual([10]);
    });
    await waitFor(() => {
      expect(app.factory.last.sent.map((message) => message.topic)).toContain('alarm-kpi:plant');
    });
    const shiftOnly = (raises: number) => ({
      type: 'alarm-kpi' as const,
      topic: 'alarm-kpi:plant',
      hour: null,
      shift: kpiBucket({ raises }),
      floods: [],
    });
    await app.push(shiftOnly(15));
    await settle(() => undefined);
    const drawn = charts.options.at(-1);
    const renders = charts.options.length;
    await app.push(shiftOnly(16));
    await settle(() => undefined);
    expect(charts.options.length).toBeGreaterThan(renders);
    for (const option of charts.options.slice(renders)) expect(option).toBe(drawn);
  });

  it('shows a dash for a mean time to acknowledge without acknowledgements', async () => {
    const server = mes({
      operator: json({
        scope: 'plant',
        id: 'plant',
        bucket: 'range',
        from: SHIFT_START,
        to: SHIFT_END,
        epoch: 1,
        buckets: [
          operatorBucket({ timeToAck: { count: 0, sumMs: 0, maxMs: null }, shelvedMs: [] }),
        ],
      }),
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms/kpi');
    const operator = await screen.findByTestId('kpi-operator');
    await waitFor(() => {
      expect(measure(operator, 'acknowledged')).toBe('0');
    });
    // Not applicable (design system 6.3): the dash with its reason, never "n/a".
    for (const name of ['mean-time-to-ack', 'max-time-to-ack']) {
      const value = operator.querySelector(`[data-measure="${name}"]`);
      expect(value?.querySelector('[data-missing]')?.getAttribute('title')).toBe(
        'No acknowledgement in this shift',
      );
      expect(value?.textContent).not.toContain('n/a');
      // The reason is visible text, as a tile's (review), and said once to a screen reader.
      expect(value?.textContent).toBe('—No acknowledgement in this shift');
    }
  });

  it('updates the cards live from alarm-kpi pushes and keeps a final REST bucket', async () => {
    const server = mes({ shift: { plant: [kpiBucket()] } });
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/alarms/kpi');
    await app.open();
    const plant = await screen.findByTestId('kpi-card-plant');
    await waitFor(() => {
      expect(plant.dataset.raises).toBe('14');
    });
    await waitFor(() => {
      expect(app.factory.last.sent.map((message) => message.topic)).toEqual(
        expect.arrayContaining([
          'alarm-kpi:plant',
          'alarm-kpi:position:cell-m1',
          'alarm-kpi:position:line-a1',
          'alarms',
        ]),
      );
    });
    await app.push({
      type: 'alarm-kpi',
      topic: 'alarm-kpi:plant',
      hour: hourKpi('2026-10-15T06:00:00.000Z'),
      shift: kpiBucket({ raises: 15, averageRate: { fraction: '5/16', decimal: '0.3125' } }),
      floods: [],
    });
    expect(plant.dataset.raises).toBe('15');
    expect(measure(plant, 'average-rate')).toContain('0.3125');
    // A pushed bucket of another shift is not this shift's.
    await app.push({
      type: 'alarm-kpi',
      topic: 'alarm-kpi:plant',
      hour: null,
      shift: kpiBucket({ key: '2026-10-15/B', raises: 1 }),
      floods: [],
    });
    expect(plant.dataset.raises).toBe('14');
  });

  it('says when the KPIs cannot be read', async () => {
    const server = mes({});
    vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
      new URL(requestUrl(input), 'http://localhost').pathname === '/api/v1/alarms/scopes'
        ? Promise.resolve(problem(503, 'Service Unavailable', 'alarms not ready', '/x'))
        : server.fetch(input),
    );
    await renderApp('/alarms/kpi');
    expect(await screen.findByText(/Could not load the alarm scopes/)).toBeTruthy();
    expect(screen.getByText(/alarms not ready/)).toBeTruthy();
  });

  /** The `<section>` a heading names. */
  function section(name: string): HTMLElement {
    const found = screen.getByRole('heading', { name }).closest('section');
    if (!found) throw new Error(`no section for ${name}`);
    return found;
  }

  /** The KPI server with these paths answering 503. */
  function failing(paths: readonly string[]) {
    const server = mes({});
    const down = { on: true };
    const fetch = (input: RequestInfo | URL) => {
      const path = new URL(requestUrl(input), 'http://localhost').pathname;
      return down.on && paths.includes(path)
        ? Promise.resolve(problem(503, 'Service Unavailable', 'KPIs not ready', path))
        : server.fetch(input);
    };
    return { server, down, fetch };
  }

  it('says one error when every KPI read fails, the sections not drawn, one retry for all (#394)', async () => {
    const { server, down, fetch } = failing([
      '/api/v1/alarms/kpi',
      '/api/v1/alarms/floods',
      '/api/v1/alarms/bad-actors',
      '/api/v1/alarms/operator-kpi',
    ]);
    vi.stubGlobal('fetch', fetch);
    await renderApp('/alarms/kpi');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Could not load the KPIs, the buckets, the floods, the bad actors and the operator measures.',
    );
    expect(within(alert).getAllByText(/KPIs not ready/)).toHaveLength(1);
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    expect(document.getElementById('kpi-scopes-title')).toBeNull();
    expect(document.getElementById('kpi-details-title')).toBeNull();

    down.on = false;
    server.paths.length = 0;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('kpi-card-plant')).toBeTruthy();
    expect(await screen.findByTestId('kpi-floods')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    for (const path of ['kpi', 'floods', 'bad-actors', 'operator-kpi']) {
      expect(server.paths.some((p) => p.startsWith(`/api/v1/alarms/${path}?`))).toBe(true);
    }
  });

  it('says one failed section in that section, under its heading (#394)', async () => {
    vi.stubGlobal('fetch', failing(['/api/v1/alarms/floods']).fetch);
    await renderApp('/alarms/kpi');
    await screen.findByRole('heading', { name: 'Flood episodes' });
    const floods = section('Flood episodes');
    const alert = await within(floods).findByRole('alert');
    expect(alert.textContent).toContain('Could not load the floods.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    expect(await screen.findByTestId('kpi-bad-actors')).toBeTruthy();
  });

  it('names several failed sections in one error, each section saying it quietly (#394)', async () => {
    vi.stubGlobal('fetch', failing(['/api/v1/alarms/floods', '/api/v1/alarms/bad-actors']).fetch);
    await renderApp('/alarms/kpi');
    const alert = await screen.findByRole('alert');
    await waitFor(() => {
      expect(alert.textContent).toContain('Could not load the floods and the bad actors.');
    });
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    // Under the page header, not inside the details it names.
    const details = document.getElementById('kpi-details-title')?.closest('section');
    expect(details?.contains(alert)).toBe(false);
    const floods = section('Flood episodes');
    const line = floods.querySelector('[data-error]');
    expect(line?.getAttribute('data-error')).toBe('quiet');
    expect(line?.textContent).toContain('Could not load the floods.');
    expect(within(floods).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByTestId('kpi-operator')).toBeTruthy();
  });
});
