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

/**
 * The axis ticks of a timeline window (M-01): at whole steps of plant time (every 10 min over an
 * hour, every hour over 8 h, every 3 h over 24 h), so the labels are round times of day; with the
 * date where the plant day changes when the window spans days, so "Last 24 h" never reads as two
 * equal times.
 */
export function timelineTicks(window: Window): Tick[] {
  const span = window.to - window.from;
  if (span <= 0) return [];
  const step = TICK_STEPS.find((candidate) => span / candidate <= MAX_TICKS) ?? span;
  const spansDays = plantDayOf(window.from) !== plantDayOf(window.to);
  // Whole steps of the plant zone's local time (Europe/Istanbul has kept one offset since 2016;
  // the offset is still read per tick so a zone with a change would land on its local hours).
  const offset = plantOffsetMs(window.from);
  const ticks: Tick[] = [];
  let previousDay: string | undefined;
  for (let local = Math.ceil((window.from + offset) / step) * step; ; local += step) {
    const at = local - plantOffsetMs(local - offset);
    if (at > window.to) break;
    if (at < window.from) continue;
    const day = plantDayOf(at);
    const date = spansDays && day !== previousDay ? plantDayLabel(day) : undefined;
    previousDay = day;
    ticks.push({
      at,
      left: ((at - window.from) / span) * 100,
      time: formatClockTime(at),
      ...(date === undefined ? {} : { date }),
    });
  }
  return ticks;
}
