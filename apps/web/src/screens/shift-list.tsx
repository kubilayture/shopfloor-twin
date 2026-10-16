import type { ShiftInstanceDto, ShiftRecordDto } from '@shopfloor/contracts/mes-api';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiError, getShiftInstance } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { shiftLabel, useShiftSelection } from '../components/shift-picker.tsx';
import {
  STATUS_TEXT,
  finalityText,
  instanceKey,
  isNewerShift,
  revisionText,
  shiftTestKey,
} from '../domain/shifts.ts';
import { useLiveShifts, useShiftsTopic } from '../live/live-context.tsx';

/**
 * The instance of a shift key to show: the newest epoch's, as the API defaults to. The read one
 * (404 when the plant clock had not entered the shift then) or the pushed one of the highest
 * epoch for the key, which a `created` push brings; within one epoch the newer by the push rule.
 */
function shownInstance(
  key: string,
  rest: ShiftRecordDto | undefined,
  pushed: Readonly<Record<string, ShiftRecordDto>> | undefined,
): ShiftRecordDto | undefined {
  let newest: ShiftRecordDto | undefined;
  for (const record of Object.values(pushed ?? {})) {
    if (record.key === key && (!newest || record.epoch > newest.epoch)) newest = record;
  }
  if (!rest) return newest;
  if (newest && newest.epoch > rest.epoch) return newest;
  const live = pushed?.[instanceKey(rest.epoch, rest.key)];
  return live && isNewerShift(live, rest) ? live : rest;
}

export function StatusBadge({ record }: { readonly record: ShiftRecordDto }) {
  return (
    <span
      data-status={record.status}
      className={`rounded border px-1.5 text-xs font-medium ${
        record.final
          ? 'border-emerald-800 text-emerald-900'
          : record.status === 'running'
            ? 'border-sky-800 text-sky-900'
            : 'border-amber-700 text-amber-950'
      }`}
    >
      {STATUS_TEXT[record.status]}
    </span>
  );
}

function ShiftRow({
  shift,
  record,
  missing,
  error,
  current,
}: {
  readonly shift: ShiftInstanceDto;
  readonly record: ShiftRecordDto | undefined;
  readonly missing: boolean;
  readonly error: Error | null | undefined;
  readonly current: boolean;
}) {
  const id = shiftTestKey(shift.key);
  return (
    <li
      data-testid={`shift-row-${id}`}
      data-status={record?.status ?? (missing ? 'none' : undefined)}
      data-final={record ? String(record.final) : undefined}
      data-current={String(current)}
      className="flex flex-col gap-1 rounded-lg border border-slate-300 bg-white p-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4"
    >
      <Link
        to="/shifts/$date/$shift"
        params={{ date: shift.date, shift: shift.shift }}
        search={{}}
        data-testid={`shift-link-${id}`}
        className="font-medium text-sky-800 underline"
      >
        {shiftLabel(shift)}
      </Link>
      {current ? <span className="text-sm font-semibold">Current shift</span> : null}
      {record ? (
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge record={record} />
          <span>{finalityText(record)}</span>
          <span className="text-slate-700">Revision: {revisionText(record)}</span>
        </span>
      ) : missing ? (
        <span className="text-sm text-slate-700">No record (the plant clock did not run it)</span>
      ) : error ? (
        <span role="alert" className="text-sm text-red-900" data-testid={`shift-error-${id}`}>
          Could not read its status: {error.message}
        </span>
      ) : (
        <span className="text-sm text-slate-700">Loading…</span>
      )}
    </li>
  );
}

export function ShiftList() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  useShiftsTopic();
  const selection = useShiftSelection(undefined);
  const currentKey = selection.current?.shift?.key;
  const instances = useQueries({
    queries: selection.shifts.map((shift) => ({
      queryKey: queryKeys.shiftInstance(shift.key, undefined),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getShiftInstance({ date: shift.date, shift: shift.shift }, signal),
    })),
  });
  const pushed = useLiveShifts()?.instances;

  return (
    <section aria-labelledby="shift-list-title">
      <h1 ref={heading} id="shift-list-title" tabIndex={-1} className="text-2xl font-bold">
        Shift reports
      </h1>
      <p className="mt-1 text-sm text-slate-700">
        The shifts of the last week, current first. A report is final once every input (OEE,
        downtime, alarm KPIs) is final; its revision counts what changed after that.
      </p>
      {selection.pending ? <p className="mt-4">Loading shifts…</p> : null}
      {selection.error ? (
        <div className="mt-4">
          <QueryError what="the shifts" error={selection.error} onRetry={selection.retry} />
        </div>
      ) : null}
      {!selection.pending && !selection.error && selection.shifts.length === 0 ? (
        <p className="mt-4" data-testid="shift-list-empty">
          No shift yet: the plant clock has not started.
        </p>
      ) : null}
      <ol className="mt-4 flex flex-col gap-2" data-testid="shift-list" aria-label="Shifts">
        {selection.shifts.map((shift, index) => {
          const query = instances[index];
          const missing = query?.error instanceof ApiError && query.error.status === 404;
          return (
            <ShiftRow
              key={shift.key}
              shift={shift}
              record={shownInstance(shift.key, query?.data, pushed)}
              missing={missing}
              error={query?.error}
              current={shift.key === currentKey}
            />
          );
        })}
      </ol>
    </section>
  );
}
