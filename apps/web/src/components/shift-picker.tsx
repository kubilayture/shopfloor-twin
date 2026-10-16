import type { CurrentShift, ShiftInstanceDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { getCurrentShift, getShifts } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { PLANT_TIME_ZONE } from '../domain/time.ts';

const HOUR = 3_600_000;
/** How far back the shift picker reaches. */
export const SHIFT_HISTORY_MS = 7 * 24 * HOUR;
const CURRENT_SHIFT_REFRESH_MS = 15_000;

const shiftDay = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: PLANT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `Mon 12 Oct, shift A (06:00–14:00)`: the shift's own date, its times in plant time. */
export function shiftLabel(shift: ShiftInstanceDto): string {
  const day = shiftDay.format(new Date(`${shift.date}T00:00:00.000Z`));
  return `${day}, shift ${shift.shift} (${clock.format(new Date(shift.start))}–${clock.format(new Date(shift.end))})`;
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
    pending: current.isPending,
    error: current.error ?? list.error,
    retry: () => {
      void current.refetch();
      void list.refetch();
    },
  };
}

/** A shift `<select>`: the current shift first (marked), then earlier ones. */
export function ShiftPicker({
  selection,
  onChange,
}: {
  readonly selection: ShiftSelection;
  readonly onChange: (shiftKey: string) => void;
}) {
  const id = useId();
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
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        Shift
      </label>
      <select
        id={id}
        data-testid="shift-select"
        value={selection.selected ?? ''}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="max-w-full rounded border border-slate-500 bg-white px-2 py-1 text-sm"
      >
        {selection.selected !== undefined &&
        !options.some((shift) => shift.key === selection.selected) ? (
          <option value={selection.selected}>{selection.selected}</option>
        ) : null}
        {options.map((shift) => (
          <option key={shift.key} value={shift.key}>
            {shiftLabel(shift)}
            {shift.key === currentKey ? ' – current' : ''}
          </option>
        ))}
      </select>
      {selection.current?.shiftKey === 'no-shift' ? (
        <span className="text-sm text-slate-700">The plant is between shifts.</span>
      ) : null}
    </div>
  );
}
