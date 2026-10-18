/**
 * Half-open time ranges [from, to) in integer ms, and the set arithmetic order and line OEE need
 * (ADR-0036): union, intersection, difference and length. Integers only.
 */
import type { Millis } from './intervals.ts';

export interface Range {
  readonly from: Millis;
  readonly to: Millis;
}

function check(range: Range): void {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)) {
    throw new RangeError(
      `a range needs integer ms, got [${String(range.from)}, ${String(range.to)})`,
    );
  }
  if (range.to < range.from) {
    throw new RangeError(
      `a range ends before it starts: [${String(range.from)}, ${String(range.to)})`,
    );
  }
}

/** Sorted, disjoint, non-empty ranges covering the same time; touching ranges are merged. */
export function normalize(ranges: readonly Range[]): Range[] {
  ranges.forEach(check);
  const sorted = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: { from: Millis; to: Millis }[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.from <= last.to) {
      if (range.to > last.to) last.to = range.to;
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

/** The time in both sets. */
export function intersect(a: readonly Range[], b: readonly Range[]): Range[] {
  const left = normalize(a);
  const right = normalize(b);
  const result: Range[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const x = left[i];
    const y = right[j];
    if (x === undefined || y === undefined) break;
    const from = x.from > y.from ? x.from : y.from;
    const to = x.to < y.to ? x.to : y.to;
    if (to > from) result.push({ from, to });
    if (x.to < y.to) i += 1;
    else j += 1;
  }
  return result;
}

/** The time in `a` and not in `b`. */
export function subtract(a: readonly Range[], b: readonly Range[]): Range[] {
  const cuts = normalize(b);
  const result: Range[] = [];
  for (const range of normalize(a)) {
    let from = range.from;
    for (const cut of cuts) {
      if (cut.to <= from || cut.from >= range.to) continue;
      if (cut.from > from) result.push({ from, to: cut.from });
      from = cut.to > from ? cut.to : from;
    }
    if (from < range.to) result.push({ from, to: range.to });
  }
  return result;
}

/** The total length of a set of ranges, overlaps counted once. */
export const measure = (ranges: readonly Range[]): Millis =>
  normalize(ranges).reduce((sum, range) => sum + range.to - range.from, 0);
