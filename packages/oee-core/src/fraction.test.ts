import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compare,
  equals,
  formatFraction,
  fraction,
  multiply,
  roundHalfUp,
  toDecimal,
} from './fraction.ts';

describe('fractions', () => {
  it('are reduced, with a positive denominator, and zero is 0/1', () => {
    expect(fraction(6n, 8n)).toEqual({ num: 3n, den: 4n });
    expect(fraction(6n, -8n)).toEqual({ num: -3n, den: 4n });
    expect(fraction(0n, -5n)).toEqual({ num: 0n, den: 1n });
    expect(fraction(7n)).toEqual({ num: 7n, den: 1n });
    expect(() => fraction(1n, 0n)).toThrow(/zero denominator/);
  });

  it('multiply, compare and format exactly', () => {
    expect(multiply(fraction(7n, 12n), fraction(12n, 7n))).toEqual(fraction(1n));
    expect(compare(fraction(1n, 3n), fraction(1n, 2n))).toBe(-1);
    expect(compare(fraction(1n, 2n), fraction(1n, 3n))).toBe(1);
    expect(equals(fraction(2n, 4n), fraction(1n, 2n))).toBe(true);
    expect(formatFraction(fraction(721n, 880n))).toBe('721/880');
  });
});

describe('half-up rounding in integers', () => {
  it.each([
    [1n, 32n, 4, '0.0313'], // a tie rounds up, not to even
    [1n, 3n, 4, '0.3333'],
    [2n, 3n, 4, '0.6667'],
    [21n, 20n, 4, '1.0500'],
    [0n, 1n, 4, '0.0000'],
    [1n, 1n, 4, '1.0000'],
    [-1n, 32n, 4, '-0.0313'], // a negative tie rounds away from zero
    [-1n, 300_000n, 4, '0.0000'], // never "-0.0000"
    [5n, 2n, 0, '3'],
    [123_456_789n, 1_000n, 2, '123456.79'],
  ])('%s/%s to %s places is %s', (num, den, places, text) => {
    expect(toDecimal(fraction(num, den), places)).toBe(text);
  });

  it('refuses a negative or fractional number of places', () => {
    expect(() => toDecimal(fraction(1n), -1)).toThrow(/decimal places/);
    expect(() => roundHalfUp(fraction(1n), 1.5)).toThrow(/decimal places/);
  });

  const fractions = fc
    .tuple(
      fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
      fc.bigInt({ min: 1n, max: 10n ** 9n }),
    )
    .map(([num, den]) => fraction(num, den));

  it('property: rounding is monotone', () => {
    fc.assert(
      fc.property(fractions, fractions, (a, b) => {
        const [low, high] = compare(a, b) <= 0 ? [a, b] : [b, a];
        expect(roundHalfUp(low) <= roundHalfUp(high)).toBe(true);
      }),
    );
  });

  it('property: the rounded value lies within half a unit, ties away from zero', () => {
    fc.assert(
      fc.property(fractions, (f) => {
        const units = roundHalfUp(f);
        // |f × 10^4 − units| ≤ 1/2, in integers: |2·num·10^4 − 2·units·den| ≤ den.
        const error = 2n * f.num * 10_000n - 2n * units * f.den;
        expect(error <= f.den && -error <= f.den).toBe(true);
        if (error === f.den || -error === f.den) {
          // A tie: the result is the one further from zero.
          expect(units < 0n ? error > 0n : error < 0n).toBe(true);
        }
      }),
    );
  });
});
