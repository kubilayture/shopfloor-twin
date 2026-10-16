import { describe, expect, it } from 'vitest';
import { KeyedLimiter } from './realtime.ts';

describe('per-name login buckets (#168)', () => {
  it('limits each key on its own and forgets a key once its bucket has refilled', () => {
    // 1 token per second, bursts of 2.
    const limiter = new KeyedLimiter(1, 2);
    expect([limiter.take('a', 0), limiter.take('a', 0), limiter.take('a', 0)]).toEqual([
      undefined,
      undefined,
      1,
    ]);
    expect(limiter.take('b', 0)).toBeUndefined();
    expect(limiter.size).toBe(2);
    // At 1.5 s `b` (one token left at 0) is full again and forgotten; `a` (empty at 0) is not.
    expect(limiter.take('c', 1_500)).toBeUndefined();
    expect(limiter.size).toBe(2);
    // At 2.6 s `a` and `c` are full too.
    expect(limiter.take('d', 2_600)).toBeUndefined();
    expect(limiter.size).toBe(1);
    // Many names tried once each, then quiet: the map shrinks back to the last one.
    for (let i = 0; i < 1_000; i++) limiter.take(`ghost-${String(i)}`, 10_000);
    expect(limiter.size).toBe(1_000);
    expect(limiter.take('e', 20_000)).toBeUndefined();
    expect(limiter.size).toBe(1);
  });

  it('prunes at most once a second, keeping buckets that have not refilled', () => {
    // 1 token per second, bursts of 1.
    const limiter = new KeyedLimiter(1, 1);
    limiter.take('a', 0);
    limiter.take('b', 999);
    // At 1.5 s (the first prune since 0): `a` is full and forgotten, `b` is not.
    limiter.take('c', 1_500);
    expect(limiter.size).toBe(2);
    // No prune within a second of the last one.
    limiter.take('d', 2_000);
    expect(limiter.size).toBe(3);
    // At 2.5 s: `b` and `c` are full, `d` is not.
    limiter.take('e', 2_500);
    expect(limiter.size).toBe(2);
  });
});
