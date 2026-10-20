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

/** One sample of the drain sampler: wall ms and the MES's counters. */
export interface DrainSample {
  readonly at: number;
  readonly stored: number;
  readonly handled: number;
  readonly subscribed: number;
}

/**
 * T2's drain rate (#245 review, finding 2): the slope of the stored count between consecutive
 * samples (Δstored ÷ Δt of the same two samples), over the steady drain: from the first sample
 * after the subscription where the count rose to the last sample before the catch-up, without the
 * first and the last second (the ramp and the tail). The median slope is the rate; the mean (the
 * count's growth over the steady span) is reported beside it.
 */
export function drainRate(
  series: readonly DrainSample[],
  caughtUpAt: number | undefined,
): {
  median: number | undefined;
  mean: number | undefined;
  subscribedAt: number | undefined;
  reason: string;
  report: {
    messagesDrained: number | null;
    messagesHandled: number | null;
    drainMs: number | null;
    steadyMs: number | null;
    slopes: number;
    medianPerSecond: number | null;
    meanPerSecond: number | null;
  };
} {
  const empty = (reason: string, subscribedAt?: number) => ({
    median: undefined,
    mean: undefined,
    subscribedAt,
    reason,
    report: {
      messagesDrained: null,
      messagesHandled: null,
      drainMs: null,
      steadyMs: null,
      slopes: 0,
      medianPerSecond: null,
      meanPerSecond: null,
    },
  });
  const subscribed = series.findIndex((x) => x.subscribed === 1);
  const subscribedAt = series[subscribed]?.at;
  if (subscribed < 0) return empty('the session never subscribed');
  if (caughtUpAt === undefined) return empty('no catch-up', subscribedAt);
  let first = subscribed;
  while (
    first + 1 < series.length &&
    (series[first + 1]?.stored ?? 0) <= (series[first]?.stored ?? 0)
  ) {
    first++;
  }
  let last = series.length - 1;
  while (last > first && (series[last]?.at ?? Infinity) > caughtUpAt) last--;
  const begin = series[first];
  const end = series[last];
  if (!begin || !end || last <= first) return empty('no sample inside the drain', subscribedAt);
  const steady = series
    .slice(first, last + 1)
    .filter((x) => x.at >= begin.at + 1_000 && x.at <= end.at - 1_000);
  const slopes: number[] = [];
  for (let i = 1; i < steady.length; i++) {
    const a = steady[i - 1];
    const b = steady[i];
    if (a && b && b.at > a.at) slopes.push((b.stored - a.stored) / ((b.at - a.at) / 1000));
  }
  const sorted = [...slopes].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? undefined
      : sorted.length % 2 === 1
        ? sorted[mid]
        : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  const s0 = steady[0];
  const s1 = steady.at(-1);
  const mean =
    s0 && s1 && s1.at > s0.at ? (s1.stored - s0.stored) / ((s1.at - s0.at) / 1000) : undefined;
  const r = (v: number | undefined) => (v === undefined ? null : Math.round(v * 10) / 10);
  return {
    median,
    mean,
    subscribedAt,
    reason: median === undefined ? 'the drain was shorter than its ramp and tail' : '',
    report: {
      messagesDrained: end.stored - (series[subscribed]?.stored ?? 0),
      messagesHandled: end.handled - (series[subscribed]?.handled ?? 0),
      drainMs: end.at - begin.at,
      steadyMs: s0 && s1 ? s1.at - s0.at : null,
      slopes: slopes.length,
      medianPerSecond: r(median),
      meanPerSecond: r(mean),
    },
  };
}

/** The long-running services of a live run (P1), each must be running at the end. */
export const LONG_RUNNING = [
  'db',
  'broker',
  'simulator',
  'gateway',
  'mes',
  'erp',
  'web',
  'prometheus',
];
export const ONE_SHOTS = ['pki', 'migrate'];

export interface ContainerState {
  readonly service: string;
  readonly id: string;
  readonly state: string;
  readonly exitCode: number;
  readonly oomKilled: boolean;
  readonly restartCount: number;
}

/** What is wrong with the containers: a long-running one missing or not running, a one-shot not exited 0. */
export function lifecycleProblems(all: readonly ContainerState[]): string[] {
  const problems: string[] = [];
  for (const service of LONG_RUNNING) {
    const found = all.filter((c) => c.service === service);
    if (found.length !== 1) problems.push(`${service}: ${String(found.length)} containers`);
    for (const c of found) {
      if (c.state !== 'running')
        problems.push(`${service} ${c.state} (exit ${String(c.exitCode)})`);
    }
  }
  for (const service of ONE_SHOTS) {
    for (const c of all.filter((x) => x.service === service)) {
      if (c.state !== 'exited' || c.exitCode !== 0) {
        problems.push(`${service} ${c.state} (exit ${String(c.exitCode)})`);
      }
    }
  }
  for (const c of all) {
    if (c.oomKilled) problems.push(`${c.service} OOM-killed`);
    if (c.restartCount > 0) problems.push(`${c.service} restarted ${String(c.restartCount)} times`);
  }
  return problems;
}
