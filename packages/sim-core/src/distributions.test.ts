import {
  chiSquareTest,
  exponentialCdf,
  ksTest,
  logNormalCdf,
  mean,
  normalCdf,
  uniformCdf,
  variance,
  weibullCdf,
  type Cdf,
} from '@shopfloor/test-kit';
import { describe, expect, it } from 'vitest';
import {
  bernoulli,
  exponential,
  logNormal,
  logNormalFromMeanCv,
  logNormalFromMedian,
  logNormalParametersFromMeanCv,
  normal,
  poissonArrivalGap,
  standardNormal,
  uniform,
  weibull,
} from './distributions.ts';
import { RandomSource, type RandomStream } from './random.ts';

const N = 20_000;
const ALPHA = 0.01;

const sample = (key: string, draw: (stream: RandomStream) => number, n = N): number[] => {
  const stream = new RandomSource(20261014).stream(key);
  return Array.from({ length: n }, () => draw(stream));
};

describe('goodness of fit with fixed seeds (plan section 9, statistical tests)', () => {
  it.each<[string, (s: RandomStream) => number, Cdf]>([
    ['uniform(2, 5)', (s) => uniform(s, 2, 5), uniformCdf(2, 5)],
    ['exponential(mean 40 s)', (s) => exponential(s, 40), exponentialCdf(40)],
    ['normal(2.0, 0.35), leak-test reading', (s) => normal(s, 2.0, 0.35), normalCdf(2.0, 0.35)],
    ['standard normal', standardNormal, normalCdf()],
    ['log-normal(mu 3, sigma 0.6)', (s) => logNormal(s, 3, 0.6), logNormalCdf(3, 0.6)],
    [
      'log-normal from median 45 min, sigma 0.6 (repair)',
      (s) => logNormalFromMedian(s, 45, 0.6),
      logNormalCdf(Math.log(45), 0.6),
    ],
    [
      'Weibull(shape 1.4, scale 160 h), spindle failure',
      (s) => weibull(s, 1.4, 160),
      weibullCdf(1.4, 160),
    ],
    ['Weibull(shape 0.8, scale 10)', (s) => weibull(s, 0.8, 10), weibullCdf(0.8, 10)],
    ['Poisson arrival gaps at 2 per hour', (s) => poissonArrivalGap(s, 2), exponentialCdf(0.5)],
  ])('%s passes a Kolmogorov–Smirnov test', (name, draw, cdf) => {
    const result = ksTest(sample(name, draw), cdf);
    expect(result.pValue).toBeGreaterThan(ALPHA);
  });

  it('log-normal from mean and coefficient of variation has that mean and CV', () => {
    const values = sample('cycle-time', (s) => logNormalFromMeanCv(s, 240, 0.03));
    const m = mean(values);
    expect(m).toBeCloseTo(240, 0);
    expect(Math.sqrt(variance(values)) / m).toBeCloseTo(0.03, 2);
    const { mu, sigma } = logNormalParametersFromMeanCv(240, 0.03);
    expect(ksTest(values, logNormalCdf(mu, sigma)).pValue).toBeGreaterThan(ALPHA);
  });

  it('Poisson arrivals give Poisson counts per hour (chi-square)', () => {
    const stream = new RandomSource(20261014).stream('minor-stops');
    const rate = 2;
    const hours = 5_000;
    const counts = new Array<number>(hours).fill(0);
    for (let t = poissonArrivalGap(stream, rate); t < hours; t += poissonArrivalGap(stream, rate)) {
      const hour = Math.floor(t);
      counts[hour] = (counts[hour] ?? 0) + 1;
    }
    const bins = [0, 1, 2, 3, 4, 5];
    const factorial = (k: number): number => (k <= 1 ? 1 : k * factorial(k - 1));
    const pmf = (k: number): number => (Math.exp(-rate) * rate ** k) / factorial(k);
    const observed = bins.map((k) => counts.filter((c) => (k === 5 ? c >= 5 : c === k)).length);
    const expected = bins.map((k) =>
      k === 5 ? hours * (1 - [0, 1, 2, 3, 4].reduce((s, j) => s + pmf(j), 0)) : hours * pmf(k),
    );
    expect(chiSquareTest(observed, expected).pValue).toBeGreaterThan(ALPHA);
  });

  it('bernoulli(0.05) hits close to 5 %', () => {
    const stream = new RandomSource(20261014).stream('defect');
    const hits = Array.from({ length: N }, () => bernoulli(stream, 0.05)).filter(Boolean).length;
    const expected = N * 0.05;
    expect(chiSquareTest([hits, N - hits], [expected, N - expected]).pValue).toBeGreaterThan(ALPHA);
  });
});

describe('deterministic draw counts', () => {
  const countingStream = (): RandomStream & { draws: number } => {
    const inner = new RandomSource(1).stream('count');
    const counter = {
      key: inner.key,
      draws: 0,
      nextUint32: () => {
        counter.draws++;
        return inner.nextUint32();
      },
      nextFloat: () => {
        counter.draws++;
        return inner.nextFloat();
      },
    };
    return counter;
  };

  it.each<[string, (s: RandomStream) => unknown, number]>([
    ['uniform', (s) => uniform(s, 0, 1), 1],
    ['bernoulli', (s) => bernoulli(s, 0.5), 1],
    ['exponential', (s) => exponential(s, 1), 1],
    ['weibull', (s) => weibull(s, 2, 1), 1],
    ['standard normal', standardNormal, 2],
    ['log-normal', (s) => logNormal(s, 0, 1), 2],
  ])('%s always consumes %s draw(s), so streams stay aligned', (_name, draw, expected) => {
    const stream = countingStream();
    for (let i = 0; i < 100; i++) {
      draw(stream);
    }
    expect(stream.draws).toBe(100 * expected);
  });
});

describe('parameter validation', () => {
  const stream = new RandomSource(1).stream('validation');
  it.each<[string, () => unknown]>([
    ['uniform with max <= min', () => uniform(stream, 1, 1)],
    ['bernoulli with p > 1', () => bernoulli(stream, 1.1)],
    ['exponential with mean 0', () => exponential(stream, 0)],
    ['normal with negative sigma', () => normal(stream, 0, -1)],
    ['log-normal with sigma 0', () => logNormal(stream, 0, 0)],
    ['log-normal with median 0', () => logNormalFromMedian(stream, 0, 1)],
    ['log-normal with CV 0', () => logNormalFromMeanCv(stream, 10, 0)],
    ['Weibull with shape 0', () => weibull(stream, 0, 1)],
    ['Weibull with infinite scale', () => weibull(stream, 1, Number.POSITIVE_INFINITY)],
    ['Poisson with rate 0', () => poissonArrivalGap(stream, 0)],
  ])('rejects %s', (_case, act) => {
    expect(act).toThrow(RangeError);
  });
});
