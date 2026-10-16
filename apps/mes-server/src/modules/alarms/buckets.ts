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
  shiftBoundaries,
  shiftSegments,
  type ShiftPattern,
} from '@shopfloor/shift-calendar';

const DAY = 24 * HOUR;

export const hourStart = (at: Millis): Millis => at - (((at % HOUR) + HOUR) % HOUR);
export const hourEnd = (at: Millis): Millis => {
  const start = hourStart(at);
  return start === at ? at : start + HOUR;
};

export interface AlarmBucket {
  /** The hour start (ISO 8601) or the shift bucket key. */
  readonly key: string;
  readonly from: Millis;
  readonly to: Millis;
}

/**
 * The key of a `no-shift` stretch starting at `from`: the last shift end at or before it (within
 * 7 days), so the key doesn't depend on where a range or run cuts the stretch; `from` itself when
 * no shift ended in the 7 days before. The simulator's ground truth keys it the same way.
 */
export function noShiftKey(pattern: ShiftPattern, from: Millis): string {
  const ends = shiftBoundaries(pattern, from - 7 * DAY, from + 1).filter(
    (boundary) => boundary.action === 'shift-end',
  );
  return `${NO_SHIFT}/${new Date(ends.at(-1)?.at ?? from).toISOString()}`;
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
