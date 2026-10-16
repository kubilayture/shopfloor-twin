/**
 * Scheduled shifts and shift buckets from the shift calendar (#120, moved here from the MES's
 * `oee` module by #144). Pure: the MES's `oee` and `shifts` modules and the simulator's ground
 * truth call the same functions, so neither module imports the other.
 */
import {
  NO_SHIFT,
  shiftBoundaries,
  shiftSegments,
  type Millis,
  type ShiftPattern,
} from './index.ts';

export const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** One scheduled shift: `date/shift`, [start, end), with its breaks. */
export interface ScheduledShift {
  readonly key: string;
  readonly date: string;
  readonly shift: string;
  readonly start: Millis;
  readonly end: Millis;
  readonly breaks: readonly { readonly start: Millis; readonly end: Millis }[];
}

/** A shift bucket over a range: a whole scheduled shift, or a no-shift stretch clipped to it. */
export interface ShiftBucket {
  readonly key: string;
  readonly start: Millis;
  readonly end: Millis;
}

/** The start of the UTC hour `at` lies in. */
export const hourStart = (at: Millis): Millis => at - (((at % HOUR) + HOUR) % HOUR);

/** `at` itself on a whole hour, else the end of its hour. */
export const hourEnd = (at: Millis): Millis => {
  const start = hourStart(at);
  return start === at ? at : start + HOUR;
};

/**
 * The shift buckets overlapping [from, to): scheduled shifts whole (they may reach outside the
 * range), no-shift stretches clipped to the range's whole hours and keyed `no-shift`. Shifts
 * start and end on whole hours (plant-config), so every bucket is a run of whole UTC hours.
 */
export function shiftBuckets(pattern: ShiftPattern, from: Millis, to: Millis): ShiftBucket[] {
  const lo = hourStart(from);
  const hi = hourEnd(to);
  // A day around the range finds the true start and end of shifts the range cuts.
  return shiftSegments(pattern, lo - DAY, hi + DAY)
    .filter((segment) => segment.to > from && segment.from < to)
    .map((segment) =>
      segment.key === NO_SHIFT
        ? { key: NO_SHIFT, start: Math.max(segment.from, lo), end: Math.min(segment.to, hi) }
        : { key: segment.key, start: segment.from, end: segment.to },
    );
}

/** The scheduled shifts overlapping [from, to), with their breaks, by start. */
export function shiftInstances(pattern: ShiftPattern, from: Millis, to: Millis): ScheduledShift[] {
  const buckets = shiftBuckets(pattern, from, to).filter((bucket) => bucket.key !== NO_SHIFT);
  if (buckets.length === 0) return [];
  const first = buckets[0]?.start ?? from;
  const last = buckets.at(-1)?.end ?? to;
  const boundaries = shiftBoundaries(pattern, first, last);
  return buckets.map((bucket) => {
    const [date = '', shift = ''] = bucket.key.split('/');
    const breaks: { start: Millis; end: Millis }[] = [];
    for (const boundary of boundaries) {
      if (boundary.action !== 'break-start') continue;
      if (boundary.shiftDate !== date || boundary.shiftId !== shift) continue;
      const end = boundaries.find(
        (b) =>
          b.action === 'break-end' &&
          b.shiftDate === date &&
          b.shiftId === shift &&
          b.at > boundary.at,
      );
      breaks.push({ start: boundary.at, end: end?.at ?? bucket.end });
    }
    return { key: bucket.key, date, shift, start: bucket.start, end: bucket.end, breaks };
  });
}

/** The scheduled shift `date/shift`, or undefined when the calendar has no such shift. */
export function shiftInstance(
  pattern: ShiftPattern,
  date: string,
  shift: string,
): ScheduledShift | undefined {
  const noon = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(noon)) return undefined;
  return shiftInstances(pattern, noon - DAY, noon + 2 * DAY).find(
    (instance) => instance.date === date && instance.shift === shift,
  );
}

/** The scheduled shift after `instance` (the next one to start), within 8 days. */
export function nextShift(
  pattern: ShiftPattern,
  instance: Pick<ScheduledShift, 'end'>,
): ScheduledShift | undefined {
  return shiftInstances(pattern, instance.end, instance.end + 8 * DAY).find(
    (next) => next.start >= instance.end,
  );
}

/**
 * The key of a `no-shift` stretch starting at `from` (ADR-0024, the alarm KPI buckets): the last
 * shift end at or before it (within 7 days), so the key doesn't depend on where a range or run
 * cuts the stretch; `from` itself when no shift ended in the 7 days before.
 */
export function noShiftKey(pattern: ShiftPattern, from: Millis): string {
  const ends = shiftBoundaries(pattern, from - 7 * DAY, from + 1).filter(
    (boundary) => boundary.action === 'shift-end',
  );
  return `${NO_SHIFT}/${new Date(ends.at(-1)?.at ?? from).toISOString()}`;
}
