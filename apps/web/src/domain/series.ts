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
 * Buckets before a gap of more than three bucket widths are followed by a null point, so uPlot
 * breaks the line instead of drawing across a time without data.
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
  const gap = 3 * Math.max(bucketMs, 1000);
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

/** Keeps live samples by time, the newest value per instant, at most `limit` of the latest. */
export function appendSample(
  samples: readonly LiveSample[],
  sample: LiveSample,
  limit: number,
): LiveSample[] {
  const last = samples.at(-1);
  let next: LiveSample[];
  if (last === undefined || sample.t > last.t) next = [...samples, sample];
  else {
    next = samples.filter((existing) => existing.t !== sample.t);
    next.push(sample);
    next.sort((a, b) => a.t - b.t);
  }
  return next.length > limit ? next.slice(next.length - limit) : next;
}
