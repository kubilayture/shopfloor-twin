import type { OrderOeeDto } from '@shopfloor/contracts/mes-api';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NA_REASON } from '../components/oee-ui.tsx';
import { liveKeys } from '../live/live-cache.ts';
import { ORDER_LINE, orderJob, orderOee, result } from '../test/oee-fixtures.ts';
import { order } from '../test/order-fixtures.ts';
import { orderMes, orderState } from '../test/order-mes.ts';
import { renderApp, settle } from '../test/render-app.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const subscribed = (app: Awaited<ReturnType<typeof renderApp>>) =>
  app.factory.last.sent.filter((m) => m.type === 'subscribe').map((m) => m.topic);

/** A provisional order OEE: the job window still open, the order not complete. */
const running = (id: string): OrderOeeDto =>
  orderOee(id, {
    status: 'in-progress',
    final: false,
    open: true,
    oee: result({ oee: { fraction: '1/2', decimal: '0.5000' } }),
    jobs: [
      orderJob(`${id}-1`, {
        final: false,
        window: {
          from: '2026-10-15T03:00:00.000Z',
          to: '2026-10-15T04:00:00.000Z',
          open: true,
          headTimeUnknown: false,
          endLost: false,
          lost: false,
        },
      }),
    ],
    firstPassYield: {
      firstPassGood: 3,
      started: 5,
      yield: { fraction: '3/5', decimal: '0.6000' },
      final: false,
    },
    completedAt: null,
    line: {
      ...ORDER_LINE,
      open: true,
      final: false,
    },
  });

