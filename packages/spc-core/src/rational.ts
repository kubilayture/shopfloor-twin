/**
 * The few operations on `oee-core`'s exact fractions that SPC needs beyond those it exports
 * (ADR-0032): sums, differences, quotients and means. No floating point anywhere in `spc-core`.
 */
import { fraction, multiply, type Fraction } from '@shopfloor/oee-core';

export const ZERO: Fraction = fraction(0n);

export const integer = (value: number): Fraction => fraction(BigInt(value));

export const add = (a: Fraction, b: Fraction): Fraction =>
  fraction(a.num * b.den + b.num * a.den, a.den * b.den);

export const subtract = (a: Fraction, b: Fraction): Fraction =>
  fraction(a.num * b.den - b.num * a.den, a.den * b.den);

/** a ÷ b; throws on b = 0. */
export function divide(a: Fraction, b: Fraction): Fraction {
  if (b.num === 0n) {
    throw new RangeError('division by a zero fraction');
  }
  return fraction(a.num * b.den, a.den * b.num);
}

export const scale = (a: Fraction, k: Fraction): Fraction => multiply(a, k);

/** The arithmetic mean of a non-empty list. */
export function mean(values: readonly Fraction[]): Fraction {
  if (values.length === 0) {
    throw new RangeError('mean of no values');
  }
  return divide(values.reduce(add, ZERO), integer(values.length));
}

/**
 * A decimal constant written as text ("2.66", "0.577") as an exact fraction, so the tables read
 * like the textbook and nothing is typed as a float literal.
 */
export function decimal(text: string): Fraction {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new RangeError(`not a decimal: "${text}"`);
  }
  const [, whole = '', digits = ''] = match;
  return fraction(BigInt(whole + digits), 10n ** BigInt(digits.length));
}
