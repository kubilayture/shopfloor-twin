import {
  ALARM_VIEWS,
  MES_API_LIMITS,
  type AlarmHistory,
  type AlarmOccurrenceDto,
  type AlarmPointDto,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCan, useUnsavedDraft } from '../auth/auth.tsx';
import {
  acknowledgeAlarm,
  acknowledgeAlarms,
  commentAlarm,
  getAlarm,
  getAlarmHistory,
  getAlarmPoints,
  getAlarmScopes,
  getAlarms,
  listEquipment,
  shelvePoint,
  unshelvePoint,
} from '../api/client.ts';
import { queryKeys, useAlarmConfig, usePlantClock } from '../api/queries.ts';
import { PriorityBadge } from '../components/priority-badge.tsx';
import { QueryError } from '../components/query-error.tsx';
import { Badge, type BadgeVariant } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { Select, Textarea, TextInput } from '../components/ui/controls.tsx';
import { DataTable, useNarrow, type Column } from '../components/ui/data-table.tsx';
import { DescriptionList, type Fact } from '../components/ui/description-list.tsx';
import { DetailPanel, useWide } from '../components/ui/detail-panel.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Icon } from '../components/ui/icons.tsx';
import { Duration, PlantTime, WallTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { SegmentedLinks } from '../components/ui/segmented-links.tsx';
import { TabPanel, Tabs } from '../components/ui/tabs.tsx';
import type { Tone } from '../components/ui/tokens.ts';
import {
  ALARM_VIEW_LABELS,
  ackFailure,
  acknowledgeable,
  commentFailure,
  endReasonText,
  floodText,
  isShelved,
  mergeAlarms,
  newerOccurrence,
  newerShelf,
  partition,
  pointKey,
  shelfFailure,
  shelvePresets,
  defaultSort,
  sortAlarms,
  stateText,
  type AlarmSort,
  type AlarmView,
  type Priority,
} from '../domain/alarms.ts';
import { formatPlantTime } from '../domain/time.ts';
import type { WriteFailure } from '../domain/writes.ts';
import { dropLiveOccurrences, upsertOccurrence, upsertPoint } from '../live/live-cache.ts';
import {
  useLiveAlarmKpi,
  useLiveAlarms,
  useAlarmsTopic,
  useLiveSubscriptions,
} from '../live/live-context.tsx';

/**
 * The alarm list (#145; UX-4a, #324): the four operator views as `Tabs`, each a `DataTable` with
 * priority, sorted by priority (active before cleared, then newest raise) or by raise alone
 * (`?sort=`, #371; History by raise unless chosen); the
 * unacknowledged rows marked by a bar in their priority's colour, the active ones also by bold text
 * and a solid state badge (ISA-18.2, A-03, #371), the row actions side by side (A-02), selection
 * and the bulk acknowledgement;
 * one card per row below `md` (G-27). The chosen alarm's detail (`?alarm=`) is a sticky side panel
 * from 1440 px and a side sheet below (design system 3.4, G-26, A-05), with its facts, the
 * acknowledgement, the shelf, comments and history on `Field`s; names before codes (A-04, A-06).
 */

const HOUR = 3_600_000;
/** How far back the History tab reads (the API allows at most 7 days). */
export const HISTORY_MS = 24 * HOUR;

/** The page heading's id: where the focus goes when a closed detail's opener is gone. */
const TITLE_ID = 'alarms-title';
/** The bulk button's description. */
const BULK_HINT_ID = 'alarm-bulk-hint';
/** The detail panel's title: the "Skip to the details" link's target. */
const PANEL_TITLE_ID = 'alarm-panel-title';

type Message = WriteFailure | { readonly kind: 'saved'; readonly text: string };

/** A write's outcome: an `ok` status or an `alarm` alert, with its kind for the tests. */
function WriteMessage({ message, testId }: { readonly message: Message; readonly testId: string }) {
  const saved = message.kind === 'saved';
  return (
    <Callout
      tone={saved ? 'ok' : 'alarm'}
      role={saved ? 'status' : 'alert'}
      data-testid={testId}
      data-kind={message.kind}
    >
      {message.text}
    </Callout>
  );
}

/**
 * A write's outcome in the list's toolbar: one line beside the bulk button (an `ok` check or an
 * `alarm` glyph and the words), announced as a status or an alert, `data-kind` for the tests.
 */
function ToolbarMessage({
  message,
  testId,
}: {
  readonly message: Message;
  readonly testId: string;
}) {
  const saved = message.kind === 'saved';
  return (
    <p
      role={saved ? 'status' : 'alert'}
      data-testid={testId}
      data-kind={message.kind}
      className={`flex min-w-0 items-start gap-1.5 text-sm font-medium ${saved ? 'text-ok-ink' : 'text-alarm-ink'}`}
    >
      <Icon name={saved ? 'check' : 'alert'} size={16} className="mt-0.5" />
      <span className="min-w-0">{message.text}</span>
    </p>
  );
}

/** The bar of an unacknowledged alarm: its priority's border colour (design system 2.5). */
const PRIORITY_TONE: Readonly<Record<Priority, Tone>> = {
  high: 'alarm',
  medium: 'warn',
  low: 'info',
};

/** Not acknowledged yet (active or cleared): it keeps its priority bar (ISA-18.2, A-03). */
const unacknowledged = (occurrence: AlarmOccurrenceDto): boolean =>
  occurrence.state === 'unacked-active' || occurrence.state === 'unacked-cleared';

/**
 * Active and not acknowledged: the alarm that needs the operator now, so it is the most salient
 * row, bold beside its bar (#371). A cleared one awaiting its acknowledgement keeps the bar only.
 */
const needsAction = (occurrence: AlarmOccurrenceDto): boolean =>
  occurrence.state === 'unacked-active';

/**
 * The condition badge's look, in the neutral tone only (ISA-101: the priority badge and the bar
 * carry the colour): solid for active and unacknowledged, outline for active and acknowledged,
 * soft for cleared and closed (#371).
 */
const CONDITION_VARIANT: Readonly<Record<AlarmOccurrenceDto['state'], BadgeVariant>> = {
  'unacked-active': 'solid',
  'acked-active': 'outline',
  'unacked-cleared': 'soft',
  closed: 'soft',
};

/** The sort switch's items: the visible label and the caption's words. */
const SORT_TEXT: Readonly<Record<AlarmSort, { label: string; caption: string }>> = {
  priority: {
    label: 'Priority',
    caption: 'highest priority first, active before cleared, then newest raise',
  },
  raised: { label: 'Newest raise', caption: 'newest raise first' },
};

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/**
 * How a control names its alarm for a screen reader: the alarm's text, else its code, then the
 * machine: "Coolant pressure low on CNC-02, Horizontal machining centre 2" (names first, 6.4).
 */
const alarmLabel = (occurrence: AlarmOccurrenceDto, machine: string): string =>
  `${occurrence.text ?? occurrence.code}, ${machine}`;

/** The occurrence's condition alone ("Active", "Cleared", "Closed"): the state without the ack. */
function conditionText(occurrence: AlarmOccurrenceDto): string {
  switch (occurrence.state) {
    case 'unacked-active':
    case 'acked-active':
      return 'Active';
    case 'unacked-cleared':
      return 'Cleared';
    case 'closed':
      return 'Closed';
  }
}

/**
 * The State cell: the condition as a neutral badge ("Active", "Cleared", "Closed"), then whether
 * it is acknowledged, in words. Beside the detail panel only the badge shows and the
 * acknowledgement is said to a screen reader (the bar and bold text show it). The cell reads
 * "Active, unacknowledged" as one phrase either way.
 */
function AlarmState({
  occurrence,
  beside,
}: {
  readonly occurrence: AlarmOccurrenceDto;
  readonly beside: boolean;
}) {
  const ack =
    occurrence.state === 'closed'
      ? undefined
      : occurrence.acknowledged === null
        ? 'unacknowledged'
        : 'acknowledged';
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <Badge
        tone="neutral"
        variant={CONDITION_VARIANT[occurrence.state]}
        data-condition={conditionText(occurrence).toLowerCase()}
      >
        {conditionText(occurrence)}
      </Badge>
      {ack === undefined ? null : beside ? (
        <span className="sr-only">, {ack}</span>
      ) : (
        <span className={ack === 'acknowledged' ? 'font-normal text-ink-secondary' : undefined}>
          <span className="sr-only">, </span>
          {ack}
        </span>
      )}
    </span>
  );
}

