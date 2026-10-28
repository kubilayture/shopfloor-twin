import type { ShiftInstanceDto, ShiftRecordDto } from '@shopfloor/contracts/mes-api';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiError, getShiftInstance } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { FinalityBadge } from '../components/finality-badge.tsx';
import { QueryError } from '../components/query-error.tsx';
import { ShiftSpan, shiftKeyLabel, useShiftSelection } from '../components/shift-picker.tsx';
import { ShiftStateBadge } from '../components/shift-state-badge.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { instanceKey, isNewerShift, revisionText, shiftTestKey } from '../domain/shifts.ts';
import { useLiveShifts, useShiftsTopic } from '../live/live-context.tsx';
import { countOf } from '../domain/words.ts';

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

/** Whether a record's revision counters say something (S-01: shown only above 0). */
const revised = (record: ShiftRecordDto): boolean =>
  record.revision.inputs > 0 || record.revision.content > 0;

interface ShiftRow {
  readonly shift: ShiftInstanceDto;
  readonly record: ShiftRecordDto | undefined;
  readonly missing: boolean;
  readonly error: Error | null | undefined;
  readonly current: boolean;
}

/** A row's state cell: the badge, or why there is none. */
function StateCell({ row }: { readonly row: ShiftRow }) {
  if (row.record) return <ShiftStateBadge status={row.record.status} />;
  if (row.missing) {
    return (
      <span className="text-ink-secondary" title="The plant clock did not run this shift">
        No record
      </span>
    );
  }
  if (row.error) {
    return (
      <span
        role="alert"
        className="text-alarm-ink"
        data-testid={`shift-error-${shiftTestKey(row.shift.key)}`}
      >
        Could not read its status: {row.error.message}
      </span>
    );
  }
  return <span className="text-ink-secondary">Loading…</span>;
}

/**
 * The list's columns (S-01, design system 4.5): the shift names the row (`th`) and links to its
 * report; its time; its state and its finality, each said once; the revision only when a shift
 * of the list was revised, and then only on the rows that were.
 */
function columns(withRevision: boolean): readonly Column<ShiftRow>[] {
  return [
    {
      key: 'shift',
      header: 'Shift',
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link
            to="/shifts/$date/$shift"
            params={{ date: row.shift.date, shift: row.shift.shift }}
            search={{}}
            data-testid={`shift-link-${shiftTestKey(row.shift.key)}`}
            className="font-medium whitespace-nowrap text-link underline-offset-4 hover:underline"
          >
            {shiftKeyLabel(row.shift.key)}
          </Link>
          {row.current ? (
            <Badge tone="neutral" variant="soft">
              Current
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'time',
      header: 'Time',
      priority: 2,
      cell: (row) => <ShiftSpan start={row.shift.start} end={row.shift.end} />,
    },
    { key: 'state', header: 'State', cell: (row) => <StateCell row={row} /> },
    {
      key: 'finality',
      header: 'Report',
      cell: (row) =>
        row.record ? (
          <FinalityBadge
            final={row.record.final}
            title={
              row.record.final
                ? 'Every input (OEE, downtime, alarm KPIs) is final'
                : 'An input is not final yet: the report may still change'
            }
          />
        ) : (
          <Missing reason="No report without a record" />
        ),
    },
    ...(withRevision
      ? [
          {
            key: 'revision',
            header: 'Revision',
            priority: 3 as const,
            cell: (row: ShiftRow) =>
              row.record && revised(row.record) ? (
                <span className="tabular-nums">{revisionText(row.record)}</span>
              ) : (
                <Missing reason="Not revised" />
              ),
          },
        ]
      : []),
  ];
}

/**
 * The shift reports (UX-5b, #327; design system section 10, S-01, S-02): the last week's shifts,
 * current first, as a table of shift, time, state and report finality, each row a link to its
 * report.
 */
export function ShiftList() {
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
  const rows: ShiftRow[] = selection.shifts.map((shift, index) => {
    const query = instances[index];
    return {
      shift,
      record: shownInstance(shift.key, query?.data, pushed),
      missing: query?.error instanceof ApiError && query.error.status === 404,
      error: query?.error,
      current: shift.key === currentKey,
    };
  });
  const withRevision = rows.some((row) => row.record !== undefined && revised(row.record));
  const notFinal = rows.filter((row) => row.record && !row.record.final).length;
  const loaded = !selection.pending && !selection.error;

  return (
    <section aria-labelledby="shift-list-title">
      <PageHeader
        id="shift-list-title"
        title="Shift reports"
        description="The last 7 days’ shifts, current first; days the plant does not work have none."
        summary={
          loaded && rows.length > 0 ? (
            <span data-testid="shift-list-summary">
              {countOf(rows.length, 'shift')}
              {notFinal > 0 ? ` · ${String(notFinal)} not final yet` : ''}
            </span>
          ) : undefined
        }
      />
      {selection.pending ? <Skeleton shape="table" label="Loading shifts…" /> : null}
      {selection.error ? (
        <QueryError what="the shifts" error={selection.error} onRetry={selection.retry} />
      ) : null}
      {loaded ? (
        <DataTable
          caption="Shifts of the last 7 days, current first"
          testId="shift-list"
          columns={columns(withRevision)}
          rows={rows}
          rowKey={(row) => row.shift.key}
          rowTestId={(row) => `shift-row-${shiftTestKey(row.shift.key)}`}
          rowProps={(row) => ({
            'data-status': row.record?.status ?? (row.missing ? 'none' : undefined),
            'data-final': row.record ? String(row.record.final) : undefined,
            'data-current': String(row.current),
          })}
          narrow="stack"
          empty={
            <EmptyState
              icon="clock"
              title="No shift yet"
              body="The plant clock has not started."
              testId="shift-list-empty"
            />
          }
        />
      ) : null}
      {loaded && rows.length > 0 ? (
        <p className="mt-3 text-sm text-ink-secondary">
          A report is final once every input (OEE, downtime, alarm KPIs) is final; its revision
          counts what changed after that.
        </p>
      ) : null}
    </section>
  );
}
