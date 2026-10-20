import { describe, expect, it } from 'vitest';
import {
  drainRate,
  histogram,
  histogramDelta,
  judgeCounts,
  parseMetrics,
  quantile,
  settledThrough,
  shareAtOrBelow,
  total,
} from './perf-metrics.ts';

const text = (count: number, at025: number, at1: number, at5: number) => `
# HELP mes_ingest_lag_seconds lag
# TYPE mes_ingest_lag_seconds histogram
mes_ingest_lag_seconds_bucket{le="0.25",class="state"} ${String(at025)}
mes_ingest_lag_seconds_bucket{le="1",class="state"} ${String(at1)}
mes_ingest_lag_seconds_bucket{le="5",class="state"} ${String(at5)}
mes_ingest_lag_seconds_bucket{le="+Inf",class="state"} ${String(count)}
mes_ingest_lag_seconds_sum{class="state"} ${String(count * 0.1)}
mes_ingest_lag_seconds_count{class="state"} ${String(count)}
mes_ingest_lag_seconds_bucket{le="0.25",class="cycle"} 10
mes_ingest_lag_seconds_bucket{le="1",class="cycle"} 10
mes_ingest_lag_seconds_bucket{le="5",class="cycle"} 10
mes_ingest_lag_seconds_bucket{le="+Inf",class="cycle"} 10
mes_ingest_lag_seconds_sum{class="cycle"} 1
mes_ingest_lag_seconds_count{class="cycle"} 10
mes_ingest_lag_excluded_total{reason="duplicate"} 3
mes_ingest_pending_messages 7
`;

describe('the performance suite’s metrics (#245)', () => {
  it('parses samples with labels and sums them by name and label', () => {
    const metrics = parseMetrics(text(100, 90, 99, 100));
    expect(total(metrics, 'mes_ingest_pending_messages')).toBe(7);
    expect(total(metrics, 'mes_ingest_lag_excluded_total', { reason: 'duplicate' })).toBe(3);
    expect(total(metrics, 'mes_ingest_lag_excluded_total', { reason: 'anchor' })).toBe(0);
    expect(total(metrics, 'absent')).toBeUndefined();
  });

  it('judges a window exactly on the bucket edges: two readings subtracted, classes summed', () => {
    const before = histogram(parseMetrics(text(100, 90, 99, 100)), 'mes_ingest_lag_seconds');
    const after = histogram(parseMetrics(text(1100, 1050, 1095, 1099)), 'mes_ingest_lag_seconds');
    if (!before || !after) throw new Error('no histogram');
    const window = histogramDelta(after, before);
    // 1000 state observations in the window (the cycle class did not move).
    expect(window.count).toBe(1000);
    expect(shareAtOrBelow(window, 0.25)).toBe(0.96);
    expect(shareAtOrBelow(window, 1)).toBe(0.996);
    expect(shareAtOrBelow(window, 5)).toBe(0.999);
    expect(() => shareAtOrBelow(window, 0.3)).toThrow(/no bucket edge/);
    // The 95th percentile lies in the first bucket, the 99.9th past 1 s.
    expect(quantile(window, 0.95)).toBeLessThanOrEqual(0.25);
    expect(quantile(window, 0.999)).toBeGreaterThan(1);
  });

  it('settles a stream through its first contiguous run of seen and reported numbers', () => {
    expect(settledThrough([])).toBe(0);
    expect(
      settledThrough([
        [1, 10],
        [11, 12],
        [20, 30],
      ]),
    ).toBe(12);
    expect(
      settledThrough([
        [5, 9],
        [1, 4],
      ]),
    ).toBe(9);
  });

  it('counts a thing shown once a page sample counts it, and misses a late or absent one', () => {
    const truth = [1_000, 2_000, 3_000];
    const page = [
      { at: 1_500, count: 1 },
      { at: 2_000, count: 1 },
      { at: 4_500, count: 3 },
    ];
    const judged = judgeCounts(truth, page, 100_000, 2_000);
    expect(judged.latencies).toEqual([500, undefined, 1_500]);
    expect(judgeCounts(truth, page, 4_000, 2_000).unjudged).toBe(1);
  });

  it('takes the drain rate as the median slope between its own samples, ramp and tail left out', () => {
    // Subscribed at 0, nothing stored for 0.5 s, then 1,000/s for 10 s, a slow tail; caught up at 11 s.
    const series = Array.from({ length: 121 }, (_, i) => {
      const at = i * 100;
      const stored = at < 500 ? 0 : at <= 10_500 ? at - 500 : 10_000 + (at - 10_500) / 10;
      return { at, stored, handled: stored + 5, subscribed: 1 };
    });
    const drain = drainRate(series, 11_000);
    expect(drain.median).toBeCloseTo(1_000, 6);
    expect(drain.report.messagesDrained).toBe(10_050);
    expect(drain.subscribedAt).toBe(0);
    expect(drainRate(series, undefined).median).toBeUndefined();
    expect(
      drainRate(
        series.map((s) => ({ ...s, subscribed: 0 })),
        11_000,
      ).reason,
    ).toMatch(/never subscribed/);
  });
});