/** The alarm's name, then its code: "Coolant pressure low", `COOLANT-PRESSURE` below. */
function AlarmName({ occurrence }: { readonly occurrence: AlarmOccurrenceDto }) {
  if (!occurrence.text) return <Code className="whitespace-nowrap">{occurrence.code}</Code>;
  return (
    <>
      <span className="block">{occurrence.text}</span>
      <Code className="block whitespace-nowrap text-xs font-normal text-ink-secondary">
        {occurrence.code}
      </Code>
    </>
  );
}

// ---- Flood banner ----

/** One position's flood banner, shown while `alarm-kpi:position:<id>` reports an open episode. */
function FloodBanner({ id, name }: { readonly id: string; readonly name: string }) {
  const floods = useLiveAlarmKpi(`position:${id}`)?.floods ?? [];
  const config = useAlarmConfig();
  const { clock } = usePlantClock();
  const episode = floods[0];
  if (!episode) return null;
  return (
    <Callout
      tone="alarm"
      data-testid={`flood-banner-${id}`}
      data-episode={episode.id}
      title={
        // Dated unless it began on the plant clock's day (design system 6.2): a flood that began
        // before plant midnight does not read as today's.
        <span role="alert">
          Alarm flood in {name} since <PlantTime at={episode.startAt} clock={clock?.watermark} />
        </span>
      }
    >
      <p data-testid={`flood-text-${id}`}>
        {config
          ? `${floodText(episode.peak, config.kpi)}, ${String(episode.raises)} since the flood began.`
          : `${String(episode.raises)} raises since the flood began.`}{' '}
        Deal with the highest priority first.
      </p>
    </Callout>
  );
}

// ---- The detail ----

