import type { CurrentStateDto, IntervalDto } from '@shopfloor/contracts/mes-api';
import { formatClockTime, plantDayLabel, plantDayOf, plantOffsetMs } from './time.ts';

export interface Band {
  readonly epoch: number;
  readonly state: string;
  readonly cause: string | null;
  readonly start: number;
  readonly end: number;
  readonly provisional: boolean;
  /** Position and width as a percentage of the window. */
  readonly left: number;
  readonly width: number;
}

export interface Window {
  readonly from: number;
  readonly to: number;
}

export interface Span {
  readonly epoch: number;
  readonly state: string;
  readonly cause: string | null;
  readonly start: number;
  readonly end: number;
  readonly provisional: boolean;
}

function spans(intervals: readonly IntervalDto[]): Span[] {
  return intervals.map((interval) => ({
    epoch: interval.epoch,
    state: interval.state,
    cause: interval.cause,
    start: Date.parse(interval.start),
    end: Date.parse(interval.end),
    provisional: interval.provisional,
  }));
}

/**
 * The stored intervals with the live state drawn on to the plant clock. The MES stores the open
 * interval only up to a step behind the watermark (ADR-0018), and a state may have changed since
 * the intervals were read, so everything is cut at the live state's start and the live state runs
 * from there to the clock. A live state older than the stored ones changes nothing.
 */
export function withLiveState(
  intervals: readonly IntervalDto[],
  current: CurrentStateDto | undefined,
  clockMs: number | undefined,
): Span[] {
  const stored = spans(intervals);
  if (!current || clockMs === undefined) return stored;
  const since = Date.parse(current.since);
  const lastStart = stored.at(-1)?.start ?? Number.NEGATIVE_INFINITY;
  if (since < lastStart) return stored;
  const before = stored
    .filter((span) => span.start < since)
    .map((span) => ({ ...span, end: Math.min(span.end, since) }));
  return [
    ...before,
    {
      epoch: current.epoch,
      state: current.state,
      cause: current.cause,
      start: since,
      end: Math.max(clockMs, since),
      provisional: true,
    },
  ];
}

/** Bands of a timeline: each span clipped to the window, in percent, empty ones left out. */
export function timelineBands(input: readonly Span[], window: Window): Band[] {
  const span = window.to - window.from;
  if (span <= 0) return [];
  const bands: Band[] = [];
  for (const item of input) {
    const start = Math.max(item.start, window.from);
    const end = Math.min(item.end, window.to);
    if (end <= start) continue;
    bands.push({
      ...item,
      start,
      end,
      left: ((start - window.from) / span) * 100,
      width: ((end - start) / span) * 100,
    });
  }
  return bands.sort((a, b) => a.start - b.start);
}

export interface StateTotal {
  readonly state: string;
  readonly ms: number;
  /** Share of the covered time, 0 to 1. */
  readonly share: number;
}

/** Time per state over the bands, longest first. */
export function stateTotals(bands: readonly Band[]): StateTotal[] {
  const totals = new Map<string, number>();
  for (const band of bands) {
    totals.set(band.state, (totals.get(band.state) ?? 0) + band.end - band.start);
  }
  const covered = [...totals.values()].reduce((sum, ms) => sum + ms, 0);
  return [...totals]
    .map(([state, ms]) => ({ state, ms, share: covered === 0 ? 0 : ms / covered }))
    .sort((a, b) => b.ms - a.ms || a.state.localeCompare(b.state));
}

/** A tick of the timeline's axis (M-01). */
export interface Tick {
  readonly at: number;
  /** Position as a percentage of the window. */
  readonly left: number;
  /** The plant time of day, `14:00`. */
  readonly time: string;
  /**
   * The plant day, `Tue 13 Oct`, on the first tick and on the first tick of each new day, only
   * when the window spans more than one plant day.
   */
  readonly date?: string;
}

const MINUTE = 60_000;
/** Tick steps, smallest first: the first that gives at most `MAX_TICKS` ticks is taken. */
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * MINUTE);
export const MAX_TICKS = 8;
/** The tick budget of a narrow axis (below `sm`): its labels need about a quarter of it each. */
export const NARROW_TICKS = 4;
/**
 * The least distance between two dated ticks, in percent of the window: a date label is about
 * 60 px wide, so closer dates would run into each other on a phone ("Sun 18 Mon 19 Oct").
 */
export const MIN_DATE_GAP = 20;

/**
 * The axis ticks of a timeline window (M-01): at whole steps of plant time (every 10 min over an
 * hour, every hour over 8 h, every 3 h over 24 h with the default budget of `MAX_TICKS`), so the
 * labels are round times of day; with the date where the plant day changes when the window spans
 * days, so "Last 24 h" never reads as two equal times. The first tick carries the date too,
 * unless the day changes within `MIN_DATE_GAP` of it: then the new day's tick has it alone (the
 * section's description gives the whole range).
 */
export function timelineTicks(
  window: Window,
  { maxTicks = MAX_TICKS }: { readonly maxTicks?: number } = {},
): Tick[] {
  const span = window.to - window.from;
  if (span <= 0) return [];
  const step = TICK_STEPS.find((candidate) => span / candidate <= maxTicks) ?? span;
  const spansDays = plantDayOf(window.from) !== plantDayOf(window.to);
  // Whole steps of the plant zone's local time (Europe/Istanbul has kept one offset since 2016;
  // the offset is still read per tick so a zone with a change would land on its local hours).
  const offset = plantOffsetMs(window.from);
  const ticks: Tick[] = [];
  let previousDay: string | undefined;
  let lastDated: number | undefined;
  for (let local = Math.ceil((window.from + offset) / step) * step; ; local += step) {
    const at = local - plantOffsetMs(local - offset);
    if (at > window.to) break;
    // A window that starts on a whole step would get one tick too many: its start goes.
    if (at < window.from || (at === window.from && span / step >= maxTicks)) continue;
    const day = plantDayOf(at);
    let date = spansDays && day !== previousDay ? plantDayLabel(day) : undefined;
    previousDay = day;
    const left = ((at - window.from) / span) * 100;
    if (date !== undefined && lastDated !== undefined) {
      const earlier = ticks[lastDated];
      if (earlier && left - earlier.left < MIN_DATE_GAP) {
        if (lastDated === 0) {
          // The leading date gives way to the new day's.
          ticks[0] = { at: earlier.at, left: earlier.left, time: earlier.time };
        } else {
          date = undefined;
        }
      }
    }
    if (date !== undefined) lastDated = ticks.length;
    ticks.push({ at, left, time: formatClockTime(at), ...(date === undefined ? {} : { date }) });
  }
  return ticks;
}
