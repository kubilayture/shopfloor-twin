import {
  HOLD_STATES,
  HOLD_SUBJECT_KINDS,
  type HoldDetailDto,
  type HoldDto,
  type HoldState,
  type HoldSubjectDto,
  type HoldSubjectKind,
  type HoldSuggestionDto,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import {
  commentHold,
  decideHold,
  getHold,
  getHoldReasons,
  getHoldSuggestion,
  getHolds,
  holdFilterKey,
  openHold,
  qualityKeys,
  type HoldFilter,
} from '../api/quality.ts';
import { useCan, useUnsavedDraft } from '../auth/auth.tsx';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import {
  CommentInput,
  FailureMessage,
  HoldStateBadge,
  Section,
  Table,
  buttonClass,
  cell,
  inputClass,
  primaryClass,
  timeOf,
} from '../components/quality-ui.tsx';
import {
  COMMENT_MAX,
  HOLD_STATE_TEXT,
  SUBJECT_TEXT,
  commentProblem,
  isStale,
  mergeHolds,
  newestHold,
  qualityFailure,
  reasonsFor,
  subjectFromSearch,
  subjectHref,
  subjectText,
  type QualityFailure,
} from '../domain/quality.ts';
import { useLiveQuality, useQualityTopic } from '../live/live-context.tsx';
import { upsertHold } from '../live/live-quality.ts';

// `/quality/holds`, `/quality/holds/new` and `/quality/holds/$id` (#203, plan "Web", ADR-0035):
// the holds with filters, opening a hold on a lot, serial, carton or order (from a trace page, an
// order, or a signal's suggested scope), and one hold's detail with its scope (it grows with
// facts), transitions with their ERP notifications, incidents, and the actions: comment
// (`quality:hold`), release and reject (`quality:release`), each with the version read.

const HOLD_ID = /^[0-9a-fA-F-]{36}$/;

/** What a hold does and doesn't do, said on its pages (ADR-0035). */
function HoldEffect() {
  return (
    <p className="mt-2 text-sm text-slate-700" data-testid="hold-effect">
      An open hold refuses the close of every order with a unit in its scope; a carton is held while
      a member is in an open or rejected hold; the ERP is told of each opening, release and
      rejection. A hold never stops a machine: the line can keep using a held lot, which shows as
      held-material-consumed.
    </p>
  );
}

/** A link to the subject's own page (an order's detail, or its trace page). */
export function SubjectLink({ subject }: { readonly subject: HoldSubjectDto }) {
  if (subject.kind === 'order') {
    return (
      <Link
        to="/orders/$id"
        params={{ id: subject.id }}
        className="text-sky-800 underline"
        data-testid="hold-subject"
        data-kind={subject.kind}
      >
        {subjectText(subject)}
      </Link>
    );
  }
  // The trace pages (#202) are linked by URL: their routes live in another screen area.
  return (
    <a
      href={subjectHref(subject)}
      className="text-sky-800 underline"
      data-testid="hold-subject"
      data-kind={subject.kind}
    >
      {subjectText(subject)}
    </a>
  );
}

const scopeText = (scope: HoldDto['scope']): string =>
  `${String(scope.units)} unit${scope.units === 1 ? '' : 's'}, ${String(scope.cartons)} carton${scope.cartons === 1 ? '' : 's'}, ${String(scope.orders)} order${scope.orders === 1 ? '' : 's'}`;

// ---- The list ----

function HoldRow({ hold }: { readonly hold: HoldDto }) {
  return (
    <tr
      data-testid={`hold-row-${hold.id}`}
      data-state={hold.state}
      data-version={String(hold.version)}
      data-subject={`${hold.subject.kind}:${hold.subject.id}`}
      data-units={String(hold.scope.units)}
    >
      <td className={cell}>
        <SubjectLink subject={hold.subject} />
      </td>
      <td className={cell}>
        <HoldStateBadge state={hold.state} />
      </td>
      <td className={cell}>
        {hold.reason}
        {hold.decisionReason ? (
          <span className="block text-xs">decided: {hold.decisionReason}</span>
        ) : null}
      </td>
      <td className={cell}>
        {hold.openedBy}, {timeOf(hold.openedAt)}
      </td>
      <td className={cell}>{scopeText(hold.scope)}</td>
      <td className={cell}>{hold.heldMaterialConsumed}</td>
      <td className={cell}>
        <Link
          to="/quality/holds/$id"
          params={{ id: hold.id }}
          data-testid={`hold-link-${hold.id}`}
          className="text-sky-800 underline"
        >
          Details
        </Link>
      </td>
    </tr>
  );
}

/** A hold table (the list's, and an order's holds). */
export function HoldTable({
  holds,
  testId,
  caption,
}: {
  readonly holds: readonly HoldDto[];
  readonly testId: string;
  readonly caption: string;
}) {
  return (
    <Table
      testId={testId}
      caption={caption}
      columns={['Subject', 'State', 'Reason', 'Opened', 'Scope', 'Held material consumed', '']}
      count={holds.length}
    >
      {holds.map((hold) => (
        <HoldRow key={hold.id} hold={hold} />
      ))}
    </Table>
  );
}

export function HoldList() {
  useQualityTopic();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const search = useSearch({ from: '/quality/holds' });
  const navigate = useNavigate();
  const canHold = useCan('quality:hold');
  const subject = subjectFromSearch(search.kind, search.id);
  const filter: HoldFilter = { states: search.state ? [search.state] : [], subject };
  const read = useQuery({
    queryKey: qualityKeys.holds(holdFilterKey(filter)),
    queryFn: ({ signal }) => getHolds(filter, signal),
  });
  const live = useLiveQuality();
  const holds = read.data ? mergeHolds(read.data.holds, live, filter) : [];
  const [kind, setKind] = useState<HoldSubjectKind>(subject?.kind ?? 'lot');
  const [id, setId] = useState(subject?.id ?? '');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const stateId = useId();
  const kindId = useId();
  const idId = useId();
  return (
    <section aria-labelledby="holds-title" data-testid="hold-list-page">
      <h1 ref={heading} id="holds-title" tabIndex={-1} className="text-2xl font-bold">
        Quality holds
      </h1>
      <HoldEffect />
      {canHold ? (
        <p className="mt-2">
          <Link
            to="/quality/holds/new"
            search={{}}
            data-testid="hold-open-link"
            className={buttonClass}
          >
            Open a hold
          </Link>
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
        <label htmlFor={stateId} className="flex flex-col gap-1 font-medium">
          State
          <select
            id={stateId}
            data-testid="hold-filter-state"
            value={search.state ?? ''}
            className={inputClass}
            onChange={(event) => {
              const value = event.target.value;
              void navigate({
                to: '/quality/holds',
                search: { ...search, state: value === '' ? undefined : (value as HoldState) },
              });
            }}
          >
            <option value="">All</option>
            {HOLD_STATES.map((state) => (
              <option key={state} value={state}>
                {HOLD_STATE_TEXT[state]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={kindId} className="flex flex-col gap-1 font-medium">
          Subject
          <select
            id={kindId}
            data-testid="hold-filter-kind"
            value={kind}
            className={inputClass}
            onChange={(event) => {
              setKind(event.target.value as HoldSubjectKind);
            }}
          >
            {HOLD_SUBJECT_KINDS.map((k) => (
              <option key={k} value={k}>
                {SUBJECT_TEXT[k]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={idId} className="flex flex-col gap-1 font-medium">
          Id
          <input
            id={idId}
            data-testid="hold-filter-id"
            value={id}
            maxLength={64}
            className={inputClass}
            onChange={(event) => {
              setId(event.target.value);
            }}
          />
        </label>
        <button
          type="button"
          data-testid="hold-filter-apply"
          className={buttonClass}
          onClick={() => {
            const found = subjectFromSearch(kind, id.trim());
            if (!found) {
              setProblem('Not a valid id for this kind of subject.');
              return;
            }
            setProblem(undefined);
            void navigate({
              to: '/quality/holds',
              search: { ...search, kind: found.kind, id: found.id },
            });
          }}
        >
          Show this subject’s holds
        </button>
        {subject ? (
          <button
            type="button"
            data-testid="hold-filter-clear"
            className={buttonClass}
            onClick={() => {
              setId('');
              void navigate({ to: '/quality/holds', search: { state: search.state } });
            }}
          >
            Every subject
          </button>
        ) : null}
        {problem ? (
          <p role="alert" className="text-red-900" data-testid="hold-filter-problem">
            {problem}
          </p>
        ) : null}
      </div>
      {read.isPending ? <p className="mt-4">Loading the holds…</p> : null}
      {read.isError ? (
        <div className="mt-4">
          <QueryError what="the holds" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {read.data ? (
        holds.length === 0 ? (
          <p className="mt-4" data-testid="holds-empty">
            No hold matches.
          </p>
        ) : (
          <div className="mt-4">
            <HoldTable holds={holds} testId="hold-list" caption="Quality holds, newest first" />
            {read.data.truncated ? (
              <p className="mt-1 text-sm" data-testid="holds-truncated">
                More holds match than are listed; filter by state or subject.
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

// ---- Opening ----

interface OpenResult {
  readonly subject: HoldSubjectDto;
  readonly hold?: HoldDto;
  readonly failure?: QualityFailure;
}

const subjectKey = (s: HoldSubjectDto): string => `${s.kind}:${s.id}`;

/** The subjects a signal's suggested scope offers: its orders, cartons and serials. */
export function suggestedSubjects(suggestion: HoldSuggestionDto): HoldSubjectDto[] {
  const serials = [
    ...new Set(suggestion.units.flatMap((u) => (u.serial === null ? [] : [u.serial]))),
  ];
  return [
    ...suggestion.orders.map((id) => ({ kind: 'order' as const, id })),
    ...suggestion.cartons.map((id) => ({ kind: 'carton' as const, id })),
    ...serials.map((id) => ({ kind: 'serial' as const, id })),
  ].flatMap((s) => {
    const found = subjectFromSearch(s.kind, s.id);
    return found ? [found] : [];
  });
}

function Suggestion({
  suggestion,
  selected,
  setSelected,
}: {
  readonly suggestion: HoldSuggestionDto;
  readonly selected: ReadonlySet<string>;
  readonly setSelected: (next: Set<string>) => void;
}) {
  const subjects = suggestedSubjects(suggestion);
  return (
    <div
      data-testid="hold-suggestion"
      data-signal={String(suggestion.signal)}
      data-final={String(suggestion.final)}
      data-readings={String(suggestion.readings)}
      className="rounded border border-slate-400 bg-white p-3 text-sm"
    >
      <p>
        Episode {suggestion.signal} ({suggestion.chart}, rule {suggestion.rule}) on{' '}
        {suggestion.characteristic}: the {suggestion.readings} readings (every pass) after{' '}
        {suggestion.after ? timeOf(suggestion.after.at) : 'the start of its segment'} through{' '}
        {timeOf(suggestion.through.at)}, {suggestion.units.length} units in{' '}
        {suggestion.orders.length} orders and {suggestion.cartons.length} cartons.
      </p>
      {suggestion.final ? null : (
        <p className="mt-1 font-semibold text-amber-900" data-testid="hold-suggestion-provisional">
          The episode’s extent is not final yet: the window can still grow.
        </p>
      )}
      {subjects.length === 0 ? (
        <p className="mt-2" data-testid="hold-suggestion-empty">
          No unit of the window has a serial, an order or a carton to hold yet.
        </p>
      ) : (
        <fieldset className="mt-2">
          <legend className="font-medium">Hold these (one hold each)</legend>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {subjects.map((s) => {
              const key = subjectKey(s);
              return (
                <li key={key}>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      data-testid={`suggest-${s.kind}-${s.id}`}
                      checked={selected.has(key)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(key);
                        else next.delete(key);
                        setSelected(next);
                      }}
                    />
                    {subjectText(s)}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
    </div>
  );
}

export function HoldOpen() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const search = useSearch({ from: '/quality/holds/new' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canHold = useCan('quality:hold');
  useQualityTopic();
  const initial = subjectFromSearch(search.kind, search.id);
  const fromSignal = search.signal;
  const reasons = useQuery({
    queryKey: qualityKeys.reasons,
    queryFn: ({ signal }) => getHoldReasons(signal),
    staleTime: Infinity,
  });
  const suggestion = useQuery({
    queryKey: qualityKeys.suggestion(fromSignal ?? 0),
    queryFn: ({ signal }) => getHoldSuggestion(fromSignal ?? 0, signal),
    enabled: fromSignal !== undefined,
  });
  const [kind, setKind] = useState<HoldSubjectKind>(initial?.kind ?? 'lot');
  const [id, setId] = useState(initial?.id ?? '');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [problems, setProblems] = useState<string[]>([]);
  const [results, setResults] = useState<OpenResult[]>([]);
  const sending = useRef(false);
  const kindId = useId();
  const idId = useId();
  const reasonId = useId();
  const commentId = useId();
  useUnsavedDraft(
    comment.trim() !== '' || (fromSignal === undefined && id !== (initial?.id ?? '')),
  );
  const openReasons = reasons.data ? reasonsFor(reasons.data.reasons, 'open') : [];
  // The first listed reason until one is chosen.
  const chosenReason = reason === '' ? (openReasons[0]?.id ?? '') : reason;
  const write = useMutation({
    mutationFn: async (subjects: readonly HoldSubjectDto[]) => {
      const out: OpenResult[] = [];
      for (const subject of subjects) {
        try {
          const hold = await openHold({
            subject,
            reason: chosenReason,
            ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
          });
          upsertHold(queryClient, hold);
          out.push({ subject, hold });
        } catch (error) {
          out.push({
            subject,
            failure: qualityFailure(error, {
              not: 'Not opened',
              what: 'this hold',
              thing: 'hold',
            }),
          });
        }
      }
      return out;
    },
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: (out) => {
      setResults(out);
      void queryClient.invalidateQueries({ queryKey: qualityKeys.holdsAll });
      const [only] = out;
      if (out.length === 1 && only?.hold && fromSignal === undefined) {
        void navigate({ to: '/quality/holds/$id', params: { id: only.hold.id } });
      }
    },
  });
  const subjectsToOpen = (): HoldSubjectDto[] | string[] => {
    if (fromSignal !== undefined) {
      const offered = suggestion.data ? suggestedSubjects(suggestion.data) : [];
      const chosen = offered.filter((s) => selected.has(subjectKey(s)));
      return chosen.length === 0 ? ['Choose at least one subject to hold.'] : chosen;
    }
    const found = subjectFromSearch(kind, id.trim());
    return found ? [found] : ['Give a valid id for this kind of subject.'];
  };
  if (!canHold) {
    return (
      <section aria-labelledby="hold-open-title">
        <h1 ref={heading} id="hold-open-title" tabIndex={-1} className="text-2xl font-bold">
          Open a quality hold
        </h1>
        <p className="mt-2" data-testid="hold-open-forbidden">
          Your role cannot open holds (quality and supervisors can).
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="hold-open-title" data-testid="hold-open-page">
      <p className="text-sm">
        <Link to="/quality/holds" search={{}} className="text-sky-800 underline">
          All holds
        </Link>
      </p>
      <h1 ref={heading} id="hold-open-title" tabIndex={-1} className="mt-1 text-2xl font-bold">
        Open a quality hold
      </h1>
      <HoldEffect />
      <form
        noValidate
        aria-label="Open a quality hold"
        data-testid="hold-open-form"
        className="mt-3 flex max-w-3xl flex-col gap-3 rounded-lg border border-slate-400 bg-white p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (sending.current) return;
          const subjects = subjectsToOpen();
          const found: string[] = subjects.filter((s): s is string => typeof s === 'string');
          if (chosenReason === '') found.push('Choose a reason.');
          const bad = commentProblem(comment, false);
          if (bad) found.push(bad);
          setProblems(found);
          if (found.length > 0) return;
          setResults([]);
          sending.current = true;
          write.mutate(subjects as HoldSubjectDto[]);
        }}
      >
        {fromSignal !== undefined ? (
          suggestion.isPending ? (
            <p>Loading the episode’s suggested scope…</p>
          ) : suggestion.isError ? (
            suggestion.error instanceof ApiError && suggestion.error.status === 404 ? (
              <p role="alert" data-testid="hold-suggestion-missing">
                Episode {fromSignal} is unknown or withdrawn: it suggests no scope.
              </p>
            ) : (
              <QueryError
                what="the suggested scope"
                error={suggestion.error}
                onRetry={() => void suggestion.refetch()}
              />
            )
          ) : (
            <Suggestion
              suggestion={suggestion.data}
              selected={selected}
              setSelected={setSelected}
            />
          )
        ) : (
          <div className="flex flex-wrap gap-3">
            <label htmlFor={kindId} className="flex flex-col gap-1 text-sm font-medium">
              Subject
              <select
                id={kindId}
                data-testid="open-kind"
                value={kind}
                className={inputClass}
                onChange={(event) => {
                  setKind(event.target.value as HoldSubjectKind);
                }}
              >
                {HOLD_SUBJECT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SUBJECT_TEXT[k]}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={idId} className="flex flex-col gap-1 text-sm font-medium">
              {kind === 'order' ? 'Order number' : `${SUBJECT_TEXT[kind]} id`}
              <input
                id={idId}
                data-testid="open-id"
                value={id}
                maxLength={64}
                className={inputClass}
                onChange={(event) => {
                  setId(event.target.value);
                }}
              />
            </label>
          </div>
        )}
        <label htmlFor={reasonId} className="flex flex-col gap-1 text-sm font-medium">
          Reason
          <select
            id={reasonId}
            data-testid="open-reason"
            value={chosenReason}
            className={`${inputClass} max-w-md`}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          >
            {openReasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.id})
              </option>
            ))}
          </select>
        </label>
        {reasons.isError ? (
          <QueryError
            what="the hold reasons"
            error={reasons.error}
            onRetry={() => void reasons.refetch()}
          />
        ) : null}
        <CommentInput
          id={commentId}
          label="Comment"
          value={comment}
          testId="open-comment"
          max={COMMENT_MAX}
          required={false}
          onChange={setComment}
        />
        {problems.length > 0 ? (
          <p role="alert" className="text-sm text-red-900" data-testid="open-invalid">
            {problems.join(' ')}
          </p>
        ) : null}
        <div>
          <button
            type="submit"
            data-testid="open-submit"
            disabled={write.isPending}
            className={primaryClass}
          >
            {write.isPending
              ? 'Opening…'
              : fromSignal !== undefined
                ? `Open ${String(selected.size)} hold${selected.size === 1 ? '' : 's'}`
                : 'Open the hold'}
          </button>
        </div>
      </form>
      {results.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2" data-testid="open-results">
          {results.map((r) => (
            <li
              key={subjectKey(r.subject)}
              data-testid={`open-result-${r.subject.kind}-${r.subject.id}`}
              data-kind={r.hold ? 'opened' : (r.failure?.kind ?? 'failed')}
            >
              {r.hold ? (
                <p role="status" className="text-sm text-emerald-900">
                  {subjectText(r.subject)}: hold opened (
                  <Link
                    to="/quality/holds/$id"
                    params={{ id: r.hold.id }}
                    className="text-sky-800 underline"
                  >
                    details
                  </Link>
                  ), scope {scopeText(r.hold.scope)} so far.
                </p>
              ) : r.failure ? (
                <FailureMessage failure={r.failure} testId="open-message" />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---- One hold ----

type HoldAction = 'comment' | 'release' | 'reject';

const ACTION_TEXT: Readonly<Record<HoldAction, { label: string; effect: string; done: string }>> = {
  comment: {
    label: 'Comment',
    effect: 'Adds a comment to the hold (audited; the ERP is not told).',
    done: 'Comment added',
  },
  release: {
    label: 'Release',
    effect:
      'Releases the hold: the goods are used as is; it no longer blocks a close or its cartons. The ERP is told.',
    done: 'Hold released',
  },
  reject: {
    label: 'Reject',
    effect:
      'Rejects the goods: quality wants the units scrapped or reworked outside the MES. Quantities and confirmations don’t change; the cartons stay held; a close is no longer blocked by it. The ERP is told.',
    done: 'Hold rejected',
  },
};

interface HoldDraft {
  readonly action: HoldAction;
  /** The hold's version it started on. */
  readonly version: number;
  readonly reason: string;
  readonly comment: string;
}

function HoldForm({
  hold,
  initial,
  reasons,
  onClose,
  onRead,
}: {
  readonly hold: HoldDto;
  readonly initial: HoldDraft;
  readonly reasons: readonly { id: string; name: string }[];
  readonly onClose: (done?: string) => void;
  readonly onRead: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [failure, setFailure] = useState<QualityFailure | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const sending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const commentId = useId();
  const reasonId = useId();
  useUnsavedDraft(draft.comment.trim() !== '');
  useEffect(() => {
    form.current?.focus();
  }, []);
  // The first listed reason until one is chosen.
  const reason = draft.reason === '' ? (reasons[0]?.id ?? '') : draft.reason;
  const stale = isStale(draft.version, hold.version);
  const applies = draft.action === 'comment' || hold.state === 'open';
  const text = ACTION_TEXT[draft.action];
  const write = useMutation({
    mutationFn: (from: HoldDraft) => {
      const comment = from.comment.trim();
      return from.action === 'comment'
        ? commentHold(hold.id, { version: from.version, comment })
        : decideHold(hold.id, from.action, {
            version: from.version,
            reason: from.reason === '' ? (reasons[0]?.id ?? '') : from.reason,
            ...(comment === '' ? {} : { comment }),
          });
    },
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: (answer) => {
      upsertHold(queryClient, answer);
      void onRead();
      onClose(`${text.done}; the hold is at version ${String(answer.version)}.`);
    },
    onError: async (error) => {
      const found = qualityFailure(error, {
        not: draft.action === 'comment' ? 'Not added' : `Not ${draft.action}ed`,
        what: draft.action === 'comment' ? 'this comment' : 'this decision',
        thing: 'hold',
      });
      setFailure(found);
      if (found.kind === 'stale' || found.kind === 'decided') await onRead();
    },
  });
  return (
    <form
      ref={form}
      tabIndex={-1}
      noValidate
      aria-label={text.label}
      data-testid={`hold-form-${draft.action}`}
      data-version={String(draft.version)}
      className="mt-2 flex flex-col gap-2 rounded border border-slate-400 bg-slate-50 p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (stale || !applies || sending.current) return;
        const found =
          commentProblem(draft.comment, draft.action === 'comment') ??
          (draft.action !== 'comment' && reason === '' ? 'Choose a reason.' : undefined);
        setProblem(found);
        if (found) return;
        setFailure(undefined);
        sending.current = true;
        write.mutate(draft);
      }}
    >
      <h3 className="font-semibold">{text.label}</h3>
      <p className="text-sm">{text.effect}</p>
      <p className="text-xs text-slate-700">
        Prepared on version {draft.version} of the hold; the MES refuses it if the hold has changed
        since (409).
      </p>
      {draft.action !== 'comment' ? (
        <label htmlFor={reasonId} className="flex flex-col gap-1 text-sm font-medium">
          Reason
          <select
            id={reasonId}
            data-testid="hold-reason"
            value={reason}
            className={`${inputClass} max-w-md`}
            onChange={(event) => {
              const reason = event.target.value;
              setDraft((d) => ({ ...d, reason }));
            }}
          >
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.id})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <CommentInput
        id={commentId}
        label="Comment"
        value={draft.comment}
        testId="hold-comment"
        max={COMMENT_MAX}
        required={draft.action === 'comment'}
        onChange={(comment) => {
          setDraft((d) => ({ ...d, comment }));
        }}
      />
      {stale ? (
        <div
          role="alert"
          data-testid="hold-stale"
          data-version={String(hold.version)}
          className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          <p>
            The hold changed while you prepared this: it is at version {hold.version} (
            {HOLD_STATE_TEXT[hold.state]}), you started on version {draft.version}. Nothing is sent
            with the newer version.{' '}
            {applies
              ? 'Check the hold above, then start again: what you entered is kept.'
              : 'This action no longer applies to the hold.'}
          </p>
          {applies ? (
            <button
              type="button"
              data-testid="hold-restart"
              className={`${buttonClass} mt-2`}
              onClick={() => {
                setDraft((d) => ({ ...d, version: hold.version }));
                setFailure(undefined);
              }}
            >
              Start again on version {hold.version}
            </button>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-red-900" data-testid="hold-invalid">
          {problem}
        </p>
      ) : null}
      {failure ? <FailureMessage failure={failure} testId="hold-message" /> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid="hold-submit"
          disabled={write.isPending || stale || !applies}
          className={primaryClass}
        >
          {write.isPending ? 'Sending…' : text.label}
        </button>
        <button
          type="button"
          data-testid="hold-cancel"
          className={buttonClass}
          onClick={() => {
            onClose();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Facts({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="text-slate-700">{label}:</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HoldActions({
  hold,
  onRead,
}: {
  readonly hold: HoldDto;
  readonly onRead: () => Promise<void>;
}) {
  const canHold = useCan('quality:hold');
  const canRelease = useCan('quality:release');
  const reasons = useQuery({
    queryKey: qualityKeys.reasons,
    queryFn: ({ signal }) => getHoldReasons(signal),
    staleTime: Infinity,
    enabled: canRelease,
  });
  const [open, setOpen] = useState<HoldDraft | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const opener = useRef<HTMLDivElement>(null);
  const offered: HoldAction[] = [
    ...(canHold ? (['comment'] as const) : []),
    ...(canRelease && hold.state === 'open' ? (['release', 'reject'] as const) : []),
  ];
  return (
    <Section id="hold-actions" title="Actions">
      {!canHold && !canRelease ? (
        <p className="text-sm" data-testid="hold-read-only">
          Your role cannot change holds: shown read-only.
        </p>
      ) : null}
      {done && !open ? (
        <p role="status" data-testid="hold-done" className="mb-2 text-sm text-emerald-900">
          {done}
        </p>
      ) : null}
      {!open ? (
        <div ref={opener} className="flex flex-wrap gap-2">
          {offered.map((action) => (
            <button
              key={action}
              type="button"
              data-testid={`hold-action-${action}`}
              className={buttonClass}
              onClick={() => {
                setDone(undefined);
                setOpen({ action, version: hold.version, reason: '', comment: '' });
              }}
            >
              {ACTION_TEXT[action].label}
            </button>
          ))}
        </div>
      ) : (
        <HoldForm
          key={`${open.action}:${String(open.version)}`}
          hold={hold}
          initial={open}
          reasons={
            open.action === 'comment' ? [] : reasonsFor(reasons.data?.reasons ?? [], open.action)
          }
          onRead={onRead}
          onClose={(text) => {
            setOpen(undefined);
            setDone(text);
            requestAnimationFrame(() => opener.current?.querySelector('button')?.focus());
          }}
        />
      )}
    </Section>
  );
}

function Scope({ detail }: { readonly detail: HoldDetailDto }) {
  return (
    <Section id="hold-scope" title="Scope">
      <p className="text-sm text-slate-700">
        Derived from the genealogy and growing with facts: a unit that consumes a held lot later, or
        whose fact arrives late, joins it (shown about a second behind the genealogy).
      </p>
      <p className="mt-2 text-sm">
        Orders:{' '}
        <span data-testid="hold-orders">
          {detail.orders.length === 0
            ? '–'
            : detail.orders.map((id, i) => (
                <span key={id}>
                  {i > 0 ? ', ' : ''}
                  <Link to="/orders/$id" params={{ id }} className="text-sky-800 underline">
                    {id}
                  </Link>
                </span>
              ))}
        </span>
      </p>
      <p className="mt-1 text-sm">
        Cartons:{' '}
        <span data-testid="hold-cartons">
          {detail.cartons.length === 0
            ? '–'
            : detail.cartons.map((id, i) => (
                <span key={id}>
                  {i > 0 ? ', ' : ''}
                  <a href={subjectHref({ kind: 'carton', id })} className="text-sky-800 underline">
                    {id}
                  </a>
                </span>
              ))}
        </span>
      </p>
      {detail.units.length === 0 ? (
        <p className="mt-2 text-sm" data-testid="hold-units-empty">
          No unit in the scope yet.
        </p>
      ) : (
        <div className="mt-2 max-h-96 overflow-y-auto">
          <Table
            testId="hold-units"
            caption="Units in the hold's scope"
            columns={['Serial', 'Unit (epoch / part)', 'Order', 'Carton', 'Joined']}
            count={detail.units.length}
          >
            {detail.units.map((u) => (
              <tr
                key={`${String(u.epoch)}-${String(u.partId)}`}
                data-testid={`hold-unit-${String(u.epoch)}-${String(u.partId)}`}
              >
                <td className={cell}>
                  {u.serial ? (
                    <a
                      href={subjectHref({ kind: 'serial', id: u.serial })}
                      className="text-sky-800 underline"
                    >
                      {u.serial}
                    </a>
                  ) : (
                    '–'
                  )}
                </td>
                <td className={cell}>
                  {u.epoch} / {u.partId}
                </td>
                <td className={cell}>{u.orderId ?? '–'}</td>
                <td className={cell}>{u.carton ?? '–'}</td>
                <td className={cell}>{timeOf(u.joinedAt)}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {detail.unitsTruncated ? (
        <p className="mt-1 text-sm" data-testid="hold-units-truncated">
          More units are in the scope than are listed.
        </p>
      ) : null}
    </Section>
  );
}

function Transitions({ detail }: { readonly detail: HoldDetailDto }) {
  return (
    <Section id="hold-history" title="Transitions and comments">
      <Table
        testId="hold-transitions"
        caption="Transitions and comments in order, with their ERP notifications"
        columns={['#', 'What', 'Reason', 'Comment', 'By', 'When', 'Scope told', 'ERP notification']}
        count={detail.transitions.length}
      >
        {detail.transitions.map((t) => (
          <tr
            key={t.n}
            data-testid={`hold-transition-${String(t.n)}`}
            data-kind={t.kind}
            data-notification={t.notification?.status ?? ''}
          >
            <td className={cell}>{t.n}</td>
            <td className={cell}>{t.kind}</td>
            <td className={cell}>{t.reason ?? '–'}</td>
            <td className={cell}>{t.comment ?? '–'}</td>
            <td className={cell}>{t.by}</td>
            <td className={cell}>{timeOf(t.at)}</td>
            <td className={cell}>
              {t.scope
                ? `${String(t.scope.units)} units, ${String(t.scope.cartons)} cartons, ${String(t.scope.orders)} orders${t.scope.final ? '' : ' (provisional)'}`
                : '–'}
            </td>
            <td className={cell}>
              {t.notification ? (
                <>
                  {t.notification.status} ({t.notification.attempts} attempt
                  {t.notification.attempts === 1 ? '' : 's'})
                  {t.notification.lastError ? (
                    <span className="block text-xs text-red-900">{t.notification.lastError}</span>
                  ) : null}
                </>
              ) : (
                'not notified'
              )}
            </td>
          </tr>
        ))}
      </Table>
    </Section>
  );
}

function Incidents({ detail }: { readonly detail: HoldDetailDto }) {
  return (
    <Section id="hold-incidents" title="Held material consumed">
      {detail.incidents.length === 0 ? (
        <p className="text-sm" data-testid="hold-incidents-empty">
          No consumption of a held lot after the opening.
        </p>
      ) : (
        <Table
          testId="hold-incident-list"
          caption="Consumptions of a held lot after the opening"
          columns={['Lot', 'Machine', 'Part', 'Operation', 'Consumed', 'Detected', 'Message']}
          count={detail.incidents.length}
        >
          {detail.incidents.map((i) => (
            <tr key={i.id} data-testid={`hold-incident-${String(i.id)}`}>
              <td className={cell}>{i.lot}</td>
              <td className={cell}>{i.equipment}</td>
              <td className={cell}>{i.partId}</td>
              <td className={cell}>
                {i.operation ?? '–'}
                {i.pass === null ? '' : ` (pass ${String(i.pass)})`}
              </td>
              <td className={cell}>{timeOf(i.consumedAt)}</td>
              <td className={cell}>{timeOf(i.detectedAt)}</td>
              <td className={cell}>{i.message}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function HoldDetail({ id }: { readonly id: string }) {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const queryClient = useQueryClient();
  const read = useQuery({
    queryKey: qualityKeys.hold(id),
    queryFn: ({ signal }) => getHold(id, signal),
  });
  const live = useLiveQuality();
  const onRead = async () => {
    await queryClient.refetchQueries({ queryKey: qualityKeys.hold(id) });
  };
  const missing = read.error instanceof ApiError && read.error.status === 404;
  const detail = read.data;
  const hold = detail ? newestHold(detail.hold, live) : undefined;
  return (
    <section aria-labelledby="hold-title" data-testid="hold-detail" data-hold={id}>
      <p className="text-sm">
        <Link to="/quality/holds" search={{}} className="text-sky-800 underline">
          All holds
        </Link>
      </p>
      <h1 ref={heading} id="hold-title" tabIndex={-1} className="mt-1 text-2xl font-bold">
        {hold ? `Hold on ${subjectText(hold.subject)}` : 'Quality hold'}
      </h1>
      {read.isPending ? <p className="mt-4">Loading the hold…</p> : null}
      {missing ? (
        <p className="mt-4" data-testid="hold-missing">
          The MES has no hold {id}.
        </p>
      ) : read.isError ? (
        <div className="mt-4">
          <QueryError what="the hold" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {detail && hold ? (
        <>
          <div
            className="mt-3"
            data-testid="hold-summary"
            data-state={hold.state}
            data-version={String(hold.version)}
          >
            <Facts
              items={[
                ['Subject', <SubjectLink key="s" subject={hold.subject} />],
                ['State', <HoldStateBadge key="st" state={hold.state} />],
                ['Reason', hold.reason],
                [
                  'Opened',
                  <span key="o">
                    {hold.openedBy}, {timeOf(hold.openedAt)}
                  </span>,
                ],
                ['Opened at plant time', timeOf(hold.openedPlantAt)],
                [
                  'Decided',
                  hold.decidedBy ? (
                    <span key="d">
                      {hold.decidedBy}, {timeOf(hold.decidedAt)} ({hold.decisionReason})
                    </span>
                  ) : (
                    '–'
                  ),
                ],
                [
                  'Scope',
                  <span
                    key="sc"
                    data-testid="hold-scope-counts"
                    data-units={String(hold.scope.units)}
                    data-cartons={String(hold.scope.cartons)}
                    data-orders={String(hold.scope.orders)}
                  >
                    {scopeText(hold.scope)}
                  </span>,
                ],
                [
                  'Held material consumed',
                  <span key="hm" data-testid="hold-consumed">
                    {hold.heldMaterialConsumed}
                  </span>,
                ],
                ['Version', String(hold.version)],
              ]}
            />
            <HoldEffect />
          </div>
          <HoldActions hold={hold} onRead={onRead} />
          <Scope detail={detail} />
          <Transitions detail={detail} />
          <Incidents detail={detail} />
        </>
      ) : null}
    </section>
  );
}

/** The route's screen: keyed by the hold id, holding the `quality` topic. */
export function HoldDetailRoute() {
  const { id } = useParams({ from: '/quality/holds/$id' });
  useQualityTopic();
  if (!HOLD_ID.test(id)) {
    return (
      <section>
        <h1 className="text-2xl font-bold">Quality hold</h1>
        <p className="mt-2" data-testid="hold-missing">
          No hold has this id.
        </p>
      </section>
    );
  }
  return <HoldDetail key={id} id={id.toLowerCase()} />;
}