function ShelfSection({
  occurrence,
  point,
  detailShelf,
  machineName,
  onWrite,
}: {
  readonly occurrence: AlarmOccurrenceDto;
  readonly point: AlarmPointDto | undefined;
  readonly detailShelf: AlarmPointDto['shelf'] | undefined;
  readonly machineName: string;
  readonly onWrite: (message: Message) => void;
}) {
  const queryClient = useQueryClient();
  const { clock } = usePlantClock();
  const shelf = newerShelf(point?.shelf, detailShelf);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const canShelve = useCan('alarm:shelve');
  useUnsavedDraft(reason.trim() !== '');
  // Presets capped at the MES's real limit (#160); none until the configuration arrived.
  const config = useAlarmConfig();
  const presets = config ? shelvePresets(config) : [];
  const [picked, setDuration] = useState<string | undefined>(undefined);
  const duration =
    picked !== undefined && presets.some((preset) => String(preset.ms) === picked)
      ? picked
      : presets[0] === undefined
        ? undefined
        : String(presets[0].ms);
  // The version a shelve draft started from (captured at its first edit): a shelf that moved on
  // since (pushed) is not overwritten unseen; the operator reloads it first, as a coding draft
  // does. Without a draft (unshelve) the newest known version is sent; the MES answers 409 if it
  // moved on meanwhile.
  const [base, setBase] = useState<number | undefined>(undefined);
  const startDraft = () => {
    setBase((known) => known ?? shelf?.version);
  };
  const version = base ?? shelf?.version;
  const stale = base !== undefined && shelf !== undefined && shelf.version !== base;

  const reread = async () => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: queryKeys.alarmPoints }),
      queryClient.refetchQueries({ queryKey: queryKeys.alarm(occurrence.id) }),
    ]);
    setBase(undefined);
  };

  const write = useMutation({
    mutationFn: ({ action, version }: { action: 'shelve' | 'unshelve'; version: number }) =>
      action === 'shelve'
        ? shelvePoint(occurrence.equipment, occurrence.code, {
            reason: reason.trim(),
            durationMs: Number(duration ?? 0),
            version,
          })
        : unshelvePoint(occurrence.equipment, occurrence.code, { version }),
    onSuccess: (result, { action }) => {
      upsertPoint(queryClient, result.point);
      setBase(undefined);
      setReason('');
      onWrite({
        kind: 'saved',
        text:
          action === 'shelve'
            ? `Shelved until ${result.point.shelf.until ? formatPlantTime(result.point.shelf.until) : '–'} (plant time).`
            : 'Unshelved.',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarmsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarmPoints });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarm(occurrence.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarmHistory(occurrence.id) });
    },
    onError: async (error, { action }) => {
      const failure = shelfFailure(error, action);
      onWrite(failure);
      if (failure.kind === 'conflict') await reread();
    },
  });

  const submit = (action: 'shelve' | 'unshelve') => {
    if (stale) {
      onWrite({
        kind: 'conflict',
        text: "Not sent: the point's shelf changed since you started. Reload the shelf first.",
      });
      return;
    }
    if (version === undefined) {
      onWrite({ kind: 'unavailable', text: 'The shelf is not loaded yet; try again.' });
      return;
    }
    if (action === 'shelve' && duration === undefined) {
      onWrite({ kind: 'unavailable', text: 'The shelving limit is not loaded yet; try again.' });
      return;
    }
    if (action === 'shelve' && reason.trim() === '') {
      setReasonError('Enter a reason for shelving.');
      onWrite({ kind: 'invalid', text: 'Enter a reason for shelving.' });
      return;
    }
    write.mutate({ action, version });
  };

  return (
    <Section
      level={3}
      title="Shelving"
      testId="shelf-section"
      description={
        <>
          Hides every <Code className="whitespace-nowrap">{occurrence.code}</Code> alarm of{' '}
          {machineName} from the Active list for a time; the KPIs still count them.
        </>
      }
    >
      {shelf === undefined ? <p className="text-ink-secondary">Loading the shelf…</p> : null}
      {stale ? (
        <Callout
          tone="alarm"
          role="alert"
          data-testid="shelf-conflict"
          data-kind="conflict"
          className="mb-3"
        >
          <p>
            The shelf changed while this panel was open (version {base} → {shelf.version}). Nothing
            is sent until you reload it.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            data-testid="reload-shelf"
            onClick={() => {
              setBase(undefined);
            }}
          >
            Reload the shelf
          </Button>
        </Callout>
      ) : null}
      {shelf?.shelved ? (
        <div className="flex flex-col items-start gap-2">
          <p data-testid="shelf-state" data-shelved="true" data-version={shelf.version}>
            Shelved by {shelf.by ?? 'an unknown user'}
            {shelf.reason ? ` (“${shelf.reason}”)` : ''} until{' '}
            {shelf.until ? (
              <PlantTime at={shelf.until} clock={clock?.watermark} />
            ) : (
              'further notice'
            )}
            .
          </p>
          {canShelve ? (
            <Button
              variant="secondary"
              data-testid="unshelve"
              loading={write.isPending}
              onClick={() => {
                submit('unshelve');
              }}
            >
              Unshelve
            </Button>
          ) : null}
        </div>
      ) : null}
      {shelf && !shelf.shelved && !canShelve ? (
        <p data-testid="shelf-state" data-shelved="false" data-version={shelf.version}>
          Not shelved.
        </p>
      ) : null}
      {shelf && !shelf.shelved && canShelve ? (
        <form
          noValidate
          aria-label="Shelve the point"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit('shelve');
          }}
        >
          <p
            className="sr-only"
            data-testid="shelf-state"
            data-shelved="false"
            data-version={shelf.version}
          >
            Not shelved.
          </p>
          <TextInput
            label="Reason"
            name="shelve-reason"
            required
            data-testid="shelve-reason"
            value={reason}
            maxLength={MES_API_LIMITS.shelveReason}
            error={reasonError}
            fieldClassName="min-w-0 flex-1 basis-48"
            className="w-full"
            onChange={(event) => {
              startDraft();
              setReason(event.target.value);
              setReasonError(undefined);
            }}
          />
          <Select
            label="For"
            name="shelve-duration"
            data-testid="shelve-duration"
            value={duration ?? ''}
            disabled={presets.length === 0}
            onChange={(event) => {
              startDraft();
              setDuration(event.target.value);
            }}
          >
            {presets.map((preset) => (
              <option key={preset.ms} value={String(preset.ms)}>
                {preset.label}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary" data-testid="shelve" loading={write.isPending}>
            Shelve
          </Button>
        </form>
      ) : null}
    </Section>
  );
}

