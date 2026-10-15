import type { CurrentStateDto, IntervalDto } from '@shopfloor/contracts/mes-api';

export interface Band {
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
  readonly state: string;
  readonly cause: string | null;
  readonly start: number;
  readonly end: number;
  readonly provisional: boolean;
}

function spans(intervals: readonly IntervalDto[]): Span[] {
  return intervals.map((interval) => ({
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
