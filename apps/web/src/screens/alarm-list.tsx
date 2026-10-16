import {
  ALARM_VIEWS,
  MES_API_LIMITS,
  type AlarmOccurrenceDto,
  type AlarmPointDto,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
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
import { queryKeys, usePlantClock } from '../api/queries.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { PriorityBadge } from '../components/priority-badge.tsx';
import { QueryError } from '../components/query-error.tsx';
import {
  ALARM_VIEW_LABELS,
  FLOOD_THRESHOLD,
  SHELVE_PRESETS,
  ackFailure,
  acknowledgeable,
  commentFailure,
  endReasonText,
  mergeAlarms,
  newerOccurrence,
  newerShelf,
  partition,
  pointKey,
  shelfFailure,
  stateText,
  type AlarmView,
} from '../domain/alarms.ts';
import { loadCodedBy, saveCodedBy } from '../domain/downtime.ts';
import { formatClockSeconds, formatDuration, formatPlantTime } from '../domain/time.ts';
import type { WriteFailure } from '../domain/writes.ts';
import { dropLiveOccurrences, upsertOccurrence, upsertPoint } from '../live/live-cache.ts';
import {
  useLiveAlarmKpi,
  useLiveAlarms,
  useAlarmsTopic,
  useLiveSubscriptions,
} from '../live/live-context.tsx';

const inputClass = 'rounded border border-slate-500 bg-white px-2 py-1 text-sm';
const buttonClass =
  'rounded border border-slate-700 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-60';
const primaryClass =
  'rounded border border-sky-900 bg-sky-800 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-60';

const HOUR = 3_600_000;
/** How far back the History tab reads (the API allows at most 7 days). */
export const HISTORY_MS = 24 * HOUR;

type Message = WriteFailure | { readonly kind: 'saved'; readonly text: string };

const NO_ACTOR: Message = {
  kind: 'invalid',
  text: 'Enter your name under Operator first: every alarm action is recorded with it.',
};

function MessageLine({ message, testId }: { readonly message: Message; readonly testId: string }) {
  return (
    <p
      role={message.kind === 'saved' ? 'status' : 'alert'}
      data-testid={testId}
      data-kind={message.kind}
      className={`rounded border p-2 text-sm ${
        message.kind === 'saved'
          ? 'border-emerald-800 bg-emerald-50 text-emerald-950'
          : 'border-red-800 bg-red-50 text-red-950'
      }`}
    >
      {message.text}
    </p>
  );
}

// ---- Flood banner ----

/** One position's flood banner, shown while `alarm-kpi:position:<id>` reports an open episode. */
function FloodBanner({ id, name }: { readonly id: string; readonly name: string }) {
  const floods = useLiveAlarmKpi(`position:${id}`)?.floods ?? [];
  const episode = floods[0];
  if (!episode) return null;
  return (
    <div
      data-testid={`flood-banner-${id}`}
      data-episode={episode.id}
      className="rounded border-2 border-red-800 bg-red-50 p-3 text-red-950"
    >
      <p role="alert" className="font-semibold">
        <span aria-hidden="true">⚠ </span>Alarm flood in {name} since{' '}
        <time dateTime={episode.startAt}>{formatClockSeconds(episode.startAt)}</time>
      </p>
      <p className="text-sm">
        Up to {episode.peak} raises in 10 minutes (more than {FLOOD_THRESHOLD} is a flood),{' '}
        {episode.raises} since the flood began. Deal with the highest priority first.
      </p>
    </div>
  );
}

// ---- The occurrence panel ----

function ShelfSection({
  occurrence,
  point,
  detailShelf,
  actor,
  onWrite,
}: {
  readonly occurrence: AlarmOccurrenceDto;
  readonly point: AlarmPointDto | undefined;
  readonly detailShelf: AlarmPointDto['shelf'] | undefined;
  readonly actor: string;
  readonly onWrite: (message: Message) => void;
}) {
  const queryClient = useQueryClient();
  const shelf = newerShelf(point?.shelf, detailShelf);
  const reasonId = useId();
  const durationId = useId();
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState(String(SHELVE_PRESETS[0]?.ms ?? 900_000));
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
            actor: actor.trim(),
            reason: reason.trim(),
            durationMs: Number(duration),
            version,
          })
        : unshelvePoint(occurrence.equipment, occurrence.code, { actor: actor.trim(), version }),
    onSuccess: (result, { action }) => {
      saveCodedBy(actor);
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
    if (actor.trim() === '') {
      onWrite(NO_ACTOR);
      return;
    }
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
    if (action === 'shelve' && reason.trim() === '') {
      onWrite({ kind: 'invalid', text: 'Enter a reason for shelving.' });
      return;
    }
    write.mutate({ action, version });
  };

  return (
    <section aria-labelledby={`${reasonId}-title`} className="mt-4" data-testid="shelf-section">
      <h3 id={`${reasonId}-title`} className="font-semibold">
        Shelf of {occurrence.equipment} {occurrence.code}
      </h3>
      <p className="text-xs text-slate-700">
        Shelving hides the point&apos;s alarms from the active list for a time of plant time; the
        KPIs still count them.
      </p>
      {shelf === undefined ? <p className="text-sm">Loading the shelf…</p> : null}
      {stale ? (
        <div
          role="alert"
          data-testid="shelf-conflict"
          data-kind="conflict"
          className="mt-2 rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          <p>
            The shelf changed while this panel was open (version {base} → {shelf.version}). Nothing
            is sent until you reload it.
          </p>
          <button
            type="button"
            data-testid="reload-shelf"
            className={`${buttonClass} mt-2`}
            onClick={() => {
              setBase(undefined);
            }}
          >
            Reload the shelf
          </button>
        </div>
      ) : null}
      {shelf?.shelved ? (
        <div className="mt-2 flex flex-col gap-2 text-sm">
          <p data-testid="shelf-state" data-shelved="true" data-version={shelf.version}>
            Shelved by {shelf.by ?? '–'}
            {shelf.reason ? ` (“${shelf.reason}”)` : ''} until{' '}
            {shelf.until ? <time dateTime={shelf.until}>{formatPlantTime(shelf.until)}</time> : '–'}{' '}
            plant time.
          </p>
          <div>
            <button
              type="button"
              data-testid="unshelve"
              className={buttonClass}
              disabled={write.isPending}
              onClick={() => {
                submit('unshelve');
              }}
            >
              {write.isPending ? 'Unshelving…' : 'Unshelve'}
            </button>
          </div>
        </div>
      ) : null}
      {shelf && !shelf.shelved ? (
        <form
          noValidate
          aria-label="Shelve the point"
          className="mt-2 flex flex-wrap items-end gap-2"
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
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={reasonId} className="text-xs font-medium text-slate-700">
              Reason
            </label>
            <input
              id={reasonId}
              data-testid="shelve-reason"
              value={reason}
              maxLength={MES_API_LIMITS.shelveReason}
              onChange={(event) => {
                startDraft();
                setReason(event.target.value);
              }}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={durationId} className="text-xs font-medium text-slate-700">
              For (plant time)
            </label>
            <select
              id={durationId}
              data-testid="shelve-duration"
              value={duration}
              onChange={(event) => {
                startDraft();
                setDuration(event.target.value);
              }}
              className={inputClass}
            >
              {SHELVE_PRESETS.map((preset) => (
                <option key={preset.ms} value={String(preset.ms)}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            data-testid="shelve"
            className={buttonClass}
            disabled={write.isPending}
          >
            {write.isPending ? 'Shelving…' : 'Shelve'}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function CommentForm({
  id,
  actor,
  onWrite,
}: {
  readonly id: string;
  readonly actor: string;
  readonly onWrite: (message: Message) => void;
}) {
  const queryClient = useQueryClient();
  const textId = useId();
  const [text, setText] = useState('');
  const write = useMutation({
    mutationFn: () => commentAlarm(id, { actor: actor.trim(), text: text.trim() }),
    onSuccess: (result) => {
      saveCodedBy(actor);
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
      className="mt-2 flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (actor.trim() === '') onWrite(NO_ACTOR);
        else if (text.trim() === '') onWrite({ kind: 'invalid', text: 'Write a comment first.' });
        else write.mutate();
      }}
    >
      <label htmlFor={textId} className="text-xs font-medium text-slate-700">
        New comment
      </label>
      <textarea
        id={textId}
        data-testid="comment-text"
        value={text}
        rows={2}
        maxLength={MES_API_LIMITS.alarmComment}
        onChange={(event) => {
          setText(event.target.value);
        }}
        className={inputClass}
      />
      <div>
        <button
          type="submit"
          data-testid="add-comment"
          className={buttonClass}
          disabled={write.isPending}
        >
          {write.isPending ? 'Adding…' : 'Add comment'}
        </button>
      </div>
    </form>
  );
}

function AlarmHistoryList({ id }: { readonly id: string }) {
  const history = useQuery({
    queryKey: queryKeys.alarmHistory(id),
    queryFn: ({ signal }) => getAlarmHistory(id, signal),
  });
  return (
    <section aria-labelledby="alarm-history-title" className="mt-4" data-testid="alarm-history">
      <h3 id="alarm-history-title" className="font-semibold">
        History
      </h3>
      {history.isPending ? <p className="text-sm">Loading history…</p> : null}
      {history.isError ? (
        <QueryError
          what="the history"
          error={history.error}
          onRetry={() => void history.refetch()}
        />
      ) : null}
      <ol className="mt-1 flex flex-col gap-1 text-sm">
        {history.data?.entries.map((entry, index) => (
          <li
            key={`${entry.source}-${entry.transition}-${String(entry.auditId ?? entry.seq ?? index)}`}
            data-testid="history-entry"
            data-transition={entry.transition}
            data-source={entry.source}
            className="rounded bg-slate-50 p-2"
          >
            <span className="font-semibold">{entry.transition}</span>{' '}
            <time dateTime={entry.at}>{formatPlantTime(entry.at)}</time> (plant time)
            {entry.source === 'audit' ? (
              <>
                {' '}
                by {entry.actor ?? '–'}
                {entry.authenticated === false ? ' (not authenticated)' : ''}
                {entry.requestId ? (
                  <span className="text-xs text-slate-700"> · request {entry.requestId}</span>
                ) : null}
              </>
            ) : (
              <span className="text-xs text-slate-700">
                {' '}
                · {entry.source}
                {entry.seq === null ? '' : ` seq ${String(entry.seq)}`}
                {entry.protocol ? ` · ${entry.protocol}` : ''}
                {entry.receivedAt
                  ? ` · received ${formatClockSeconds(entry.receivedAt)} (wall time)`
                  : ''}
              </span>
            )}
            {entry.transition === 'comment' && typeof entry.detail?.text === 'string' ? (
              <p className="text-slate-800">“{entry.detail.text}”</p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function AlarmPanel({
  occurrence,
  point,
  machineName,
  actor,
  onClose,
}: {
  readonly occurrence: AlarmOccurrenceDto;
  readonly point: AlarmPointDto | undefined;
  readonly machineName: string;
  readonly actor: string;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const ackCommentId = useId();
  const [ackComment, setAckComment] = useState('');
  const detail = useQuery({
    queryKey: queryKeys.alarm(occurrence.id),
    queryFn: ({ signal }) => getAlarm(occurrence.id, signal),
  });
  useEffect(() => {
    heading.current?.focus();
  }, [occurrence.id]);

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
        actor: actor.trim(),
        ...(ackComment.trim() === '' ? {} : { comment: ackComment.trim() }),
      }),
    onSuccess: (result) => {
      saveCodedBy(actor);
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
  return (
    <section
      aria-labelledby="alarm-panel-title"
      data-testid="alarm-panel"
      data-alarm={occurrence.id}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      className="min-w-0 rounded-lg border border-slate-300 bg-white p-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="alarm-panel-title" ref={heading} tabIndex={-1} className="text-lg font-semibold">
          {machineName}: {occurrence.code}
        </h2>
        <button type="button" data-testid="close-alarm" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-slate-700">Priority</dt>
        <dd>
          <PriorityBadge priority={occurrence.priority} />{' '}
          <span className="text-slate-700">
            severity {occurrence.severity}
            {occurrence.defined ? '' : ', no definition'}
          </span>
        </dd>
        <dt className="text-slate-700">Text</dt>
        <dd>{occurrence.text ?? definition?.text ?? '–'}</dd>
        {definition?.consequence ? (
          <>
            <dt className="text-slate-700">Consequence</dt>
            <dd>{definition.consequence}</dd>
          </>
        ) : null}
        {definition?.response ? (
          <>
            <dt className="text-slate-700">Response</dt>
            <dd>{definition.response}</dd>
          </>
        ) : null}
        <dt className="text-slate-700">State</dt>
        <dd data-testid="alarm-state" data-state={occurrence.state}>
          {stateText(occurrence)}
          {(newerShelf(point?.shelf, detail.data?.shelf)?.shelved ?? occurrence.shelved)
            ? ', point shelved'
            : ''}
        </dd>
        <dt className="text-slate-700">Raised</dt>
        <dd>
          <time dateTime={occurrence.raisedAt}>{formatPlantTime(occurrence.raisedAt)}</time>
          {occurrence.source === 'anchor' ? ' (from a retained delivery)' : ''}
        </dd>
        <dt className="text-slate-700">Ended</dt>
        <dd>
          {occurrence.endedAt ? (
            <>
              <time dateTime={occurrence.endedAt}>{formatPlantTime(occurrence.endedAt)}</time> (
              {formatDuration(Date.parse(occurrence.endedAt) - Date.parse(occurrence.raisedAt))}
              ),{' '}
            </>
          ) : null}
          {endReasonText(occurrence.endReason)}
        </dd>
        <dt className="text-slate-700">Acknowledged</dt>
        <dd>
          {occurrence.acknowledged ? (
            <>
              by {occurrence.acknowledged.by} (not authenticated) at{' '}
              <time dateTime={occurrence.acknowledged.at}>
                {formatPlantTime(occurrence.acknowledged.at)}
              </time>{' '}
              (wall time)
              {occurrence.acknowledged.comment ? ` – “${occurrence.acknowledged.comment}”` : ''}
            </>
          ) : (
            'no'
          )}
        </dd>
        <dt className="text-slate-700">Final</dt>
        <dd>{occurrence.final ? 'yes' : 'no, may still change'}</dd>
      </dl>
      {detail.isError ? (
        <div className="mt-2">
          <QueryError what="the alarm" error={detail.error} onRetry={() => void detail.refetch()} />
        </div>
      ) : null}
      {message ? (
        <div className="mt-3">
          <MessageLine message={message} testId="alarm-message" />
        </div>
      ) : null}
      {acknowledgeable(occurrence) ? (
        <form
          noValidate
          aria-label="Acknowledge the alarm"
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (actor.trim() === '') setMessage(NO_ACTOR);
            else ack.mutate();
          }}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={ackCommentId} className="text-xs font-medium text-slate-700">
              Comment with the acknowledgement (optional)
            </label>
            <input
              id={ackCommentId}
              data-testid="ack-comment"
              value={ackComment}
              maxLength={MES_API_LIMITS.alarmComment}
              onChange={(event) => {
                setAckComment(event.target.value);
              }}
              className={inputClass}
            />
          </div>
          <button
            type="submit"
            data-testid="ack-detail"
            className={primaryClass}
            disabled={ack.isPending}
          >
            {ack.isPending ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        </form>
      ) : null}
      <ShelfSection
        key={pointKey(occurrence.equipment, occurrence.code)}
        occurrence={occurrence}
        point={point}
        detailShelf={detail.data?.shelf}
        actor={actor}
        onWrite={setMessage}
      />
      <section aria-labelledby="alarm-comments-title" className="mt-4" data-testid="comments">
        <h3 id="alarm-comments-title" className="font-semibold">
          Comments ({occurrence.comments})
        </h3>
        <ol className="mt-1 flex flex-col gap-1 text-sm">
          {detail.data?.comments.map((comment) => (
            <li key={comment.id} data-testid="comment" className="rounded bg-slate-50 p-2">
              <p>{comment.text}</p>
              <p className="text-xs text-slate-700">
                {comment.actor} (not authenticated),{' '}
                <time dateTime={comment.at}>{formatPlantTime(comment.at)}</time> (wall time)
              </p>
            </li>
          ))}
        </ol>
        <CommentForm id={occurrence.id} actor={actor} onWrite={setMessage} />
      </section>
      <AlarmHistoryList id={occurrence.id} />
    </section>
  );
}

// ---- The list ----

function Tabs({
  view,
  counts,
  onChange,
}: {
  readonly view: AlarmView;
  readonly counts: Readonly<Partial<Record<AlarmView, number | undefined>>>;
  readonly onChange: (view: AlarmView) => void;
}) {
  const refs = useRef<Partial<Record<AlarmView, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent, index: number) => {
    const last = ALARM_VIEWS.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const target = ALARM_VIEWS[next];
    if (target === undefined) return;
    onChange(target);
    refs.current[target]?.focus();
  };
  return (
    <div role="tablist" aria-label="Alarm lists" className="flex flex-wrap gap-1">
      {ALARM_VIEWS.map((name, index) => {
        const selected = name === view;
        const count = counts[name];
        return (
          <button
            key={name}
            ref={(element) => {
              refs.current[name] = element;
            }}
            type="button"
            role="tab"
            id={`alarm-tab-${name}`}
            aria-selected={selected}
            aria-controls="alarm-tabpanel"
            tabIndex={selected ? 0 : -1}
            data-testid={`tab-${name}`}
            data-count={count}
            onClick={() => {
              onChange(name);
            }}
            onKeyDown={(event) => {
              move(event, index);
            }}
            className={`rounded-t border border-b-0 px-3 py-1.5 text-sm ${
              selected
                ? 'border-slate-700 bg-white font-semibold underline underline-offset-4'
                : 'border-slate-300 bg-slate-100 hover:bg-white'
            }`}
          >
            {ALARM_VIEW_LABELS[name]}
            {count === undefined ? '' : ` (${String(count)})`}
          </button>
        );
      })}
    </div>
  );
}

export function AlarmList() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const search = useSearch({ from: '/alarms' });
  const navigate = useNavigate({ from: '/alarms' });
  const queryClient = useQueryClient();
  const view: AlarmView = search.view ?? 'active';
  const actorId = useId();
  const [actor, setActor] = useState(loadCodedBy);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const selectAll = useRef<HTMLInputElement>(null);
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
  const shown = views[view];
  const loaded = { active, acknowledged, shelved, history }[view];
  const selectable = shown.filter(acknowledgeable);
  const chosen = selectable.filter((occurrence) => selected.has(occurrence.id));
  const all = chosen.length > 0 && chosen.length === selectable.length;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = chosen.length > 0 && !all;
  }, [chosen.length, all]);

  const machineName = (id: string) => equipment.data?.find((item) => item.id === id)?.name ?? id;
  // The chosen occurrence: from the lists, or read by id (a link to one outside them); the
  // panel shares this read.
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
    saveCodedBy(actor);
    void queryClient.invalidateQueries({ queryKey: queryKeys.alarmsAll });
    void queryClient.invalidateQueries({ queryKey: ['alarm'] });
    void queryClient.invalidateQueries({ queryKey: ['alarm-history'] });
  };
  const ackOne = useMutation({
    mutationFn: (id: string) => acknowledgeAlarm(id, { actor: actor.trim() }),
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
    mutationFn: (ids: string[]) => acknowledgeAlarms({ ids, actor: actor.trim() }),
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

  const needActor = (): boolean => {
    if (actor.trim() !== '') return false;
    setMessage(NO_ACTOR);
    document.getElementById(actorId)?.focus();
    return true;
  };

  const toggle = (id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const counts = {
    active: active.data ? views.active.length : undefined,
    acknowledged: acknowledged.data ? views.acknowledged.length : undefined,
    shelved: shelved.data ? views.shelved.length : undefined,
  };
  const truncated = [active, acknowledged, shelved, history].some(
    (query) => query.data?.next !== null && query.data?.next !== undefined,
  );

  return (
    <section aria-labelledby="alarms-title">
      <h1 ref={heading} id="alarms-title" tabIndex={-1} className="text-2xl font-bold">
        Alarms
      </h1>
      <div className="mt-3 flex flex-col gap-2">
        {positions.map((position) => (
          <FloodBanner key={position.id} id={position.id} name={position.name} />
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor={actorId} className="text-sm font-medium">
          Operator
        </label>
        <input
          id={actorId}
          data-testid="operator-name"
          value={actor}
          maxLength={MES_API_LIMITS.alarmActor}
          autoComplete="name"
          onChange={(event) => {
            setActor(event.target.value);
          }}
          className={`${inputClass} max-w-xs`}
        />
        <p className="text-xs text-slate-700">
          Recorded as typed with every acknowledgement, shelf and comment, not authenticated (until
          login comes). Remembered on this browser.
        </p>
      </div>
      {[
        { what: 'the active alarms', query: active },
        { what: 'the acknowledged alarms', query: acknowledged },
        { what: 'the shelved alarms', query: shelved },
        { what: 'the alarm history', query: history },
        { what: 'the alarm points', query: points },
      ].map(({ what, query }) =>
        query.isError ? (
          <div key={what} className="mt-4">
            <QueryError what={what} error={query.error} onRetry={() => void query.refetch()} />
          </div>
        ) : null,
      )}
      {truncated ? (
        <p role="note" className="mt-4 rounded border border-amber-700 p-2 text-sm">
          More alarms than one answer holds ({MES_API_LIMITS.alarmPageMax}): the list is cut off.
        </p>
      ) : null}
      {message ? (
        <div className="mt-3">
          <MessageLine message={message} testId="alarm-list-message" />
        </div>
      ) : null}
      {search.alarm !== undefined && selectedOccurrence === undefined && linked.isError ? (
        <div className="mt-4">
          <QueryError what="the alarm" error={linked.error} onRetry={() => void linked.refetch()} />
        </div>
      ) : null}

      <div className="mt-4">
        <Tabs
          view={view}
          counts={counts}
          onChange={(next) => {
            setMessage(undefined);
            // A selection belongs to the rows of one tab: never acknowledge what isn't shown.
            setSelected(new Set());
            void navigate({ search: (previous) => ({ ...previous, view: next }) });
          }}
        />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div
          role="tabpanel"
          id="alarm-tabpanel"
          aria-labelledby={`alarm-tab-${view}`}
          data-testid="alarm-list"
          data-view={view}
          className="min-w-0 rounded-b-lg rounded-tr-lg border border-slate-300 bg-white"
        >
          {view === 'active' || view === 'shelved' ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-2">
              <button
                type="button"
                data-testid="ack-selected"
                className={primaryClass}
                disabled={chosen.length === 0 || ackMany.isPending}
                onClick={() => {
                  if (needActor()) return;
                  if (chosen.length > MES_API_LIMITS.alarmAckBulk) {
                    setMessage({
                      kind: 'invalid',
                      text: `Select at most ${String(MES_API_LIMITS.alarmAckBulk)} alarms to acknowledge at once.`,
                    });
                    return;
                  }
                  setMessage(undefined);
                  ackMany.mutate(chosen.map((occurrence) => occurrence.id));
                }}
              >
                {ackMany.isPending
                  ? 'Acknowledging…'
                  : `Acknowledge selected (${String(chosen.length)})`}
              </button>
              <span className="text-xs text-slate-700">
                At most {MES_API_LIMITS.alarmAckBulk} at once.
              </span>
            </div>
          ) : null}
          {loaded.isPending && (view !== 'history' || historyTo !== undefined) ? (
            <p className="p-3">Loading alarms…</p>
          ) : null}
          {view === 'history' && historyTo === undefined ? (
            <p className="p-3">No plant clock yet: there is no history to read.</p>
          ) : null}
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="sr-only">
                {ALARM_VIEW_LABELS[view]} alarms, newest raise first
                {view === 'history' ? ', the last 24 hours' : ''}
              </caption>
              <thead className="bg-slate-100 text-left">
                <tr>
                  <th scope="col" className="w-8 px-2 py-1">
                    <input
                      ref={selectAll}
                      type="checkbox"
                      data-testid="select-all"
                      aria-label="Select every alarm that can be acknowledged"
                      disabled={selectable.length === 0}
                      checked={all}
                      onChange={(event) => {
                        const on = event.target.checked;
                        setSelected(
                          new Set(on ? selectable.map((occurrence) => occurrence.id) : []),
                        );
                      }}
                    />
                  </th>
                  <th scope="col" className="px-2 py-1">
                    Priority
                  </th>
                  <th scope="col" className="px-2 py-1">
                    Machine
                  </th>
                  <th scope="col" className="px-2 py-1">
                    Alarm
                  </th>
                  <th scope="col" className="px-2 py-1">
                    Raised
                  </th>
                  <th scope="col" className="px-2 py-1">
                    State
                  </th>
                  <th scope="col" className="px-2 py-1">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((occurrence) => {
                  const name = machineName(occurrence.equipment);
                  const canAck = acknowledgeable(occurrence);
                  return (
                    <tr
                      key={occurrence.id}
                      data-testid={`alarm-row-${occurrence.id}`}
                      data-state={occurrence.state}
                      data-priority={occurrence.priority}
                      data-code={occurrence.code}
                      data-equipment={occurrence.equipment}
                      aria-current={occurrence.id === search.alarm ? 'true' : undefined}
                      className={`border-t border-slate-200 ${occurrence.id === search.alarm ? 'bg-sky-50' : ''}`}
                    >
                      <td className="px-2 py-1">
                        {canAck ? (
                          <input
                            type="checkbox"
                            data-testid={`select-${occurrence.id}`}
                            aria-label={`Select ${occurrence.code} on ${name}`}
                            checked={selected.has(occurrence.id)}
                            onChange={(event) => {
                              toggle(occurrence.id, event.target.checked);
                            }}
                          />
                        ) : null}
                      </td>
                      <td className="px-2 py-1">
                        <PriorityBadge priority={occurrence.priority} />
                      </td>
                      <td className="px-2 py-1">{name}</td>
                      <td className="px-2 py-1">
                        <span className="whitespace-nowrap font-mono text-xs">
                          {occurrence.code}
                        </span>
                        {occurrence.text ? (
                          <span className="block text-slate-800">{occurrence.text}</span>
                        ) : null}
                      </td>
                      <td className="px-2 py-1 tabular-nums">
                        <time dateTime={occurrence.raisedAt}>
                          {formatClockSeconds(occurrence.raisedAt)}
                        </time>
                      </td>
                      <td className="px-2 py-1">
                        {stateText(occurrence)}
                        {occurrence.comments > 0 ? (
                          <span className="block text-xs text-slate-700">
                            {occurrence.comments} comment{occurrence.comments === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex flex-wrap gap-1">
                          {canAck ? (
                            <button
                              type="button"
                              data-testid={`ack-${occurrence.id}`}
                              className={buttonClass}
                              disabled={ackOne.isPending}
                              aria-label={`Acknowledge ${occurrence.code} on ${name}`}
                              onClick={() => {
                                if (needActor()) return;
                                setMessage(undefined);
                                ackOne.mutate(occurrence.id);
                              }}
                            >
                              Acknowledge
                            </button>
                          ) : null}
                          <button
                            type="button"
                            data-testid={`details-${occurrence.id}`}
                            className={buttonClass}
                            aria-label={`Details of ${occurrence.code} on ${name}`}
                            onClick={() => {
                              void navigate({
                                search: (previous) => ({ ...previous, alarm: occurrence.id }),
                              });
                            }}
                          >
                            Details
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {loaded.data && shown.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-2 py-3" data-testid="alarm-list-empty">
                      {view === 'history'
                        ? 'No closed alarms in the last 24 hours.'
                        : `No ${ALARM_VIEW_LABELS[view].toLowerCase()} alarms.`}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        {/* Before the list on narrow screens, beside it and in view on wide ones. */}
        <div className="order-first min-w-0 lg:sticky lg:top-4 lg:order-none">
          {selectedOccurrence ? (
            <AlarmPanel
              key={selectedOccurrence.id}
              occurrence={selectedOccurrence}
              point={set.points.get(
                pointKey(selectedOccurrence.equipment, selectedOccurrence.code),
              )}
              machineName={machineName(selectedOccurrence.equipment)}
              actor={actor}
              onClose={() => {
                const id = selectedOccurrence.id;
                void navigate({ search: (previous) => ({ ...previous, alarm: undefined }) }).then(
                  () => {
                    // Back to the row's Details button (ids are validated: no quote can occur).
                    const button = document.querySelector<HTMLElement>(
                      `[data-testid="details-${id}"]`,
                    );
                    (button ?? document.getElementById('alarms-title'))?.focus();
                  },
                );
              }}
            />
          ) : (
            <p className="hidden rounded-lg border border-dashed border-slate-400 p-4 text-sm lg:block">
              Choose an alarm to see its details, history and actions.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
