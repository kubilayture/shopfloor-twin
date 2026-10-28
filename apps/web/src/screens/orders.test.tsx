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
          history: [
            {
              id: 1,
              // Wall time a week after the plant's clock: the demo's case (#295 review).
              at: '2026-10-22T07:12:03.000Z',
              plantAt: '2026-10-15T06:30:00.000Z',
              actor: 'sam',
              roles: ['supervisor'],
              authenticated: true,
              action: 'release',
              before: null,
              after: null,
              requestId: null,
            },
          ],
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
    // Wall-clock times in the plant's zone, labelled as wall time, never raw ISO (#295).
    expect(within(first).getByTestId('command-attempt').textContent).toBe(
      'Delivery 1: written Thu 15 Oct, 09:00:00 (wall time), published Thu 15 Oct, 09:00:00 (wall time), expires Thu 15 Oct, 09:01:00 (wall time)',
    );
    expect(within(first).getByTestId('command-result').textContent).toContain(
      'for the delivery expiring Thu 15 Oct, 09:01:00 (wall time); seq after expiry 51',
    );
    expect(
      screen
        .getAllByTestId('order-incident')
        .map((item) => item.querySelectorAll('p')[1]?.textContent),
    ).toEqual([
      'Detected Thu 15 Oct, 09:07:00 (wall time)',
      'Detected Thu 15 Oct, 09:05:00 (wall time)',
    ]);
    expect(screen.getByTestId('order-history-entry').textContent).toBe(
      'release by sam at Thu 22 Oct, 10:12:03 (wall time) (plant Thu 15 Oct, 09:30:00)',
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
    // The focus goes to the send button once it is enabled again, not to the page (#333 review).
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('action-submit'));
    });
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
        // The ids come from `holds` (the detail names only one, as an older MES's would differ).
        return new Response(
          JSON.stringify({
            type: PROBLEM_TYPES.qualityHold,
            title: 'Conflict',
            status: 409,
            detail: `order PO-1001 has units in open quality holds: ${HOLD_ID}`,
            instance: path,
            holds: [HOLD_ID, HOLD_ID_2],
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
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

describe('orders on the design system (UX-6a, #328)', () => {
  // The fixtures' plant clock is 2026-10-15T06:10Z.
  const late = { dueDate: '2026-10-15T06:00:00.000Z' };

  it('lists priority as a badge and marks an unfinished order past its due date (P-02)', async () => {
    const overdue = order('PO-1001', { ...late, priority: 1 });
    const done = order('PO-1002', { ...late, status: 'completed', priority: 4 });
    const onTime = order('PO-1003', { priority: 2 });
    vi.stubGlobal('fetch', orderMes(orderState([overdue, done, onTime])).fetch);
    await renderApp('/orders');
    const row = await screen.findByTestId('order-row-PO-1001');
    await waitFor(() => {
      expect(within(row).queryByTestId('order-overdue')?.textContent).toBe('Overdue');
    });
    expect(row.dataset.overdue).toBe('true');
    expect(row.querySelector('[data-priority]')?.textContent).toBe('1');
    // Completed late is done, not overdue; due later is not overdue either.
    for (const id of ['PO-1002', 'PO-1003']) {
      const other = screen.getByTestId(`order-row-${id}`);
      expect(within(other).queryByTestId('order-overdue')).toBeNull();
      expect(other.dataset.overdue).toBe('false');
    }
    // The order id is the row's header, its link the way in.
    expect(within(row).getByRole('rowheader').textContent).toBe('PO-1001');
    expect(screen.getByTestId('order-link-PO-1001').getAttribute('href')).toBe('/orders/PO-1001');
    // The filter has its label inline and the count beside it.
    expect(screen.getByRole('combobox', { name: 'Show' })).toBe(screen.getByTestId('order-filter'));
    expect(screen.getByText('3 orders')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Production orders' })).toBeTruthy();
  });

  it('shows an empty state that says why, per filter', async () => {
    vi.stubGlobal('fetch', orderMes(orderState([])).fetch);
    await renderApp('/orders');
    expect((await screen.findByTestId('orders-empty')).textContent).toContain('No order yet');
    fireEvent.change(screen.getByTestId('order-filter'), { target: { value: 'closed' } });
    await waitFor(() => {
      expect(screen.getByTestId('orders-empty').textContent).toContain(
        'No order matches this filter',
      );
    });
  });

  it('heads the detail with the status, the actions beside it and an index of its sections (Q-01)', async () => {
    const base = order('PO-1001', { ...late, priority: 3 });
    vi.stubGlobal('fetch', orderMes(orderState([base])).fetch);
    await renderApp('/orders/PO-1001');
    const title = await screen.findByRole('heading', { level: 1, name: 'Order PO-1001' });
    expect(title.id).toBe('order-title');
    expect(document.title).toBe('Order PO-1001 · ShopFloor Twin');
    // Status, overdue and actions in the header: the primary action last, cancel as danger.
    const header = screen.getByTestId('order-header');
    expect(header.contains(title)).toBe(true);
    expect(within(header).getByTestId('order-status').dataset.status).toBe('imported');
    await waitFor(() => {
      expect(within(header).queryByTestId('order-overdue')).not.toBeNull();
    });
    const buttons = within(header)
      .getAllByRole('button')
      .map((button) => button.dataset.testid);
    expect(buttons).toEqual(['action-cancel', 'action-release']);
    expect(within(header).getByTestId('order-hold-open').textContent).toBe('Hold this order');
    expect(screen.getByTestId('action-release').className).toContain('bg-accent');
    expect(screen.getByTestId('action-cancel').className).toContain('text-alarm-ink');
    // No "Actions" section any more.
    expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
    // The index links to every section heading on the page.
    const index = screen.getByRole('navigation', { name: 'On this page' });
    const targets = within(index)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href')?.slice(1) ?? '');
    expect(targets).toHaveLength(9);
    for (const target of targets) {
      expect(document.getElementById(target)?.tagName, target).toMatch(/^H2$/);
    }
    // The facts leave out the steps not taken yet (Q-02).
    const facts = screen.getByTestId('order-summary').querySelector('dl');
    const terms = [...(facts?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent);
    expect(terms).toEqual([
      'Blanks dispatched',
      'Blanks remaining',
      'Priority',
      'Planned start',
      'Version',
    ]);
    // The holds section explains itself without HTTP codes (Q-06).
    expect(screen.getByTestId('order-holds').textContent).not.toMatch(/409/);
  });

  it('returns the focus to the action that opened a form', async () => {
    const base = order('PO-1001');
    vi.stubGlobal('fetch', orderMes(orderState([base])).fetch);
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-cancel'));
    expect(screen.queryByTestId('action-release')).toBeNull();
    fireEvent.click(screen.getByTestId('action-back'));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('action-cancel'));
    });
  });

  it('tells a read-only role in one line, under the header (Q-08)', async () => {
    vi.stubGlobal('fetch', orderMes(orderState([order('PO-1001')])).fetch);
    await renderApp('/orders/PO-1001', { session: sessionOf(['operator']) });
    const note = await screen.findByTestId('order-read-only');
    expect(note.textContent).toBe('Your role cannot change orders: they are shown read-only.');
    expect(screen.queryAllByRole('button', { name: /Release|Cancel order|Dispatch/ })).toEqual([]);
  });

  it('lists ERP messages as a table with a payload per row, and request ids in a disclosure (Q-05, Q-07)', async () => {
    const base = order('PO-1001');
    const state = orderState([base], {
      details: {
        'PO-1001': detail(base, {
          erpMessages: [
            {
              id: 1,
              direction: 'in',
              kind: 'feed-entry',
              revision: 2,
              idempotencyKey: null,
              status: 'revision-refused',
              detail: 'older than the held revision',
              attempts: 1,
              lastError: null,
              createdAt: '2026-10-22T07:00:00.000Z',
              updatedAt: '2026-10-22T07:00:00.000Z',
              payload: { orderNumber: 'PO-1001' },
            },
          ],
          history: [
            {
              id: 1,
              at: '2026-10-22T07:12:03.000Z',
              plantAt: null,
              actor: 'sam',
              roles: ['supervisor'],
              authenticated: true,
              action: 'release',
              before: null,
              after: null,
              requestId: 'req-42',
            },
          ],
        }),
      },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    await renderApp('/orders/PO-1001');
    const table = await screen.findByRole('table', { name: 'ERP messages' });
    const row = within(table).getByTestId('erp-message');
    expect(row.tagName).toBe('TR');
    expect(row.textContent).toContain('From the ERP');
    expect(row.textContent).toContain('Revision refused');
    expect(row.textContent).toContain('(wall time)');
    const payload = within(row).getByText('Payload').closest('details');
    expect(payload?.open).toBe(false);
    expect(payload?.textContent).toContain('"orderNumber": "PO-1001"');
    // G-33 (UX-F1): a payload disclosure per row, so a skip link before the table to the history.
    const skip = screen.getByRole('link', { name: 'Skip past the ERP messages' });
    expect(skip.getAttribute('href')).toBe('#order-history-title');
    expect(skip.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const history = screen.getByRole('heading', { name: 'History' });
    expect(history.id).toBe('order-history-title');
    fireEvent.click(skip);
    expect(document.activeElement).toBe(history);
    const entry = screen.getByTestId('order-history-entry');
    const request = within(entry).getByText('Request id').closest('details');
    expect(request?.open).toBe(false);
    expect(request?.textContent).toContain('req-42');
  });

  it('shows an unknown order as not found, with the way back (G-21)', async () => {
    vi.stubGlobal('fetch', orderMes(orderState([])).fetch);
    await renderApp('/orders/PO-404');
    expect(await screen.findByRole('heading', { level: 1, name: 'Order PO-404' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'No order PO-404' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All orders' }).getAttribute('href')).toBe('/orders');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an id the MES cannot hold as not found too', async () => {
    vi.stubGlobal('fetch', orderMes(orderState([])).fetch);
    await renderApp('/orders/-bad');
    expect((await screen.findByTestId('order-missing')).textContent).toContain('-bad');
  });

  it('opens an action form under the header as an h2, so the outline never skips a level', async () => {
    vi.stubGlobal('fetch', orderMes(orderState([order('PO-1001')])).fetch);
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-release'));
    expect(screen.getByRole('heading', { level: 2, name: 'Release' })).toBeTruthy();
    const levels = within(screen.getByRole('main'))
      .getAllByRole('heading')
      .map((heading) => Number(heading.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    // Each heading at most one level below the one before it.
    expect(levels.slice(1).every((level, i) => level - (levels[i] ?? 0) <= 1)).toBe(true);
  });

  it('makes only the forward step primary: a re-dispatch is secondary (design system 4.1)', async () => {
    const running = order('PO-1001', { status: 'in-progress', remaining: 5 });
    vi.stubGlobal('fetch', orderMes(orderState([running])).fetch);
    await renderApp('/orders/PO-1001');
    const redispatch = await screen.findByTestId('action-redispatch');
    expect(redispatch.className).not.toContain('bg-accent');
    expect(redispatch.className).toContain('border-line-strong');
  });

  it('makes close the primary action of a completed order, and says nothing when none applies', async () => {
    const completed = order('PO-1001', { status: 'completed' });
    const closed = order('PO-1002', { status: 'closed' });
    vi.stubGlobal('fetch', orderMes(orderState([completed, closed])).fetch);
    const app = await renderApp('/orders/PO-1001');
    expect((await screen.findByTestId('action-close')).className).toContain('bg-accent');
    await settle(() => {
      app.history.push('/orders/PO-1002');
    });
    await waitFor(() => {
      expect(screen.getByTestId('order-detail').dataset.order).toBe('PO-1002');
    });
    await screen.findByTestId('order-header');
    expect(screen.queryByText(/No action applies/)).toBeNull();
    expect(within(screen.getByTestId('order-header')).queryAllByRole('button')).toEqual([]);
  });

  it('shows one dash for "nothing" in the operations table', async () => {
    const base = order('PO-1001', { status: 'in-progress' });
    const state = orderState([base], {
      executions: {
        'PO-1001': execution('PO-1001', {
          operations: [
            {
              operation: 'OP10',
              workCenter: 'cell-m1',
              in: 0,
              good: 0,
              scrap: {},
              rework: 0,
              material: {},
              completedAt: null,
            },
          ],
        }),
      },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    await renderApp('/orders/PO-1001');
    const row = await screen.findByTestId('operation-OP10');
    expect(row.textContent).not.toContain('–');
    expect(row.querySelectorAll('[data-missing]')).toHaveLength(3);
  });

  it('says when the routing incidents could not be read, never "No incident"', async () => {
    const server = orderMes(orderState([order('PO-1001')]));
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      input.includes('/api/v1/execution-incidents')
        ? Promise.resolve(problem(500, 'Internal Server Error', 'down', '/x'))
        : server.fetch(input, init),
    );
    await renderApp('/orders/PO-1001');
    const section = await screen.findByTestId('order-incidents');
    await waitFor(() => {
      expect(within(section).getByRole('alert').textContent).toContain('routing incidents');
    });
    expect(within(section).queryByTestId('incidents-empty')).toBeNull();
  });

  it('names several failed sections in one error under the header, each quietly (#394)', async () => {
    const server = orderMes(orderState([order('PO-1001')]));
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      input.includes('/api/v1/scrap-records') || input.includes('/api/v1/quality/holds')
        ? Promise.resolve(problem(500, 'Internal Server Error', 'down', '/x'))
        : server.fetch(input, init),
    );
    await renderApp('/orders/PO-1001');
    const alert = await screen.findByRole('alert', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(alert.textContent).toContain('Could not load the holds and the scrap records.');
    });
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    // Under the page header, before the section nav; the sections still drawn.
    expect(
      alert.compareDocumentPosition(screen.getByTestId('order-section-nav')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const id of ['order-holds', 'order-scrap']) {
      const quiet = screen.getByTestId(id).querySelector('[data-error]');
      expect(quiet?.getAttribute('data-error')).toBe('quiet');
    }
    expect(await screen.findByTestId('operation-OP10')).toBeTruthy();
  });

  it('says one failed section of the order in that section (#394)', async () => {
    const server = orderMes(orderState([order('PO-1001')]));
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      input.includes('/api/v1/scrap-records')
        ? Promise.resolve(problem(500, 'Internal Server Error', 'down', '/x'))
        : server.fetch(input, init),
    );
    await renderApp('/orders/PO-1001');
    const scrap = await screen.findByTestId('order-scrap');
    const own = await within(scrap).findByRole('alert', {}, { timeout: 5_000 });
    expect(own.textContent).toContain('Could not load the scrap records.');
    expect(screen.getAllByRole('alert')).toEqual([own]);
  });
});

describe('order actions on the design system (UX-6b, #329)', () => {
  it('labels the fields of a re-dispatch and shows a refused quantity under its field', async () => {
    const base = order('PO-1001', {
      status: 'in-progress',
      version: 5,
      dispatched: 12,
      remaining: 8,
    });
    const server = orderMes(orderState([base]));
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-redispatch'));
    const form = screen.getByTestId('action-form-redispatch');
    expect(within(form).getByRole('combobox', { name: 'CNC' })).toBe(
      screen.getByTestId('action-cnc'),
    );
    const quantity = within(form).getByRole('textbox', { name: 'Quantity' });
    expect(quantity).toBe(screen.getByTestId('action-quantity'));
    expect(quantity.getAttribute('name')).toBe('quantity');
    expect(quantity.getAttribute('inputmode')).toBe('numeric');
    // Its unit and the hint are read with it.
    const described = () =>
      (quantity.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' | ');
    expect(described()).toBe('blanks | Leave it empty to send all 8 remaining.');
    expect(quantity.getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(quantity, { target: { value: '9' } });
    fireEvent.click(within(form).getByTestId('action-submit'));
    // The form's summary announces; the field says where.
    expect(within(form).getByTestId('action-invalid').getAttribute('role')).toBe('alert');
    expect(quantity.getAttribute('aria-invalid')).toBe('true');
    expect(described()).toContain('At most the 8 blanks remaining.');
    expect(server.posts()).toHaveLength(0);
    // A re-dispatch is not destructive: its send button is the form's primary.
    expect(within(form).getByTestId('action-submit').className).toContain('bg-accent');
  });

  it('sends a cancel with the solid danger button, a close with the primary one', async () => {
    const imported = order('PO-1001', { version: 3 });
    const completed = order('PO-1002', { status: 'completed', version: 9 });
    vi.stubGlobal('fetch', orderMes(orderState([imported, completed])).fetch);
    const app = await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-cancel'));
    const cancel = screen.getByTestId('action-form-cancel');
    // Irreversible writes say so in their confirmation (design system 4.9).
    expect(cancel.textContent).toContain('This cannot be undone.');
    const reason = within(cancel).getByRole('textbox', { name: 'Reason' });
    expect(reason).toBe(screen.getByTestId('action-reason'));
    expect(reason.getAttribute('name')).toBe('reason');
    // Back first, the send button last; the send button repeats the verb.
    const buttons = within(cancel)
      .getAllByRole('button')
      .map((button) => button.dataset.testid);
    expect(buttons.slice(-2)).toEqual(['action-back', 'action-submit']);
    const send = within(cancel).getByRole('button', { name: 'Cancel order' });
    expect(send).toBe(within(cancel).getByTestId('action-submit'));
    expect(send.className).toContain('bg-alarm-solid');
    expect(within(cancel).getByTestId('action-back').className).not.toContain('bg-alarm-solid');

    await settle(() => {
      app.history.push('/orders/PO-1002');
    });
    fireEvent.click(await screen.findByTestId('action-close'));
    const close = screen.getByTestId('action-form-close');
    expect(close.textContent).toContain('This cannot be undone.');
    const closeSend = within(close).getByRole('button', { name: 'Close order' });
    expect(closeSend.className).toContain('bg-accent');
    expect(closeSend.className).not.toContain('bg-alarm-solid');
  });

  it('keeps the focus on the busy send button while the write is on its way', async () => {
    const base = order('PO-1001', { version: 3 });
    const server = orderMes(orderState([base]));
    let answer: (response: Response) => void = () => undefined;
    let posts = 0;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts += 1;
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return server.fetch(input, init);
    });
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-release'));
    // A release can be followed by a cancel: it does not claim to be irreversible.
    expect(screen.getByTestId('action-form-release').textContent).not.toContain('cannot be undone');
    const send = screen.getByTestId<HTMLButtonElement>('action-submit');
    send.focus();
    fireEvent.click(send);
    await waitFor(() => {
      expect(send.getAttribute('aria-busy')).toBe('true');
    });
    // Busy, not natively disabled: the focus stays, the label stays its name, a click is ignored.
    expect(send.disabled).toBe(false);
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(send);
    expect(within(send).getByText('Release')).toBeTruthy();
    fireEvent.click(send);
    expect(posts).toBe(1);
    answer(written(base, { status: 'released', version: 4 }));
    expect((await screen.findByTestId('action-done')).textContent).toContain('version 4');
  });

  it('puts a refused write at the top of the form, as an alarm callout', async () => {
    const base = order('PO-1001', { status: 'completed', version: 9 });
    const write: Write = () =>
      problem(409, 'Conflict', 'not signed off', '/x', PROBLEM_TYPES.signOffMissing);
    vi.stubGlobal('fetch', orderMes(orderState([base]), write).fetch);
    await renderApp('/orders/PO-1001');
    fireEvent.click(await screen.findByTestId('action-close'));
    const form = screen.getByTestId('action-form-close');
    fireEvent.click(within(form).getByTestId('action-submit'));
    const message = await within(form).findByTestId('action-message');
    expect(message.getAttribute('role')).toBe('alert');
    expect(message.className).toContain('bg-alarm-soft');
    // Under the heading, above the buttons.
    const heading = within(form).getByRole('heading', { name: 'Close order' });
    const back = within(form).getByTestId('action-back');
    expect(
      heading.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(message.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('makes abandoning a command a danger action, sent with the solid danger button', async () => {
    const base = order('PO-1001', { status: 'in-progress', version: 7, remaining: 0 });
    const lostJob = command('PO-1001', 1, { job: 'lost' });
    const state = orderState([base], {
      details: { 'PO-1001': detail(base, { commands: [lostJob] }) },
    });
    vi.stubGlobal('fetch', orderMes(state).fetch);
    await renderApp('/orders/PO-1001');
    const abandon = await screen.findByTestId(`abandon-${lostJob.commandId}`);
    expect(abandon.className).toContain('text-alarm-ink');
    fireEvent.click(abandon);
    const form = screen.getByTestId('action-form-abandon');
    expect(form.textContent).toContain('This cannot be undone.');
    expect(within(form).getByRole('heading', { level: 2 }).textContent).toBe(
      `Abandon command: ${lostJob.commandId}`,
    );
    expect(within(form).getByTestId('action-submit').className).toContain('bg-alarm-solid');
  });
});
