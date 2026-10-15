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

  it('breaks the line over a gap of more than three usual spacings', () => {
    const data = chartData(
      [bucket(0, 1, 1, 1), bucket(60, 1, 1, 1), bucket(120, 1, 1, 1), bucket(600, 2, 2, 2)],
      60_000,
      [],
      window,
    );
    expect(data[3]).toEqual([1, 1, 1, null, 2]);
    expect(data[0][3]).toBeGreaterThan(data[0][2] ?? 0);
    expect(data[0][3]).toBeLessThan(data[0][4] ?? 0);
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

  it('draws a line through metrics sampled once a simulated minute', () => {
    const hour = { from: T0, to: T0 + 3_600_000 };
    const buckets = Array.from({ length: 60 }, (_, index) => bucket(index * 60, 1, 2, 1.5));
    const data = chartData(buckets, 6_000, [], hour);
    expect(data[3]).not.toContain(null);
    expect(data[0]).toHaveLength(60);

    const withHole = buckets.filter((_, index) => index < 20 || index >= 30);
    expect(chartData(withHole, 6_000, [], hour)[3].filter((value) => value === null)).toHaveLength(
      1,
    );
  });

  it('works with live samples only', () => {
    const data = chartData([], 1_000, [{ t: T0 + 1000, value: 3 }], window);
    expect(data).toEqual([[T0 / 1000 + 1], [3], [3], [3]]);
  });
});

describe('appendSample', () => {
  it('keeps time order, replaces a repeated instant and trims to the limit in batches', () => {
    const samples: { t: number; value: number }[] = [];
    appendSample(samples, { t: 2, value: 2 }, 4);
    appendSample(samples, { t: 1, value: 1 }, 4);
    appendSample(samples, { t: 2, value: 20 }, 4);
    appendSample(samples, { t: 4, value: 4 }, 4);
    appendSample(samples, { t: 3, value: 3 }, 4);
    expect(samples).toEqual([
      { t: 1, value: 1 },
      { t: 2, value: 20 },
      { t: 3, value: 3 },
      { t: 4, value: 4 },
    ]);
    appendSample(samples, { t: 5, value: 5 }, 4);
    expect(samples).toHaveLength(5);
    appendSample(samples, { t: 6, value: 6 }, 4);
    expect(samples.map((sample) => sample.t)).toEqual([3, 4, 5, 6]);
  });
});
