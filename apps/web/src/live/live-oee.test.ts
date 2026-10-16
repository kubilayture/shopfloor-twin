import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { socketFactory } from '../test/fake-socket.ts';
import { bucket, hourBucket, record } from '../test/oee-fixtures.ts';
import {
  applyMessage,
  liveKeys,
  setLiveQueryDefaults,
  upsertRecord,
  type LiveDowntime,
  type LiveOee,
} from './live-cache.ts';
import { LiveClient } from './live-client.ts';

function liveQueryClient(): QueryClient {
  const queryClient = new QueryClient();
  setLiveQueryDefaults(queryClient);
  return queryClient;
}

const oee = (queryClient: QueryClient, id: string) =>
  queryClient.getQueryData<LiveOee>(liveKeys.oee(id));
const downtime = (queryClient: QueryClient) =>
  queryClient.getQueryData<LiveDowntime>(liveKeys.downtime);

describe('OEE pushes in the cache', () => {
  it('keeps the newest bucket per key from snapshots and deltas', () => {
    const queryClient = liveQueryClient();
    const hour = hourBucket('cell-m1', '2026-10-15T06:00:00.000Z');
    applyMessage(queryClient, {
      type: 'snapshot',
      topic: 'oee:cell-m1',
      hour,
      shift: bucket('cell-m1'),
    });
    applyMessage(queryClient, {
      type: 'oee',
      topic: 'oee:cell-m1',
      hour: { ...hour, provisionalMs: 5 },
      shift: bucket('cell-m1', { final: true }),
    });
    applyMessage(queryClient, { type: 'oee', topic: 'oee:cnc-01', hour: null, shift: null });
    const live = oee(queryClient, 'cell-m1');
    expect(live?.hour?.provisionalMs).toBe(5);
    expect(live?.shift?.final).toBe(true);
    expect(oee(queryClient, 'cnc-01')).toEqual({ hour: null, shift: null });
  });

  it('keeps only the buckets the clock is in and rereads REST when it moves on', () => {
    const queryClient = liveQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const push = (hourStart: string, shift = bucket('cell-m1')) => {
      applyMessage(queryClient, {
        type: 'oee',
        topic: 'oee:cell-m1',
        hour: hourBucket('cell-m1', hourStart),
        shift,
      });
    };
    push('2026-10-15T06:00:00.000Z');
    push('2026-10-15T06:00:00.000Z');
    expect(invalidate).not.toHaveBeenCalled();

    // A new hour: the old one is dropped and the hourly REST reads are refetched.
    push('2026-10-15T07:00:00.000Z');
    expect(oee(queryClient, 'cell-m1')?.hour?.key).toBe('2026-10-15T07:00:00.000Z');
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([['oee']]);

    // A new shift: also the shift's OEE and the shifts.
    invalidate.mockClear();
    push('2026-10-15T11:00:00.000Z', bucket('cell-m1', { key: '2026-10-15/B' }));
    expect(oee(queryClient, 'cell-m1')?.shift?.key).toBe('2026-10-15/B');
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ['oee'],
      ['shift-oee'],
      ['shifts'],
    ]);
  });
});

describe('downtime pushes in the cache', () => {
  it('upserts by id with the newer version and applies removals', () => {
    const queryClient = liveQueryClient();
    const first = record();
    applyMessage(queryClient, { type: 'downtime', event: 'created', record: first });
    applyMessage(queryClient, {
      type: 'downtime',
      event: 'recoded',
      record: { ...first, reason: 'SETUP', uncoded: false, version: 4 },
    });
    // An older message (version 3) arriving late does not take the coding back.
    applyMessage(queryClient, { type: 'downtime', event: 'updated', record: first });
    expect(downtime(queryClient)?.records[first.id]?.record.reason).toBe('SETUP');
    expect(downtime(queryClient)?.seq).toBe(3);

    upsertRecord(queryClient, { ...first, reason: 'BREAKDOWN', version: 5 });
    expect(downtime(queryClient)?.records[first.id]?.record.reason).toBe('BREAKDOWN');

    applyMessage(queryClient, { type: 'downtime', event: 'removed', record: first });
    expect(downtime(queryClient)?.records[first.id]?.removed).toBe(true);
  });

  it('prefers a closed record over an open one at the same version', () => {
    const queryClient = liveQueryClient();
    const open = record({ end: null });
    applyMessage(queryClient, {
      type: 'downtime',
      event: 'closed',
      record: { ...open, end: '2026-10-15T04:10:00.000Z', ms: 600_000 },
    });
    applyMessage(queryClient, { type: 'downtime', event: 'updated', record: open });
    expect(downtime(queryClient)?.records[open.id]?.record.end).toBe('2026-10-15T04:10:00.000Z');
  });
});

describe('LiveClient with OEE and downtime topics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the busy backoff anew once a subscription is confirmed', () => {
    const factory = socketFactory();
    const client = new LiveClient({
      url: 'ws://x',
      createSocket: factory.create,
      random: () => 0.5,
    });
    client.start();
    factory.last.open();
    client.subscribe('oee:cell-m1');
    const subscribes = () =>
      factory.last.sent.filter((message) => message.topic === 'oee:line-a1').length;
    const busy = () => {
      factory.last.receive({ type: 'error', code: 'busy', detail: 'snapshots' });
    };
    busy();
    vi.advanceTimersByTime(1_000);
    busy();
    vi.advanceTimersByTime(2_000);
    // Without a reset the next retry would wait 4 s.
    factory.last.receive({ type: 'subscribed', topic: 'oee:cell-m1', metric: null });
    client.subscribe('oee:line-a1');
    expect(subscribes()).toBe(1);
    busy();
    vi.advanceTimersByTime(1_000);
    expect(subscribes()).toBe(2);
  });

  it('subscribes to oee:<id> and downtime and asks again after a reconnect', () => {
    const factory = socketFactory();
    const client = new LiveClient({
      url: 'ws://x',
      createSocket: factory.create,
      random: () => 0.5,
    });
    client.start();
    factory.last.open();
    const offCell = client.subscribe('oee:cell-m1');
    const offDowntime = client.subscribe('downtime');
    expect(factory.last.sent).toEqual([
      { type: 'subscribe', topic: 'oee:cell-m1' },
      { type: 'subscribe', topic: 'downtime' },
    ]);
    factory.last.drop();
    vi.advanceTimersByTime(1_000);
    factory.last.open();
    expect(factory.last.sent).toEqual([
      { type: 'subscribe', topic: 'oee:cell-m1' },
      { type: 'subscribe', topic: 'downtime' },
    ]);
    offCell();
    offDowntime();
    expect(factory.last.sent.slice(2)).toEqual([
      { type: 'unsubscribe', topic: 'oee:cell-m1' },
      { type: 'unsubscribe', topic: 'downtime' },
    ]);
  });
});
