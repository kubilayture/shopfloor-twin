/**
 * Alarm KPI buckets (ADR-0024 "Shift bucket keys", binding since #140): UTC hours, shift instances
 * keyed `2026-10-12/A`, and `no-shift` stretches, each its own contiguous bucket keyed
 * `no-shift/{start}` with the stretch's start by the calendar (standing and active-at-end are taken
 * at a bucket's end, so a bucket must be contiguous; the OEE buckets differ on purpose and collect
 * every gap in one plain `no-shift`).
 */
import { HOUR, type Millis } from '@shopfloor/alarm-core';
import {
  NO_SHIFT,
  hourEnd,
  hourStart,
  noShiftKey,
  shiftSegments,
  type ShiftPattern,
} from '@shopfloor/shift-calendar';

const DAY = 24 * HOUR;

// The hour helpers and the `no-shift/{start}` key live in the pure shift calendar (#144), shared
// with the simulator's ground truth.
export { hourEnd, hourStart, noShiftKey };

export interface AlarmBucket {
  /** The hour start (ISO 8601) or the shift bucket key. */
  readonly key: string;
  readonly from: Millis;
  readonly to: Millis;
}

/**
 * The shift buckets overlapping [from, to): scheduled shifts whole; `no-shift` stretches clipped
 * to the range's whole hours (as the ground truth clips them to its run) and keyed by their start
 * by the calendar.
 */
export function alarmShiftBuckets(pattern: ShiftPattern, from: Millis, to: Millis): AlarmBucket[] {
  const lo = hourStart(from);
  const hi = hourEnd(to);
  return shiftSegments(pattern, lo - DAY, hi + DAY)
    .filter((segment) => segment.to > from && segment.from < to)
    .map((segment) =>
      segment.key === NO_SHIFT
        ? {
            key: noShiftKey(pattern, segment.from),
            from: Math.max(segment.from, lo),
            to: Math.min(segment.to, hi),
          }
        : { key: segment.key, from: segment.from, to: segment.to },
    );
}

/** The UTC hours overlapping [from, to). */
export function alarmHourBuckets(from: Millis, to: Millis): AlarmBucket[] {
  const buckets: AlarmBucket[] = [];
  for (let hour = hourStart(from); hour < to; hour += HOUR) {
    buckets.push({ key: new Date(hour).toISOString(), from: hour, to: hour + HOUR });
  }
  return buckets;
}
