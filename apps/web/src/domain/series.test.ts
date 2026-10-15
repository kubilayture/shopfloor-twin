import { describe, expect, it } from 'vitest';
import { appendSample, chartData } from './series.ts';

const T0 = Date.parse('2026-10-15T06:00:00.000Z');
const iso = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const bucket = (seconds: number, min: number, max: number, avg: number) => ({
  t: iso(seconds),
  min,
  max,
  avg,
  n: 10,
});

describe('chartData', () => {
  const window = { from: T0, to: T0 + 3_600_000 };

  it('shapes buckets into uPlot columns in seconds: min, max, average', () => {
    const data = chartData([bucket(0, 1, 3, 2), bucket(60, 2, 6, 4)], 60_000, [], window);
    expect(data).toEqual([
      [T0 / 1000, T0 / 1000 + 60],
      [1, 2],
      [3, 6],
      [2, 4],
    ]);
  });

  it('appends live samples after the last bucket and drops older ones', () => {
    const data = chartData(
      [bucket(0, 1, 3, 2)],
      60_000,
      [
        { t: T0 + 30_000, value: 99 },
        { t: T0 + 60_000, value: 5 },
        { t: T0 + 61_000, value: 6 },
      ],
      window,
    );
    expect(data[0]).toEqual([T0 / 1000, T0 / 1000 + 60, T0 / 1000 + 61]);
    expect(data[3]).toEqual([2, 5, 6]);
    expect(data[1]).toEqual([1, 5, 6]);
  });

  it('breaks the line over a gap of more than three buckets', () => {
    const data = chartData([bucket(0, 1, 1, 1), bucket(600, 2, 2, 2)], 60_000, [], window);
    expect(data[0]).toHaveLength(3);
    expect(data[3]).toEqual([1, null, 2]);
    expect(data[0][1]).toBeGreaterThan(data[0][0] ?? 0);
    expect(data[0][1]).toBeLessThan(data[0][2] ?? 0);
  });

  it('clips to the window and keeps x strictly increasing', () => {
    const data = chartData(
      [bucket(-60, 0, 0, 0), bucket(0, 1, 1, 1)],
      60_000,
      [{ t: T0 + 7_200_000, value: 5 }],
      window,
    );
    expect(data[0]).toEqual([T0 / 1000]);
  });

  it('works with live samples only', () => {
    const data = chartData([], 1_000, [{ t: T0 + 1000, value: 3 }], window);
    expect(data).toEqual([[T0 / 1000 + 1], [3], [3], [3]]);
  });
});

describe('appendSample', () => {
  it('keeps time order, replaces a repeated instant and bounds the list', () => {
    let samples = appendSample([], { t: 2, value: 2 }, 3);
    samples = appendSample(samples, { t: 1, value: 1 }, 3);
    samples = appendSample(samples, { t: 2, value: 20 }, 3);
    samples = appendSample(samples, { t: 3, value: 3 }, 3);
    samples = appendSample(samples, { t: 4, value: 4 }, 3);
    expect(samples).toEqual([
      { t: 2, value: 20 },
      { t: 3, value: 3 },
      { t: 4, value: 4 },
    ]);
  });
});
