import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EQUIPMENT, PLANT, fakeFetch, json, problem } from '../test/fixtures.ts';
import {
  BOTTLENECKS,
  CURRENT_SHIFT,
  PARETO,
  PREVIOUS_SHIFT,
  SHIFT,
  SHIFT_END,
  SHIFT_KEY,
  SHIFT_START,
  bucket,
  emptyResult,
  hourBucket,
  lineBucket,
  lineOee,
  requestUrl,
  result,
} from '../test/oee-fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';
import { expectDecimals } from '../test/decimals.ts';
import { NA_REASON } from '../components/oee-ui.tsx';

// jsdom has no canvas: the chart is a stub, the tables beside it carry the values. It records
// every option it is given (UX-1f: an unrelated re-render must hand it the same option).
const charts = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('../chart/echarts-view.tsx', () => ({
  EChartsView: ({ option }: { option: unknown }) => {
    charts.options.push(option);
    return null;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  charts.options.length = 0;
});

function api(overrides: Record<string, (url: URL) => Response> = {}) {
  return fakeFetch({
    '/api/v1/equipment': () => json({ equipment: EQUIPMENT }),
    '/api/v1/plant': () => json(PLANT),
    '/api/v1/shifts/current': () => json(CURRENT_SHIFT),
    '/api/v1/shifts': () =>
      json({ from: SHIFT_START, to: SHIFT_END, shifts: [PREVIOUS_SHIFT, SHIFT] }),
    '/api/v1/shifts/2026-10-15/A/oee': () =>
      json({
        shiftKey: SHIFT.key,
        start: SHIFT_START,
        end: SHIFT_END,
        equipment: [
          bucket('cnc-01', { final: true }),
          bucket('wsh-01', { revision: 1, incidents: 2 }),
          bucket('asm-01', { result: emptyResult() }),
        ],
        workCenters: [bucket('cell-m1'), bucket('line-a1', { result: emptyResult() })],
      }),
    '/api/v1/oee': (url) =>
      json({
        scope: url.searchParams.get('scope'),
        id: url.searchParams.get('id'),
        bucket: 'hour',
        from: SHIFT_START,
        to: SHIFT_END,
        buckets: [
          hourBucket('cell-m1', '2026-10-15T03:00:00.000Z', { final: true }),
          hourBucket('cell-m1', '2026-10-15T04:00:00.000Z', { result: emptyResult() }),
        ],
      }),
    '/api/v1/downtime/pareto': () => json(PARETO),
    '/api/v1/oee/line': (url) =>
      url.searchParams.get('bucket') === 'shift'
        ? json(lineOee('shift', [lineBucket('shift', SHIFT_KEY, { final: true })]))
        : json(
            lineOee('hour', [
              lineBucket('hour', '2026-10-15T03:00:00.000Z', { final: true }),
              lineBucket('hour', '2026-10-15T04:00:00.000Z', {
                oee: { fraction: '21/20', decimal: '1.0500' },
                aboveOne: true,
              }),
            ]),
          ),
    ...overrides,
  });
}

describe('OEE dashboard', () => {
  it('shows the API values per work center and machine, n/a never as 0', async () => {
    vi.stubGlobal('fetch', api());
    await renderApp('/oee');
    const cell = await screen.findByTestId('oee-card-cell-m1');
    expect(cell.dataset.oee).toBe('0.6300');
    expect(within(cell).getByTestId('oee-value-cell-m1').textContent).toBe('63.00 %');
    // E-02: A, P and Q as percentages, the four decimals in data-decimal.
    expect(within(cell).getByText('80.00 %').dataset.decimal).toBe('0.8000');
    expect(within(cell).getByText('87.50 %').dataset.fraction).toBe('7/8');
    expect(within(cell).getByTestId('oee-own-cell-m1').textContent).toBe('2.5 min');
    expect(within(cell).getByTestId('oee-external-cell-m1').textContent).toBe('0.8 min');
    // E-03: the work centers are all provisional: said once, beside the section's heading.
    expect(within(cell).queryByText(/Provisional/)).toBeNull();
    const centers = screen.getByTestId('wc-finality');
    expect(centers.textContent).toBe('Provisional');
    expect(centers.getAttribute('title')).toContain('up to 2.0 min');
    await waitFor(() => {
      expect(screen.getByTestId('bottleneck-line-a1').dataset.state).toBe('known');
    });
    expect(screen.queryByTestId('bottleneck-cell-m1')).toBeNull();

    const line = screen.getByTestId('oee-card-line-a1');
    expect(line.dataset.oee).toBe('n/a');
    // E-01: no value is a dash with its reason as the visible hint, never "n/a" at headline size.
    expect(within(line).getByTestId('oee-value-line-a1').textContent).toBe('—');
    expect(within(line).getByText(NA_REASON.oee)).toBeTruthy();
    // The bottleneck is the MES's answer (`GET /oee/line`), not a constant of the web.
    const named = await within(line).findByTestId('bottleneck-line-a1');
    expect(named.textContent).toContain('asm-01');
    expect(named.textContent).toContain('VB-100, VB-200');
    expect(named.dataset.equipment).toBe('asm-01');

    expect(screen.getByTestId('oee-machine-cnc-01').dataset.oee).toBe('0.6300');
    // The machines are a mix: the section says how many are final, each row its own finality.
    expect(screen.getByTestId('machine-finality').textContent).toBe('1 of 3 final');
    expect(within(screen.getByTestId('oee-machine-cnc-01')).getByText('Final')).toBeTruthy();
    const wsh = screen.getByTestId('oee-machine-wsh-01');
    expect(within(wsh).getByText('Revision 1')).toBeTruthy();
    expect(within(wsh).getByText('2 incidents')).toBeTruthy();
    const asm = screen.getByTestId('oee-machine-asm-01');
    expect(asm.dataset.oee).toBe('n/a');
    expect(within(asm).getByText('Bottleneck')).toBeTruthy();

    const waterfall = screen.getByTestId('waterfall');
    expect(within(waterfall).getByTestId('waterfall-pbt').textContent).toContain('16.7 min');
    expect(within(waterfall).getByTestId('waterfall-productive').textContent).toContain('10.5 min');
    // E-06: the sign against the number, as the chart labels it.
    expect(within(waterfall).getByTestId('waterfall-own').textContent).toContain('−2.5 min');
    expect(within(waterfall).queryByRole('alert')).toBeNull();

    const pareto = await screen.findByTestId('pareto-BREAKDOWN/SPINDLE-OVERLOAD');
    expect(pareto.textContent).toContain('1.7 min');
    // The demo walkthrough reads the time as the row's third cell.
    expect(pareto.querySelectorAll('td')[2]?.textContent).toBe('1.7 min');
    expect(within(screen.getByTestId('pareto')).getByText(/CHIP-JAM/)).toBeTruthy();
    expect(screen.getByTestId('pareto').textContent).toContain('Availability loss:');
    expect(await screen.findByTestId('hour-2026-10-15T04:00:00.000Z')).toBeTruthy();
    expect(screen.getByTestId('hour-2026-10-15T04:00:00.000Z').textContent).toContain('—');

    // UX-1c (#315): every ratio element carries its raw four decimals, n/a included.
    expect(within(cell).getByTestId('oee-value-cell-m1').dataset.decimal).toBe('0.6300');
    expect(within(line).getByTestId('oee-value-line-a1').dataset.decimal).toBe('n/a');
    // The machine table's availability cell, which the demo walkthrough reads (td.nth(1)) by
    // its data-decimal: the percentage shown, the four decimals raw.
    const availability = screen
      .getByTestId('oee-machine-cnc-01')
      .querySelectorAll('td')[1]
      ?.querySelector<HTMLElement>('[data-decimal]');
    expect(availability?.dataset.decimal).toBe('0.8000');
    expect(availability?.textContent).toBe('80.00 %');
    expect(
      asm.querySelectorAll('td')[0]?.querySelector<HTMLElement>('[data-decimal]')?.dataset.decimal,
    ).toBe('n/a');
    const hour = screen
      .getByTestId('hour-2026-10-15T04:00:00.000Z')
      .querySelectorAll('td')[0]
      ?.querySelector<HTMLElement>('[data-decimal]');
    expect(hour?.dataset.decimal).toBe('n/a');
    expect(expectDecimals(document.body).length).toBeGreaterThanOrEqual(20);
  });

  it('hands each chart the same option when it re-renders without new data (UX-1f)', async () => {
    // A new option redraws the chart (`notMerge`) and drops an open tooltip: a push that changes
    // nothing the charts show re-renders them but must not build their options again.
    vi.stubGlobal('fetch', api());
    const app = await renderApp('/oee');
    await app.open();
    await screen.findByTestId('pareto-BREAKDOWN/SPINDLE-OVERLOAD');
    await screen.findByTestId('hour-2026-10-15T04:00:00.000Z');
    await waitFor(() => {
      expect(app.factory.last.sent.map((message) => message.topic)).toContain('oee:cell-m1');
    });
    // A bucket of another shift for the focused work center: its live value changes, the shown
    // buckets don't.
    const otherShift = (revision: number) => ({
      type: 'oee' as const,
      topic: 'oee:cell-m1',
      hour: null,
      shift: bucket('cell-m1', {
        key: '2026-10-15/B',
        shiftKey: '2026-10-15/B',
        revision,
      }),
    });
    await app.push(otherShift(1));
    await settle(() => undefined);
    expect(new Set(charts.options.slice(-3)).size).toBe(3);
    const drawn = new Set(charts.options);
    const renders = charts.options.length;
    await app.push(otherShift(2));
    await settle(() => undefined);
    expect(charts.options.length).toBeGreaterThan(renders);
    for (const option of charts.options.slice(renders)) expect(drawn.has(option)).toBe(true);
  });

  it('subscribes to every work center and machine and applies pushed buckets', async () => {
    vi.stubGlobal('fetch', api());
    const app = await renderApp('/oee');
    await app.open();
    await screen.findByTestId('oee-card-cell-m1');
    await waitFor(() => {
      expect(app.factory.last.sent.map((message) => message.topic)).toEqual([
        'oee:line',
        'states',
        'oee:cell-m1',
        'oee:line-a1',
        'oee:cnc-01',
        'oee:wsh-01',
        'oee:asm-01',
        'downtime',
      ]);
    });

    await app.push({
      type: 'oee',
      topic: 'oee:cell-m1',
      hour: hourBucket('cell-m1', '2026-10-15T05:00:00.000Z'),
      shift: bucket('cell-m1', {
        result: result({ oee: { fraction: '7/10', decimal: '0.7000' } }),
      }),
    });
    expect(screen.getByTestId('oee-card-cell-m1').dataset.oee).toBe('0.7000');
    expect(screen.getByTestId('hour-2026-10-15T05:00:00.000Z')).toBeTruthy();

    // The waterfall says when pushed values don't add up rather than inventing a bar.
    expect(within(screen.getByTestId('waterfall')).getByRole('alert')).toBeTruthy();

    await app.push({
      type: 'snapshot',
      topic: 'oee:cnc-01',
      hour: null,
      shift: bucket('cnc-01', { final: true, result: emptyResult() }),
    });
    expect(screen.getByTestId('oee-machine-cnc-01').dataset.oee).toBe('n/a');

    // A bucket of another shift doesn't touch this one.
    await app.push({
      type: 'oee',
      topic: 'oee:line-a1',
      hour: null,
      shift: bucket('line-a1', { key: '2026-10-15/B', shiftKey: '2026-10-15/B' }),
    });
    expect(screen.getByTestId('oee-card-line-a1').dataset.oee).toBe('n/a');
  });

  it('shows pushed values only for the buckets the clock is in, and rereads the rest', async () => {
    const reads: string[] = [];
    const base = api();
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      reads.push(new URL(requestUrl(input), 'http://localhost').pathname);
      return base(input);
    });
    const app = await renderApp('/oee');
    await app.open();
    await screen.findByTestId('hour-2026-10-15T04:00:00.000Z');
    const pushed = (hourStart: string, shift = bucket('cell-m1')) =>
      app.push({
        type: 'oee',
        topic: 'oee:cell-m1',
        hour: hourBucket('cell-m1', hourStart, {
          result: result({ oee: { fraction: '1/2', decimal: '0.5000' } }),
        }),
        shift: { ...shift, result: result({ oee: { fraction: '7/10', decimal: '0.7000' } }) },
      });
    await pushed('2026-10-15T05:00:00.000Z');
    expect(screen.getByTestId('hour-2026-10-15T05:00:00.000Z').textContent).toContain('50.00 %');
    const hourlyReads = () => reads.filter((path) => path === '/api/v1/oee').length;
    const before = hourlyReads();

    // The clock moves on: 05:00 is no longer pushed (REST has no such hour here), REST is read.
    await pushed('2026-10-15T06:00:00.000Z');
    expect(screen.queryByTestId('hour-2026-10-15T05:00:00.000Z')).toBeNull();
    expect(screen.getByTestId('hour-2026-10-15T06:00:00.000Z')).toBeTruthy();
    await waitFor(() => {
      expect(hourlyReads()).toBeGreaterThan(before);
    });

    // A new shift: the selected shift's card falls back to its REST value.
    expect(screen.getByTestId('oee-card-cell-m1').dataset.oee).toBe('0.7000');
    await pushed('2026-10-15T11:00:00.000Z', bucket('cell-m1', { key: '2026-10-15/B' }));
    expect(screen.getByTestId('oee-card-cell-m1').dataset.oee).toBe('0.6300');
    await waitFor(() => {
      expect(reads.filter((path) => path === '/api/v1/shifts/2026-10-15/A/oee').length).toBe(2);
    });
  });

  it('switches to an earlier shift and to a machine', async () => {
    const fetched: string[] = [];
    const base = api({
      '/api/v1/shifts/2026-10-14/C/oee': () =>
        json({
          shiftKey: PREVIOUS_SHIFT.key,
          start: PREVIOUS_SHIFT.start,
          end: PREVIOUS_SHIFT.end,
          equipment: [bucket('cnc-01', { key: PREVIOUS_SHIFT.key, final: true })],
          workCenters: [bucket('cell-m1', { key: PREVIOUS_SHIFT.key, final: true })],
        }),
    });
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      fetched.push(requestUrl(input));
      return base(input);
    });
    const app = await renderApp('/oee');
    const select = await screen.findByTestId('shift-select');
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(2);
    });
    expect(within(select).getAllByRole('option')[0]?.textContent).toContain('– current');
    fireEvent.change(select, { target: { value: PREVIOUS_SHIFT.key } });
    await waitFor(() => {
      expect(screen.getByTestId('oee-card-cell-m1').dataset.final).toBe('true');
    });
    expect(app.history.location.search).toContain('shift=');
    expect(screen.getByTestId('oee-card-line-a1').textContent).toContain('No data');
    // Every machine final: said once beside the heading, and no status column of repeats (E-03).
    expect(screen.getByTestId('machine-finality').textContent).toBe('Final');
    expect(
      within(screen.getByTestId('machine-oee-table')).queryByRole('columnheader', {
        name: 'Status',
      }),
    ).toBeNull();
    expect(within(screen.getByTestId('oee-machine-cnc-01')).queryByText('Final')).toBeNull();

    fireEvent.change(screen.getByTestId('focus-select'), { target: { value: 'cnc-01' } });
    await waitFor(() => {
      expect(fetched.some((url) => url.includes('scope=equipment&id=cnc-01'))).toBe(true);
    });
  });

  it('shows the line OEE of the shift, its hours and the bottleneck per product', async () => {
    vi.stubGlobal('fetch', api());
    await renderApp('/oee');
    const card = await screen.findByTestId('line-oee-card');
    await waitFor(() => {
      expect(card.dataset.oee).toBe('0.7500');
    });
    expect(card.dataset.final).toBe('true');
    expect(card.dataset.key).toBe(SHIFT_KEY);
    // E-02: the percentage shown; the four decimals (which the reconciliation reads) in
    // data-decimal, the exact fraction in data-fraction and the tooltip.
    const value = within(card).getByTestId('line-oee-value');
    expect(value.textContent).toBe('75.00 %');
    expect(value.dataset.decimal).toBe('0.7500');
    expect(value.dataset.fraction).toBe('3/4');
    expect(value.getAttribute('title')).toBe('3/4 exactly');
    const ratios = [...card.querySelectorAll<HTMLElement>('[data-fraction]')];
    expect(ratios.length).toBeGreaterThan(1);
    expect(expectDecimals(card).length).toBe(ratios.length);
    expect(within(card).getByTestId('line-oee-good').textContent).toBe('VB-100: 100');
    // Times as durations, as on the order detail (#367); the milliseconds in data-value.
    expect(within(card).getByTestId('line-oee-planned').textContent).toBe('5 h 33 min');
    expect(within(card).getByTestId('line-oee-planned').dataset.value).toBe('20000000');
    expect(within(card).getByTestId('line-oee-ideal').textContent).toBe('4 h 10 min');
    expect(card.querySelector('[data-flag="final"]')?.textContent).toBe('Final');
    expect(within(card).getByTestId('line-oee-mode').textContent).toContain(
      'only while an order is in progress',
    );
    expect(within(card).queryByTestId('line-oee-above-one')).toBeNull();
    const vb100 = within(card).getByTestId('line-bottleneck-VB-100');
    expect(vb100.dataset.equipment).toBe('asm-01');
    expect(vb100.textContent).toContain('150.000 s');
    expect(within(card).getByTestId('line-bottleneck-VB-200').textContent).toContain('210.000 s');
    // Hours: an hour above 1 says so, never capped.
    const above = await within(card).findByTestId('line-hour-2026-10-15T04:00:00.000Z');
    expect(above.dataset.oee).toBe('1.0500');
    expect(above.dataset.aboveOne).toBe('true');
    expect(above.textContent).toContain('Above 1');
    // Finality once beside the hour table (E-03): the hours are a mix, so each row says its own.
    expect(within(card).getByTestId('line-hours-finality').textContent).toBe('1 of 2 final');
    expect(within(card).getByTestId('line-hour-2026-10-15T03:00:00.000Z').dataset.final).toBe(
      'true',
    );
    // The machine table marks the MES's bottleneck.
    expect(within(screen.getByTestId('oee-machine-asm-01')).getByText('Bottleneck')).toBeTruthy();
    expect(within(screen.getByTestId('oee-machine-cnc-01')).queryByText('Bottleneck')).toBeNull();
  });

  it('follows oee:line: the current shift and hour, above 1 explained, the bottleneck', async () => {
    vi.stubGlobal('fetch', api());
    const app = await renderApp('/oee');
    await app.open();
    const card = await screen.findByTestId('line-oee-card');
    await waitFor(() => {
      expect(card.dataset.oee).toBe('0.7500');
    });
    // A provisional push does not take back the final REST bucket.
    await app.push({
      type: 'snapshot',
      topic: 'oee:line',
      productionMode: 'orders',
      bottlenecks: BOTTLENECKS,
      hour: null,
      shift: lineBucket('shift', SHIFT_KEY, { oee: { fraction: '1/2', decimal: '0.5000' } }),
    });
    expect(card.dataset.oee).toBe('0.7500');
    // A final pushed value above 1 replaces it, with the reason on screen.
    await app.push({
      type: 'oee-line',
      topic: 'oee:line',
      productionMode: 'orders',
      bottlenecks: [
        {
          product: 'VB-100',
          operation: 'OP10',
          equipment: ['cnc-01'],
          idealCycleMs: 240_000,
          effectiveCycleMs: '240000/1',
        },
      ],
      hour: lineBucket('hour', '2026-10-15T05:00:00.000Z', {
        oee: { fraction: '11/10', decimal: '1.1000' },
        aboveOne: true,
        final: true,
        revision: 1,
        incidents: [{ machine: 'pck-01', epoch: 1, id: 3, seqFrom: 5, seqTo: 6 }],
        mayRevise: true,
      }),
      shift: lineBucket('shift', SHIFT_KEY, {
        final: true,
        revision: 1,
        incidents: [{ machine: 'asm-01', epoch: 1, id: 7, seqFrom: 10, seqTo: 12 }],
        mayRevise: true,
        oee: { fraction: '21/20', decimal: '1.0500' },
        aboveOne: true,
      }),
    });
    expect(card.dataset.oee).toBe('1.0500');
    expect(card.dataset.aboveOne).toBe('true');
    expect(within(card).getByTestId('line-oee-above-one').textContent).toContain('not capped');
    for (const flag of ['final', 'revision', 'incidents', 'may-revise', 'above-one']) {
      expect(card.querySelector(`[data-flag="${flag}"]`)).toBeTruthy();
    }
    const revisedHour = within(card).getByTestId('line-hour-2026-10-15T05:00:00.000Z');
    expect(revisedHour.dataset.oee).toBe('1.1000');
    expect(
      [...revisedHour.querySelectorAll<HTMLElement>('[data-flag]')].map(
        (flag) => flag.dataset.flag,
      ),
    ).toEqual(['final', 'revision', 'incidents', 'may-revise', 'above-one']);
    // The bottleneck follows the MES's answer (here, for the test, a CNC).
    expect(within(screen.getByTestId('oee-machine-cnc-01')).getByText('Bottleneck')).toBeTruthy();
    expect(within(screen.getByTestId('oee-machine-asm-01')).queryByText('Bottleneck')).toBeNull();
    expect(screen.queryByTestId('bottleneck-line-a1')).toBeNull();
    expect(screen.getByTestId('bottleneck-cell-m1').dataset.equipment).toBe('cnc-01');
    // Another shift's bucket leaves the selected one alone.
    await app.push({
      type: 'oee-line',
      topic: 'oee:line',
      productionMode: 'orders',
      bottlenecks: BOTTLENECKS,
      hour: null,
      shift: lineBucket('shift', '2026-10-15/B', { oee: { fraction: '0/1', decimal: '0.0000' } }),
    });
    expect(card.dataset.oee).toBe('0.7500');
  });

  it('says the bottleneck is loading, then unknown when the line OEE read fails', async () => {
    vi.stubGlobal(
      'fetch',
      api({
        '/api/v1/oee/line': () => new Promise<Response>(() => undefined) as unknown as Response,
      }),
    );
    const loading = await renderApp('/oee');
    const pending = await screen.findByTestId('bottleneck-line-a1');
    expect(pending.dataset.state).toBe('loading');
    expect(pending.textContent).toContain('loading…');
    expect(screen.getByTestId('bottleneck-cell-m1').dataset.state).toBe('loading');
    expect(screen.getByTestId('machine-bottleneck-state').textContent).toContain('loading…');
    loading.unmount();

    vi.stubGlobal(
      'fetch',
      api({
        '/api/v1/oee/line': () =>
          problem(503, 'Service Unavailable', 'line OEE is not available', '/api/v1/oee/line'),
      }),
    );
    await renderApp('/oee');
    await waitFor(() => {
      expect(screen.getByTestId('bottleneck-line-a1').dataset.state).toBe('unknown');
    });
    expect(screen.getByTestId('bottleneck-line-a1').textContent).toContain(
      'unknown (line OEE unavailable)',
    );
    expect(screen.getByTestId('machine-bottleneck-state').textContent).toContain('unknown');
    expect(within(screen.getByTestId('oee-machine-asm-01')).queryByText('Bottleneck')).toBeNull();
  });

  it('shows an idle shift as an empty state with its reason, not a card of dashes (E-01)', async () => {
    const idle = { oee: null, plannedBusyMs: 0, good: {}, idealMs: '0/1' };
    vi.stubGlobal(
      'fetch',
      api({
        '/api/v1/oee/line': (url) =>
          url.searchParams.get('bucket') === 'shift'
            ? json(lineOee('shift', [lineBucket('shift', SHIFT_KEY, { ...idle, final: true })]))
            : json(
                lineOee('hour', [
                  lineBucket('hour', '2026-10-15T03:00:00.000Z', idle),
                  lineBucket('hour', '2026-10-15T04:00:00.000Z', idle),
                ]),
              ),
      }),
    );
    await renderApp('/oee');
    const card = await screen.findByTestId('line-oee-card');
    const empty = await within(card).findByTestId('line-oee-idle');
    expect(empty.textContent).toContain('No line time this shift');
    expect(empty.textContent).toContain('No order was in progress');
    expect(card.dataset.oee).toBe('n/a');
    expect(card.dataset.final).toBe('true');
    // The raw marker stays for the reconciliation's page read (`orders-pass.ts`: n/a).
    const marker = within(card).getByTestId('line-oee-value');
    expect(marker.dataset.decimal).toBe('n/a');
    expect(marker.dataset.fraction).toBe('n/a');
    expect(within(card).queryByTestId('line-oee-planned')).toBeNull();
    // Its finality is still said once, and the bottleneck still shown.
    expect(card.querySelector('[data-flag="final"]')).toBeTruthy();
    expect(within(card).getByTestId('line-bottleneck-VB-100')).toBeTruthy();
    // No hour had line time: one empty state, no rows of dashes.
    expect(await within(card).findByText('No hour with planned line time yet')).toBeTruthy();
    expect(card.querySelector('[data-testid^="line-hour-"]')).toBeNull();
  });

  it('lists the hours with line time and counts the others', async () => {
    vi.stubGlobal(
      'fetch',
      api({
        '/api/v1/oee/line': (url) =>
          url.searchParams.get('bucket') === 'shift'
            ? json(lineOee('shift', [lineBucket('shift', SHIFT_KEY)]))
            : json(
                lineOee('hour', [
                  lineBucket('hour', '2026-10-15T03:00:00.000Z'),
                  lineBucket('hour', '2026-10-15T04:00:00.000Z', { oee: null, good: {} }),
                  lineBucket('hour', '2026-10-15T05:00:00.000Z', { oee: null, good: {} }),
                  // Packed good without line time is still worth a row.
                  lineBucket('hour', '2026-10-15T06:00:00.000Z', { oee: null }),
                ]),
              ),
      }),
    );
    await renderApp('/oee');
    const card = await screen.findByTestId('line-oee-card');
    await within(card).findByTestId('line-hour-2026-10-15T03:00:00.000Z');
    expect(
      [...card.querySelectorAll('[data-testid^="line-hour-"]')].map((row) =>
        row.getAttribute('data-testid'),
      ),
    ).toEqual(['line-hour-2026-10-15T03:00:00.000Z', 'line-hour-2026-10-15T06:00:00.000Z']);
    expect(card.textContent).toContain('2 hours without planned line time not listed.');
    // Every listed hour provisional with nothing of its own: said once, no status column.
    expect(within(card).getByTestId('line-hours-finality').textContent).toBe('Provisional');
    expect(
      within(within(card).getByTestId('line-hours')).queryByRole('columnheader', {
        name: 'Status',
      }),
    ).toBeNull();
  });

  it('shows a Pareto without loss as its empty state alone', async () => {
    vi.stubGlobal(
      'fetch',
      api({
        '/api/v1/downtime/pareto': () =>
          json({ ...PARETO, reasons: [], availability: { own: 0, external: 0 } }),
      }),
    );
    await renderApp('/oee');
    const pareto = await screen.findByTestId('pareto');
    expect(await within(pareto).findByText('No availability loss in this shift.')).toBeTruthy();
    expect(pareto.textContent).not.toContain('Availability loss:');
    expect(within(pareto).queryByRole('table')).toBeNull();
  });

  it('says the hourly values’ finality once, without a status column of repeats', async () => {
    vi.stubGlobal('fetch', api());
    await renderApp('/oee');
    const values = await screen.findByTestId('hourly-values');
    // One hour final, one provisional: a mix, each row its own.
    expect(screen.getByTestId('hourly-finality').textContent).toBe('1 of 2 final');
    expect(within(values).getByRole('columnheader', { name: 'Status' })).toBeTruthy();
  });

  it('names a shift asked for outside the picker’s list in words, not by its key', async () => {
    vi.stubGlobal('fetch', api());
    await renderApp('/oee?shift=2020-01-06%2FA');
    const select = await screen.findByTestId('shift-select');
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('2020-01-06/A');
    });
    expect((select as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      'Mon 06 Jan, shift A',
    );
  });

  it('says when no shift has started', async () => {
    vi.stubGlobal(
      'fetch',
      api({
        '/api/v1/shifts/current': () => json({ clock: null, shiftKey: null, shift: null }),
      }),
    );
    await renderApp('/oee');
    expect(await screen.findByText(/plant clock has not started/)).toBeTruthy();
  });
});
