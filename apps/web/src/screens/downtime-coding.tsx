import {
  DOWNTIME_TOPIC,
  MES_API_LIMITS,
  type DowntimeList,
  type DowntimeRecordDto,
  type ReasonCodes,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useCan, useUnsavedDraft } from '../auth/auth.tsx';
import {
  getDowntime,
  getDowntimeAudit,
  getReasonCodes,
  getShiftOee,
  listEquipment,
  putCoding,
} from '../api/client.ts';
import { queryKeys, usePlantClock } from '../api/queries.ts';
import { LossBadge } from '../components/loss-badge.tsx';
import { QueryError } from '../components/query-error.tsx';
import {
  ScreenError,
  queryRead,
  useScreenErrors,
  selectionRead,
} from '../components/screen-error.tsx';
import { ShiftPicker, useShiftSelection } from '../components/shift-picker.tsx';
import { StateBadge } from '../components/state-badge.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { Checkbox, Select, TextInput } from '../components/ui/controls.tsx';
import { DataTable, useNarrow, type Column } from '../components/ui/data-table.tsx';
import { DescriptionList, type Fact } from '../components/ui/description-list.tsx';
import { DetailPanel, useWide } from '../components/ui/detail-panel.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Duration, PlantTime, WallTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { PlantTimeInput } from '../components/ui/plant-time-input.tsx';
import { Section } from '../components/ui/section.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import {
  codingBody,
  codingFailure,
  initialSegments,
  joinSegment,
  mergeRecords,
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
  UNCODED,
} from '../domain/downtime.ts';
import { stateStyle } from '../domain/states.ts';
import { formatClockSeconds } from '../domain/time.ts';
import { upsertRecord } from '../live/live-cache.ts';
import { useLiveDowntime, useLiveSubscription } from '../live/live-context.tsx';
import { countOf } from '../domain/words.ts';

/**
 * Downtime coding (#122; UX-5a, #326): the shift's downtime records in a `DataTable`, uncoded
 * first, with their state and loss badges and lengths by the content rule (D-01, D-02); the
 * chosen record (`?record=`) opens its coding as a sticky side panel from 1440 px and a side sheet
 * below (design system 3.4, G-26), with "Skip to the details" before the table (G-33). The coding
 * splits a record at a plant time (`PlantTimeInput`, D-05), gives each segment a reason and a
 * comment, and keeps its history. Roles without `downtime:code` see "View" and a read-only
 * record (D-04).
 */

/** The page heading's id: where the focus goes when nothing else is left to take it. */
const TITLE_ID = 'downtime-title';
/** The detail's title: the "Skip to the details" link's target. */
const PANEL_TITLE_ID = 'coding-panel-title';
/**
 * The end of the record list (G-33, UX-F1 #337): the "Skip past the records" link's target while
 * no detail is beside the table, as nothing follows the list on the page then. Visually hidden
 * until the link moves the focus to it.
 */
const LIST_END_ID = 'downtime-list-end';

/** A record's state as a badge, its cause code beside it. */
function StateWithCause({ record }: { readonly record: DowntimeRecordDto }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StateBadge state={record.state} />
      {record.cause ? (
        <Code className="text-xs whitespace-nowrap text-ink-secondary">{record.cause}</Code>
      ) : null}
    </span>
  );
}

/** "Uncoded": time of the record no reason was given for, by hand or by a rule. */
function UncodedBadge() {
  return (
    <Badge tone="warn" variant="outline" icon="alert">
      Uncoded
    </Badge>
  );
}

/** A top-level reason and the reasons under it, in the reason codes' order. */
interface ReasonGroup {
  readonly head: ReasonOption;
  readonly members: readonly ReasonOption[];
}

/** The reasons by their top-level parent (`SETUP` holds `SETUP/TOOL-CHANGE`). */
function reasonGroups(options: readonly ReasonOption[]): ReasonGroup[] {
  const groups: { head: ReasonOption; members: ReasonOption[] }[] = [];
  for (const option of options) {
    const root = option.id.split('/')[0];
    const group = groups.find((candidate) => candidate.head.id === root);
    if (option.depth === 0 || !group) groups.push({ head: option, members: [] });
    else group.members.push(option);
  }
  return groups;
}

function ReasonOptionItem({ option }: { readonly option: ReasonOption }) {
  return (
    <option value={option.id} disabled={!option.codable}>
      {/* Below the group's own level, non-breaking spaces (a select collapses ordinary ones). */}
      {`${'\u00a0\u00a0'.repeat(Math.max(0, option.depth - 1))}${option.name}`}
      {option.codable ? '' : ' (not codable)'}
    </option>
  );
}

