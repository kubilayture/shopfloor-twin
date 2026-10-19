/**
 * Subgroups, control limits estimated from a window, and capability (ADR-0032).
 *
 * I-MR: centre X̄, limits X̄ ± 2.66·M̄R; MR chart centre M̄R, upper 3.267·M̄R, lower 0.
 * X̄-R on consecutive subgroups: centre X̿, limits X̿ ± A2·R̄; R chart centre R̄, limits D3·R̄ and
 * D4·R̄. Everything is an exact fraction of whole reading steps.
 */
import { compare, fraction, multiply, type Fraction } from '@shopfloor/oee-core';
import { E2, MR_D4, subgroupConstants } from './constants.ts';
import { add, divide, integer, mean, subtract, ZERO } from './rational.ts';
import { segments, within, type Position, type Reading } from './readings.ts';

export const CHARTS = ['I', 'MR', 'Xbar', 'R'] as const;
export type ChartName = (typeof CHARTS)[number];

export interface Limits {
  readonly lower: Fraction;
  readonly centre: Fraction;
  readonly upper: Fraction;
}

/** Consecutive first-pass readings of one segment, `size` of them. */
export interface Subgroup {
  /** The key of its last reading: the reading that completes it. */
  readonly key: string;
  /** The position of its last reading. */
  readonly position: Position;
  readonly readings: readonly Reading[];
  readonly mean: Fraction;
  readonly range: number;
}

export interface Subgroups {
  readonly complete: readonly Subgroup[];
  /** The last segment's readings that don't fill a subgroup yet. */
  readonly pending: readonly Reading[];
  /** Earlier segments' trailing readings that can never fill one (a subgroup never spans epochs). */
  readonly dropped: readonly Reading[];
}

/**
 * Cuts ordered first-pass readings into subgroups of `size`, from the start of each segment.
 */
export function subgroupsOf(ordered: readonly Reading[], size: number): Subgroups {
  subgroupConstants(size);
  const complete: Subgroup[] = [];
  const parts = segments(ordered);
  let tail: Reading[] = [];
  const dropped: Reading[] = [];
  parts.forEach((segment, index) => {
    tail = [];
    for (const reading of segment) {
      tail.push(reading);
      if (tail.length === size) {
        complete.push(subgroup(tail));
        tail = [];
      }
    }
    if (index < parts.length - 1) dropped.push(...tail);
  });
  return { complete, pending: tail, dropped };
}

/** One subgroup of consecutive readings of one segment (internal to `spc-core`). */
export function subgroup(readings: readonly Reading[]): Subgroup {
  const values = readings.map((r) => r.value);
  const last = readings.at(-1);
  if (last === undefined) {
    throw new RangeError('empty subgroup');
  }
  const high = values.reduce((a, b) => (b > a ? b : a));
  const low = values.reduce((a, b) => (b < a ? b : a));
  return {
    key: last.key,
    position: { epoch: last.epoch, at: last.at, seq: last.seq },
    readings: [...readings],
    // The mean of whole steps: their sum over the count, reduced (the same fraction as the mean of
    // the values as fractions, with one reduction instead of one per value).
    mean: fraction(
      values.reduce((sum, v) => sum + BigInt(v), 0n),
      BigInt(values.length),
    ),
    range: high - low,
  };
}

const distance = (a: number, b: number): number => (a > b ? a - b : b - a);

/** Moving ranges of ordered readings, within segments: |xᵢ − xᵢ₋₁|, keyed by the later reading. */
export function movingRanges(ordered: readonly Reading[]): { key: string; value: number }[] {
  return segments(ordered).flatMap((segment) =>
    segment.slice(1).map((reading, i) => ({
      key: reading.key,
      value: distance(reading.value, segment[i]?.value ?? reading.value),
    })),
  );
}

export interface Window {
  readonly from: Position;
  readonly to: Position;
}

