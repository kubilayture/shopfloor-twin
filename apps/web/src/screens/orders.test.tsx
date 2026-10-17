import { PROBLEM_TYPES, type OrderDto } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveKeys, type LiveOrders } from '../live/live-cache.ts';
import { json, problem, sessionOf } from '../test/fixtures.ts';
import {
  command,
  confirmation,
  detail,
  execution,
  order,
  pushedCommand,
  result,
} from '../test/order-fixtures.ts';
import { orderMes, orderState, type Write } from '../test/order-mes.ts';
import { HOLD_ID, HOLD_ID_2, hold } from '../test/quality-fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const subscribed = (app: Awaited<ReturnType<typeof renderApp>>) =>
  app.factory.last.sent.filter((m) => m.type === 'subscribe').map((m) => m.topic);

const written = (base: OrderDto, overrides: Partial<OrderDto>) =>
  json({ order: { ...base, ...overrides }, command: null });

describe('orders list', () => {
  it('lists the orders, filters by status and follows pushes', async () => {
    const first = order('PO-1001', { status: 'released', version: 2 });
    const second = order('PO-1002', { plannedStart: '2026-10-15T05:00:00.000Z' });
    const state = orderState([first, second]);
    const server = orderMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/orders');
    await app.open();
    await screen.findByTestId('order-row-PO-1001');
    // By planned start.
    expect(
      within(screen.getByTestId('order-table'))
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.dataset.testid),
    ).toEqual(['order-row-PO-1002', 'order-row-PO-1001']);
    expect(subscribed(app)).toContain('orders');
    // A newer pushed copy wins; an older one never takes it back.
    await app.push({
      type: 'order',
      event: 'updated',
      order: { ...first, status: 'dispatched', version: 3, dispatched: 20, remaining: 0 },
    });
    expect(screen.getByTestId('order-row-PO-1001').dataset.status).toBe('dispatched');
    await app.push({ type: 'order', event: 'updated', order: first });
    expect(screen.getByTestId('order-row-PO-1001').dataset.version).toBe('3');
    // An order imported since the read appears.
    await app.push({ type: 'order', event: 'imported', order: order('PO-1003') });
    expect(screen.getByTestId('order-row-PO-1003')).toBeTruthy();
    // The filter goes to the MES and applies to pushed orders as well.
    fireEvent.change(screen.getByTestId('order-filter'), { target: { value: 'imported' } });
    await waitFor(() => {
      expect(screen.getByTestId('order-table').dataset.count).toBe('2');
    });
    expect(screen.queryByTestId('order-row-PO-1001')).toBeNull();
    expect(server.calls.some((call) => call.path === '/api/v1/orders?status=imported')).toBe(true);
    expect(screen.getByTestId('order-row-PO-1003')).toBeTruthy();
  });

  it('updates a row after a command push, and a read wins over a push of the same version', async () => {
    const first = order('PO-1001', { status: 'dispatched', version: 3 });
    const state = orderState([first]);
    const server = orderMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/orders');
    await app.open();
    await screen.findByTestId('order-row-PO-1001');
    // A push of the order as read: kept, as is its later REST read of the same version.
    await app.push({ type: 'order', event: 'updated', order: first });
    // The device accepted the job: the MES re-reads the order with its blanks dispatched.
    state.orders = [{ ...first, dispatched: 20, remaining: 0 }];
    await app.push({
      type: 'command',
      event: 'updated',
      command: pushedCommand(command('PO-1001', 1, { updatedAt: '2026-10-15T06:02:00.000Z' })),
    });
    await waitFor(() => {
      expect(screen.getByTestId('order-row-PO-1001').dataset.dispatched).toBe('20');
    });
  });

  it('forgets pushed copies when it lets go of the topic and after a lost connection', async () => {
    const first = order('PO-1001');
    const server = orderMes(orderState([first]));
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/orders');
    await app.open();
    await screen.findByTestId('order-row-PO-1001');
    await app.push({ type: 'order', event: 'updated', order: { ...first, version: 5 } });
    const pushed = () => app.queryClient.getQueryData<LiveOrders>(liveKeys.orders)?.orders ?? {};
    expect(Object.keys(pushed())).toEqual(['PO-1001']);
    // A dropped connection: pushes in between are missed, so the copies go and REST reads again.
    await app.drop();
    await settle(() => {
      app.factory.last.open();
    });
    await waitFor(() => {
      expect(app.factory.sockets.length).toBeGreaterThan(1);
    });
    await settle(() => {
      app.factory.last.open();
    });
    expect(pushed()).toEqual({});
    // Leaving the screen lets go of the topic and empties the pushed set.
    await app.push({ type: 'order', event: 'updated', order: { ...first, version: 6 } });
    expect(Object.keys(pushed())).toEqual(['PO-1001']);
    await settle(() => {
      app.history.push('/');
    });
    expect(pushed()).toEqual({});
  });
});