function ReasonSelect({
  value,
  options,
  onChange,
  index,
}: {
  readonly value: string;
  readonly options: readonly ReasonOption[];
  readonly onChange: (reason: string) => void;
  readonly index: number;
}) {
  return (
    <Select
      label={`Reason, segment ${String(index + 1)}`}
      name={`reason-${String(index)}`}
      data-testid="reason-picker"
      data-segment={String(index)}
      value={value}
      fieldClassName="min-w-0"
      className="w-full"
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      <option value="">Keep the automatic reason</option>
      {reasonGroups(options).map(({ head, members }) =>
        members.length === 0 ? (
          <ReasonOptionItem key={head.id} option={head} />
        ) : (
          // The tree as the platform knows it: a screen reader says the group with each option.
          <optgroup key={head.id} label={head.name}>
            <ReasonOptionItem option={head} />
            {members.map((option) => (
              <ReasonOptionItem key={option.id} option={option} />
            ))}
          </optgroup>
        ),
      )}
    </Select>
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
    <ol className="flex flex-col gap-3" data-testid="segments" aria-label="Segments">
      {segments.map((segment, index) => (
        <li
          key={`${String(segment.from)}-${String(index)}`}
          data-testid={`segment-${String(index)}`}
          className="rounded-md border border-line-subtle bg-surface-sunken p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-ink">
              Segment {index + 1}:{' '}
              <span className="whitespace-nowrap tabular-nums">
                <PlantTime at={segment.from} clock={segment.from} /> –{' '}
                <PlantTime at={segment.to} clock={segment.from} />
              </span>{' '}
              <span className="font-normal whitespace-nowrap text-ink-secondary">
                (<Duration ms={segment.to - segment.from} />)
              </span>
            </p>
            {index > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="join-segment"
                data-segment={String(index)}
                onClick={() => {
                  onChange(joinSegment(segments, index));
                }}
              >
                Join with segment {index}
              </Button>
            ) : null}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-3">
            <ReasonSelect
              value={segment.reason}
              options={options}
              index={index}
              onChange={(reason) => {
                update(index, { reason });
              }}
            />
            <TextInput
              label={`Comment, segment ${String(index + 1)}`}
              name={`comment-${String(index)}`}
              data-testid="segment-comment"
              value={segment.comment}
              maxLength={MES_API_LIMITS.codingComment}
              fieldClassName="min-w-0"
              className="w-full"
              onChange={(event) => {
                update(index, { comment: event.target.value });
              }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

const SPLIT_ERROR = 'Enter a time inside the record, between its start and end.';

/**
 * Splits the draft at a plant time inside the record (D-05: `PlantTimeInput`, `hh:mm:ss`, the
 * day a select of the record's days). Enter in the time box splits instead of saving the form.
 */
function SplitControl({
  record,
  onSplit,
}: {
  readonly record: DowntimeRecordDto;
  readonly onSplit: (at: number) => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const start = Date.parse(record.start);
  const end = recordEnd(record);
  const split = () => {
    const at = value === null ? Number.NaN : Date.parse(value);
    // Strictly inside: a split at the start or the end would leave an empty segment.
    if (!(at > start && at < end)) {
      setError(SPLIT_ERROR);
      return;
    }
    onSplit(at);
    setValue(null);
    setError(undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    split();
  };
  return (
    // Enter in a box of the split is the split, not the form's save.
    <div className="flex flex-col items-start gap-2" onKeyDown={onKeyDown}>
      <PlantTimeInput
        label="Split at"
        name="split-at"
        testId="split-at"
        withSeconds
        // Strictly inside the record, as the split itself: a time at its start or end is no
        // split, and on a record longer than a day the time lands on the day where it is inside.
        min={new Date(start + 1).toISOString()}
        max={new Date(end - 1).toISOString()}
        value={value}
        error={error}
        hint="Split the record in two at this time, then give each part its reason."
        onChange={(next) => {
          setValue(next);
          setError(undefined);
        }}
      />
      <Button size="sm" data-testid="split" onClick={split}>
        Split
      </Button>
    </div>
  );
}

function AuditHistory({ id, reasons }: { readonly id: string; readonly reasons?: ReasonCodes }) {
  const audit = useQuery({
    queryKey: queryKeys.audit(id),
    queryFn: ({ signal }) => getDowntimeAudit(id, signal),
  });
  const codings = (list: readonly { reason: string; from: string; to: string }[]) =>
    list.length === 0
      ? 'automatic'
      : list
          .map(
            (coding) =>
              `${reasonName(reasons, coding.reason)} ${formatClockSeconds(coding.from)}–${formatClockSeconds(coding.to)}`,
          )
          .join('; ');
  return (
    <Section level={3} title="History" id="audit-title" testId="audit" className="mt-6">
      {audit.isPending ? <Skeleton shape="text" rows={2} label="Loading history…" /> : null}
      {audit.isError ? (
        <QueryError what="the history" error={audit.error} onRetry={() => void audit.refetch()} />
      ) : null}
      {audit.data?.entries.length === 0 ? (
        <p className="text-ink-secondary">Never coded by hand: the automatic reason applies.</p>
      ) : null}
      <ol className="flex flex-col divide-y divide-line-subtle">
        {audit.data?.entries.map((entry) => (
          <li key={entry.id} data-testid="audit-entry" className="py-2 first:pt-0">
            <p className="text-ink">
              <span className="font-semibold">{entry.action}</span> by {entry.actor}
              {entry.authenticated ? '' : ' (not authenticated)'} at <WallTime at={entry.at} />,
              version {entry.version}
            </p>
            <p className="mt-0.5 text-ink-secondary">Before: {codings(entry.before)}</p>
            <p className="text-ink-secondary">
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
    </Section>
  );
}

type Message = WriteFailure | { readonly kind: 'saved'; readonly text: string };

function CodingForm({
  record,
  options,
  shiftQueryKey,
}: {
  readonly record: DowntimeRecordDto;
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
  // A ref, not `isPending`: two submits before the next render both see it false.
  const sending = useRef(false);
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
    onSettled: () => {
      sending.current = false;
    },
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
    // Busy: a second save or removal waits for the first (the buttons say so).
    if (sending.current) return;
    setMessage(undefined);
    if (version === undefined) {
      setErrors(['Reload the draft first: the codings of this record changed meanwhile.']);
      return;
    }
    const problems = validateDraft({ segments: clear ? [] : segments }, record, options);
    setErrors(problems);
    if (problems.length > 0) return;
    sending.current = true;
    save.mutate({ clear, at: version });
  };
  const clearing = save.isPending && save.variables.clear;

  return (
    <form
      noValidate
      aria-label={`Coding of ${record.equipment} at ${formatClockSeconds(record.start)}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
      className="flex flex-col gap-4"
    >
      <SplitControl
        record={record}
        onSplit={(at) => {
          setSegments((current) => splitSegments(current, at));
        }}
      />
      <SegmentEditor segments={segments} options={options} onChange={setSegments} />
      {version === undefined ? (
        <Callout
          tone="warn"
          role="alert"
          data-testid="draft-conflict"
          data-kind="conflict"
          title="The codings changed while you were editing"
        >
          <p>
            Another coding of this record was saved. Your draft is not sent; reload it to start from
            the current codings.
          </p>
          <Button
            size="sm"
            data-testid="reload-draft"
            className="mt-2"
            onClick={() => {
              restart(record);
              setErrors([]);
              setMessage(undefined);
            }}
          >
            Reload the draft
          </Button>
        </Callout>
      ) : null}
      {errors.length > 0 ? (
        <Callout tone="alarm" role="alert" data-testid="coding-errors">
          <ul className="flex flex-col gap-1">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {message ? (
        <Callout
          tone={message.kind === 'saved' ? 'ok' : 'alarm'}
          role={message.kind === 'saved' ? 'status' : 'alert'}
          data-testid="coding-message"
          data-kind={message.kind}
        >
          {message.text}
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {record.codings.length > 0 ? (
          <Button
            variant="danger"
            data-testid="clear-coding"
            className="mr-auto"
            loading={clearing}
            aria-disabled={save.isPending || undefined}
            onClick={() => {
              submit(true);
            }}
          >
            Remove all codings
          </Button>
        ) : null}
        <Button
          data-testid="reset-coding"
          className={record.codings.length > 0 ? undefined : 'ml-auto'}
          onClick={() => {
            restart(record);
            setErrors([]);
            setMessage(undefined);
          }}
        >
          Undo changes
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="save-coding"
          loading={save.isPending && !clearing}
          aria-disabled={save.isPending || undefined}
        >
          Save coding
        </Button>
      </div>
    </form>
  );
}

/** The chosen record: its facts, then its coding (or a read-only note) and its history. */
function RecordDetail({
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
  const canCode = useCan('downtime:code');
  const facts: Fact[] = [
    { term: 'State', detail: <StateWithCause record={record} /> },
    { term: 'Loss', detail: <LossBadge kind={record.loss} /> },
    {
      term: 'Automatic reason',
      detail:
        record.autoReason === UNCODED ? (
          // No rule gave a reason: the badge says it once, not "Not coded, Uncoded".
          <UncodedBadge />
        ) : (
          reasonName(reasons, record.autoReason)
        ),
    },
    {
      term: 'In effect',
      detail: (
        <ul className="flex flex-col gap-0.5">
          {record.segments.map((segment) => (
            <li key={segment.from}>
              <span className="whitespace-nowrap tabular-nums">
                {formatClockSeconds(segment.from)}–{formatClockSeconds(segment.to)}
              </span>
              : {reasonName(reasons, segment.reason)}{' '}
              <span className="text-ink-secondary">
                {segment.coded ? '(coded)' : '(automatic)'}
              </span>
            </li>
          ))}
        </ul>
      ),
    },
  ];
  return (
    <>
      <DescriptionList facts={facts} columns={2} label="The record" />
      <p className="mb-4 text-xs text-ink-secondary">
        Reasons change the Pareto and the reason view, never OEE.
      </p>
      {canCode ? (
        <Section level={3} title="Coding">
          <CodingForm
            key={record.id}
            record={record}
            options={options}
            shiftQueryKey={shiftQueryKey}
          />
        </Section>
      ) : (
        <Callout tone="neutral" data-testid="coding-not-allowed" className="mb-6">
          Your role cannot code downtime: the record and its history are shown read-only.
        </Callout>
      )}
      <AuditHistory id={record.id} {...(reasons ? { reasons } : {})} />
    </>
  );
}

/**
 * The record table's columns. `beside`: the detail panel is open beside the table (from 1440 px),
 * which leaves it about 720 px, so the loss and the cause code leave the table (the panel shows
 * them); times and lengths keep to one line, long machine names wrap to two.
 */
function recordColumns(
  machineName: (id: string) => string,
  reasons: ReasonCodes | undefined,
  clock: string | undefined,
  beside: boolean,
): readonly Column<DowntimeRecordDto>[] {
  const loss: Column<DowntimeRecordDto>[] = beside
    ? []
    : [
        {
          key: 'loss',
          header: 'Loss',
          nowrap: true,
          priority: 3,
          cell: (record) => <LossBadge kind={record.loss} />,
        },
      ];
  return [
    {
      key: 'machine',
      header: 'Machine',
      rowHeader: true,
      cell: (record) => machineName(record.equipment),
    },
    {
      key: 'from',
      header: 'From',
      align: 'end',
      nowrap: true,
      cell: (record) => <PlantTime at={record.start} clock={clock} />,
    },
    {
      key: 'length',
      header: 'Length',
      numeric: true,
      cell: (record) => (
        <>
          <Duration ms={recordEnd(record) - Date.parse(record.start)} />
          {record.end === null ? <span className="text-ink-secondary"> (open)</span> : null}
        </>
      ),
    },
    {
      key: 'state',
      header: 'State',
      nowrap: beside,
      // Beside the panel the cause code stays in the panel, so the machine keeps to one line.
      cell: (record) =>
        beside ? <StateBadge state={record.state} /> : <StateWithCause record={record} />,
    },
    ...loss,
    {
      key: 'reason',
      header: 'Reason',
      cell: (record) => (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          {record.uncoded ? <UncodedBadge /> : null}
          {/* No reason at all: the badge says it once, not "Uncoded Not coded". */}
          {record.reason === UNCODED ? null : (
            <span>
              {reasonName(reasons, record.reason)}
              {record.codings.length > 0 ? (
                <span className="text-ink-secondary"> (coded)</span>
              ) : null}
            </span>
          )}
        </span>
      ),
    },
  ];
}

export function DowntimeCoding() {
  const search = useSearch({ from: '/downtime' });
  const navigate = useNavigate({ from: '/downtime' });
  const selection = useShiftSelection(search.shift);
  const shiftKey = selection.selected;
  const uncodedOnly = search.uncoded === true;
  const [machine, setMachine] = useState('');
  const canCode = useCan('downtime:code');
  const wide = useWide();
  // Row actions are 44 px touch targets on the stacked cards (design system 7, 2.5.8).
  const actionSize = useNarrow() ? 'lg' : 'sm';
  const { clock } = usePlantClock();
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
  const panelOpen = selected !== undefined;
  const beside = panelOpen && wide;

  // The rows as they were while the open record was among them: when it leaves the list (coded
  // out of "Only uncoded"), closing the detail takes the focus to the next row's action.
  const shownIds = shown.map((record) => record.id).join('\n');
  const order = useRef<readonly string[]>([]);
  useEffect(() => {
    const ids = shownIds === '' ? [] : shownIds.split('\n');
    if (search.record !== undefined && ids.includes(search.record)) order.current = ids;
  }, [shownIds, search.record]);
  /** The row action to focus after the detail of `id` closes: its own, the next, the previous. */
  const focusAfterClose = (id: string): HTMLElement | null => {
    // Ids are validated by the MES: no quote can occur.
    const action = (key: string) =>
      document.querySelector<HTMLElement>(`[data-testid="code-${key}"]`);
    const at = order.current.indexOf(id);
    const after = at < 0 ? [] : order.current.slice(at + 1);
    const before = at < 0 ? [] : order.current.slice(0, at).reverse();
    for (const key of [id, ...after, ...before]) {
      const found = action(key);
      if (found) return found;
    }
    return document.getElementById(TITLE_ID);
  };
  const closeDetail = (id: string) => {
    void navigate({ search: (previous) => ({ ...previous, record: undefined }) }).then(() => {
      // Back to the record's own action, whatever had the focus before it opened (a click does
      // not focus a button in Safari); when the record left the list, the next row's action.
      setTimeout(() => {
        focusAfterClose(id)?.focus();
      }, 0);
    });
  };

  const rowAction = (record: DowntimeRecordDto): ReactNode => {
    const name = `${machineName(record.equipment)} at ${formatClockSeconds(record.start)}`;
    const verb = canCode ? 'Code' : 'View';
    return (
      <Button
        variant="ghost"
        size={actionSize}
        data-testid={`code-${record.id}`}
        aria-label={`${verb} ${name}`}
        onClick={() => {
          void navigate({ search: (previous) => ({ ...previous, record: record.id }) });
        }}
      >
        {verb}
      </Button>
    );
  };

  // One error for the screen (#394): the records' failed read (or one it waits on) takes the
  // table's place, naming every failed read; with the records in, a failed read of the reason
  // codes is said above them.
  const errors = useScreenErrors([
    selectionRead(selection),
    queryRead('the shift', shift, 'base'),
    queryRead('the downtime records', list, 'main'),
    queryRead('the reason codes', reasons, 'base'),
  ]);
  // The records' read, or one it waits on, failed (kept while it is read again: `errors`).
  const failed = errors.summary.some((read) => read.key !== 'the reason codes');
  const waits =
    (selection.error !== null && selection.error !== undefined) || shift.isError || list.isError;
  const noShift = !selection.pending && shiftKey === undefined;
  const loading =
    !noShift && (selection.pending || shift.isPending || list.isPending) && shown.length === 0;
  const missingRecord =
    search.record !== undefined && selected === undefined && list.data !== undefined;

  return (
    <section aria-labelledby={TITLE_ID}>
      <PageHeader
        id={TITLE_ID}
        title="Downtime coding"
        description="Every stop of the shift with its reason, uncoded first; reasons feed the Pareto, never OEE."
        filters={
          <>
            <ShiftPicker
              selection={selection}
              onChange={(key) => {
                void navigate({
                  search: (previous) => ({ ...previous, shift: key, record: undefined }),
                });
              }}
            />
            <Checkbox
              label="Only uncoded"
              name="uncoded-only"
              data-testid="uncoded-only"
              checked={uncodedOnly}
              onChange={(event) => {
                const checked = event.target.checked;
                void navigate({
                  search: (previous) => ({ ...previous, uncoded: checked ? true : undefined }),
                });
              }}
            />
            <Select
              label="Machine"
              name="machine"
              inline
              data-testid="machine-filter"
              value={machine}
              onChange={(event) => {
                setMachine(event.target.value);
              }}
            >
              <option value="">All</option>
              {machines.map((id) => (
                <option key={id} value={id}>
                  {machineName(id)}
                </option>
              ))}
            </Select>
          </>
        }
        summary={
          list.data ? (
            <span data-testid="downtime-summary">
              {countOf(shown.length, 'record')}, {uncodedCount} with uncoded time; uncoded first
            </span>
          ) : undefined
        }
      />
      {errors.summary.length > 0 && !failed ? (
        <div className="mb-4">
          <ScreenError errors={errors} />
        </div>
      ) : null}
      {list.data?.truncated ? (
        <Callout tone="warn" role="status" className="mb-4">
          More records matched than one answer holds: the list is cut off. Narrow the range to see
          the rest.
        </Callout>
      ) : null}
      {missingRecord ? (
        <Callout tone="neutral" role="status" className="mb-4" data-testid="record-not-found">
          <p>
            Record <Code>{search.record}</Code>{' '}
            {uncodedOnly
              ? 'is not among the uncoded records of this shift: it is coded, or belongs to another shift.'
              : 'is not among the records of this shift: it belongs to another shift.'}
          </p>
          <Button
            size="sm"
            className="mt-2"
            onClick={() => {
              void navigate({ search: (previous) => ({ ...previous, record: undefined }) });
            }}
          >
            Close the note
          </Button>
        </Callout>
      ) : null}

      <div
        className={beside ? 'grid grid-cols-[minmax(0,1fr)_25rem] items-start gap-4' : undefined}
      >
        <div className="min-w-0">
          {failed ? (
            <ScreenError errors={errors} />
          ) : (
            <DataTable
              caption="Downtime records of the shift, uncoded first"
              testId="downtime-table"
              columns={recordColumns(machineName, reasons.data, clock?.watermark, beside)}
              rows={shown}
              rowKey={(record) => record.id}
              rowTestId={(record) => `downtime-row-${record.id}`}
              rowProps={(record) => ({
                'data-uncoded': String(record.uncoded),
                'data-reason': record.reason,
              })}
              rowTone={(record) => (record.uncoded ? 'warn' : undefined)}
              activeRowKey={search.record}
              actions={rowAction}
              skipToDetails={beside ? PANEL_TITLE_ID : LIST_END_ID}
              skipLabel={beside ? undefined : 'Skip past the records'}
              announceRemoval={(left) =>
                `The record left the list; ${left === 0 ? 'no records remain' : `${countOf(left, 'record')} ${left === 1 ? 'remains' : 'remain'}`}.`
              }
              narrow="stack"
              // A failed read waits here while the screen's other reads are on their way.
              loading={loading || waits ? 'Loading downtime…' : undefined}
              empty={
                noShift ? (
                  <EmptyState
                    icon="clock"
                    title="No shift yet"
                    body="Downtime is listed by shift; the plant clock has not reached one."
                  />
                ) : (
                  <EmptyState
                    testId="downtime-empty"
                    icon="check"
                    title={
                      uncodedOnly
                        ? 'No uncoded downtime in this shift'
                        : machine === ''
                          ? 'No downtime in this shift'
                          : 'No downtime of this machine in this shift'
                    }
                    body={
                      uncodedOnly
                        ? 'Every stop has its reason; new stops appear here at once.'
                        : 'New stops appear here at once.'
                    }
                  />
                )
              }
            />
          )}
          {beside || shown.length === 0 ? null : (
            <p
              id={LIST_END_ID}
              className="sr-only text-sm text-ink-secondary focus:not-sr-only focus:mt-3 focus:block"
            >
              End of the downtime records.
            </p>
          )}
        </div>
        {selected ? (
          <DetailPanel
            testId="coding-panel"
            data-record={selected.id}
            closeTestId="close-coding"
            closeLabel="Close the record"
            titleId={PANEL_TITLE_ID}
            focusKey={selected.id}
            returnFocus={() => focusAfterClose(selected.id)}
            title={`${machineName(selected.equipment)}: ${stateStyle(selected.state).label}`}
            description={
              <span className="tabular-nums">
                <PlantTime at={selected.start} clock={clock?.watermark} /> –{' '}
                {selected.end ? (
                  <PlantTime at={selected.end} clock={clock?.watermark} />
                ) : (
                  'still open'
                )}{' '}
                · <Duration ms={recordEnd(selected) - Date.parse(selected.start)} />
              </span>
            }
            onClose={() => {
              closeDetail(selected.id);
            }}
          >
            <RecordDetail
              key={selected.id}
              record={selected}
              reasons={reasons.data}
              options={options}
              shiftQueryKey={listKey}
            />
          </DetailPanel>
        ) : null}
      </div>
    </section>
  );
}
