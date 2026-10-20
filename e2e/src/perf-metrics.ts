/**
 * Pure helpers of the performance suite (#245, e2e/src/perf.ts): the Prometheus text format, the
 * lag histogram's window and its exact judgement on bucket edges, the settled part of a device
 * stream and the count judge of the OEE dashboard. Unit tested in perf-metrics.test.ts.
 */

export interface Sample {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** The samples of a `/metrics` text, by metric name. */
export function parseMetrics(text: string): Map<string, Sample[]> {
  const metrics = new Map<string, Sample[]>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const [, name = '', body = '', value = ''] = match;
    const labels: Record<string, string> = {};
    for (const pair of body.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1] ?? ''] = pair[2] ?? '';
    }
    const list = metrics.get(name) ?? [];
    list.push({ labels, value: Number(value) });
    metrics.set(name, list);
  }
  return metrics;
}

/** The sum of a metric's samples (whose labels include `where`); undefined when it is absent. */
export function total(
  metrics: ReadonlyMap<string, readonly Sample[]>,
  name: string,
  where: Readonly<Record<string, string>> = {},
): number | undefined {
  const samples = metrics.get(name);
  if (samples === undefined) return undefined;
  return samples
    .filter((s) => Object.entries(where).every(([k, v]) => s.labels[k] === v))
    .reduce((sum, s) => sum + s.value, 0);
}

/** A histogram summed over every label but `le`: cumulative counts per upper edge. */
export interface Histogram {
  readonly buckets: ReadonlyMap<number, number>;
  readonly count: number;
  readonly sum: number;
}

export function histogram(
  metrics: ReadonlyMap<string, readonly Sample[]>,
  name: string,
): Histogram | undefined {
  const buckets = metrics.get(`${name}_bucket`);
  if (buckets === undefined) return undefined;
  const byEdge = new Map<number, number>();
  for (const sample of buckets) {
    const le = sample.labels.le === '+Inf' ? Infinity : Number(sample.labels.le);
    byEdge.set(le, (byEdge.get(le) ?? 0) + sample.value);
  }
  return {
    buckets: new Map([...byEdge].sort(([a], [b]) => a - b)),
    count: total(metrics, `${name}_count`) ?? 0,
    sum: total(metrics, `${name}_sum`) ?? 0,
  };
}

/** `later − earlier`: the observations between two readings of the same process. */
export function histogramDelta(later: Histogram, earlier: Histogram | undefined): Histogram {
  if (earlier === undefined) return later;
  return {
    buckets: new Map(
      [...later.buckets].map(([le, n]) => [le, n - (earlier.buckets.get(le) ?? 0)] as const),
    ),
    count: later.count - earlier.count,
    sum: later.sum - earlier.sum,
  };
}

/** The share of observations at or below an edge of the histogram (1 when there are none). */
export function shareAtOrBelow(h: Histogram, edge: number): number {
  if (h.count === 0) return 1;
  const n = h.buckets.get(edge);
  if (n === undefined) throw new Error(`no bucket edge at ${String(edge)}`);
  return n / h.count;
}

/** Prometheus's `histogram_quantile`: linear inside the bucket holding the quantile (seconds). */
export function quantile(h: Histogram, q: number): number | null {
  if (h.count === 0) return null;
  const rank = q * h.count;
  let lower = 0;
  let below = 0;
  for (const [le, n] of h.buckets) {
    if (n >= rank) {
      if (le === Infinity) return lower;
      return lower + ((le - lower) * (rank - below)) / Math.max(1, n - below);
    }
    lower = le;
    below = n;
  }
  return lower;
}

export type Range = readonly [number, number];

/** The end of the first contiguous run of `ranges` (seen ∪ reported). */
export function settledThrough(ranges: readonly Range[]): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let settled: number | undefined;
  for (const [from, to] of sorted) {
    if (settled === undefined) settled = to;
    else if (from <= settled + 1) settled = Math.max(settled, to);
    else break;
  }
  return settled ?? 0;
}

/**
 * Count judge: the i-th thing the truth completed (wall time `truth[i]`) is shown once a page
 * sample with a count ≥ i + 1 arrived; its latency is that arrival minus the truth's (never below
 * 0). Things whose deadline lies past `until` are not judged.
 */
export function judgeCounts(
  truth: readonly number[],
  page: readonly { readonly at: number; readonly count: number }[],
  until: number,
  limitMs: number,
): { latencies: (number | undefined)[]; unjudged: number } {
  const latencies: (number | undefined)[] = [];
  let unjudged = 0;
  truth.forEach((at, i) => {
    if (at + limitMs > until) {
      unjudged++;
      return;
    }
    const shown = page.find((sample) => sample.count >= i + 1 && sample.at <= at + limitMs);
    latencies.push(shown === undefined ? undefined : Math.max(0, shown.at - at));
  });
  return { latencies, unjudged };
}
