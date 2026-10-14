import type { PlantConfig } from '@shopfloor/plant-config';
import type { SimTime } from '@shopfloor/sim-core';

export type CalendarAction = 'shift-start' | 'shift-end' | 'break-start' | 'break-end';

export interface CalendarBoundary {
  readonly at: SimTime;
  readonly action: CalendarAction;
  readonly shiftId: string;
  readonly shiftDate: string;
}

type ShiftsConfig = PlantConfig['shifts'];

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const ORDER: Record<CalendarAction, number> = {
  'shift-end': 0,
  'break-end': 1,
  'shift-start': 2,
  'break-start': 3,
};

function at(date: Temporal.PlainDate, time: string, start: string, timeZone: string): SimTime {
  const day = time < start ? date.add({ days: 1 }) : date;
  return day.toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(time) })
    .epochMilliseconds;
}

function endAt(date: Temporal.PlainDate, end: string, start: string, timeZone: string): SimTime {
  const day = end <= start ? date.add({ days: 1 }) : date;
  return day.toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(end) })
    .epochMilliseconds;
}

export function shiftBoundaries(
  shifts: ShiftsConfig,
  from: SimTime,
  to: SimTime,
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
    if (
      !shifts.workdays.includes(WEEKDAYS[date.dayOfWeek - 1] as ShiftsConfig['workdays'][number])
    ) {
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

export function shiftAt(shifts: ShiftsConfig, time: SimTime): ShiftInstance | undefined {
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
