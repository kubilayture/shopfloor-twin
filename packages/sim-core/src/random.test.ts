import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ksTest, normalCdf } from '@shopfloor/test-kit';
import {
  RandomSource,
  Xoshiro128StarStar,
  fmix32,
  fnv1a32,
  hashedStandardNormal,
  streamState,
} from './random.ts';

const take = (next: () => number, n: number): number[] => Array.from({ length: n }, next);

describe('Xoshiro128StarStar', () => {
  it.each<[[number, number, number, number], number[]]>([
    [
      [1, 2, 3, 4],
      [11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849],
    ],
    [
      [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef],
      [2463954730, 5524658, 74256371, 1905451993, 3123413897, 314453775, 1263677054, 1531511215],
    ],
  ])('matches the reference C implementation from state %j', (state, expected) => {
    const generator = new Xoshiro128StarStar(state);
    expect(take(() => generator.nextUint32(), expected.length)).toEqual(expected);
  });

  it('rejects the all-zero state, which would only ever produce zeros', () => {
    expect(() => new Xoshiro128StarStar([0, 0, 0, 0])).toThrow(RangeError);
  });
});

describe('hash functions used to derive streams', () => {
  it.each([
    ['', 0x811c9dc5],
    ['a', 0xe40c292c],
    ['foobar', 0xbf9cf968],
  ])('fnv1a32(%j) matches the published FNV-1a test vector', (text, expected) => {
    expect(fnv1a32(text)).toBe(expected);
  });

  it('fmix32 maps 0 to 0 and is a bijection on a sample', () => {
    expect(fmix32(0)).toBe(0);
    fc.assert(
      fc.property(fc.uniqueArray(fc.nat({ max: 0xffffffff }), { minLength: 2 }), (values) => {
        expect(new Set(values.map(fmix32)).size).toBe(values.length);
      }),
    );
  });
});

describe('hashedStandardNormal', () => {
  it('is a pure function of seed, key and index', () => {
    expect(hashedStandardNormal(1, 'cnc-01/spindle', 42)).toBe(
      hashedStandardNormal(1, 'cnc-01/spindle', 42),
    );
    expect(hashedStandardNormal(1, 'cnc-01/spindle', 42)).not.toBe(
      hashedStandardNormal(1, 'cnc-01/spindle', 43),
    );
    expect(hashedStandardNormal(1, 'cnc-01/spindle', 42)).not.toBe(
      hashedStandardNormal(2, 'cnc-01/spindle', 42),
    );
    expect(hashedStandardNormal(1, 'cnc-01/spindle', 42)).not.toBe(
      hashedStandardNormal(1, 'cnc-02/spindle', 42),
    );
  });

  it('follows the standard normal distribution over consecutive indices (KS test)', () => {
    const start = 1_791_774_000;
    const values = Array.from({ length: 20_000 }, (_, i) =>
      hashedStandardNormal(7, 'cnc-01/spindle', start + i),
    );
    expect(ksTest(values, normalCdf()).pValue).toBeGreaterThan(0.01);
  });

  it('is uncorrelated between neighbouring indices', () => {
    const xs = Array.from({ length: 20_000 }, (_, i) => hashedStandardNormal(7, 'k', i));
    let sum = 0;
    for (let i = 1; i < xs.length; i++) sum += (xs[i] ?? 0) * (xs[i - 1] ?? 0);
    expect(Math.abs(sum / (xs.length - 1))).toBeLessThan(0.03);
  });
});

describe('RandomSource', () => {
  it('gives the same sequence for the same seed and key', () => {
    const a = new RandomSource(42).stream('cnc-01/failure/spindle-overload');
    const b = new RandomSource(42).stream('cnc-01/failure/spindle-overload');
    expect(take(() => a.nextUint32(), 100)).toEqual(take(() => b.nextUint32(), 100));
  });

  it('keeps a stream unchanged when other streams are added (plan section 4)', () => {
    const alone = new RandomSource(7).stream('cnc-01/cycle');
    const crowded = new RandomSource(7);
    crowded.stream('cnc-02/cycle');
    crowded.stream('new-machine/cycle');
    const withOthers = crowded.stream('cnc-01/cycle');
    expect(take(() => withOthers.nextFloat(), 50)).toEqual(take(() => alone.nextFloat(), 50));
  });

  it('gives different sequences for different keys or seeds', () => {
    const streams = [
      [1, 'cnc-01/cycle'],
      [1, 'cnc-02/cycle'],
      [2, 'cnc-01/cycle'],
    ] as const;
    const heads = streams.map(([seed, key]) => {
      const stream = new RandomSource(seed).stream(key);
      return take(() => stream.nextUint32(), 4).join(',');
    });
    expect(new Set(heads).size).toBe(streams.length);
  });

  it('locks the stream derivation so it cannot change silently', () => {
    expect(streamState(42, 'cnc-01/cycle').every((word) => word !== 0)).toBe(true);
    const stream = new RandomSource(42).stream('cnc-01/cycle');
    expect(take(() => stream.nextUint32(), 4)).toMatchInlineSnapshot(`
      [
        2123802054,
        2040115349,
        637226931,
        564064071,
      ]
    `);
  });

  it('refuses to issue the same key twice', () => {
    const source = new RandomSource(1);
    source.stream('asm-01/operator');
    expect(() => source.stream('asm-01/operator')).toThrow(/already issued/);
  });

  it.each([-1, 1.5, 2 ** 32, Number.NaN])('rejects the seed %s', (seed) => {
    expect(() => new RandomSource(seed)).toThrow(RangeError);
  });

  it('rejects an empty key', () => {
    expect(() => new RandomSource(1).stream('')).toThrow(RangeError);
  });

  it('produces floats in [0, 1) with mean close to 1/2', () => {
    const stream = new RandomSource(2026).stream('uniformity');
    const values = take(() => stream.nextFloat(), 100_000);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.005);
  });

  it('produces uncorrelated streams for neighbouring keys', () => {
    const source = new RandomSource(2026);
    const a = source.stream('cnc-01/cycle');
    const b = source.stream('cnc-02/cycle');
    const n = 50_000;
    const xs = take(() => a.nextFloat(), n);
    const ys = take(() => b.nextFloat(), n);
    const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
    const mx = mean(xs);
    const my = mean(ys);
    let cov = 0;
    let vx = 0;
    let vy = 0;
    xs.forEach((x, i) => {
      const y = ys[i] ?? 0;
      cov += (x - mx) * (y - my);
      vx += (x - mx) ** 2;
      vy += (y - my) ** 2;
    });
    expect(Math.abs(cov / Math.sqrt(vx * vy))).toBeLessThan(0.02);
  });
});
