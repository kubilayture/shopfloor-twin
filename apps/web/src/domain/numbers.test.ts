import { describe, expect, it } from 'vitest';
import {
  MAX_DECIMALS,
  decimalFraction,
  decimalsOf,
  fixedText,
  plainText,
  pointDecimals,
  spcPrecision,
  spcValueText,
} from './numbers.ts';

// Values whose binary form is not exact (#295): the API's doubles are display values only.
const LEAK = 3381 * 0.001; // 3.3810000000000002
const POINT_THREE = 0.1 + 0.2; // 0.30000000000000004

describe('number text (#295)', () => {
  it('starts from doubles that print with binary noise', () => {
    expect(String(LEAK)).toBe('3.3810000000000002');
    expect(String(POINT_THREE)).toBe('0.30000000000000004');
    expect((1.005).toFixed(2)).toBe('1.00'); // why `toFixed` is not used
  });

  it('reads a double as the exact fraction of its 15-digit decimal form', () => {
    expect(decimalFraction(LEAK)).toEqual({ num: 3381n, den: 1000n });
    expect(decimalFraction(POINT_THREE)).toEqual({ num: 3n, den: 10n });
    expect(decimalFraction(-2.5)).toEqual({ num: -5n, den: 2n });
    expect(decimalFraction(1e-7)).toEqual({ num: 1n, den: 10_000_000n });
    expect(decimalFraction(1.5e21)).toEqual({ num: 1_500_000_000_000_000_000_000n, den: 1n });
    expect(() => decimalFraction(Number.NaN)).toThrow(RangeError);
    expect(() => decimalFraction(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('takes the decimals of a resolution step', () => {
    expect(decimalsOf(0.001)).toBe(3);
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(0.05)).toBe(2);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(5)).toBe(0);
    expect(decimalsOf(POINT_THREE)).toBe(1);
    expect(decimalsOf(1e-7)).toBe(MAX_DECIMALS);
    expect(decimalsOf(0)).toBe(MAX_DECIMALS);
    expect(decimalsOf(-0.1)).toBe(MAX_DECIMALS);
    expect(decimalsOf(Number.NaN)).toBe(MAX_DECIMALS);
  });

  it('writes fixed decimals, rounding half away from zero on the decimal value', () => {
    expect(fixedText(LEAK, 3)).toBe('3.381');
    expect(fixedText(LEAK, 4)).toBe('3.3810');
    expect(fixedText(LEAK, 2)).toBe('3.38');
    expect(fixedText(POINT_THREE, 3)).toBe('0.300');
    expect(fixedText(1.005, 2)).toBe('1.01');
    expect(fixedText(2.5, 0)).toBe('3');
    expect(fixedText(-2.5, 0)).toBe('-3');
    expect(fixedText(-0.0004, 3)).toBe('0.000');
    expect(fixedText(0.93, 2)).toBe('0.93');
  });

  it('writes a value of no known precision without noise and without trailing zeros', () => {
    expect(plainText(LEAK)).toBe('3.381');
    expect(plainText(POINT_THREE)).toBe('0.3');
    expect(plainText(30.2 + 1e-12)).toBe('30.2');
    expect(plainText(100)).toBe('100');
    expect(plainText(0)).toBe('0');
    expect(plainText(3.2)).toBe('3.2');
    expect(plainText(1 / 3)).toBe('0.333333');
    expect(plainText(-1.25)).toBe('-1.25');
  });

  it('gives readings the resolution’s decimals and statistics one more', () => {
    const leak = spcPrecision(0.001);
    expect(leak.reading).toBe(3);
    expect(leak.statistic).toBe(4);
    expect(pointDecimals(leak, 'I')).toBe(3);
    expect(pointDecimals(leak, 'MR')).toBe(3);
    expect(pointDecimals(leak, 'R')).toBe(3);
    expect(pointDecimals(leak, 'Xbar')).toBe(4);
  });

  it('writes an SPC value from its exact steps', () => {
    const leak = spcPrecision(0.001);
    // A reading: 3381 steps, sent as 3.3810000000000002.
    expect(spcValueText({ value: LEAK, steps: '3381/1' }, leak, leak.reading)).toBe('3.381');
    // A mean of five readings: 16906/5 steps = 3.3812.
    expect(spcValueText({ value: 3.3812000000000006, steps: '16906/5' }, leak, 4)).toBe('3.3812');
    // A limit: 10144/3 steps = 3.38133…, half-up at four decimals.
    expect(spcValueText({ value: 3.381333333333333, steps: '10144/3' }, leak, 4)).toBe('3.3813');
    // 20003/6 steps = 3.3338333…; 3.33383 rounds up at five.
    expect(spcValueText({ value: 3.3338, steps: '20003/6' }, leak, 5)).toBe('3.33383');
    // A negative lower limit.
    expect(spcValueText({ value: -0.25, steps: '-250/1' }, leak, 4)).toBe('-0.2500');
    // A measurement's whole steps.
    expect(spcValueText({ value: POINT_THREE, steps: 300 }, leak, 3)).toBe('0.300');
  });

  it('falls back on the double when the steps or the resolution can’t be read', () => {
    const leak = spcPrecision(0.001);
    expect(spcValueText({ value: LEAK, steps: 'garbage' }, leak, 3)).toBe('3.381');
    expect(spcValueText({ value: LEAK, steps: '1/0' }, leak, 3)).toBe('3.381');
    expect(spcValueText({ value: LEAK, steps: 0.5 }, leak, 3)).toBe('3.381');
    const none = spcPrecision(0);
    expect(none.reading).toBe(MAX_DECIMALS);
    expect(spcValueText({ value: LEAK, steps: '3381/1' }, none, 3)).toBe('3.381');
  });
});