export interface ChartLimits {
  readonly subgroupSize: number;
  readonly window: Window;
  /** Readings, moving ranges and complete subgroups the estimate rests on. */
  readonly counts: {
    readonly readings: number;
    readonly movingRanges: number;
    readonly subgroups: number;
  };
  /** X̄, M̄R, X̿ and R̄ of the window. */
  readonly statistics: {
    readonly mean: Fraction;
    readonly movingRange: Fraction;
    readonly grandMean: Fraction;
    readonly range: Fraction;
  };
  readonly charts: Readonly<Record<ChartName, Limits>>;
}

/**
 * Control limits from the first-pass readings inside `window` (both ends inclusive): the I-MR
 * chart from every reading in it and the moving ranges between consecutive ones of a segment, the
 * X̄-R chart from the series' complete subgroups that lie wholly inside it. Throws when the window
 * holds no moving range or no complete subgroup.
 */
export function estimateLimits(
  ordered: readonly Reading[],
  window: Window,
  subgroupSize: number,
): ChartLimits {
  const constants = subgroupConstants(subgroupSize);
  const inside = ordered.filter((reading) => within(reading, window.from, window.to));
  const ranges = movingRanges(inside);
  const groups = subgroupsOf(ordered, subgroupSize).complete.filter((g) =>
    g.readings.every((reading) => within(reading, window.from, window.to)),
  );
  if (ranges.length === 0 || groups.length === 0) {
    throw new RangeError(
      `the window holds ${String(ranges.length)} moving ranges and ${String(groups.length)} complete subgroups; at least one of each is needed`,
    );
  }
  const xBar = mean(inside.map((r) => integer(r.value)));
  const mrBar = mean(ranges.map((r) => integer(r.value)));
  const xBarBar = mean(groups.map((g) => g.mean));
  const rBar = mean(groups.map((g) => integer(g.range)));
  const iSpread = multiply(E2, mrBar);
  const xSpread = multiply(constants.a2, rBar);
  return {
    subgroupSize,
    window,
    counts: { readings: inside.length, movingRanges: ranges.length, subgroups: groups.length },
    statistics: { mean: xBar, movingRange: mrBar, grandMean: xBarBar, range: rBar },
    charts: {
      I: { lower: subtract(xBar, iSpread), centre: xBar, upper: add(xBar, iSpread) },
      MR: { lower: ZERO, centre: mrBar, upper: multiply(MR_D4, mrBar) },
      Xbar: { lower: subtract(xBarBar, xSpread), centre: xBarBar, upper: add(xBarBar, xSpread) },
      R: {
        lower: multiply(constants.d3, rBar),
        centre: rBar,
        upper: multiply(constants.d4, rBar),
      },
    },
  };
}

/**
 * The baseline window: from the first reading of the first complete subgroup to the last reading
 * of the `count`-th, or `null` while fewer than `count` subgroups are complete.
 */
export function baselineWindow(
  ordered: readonly Reading[],
  subgroupSize: number,
  count: number,
): Window | null {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`a baseline needs at least one subgroup, got ${String(count)}`);
  }
  const groups = subgroupsOf(ordered, subgroupSize).complete;
  const first = groups[0]?.readings[0];
  const last = groups[count - 1];
  if (first === undefined || last === undefined) return null;
  return { from: { epoch: first.epoch, at: first.at, seq: first.seq }, to: last.position };
}

export interface Capability {
  /** σ̂ = R̄ / d2, the within-subgroup standard deviation, in steps. */
  readonly sigma: Fraction;
  /** (USL − X̿) / 3σ̂. */
  readonly cpu: Fraction;
  /** min(Cpu, Cpl); the specification is one-sided (an upper limit only), so Cpk = Cpu. */
  readonly cpk: Fraction;
}

/**
 * Cpu and Cpk of a limit version against an upper specification limit (in steps). `null` when
 * R̄ = 0, which leaves σ̂ = 0 and the indices undefined. Shown, not reconciled (plan "SPC").
 */
export function capability(limits: ChartLimits, upperSpec: Fraction): Capability | null {
  const { d2 } = subgroupConstants(limits.subgroupSize);
  if (compare(limits.statistics.range, ZERO) === 0) return null;
  const sigma = divide(limits.statistics.range, d2);
  const cpu = divide(subtract(upperSpec, limits.statistics.grandMean), multiply(integer(3), sigma));
  return { sigma, cpu, cpk: cpu };
}
