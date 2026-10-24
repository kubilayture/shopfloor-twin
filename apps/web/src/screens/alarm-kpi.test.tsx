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
import { renderApp } from '../test/render-app.tsx';
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
  it('shows each scope of the shift exactly, with its status, and n/a without data', async () => {
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
    expect(measure(plant, 'raises')).toBe('14 (2 / 11 / 1)');
    expect(measure(plant, 'average-rate')).toContain('0.2917');
    await waitFor(() => {
      expect(measure(plant, 'average-rate')).toContain('Acceptable (≤ 1 per 10 min)');
    });
    expect(measure(plant, 'peak10')).toBe('12');
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
    // Line A1 has no bucket for the shift: every measure is n/a, never 0.
    const line = screen.getByTestId('kpi-card-position-line-a1');
    await waitFor(() => {
      expect(line.dataset.raises).toBe('n/a');
    });
    expect(measure(line, 'peak10')).toBe('n/a');
    expect(screen.getByTestId('kpi-empty-position-line-a1')).toBeTruthy();
    // Equipment scopes have no card.
    expect(screen.queryByTestId('kpi-card-equipment-cnc-01')).toBeNull();
    const read = server.paths.find((path) => path.startsWith('/api/v1/alarms/kpi?scope=plant'));
    expect(read).toContain('bucket=shift');
    expect(read).toContain(`from=${encodeURIComponent(SHIFT_START)}`);
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

  it('shows n/a for a mean time to acknowledge without acknowledgements', async () => {
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
    expect(measure(operator, 'mean-time-to-ack')).toBe('n/a');
    expect(measure(operator, 'max-time-to-ack')).toBe('n/a');
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
});
