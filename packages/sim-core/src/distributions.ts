import type { RandomStream } from './random.ts';

const requirePositive = (name: string, value: number): void => {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a positive finite number, got ${String(value)}`);
  }
};

const openUnit = (stream: RandomStream): number => 1 - stream.nextFloat();

export function uniform(stream: RandomStream, min: number, max: number): number {
  if (!(max > min)) {
    throw new RangeError(`uniform needs max > min, got [${String(min)}, ${String(max)}]`);
  }
  return min + (max - min) * stream.nextFloat();
}

export function bernoulli(stream: RandomStream, probability: number): boolean {
  if (!(probability >= 0 && probability <= 1)) {
    throw new RangeError(`probability must be in [0, 1], got ${String(probability)}`);
  }
  return stream.nextFloat() < probability;
}

export function exponential(stream: RandomStream, mean: number): number {
  requirePositive('mean', mean);
  return -mean * Math.log(openUnit(stream));
}

export function standardNormal(stream: RandomStream): number {
  const radius = Math.sqrt(-2 * Math.log(openUnit(stream)));
  return radius * Math.cos(2 * Math.PI * stream.nextFloat());
}

export function normal(stream: RandomStream, mean: number, sigma: number): number {
  requirePositive('sigma', sigma);
  return mean + sigma * standardNormal(stream);
}

export function logNormal(stream: RandomStream, mu: number, sigma: number): number {
  requirePositive('sigma', sigma);
  return Math.exp(mu + sigma * standardNormal(stream));
}

export function logNormalFromMedian(stream: RandomStream, median: number, sigma: number): number {
  requirePositive('median', median);
  return logNormal(stream, Math.log(median), sigma);
}

export function logNormalParametersFromMeanCv(
  mean: number,
  cv: number,
): { mu: number; sigma: number } {
  requirePositive('mean', mean);
  requirePositive('cv', cv);
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  return { mu: Math.log(mean) - (sigma * sigma) / 2, sigma };
}

export function logNormalFromMeanCv(stream: RandomStream, mean: number, cv: number): number {
  const { mu, sigma } = logNormalParametersFromMeanCv(mean, cv);
  return logNormal(stream, mu, sigma);
}

export function weibull(stream: RandomStream, shape: number, scale: number): number {
  requirePositive('shape', shape);
  requirePositive('scale', scale);
  return scale * (-Math.log(openUnit(stream))) ** (1 / shape);
}

export function poissonArrivalGap(stream: RandomStream, ratePerUnit: number): number {
  requirePositive('rate', ratePerUnit);
  return exponential(stream, 1 / ratePerUnit);
}
