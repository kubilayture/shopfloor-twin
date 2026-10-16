import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EQUIPMENT, PLANT, fakeFetch, json } from '../test/fixtures.ts';
import {
  CURRENT_SHIFT,
  PARETO,
  PREVIOUS_SHIFT,
  SHIFT,
  SHIFT_END,
  SHIFT_START,
  bucket,
  emptyResult,
  hourBucket,
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
    expect(within(line).getByTestId('bottleneck-line-a1').textContent).toContain('asm-01');

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
