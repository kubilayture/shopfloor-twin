import fc from 'fast-check';
import { describe, expect, inject, test } from 'vitest';
import { drawSeed, parseSeed, resolveSeed, seedLine } from './index.ts';

describe('parseSeed', () => {
  test('unset or empty: no pinned seed', () => {
    expect(parseSeed(undefined)).toBeUndefined();
    expect(parseSeed('')).toBeUndefined();
    expect(parseSeed('  ')).toBeUndefined();
  });

  test('a 32-bit signed integer', () => {
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed('-7')).toBe(-7);
    expect(parseSeed('2147483647')).toBe(2147483647);
    expect(parseSeed('-2147483648')).toBe(-2147483648);
  });

  test.each(['abc', '1.5', '1e3', '0x10', '2147483648', '-2147483649', '12abc'])(
    'refuses %s',
    (raw) => {
      expect(() => parseSeed(raw)).toThrow(/FC_SEED must be an integer/);
    },
  );
});

test('resolveSeed: FC_SEED wins, else a drawn seed in range', () => {
  expect(resolveSeed('123')).toBe(123);
  for (let i = 0; i < 100; i += 1) {
    const seed = drawSeed();
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31).toBe(true);
  }
  expect(new Set(Array.from({ length: 20 }, () => resolveSeed(undefined))).size).toBeGreaterThan(1);
});

test('the seed line', () => {
  expect(seedLine('@shopfloor/sim-core', 42)).toBe(
    'fast-check seed @shopfloor/sim-core: 42 (FC_SEED=42 reproduces)',
  );
});

describe('in this workspace', () => {
  test('fast-check runs with the seed the global setup provided', () => {
    expect(fc.readConfigureGlobal().seed).toBe(inject('fcSeed'));
  });

  test('an explicit seed wins over the global one', () => {
    const saved = fc.readConfigureGlobal();
    try {
      fc.configureGlobal({ ...saved, seed: 1 });
      const underOne = fc.sample(fc.integer(), 10);
      const explicitUnderOne = fc.sample(fc.integer(), { numRuns: 10, seed: 156 });
      fc.configureGlobal({ ...saved, seed: 2 });
      expect(fc.sample(fc.integer(), 10)).not.toEqual(underOne);
      expect(fc.sample(fc.integer(), { numRuns: 10, seed: 156 })).toEqual(explicitUnderOne);
    } finally {
      fc.configureGlobal(saved);
    }
  });
});
