/**
 * The plant's shift calendar (Temporal, any IANA time zone). Pure and shared: the simulator runs
 * its shifts with it and the MES cuts its intervals with it, so both agree by construction.
 */

/** Milliseconds since 1970 UTC. */
export type Millis = number;

export const WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** Structurally the same as `config/plant/shifts.yaml` (plant-config's `shifts`). */
export interface ShiftPattern {
  readonly timeZone: string;
  readonly workdays: readonly Weekday[];
  readonly shifts: readonly {
    readonly id: string;
    /** Local clock time, HH:MM. */
    readonly start: string;
    readonly end: string;
    readonly break?: { readonly start: string; readonly minutes: number } | undefined;
  }[];
}

export type CalendarAction = 'shift-start' | 'shift-end' | 'break-start' | 'break-end';

export interface CalendarBoundary {
  readonly at: Millis;
  readonly action: CalendarAction;
  readonly shiftId: string;
  readonly shiftDate: string;
}

const ORDER: Record<CalendarAction, number> = {
  'shift-end': 0,
  'break-end': 1,
  'shift-start': 2,
  'break-start': 3,
};

function at(date: Temporal.PlainDate, time: string, start: string, timeZone: string): Millis {
  const day = time < start ? date.add({ days: 1 }) : date;
  return day.toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(time) })
    .epochMilliseconds;
}

function endAt(date: Temporal.PlainDate, end: string, start: string, timeZone: string): Millis {
  const day = end <= start ? date.add({ days: 1 }) : date;
  return day.toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(end) })
    .epochMilliseconds;
}

export function shiftBoundaries(
  shifts: ShiftPattern,
  from: Millis,
  to: Millis,
): CalendarBoundary[] {
  const zone = shifts.timeZone;
  const first = Temporal.Instant.fromEpochMilliseconds(from).toZonedDateTimeISO(zone).toPlainDate();
  const last = Temporal.Instant.fromEpochMilliseconds(to).toZonedDateTimeISO(zone).toPlainDate();
  const raw: CalendarBoundary[] = [];
  for (
    let date = first.subtract({ days: 1 });
    Temporal.PlainDate.compare(date, last) <= 0;
    date = date.add({ days: 1 })
  ) {
    const weekday = WEEKDAYS[date.dayOfWeek - 1];
    if (weekday === undefined || !shifts.workdays.includes(weekday)) {
      continue;
    }
    const shiftDate = date.toString();
    for (const shift of shifts.shifts) {
      const start = date.toZonedDateTime({
        timeZone: zone,
        plainTime: Temporal.PlainTime.from(shift.start),
      }).epochMilliseconds;
      const common = { shiftId: shift.id, shiftDate };
      raw.push(
        { at: start, action: 'shift-start', ...common },
        { at: endAt(date, shift.end, shift.start, zone), action: 'shift-end', ...common },
      );
      if (shift.break) {
        const breakStart = at(date, shift.break.start, shift.start, zone);
        raw.push(
          { at: breakStart, action: 'break-start', ...common },
          { at: breakStart + shift.break.minutes * 60_000, action: 'break-end', ...common },
        );
      }
    }
  }
  const handovers = new Set(raw.filter((b) => b.action === 'shift-start').map((b) => b.at));
  return raw
    .filter((b) => !(b.action === 'shift-end' && handovers.has(b.at)))
    .filter((b) => b.at >= from && b.at < to)
    .sort((a, b) => a.at - b.at || ORDER[a.action] - ORDER[b.action]);
}

export interface ShiftInstance {
  readonly shiftId: string;
  readonly shiftDate: string;
  readonly inBreak: boolean;
}

export function shiftAt(shifts: ShiftPattern, time: Millis): ShiftInstance | undefined {
  const day = 24 * 3_600_000;
  let current: ShiftInstance | undefined;
  for (const boundary of shiftBoundaries(shifts, time - 2 * day, time + 1)) {
    if (boundary.action === 'shift-start') {
      current = { shiftId: boundary.shiftId, shiftDate: boundary.shiftDate, inBreak: false };
    } else if (boundary.action === 'shift-end') {
      current = undefined;
    } else if (current) {
      current = { ...current, inBreak: boundary.action === 'break-start' };
    }
  }
  return current;
}

/** The bucket a moment belongs to, as the ground truth keys it: `2026-10-13/B`, or `no-shift`. */
export const NO_SHIFT = 'no-shift';

export function shiftKeyAt(shifts: ShiftPattern, time: Millis): string {
  const instance = shiftAt(shifts, time);
  return instance ? `${instance.shiftDate}/${instance.shiftId}` : NO_SHIFT;
}

/** Instants in [from, to) where the shift bucket changes (shift starts and ends; breaks don't). */
export function shiftCuts(shifts: ShiftPattern, from: Millis, to: Millis): Millis[] {
  return [
    ...new Set(
      shiftBoundaries(shifts, from, to)
        .filter((b) => b.action === 'shift-start' || b.action === 'shift-end')
        .map((b) => b.at),
    ),
  ];
}

/** A stretch of time in one shift bucket: [from, to), keyed like `shiftKeyAt`. */
export interface ShiftSegment {
  readonly from: Millis;
  readonly to: Millis;
  readonly key: string;
}

/**
 * The shift buckets covering [from, to), in order: contiguous, never empty, and adjacent ones have
 * different keys. One calendar walk for the whole range, so cutting many pieces costs one call
 * rather than one `shiftKeyAt` (a few tens of microseconds) per piece.
 */
export function shiftSegments(shifts: ShiftPattern, from: Millis, to: Millis): ShiftSegment[] {
  if (to <= from) return [];
  const segments: ShiftSegment[] = [];
  let start = from;
  let key = shiftKeyAt(shifts, from);
  // Boundaries at `from` itself are already part of `shiftKeyAt(from)`.
  for (const boundary of shiftBoundaries(shifts, from + 1, to)) {
    if (boundary.action !== 'shift-start' && boundary.action !== 'shift-end') continue;
    const next =
      boundary.action === 'shift-start' ? `${boundary.shiftDate}/${boundary.shiftId}` : NO_SHIFT;
    if (next === key) continue;
    if (boundary.at > start) segments.push({ from: start, to: boundary.at, key });
    start = boundary.at;
    key = next;
  }
  segments.push({ from: start, to, key });
  return segments;
}

export {
  HOUR,
  hourEnd,
  hourStart,
  nextShift,
  noShiftKey,
  shiftBuckets,
  shiftInstance,
  shiftInstances,
} from './instances.ts';
export type { ScheduledShift, ShiftBucket } from './instances.ts';
