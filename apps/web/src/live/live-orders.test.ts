import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { socketFactory } from '../test/fake-socket.ts';
import { command, order, pushedCommand } from '../test/order-fixtures.ts';
import {
  applyMessage,
  connectLiveToCache,
  liveKeys,
  resetLiveOrders,
  setLiveQueryDefaults,
  upsertCommand,
  upsertOrder,
  type LiveOrders,
} from './live-cache.ts';
import { LiveClient } from './live-client.ts';

const orders = (client: QueryClient) => client.getQueryData<LiveOrders>(liveKeys.orders);

describe('live orders', () => {
  it('keeps an order only when its version is at least as new', () => {
    const client = new QueryClient();
    applyMessage(client, {
      type: 'order',
      event: 'imported',
      order: order('PO-1', { version: 1 }),
    });
    applyMessage(client, {
      type: 'order',
      event: 'updated',
      order: order('PO-1', { version: 3, status: 'released' }),
    });
    // A write's answer read before the push never takes it back.
    upsertOrder(client, order('PO-1', { version: 2, status: 'imported' }));
    expect(orders(client)?.orders['PO-1']?.status).toBe('released');
    expect(orders(client)?.seq).toBe(3);
  });

  it('keeps a command only when its updatedAt is at least as new', () => {
    const client = new QueryClient();
    const sent = pushedCommand(command('PO-1', 1, { state: 'sent' }));
    applyMessage(client, {
      type: 'command',
      event: 'updated',
      command: { ...sent, state: 'accepted', updatedAt: '2026-10-15T06:05:00.000Z' },
    });
    upsertCommand(client, sent);
    expect(orders(client)?.commands['PO-1~OP10~1']?.state).toBe('accepted');
  });

  it('reads the pushed order again (its detail, execution and scrap)', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyMessage(client, { type: 'order', event: 'updated', order: order('PO-7') });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ['order', 'PO-7'],
      ['order-execution', 'PO-7'],
      ['order-scrap', 'PO-7'],
    ]);
  });

  it('forgets every pushed order and command on reset', () => {
    const client = new QueryClient();
    resetLiveOrders(client);
    expect(orders(client)).toBeUndefined();
    upsertOrder(client, order('PO-1'));
    upsertCommand(client, pushedCommand(command('PO-1')));
    resetLiveOrders(client);
    expect(orders(client)?.orders).toEqual({});
    expect(orders(client)?.commands).toEqual({});
  });

  it('forgets them after a stop (a lost session) once the client is open again', () => {
    const client = new QueryClient();
    setLiveQueryDefaults(client);
    const factory = socketFactory();
    const live = new LiveClient({ url: 'ws://x', createSocket: factory.create });
    connectLiveToCache(live, client);
    live.start();
    factory.last.open();
    factory.last.receive({ type: 'order', event: 'imported', order: order('PO-1') });
    expect(Object.keys(orders(client)?.orders ?? {})).toEqual(['PO-1']);
    // A 4401 or a logout stops the client; pushes in between are missed.
    live.stop();
    live.start();
    factory.last.open();
    expect(orders(client)?.orders).toEqual({});
  });
});
