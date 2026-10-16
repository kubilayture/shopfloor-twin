import { HOUR, hourCuts, intervalsFromFacts, splitAt, type Millis } from '@shopfloor/oee-core';
import { shiftSegments, type ShiftPattern } from '@shopfloor/shift-calendar';

/** A state fact or the anchor, in `seq` order: where an interval starts. */
export interface Point {
  readonly at: Millis;
  readonly state: string;
  readonly cause: string | null;
  /** The fact's `seq`; null for the anchor. */
  readonly seq: number | null;
}

/** One stored piece of an interval: inside one UTC hour and one shift bucket. */
export interface Piece {
  readonly from: Millis;
  readonly to: Millis;
  readonly state: string;
  readonly cause: string | null;
  readonly hour: Millis;
  readonly shiftKey: string;
  readonly provisional: boolean;
  readonly intervalStart: Millis;
  readonly startSeq: number | null;
}

/**
 * Makes times non-decreasing in `seq` order: a fact earlier than the one before it (a device clock
 * that went back within an epoch) is moved up to that time, so its predecessor's interval becomes
 * zero-length and is dropped. Returns whether any time was moved.
 */
export function clamp(points: readonly Point[]): { points: Point[]; clamped: boolean } {
  let clamped = false;
  let latest = -Infinity;
  const result = points.map((point) => {
    if (point.at >= latest) {
      latest = point.at;
      return point;
    }
    clamped = true;
    return { ...point, at: latest };
  });
  return { points: result, clamped };
}

/** True when the times never go back in `seq` order. */
export const monotonic = (points: readonly Point[]): boolean =>
  points.every((point, i) => i === 0 || point.at >= (points[i - 1]?.at ?? point.at));

/**
 * Intervals from consecutive points (times non-decreasing), cut at every UTC hour and shift
 * boundary. Each point lasts until the next; the last one until `end`. A piece is `provisional`
 * when it ends after `finalThrough`, the time up to which nothing that can still arrive may change
 * it (#113; Infinity for a closed epoch). Zero-length intervals are dropped, as in the simulator's
 * ground truth. Shift buckets come from one calendar walk over the whole range.
 */
export function cutPieces(
  points: readonly Point[],
  end: Millis,
  pattern: ShiftPattern,
  finalThrough: Millis,
): Piece[] {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return [];
  // Same-millisecond points: the interval at that time belongs to the last of them by seq.
  const seqAt = new Map(points.map((p) => [p.at, p.seq]));
  const intervals = intervalsFromFacts(points, Math.max(end, last.at));
  const segments = shiftSegments(pattern, first.at, Math.max(end, last.at));
  const pieces: Piece[] = [];
  let s = 0;
  for (const interval of intervals) {
    const segmentCuts: Millis[] = [];
    for (let k = s; k < segments.length; k++) {
      const segment = segments[k];
      if (!segment || segment.from >= interval.to) break;
      if (segment.from > interval.from) segmentCuts.push(segment.from);
    }
    for (const part of splitAt(interval, [
      ...hourCuts(interval.from, interval.to),
      ...segmentCuts,
    ])) {
      while ((segments[s]?.to ?? Infinity) <= part.from) s++;
      const segment = segments[s];
      if (!segment) throw new RangeError(`no shift segment for ${String(part.from)}`);
      pieces.push({
        from: part.from,
        to: part.to,
        state: part.state,
        cause: part.cause,
        hour: Math.floor(part.from / HOUR) * HOUR,
        shiftKey: segment.key,
        provisional: part.to > finalThrough,
        intervalStart: interval.from,
        startSeq: seqAt.get(interval.from) ?? null,
      });
    }
  }
  return pieces;
}
