import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { characteristic, hold, signal } from '../test/quality-fixtures.ts';
import { HOLD_ID } from '../test/quality-fixtures.ts';
import { socketFactory } from '../test/fake-socket.ts';
import { applyMessage, connectLiveToCache } from './live-cache.ts';
import { LiveClient } from './live-client.ts';
import {
  liveQualityKey,
  resetLiveQuality,
  upsertCharacteristic,
  upsertHold,
  upsertSignal,
  type LiveQuality,
} from './live-quality.ts';

const read = (client: QueryClient) => client.getQueryData<LiveQuality>(liveQualityKey);

/** Which query keys were marked stale. */
function watch(client: QueryClient, keys: readonly (readonly unknown[])[]) {
  for (const queryKey of keys) client.setQueryData([...queryKey], { kept: true });
  return () =>
    keys
      .filter((queryKey) => client.getQueryState([...queryKey])?.isInvalidated)
      .map((k) => k.join('/'));
}

describe('the quality topic in the cache (#203)', () => {
  it('upserts episodes by id: equal or newer row versions win, removed ones are marked', () => {
    const client = new QueryClient();
    const stale = watch(client, [
      ['quality', 'suggestion', 1],
      ['quality', 'chart', 'leak-rate', '|'],
    ]);
    applyMessage(client, { type: 'spc-signal', event: 'opened', signal: signal(1) });
    applyMessage(client, {
      type: 'spc-signal',
      event: 'acknowledged',
      signal: signal(1, { rowVersion: 2 }),
    });
    // Grown at the same version: applies.
    applyMessage(client, {
      type: 'spc-signal',
      event: 'updated',
      signal: signal(1, { rowVersion: 2, points: 4 }),
    });
    // Older: ignored.
    applyMessage(client, { type: 'spc-signal', event: 'updated', signal: signal(1) });
    expect(read(client)?.signals['1']?.signal).toMatchObject({ rowVersion: 2, points: 4 });
    expect(stale()).toEqual(['quality/suggestion/1']);
    applyMessage(client, { type: 'spc-signal', event: 'removed', signal: signal(1) });
    expect(read(client)?.signals['1']?.removed).toBe(true);
    upsertSignal(client, signal(5));
    expect(read(client)?.signals['5']?.removed).toBe(false);
  });

  it('upserts holds and characteristics by version and reads their other parts again', () => {
    const client = new QueryClient();
    const stale = watch(client, [
      ['quality', 'hold', HOLD_ID],
      ['quality', 'chart', 'leak-rate', '|'],
      ['quality', 'characteristics'],
      ['quality', 'holds', '|'],
    ]);
    applyMessage(client, { type: 'quality-hold', event: 'opened', hold: hold({ version: 2 }) });
    applyMessage(client, { type: 'quality-hold', event: 'scope', hold: hold({ version: 1 }) });
    expect(read(client)?.holds[HOLD_ID]?.version).toBe(2);
    applyMessage(client, {
      type: 'spc-characteristic',
      event: 'limits',
      characteristic: characteristic({ version: 4 }),
    });
    upsertCharacteristic(client, characteristic({ version: 3 }));
    expect(read(client)?.characteristics['leak-rate']?.version).toBe(4);
    upsertHold(client, hold({ version: 3, state: 'released' }));
    expect(read(client)?.holds[HOLD_ID]?.state).toBe('released');
    expect(stale().sort()).toEqual([
      'quality/characteristics',
      'quality/chart/leak-rate/|',
      `quality/hold/${HOLD_ID}`,
    ]);
    resetLiveQuality(client);
    expect(read(client)?.holds).toEqual({});
    // Reset without a set does nothing.
    const fresh = new QueryClient();
    resetLiveQuality(fresh);
    expect(read(fresh)).toBeUndefined();
  });

  it('reads the quality screens again once subscribed, and forgets pushes after a lost connection', async () => {
    const client = new QueryClient();
    const factory = socketFactory();
    const live = new LiveClient({ url: 'ws://test', createSocket: factory.create });
    connectLiveToCache(live, client);
    live.start();
    factory.last.open();
    const stale = watch(client, [['quality', 'holds', '|']]);
    factory.last.receive({ type: 'subscribed', topic: 'quality', metric: null });
    expect(stale()).toEqual(['quality/holds/|']);
    factory.last.receive({ type: 'quality-hold', event: 'opened', hold: hold() });
    expect(read(client)?.holds[HOLD_ID]).toBeDefined();
    factory.last.drop();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    factory.last.open();
    expect(read(client)?.holds).toEqual({});
    live.stop();
  });
});
