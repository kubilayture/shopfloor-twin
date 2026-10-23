/** Plant times are simulation time in UTC; people read them in the plant's zone (plan section 8). */
export const PLANT_TIME_ZONE = 'Europe/Istanbul';

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: PLANT_TIME_ZONE,
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const clockTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: PLANT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const clockSeconds = new Intl.DateTimeFormat('en-GB', {
  timeZone: PLANT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** `14:05:09` in plant time (what a time input with seconds takes back). */
export function formatClockSeconds(time: string | number): string {
  return clockSeconds.format(new Date(time));
}

export function formatPlantTime(time: string | number): string {
  return dateTime.format(new Date(time));
}

const plantDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLANT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The plant-zone calendar day of an instant, `2026-10-15`. */
export function plantDayOf(time: string | number): string {
  return plantDay.format(new Date(time));
}

/**
 * An event time relative to the plant clock (design system 6.2, A-01): the time only (`07:15:00`)
 * when it falls on the plant clock's current day in the plant zone, `Mon 12 Oct, 07:15:00` on any
 * other day or while there is no plant clock yet, so a days-old standing alarm never reads as this
 * morning's. Callers put the full `formatPlantTime` in the element's `title`.
 */
export function formatPlantTimeRelative(
  at: string | number,
  clock: string | number | undefined,
): string {
  if (clock !== undefined && plantDayOf(at) === plantDayOf(clock)) {
    return formatClockSeconds(at);
  }
  return formatPlantTime(at);
}

/**
 * An API time for people, in plant time as the header shows it (#295): `–` when there is none, the
 * text as it came when it is no time (never a thrown `RangeError` from a malformed event line).
 */
export function plantTimeText(time: string | undefined): string {
  if (time === undefined) return '–';
  return Number.isFinite(Date.parse(time)) ? formatPlantTime(time) : time;
}

/**
 * A wall-clock time (when the MES or a person did something, not the plant's simulated clock) in
 * the plant's zone, labelled so it is never read as plant time (#295): `Thu 22 Oct, 09:12:03 (wall
 * time)`. A demo's plant clock can run on another day than the wall clock.
 */
export function wallTimeText(time: string): string {
  return `${Number.isFinite(Date.parse(time)) ? formatPlantTime(time) : time} (wall time)`;
}

export function formatClockTime(time: string | number): string {
  return clockTime.format(new Date(time));
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** A duration for people: `12 s`, `4 min 05 s`, `2 h 05 min`, `3 d 4 h`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${String(days)} d ${String(hours % 24)} h`;
  if (hours > 0) return `${String(hours)} h ${pad(minutes % 60)} min`;
  if (minutes > 0) return `${String(minutes)} min ${pad(seconds % 60)} s`;
  return `${String(seconds)} s`;
}

export const RANGES = {
  '1h': { label: 'Last hour', ms: 3_600_000 },
  '8h': { label: 'Last 8 h', ms: 8 * 3_600_000 },
  '24h': { label: 'Last 24 h', ms: 24 * 3_600_000 },
} as const;

export type RangeKey = keyof typeof RANGES;

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === 'string' && Object.hasOwn(RANGES, value);
}
