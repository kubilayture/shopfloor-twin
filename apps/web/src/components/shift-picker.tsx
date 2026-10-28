import type { CurrentShift, ShiftInstanceDto } from '@shopfloor/contracts/mes-api';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getCurrentShift, getShifts } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { PLANT_TIME_ZONE, formatClockTime, formatPlantTime, plantDayOf } from '../domain/time.ts';
import { PlantTime } from './ui/format.tsx';
import { Select } from './ui/controls.tsx';

const HOUR = 3_600_000;
/** How far back the shift picker reaches. */
export const SHIFT_HISTORY_MS = 7 * 24 * HOUR;
const CURRENT_SHIFT_REFRESH_MS = 15_000;

const shiftDay = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: PLANT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * A shift key (`2026-10-12/A`) as words, for a shift outside the picker's list (an old one asked
 * for by URL): `Mon 12 Oct, shift A`; an unparseable key as it is.
 */
export function shiftKeyLabel(key: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9]+)$/.exec(key);
  const day = match?.[1];
  const date = day === undefined ? Number.NaN : Date.parse(`${day}T00:00:00.000Z`);
  if (!match || !Number.isFinite(date)) return key;
  return `${shiftDay.format(new Date(date))}, shift ${match[2] ?? ''}`;
}

/** `Mon 12 Oct, shift A (06:00–14:00)`: the shift's own date, its times in plant time. */
export function shiftLabel(shift: ShiftInstanceDto): string {
  const day = shiftDay.format(new Date(`${shift.date}T00:00:00.000Z`));
  return `${day}, shift ${shift.shift} (${clock.format(new Date(shift.start))}–${clock.format(new Date(shift.end))})`;
}

/**
 * A shift's span (design system 6.2): `Mon 12 Oct, 06:00 – 14:00` within one plant day, the date
 * on both sides only across midnight (`Mon 12 Oct, 22:00 – Tue 13 Oct, 06:00`).
 */
export function ShiftSpan({ start, end }: { readonly start: string; readonly end: string }) {
  const oneDay = plantDayOf(start) === plantDayOf(end);
  return (
    <>
      <PlantTime at={start} seconds={false} /> –{' '}
      {oneDay ? (
        <time dateTime={end} title={formatPlantTime(end)} className="tabular-nums">
          {formatClockTime(end)}
        </time>
      ) : (
        <PlantTime at={end} seconds={false} />
      )}
    </>
  );
}

export interface ShiftSelection {
  readonly current: CurrentShift | undefined;
  /** Shifts that started by the plant clock, newest first. */
  readonly shifts: readonly ShiftInstanceDto[];
  /** The chosen shift's key: the one asked for, else the current shift, else the latest one. */
  readonly selected: string | undefined;
  readonly isCurrent: boolean;
  readonly pending: boolean;
  readonly error: unknown;
  /**
   * A read that failed with nothing to show is read again (a poll, a retry), with no answer yet:
   * TanStack Query shows it as pending meanwhile; the screen's error keeps its failure (#394).
   */
  readonly retrying: boolean;
  /** When one of its reads last failed (0: never): which failure the screen's error keeps. */
  readonly failedAt: number;
  /** When one of its reads last answered, with data or a failure ("Try again" busy until it moves). */
  readonly answeredAt: number;
  readonly retry: () => void;
}

/** The current shift (`GET /shifts/current`) and the last week's shifts (`GET /shifts`). */
export function useShiftSelection(requested: string | undefined): ShiftSelection {
  const current = useQuery({
    queryKey: queryKeys.currentShift,
    queryFn: ({ signal }) => getCurrentShift(signal),
    refetchInterval: CURRENT_SHIFT_REFRESH_MS,
  });
  const watermark = current.data?.clock?.watermark;
  const clockMs = watermark === undefined ? undefined : Date.parse(watermark);
  // The list is read up to the next full hour, so it is not read again at every clock tick.
  const to = clockMs === undefined ? undefined : Math.floor(clockMs / HOUR) * HOUR + HOUR;
  const list = useQuery({
    queryKey: queryKeys.shifts(to === undefined ? '' : new Date(to).toISOString()),
    queryFn: ({ signal }) =>
      getShifts({ from: new Date((to ?? 0) - SHIFT_HISTORY_MS), to: new Date(to ?? 0) }, signal),
    enabled: to !== undefined,
    // The key moves with every plant hour: keep the list shown while the next one is read, so
    // a screen never drops back to its loading state each hour (#393 review F1).
    placeholderData: keepPreviousData,
  });
  const shifts = (list.data?.shifts ?? [])
    .filter((shift) => clockMs !== undefined && Date.parse(shift.start) < clockMs)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const currentKey = current.data?.shift ? current.data.shift.key : undefined;
  const selected = requested ?? currentKey ?? shifts[0]?.key;
  return {
    current: current.data,
    shifts,
    selected,
    isCurrent: selected !== undefined && selected === currentKey,
    // Until the first list is in too: with the current shift alone, a screen took the empty list
    // for "no shift yet" while it was on its way (#339). A later hour's list is read behind the
    // one shown (`keepPreviousData`), so it never counts as pending.
    pending: current.isPending || (to !== undefined && list.isPending),
    error: current.error ?? list.error,
    retrying: [current, list].some(
      (read) => read.isPending && read.fetchStatus !== 'idle' && read.errorUpdateCount > 0,
    ),
    failedAt: Math.max(current.errorUpdatedAt, list.errorUpdatedAt),
    answeredAt: Math.max(
      current.dataUpdatedAt,
      current.errorUpdatedAt,
      list.dataUpdatedAt,
      list.errorUpdatedAt,
    ),
    retry: () => {
      void current.refetch();
      void list.refetch();
    },
  };
}

/**
 * A shift `<select>`: the current shift first (marked), then earlier ones. The filter bar's
 * "Shift [select]" (design system 3.3 and 4.7, UX-5b): the token `Select` with its label inline.
 */
export function ShiftPicker({
  selection,
  onChange,
}: {
  readonly selection: ShiftSelection;
  readonly onChange: (shiftKey: string) => void;
}) {
  const currentKey = selection.current?.shift?.key;
  const options = [...selection.shifts];
  if (
    selection.selected !== undefined &&
    !options.some((shift) => shift.key === selection.selected)
  ) {
    const fallback = selection.current?.shift;
    if (fallback?.key === selection.selected) options.unshift(fallback);
  }
  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <Select
        label="Shift"
        // Above the select on a phone: the longest option ("… (14:00–22:00) – current") needs
        // the row's whole width at 390 px (#339).
        inline="sm"
        name="shift"
        data-testid="shift-select"
        value={selection.selected ?? ''}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {selection.selected !== undefined &&
        !options.some((shift) => shift.key === selection.selected) ? (
          <option value={selection.selected}>{shiftKeyLabel(selection.selected)}</option>
        ) : null}
        {options.map((shift) => (
          <option key={shift.key} value={shift.key}>
            {shiftLabel(shift)}
            {shift.key === currentKey ? ' – current' : ''}
          </option>
        ))}
      </Select>
      {selection.current?.shiftKey === 'no-shift' ? (
        <span className="text-sm text-ink-secondary">The plant is between shifts.</span>
      ) : null}
    </div>
  );
}
