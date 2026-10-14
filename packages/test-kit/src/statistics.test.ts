import { describe, expect, it } from 'vitest';
import {
  chiSquareSurvival,
  chiSquareTest,
  erf,
  exponentialCdf,
  kolmogorovQ,
  ksTest,
  logNormalCdf,
  mean,
  normalCdf,
  uniformCdf,
  variance,
  weibullCdf,
} from './statistics.ts';

describe('erf and normal CDF', () => {
  it.each([
    [0, 0],
    [0.5, 0.5204999],
    [1, 0.8427008],
    [2, 0.9953223],
    [-1, -0.8427008],
  ])('erf(%s) matches the tabulated value', (x, expected) => {
    expect(erf(x)).toBeCloseTo(expected, 6);
  });

  it.each([
    [1.6448536, 0.95],
    [1.959964, 0.975],
    [2.5758293, 0.995],
  ])('the standard normal CDF at %s is %s', (z, p) => {
    expect(normalCdf()(z)).toBeCloseTo(p, 6);
  });
});

describe('Kolmogorov distribution', () => {
  it.each([
    [1.2238, 0.1],
    [1.3581, 0.05],
    [1.6276, 0.01],
  ])('Q(%s) matches the published critical value for alpha = %s', (lambda, alpha) => {
    expect(kolmogorovQ(lambda)).toBeCloseTo(alpha, 3);
  });

  it('is 1 for tiny distances', () => {
    expect(kolmogorovQ(0.1)).toBe(1);
  });
});

describe('chi-square distribution', () => {
  it.each([
    [11.0705, 5, 0.05],
    [18.307, 10, 0.05],
    [23.2093, 10, 0.01],
    [31.4104, 20, 0.05],
  ])('survival at the table value %s with %s degrees of freedom is %s', (x, df, p) => {
    expect(chiSquareSurvival(x, df)).toBeCloseTo(p, 2);
  });

  it('rejects fewer than one degree of freedom', () => {
    expect(() => chiSquareSurvival(1, 0)).toThrow(RangeError);
  });
});

describe('ksTest', () => {
  const quantiles = (n: number, inverse: (p: number) => number): number[] =>
    Array.from({ length: n }, (_, i) => inverse((i + 0.5) / n));

  it('accepts a sample that follows the distribution exactly', () => {
    const sample = quantiles(1_000, (p) => -2 * Math.log(1 - p));
    expect(ksTest(sample, exponentialCdf(2)).pValue).toBeGreaterThan(0.99);
  });

  it('rejects a sample from the wrong distribution', () => {
    const sample = quantiles(1_000, (p) => -2 * Math.log(1 - p));
    expect(ksTest(sample, exponentialCdf(3)).pValue).toBeLessThan(0.001);
  });

  it('computes the statistic for a tiny sample by hand', () => {
    const result = ksTest([0.5], uniformCdf(0, 1));
    expect(result.statistic).toBeCloseTo(0.5, 10);
  });

  it('rejects an empty sample', () => {
    expect(() => ksTest([], uniformCdf(0, 1))).toThrow(RangeError);
  });
});

describe('chiSquareTest', () => {
  it('matches a hand-calculated example', () => {
    const result = chiSquareTest([18, 22, 20, 40], [25, 25, 25, 25]);
    expect(result.statistic).toBeCloseTo((49 + 9 + 25 + 225) / 25, 10);
    expect(result.degreesOfFreedom).toBe(3);
    expect(result.pValue).toBeLessThan(0.01);
  });

  it('subtracts estimated parameters from the degrees of freedom', () => {
    expect(chiSquareTest([10, 10, 10], [10, 10, 10], 1).degreesOfFreedom).toBe(1);
  });

  it.each([
    [[1], [1]],
    [[1, 2], [1]],
    [
      [1, 2],
      [0, 3],
    ],
  ])('rejects invalid input %j / %j', (observed, expected) => {
    expect(() => chiSquareTest(observed, expected)).toThrow(RangeError);
  });
});

describe('CDFs and summary statistics', () => {
  it('evaluates the closed-form CDFs at known points', () => {
    expect(exponentialCdf(2)(2)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(exponentialCdf(2)(-1)).toBe(0);
    expect(weibullCdf(1.5, 100)(100)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(weibullCdf(1.5, 100)(0)).toBe(0);
    expect(logNormalCdf(Math.log(10), 0.5)(10)).toBeCloseTo(0.5, 6);
    expect(logNormalCdf(0, 1)(0)).toBe(0);
    expect(uniformCdf(0, 4)(1)).toBe(0.25);
    expect(uniformCdf(0, 4)(9)).toBe(1);
  });

  it('computes mean and sample variance', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(variance([1, 2, 3, 4])).toBeCloseTo(5 / 3, 12);
  });
});
