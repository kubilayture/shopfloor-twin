/**
 * Pure state accounting (plan section 8: `oee-core` has no I/O). Intervals are half-open,
 * [from, to), in integer milliseconds of device (simulation) time.
 */

export type Millis = number;

export const HOUR: Millis = 3_600_000;

/** One state change of one piece of equipment, as the device reported it. */
export interface StateFact<S extends string = string> {
  readonly at: Millis;
  readonly state: S;
  readonly cause: string | null;
}

export interface StateInterval<S extends string = string> {
  readonly from: Millis;
  readonly to: Millis;
  readonly state: S;
  readonly cause: string | null;
}

/**
 * Consecutive facts (in device order) become intervals: each state lasts until the next fact, the
 * last one until `end`. Zero-length intervals are dropped. Facts must not go back in time.
 */
export function intervalsFromFacts<S extends string>(
  facts: readonly StateFact<S>[],
  end: Millis,
): StateInterval<S>[] {
  const intervals: StateInterval<S>[] = [];
  for (const [i, fact] of facts.entries()) {
    const next = facts[i + 1];
    const to = next ? next.at : end;
    if (to < fact.at) {
      throw new RangeError(`facts go back in time: ${String(fact.at)} then ${String(to)}`);
    }
    if (to > fact.at) {
      intervals.push({ from: fact.at, to, state: fact.state, cause: fact.cause });
    }
  }
  return intervals;
}

/** Splits an interval at every cut strictly inside it. Cuts need not be sorted or unique. */
export function splitAt<S extends string>(
  interval: StateInterval<S>,
  cuts: readonly Millis[],
): StateInterval<S>[] {
  const inside = [...new Set(cuts)]
    .filter((cut) => cut > interval.from && cut < interval.to)
    .sort((a, b) => a - b);
  const bounds = [interval.from, ...inside, interval.to];
  return bounds
    .slice(0, -1)
    .map((from, i) => ({ ...interval, from, to: bounds[i + 1] ?? interval.to }));
}

/** The UTC hour boundaries strictly inside (from, to). */
export function hourCuts(from: Millis, to: Millis): Millis[] {
  const cuts: Millis[] = [];
  // The first hour boundary after `from` (never `from` itself, even when it is on the hour).
  // A floored remainder, in integers only (ADR-0021: no floating point in oee-core).
  const intoHour = ((from % HOUR) + HOUR) % HOUR;
  for (let cut = from - intoHour + HOUR; cut < to; cut += HOUR) {
    cuts.push(cut);
  }
  return cuts;
}

/** Time per state over a set of intervals. */
export function totalsByState<S extends string>(
  intervals: readonly StateInterval<S>[],
): Map<S, Millis> {
  const totals = new Map<S, Millis>();
  for (const interval of intervals) {
    totals.set(interval.state, (totals.get(interval.state) ?? 0) + interval.to - interval.from);
  }
  return totals;
}
