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

const dateTimeMinutes = new Intl.DateTimeFormat('en-GB', {
  timeZone: PLANT_TIME_ZONE,
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A planning time without seconds (design system 6.2: due, planned start): `Mon 12 Oct, 22:00`. */
export function formatPlantTimeMinutes(time: string | number): string {
  return dateTimeMinutes.format(new Date(time));
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

/**
 * A duration for people, by one rule (design system 6.1, G-17): under a minute `45 s`; under an
 * hour `12 min`, or `12 min 05 s` with `seconds` (only where it ticks live: time in state, a
 * running pause); under a day `4 h 54 min`; from a day `2 d 12 h`. Whole units, rounded down, so
 * a live figure never runs ahead; a negative one (clock skew) is `0 s`. Loss totals that reconcile
 * stay `minutesText` (one decimal).
 */
export function durationText(ms: number, { seconds = false }: { seconds?: boolean } = {}): string {
  // No finite number: the dash of `domain/numbers.ts` (`Duration` shows `Missing` instead).
  if (!Number.isFinite(ms)) return '–';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${String(days)} d ${String(hours % 24)} h`;
  if (hours > 0) return `${String(hours)} h ${pad(minutes % 60)} min`;
  if (minutes > 0) {
    return seconds
      ? `${String(minutes)} min ${pad(totalSeconds % 60)} s`
      : `${String(minutes)} min`;
  }
  return `${String(totalSeconds)} s`;
}

/** A live duration with its seconds under an hour: `12 s`, `4 min 05 s`, `2 h 05 min`, `3 d 4 h`. */
export function formatDuration(ms: number): string {
  return durationText(ms, { seconds: true });
}

/** `PT4H54M5S`: a duration for `<time dateTime>` (whole seconds, rounded down). */
export function isoDuration(ms: number): string {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const rest = totalSeconds % 60;
  return `PT${hours > 0 ? `${String(hours)}H` : ''}${minutes > 0 ? `${String(minutes)}M` : ''}${
    rest > 0 || totalSeconds === 0 ? `${String(rest)}S` : ''
  }`;
}

/**
 * A plant-time range without seconds (design system 6.2): `Mon 12 Oct, 06:15 – 12:17` on one plant
 * day, `Wed 21 Oct, 22:00 – Thu 22 Oct, 06:00` across midnight.
 */
export function plantRangeText(from: string | number, to: string | number): string {
  const end =
    plantDayOf(from) === plantDayOf(to) ? formatClockTime(to) : formatPlantTimeMinutes(to);
  return `${formatPlantTimeMinutes(from)} – ${end}`;
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

// ---- Plant-time input (design system 4.8, UX-1d2 #319) ----

const zoneParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: PLANT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The plant zone's offset from UTC at an instant, in ms (whole seconds). */
export function plantOffsetMs(instant: number): number {
  const p = Object.fromEntries(zoneParts.formatToParts(instant).map((x) => [x.type, x.value]));
  const local = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return local - (instant - (((instant % 1000) + 1000) % 1000));
}

/** `y-m-d` as the calendar day it names, or undefined when there is no such day. */
function calendarDay(year: number, month: number, day: number): string | undefined {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return undefined;
  }
  return at.toISOString().slice(0, 10);
}

/**
 * A date as a person types it, as the plant day `2026-10-12`: `12/10/2026` (the input's format),
 * also `12.10.2026`, `12-10-2026`, single-digit day and month, and `2026-10-12`. Undefined when it
 * is no calendar day.
 */
export function parsePlantDate(text: string): string | undefined {
  const value = text.trim();
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (dayFirst) return calendarDay(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  return undefined;
}

/**
 * A clock time `hh:mm`, `hh:mm:ss` or `hh:mm:ss.sss` (also `h:mm`) as seconds into the day (with
 * the milliseconds as a fraction); undefined if none.
 */
export function parsePlantClock(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text.trim());
  if (!match) return undefined;
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  const ms = Number((match[4] ?? '').padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

/**
 * A whole ISO 8601 instant with its zone (`2026-10-12T05:00:00Z`, `…+03:00`, with or without
 * seconds and fractions), as epoch ms; undefined for anything else: a bare date, a time without a
 * zone (it would be read in the browser's zone), or a day, hour, minute or second that does not
 * exist (`2026-02-30`, which some engines roll over into March and others refuse).
 */
export function parseIsoInstant(text: string): number | undefined {
  const value = text.trim();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(
      value,
    );
  if (!match) return undefined;
  const [
    ,
    year,
    month,
    day,
    hours,
    minutes,
    seconds = '0',
    offsetHours = '0',
    offsetMinutes = '0',
  ] = match;
  if (calendarDay(Number(year), Number(month), Number(day)) === undefined) return undefined;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return undefined;
  if (Number(offsetHours) > 23 || Number(offsetMinutes) > 59) return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

/** The instant a plant day (`2026-10-12`) and a clock time (seconds into it) name in the zone. */
export function plantInstant(day: string, secondsOfDay: number): number {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  const asUtc = Date.UTC(year, month - 1, date) + Math.round(secondsOfDay * 1000);
  const guess = asUtc - plantOffsetMs(asUtc);
  // Across an offset change the first guess can be an hour off: correct once.
  return asUtc - plantOffsetMs(guess);
}

/** The plant day of an instant as the date input shows it: `12/10/2026`. */
export function plantDateText(time: string | number): string {
  const [year, month, day] = plantDayOf(time).split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/**
 * The plant clock time of an instant as the time input shows it: `14:05` or `14:05:09`, and
 * `14:05:09.123` whenever the instant has milliseconds (never dropped: the box shows what is sent).
 */
export function plantClockText(time: string | number, seconds: boolean): string {
  const instant = typeof time === 'number' ? time : Date.parse(time);
  const ms = ((instant % 1000) + 1000) % 1000;
  if (ms !== 0) return `${formatClockSeconds(instant)}.${String(ms).padStart(3, '0')}`;
  return seconds ? formatClockSeconds(instant) : formatClockTime(instant);
}

const dayLabel = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});

/** A plant day (`2026-10-12`) for a day picker: `Mon 12 Oct`. */
export function plantDayLabel(day: string): string {
  return dayLabel.format(new Date(`${day}T12:00:00Z`));
}

/** Every plant day from the one `min` falls on to the one `max` falls on, in order. */
export function plantDaysBetween(min: string | number, max: string | number): string[] {
  const first = plantDayOf(min);
  const last = plantDayOf(max);
  const days: string[] = [];
  for (let at = Date.parse(`${first}T00:00:00Z`); days.length < 366; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day > last) break;
    days.push(day);
  }
  return days;
}

/** The instant as it is sent, in UTC: `2026-10-12 05:00:00 UTC` (`…:00.123 UTC` with ms). */
export function utcInstantText(time: string | number): string {
  const iso = new Date(time).toISOString();
  const ms = iso.slice(19, 23);
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${ms === '.000' ? '' : ms} UTC`;
}
