/**
 * Exact rational numbers for OEE (ADR-0021): reduced BigInt fractions and half-up decimal
 * rounding with integer arithmetic only. Nothing in `oee-core` uses floating point.
 */

/** A reduced fraction: `den > 0` and gcd(|num|, den) = 1; zero is `0/1`. */
export interface Fraction {
  readonly num: bigint;
  readonly den: bigint;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** Truncating division of two bigints: the only division in `oee-core`. */
function quotient(dividend: bigint, divisor: bigint): bigint {
  // eslint-disable-next-line no-restricted-syntax -- both operands are bigint, so this is integer division
  return dividend / divisor;
}

/** The fraction num/den, reduced. Throws on a zero denominator. */
export function fraction(num: bigint, den = 1n): Fraction {
  if (den === 0n) {
    throw new RangeError('fraction with a zero denominator');
  }
  const sign = den < 0n ? -1n : 1n;
  const divisor = gcd(num, den);
  return { num: quotient(sign * num, divisor), den: quotient(sign * den, divisor) };
}

export const multiply = (a: Fraction, b: Fraction): Fraction =>
  fraction(a.num * b.num, a.den * b.den);

export const add = (a: Fraction, b: Fraction): Fraction =>
  fraction(a.num * b.den + b.num * a.den, a.den * b.den);

/** -1, 0 or 1 as a is below, equal to or above b. */
export function compare(a: Fraction, b: Fraction): -1 | 0 | 1 {
  const difference = a.num * b.den - b.num * a.den;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export const equals = (a: Fraction, b: Fraction): boolean => compare(a, b) === 0;

/** `num/den`, as the reference cases write it. */
export const formatFraction = (f: Fraction): string => `${String(f.num)}/${String(f.den)}`;

function checkPlaces(places: number): void {
  if (!Number.isSafeInteger(places) || places < 0) {
    throw new RangeError(`decimal places must be a non-negative integer, got ${String(places)}`);
  }
}

/**
 * The value rounded half-up to `places` decimals, as an integer count of 10^-places. A tie rounds
 * away from zero (0.03125 → 313 at four places); OEE values are never negative.
 */
export function roundHalfUp(f: Fraction, places = 4): bigint {
  checkPlaces(places);
  const scaled = abs(f.num) * 10n ** BigInt(places);
  const whole = quotient(scaled, f.den);
  const rounded = 2n * (scaled - whole * f.den) >= f.den ? whole + 1n : whole;
  return f.num < 0n ? -rounded : rounded;
}

/** The value as a decimal string rounded half-up to `places` decimals (default four): `0.8193`. */
export function toDecimal(f: Fraction, places = 4): string {
  const units = roundHalfUp(f, places);
  const digits = abs(units)
    .toString()
    .padStart(places + 1, '0');
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return units < 0n ? `-${text}` : text;
}
