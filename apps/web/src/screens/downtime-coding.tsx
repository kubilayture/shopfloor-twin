import {
  DOWNTIME_TOPIC,
  MES_API_LIMITS,
  type DowntimeList,
  type DowntimeRecordDto,
  type ReasonCodes,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { useCan, useUnsavedDraft } from '../auth/auth.tsx';
import {
  getDowntime,
  getDowntimeAudit,
  getReasonCodes,
  getShiftOee,
  listEquipment,
  putCoding,
} from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { ShiftPicker, useShiftSelection } from '../components/shift-picker.tsx';
import {
  codingBody,
  codingFailure,
  initialSegments,
  joinSegment,
  mergeRecords,
  plantTimeInRecord,
  reasonName,
  reasonOptions,
  recordEnd,
  splitSegments,
  validateDraft,
  writeVersion,
  draftBase,
  type DraftBase,
  type DraftSegment,
  type ReasonOption,
  type WriteFailure,
} from '../domain/downtime.ts';
import { formatClockSeconds, formatDuration, formatPlantTime } from '../domain/time.ts';
import { upsertRecord } from '../live/live-cache.ts';
import { useLiveDowntime, useLiveSubscription } from '../live/live-context.tsx';

const inputClass = 'rounded border border-slate-500 bg-white px-2 py-1 text-sm';
const buttonClass =
  'rounded border border-slate-700 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-60';
const primaryClass =
  'rounded border border-sky-900 bg-sky-800 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-60';

function LossBadge({ loss }: { readonly loss: 'own' | 'external' }) {
  return (
    <span
      className={`rounded px-1.5 text-xs font-semibold ${
        loss === 'own' ? 'bg-red-700 text-white' : 'bg-amber-200 text-amber-950'
      }`}
    >
      {loss === 'own' ? 'Own' : 'External'}
    </span>
  );
}

function ReasonSelect({
  value,
  options,
  onChange,
  index,
  label,
}: {
  readonly value: string;
  readonly options: readonly ReasonOption[];
  readonly onChange: (reason: string) => void;
  readonly index: number;
  readonly label: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-slate-700">
        {label}
      </label>
      <select
        id={id}
        data-testid="reason-picker"
        data-segment={index}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={`${inputClass} max-w-full`}
      >
        <option value="">Keep the automatic reason</option>
        {options.map((option) => (
          <option key={option.id} value={option.id} disabled={!option.codable}>
            {`${'  '.repeat(option.depth)}${option.name}`}
            {option.codable ? '' : ' (not codable)'}
          </option>
        ))}
      </select>
    </div>
  );
}

function SegmentEditor({
  segments,
  options,
  onChange,
}: {
  readonly segments: readonly DraftSegment[];
  readonly options: readonly ReasonOption[];
  readonly onChange: (segments: DraftSegment[]) => void;
}) {
  const update = (index: number, change: Partial<DraftSegment>) => {
    onChange(segments.map((segment, i) => (i === index ? { ...segment, ...change } : segment)));
  };
  return (
    <ol className="flex flex-col gap-3" data-testid="segments">
      {segments.map((segment, index) => (
        <li
          key={`${String(segment.from)}-${String(index)}`}
          data-testid={`segment-${String(index)}`}
          className="rounded border border-slate-300 p-2"
        >
          <p className="text-sm font-medium">
            Segment {index + 1}:{' '}
            <time dateTime={new Date(segment.from).toISOString()}>
              {formatClockSeconds(segment.from)}
            </time>
            –
            <time dateTime={new Date(segment.to).toISOString()}>
              {formatClockSeconds(segment.to)}
            </time>{' '}
            <span className="font-normal text-slate-700">
              ({formatDuration(segment.to - segment.from)})
            </span>
          </p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ReasonSelect
              value={segment.reason}
              options={options}
              index={index}
              label={`Reason, segment ${String(index + 1)}`}
              onChange={(reason) => {
                update(index, { reason });
              }}
            />
            <CommentInput
              value={segment.comment}
              index={index}
              onChange={(comment) => {
                update(index, { comment });
              }}
            />
          </div>
          {index > 0 ? (
            <button
              type="button"
              data-testid="join-segment"
              data-segment={index}
              className={`${buttonClass} mt-2`}
              onClick={() => {
                onChange(joinSegment(segments, index));
              }}
            >
              Join with segment {index}
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function CommentInput({
  value,
  index,
  onChange,
}: {
  readonly value: string;
  readonly index: number;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-slate-700">
        Comment, segment {index + 1} (optional)
      </label>
      <input
        id={id}
        data-testid="segment-comment"
        value={value}
        maxLength={MES_API_LIMITS.codingComment}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={inputClass}
      />
    </div>
  );
}

function SplitControl({
  record,
  onSplit,
}: {
  readonly record: DowntimeRecordDto;
  readonly onSplit: (at: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="text-xs font-medium text-slate-700">
            Split at (plant time)
          </label>
          <input
            id={id}
            type="time"
            step={1}
            data-testid="split-at"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(undefined);
            }}
            className={inputClass}
          />
        </div>
        <button
          type="button"
          data-testid="split"
          className={buttonClass}
          onClick={() => {
            const at = plantTimeInRecord(text, record);
            if (at === undefined) {
              setError('Enter a time inside the record, between its start and end.');
              return;
            }
            onSplit(at);
            setText('');
          }}
        >
          Split
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-900">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AuditHistory({ id, reasons }: { readonly id: string; readonly reasons?: ReasonCodes }) {
  const audit = useQuery({
    queryKey: queryKeys.audit(id),
    queryFn: ({ signal }) => getDowntimeAudit(id, signal),
  });
  return (
    <section aria-labelledby="audit-title" className="mt-4" data-testid="audit">
      <h3 id="audit-title" className="font-semibold">
        History
      </h3>
      {audit.isPending ? <p className="text-sm">Loading history…</p> : null}
      {audit.isError ? (
        <QueryError what="the history" error={audit.error} onRetry={() => void audit.refetch()} />
      ) : null}
      {audit.data?.entries.length === 0 ? (
        <p className="text-sm">Never coded by hand: the automatic reason applies.</p>
      ) : null}
      <ol className="mt-1 flex flex-col gap-2 text-sm">
        {audit.data?.entries.map((entry) => (
          <li key={entry.id} data-testid="audit-entry" className="rounded bg-slate-50 p-2">
            <p>
              <span className="font-semibold">{entry.action}</span> by {entry.actor}
              {entry.authenticated ? '' : ' (not authenticated)'} at{' '}
              <time dateTime={entry.at}>{formatPlantTime(entry.at)}</time> (wall time), version{' '}
              {entry.version}
            </p>
            <p className="text-slate-800">
              Before:{' '}
              {entry.before.length === 0
                ? 'automatic'
                : entry.before
                    .map(
                      (coding) =>
                        `${reasonName(reasons, coding.reason)} ${formatClockSeconds(coding.from)}–${formatClockSeconds(coding.to)}`,
                    )
                    .join('; ')}
            </p>
            <p className="text-slate-800">
              After:{' '}
              {entry.after.length === 0
                ? 'automatic'
                : entry.after
                    .map(
                      (coding) =>
                        `${reasonName(reasons, coding.reason)} ${formatClockSeconds(coding.from)}–${formatClockSeconds(coding.to)}${coding.comment ? ` (“${coding.comment}”)` : ''}`,
                    )
                    .join('; ')}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Message = WriteFailure | { readonly kind: 'saved'; readonly text: string };

function CodingForm({
  record,
  reasons,
  options,
  shiftQueryKey,
}: {
  readonly record: DowntimeRecordDto;
  readonly reasons: ReasonCodes | undefined;
  readonly options: readonly ReasonOption[];
  readonly shiftQueryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [segments, setSegments] = useState<DraftSegment[]>(() => initialSegments(record));
  // What the draft started from: a newer record with the same codings only moves the version
  // (adopted); one with other codings makes the draft stale, and it is never sent as it is.
  const [base, setBase] = useState<DraftBase>(() => draftBase(record));
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const version = writeVersion(base, record);
  // Unsaved while the segments differ from the record's codings (#170: kept under a re-login).
  useUnsavedDraft(JSON.stringify(segments) !== JSON.stringify(initialSegments(record)));

  const restart = (from: DowntimeRecordDto) => {
    setSegments(initialSegments(from));
    setBase(draftBase(from));
  };

  const save = useMutation({
    mutationFn: ({ clear, at }: { clear: boolean; at: number }) =>
      putCoding(record.id, codingBody({ segments: clear ? [] : segments }, at)),
    onSuccess: (result) => {
      upsertRecord(queryClient, result.record);
      restart(result.record);
      setMessage({ kind: 'saved', text: `Saved (version ${String(result.version)}).` });
      void queryClient.invalidateQueries({ queryKey: queryKeys.audit(record.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.paretoAll });
      // The machine's other records moved to the new version too; the MES pushes them as
      // `updated`, and the list is read again in case this tab missed a push.
      void queryClient.invalidateQueries({ queryKey: queryKeys.downtimeAll });
    },
    onError: async (error) => {
      const failure = codingFailure(error);
      setMessage(failure);
      if (failure.kind === 'conflict') {
        await queryClient.refetchQueries({ queryKey: shiftQueryKey });
        const fresh = queryClient
          .getQueryData<DowntimeList>(shiftQueryKey)
          ?.records.find((candidate) => candidate.id === record.id);
        if (fresh) upsertRecord(queryClient, fresh);
        restart(fresh ?? record);
        void queryClient.invalidateQueries({ queryKey: queryKeys.audit(record.id) });
      }
    },
  });

  const submit = (clear: boolean) => {
    setMessage(undefined);
    if (version === undefined) {
      setErrors(['Reload the draft first: the codings of this record changed meanwhile.']);
      return;
    }
    const problems = validateDraft({ segments: clear ? [] : segments }, record, options);
    setErrors(problems);
    if (problems.length > 0) return;
    save.mutate({ clear, at: version });
  };

  return (
    <form
      noValidate
      aria-label={`Coding of ${record.equipment} at ${formatPlantTime(record.start)}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
      className="mt-3 flex flex-col gap-3"
    >
      <SplitControl
        record={record}
        onSplit={(at) => {
          setSegments((current) => splitSegments(current, at));
        }}
      />
      <SegmentEditor segments={segments} options={options} onChange={setSegments} />
      {version === undefined ? (
        <div
          role="alert"
          data-testid="draft-conflict"
          data-kind="conflict"
          className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          <p>
            The codings of this record changed while you were editing (another coding was saved).
            Your draft is not sent; reload it to start from the current codings.
          </p>
          <button
            type="button"
            data-testid="reload-draft"
            className={`${buttonClass} mt-2`}
            onClick={() => {
              restart(record);
              setErrors([]);
              setMessage(undefined);
            }}
          >
            Reload the draft
          </button>
        </div>
      ) : null}
      {errors.length > 0 ? (
        <ul role="alert" data-testid="coding-errors" className="text-sm text-red-900">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      {message ? (
        <p
          role={message.kind === 'saved' ? 'status' : 'alert'}
          data-testid="coding-message"
          data-kind={message.kind}
          className={`rounded border p-2 text-sm ${
            message.kind === 'saved'
              ? 'border-emerald-800 bg-emerald-50 text-emerald-950'
              : 'border-red-800 bg-red-50 text-red-950'
          }`}
        >
          {message.text}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid="save-coding"
          disabled={save.isPending}
          className={primaryClass}
        >
          {save.isPending ? 'Saving…' : 'Save coding'}
        </button>
        <button
          type="button"
          data-testid="reset-coding"
          className={buttonClass}
          onClick={() => {
            restart(record);
            setErrors([]);
            setMessage(undefined);
          }}
        >
          Undo changes
        </button>
        {record.codings.length > 0 ? (
          <button
            type="button"
            data-testid="clear-coding"
            disabled={save.isPending}
            className={buttonClass}
            onClick={() => {
              submit(true);
            }}
          >
            Remove all codings
          </button>
        ) : null}
      </div>
      <AuditHistory id={record.id} {...(reasons ? { reasons } : {})} />
    </form>
  );
}

function RecordPanel({
  record,
  reasons,
  options,
  machineName,
  shiftQueryKey,
  onClose,
}: {
  readonly record: DowntimeRecordDto;
  readonly reasons: ReasonCodes | undefined;
  readonly options: readonly ReasonOption[];
  readonly machineName: string;
  readonly shiftQueryKey: readonly unknown[];
  readonly onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const canCode = useCan('downtime:code');
  useEffect(() => {
    heading.current?.focus();
  }, [record.id]);
  return (
    <section
      aria-labelledby="record-title"
      data-testid="coding-panel"
      data-record={record.id}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      className="min-w-0 rounded-lg border border-slate-300 bg-white p-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="record-title" ref={heading} tabIndex={-1} className="text-lg font-semibold">
          {machineName}: {record.state}
          {record.cause ? ` (${record.cause})` : ''}
        </h2>
        <button type="button" data-testid="close-coding" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
        <dt className="text-slate-700">From</dt>
        <dd>
          <time dateTime={record.start}>{formatPlantTime(record.start)}</time>
        </dd>
        <dt className="text-slate-700">To</dt>
        <dd>
          {record.end ? (
            <time dateTime={record.end}>{formatPlantTime(record.end)}</time>
          ) : (
            'still open'
          )}{' '}
          ({formatDuration(record.ms)})
        </dd>
        <dt className="text-slate-700">Loss</dt>
        <dd>
          <LossBadge loss={record.loss} />
        </dd>
        <dt className="text-slate-700">Automatic reason</dt>
        <dd>{reasonName(reasons, record.autoReason)}</dd>
        <dt className="text-slate-700">In effect</dt>
        <dd>
          <ul>
            {record.segments.map((segment) => (
              <li key={segment.from}>
                {formatClockSeconds(segment.from)}–{formatClockSeconds(segment.to)}:{' '}
                {reasonName(reasons, segment.reason)}
                {segment.coded ? ' (coded)' : ' (automatic)'}
              </li>
            ))}
          </ul>
        </dd>
      </dl>
      <p className="mt-2 text-xs text-slate-700">
        Reasons change the Pareto and the reason view, never OEE.
      </p>
      {canCode ? (
        <CodingForm
          key={record.id}
          record={record}
          reasons={reasons}
          options={options}
          shiftQueryKey={shiftQueryKey}
        />
      ) : (
        <>
          <p data-testid="coding-not-allowed" className="mt-3 text-sm text-slate-800">
            Your role cannot code downtime: the record and its history are shown read-only.
          </p>
          <AuditHistory id={record.id} {...(reasons ? { reasons } : {})} />
        </>
      )}
    </section>
  );
}

export function DowntimeCoding() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const search = useSearch({ from: '/downtime' });
  const navigate = useNavigate({ from: '/downtime' });
  const selection = useShiftSelection(search.shift);
  const shiftKey = selection.selected;
  const uncodedOnly = search.uncoded === true;
  const machineFilterId = useId();
  const [machine, setMachine] = useState('');
  useLiveSubscription(DOWNTIME_TOPIC);

  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const reasons = useQuery({
    queryKey: queryKeys.reasonCodes,
    queryFn: ({ signal }) => getReasonCodes(signal),
    staleTime: 5 * 60_000,
  });
  // The shift's start and end come with its OEE (shared with the dashboard's cache).
  const shift = useQuery({
    queryKey: queryKeys.shiftOee(shiftKey ?? ''),
    queryFn: ({ signal }) => getShiftOee(shiftKey ?? '', signal),
    enabled: shiftKey !== undefined,
  });
  const range = shift.data
    ? { from: Date.parse(shift.data.start), to: Date.parse(shift.data.end) }
    : undefined;
  const listKey = [...queryKeys.downtime(shiftKey ?? ''), uncodedOnly] as const;
  const list = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) =>
      getDowntime({ from: range?.from ?? 0, to: range?.to ?? 0, uncoded: uncodedOnly }, signal),
    enabled: range !== undefined,
  });
  const live = useLiveDowntime();
  const all = range ? mergeRecords(list.data?.records ?? [], live, range) : [];
  const shown = all.filter(
    (record) =>
      (!uncodedOnly || record.uncoded) && (machine === '' || record.equipment === machine),
  );
  const selected = search.record
    ? (all.find((record) => record.id === search.record) ??
      (live?.records[search.record]?.removed === false
        ? live.records[search.record]?.record
        : undefined))
    : undefined;
  const options = reasons.data ? reasonOptions(reasons.data) : [];
  const machineName = (id: string) => equipment.data?.find((item) => item.id === id)?.name ?? id;
  const machines = [...new Set(all.map((record) => record.equipment))].sort();
  const uncodedCount = all.filter((record) => record.uncoded).length;

  return (
    <section aria-labelledby="downtime-title">
      <h1 ref={heading} id="downtime-title" tabIndex={-1} className="text-2xl font-bold">
        Downtime coding
      </h1>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
        <ShiftPicker
          selection={selection}
          onChange={(key) => {
            void navigate({
              search: (previous) => ({ ...previous, shift: key, record: undefined }),
            });
          }}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="uncoded-only"
            checked={uncodedOnly}
            onChange={(event) => {
              const checked = event.target.checked;
              void navigate({
                search: (previous) => ({ ...previous, uncoded: checked ? true : undefined }),
              });
            }}
          />
          Only uncoded
        </label>
        <div className="flex items-center gap-2">
          <label htmlFor={machineFilterId} className="text-sm font-medium">
            Machine
          </label>
          <select
            id={machineFilterId}
            data-testid="machine-filter"
            value={machine}
            onChange={(event) => {
              setMachine(event.target.value);
            }}
            className={inputClass}
          >
            <option value="">All</option>
            {machines.map((id) => (
              <option key={id} value={id}>
                {machineName(id)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {selection.error ? (
        <div className="mt-4">
          <QueryError what="the shifts" error={selection.error} onRetry={selection.retry} />
        </div>
      ) : null}
      {shift.isError ? (
        <div className="mt-4">
          <QueryError what="the shift" error={shift.error} onRetry={() => void shift.refetch()} />
        </div>
      ) : null}
      {list.isError ? (
        <div className="mt-4">
          <QueryError
            what="the downtime records"
            error={list.error}
            onRetry={() => void list.refetch()}
          />
        </div>
      ) : null}
      {reasons.isError ? (
        <div className="mt-4">
          <QueryError
            what="the reason codes"
            error={reasons.error}
            onRetry={() => void reasons.refetch()}
          />
        </div>
      ) : null}
      {list.data?.truncated ? (
        <p role="note" className="mt-4 rounded border border-amber-700 p-2 text-sm">
          More records matched than one answer holds: the list is cut off. Narrow the range to see
          the rest.
        </p>
      ) : null}
      {list.isPending && range ? <p className="mt-4">Loading downtime…</p> : null}
      {list.data ? (
        <p className="mt-4 text-sm" data-testid="downtime-summary">
          {String(shown.length)} records, {String(uncodedCount)} with uncoded time. Uncoded first.
        </p>
      ) : null}

      <div className="mt-3 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="relative min-w-0 overflow-x-auto rounded-lg border border-slate-300 bg-white">
          <table className="w-full min-w-[34rem] text-sm">
            <caption className="sr-only">Downtime records of the shift, uncoded first</caption>
            <thead className="bg-slate-100 text-left">
              <tr>
                <th scope="col" className="px-2 py-1">
                  Machine
                </th>
                <th scope="col" className="px-2 py-1">
                  From
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Length
                </th>
                <th scope="col" className="px-2 py-1">
                  State
                </th>
                <th scope="col" className="px-2 py-1">
                  Loss
                </th>
                <th scope="col" className="px-2 py-1">
                  Reason
                </th>
                <th scope="col" className="px-2 py-1">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((record) => (
                <tr
                  key={record.id}
                  data-testid={`downtime-row-${record.id}`}
                  data-uncoded={String(record.uncoded)}
                  data-reason={record.reason}
                  aria-current={record.id === search.record ? 'true' : undefined}
                  className={`border-t border-slate-200 ${record.id === search.record ? 'bg-sky-50' : ''}`}
                >
                  <td className="px-2 py-1">{machineName(record.equipment)}</td>
                  <td className="px-2 py-1">
                    <time dateTime={record.start}>{formatClockSeconds(record.start)}</time>
                    {record.end === null ? ' (open)' : ''}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {formatDuration(recordEnd(record) - Date.parse(record.start))}
                  </td>
                  <td className="px-2 py-1">
                    {record.state}
                    {record.cause ? ` · ${record.cause}` : ''}
                  </td>
                  <td className="px-2 py-1">
                    <LossBadge loss={record.loss} />
                  </td>
                  <td className="px-2 py-1">
                    {record.uncoded ? (
                      <span className="mr-1 rounded border border-red-800 px-1 text-xs font-semibold text-red-900">
                        Uncoded
                      </span>
                    ) : null}
                    {reasonName(reasons.data, record.reason)}
                    {record.codings.length > 0 ? ' (coded)' : ''}
                  </td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      data-testid={`code-${record.id}`}
                      className={buttonClass}
                      aria-label={`Code ${machineName(record.equipment)} at ${formatClockSeconds(record.start)}`}
                      onClick={() => {
                        void navigate({
                          search: (previous) => ({ ...previous, record: record.id }),
                        });
                      }}
                    >
                      Code
                    </button>
                  </td>
                </tr>
              ))}
              {list.data && shown.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-3">
                    {uncodedOnly
                      ? 'No uncoded downtime in this shift.'
                      : 'No downtime in this shift.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {/* Before the list on narrow screens (the list can be long), beside it and in view on wide ones. */}
        <div className="order-first min-w-0 lg:sticky lg:top-4 lg:order-none">
          {selected ? (
            <RecordPanel
              record={selected}
              reasons={reasons.data}
              options={options}
              machineName={machineName(selected.equipment)}
              shiftQueryKey={listKey}
              onClose={() => {
                const id = selected.id;
                void navigate({ search: (previous) => ({ ...previous, record: undefined }) }).then(
                  () => {
                    // Back to the row's Code button (ids are validated: no quote can occur).
                    const button = document.querySelector<HTMLElement>(
                      `[data-testid="code-${id}"]`,
                    );
                    (button ?? document.getElementById('downtime-title'))?.focus();
                  },
                );
              }}
            />
          ) : (
            <p className="hidden rounded-lg border border-dashed border-slate-400 p-4 text-sm lg:block">
              Choose a record to code it.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
