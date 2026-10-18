/**
 * Line throughput OEE (ADR-0036, ADR-0021 option (c)): good packed units × the bottleneck's
 * effective cycle per product ÷ line planned busy time, per bucket (an hour, a shift) or per order.
 * One ratio, no A × P × Q split; not capped at 1, flagged `aboveOne` instead, so bucket sums agree
 * with their shift.
 */
import { add, compare, fraction, multiply, type Fraction } from './fraction.ts';
import type { Millis } from './intervals.ts';
import { intersect, measure, normalize, subtract, type Range } from './ranges.ts';

export interface LinePlannedBusyInput {
  /** The bucket (an hour or a shift), or an order's in-progress time for its per-order value. */
  readonly bucket: Range;
  /** The scheduled time: the shift buckets of the calendar. */
  readonly scheduled: readonly Range[];
  /** Planned stops: the calendar's breaks and the bottleneck's planned maintenance. */
  readonly plannedStops: readonly Range[];
  /**
   * Orders mode only: the time each order is in progress, from its first job's head time to its
   * completion (or the cut-off while open). Left out in schedule mode, where every scheduled
   * moment is planned.
   */
  readonly inProgress?: readonly Range[];
}

/**
 * Line planned busy time in ms: the bucket's scheduled time, minus planned stops, and in orders mode
 * only where at least one order is in progress (the line's counterpart of Idle `NO-ORDER`).
 */
export function linePlannedBusyMs(input: LinePlannedBusyInput): Millis {
  let planned = intersect(normalize([input.bucket]), input.scheduled);
  if (input.inProgress !== undefined) {
    planned = intersect(planned, input.inProgress);
  }
  return measure(subtract(planned, input.plannedStops));
}

export interface PackedCount {
  readonly product: string;
  /** Units packed good (OP50 `good` cycles) in the bucket, or of the order. */
  readonly count: number;
}

export interface LineOeeInput {
  readonly plannedBusyMs: Millis;
  readonly good: readonly PackedCount[];
  /** The bottleneck's effective cycle per product (`deriveBottlenecks`). */
  readonly effectiveCycleMs: Readonly<Record<string, Fraction>>;
}

export interface LineOeeResult {
  /** Σ good × effective cycle, in ms (a fraction when the bottleneck has parallel machines). */
  readonly idealMs: Fraction;
  readonly good: bigint;
  readonly plannedBusyMs: bigint;
  /** idealMs / plannedBusyMs, not capped; null when the planned busy time is 0. */
  readonly oee: Fraction | null;
  /** The value is above 1: faster than the bottleneck's ideal rate, or WIP drained into the bucket. */
  readonly aboveOne: boolean;
}

function count(value: number, what: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${String(value)}`);
  }
  return BigInt(value);
}

export function lineOee(input: LineOeeInput): LineOeeResult {
  const pbt = count(input.plannedBusyMs, 'line planned busy time');
  let idealMs = fraction(0n);
  let good = 0n;
  for (const packed of input.good) {
    const n = count(packed.count, `${packed.product} good packed`);
    const cycle = input.effectiveCycleMs[packed.product];
    if (cycle === undefined) {
      throw new RangeError(`no bottleneck cycle for ${packed.product}`);
    }
    idealMs = add(idealMs, multiply(fraction(n), cycle));
    good += n;
  }
  const oee = pbt > 0n ? multiply(idealMs, fraction(1n, pbt)) : null;
  return {
    idealMs,
    good,
    plannedBusyMs: pbt,
    oee,
    aboveOne: oee !== null && compare(oee, fraction(1n)) > 0,
  };
}
