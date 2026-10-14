export type Cdf = (x: number) => number;

export interface TestResult {
  statistic: number;
  pValue: number;
}

// Abramowitz & Stegun 7.1.26: absolute error below 1.5e-7, ample for goodness-of-fit tests.
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

export const normalCdf =
  (mean = 0, sigma = 1): Cdf =>
  (x) =>
    0.5 * (1 + erf((x - mean) / (sigma * Math.SQRT2)));

export const exponentialCdf =
  (mean: number): Cdf =>
  (x) =>
    x <= 0 ? 0 : 1 - Math.exp(-x / mean);

export const weibullCdf =
  (shape: number, scale: number): Cdf =>
  (x) =>
    x <= 0 ? 0 : 1 - Math.exp(-((x / scale) ** shape));

export const logNormalCdf =
  (mu: number, sigma: number): Cdf =>
  (x) =>
    x <= 0 ? 0 : normalCdf(mu, sigma)(Math.log(x));

export const uniformCdf =
  (min: number, max: number): Cdf =>
  (x) =>
    Math.min(1, Math.max(0, (x - min) / (max - min)));

export function kolmogorovQ(lambda: number): number {
  if (lambda < 0.2) {
    return 1;
  }
  let sum = 0;
  for (let j = 1; j <= 100; j++) {
    const term = 2 * (-1) ** (j - 1) * Math.exp(-2 * j * j * lambda * lambda);
    sum += term;
    if (Math.abs(term) < 1e-12) {
      break;
    }
  }
  return Math.min(1, Math.max(0, sum));
}

// One-sample Kolmogorov–Smirnov test with the Stephens small-sample correction (Numerical Recipes 14.3).
export function ksTest(sample: readonly number[], cdf: Cdf): TestResult {
  if (sample.length === 0) {
    throw new RangeError('ksTest needs a non-empty sample');
  }
  const sorted = [...sample].sort((a, b) => a - b);
  const n = sorted.length;
  let statistic = 0;
  sorted.forEach((x, i) => {
    const f = cdf(x);
    statistic = Math.max(statistic, f - i / n, (i + 1) / n - f);
  });
  const root = Math.sqrt(n);
  return { statistic, pValue: kolmogorovQ((root + 0.12 + 0.11 / root) * statistic) };
}

// Pearson chi-square test; p-value from the Wilson–Hilferty normal approximation of the chi-square distribution.
export function chiSquareTest(
  observed: readonly number[],
  expected: readonly number[],
  estimatedParameters = 0,
): TestResult & { degreesOfFreedom: number } {
  if (observed.length !== expected.length || observed.length < 2) {
    throw new RangeError('chiSquareTest needs two equally long arrays with at least two bins');
  }
  const statistic = observed.reduce((sum, o, i) => {
    const e = expected[i] ?? 0;
    if (!(e > 0)) {
      throw new RangeError(`expected count in bin ${String(i)} must be positive`);
    }
    return sum + (o - e) ** 2 / e;
  }, 0);
  const degreesOfFreedom = observed.length - 1 - estimatedParameters;
  return { statistic, degreesOfFreedom, pValue: chiSquareSurvival(statistic, degreesOfFreedom) };
}

export function chiSquareSurvival(x: number, degreesOfFreedom: number): number {
  if (degreesOfFreedom < 1) {
    throw new RangeError('degrees of freedom must be at least 1');
  }
  const k = degreesOfFreedom;
  const z = ((x / k) ** (1 / 3) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  return 1 - normalCdf()(z);
}

export function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function variance(values: readonly number[]): number {
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}
