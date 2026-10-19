import type { OrderOeeDto } from '@shopfloor/contracts/mes-api';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { BOTTLENECKS, SHIFT_KEY, lineBucket, orderOee } from '../test/oee-fixtures.ts';
import { applyMessage, liveKeys, setLiveQueryDefaults, type LiveLineOee } from './live-cache.ts';

function liveQueryClient(): QueryClient {
  const queryClient = new QueryClient();
  setLiveQueryDefaults(queryClient);
  return queryClient;
}

const line = (queryClient: QueryClient) => queryClient.getQueryData<LiveLineOee>(liveKeys.lineOee);

describe('line and order OEE pushes in the cache (#233)', () => {
  it('keeps the last oee:line body and rereads the line REST reads when the clock moves on', () => {
    const queryClient = liveQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const push = (hour: string, kind: 'snapshot' | 'oee-line' = 'oee-line') => {
      const body = {
        topic: 'oee:line' as const,
        productionMode: 'orders' as const,
        bottlenecks: BOTTLENECKS,
        hour: lineBucket('hour', hour),
        shift: lineBucket('shift', SHIFT_KEY),
      };
      applyMessage(
        queryClient,
        kind === 'snapshot' ? { type: 'snapshot', ...body } : { type: 'oee-line', ...body },
      );
    };
    push('2026-10-15T05:00:00.000Z', 'snapshot');
    expect(line(queryClient)?.hour?.key).toBe('2026-10-15T05:00:00.000Z');
    expect(line(queryClient)?.bottlenecks).toEqual(BOTTLENECKS);
    push('2026-10-15T05:00:00.000Z');
    expect(invalidate).not.toHaveBeenCalled();
    push('2026-10-15T06:00:00.000Z');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['line-oee'] });
  });

  it('keeps each order’s pushed OEE under its own key, null for an unknown order', () => {
    const queryClient = liveQueryClient();
    applyMessage(queryClient, {
      type: 'snapshot',
      topic: 'oee:order:PO-1',
      order: orderOee('PO-1'),
    });
    applyMessage(queryClient, { type: 'oee-order', topic: 'oee:order:PO-2', order: null });
    expect(queryClient.getQueryData<OrderOeeDto | null>(liveKeys.orderOee('PO-1'))?.orderId).toBe(
      'PO-1',
    );
    expect(queryClient.getQueryData(liveKeys.orderOee('PO-2'))).toBeNull();
    applyMessage(queryClient, {
      type: 'oee-order',
      topic: 'oee:order:PO-1',
      order: orderOee('PO-1', { revision: 2 }),
    });
    expect(queryClient.getQueryData<OrderOeeDto | null>(liveKeys.orderOee('PO-1'))?.revision).toBe(
      2,
    );
  });
});