function CommentForm({
  id,
  onWrite,
}: {
  readonly id: string;
  readonly onWrite: (message: Message) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  useUnsavedDraft(text.trim() !== '');
  const write = useMutation({
    mutationFn: () => commentAlarm(id, { text: text.trim() }),
    onSuccess: (result) => {
      upsertOccurrence(queryClient, result.occurrence);
      setText('');
      onWrite({ kind: 'saved', text: 'Comment added.' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarm(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarmHistory(id) });
    },
    onError: (error) => {
      onWrite(commentFailure(error));
    },
  });
  return (
    <form
      noValidate
      aria-label="Add a comment"
      className="mt-3 flex flex-col items-start gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() === '') onWrite({ kind: 'invalid', text: 'Write a comment first.' });
        else write.mutate();
      }}
    >
      <Textarea
        label="New comment"
        name="comment"
        data-testid="comment-text"
        value={text}
        rows={2}
        max={MES_API_LIMITS.alarmComment}
        fieldClassName="w-full"
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <Button type="submit" variant="secondary" data-testid="add-comment" loading={write.isPending}>
        Add comment
      </Button>
    </form>
  );
}

/** What each history transition says, in words (A-06). */
const TRANSITION_TEXT: Readonly<Record<AlarmHistory['entries'][number]['transition'], string>> = {
  raised: 'Raised',
  cleared: 'Cleared by the device',
  lost: 'Clear lost',
  superseded: 'Superseded by the next raise',
  'epoch-ended': 'Ended with its simulator run',
  ack: 'Acknowledged',
  comment: 'Comment',
  shelve: 'Point shelved',
  unshelve: 'Point unshelved',
  expire: 'Shelf expired',
};

/** Where a history entry came from, in words; the raw value stays in `data-source`. */
const SOURCE_TEXT: Readonly<Record<AlarmHistory['entries'][number]['source'], string>> = {
  fact: 'device fact',
  anchor: 'retained delivery',
  snapshot: 'resync snapshot',
  mes: 'derived by the MES',
  audit: 'audit',
};

