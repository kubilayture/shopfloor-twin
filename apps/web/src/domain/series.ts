import type { Series } from '@shopfloor/contracts/mes-api';

/** One stored bucket or one live sample (min = max = avg = the value). */
export interface SeriesPoint {
  readonly t: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
}

export interface LiveSample {
  readonly t: number;
  readonly value: number;
}

/** uPlot's aligned columns: x in seconds, then min, max and average. */
export type ChartData = [number[], (number | null)[], (number | null)[], (number | null)[]];

export type SeriesPoints = Series['series'][number]['points'];

/**
 * The chart columns of one metric: the decimated buckets (ADR-0019) followed by the live samples
 * that arrived after the last bucket, clipped to the window, by time, one point per instant.
 * A gap of more than three times the usual spacing (the median distance between points, at least
 * a bucket) is marked with a null point, so uPlot breaks the line instead of drawing across a time
 * without data. The spacing comes from the data because sample rates differ: at 60× an OPC UA
 * metric is sampled about once a simulated minute, far wider than a 1-hour range's buckets.
 */
export function chartData(
  buckets: SeriesPoints,
  bucketMs: number,
  live: readonly LiveSample[],
  window: { from: number; to: number },
): ChartData {
  const points: SeriesPoint[] = buckets.map((bucket) => ({
    t: Date.parse(bucket.t),
    min: bucket.min,
    max: bucket.max,
    avg: bucket.avg,
  }));
  const storedUntil = (points.at(-1)?.t ?? Number.NEGATIVE_INFINITY) + bucketMs;
  for (const sample of live) {
    if (sample.t >= storedUntil) {
      points.push({ t: sample.t, min: sample.value, max: sample.value, avg: sample.value });
    }
  }
  const byTime = new Map<number, SeriesPoint>();
  for (const point of points) {
    if (point.t >= window.from && point.t <= window.to) byTime.set(point.t, point);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);

  const data: ChartData = [[], [], [], []];
  const gap = 3 * Math.max(bucketMs, 1000, medianSpacing(sorted));
  let previous: number | undefined;
  for (const point of sorted) {
    if (previous !== undefined && point.t - previous > gap) {
      data[0].push((previous + 1) / 1000);
      data[1].push(null);
      data[2].push(null);
      data[3].push(null);
    }
    data[0].push(point.t / 1000);
    data[1].push(point.min);
    data[2].push(point.max);
    data[3].push(point.avg);
    previous = point.t;
  }
  return data;
}

function medianSpacing(points: readonly SeriesPoint[]): number {
  if (points.length < 2) return 0;
  const spacings: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    spacings.push((points[index]?.t ?? 0) - (points[index - 1]?.t ?? 0));
  }
  spacings.sort((a, b) => a - b);
  return spacings[Math.floor(spacings.length / 2)] ?? 0;
}

/** Index of the first sample at or after `t` (samples are by time). */
function lowerBound(samples: readonly LiveSample[], t: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((samples[middle]?.t ?? 0) < t) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Adds a live sample in place, in time order, replacing one at the same instant, and keeps
 * between `limit` and 1.25 × `limit` of the latest. In-order samples (the usual case) cost O(1)
 * amortised: trimming happens in batches, not on every sample.
 */
export function appendSample(samples: LiveSample[], sample: LiveSample, limit: number): void {
  const last = samples.at(-1);
  if (last === undefined || sample.t > last.t) samples.push(sample);
  else {
    const index = lowerBound(samples, sample.t);
    if (samples[index]?.t === sample.t) samples[index] = sample;
    else samples.splice(index, 0, sample);
  }
  if (samples.length > limit + Math.max(1, Math.floor(limit / 4))) {
    samples.splice(0, samples.length - limit);
  }
}
