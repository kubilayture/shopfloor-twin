import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EQUIPMENT, PLANT, fakeFetch, json } from '../test/fixtures.ts';
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
import { renderApp } from '../test/render-app.tsx';

// jsdom has no canvas: the chart is a stub, the tables beside it carry the values.
vi.mock('../chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(within(cell).getByText('0.8000')).toBeTruthy();
    expect(within(cell).getByText('0.8750')).toBeTruthy();
    expect(within(cell).getByTestId('oee-own-cell-m1').textContent).toBe('2.5 min');
    expect(within(cell).getByTestId('oee-external-cell-m1').textContent).toBe('0.8 min');
    expect(within(cell).getByText('Provisional (2.0 min)')).toBeTruthy();
    expect(screen.queryByTestId('bottleneck-cell-m1')).toBeNull();

    const line = screen.getByTestId('oee-card-line-a1');
    expect(line.dataset.oee).toBe('n/a');
    expect(within(line).getByTestId('oee-value-line-a1').textContent).toBe('n/a');
    // The bottleneck is the MES's answer (`GET /oee/line`), not a constant of the web.
    const named = await within(line).findByTestId('bottleneck-line-a1');
    expect(named.textContent).toContain('asm-01');
    expect(named.textContent).toContain('VB-100, VB-200');
    expect(named.dataset.equipment).toBe('asm-01');

    expect(screen.getByTestId('oee-machine-cnc-01').dataset.oee).toBe('0.6300');
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
    expect(within(waterfall).queryByRole('alert')).toBeNull();

    const pareto = await screen.findByTestId('pareto-BREAKDOWN/SPINDLE-OVERLOAD');
    expect(pareto.textContent).toContain('1.7 min');
    expect(within(screen.getByTestId('pareto')).getByText(/CHIP-JAM/)).toBeTruthy();
    expect(await screen.findByTestId('hour-2026-10-15T04:00:00.000Z')).toBeTruthy();
    expect(screen.getByTestId('hour-2026-10-15T04:00:00.000Z').textContent).toContain('n/a');
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
    expect(screen.getByTestId('hour-2026-10-15T05:00:00.000Z').textContent).toContain('0.5000');
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
    expect(within(card).getByTestId('line-oee-value').textContent).toBe('0.7500');
    expect(within(card).getByTestId('line-oee-value').dataset.fraction).toBe('3/4');
    expect(within(card).getByTestId('line-oee-value-percent').textContent).toBe('75.00 %');
    expect(within(card).getByTestId('line-oee-good').textContent).toBe('VB-100 100');
    expect(within(card).getByTestId('line-oee-planned').textContent).toBe('333.3 min');
    expect(within(card).getByTestId('line-oee-ideal').textContent).toBe('250.0 min');
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
    expect(above.textContent).toContain('above 1');
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
    expect(within(card).getByTestId('line-hour-2026-10-15T05:00:00.000Z').dataset.oee).toBe(
      '1.1000',
    );
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
