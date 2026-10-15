/**
 * Sets of sequence numbers as sorted, non-overlapping, non-adjacent ranges [from, to], the storage
 * form of ADR-0015's consumer rule (as in `Deduplicator`): memory grows with the number of holes,
 * not with the number of messages.
 */
export type Range = readonly [number, number];

export function contains(ranges: readonly Range[], seq: number): boolean {
  return ranges.some(([from, to]) => seq >= from && seq <= to);
}

/** A new range list with [from, to] added and neighbours merged. */
export function add(ranges: readonly Range[], from: number, to: number = from): Range[] {
  const sorted = [...ranges, [from, to] as const].sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = result.at(-1);
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      result.push([start, end]);
    }
  }
  return result;
}

export function union(a: readonly Range[], b: readonly Range[]): Range[] {
  return b.reduce<Range[]>((acc, [from, to]) => add(acc, from, to), [...a]);
}

/** The holes between the ranges: numbers before the first one or after the last are not holes. */
export function holes(ranges: readonly Range[]): Range[] {
  const result: Range[] = [];
  for (let i = 0; i < ranges.length - 1; i++) {
    const before = ranges[i];
    const after = ranges[i + 1];
    if (before && after) result.push([before[1] + 1, after[0] - 1]);
  }
  return result;
}

/** How many numbers of [from, to] are not in `ranges`. */
export function missing(ranges: readonly Range[], from: number, to: number): number {
  let covered = 0;
  for (const [start, end] of ranges) {
    const lo = Math.max(start, from);
    const hi = Math.min(end, to);
    if (hi >= lo) covered += hi - lo + 1;
  }
  return to - from + 1 - covered;
}

export const overlaps = (a: Range, b: Range): boolean => a[0] <= b[1] && b[0] <= a[1];

/**
 * The highest number with no open hole at or below it (#113): the end of the first range of
 * `seen` and `reported` together, since a hole already reported holds nothing back any more.
 * Every epoch numbers from 1 (ADR-0015; a new epoch's sentinel 0 counts too), so a first range
 * starting above 1 leaves a hole below it: null then, and when nothing was seen.
 */
export function settledThrough(seen: readonly Range[], reported: readonly Range[]): number | null {
  const first = (reported.length === 0 ? seen : union(seen, reported))[0];
  return first && first[0] <= 1 ? first[1] : null;
}
