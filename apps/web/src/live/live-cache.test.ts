import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { current, EPOCH } from '../test/fixtures.ts';
import { socketFactory } from '../test/fake-socket.ts';
import {
  LIVE_SAMPLE_LIMIT,
  TELEMETRY_GC_MS,
  applyMessage,
  connectLiveToCache,
  liveKeys,
  setLiveQueryDefaults,
  type LiveStates,
  type LiveTelemetry,
} from './live-cache.ts';
import { LiveClient } from './live-client.ts';

function liveQueryClient(): QueryClient {
  const queryClient = new QueryClient();
  setLiveQueryDefaults(queryClient);
  return queryClient;
}

const states = (queryClient: QueryClient) => queryClient.getQueryData<LiveStates>(liveKeys.states);

describe('applyMessage', () => {
  it('merges a states snapshot and keeps the newer state of each equipment', () => {
    const queryClient = liveQueryClient();
    applyMessage(queryClient, {
      type: 'state',
      equipment: 'cnc-01',
      current: current({ state: 'Down', seq: 12 }),
    });
    applyMessage(queryClient, {
      type: 'snapshot',
      topic: 'states',
      clock: { epoch: EPOCH, watermark: '2026-10-15T06:10:00.000Z' },
      states: [
        { equipment: 'cnc-01', current: current({ state: 'Running', seq: 11 }) },
        { equipment: 'wsh-01', current: current({ state: 'Idle' }) },
      ],
    });
    expect(states(queryClient)?.states['cnc-01']?.state).toBe('Down');
    expect(states(queryClient)?.states['wsh-01']?.state).toBe('Idle');
    expect(states(queryClient)?.clock?.watermark).toBe('2026-10-15T06:10:00.000Z');
  });

  it('applies state deltas in order and a newer epoch over a higher seq', () => {
    const queryClient = liveQueryClient();
    const push = (state: string, seq: number, epoch = EPOCH) => {
      applyMessage(queryClient, {
        type: 'state',
        equipment: 'cnc-01',
        current: current({ state, seq, epoch }),
      });
    };
    push('Running', 5);
    push('Starved', 6);
    push('Running', 4);
    expect(states(queryClient)?.states['cnc-01']?.state).toBe('Starved');
    push('Off', 1, EPOCH + 60);
    expect(states(queryClient)?.states['cnc-01']?.state).toBe('Off');
  });

  it('moves the clock forward only', () => {
    const queryClient = liveQueryClient();
    const clock = (watermark: string, epoch = EPOCH) => {
      applyMessage(queryClient, { type: 'clock', epoch, watermark });
    };
    clock('2026-10-15T06:10:00.000Z');
    const before = states(queryClient);
    clock('2026-10-15T06:09:00.000Z');
    expect(states(queryClient)).toBe(before);
    clock('2026-10-15T06:11:00.000Z');
    expect(states(queryClient)?.clock?.watermark).toBe('2026-10-15T06:11:00.000Z');
    clock('2026-10-15T00:00:00.000Z', EPOCH + 1);
    expect(states(queryClient)?.clock?.epoch).toBe(EPOCH + 1);
  });

  it('collects telemetry from the snapshot and deltas, newest per instant, bounded', () => {
    const queryClient = liveQueryClient();
    const sample = (t: string, value: number) => ({
      equipment: 'wsh-01',
      metric: 'bath-temperature',
      unit: 'degC',
      t,
      value,
    });
    applyMessage(queryClient, {
      type: 'snapshot',
      topic: 'telemetry:wsh-01',
      samples: [sample('2026-10-15T06:00:00.000Z', 60)],
    });
    applyMessage(queryClient, { type: 'telemetry', ...sample('2026-10-15T06:00:01.000Z', 61) });
    applyMessage(queryClient, { type: 'telemetry', ...sample('2026-10-15T06:00:00.000Z', 59) });
    applyMessage(queryClient, { type: 'snapshot', topic: 'telemetry:wsh-01', samples: [] });
    const telemetry = queryClient.getQueryData<LiveTelemetry>(liveKeys.telemetry('wsh-01'));
    expect(telemetry?.['bath-temperature']).toEqual({
      unit: 'degC',
      samples: [
        { t: Date.parse('2026-10-15T06:00:00.000Z'), value: 59 },
        { t: Date.parse('2026-10-15T06:00:01.000Z'), value: 61 },
      ],
      version: 3,
    });

    applyMessage(queryClient, { type: 'telemetry', ...sample('2026-10-15T06:00:02.000Z', 62) });
    const after = queryClient.getQueryData<LiveTelemetry>(liveKeys.telemetry('wsh-01'));
    expect(after).not.toBe(telemetry);
    expect(after?.['bath-temperature']?.version).toBe(4);
    expect(after?.['bath-temperature']?.samples).toHaveLength(3);
  });

  it('bounds the samples kept per metric cheaply over a long session', () => {
    const queryClient = liveQueryClient();
    const start = Date.parse('2026-10-15T07:00:00.000Z');
    for (let index = 0; index < 3 * LIVE_SAMPLE_LIMIT; index += 1) {
      applyMessage(queryClient, {
        type: 'telemetry',
        equipment: 'wsh-01',
        metric: 'bath-temperature',
        unit: 'degC',
        t: new Date(start + index * 1000).toISOString(),
        value: index,
      });
    }
    const samples =
      queryClient.getQueryData<LiveTelemetry>(liveKeys.telemetry('wsh-01'))?.['bath-temperature']
        ?.samples ?? [];
    expect(samples.length).toBeGreaterThanOrEqual(LIVE_SAMPLE_LIMIT);
    expect(samples.length).toBeLessThanOrEqual(LIVE_SAMPLE_LIMIT * 1.25 + 1);
    expect(samples.at(-1)?.value).toBe(3 * LIVE_SAMPLE_LIMIT - 1);
  });

  it("drops a machine's telemetry a while after nobody reads it", () => {
    vi.useFakeTimers();
    try {
      const queryClient = liveQueryClient();
      applyMessage(queryClient, {
        type: 'telemetry',
        equipment: 'wsh-01',
        metric: 'bath-temperature',
        unit: 'degC',
        t: '2026-10-15T06:00:00.000Z',
        value: 1,
      });
      applyMessage(queryClient, {
        type: 'clock',
        epoch: EPOCH,
        watermark: '2026-10-15T06:00:00.000Z',
      });
      vi.advanceTimersByTime(TELEMETRY_GC_MS + 1);
      expect(queryClient.getQueryData(liveKeys.telemetry('wsh-01'))).toBeUndefined();
      expect(states(queryClient)?.clock).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores acknowledgements and errors', () => {
    const queryClient = liveQueryClient();
    applyMessage(queryClient, { type: 'subscribed', topic: 'states', metric: null });
    applyMessage(queryClient, { type: 'unsubscribed', topic: 'states', metric: null });
    applyMessage(queryClient, { type: 'error', code: 'busy', detail: 'x' });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe('connectLiveToCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('feeds pushed messages into the cache and refetches REST reads after a reconnect', () => {
    const queryClient = liveQueryClient();
    const factory = socketFactory();
    const client = new LiveClient({
      url: 'ws://x',
      createSocket: factory.create,
      random: () => 0.5,
    });
    const disconnect = connectLiveToCache(client, queryClient);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    client.start();
    factory.last.open();
    factory.last.receive({ type: 'state', equipment: 'cnc-01', current: current() });
    expect(states(queryClient)?.states['cnc-01']?.state).toBe('Running');
    expect(invalidate).not.toHaveBeenCalled();

    factory.last.drop();
    vi.advanceTimersByTime(1_000);
    factory.last.open();
    expect(invalidate).toHaveBeenCalledTimes(1);
    const options = invalidate.mock.calls[0]?.[0];
    const predicate = options?.predicate;
    expect(predicate).toBeTypeOf('function');

    disconnect();
    factory.last.receive({ type: 'state', equipment: 'wsh-01', current: current() });
    expect(states(queryClient)?.states['wsh-01']).toBeUndefined();
  });
});