function AlarmHistoryList({ id }: { readonly id: string }) {
  const { clock } = usePlantClock();
  const history = useQuery({
    queryKey: queryKeys.alarmHistory(id),
    queryFn: ({ signal }) => getAlarmHistory(id, signal),
  });
  return (
    <Section level={3} title="History" testId="alarm-history">
      {history.isPending ? <p className="text-ink-secondary">Loading history…</p> : null}
      {history.isError ? (
        <QueryError
          what="the history"
          error={history.error}
          onRetry={() => void history.refetch()}
        />
      ) : null}
      <ol className="flex flex-col divide-y divide-line-subtle">
        {history.data?.entries.map((entry, index) => (
          <li
            key={`${entry.source}-${entry.transition}-${String(entry.auditId ?? entry.seq ?? index)}`}
            data-testid="history-entry"
            data-transition={entry.transition}
            data-source={entry.source}
            className="py-2 first:pt-0"
          >
            <p>
              <span className="font-medium">{TRANSITION_TEXT[entry.transition]}</span>{' '}
              <PlantTime at={entry.at} clock={clock?.watermark} />
              {entry.source === 'audit' ? (
                <>
                  {' '}
                  by {entry.actor ?? 'an unknown user'}
                  {entry.authenticated === false ? ' (not authenticated)' : ''}
                </>
              ) : null}
            </p>
            {entry.transition === 'comment' && typeof entry.detail?.text === 'string' ? (
              <p className="mt-0.5 text-ink-secondary">“{entry.detail.text}”</p>
            ) : null}
            <Disclosure summary="Technical details" className="mt-1">
              <p className="text-xs text-ink-secondary">
                {SOURCE_TEXT[entry.source]}
                {entry.seq === null ? '' : ` · seq ${String(entry.seq)}`}
                {entry.protocol ? ` · ${entry.protocol}` : ''}
                {entry.requestId ? ` · request ${entry.requestId}` : ''}
                {entry.receivedAt ? (
                  <>
                    {' · received '}
                    <WallTime at={entry.receivedAt} />
                  </>
                ) : null}
              </p>
            </Disclosure>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** The chosen alarm's facts, acknowledgement, shelf, comments and history. */
function AlarmDetail({
  occurrence,
  point,
  machineName,
}: {
  readonly occurrence: AlarmOccurrenceDto;
  readonly point: AlarmPointDto | undefined;
  readonly machineName: string;
}) {
  const queryClient = useQueryClient();
  const { clock } = usePlantClock();
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [ackComment, setAckComment] = useState('');
  const canAck = useCan('alarm:ack');
  const canComment = useCan('alarm:comment');
  useUnsavedDraft(ackComment.trim() !== '');
  const detail = useQuery({
    queryKey: queryKeys.alarm(occurrence.id),
    queryFn: ({ signal }) => getAlarm(occurrence.id, signal),
  });

  // A pushed change of the occurrence or its point: read its comments and history again.
  const signature = [
    occurrence.state,
    occurrence.endedAt,
    occurrence.comments,
    occurrence.acknowledged?.at,
    point?.shelf.version,
  ].join('|');
  const seen = useRef(signature);
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    void queryClient.invalidateQueries({ queryKey: queryKeys.alarm(occurrence.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.alarmHistory(occurrence.id) });
  }, [signature, occurrence.id, queryClient]);

  const ack = useMutation({
    mutationFn: () =>
      acknowledgeAlarm(occurrence.id, {
        ...(ackComment.trim() === '' ? {} : { comment: ackComment.trim() }),
      }),
    onSuccess: (result) => {
      upsertOccurrence(queryClient, result.occurrence);
      setAckComment('');
      setMessage({
        kind: 'saved',
        text: result.changed ? 'Acknowledged.' : 'It was acknowledged already.',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarmsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarm(occurrence.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.alarmHistory(occurrence.id) });
    },
    onError: (error) => {
      setMessage(ackFailure(error));
    },
  });

  const definition = detail.data?.definition;
  const shelved = newerShelf(point?.shelf, detail.data?.shelf)?.shelved ?? occurrence.shelved;
  const facts: Fact[] = [
    {
      term: 'Priority',
      detail: (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PriorityBadge priority={occurrence.priority} />
          <span className="text-ink-secondary">
            Severity {occurrence.severity}
            {occurrence.defined ? '' : ', no definition'}
          </span>
        </span>
      ),
    },
    {
      term: 'State',
      detail: (
        <span data-testid="alarm-state" data-state={occurrence.state}>
          {stateText(occurrence)}
          {shelved ? ', point shelved' : ''}
        </span>
      ),
    },
    {
      term: 'Raised',
      detail: (
        <>
          <PlantTime at={occurrence.raisedAt} clock={clock?.watermark} />
          {occurrence.source === 'anchor' ? ' (from a retained delivery)' : ''}
        </>
      ),
    },
    {
      term: 'Ended',
      detail: occurrence.endedAt ? (
        <>
          <PlantTime at={occurrence.endedAt} clock={clock?.watermark} /> after{' '}
          <Duration ms={Date.parse(occurrence.endedAt) - Date.parse(occurrence.raisedAt)} />,{' '}
          {endReasonText(occurrence.endReason)}
        </>
      ) : (
        'Not yet: still active'
      ),
    },
    {
      term: 'Acknowledged',
      detail: occurrence.acknowledged ? (
        <>
          By {occurrence.acknowledged.by}, <WallTime at={occurrence.acknowledged.at} />
          {occurrence.acknowledged.comment ? (
            <span className="block text-ink-secondary">“{occurrence.acknowledged.comment}”</span>
          ) : null}
        </>
      ) : (
        'Not yet'
      ),
    },
    { term: 'Final', detail: occurrence.final ? 'Yes' : 'No, may still change' },
  ];
  const guidance: Fact[] = [
    { term: 'Consequence', detail: definition?.consequence },
    { term: 'Response', detail: definition?.response },
  ];

  return (
    <>
      <DescriptionList facts={facts} columns={2} label="The alarm" />
      {definition?.consequence || definition?.response ? (
        <DescriptionList facts={guidance} columns={1} label="What it means" />
      ) : null}
      {detail.isError ? (
        <div className="mb-3">
          <QueryError what="the alarm" error={detail.error} onRetry={() => void detail.refetch()} />
        </div>
      ) : null}
      {message ? (
        <div className="mb-3">
          <WriteMessage message={message} testId="alarm-message" />
        </div>
      ) : null}
      {canAck && acknowledgeable(occurrence) ? (
        <form
          noValidate
          aria-label="Acknowledge the alarm"
          className="flex flex-wrap items-end gap-3 rounded-md border border-line-subtle bg-surface-sunken p-3"
          onSubmit={(event) => {
            event.preventDefault();
            ack.mutate();
          }}
        >
          <TextInput
            label="Comment with the acknowledgement"
            name="ack-comment"
            data-testid="ack-comment"
            value={ackComment}
            maxLength={MES_API_LIMITS.alarmComment}
            fieldClassName="min-w-0 flex-1 basis-48"
            className="w-full"
            onChange={(event) => {
              setAckComment(event.target.value);
            }}
          />
          <Button type="submit" variant="primary" data-testid="ack-detail" loading={ack.isPending}>
            Acknowledge
          </Button>
        </form>
      ) : null}
      <div className="mt-6">
        <ShelfSection
          key={pointKey(occurrence.equipment, occurrence.code)}
          occurrence={occurrence}
          point={point}
          detailShelf={detail.data?.shelf}
          machineName={machineName}
          onWrite={setMessage}
        />
        <Section
          level={3}
          title="Comments"
          testId="comments"
          status={
            <Badge tone="neutral" className="tabular-nums">
              {occurrence.comments}
            </Badge>
          }
        >
          {detail.data?.comments.length === 0 ? (
            <p className="text-ink-secondary">No comments yet.</p>
          ) : null}
          <ol className="flex flex-col divide-y divide-line-subtle">
            {detail.data?.comments.map((comment) => (
              <li key={comment.id} data-testid="comment" className="py-2 first:pt-0">
                <p>{comment.text}</p>
                <p className="mt-0.5 text-xs text-ink-secondary">
                  {comment.actor}
                  {comment.authenticated ? '' : ' (not authenticated)'} ·{' '}
                  <WallTime at={comment.at} />
                </p>
              </li>
            ))}
          </ol>
          {canComment ? <CommentForm id={occurrence.id} onWrite={setMessage} /> : null}
        </Section>
        <AlarmHistoryList id={occurrence.id} />
      </div>
    </>
  );
}

// ---- The list ----

/**
 * The list's columns. `beside`: the detail panel is open beside the list (from 1440 px), which
 * leaves the table about 720 px, so the machine joins the alarm's cell under its code instead of
 * a column of its own, and the row actions stay in view without a sideways scroll.
 */
function alarmColumns(
  machineName: (id: string) => string,
  clock: string | undefined,
  beside: boolean,
): readonly Column<AlarmOccurrenceDto>[] {
  const machine: Column<AlarmOccurrenceDto>[] = beside
    ? []
    : [
        {
          key: 'machine',
          header: 'Machine',
          cell: (occurrence) => machineName(occurrence.equipment),
        },
      ];
  return [
    {
      key: 'priority',
      header: 'Priority',
      nowrap: true,
      cell: (occurrence) => <PriorityBadge priority={occurrence.priority} />,
    },
    {
      key: 'alarm',
      header: beside ? 'Alarm and machine' : 'Alarm',
      rowHeader: true,
      cell: (occurrence) => (
        <>
          <AlarmName occurrence={occurrence} />
          {beside ? (
            <span className="block text-xs font-normal text-ink-secondary">
              {machineName(occurrence.equipment)}
            </span>
          ) : null}
        </>
      ),
    },
    ...machine,
    {
      key: 'raised',
      header: 'Raised',
      align: 'end',
      nowrap: true,
      cell: (occurrence) => <PlantTime at={occurrence.raisedAt} clock={clock} />,
    },
    {
      key: 'state',
      header: 'State',
      cell: (occurrence) => (
        <>
          {/* Beside the panel the column keeps to the condition, so the alarm's name has room. */}
          <AlarmState occurrence={occurrence} beside={beside} />
          {occurrence.comments > 0 ? (
            <span className="block text-xs font-normal text-ink-secondary">
              {plural(occurrence.comments, 'comment')}
            </span>
          ) : null}
        </>
      ),
    },
  ];
}

/** The empty state of a view, by what it holds. */
function emptyText(view: AlarmView): { readonly title: string; readonly body: string } {
  switch (view) {
    case 'active':
      return {
        title: 'No active alarms',
        body: 'Every alarm is acknowledged or shelved; new raises appear here at once.',
      };
    case 'acknowledged':
      return {
        title: 'No acknowledged alarms',
        body: 'An acknowledged alarm stays here while its condition is still active.',
      };
    case 'shelved':
      return {
        title: 'No shelved alarms',
        body: "Shelving a point from an alarm's details moves its alarms here for a time.",
      };
    case 'history':
      return {
        title: 'No closed alarms in the last 24 hours',
        body: 'An alarm comes here once it has cleared and been acknowledged.',
      };
  }
}

export function AlarmList() {
  const search = useSearch({ from: '/alarms' });
  const navigate = useNavigate({ from: '/alarms' });
  const queryClient = useQueryClient();
  const view: AlarmView = search.view ?? 'active';
  // Each view has its default (History by raise time); a chosen order is kept across the tabs.
  const sort: AlarmSort = search.sort ?? defaultSort(view);
  const mayAck = useCan('alarm:ack');
  const wide = useWide();
  // Row actions are 44 px touch targets on the stacked cards (design system 7, 2.5.8).
  const actionSize = useNarrow() ? 'lg' : 'sm';
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState<Message | undefined>(undefined);
  useAlarmsTopic();

  const { clock } = usePlantClock();
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const scopes = useQuery({
    queryKey: queryKeys.alarmScopes,
    queryFn: ({ signal }) => getAlarmScopes(signal),
    staleTime: 5 * 60_000,
  });
  const positions = (scopes.data?.scopes ?? []).filter((scope) => scope.scope === 'position');
  useLiveSubscriptions(positions.map((position) => `alarm-kpi:position:${position.id}`));

  const active = useQuery({
    queryKey: queryKeys.alarms('active'),
    queryFn: ({ signal }) => getAlarms({ view: 'active' }, signal),
  });
  const acknowledged = useQuery({
    queryKey: queryKeys.alarms('acknowledged'),
    queryFn: ({ signal }) => getAlarms({ view: 'acknowledged' }, signal),
  });
  const shelved = useQuery({
    queryKey: queryKeys.alarms('shelved'),
    queryFn: ({ signal }) => getAlarms({ view: 'shelved' }, signal),
  });
  // History: the last 24 hours up to the next full hour of the plant clock (read again hourly).
  const watermark = clock ? Date.parse(clock.watermark) : undefined;
  const historyTo =
    watermark === undefined ? undefined : Math.floor(watermark / HOUR) * HOUR + HOUR;
  const history = useQuery({
    queryKey: queryKeys.alarms('history', String(historyTo ?? '')),
    queryFn: ({ signal }) =>
      getAlarms(
        { view: 'history', from: (historyTo ?? 0) - HISTORY_MS, to: historyTo ?? 0 },
        signal,
      ),
    enabled: view === 'history' && historyTo !== undefined,
  });
  const points = useQuery({
    queryKey: queryKeys.alarmPoints,
    queryFn: ({ signal }) => getAlarmPoints(signal),
  });
  const live = useLiveAlarms();
  const set = mergeAlarms(
    [
      active.data?.alarms ?? [],
      acknowledged.data?.alarms ?? [],
      shelved.data?.alarms ?? [],
      view === 'history' ? (history.data?.alarms ?? []) : [],
    ],
    points.data?.points ?? [],
    live,
  );
  const views = partition(set);
  const shown = sortAlarms(views[view], sort);
  const reads = { active, acknowledged, shelved, history };
  const loaded = reads[view];
  const noClock = view === 'history' && historyTo === undefined;
  const chosen = shown.filter(
    (occurrence) => acknowledgeable(occurrence) && selected.has(occurrence.id),
  );

  const machineName = (id: string) => equipment.data?.find((item) => item.id === id)?.name ?? id;
  // The chosen occurrence: from the lists, or read by id (a link to one outside them); the
  // detail shares this read.
  const linked = useQuery({
    queryKey: queryKeys.alarm(search.alarm ?? ''),
    queryFn: ({ signal }) => getAlarm(search.alarm ?? '', signal),
    enabled: search.alarm !== undefined,
  });
  const listed = search.alarm
    ? set.occurrences.find((occurrence) => occurrence.id === search.alarm)
    : undefined;
  const read = search.alarm ? linked.data?.occurrence : undefined;
  const selectedOccurrence = listed && read ? newerOccurrence(read, listed) : (listed ?? read);

  const afterAck = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.alarmsAll });
    void queryClient.invalidateQueries({ queryKey: ['alarm'] });
    void queryClient.invalidateQueries({ queryKey: ['alarm-history'] });
  };
  const ackOne = useMutation({
    mutationFn: (id: string) => acknowledgeAlarm(id, {}),
    onSuccess: (result) => {
      upsertOccurrence(queryClient, result.occurrence);
      afterAck();
      setMessage({
        kind: 'saved',
        text: result.changed
          ? `Acknowledged ${result.occurrence.code} on ${machineName(result.occurrence.equipment)}.`
          : 'It was acknowledged already.',
      });
    },
    onError: (error) => {
      setMessage(ackFailure(error));
    },
  });
  const ackMany = useMutation({
    mutationFn: (ids: string[]) => acknowledgeAlarms({ ids }),
    onSuccess: (result) => {
      // The answer carries no occurrences: forget their pushed copies, so the lists read again
      // below (and the pushes of the acknowledgements) decide what they show.
      dropLiveOccurrences(
        queryClient,
        result.results.map((entry) => entry.id),
      );
      afterAck();
      setSelected(new Set());
      const skipped = result.results.length - result.acknowledged;
      setMessage({
        kind: 'saved',
        text: `Acknowledged ${String(result.acknowledged)}${skipped > 0 ? ` (${String(skipped)} already acknowledged)` : ''}.`,
      });
    },
    onError: (error) => {
      setMessage(ackFailure(error));
    },
  });

  const counts: Readonly<Partial<Record<AlarmView, number>>> = {
    ...(active.data ? { active: views.active.length } : {}),
    ...(acknowledged.data ? { acknowledged: views.acknowledged.length } : {}),
    ...(shelved.data ? { shelved: views.shelved.length } : {}),
  };
  const truncated = [active, acknowledged, shelved, history].some(
    (query) => query.data?.next !== null && query.data?.next !== undefined,
  );
  // The shown view's failed read takes the table's place; the others' go above the tabs.
  const otherErrors = [
    { view: 'active', what: 'the active alarms', query: active },
    { view: 'acknowledged', what: 'the acknowledged alarms', query: acknowledged },
    { view: 'shelved', what: 'the shelved alarms', query: shelved },
    { view: 'history', what: 'the alarm history', query: history },
    { view: undefined, what: 'the alarm points', query: points },
  ].filter((entry) => entry.view !== view && entry.query.isError);

  const bulk = mayAck && (view === 'active' || view === 'shelved');
  const panelOpen = selectedOccurrence !== undefined;
  const empty = noClock
    ? {
        title: 'No plant clock yet',
        body: 'There is no history to read until the plant clock is known.',
      }
    : emptyText(view);

  const closeDetail = () => {
    void navigate({ search: (previous) => ({ ...previous, alarm: undefined }) }).then(() => {
      // The sheet gives the focus back to its opener; when that left with its row, the heading.
      setTimeout(() => {
        if (document.activeElement === null || document.activeElement === document.body) {
          document.getElementById(TITLE_ID)?.focus();
        }
      }, 0);
    });
  };

  const rowActions = (occurrence: AlarmOccurrenceDto): ReactNode => {
    const name = machineName(occurrence.equipment);
    return (
      <>
        {mayAck && acknowledgeable(occurrence) ? (
          <Button
            variant="ghost"
            size={actionSize}
            data-testid={`ack-${occurrence.id}`}
            aria-label={`Acknowledge ${alarmLabel(occurrence, name)}`}
            // Busy (not disabled) while its own acknowledgement is on the way: the focus stays
            // on it until the row leaves, and then moves to the next row's (DataTable).
            loading={ackOne.isPending && ackOne.variables === occurrence.id}
            onClick={() => {
              ackOne.mutate(occurrence.id);
            }}
          >
            Acknowledge
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size={actionSize}
          data-testid={`details-${occurrence.id}`}
          aria-label={`Details of ${alarmLabel(occurrence, name)}`}
          onClick={() => {
            void navigate({
              search: (previous) => ({ ...previous, alarm: occurrence.id }),
            });
          }}
        >
          Details
        </Button>
      </>
    );
  };

  return (
    <section aria-labelledby={TITLE_ID}>
      <PageHeader
        id={TITLE_ID}
        title="Alarms"
        description="Every alarm of the plant; acknowledge, shelve and comment."
        filters={
          <>
            <span aria-hidden="true" className="text-sm font-medium text-ink">
              Sort by
            </span>
            <SegmentedLinks
              label="Sort by"
              testId="alarm-sort"
              current={sort}
              items={[
                {
                  key: 'priority',
                  label: SORT_TEXT.priority.label,
                  to: '/alarms',
                  // The view's default leaves the URL without `sort`, as a link from elsewhere
                  // has it.
                  search: {
                    ...search,
                    sort: defaultSort(view) === 'priority' ? undefined : 'priority',
                  },
                  testId: 'alarm-sort-priority',
                },
                {
                  key: 'raised',
                  label: SORT_TEXT.raised.label,
                  to: '/alarms',
                  search: {
                    ...search,
                    sort: defaultSort(view) === 'raised' ? undefined : 'raised',
                  },
                  testId: 'alarm-sort-raised',
                },
              ]}
            />
          </>
        }
      />
      {positions.length > 0 ? (
        <div className="mb-4 flex flex-col gap-2 empty:hidden">
          {positions.map((position) => (
            <FloodBanner key={position.id} id={position.id} name={position.name} />
          ))}
        </div>
      ) : null}
      {otherErrors.map(({ what, query }) => (
        <div key={what} className="mb-4">
          <QueryError what={what} error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ))}
      {truncated ? (
        <Callout tone="warn" role="status" className="mb-4">
          More alarms than one answer holds ({MES_API_LIMITS.alarmPageMax}): the list is cut off.
        </Callout>
      ) : null}
      {search.alarm !== undefined && selectedOccurrence === undefined && linked.isError ? (
        <div className="mb-4">
          <QueryError what="the alarm" error={linked.error} onRetry={() => void linked.refetch()} />
        </div>
      ) : null}

      <div
        className={
          panelOpen && wide ? 'grid grid-cols-[minmax(0,1fr)_25rem] items-start gap-4' : undefined
        }
      >
        <div className="min-w-0">
          <Tabs
            label="Alarm lists"
            idPrefix="alarm-tab"
            panelId="alarm-tabpanel"
            value={view}
            tabs={ALARM_VIEWS.map((name) => ({
              id: name,
              label: ALARM_VIEW_LABELS[name],
              count: counts[name],
              testId: `tab-${name}`,
            }))}
            onChange={(next) => {
              const target = ALARM_VIEWS.find((name) => name === next);
              if (target === undefined) return;
              setMessage(undefined);
              // A selection belongs to the rows of one tab: never acknowledge what isn't shown.
              setSelected(new Set());
              void navigate({ search: (previous) => ({ ...previous, view: target }) });
            }}
          />
          <TabPanel
            id="alarm-tabpanel"
            labelledBy={`alarm-tab-${view}`}
            testId="alarm-list"
            data-view={view}
            data-count={loaded.data ? String(shown.length) : undefined}
            className="pt-4"
          >
            {/* The toolbar: the bulk acknowledgement and the last write's outcome, in a row of its
                own whose height is kept, so a message never pushes the rows down (#369 review). */}
            {bulk || message ? (
              <div
                data-testid="alarm-toolbar"
                className="mb-3 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2"
              >
                {bulk && !loaded.isError ? (
                  <>
                    <Button
                      variant="primary"
                      data-testid="ack-selected"
                      // Never `disabled`: after a bulk acknowledgement empties the selection the
                      // focus stays on the button instead of falling to the page (#369 review).
                      aria-disabled={chosen.length === 0 || undefined}
                      aria-describedby={BULK_HINT_ID}
                      loading={ackMany.isPending}
                      onClick={() => {
                        if (chosen.length === 0) return;
                        if (chosen.length > MES_API_LIMITS.alarmAckBulk) {
                          setMessage({
                            kind: 'invalid',
                            text: `Select at most ${String(MES_API_LIMITS.alarmAckBulk)} alarms to acknowledge at once.`,
                          });
                          return;
                        }
                        ackMany.mutate(chosen.map((occurrence) => occurrence.id));
                      }}
                    >
                      Acknowledge selected ({chosen.length})
                    </Button>
                    <span id={BULK_HINT_ID} className="sr-only">
                      Select the alarms first; at most {MES_API_LIMITS.alarmAckBulk} at once.
                    </span>
                  </>
                ) : null}
                {message ? <ToolbarMessage message={message} testId="alarm-list-message" /> : null}
              </div>
            ) : null}
            {loaded.isError ? (
              <QueryError
                what={view === 'history' ? 'the alarm history' : `the ${view} alarms`}
                error={loaded.error}
                onRetry={() => void loaded.refetch()}
              />
            ) : (
              <DataTable
                caption={`${ALARM_VIEW_LABELS[view]} alarms, ${SORT_TEXT[sort].caption}${view === 'history' ? ', the last 24 hours' : ''}`}
                testId="alarm-table"
                columns={alarmColumns(machineName, clock?.watermark, panelOpen && wide)}
                rows={noClock ? [] : shown}
                rowKey={(occurrence) => occurrence.id}
                rowTestId={(occurrence) => `alarm-row-${occurrence.id}`}
                rowProps={(occurrence) => ({
                  'data-state': occurrence.state,
                  'data-priority': occurrence.priority,
                  'data-code': occurrence.code,
                  'data-equipment': occurrence.equipment,
                  'data-shelved': String(isShelved(occurrence, set.points)),
                })}
                rowTone={(occurrence) =>
                  unacknowledged(occurrence) ? PRIORITY_TONE[occurrence.priority] : undefined
                }
                rowEmphasis={needsAction}
                activeRowKey={search.alarm}
                {...(bulk
                  ? {
                      selection: {
                        selected,
                        onChange: setSelected,
                        selectable: acknowledgeable,
                        label: (occurrence: AlarmOccurrenceDto) =>
                          `Select ${alarmLabel(occurrence, machineName(occurrence.equipment))}`,
                        allLabel: 'Select every alarm that can be acknowledged',
                        testId: 'select-all',
                        rowTestId: (occurrence: AlarmOccurrenceDto) => `select-${occurrence.id}`,
                      },
                    }
                  : {})}
                actions={rowActions}
                skipToDetails={panelOpen && wide ? PANEL_TITLE_ID : undefined}
                announceRemoval={(left) =>
                  `The alarm left the ${ALARM_VIEW_LABELS[view]} list; ${left === 0 ? 'no alarms remain' : `${plural(left, 'alarm')} ${left === 1 ? 'remains' : 'remain'}`}.`
                }
                narrow="stack"
                loading={
                  !noClock && loaded.isPending && shown.length === 0 ? 'Loading alarms…' : undefined
                }
                empty={
                  <EmptyState
                    testId="alarm-list-empty"
                    icon={noClock ? 'clock' : 'check'}
                    title={empty.title}
                    body={empty.body}
                  />
                }
              />
            )}
          </TabPanel>
        </div>
        {selectedOccurrence ? (
          <DetailPanel
            testId="alarm-panel"
            data-alarm={selectedOccurrence.id}
            closeTestId="close-alarm"
            titleId={PANEL_TITLE_ID}
            focusKey={selectedOccurrence.id}
            returnFocus={() => document.getElementById(TITLE_ID)}
            title={
              selectedOccurrence.text ?? linked.data?.definition?.text ?? selectedOccurrence.code
            }
            description={
              <>
                {machineName(selectedOccurrence.equipment)} ·{' '}
                <Code className="whitespace-nowrap">{selectedOccurrence.code}</Code>
              </>
            }
            onClose={closeDetail}
          >
            <AlarmDetail
              key={selectedOccurrence.id}
              occurrence={selectedOccurrence}
              point={set.points.get(
                pointKey(selectedOccurrence.equipment, selectedOccurrence.code),
              )}
              machineName={machineName(selectedOccurrence.equipment)}
            />
          </DetailPanel>
        ) : null}
      </div>
    </section>
  );
}