describe('order detail', () => {
  it('shows operations, WIP, commands with their results, incidents and confirmations', async () => {
    const base = order('PO-1001', { status: 'in-progress', version: 4, dispatched: 20 });
    const lost = command('PO-1001', 1, {
      state: 'epoch-ended',
      job: null,
      settled: true,
      confirmed: false,
      results: [
        {
          ...result(),
          result: 'unknown',
          seqAfterExpiry: 51,
          acceptedSeq: null,
          acceptedAt: null,
          position: null,
        },
      ],
    });
    const second = command('PO-1001', 2, { state: 'failed', settled: false, failed: true });
    const state = orderState([base], {
      details: {
        'PO-1001': detail(base, {
          commands: [lost, second],
          confirmations: [confirmation()],
          incidents: [
            {
              id: 3,
              type: 'command-failed',
              orderId: 'PO-1001',
              commandId: second.commandId,
              equipment: 'cnc-01',
              message: 'no final answer',
              detectedAt: '2026-10-15T06:05:00.000Z',
              closedAt: null,
              resolution: null,
            },
          ],
        }),
      },
      executions: { 'PO-1001': execution() },
      executionIncidents: [
        {
          id: 9,
          type: 'routing-violation',
          epoch: 1,
          partId: 4,
          orderId: 'PO-1001',
          equipment: 'asm-01',
          message: 'unit seen at OP30 without OP20',
          detectedAt: '2026-10-15T06:07:00.000Z',
          closedAt: null,
          resolution: null,
        },
        {
          id: 10,
          type: 'routing-violation',
          epoch: 1,
          partId: 5,
          orderId: 'PO-9999',
          equipment: 'asm-01',
          message: 'another order',
          detectedAt: '2026-10-15T06:07:00.000Z',
          closedAt: null,
          resolution: null,
        },
      ],
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    await renderApp('/orders/PO-1001');
    expect((await screen.findByTestId('good-OP10')).textContent).toBe('11');
    expect(screen.getByTestId('wip-count').textContent).toBe('7');
    expect(screen.getByTestId('order-wip').textContent).toContain('cnc-01: 1');
    const first = screen.getByTestId(`command-${lost.commandId}`);
    expect(within(first).getByTestId('command-state').dataset.state).toBe('epoch-ended');
    expect(within(first).getByTestId('command-result').dataset.result).toBe('unknown');
    expect(within(first).getByTestId('command-result').textContent).toContain(
      'seq after expiry 51',
    );
    expect(
      within(screen.getByTestId(`command-${second.commandId}`)).getByTestId('command-state')
        .textContent,
    ).toBe('Failed');
    expect(screen.getAllByTestId('order-incident').map((item) => item.dataset.type)).toEqual([
      'routing-violation',
      'command-failed',
    ]);
    expect(screen.getByTestId('confirmation-OP10-1').dataset.status).toBe('sent');
  });

  it('shows no action to a role without order permissions', async () => {
    const base = order('PO-1001');
    vi.stubGlobal('fetch', orderMes(orderState([base])).fetch);
    await renderApp('/orders/PO-1001', { session: sessionOf(['operator']) });
    expect(await screen.findByTestId('order-read-only')).toBeTruthy();
    expect(screen.queryByTestId('action-release')).toBeNull();
  });

  it('releases with the version read', async () => {
    const base = order('PO-1001', { version: 3 });
    const state = orderState([base]);
    const write: Write = (method, path, body) => {
      expect(path).toBe('/api/v1/orders/PO-1001/release');
      expect(body).toEqual({ version: 3 });
      state.orders = [{ ...base, status: 'released', version: 4 }];
      return written(base, { status: 'released', version: 4 });
    };
    const server = orderMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/orders/PO-1001');
    // Only what the status allows: release and cancel.
    await screen.findByTestId('action-release');
    expect(screen.getByTestId('action-cancel')).toBeTruthy();
    expect(screen.queryByTestId('action-dispatch')).toBeNull();
    fireEvent.click(screen.getByTestId('action-release'));
    fireEvent.click(screen.getByTestId('action-submit'));
    expect((await screen.findByTestId('action-done')).textContent).toContain('version 4');
    expect(screen.getByTestId('order-status').dataset.status).toBe('released');
    expect(server.posts()).toHaveLength(1);
  });

  it('dispatches to the CNC chosen among the OP10 work center', async () => {
    const base = order('PO-1001', { status: 'released', version: 2 });
    const state = orderState([base]);
    const write: Write = (_method, path, body) => {
      expect(path).toBe('/api/v1/orders/PO-1001/dispatch');
      expect(body).toEqual({ version: 2, equipment: 'cnc-02' });
      const made = pushedCommand(command('PO-1001', 1, { equipment: 'cnc-02', state: 'queued' }));
      return json({ order: { ...base, status: 'dispatched', version: 3 }, command: made });
    };
    vi.stubGlobal('fetch', orderMes(state, write).fetch);
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-dispatch'));
    const select = screen.getByTestId<HTMLSelectElement>('action-cnc');
    await waitFor(() => {
      expect([...select.options].map((option) => option.value)).toEqual(['', 'cnc-01', 'cnc-02']);
    });
    fireEvent.change(select, { target: { value: 'cnc-02' } });
    fireEvent.click(screen.getByTestId('action-submit'));
    expect((await screen.findByTestId('action-done')).textContent).toContain(
      'command PO-1001~OP10~1',
    );
    // The new command shows from the write's answer before the order is read again.
    expect(screen.getByTestId('command-PO-1001~OP10~1').dataset.state).toBe('queued');
  });

  it('never sends a draft over an order that moved on, and starts again keeping the input', async () => {
    const base = order('PO-1001', { status: 'released', version: 2 });
    const state = orderState([base]);
    const server = orderMes(state, () => written(base, { status: 'dispatched', version: 4 }));
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/orders/PO-1001');
    await app.open();
    fireEvent.click(await screen.findByTestId('action-dispatch'));
    const select = screen.getByTestId<HTMLSelectElement>('action-cnc');
    await waitFor(() => {
      expect(select.options.length).toBe(3);
    });
    fireEvent.change(select, { target: { value: 'cnc-01' } });
    await app.push({
      type: 'order',
      event: 'updated',
      order: { ...base, version: 3, priority: 1 },
    });
    const form = screen.getByTestId('action-form-dispatch');
    expect(form.dataset.version).toBe('2');
    expect(within(form).getByTestId('action-stale').dataset.version).toBe('3');
    expect(within(form).getByTestId<HTMLButtonElement>('action-submit').disabled).toBe(true);
    fireEvent.submit(form);
    expect(server.posts()).toHaveLength(0);
    fireEvent.click(within(form).getByTestId('action-restart'));
    expect(screen.getByTestId('action-form-dispatch').dataset.version).toBe('3');
    expect(screen.getByTestId<HTMLSelectElement>('action-cnc').value).toBe('cnc-01');
    fireEvent.click(screen.getByTestId('action-submit'));
    await screen.findByTestId('action-done');
    expect(server.posts()[0]?.body).toEqual({ version: 3, equipment: 'cnc-01' });
  });

  it('on 409 order-stale shows the problem type, reads the order again and keeps the draft stale', async () => {
    const base = order('PO-1001', { version: 2 });
    const state = orderState([base]);
    const write: Write = () => {
      state.orders = [{ ...base, version: 3, priority: 1 }];
      return problem(409, 'Conflict', 'version is 3, not 2', '/x', PROBLEM_TYPES.orderStale);
    };
    vi.stubGlobal('fetch', orderMes(state, write).fetch);
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-cancel'));
    fireEvent.change(screen.getByTestId('action-reason'), { target: { value: 'ERP asked' } });
    fireEvent.click(screen.getByTestId('action-submit'));
    const message = await screen.findByTestId('action-message');
    expect(message.dataset.kind).toBe('stale');
    expect(screen.getByTestId('action-problem-type').textContent).toContain(
      'urn:shopfloor:order-stale',
    );
    await screen.findByTestId('action-stale');
    expect(screen.getByTestId<HTMLTextAreaElement>('action-reason').value).toBe('ERP asked');
  });

  it('re-dispatches the remainder with a checked quantity and explains commands-unsettled', async () => {
    const base = order('PO-1001', {
      status: 'in-progress',
      version: 5,
      dispatched: 12,
      remaining: 8,
      flags: { short: false, dispatchFailed: true, dispatchLost: false },
    });
    const unsettled = command('PO-1001', 1, { state: 'unknown', settled: false, job: null });
    const state = orderState([base], {
      details: { 'PO-1001': detail(base, { commands: [unsettled] }) },
    });
    const write: Write = (_method, path, body) => {
      expect(path).toBe('/api/v1/orders/PO-1001/redispatch');
      expect(body).toEqual({ version: 5, quantity: 6 });
      return problem(
        409,
        'Conflict',
        'PO-1001~OP10~1 is not settled',
        '/x',
        PROBLEM_TYPES.commandsUnsettled,
      );
    };
    const server = orderMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/orders/PO-1001');
    expect((await screen.findByTestId('order-flags')).textContent).toContain('Dispatch failed');
    fireEvent.click(screen.getByTestId('action-redispatch'));
    expect(screen.getByTestId('action-unsettled').textContent).toContain('PO-1001~OP10~1');
    fireEvent.change(screen.getByTestId('action-quantity'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('action-submit'));
    expect(screen.getByTestId('action-invalid').textContent).toContain('8 blanks remaining');
    expect(server.posts()).toHaveLength(0);
    fireEvent.change(screen.getByTestId('action-quantity'), { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('action-submit'));
    const message = await screen.findByTestId('action-message');
    expect(message.dataset.kind).toBe('unsettled');
    expect(message.dataset.type).toBe(PROBLEM_TYPES.commandsUnsettled);
  });

  it('offers abandon only for a command whose run ended, and sends its id', async () => {
    const base = order('PO-1001', { status: 'in-progress', version: 7, remaining: 0 });
    const lostJob = command('PO-1001', 1, { job: 'lost' });
    const running = command('PO-1001', 2, { job: 'started' });
    const rejected = command('PO-1001', 3, { state: 'rejected', job: null, confirmed: false });
    const state = orderState([base], {
      details: { 'PO-1001': detail(base, { commands: [lostJob, running, rejected] }) },
    });
    const write: Write = (_method, path, body) => {
      expect(path).toBe('/api/v1/orders/PO-1001/abandon-command');
      expect(body).toEqual({ version: 7, commandId: lostJob.commandId });
      return written(base, { version: 8, flags: { ...base.flags, dispatchLost: true } });
    };
    vi.stubGlobal('fetch', orderMes(state, write).fetch);
    await renderApp('/orders/PO-1001');
    await screen.findByTestId(`command-${lostJob.commandId}`);
    expect(screen.queryByTestId(`abandon-${running.commandId}`)).toBeNull();
    expect(screen.queryByTestId(`abandon-${rejected.commandId}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`abandon-${lostJob.commandId}`));
    const form = screen.getByTestId('action-form-abandon');
    expect(form.textContent).toContain(lostJob.commandId);
    fireEvent.click(within(form).getByTestId('action-submit'));
    expect((await screen.findByTestId('action-done')).textContent).toContain('version 8');
  });

  it('offers close on a completed order and no longer abandon', async () => {
    const base = order('PO-1001', { status: 'completed', version: 9 });
    const state = orderState([base], {
      details: { 'PO-1001': detail(base, { commands: [command('PO-1001', 1, { job: 'lost' })] }) },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    await renderApp('/orders/PO-1001');
    // Completed: abandon no longer applies, close does.
    await screen.findByTestId('action-close');
    expect(screen.queryByTestId('abandon-PO-1001~OP10~1')).toBeNull();
  });

  it('on a close before every operation is signed off says so with the problem type and the operations (#177)', async () => {
    const base = order('PO-1001', { status: 'completed', version: 9 });
    const state = orderState([base]);
    const write: Write = (_method, path) =>
      path.endsWith('/close')
        ? problem(
            409,
            'Conflict',
            'order PO-1001: not signed off at the terminal yet: OP10 (cell-m1), OP50 (line-a1)',
            '/x',
            PROBLEM_TYPES.signOffMissing,
          )
        : json({});
    vi.stubGlobal('fetch', orderMes(state, write).fetch);
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-close'));
    fireEvent.click(screen.getByTestId('action-submit'));
    const message = await screen.findByTestId('action-message');
    expect(message.dataset.kind).toBe('sign-off');
    expect(message.textContent).toContain('OP10 (cell-m1), OP50 (line-a1)');
    expect(screen.getByTestId('action-problem-type').textContent).toContain(
      'urn:shopfloor:sign-off-missing',
    );
  });

  it('on a close refused for a quality hold links the holds; genealogy-pending says to retry (#203)', async () => {
    const base = order('PO-1001', { status: 'completed', version: 9 });
    const onOrder = hold({ subject: { kind: 'order', id: 'PO-1001' } });
    const state = orderState([base], { holds: [onOrder] });
    let answer = 'hold';
    const write: Write = (_method, path) => {
      if (answer === 'hold') {
        answer = 'pending';
        return problem(
          409,
          'Conflict',
          `order PO-1001 has units in open quality holds: ${HOLD_ID}, ${HOLD_ID_2}`,
          path,
          PROBLEM_TYPES.qualityHold,
        );
      }
      return new Response(
        JSON.stringify({
          type: PROBLEM_TYPES.genealogyPending,
          title: 'Conflict',
          status: 409,
          detail: 'order PO-1001: genealogy has not processed every fact of its units yet',
          instance: path,
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '2' },
        },
      );
    };
    vi.stubGlobal('fetch', orderMes(state, write).fetch);
    const app = await renderApp('/orders/PO-1001');
    await app.open();
    // The holds on the order itself, and a way to open one.
    expect(await screen.findByTestId(`hold-row-${HOLD_ID}`)).toBeTruthy();
    expect(screen.getByTestId('order-hold-open').getAttribute('href')).toBe(
      '/quality/holds/new?kind=order&id=PO-1001',
    );
    expect(app.factory.last.sent).toContainEqual({ type: 'subscribe', topic: 'quality' });
    fireEvent.click(screen.getByTestId('action-close'));
    fireEvent.click(screen.getByTestId('action-submit'));
    const message = await screen.findByTestId('action-message');
    expect(message.dataset.kind).toBe('quality-hold');
    expect(screen.getByTestId(`action-hold-${HOLD_ID}`).getAttribute('href')).toBe(
      `/quality/holds/${HOLD_ID}`,
    );
    expect(screen.getByTestId(`action-hold-${HOLD_ID_2}`)).toBeTruthy();
    // Sent again: genealogy is behind, retryable.
    fireEvent.click(screen.getByTestId('action-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('action-message').dataset.kind).toBe('genealogy-pending');
    });
    expect(screen.getByTestId('action-message').textContent).toContain('Try again in 2 s');
  });

  it('starts another order with no open action (panels keyed by id)', async () => {
    const one = order('PO-1001');
    const two = order('PO-1002');
    vi.stubGlobal('fetch', orderMes(orderState([one, two])).fetch);
    const app = await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-cancel'));
    fireEvent.change(screen.getByTestId('action-reason'), { target: { value: 'draft' } });
    await settle(() => {
      app.history.push('/orders/PO-1002');
    });
    await waitFor(() => {
      expect(screen.getByTestId('order-detail').dataset.order).toBe('PO-1002');
    });
    await screen.findByTestId('action-cancel');
    expect(screen.queryByTestId('action-form-cancel')).toBeNull();
  });

  it('reads the order again when a pushed command of it arrives', async () => {
    const base = order('PO-1001', { status: 'dispatched', version: 3 });
    const sent = command('PO-1001', 1, { state: 'sent', settled: false, job: null });
    const state = orderState([base], {
      details: { 'PO-1001': detail(base, { commands: [sent] }) },
    });
    const server = orderMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/orders/PO-1001');
    await app.open();
    await screen.findByTestId(`command-${sent.commandId}`);
    const reads = () =>
      server.calls.filter((call) => call.path === '/api/v1/orders/PO-1001').length;
    const before = reads();
    await app.push({
      type: 'command',
      event: 'updated',
      command: pushedCommand({ ...sent, state: 'accepted', updatedAt: '2026-10-15T06:02:00.000Z' }),
    });
    expect(screen.getByTestId(`command-${sent.commandId}`).dataset.state).toBe('accepted');
    await waitFor(() => {
      expect(reads()).toBeGreaterThan(before);
    });
  });

  it('sends one write for a double submit', async () => {
    const base = order('PO-1001', { version: 3 });
    const server = orderMes(orderState([base]), () =>
      written(base, { status: 'released', version: 4 }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-release'));
    const form = screen.getByTestId('action-form-release');
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByTestId('action-done');
    expect(server.posts()).toHaveLength(1);
  });

  it('shows an admin the order read-only (no order permission)', async () => {
    const base = order('PO-1001', { status: 'completed' });
    vi.stubGlobal('fetch', orderMes(orderState([base])).fetch);
    await renderApp('/orders/PO-1001', { session: sessionOf(['admin']) });
    expect(await screen.findByTestId('order-read-only')).toBeTruthy();
    expect(screen.queryByTestId('action-close')).toBeNull();
  });

  it('hides the abandon buttons while another action form is open', async () => {
    const base = order('PO-1001', { status: 'in-progress', version: 7, remaining: 5 });
    const lostJob = command('PO-1001', 1, { job: 'lost' });
    const state = orderState([base], {
      details: { 'PO-1001': detail(base, { commands: [lostJob] }) },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    await renderApp('/orders/PO-1001');
    const abandon = `abandon-${lostJob.commandId}`;
    await screen.findByTestId(abandon);
    fireEvent.click(screen.getByTestId('action-redispatch'));
    expect(screen.getByTestId('action-form-redispatch')).toBeTruthy();
    expect(screen.queryByTestId(abandon)).toBeNull();
    fireEvent.click(screen.getByTestId('action-back'));
    // Back: the abandon starts its own form, fresh.
    fireEvent.click(screen.getByTestId(abandon));
    const form = screen.getByTestId('action-form-abandon');
    expect(form.dataset.version).toBe('7');
    expect(screen.queryByTestId('action-form-redispatch')).toBeNull();
  });

  it('says when the MES has no such order', async () => {
    vi.stubGlobal('fetch', orderMes(orderState([])).fetch);
    await renderApp('/orders/PO-404');
    expect((await screen.findByTestId('order-missing')).textContent).toContain('PO-404');
  });
});