describe('order OEE on the order detail (#233)', () => {
  it('shows A, P, Q and OEE, the jobs, the first-pass yield and the order’s line OEE', async () => {
    const state = orderState([order('PO-1001', { status: 'completed' })], {
      orderOee: { 'PO-1001': orderOee('PO-1001') },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    await renderApp('/orders/PO-1001');
    const section = await screen.findByTestId('order-oee');
    expect(section.dataset.final).toBe('true');
    expect(section.dataset.oee).toBe('0.6300');
    const value = (id: string) => within(section).getByTestId(id);
    // E-02: percentages people read; the MES's four decimals in data-decimal, the exact fraction
    // in data-fraction and the tooltip.
    expect(value('order-oee-oee').textContent).toBe('63.00 %');
    expect(value('order-oee-oee').dataset.decimal).toBe('0.6300');
    expect(value('order-oee-oee').dataset.fraction).toBe('63/100');
    expect(value('order-oee-oee').title).toBe('63/100 exactly');
    expect(value('order-oee-availability').textContent).toBe('80.00 %');
    expect(value('order-oee-availability').dataset.decimal).toBe('0.8000');
    expect(value('order-oee-performance').dataset.decimal).toBe('0.8750');
    expect(value('order-oee-quality').dataset.decimal).toBe('0.9000');
    expect(value('order-oee-quality').dataset.fraction).toBe('9/10');
    // Order OEE, FPY and line OEE are KPI tiles: named groups with a headline figure.
    const tile = (name: string) => within(section).getByRole('group', { name });
    expect(within(tile('Order OEE')).getByText('OEE')).toBeTruthy();
    expect(within(tile('Order OEE')).getByText('Planned busy time')).toBeTruthy();
    // First-pass yield, beside the OEE; the counts stay bare numbers (the specs read their text).
    const fpy = value('order-fpy');
    expect(fpy).toBe(tile('First-pass yield'));
    expect(fpy.dataset.final).toBe('true');
    expect(fpy.dataset.yield).toBe('0.9000');
    expect(value('order-fpy-yield').textContent).toBe('90.00 %');
    expect(value('order-fpy-yield').dataset.decimal).toBe('0.9000');
    expect(value('order-fpy-good').textContent).toBe('9');
    expect(value('order-fpy-started').textContent).toBe('10');
    // The order's line OEE, not additive; a completed order's window is labelled as one (Q-04),
    // and the packed units read product, then count.
    const line = value('order-line-oee');
    expect(line).toBe(tile('Line OEE of this order'));
    expect(line.dataset.final).toBe('true');
    expect(line.dataset.oee).toBe('0.1875');
    expect(line.dataset.aboveOne).toBe('false');
    expect(value('order-line-oee-value').textContent).toBe('18.75 %');
    expect(value('order-line-oee-value').dataset.decimal).toBe('0.1875');
    expect(value('order-line-oee-value').dataset.fraction).toBe('3/16');
    expect(within(line).queryByText('In progress')).toBeNull();
    expect(within(line).getByText('Window')).toBeTruthy();
    expect(value('order-line-window').textContent).not.toContain('open');
    expect(value('order-line-good').textContent).toBe('VB-100: 9');
    expect(value('order-line-not-additive').textContent).toContain('Not additive across orders');
    // The job breakdown, on DataTable: real rows, the job id as the row header.
    const jobs = value('order-oee-jobs');
    expect(jobs.tagName).toBe('TABLE');
    expect(within(jobs).getByRole('rowheader').textContent).toBe('PO-1001-1');
    const headers = within(jobs)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      'Job',
      'CNC',
      'Head time',
      'Window',
      'Cycles',
      'OEE',
      'Availability',
      'Performance',
      'Quality',
      'Status',
    ]);
    const job = value('order-oee-job-PO-1001-1');
    expect(job.tagName).toBe('TR');
    expect(job.dataset.final).toBe('true');
    expect(job.dataset.oee).toBe('0.6300');
    expect(job.textContent).toContain('its accepted fact');
    expect(job.textContent).toContain('63.00 %');
    expect(within(section).queryByTestId('order-oee-pending')).toBeNull();
    // The table's frame is a named tab stop only when it scrolls (DataTable): no stopgap region.
    expect(within(section).queryByRole('region', { name: 'OEE per job of the order' })).toBeNull();
    // Every ratio element (OEE, A, P, Q, the jobs, FPY, the order's line OEE) carries the MES's
    // four decimals in data-decimal and shows them as a percentage.
    const ratios = [...section.querySelectorAll<HTMLElement>('[data-fraction]')];
    expect(ratios.length).toBeGreaterThanOrEqual(10);
    for (const ratio of ratios) {
      expect(ratio.dataset.decimal, ratio.dataset.testid).toMatch(/^\d+\.\d{4}$/);
      expect(ratio.textContent, ratio.dataset.testid).toMatch(/^\d+\.\d{2} %$/);
    }
  });

  it('shows a ratio that does not apply as a dash with its reason, and no job as an empty table', async () => {
    const state = orderState([order('PO-1006', { status: 'released' })], {
      orderOee: {
        'PO-1006': orderOee('PO-1006', {
          status: 'released',
          final: false,
          pending: true,
          oee: result({ oee: null, availability: null }),
          jobs: [],
          line: null,
          firstPassYield: { firstPassGood: 0, started: 0, yield: null, final: false },
          completedAt: null,
        }),
      },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    await renderApp('/orders/PO-1006');
    const section = await screen.findByTestId('order-oee');
    const value = (id: string) => within(section).getByTestId(id);
    expect(value('order-oee-oee').dataset.decimal).toBe('n/a');
    expect(value('order-oee-oee').dataset.fraction).toBe('n/a');
    expect(value('order-oee-oee').textContent).toBe(`—${NA_REASON.oee}`);
    expect(within(value('order-oee-card')).getAllByText(NA_REASON.oee).length).toBe(2);
    expect(value('order-fpy-yield').dataset.decimal).toBe('n/a');
    expect(value('order-fpy-good').textContent).toBe('0');
    // No line OEE yet: the tile says why instead of a figure.
    const line = value('order-line-oee');
    expect(line.dataset.oee).toBe('n/a');
    expect(line.textContent).toContain('No job of this order is head of its CNC’s queue yet.');
    expect(within(section).queryByTestId('order-line-oee-value')).toBeNull();
    expect(value('order-oee-jobs-empty').textContent).toContain('No job accepted yet');
    expect(within(section).queryByRole('table')).toBeNull();
  });

  it('marks a provisional order with its reasons and follows oee:order:<id>', async () => {
    const state = orderState([order('PO-1002', { status: 'in-progress' })], {
      orderOee: { 'PO-1002': running('PO-1002') },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    const app = await renderApp('/orders/PO-1002');
    await app.open();
    const section = await screen.findByTestId('order-oee');
    expect(section.dataset.final).toBe('false');
    expect(within(section).getByTestId('order-oee-pending').textContent).toContain(
      'a job window is still open',
    );
    expect(within(section).getByTestId('order-fpy').dataset.final).toBe('false');
    expect(within(section).getByText('Provisional (order in progress)')).toBeTruthy();
    // An order still in progress: its line OEE runs to the plant clock, and says so.
    const open = within(section).getByTestId('order-line-oee');
    expect(within(open).getByText('In progress')).toBeTruthy();
    expect(within(open).getByTestId('order-line-window').textContent).toContain(
      '(open: to the plant clock)',
    );
    expect(subscribed(app)).toContain('oee:order:PO-1002');

    // The push of the order completing: final, over written-off gaps, revised once.
    await app.push({
      type: 'oee-order',
      topic: 'oee:order:PO-1002',
      order: orderOee('PO-1002', {
        revision: 1,
        mayRevise: true,
        incidents: [{ machine: 'cnc-01', epoch: 1, id: 4, seqFrom: 20, seqTo: 21 }],
        line: {
          ...ORDER_LINE,
          aboveOne: true,
          oee: { fraction: '11/10', decimal: '1.1000' },
        },
      }),
    });
    expect(section.dataset.final).toBe('true');
    expect(section.dataset.revision).toBe('1');
    expect(section.dataset.incidents).toBe('1');
    for (const flag of ['final', 'revision', 'incidents', 'may-revise']) {
      expect(section.querySelector(`[data-flag="${flag}"]`)).toBeTruthy();
    }
    expect(within(section).getByTestId('order-oee-incidents').textContent).toContain('cnc-01');
    const line = within(section).getByTestId('order-line-oee');
    expect(line.dataset.oee).toBe('1.1000');
    expect(line.querySelector('[data-flag="above-one"]')).toBeTruthy();
    expect(line.textContent).toContain('not capped');
  });

  it('keeps a final REST answer over a provisional push', async () => {
    const state = orderState([order('PO-1005', { status: 'completed' })], {
      orderOee: { 'PO-1005': orderOee('PO-1005') },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    const app = await renderApp('/orders/PO-1005');
    await app.open();
    const section = await screen.findByTestId('order-oee');
    expect(section.dataset.final).toBe('true');
    await app.push({ type: 'oee-order', topic: 'oee:order:PO-1005', order: running('PO-1005') });
    expect(section.dataset.final).toBe('true');
    expect(section.dataset.oee).toBe('0.6300');
  });

  it('subscribes only on the detail and drops the pushed copy when it lets go', async () => {
    const state = orderState([order('PO-1003')], { orderOee: { 'PO-1003': orderOee('PO-1003') } });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    const app = await renderApp('/orders');
    await app.open();
    await screen.findByTestId('order-row-PO-1003');
    expect(subscribed(app).some((topic) => topic.startsWith('oee:order:'))).toBe(false);
    await settle(() => {
      app.history.push('/orders/PO-1003');
    });
    await screen.findByTestId('order-oee');
    await app.push({ type: 'snapshot', topic: 'oee:order:PO-1003', order: orderOee('PO-1003') });
    expect(app.queryClient.getQueryData(liveKeys.orderOee('PO-1003'))).toBeTruthy();
    await settle(() => {
      app.history.push('/orders');
    });
    await waitFor(() => {
      expect(
        app.factory.last.sent.some(
          (m) => m.type === 'unsubscribe' && m.topic === 'oee:order:PO-1003',
        ),
      ).toBe(true);
    });
    expect(app.queryClient.getQueryData(liveKeys.orderOee('PO-1003'))).toBeUndefined();
  });

  it('says when the MES has no OEE for the order', async () => {
    vi.stubGlobal('fetch', orderMes(orderState([order('PO-1004')])).fetch);
    await renderApp('/orders/PO-1004');
    expect((await screen.findByTestId('order-oee-missing')).textContent).toContain('no OEE');
  });
});
