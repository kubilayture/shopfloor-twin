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
import { QueryError } from '../components/query-error.tsx';
import {
  ScreenError,
  SectionError,
  queryRead,
  useScreenErrors,
} from '../components/screen-error.tsx';
import {
  CommentInput,
  FailureMessage,
  HoldStateBadge,
  plantBeside,
  plantOrWall,
  timeOf,
  wallTimeOf,
} from '../components/quality-ui.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button, buttonClass, type ButtonVariant } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { Checkbox, ChoiceGroup, Select, TextInput } from '../components/ui/controls.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { DescriptionList, type Fact } from '../components/ui/description-list.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing } from '../components/ui/format.tsx';
import { Icon } from '../components/ui/icons.tsx';
import { Forbidden, NotFound } from '../components/ui/not-found.tsx';
import { BackLink, PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { SectionNav, type SectionNavItem } from '../components/ui/section-nav.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { Stat } from '../components/ui/stat.tsx';
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
  subjectText,
  type QualityFailure,
} from '../domain/quality.ts';
import { useLiveQuality, useQualityTopic } from '../live/live-context.tsx';
import { upsertHold } from '../live/live-quality.ts';
import {
  CartonLink,
  IdText,
  OrderLink,
  SerialLink,
  SubjectLink as TraceSubjectLink,
} from './trace-common.tsx';
import { countOf } from '../domain/words.ts';

// `/quality/holds`, `/quality/holds/new` and `/quality/holds/$id` (#203, plan "Web", ADR-0035):
// the holds with filters, opening a hold on a lot, serial, carton or order (from a trace page, an
// order, or a signal's suggested scope), and one hold's detail with its scope (it grows with
// facts), transitions with their ERP notifications, incidents, and the actions: comment
// (`quality:hold`), release and reject (`quality:release`), each with the version read.
// On the design system since UX-9b (#333): page header, fields, data tables, stats.

const HOLD_ID = /^[0-9a-fA-F-]{36}$/;

const BACK = { label: 'All holds', link: { to: '/quality/holds', search: {} } } as const;

/** A link in body text: underlined (WCAG 1.4.1). */
const linkClass = 'text-link underline underline-offset-2 hover:text-accent-hover';
/** A link on an id: it never breaks at a hyphen, so a focused one is never cut in two (2.4.11). */
const idLinkClass = `${linkClass} whitespace-nowrap`;

/** What a hold does and doesn't do, said on its pages (ADR-0035), closed by default (G-08). */
function HoldEffect() {
  return (
    <Disclosure summary="What a hold does" className="mt-2">
      <p className="max-w-[90ch] text-ink-secondary" data-testid="hold-effect">
        An open hold refuses the close of every order with a unit in its scope; a carton is held
        while a member is in an open or rejected hold; the ERP is told of each opening, release and
        rejection. A hold never stops a machine: the line can keep using a held lot, which shows as
        held-material-consumed.
      </p>
    </Disclosure>
  );
}

/** A link to the subject's own page: its trace page (#202) or an order's detail. */
export function SubjectLink({ subject }: { readonly subject: HoldSubjectDto }) {
  return (
    <span className="whitespace-nowrap">
      <TraceSubjectLink subject={subject} testId="hold-subject" />
    </span>
  );
}

const scopeText = (scope: HoldDto['scope']): string =>
  `${countOf(scope.units, 'unit')}, ${countOf(scope.cartons, 'carton')}, ${countOf(scope.orders, 'order')}`;

// ---- The list ----

const HOLD_COLUMNS: readonly Column<HoldDto>[] = [
  {
    key: 'subject',
    header: 'Subject',
    rowHeader: true,
    cell: (hold) => <SubjectLink subject={hold.subject} />,
  },
  {
    key: 'state',
    header: 'State',
    nowrap: true,
    cell: (hold) => <HoldStateBadge state={hold.state} />,
  },
  {
    key: 'reason',
    header: 'Reason',
    cell: (hold) => (
      <>
        <Code className="whitespace-nowrap">{hold.reason}</Code>
        {hold.decisionReason ? (
          <span className="block text-xs text-ink-secondary">
            decided: <Code className="whitespace-nowrap">{hold.decisionReason}</Code>
          </span>
        ) : null}
      </>
    ),
  },
  {
    key: 'opened',
    header: 'Opened',
    priority: 2,
    cell: (hold) => (
      <>
        {hold.openedBy},{' '}
        <span className="block">{plantOrWall(hold.openedPlantAt, hold.openedAt)}</span>
      </>
    ),
  },
  {
    key: 'scope',
    header: 'Scope',
    priority: 3,
    cell: (hold) => scopeText(hold.scope),
  },
  {
    key: 'consumed',
    header: 'Held material consumed',
    numeric: true,
    priority: 3,
    cell: (hold) => hold.heldMaterialConsumed,
  },
];

/** A hold table (the list's, and an order's holds). */
export function HoldTable({
  holds,
  testId,
  caption,
  empty,
  loading,
}: {
  readonly holds: readonly HoldDto[];
  readonly testId: string;
  readonly caption: string;
  readonly empty?: ReactNode;
  readonly loading?: string | undefined;
}) {
  return (
    <DataTable
      caption={caption}
      testId={testId}
      columns={HOLD_COLUMNS}
      rows={holds}
      rowKey={(hold) => hold.id}
      rowTestId={(hold) => `hold-row-${hold.id}`}
      rowProps={(hold) => ({
        'data-state': hold.state,
        'data-version': String(hold.version),
        'data-subject': `${hold.subject.kind}:${hold.subject.id}`,
        'data-units': String(hold.scope.units),
      })}
      // The bar says "blocks" (open, and rejected whose cartons stay held), as the trace pages'
      // holds do; the badge carries the state (design system 2.6).
      rowTone={(hold) => (hold.state === 'released' ? undefined : 'alarm')}
      actions={(hold) => (
        <Link
          to="/quality/holds/$id"
          params={{ id: hold.id }}
          data-testid={`hold-link-${hold.id}`}
          // The containing block of its visually hidden words, which would widen a narrow page.
          className={`${buttonClass({ variant: 'ghost', size: 'sm' })} relative`}
        >
          Details <span className="sr-only">of the hold on {subjectText(hold.subject)}</span>
        </Link>
      )}
      narrow="stack"
      empty={empty}
      loading={loading}
    />
  );
}

export function HoldList() {
  useQualityTopic();
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
  const problemId = useId();
  const filtered = search.state !== undefined || subject !== undefined;
  const openLink = (
    <Link
      to="/quality/holds/new"
      search={{}}
      data-testid="hold-open-link"
      className={buttonClass({ variant: 'primary' })}
    >
      Open a hold
    </Link>
  );
  return (
    <section aria-labelledby="holds-title" data-testid="hold-list-page">
      <PageHeader
        id="holds-title"
        title="Quality holds"
        description="Holds on lots, serials, cartons and orders, newest first; the list follows the MES live."
        actions={canHold ? openLink : undefined}
        meta={<HoldEffect />}
        filters={
          <>
            <Select
              label="State"
              inline
              name="state"
              data-testid="hold-filter-state"
              value={search.state ?? ''}
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
            </Select>
            <form
              role="search"
              aria-label="One subject’s holds"
              noValidate
              className="flex flex-wrap items-center gap-x-3 gap-y-2"
              onSubmit={(event) => {
                event.preventDefault();
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
              <Select
                label="Subject"
                inline
                name="kind"
                data-testid="hold-filter-kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as HoldSubjectKind);
                }}
              >
                {HOLD_SUBJECT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SUBJECT_TEXT[k]}
                  </option>
                ))}
              </Select>
              <TextInput
                label="Subject id"
                inline
                name="id"
                data-testid="hold-filter-id"
                value={id}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                describedBy={problem ? problemId : undefined}
                className="w-44"
                onChange={(event) => {
                  setId(event.target.value);
                }}
              />
              <Button type="submit" data-testid="hold-filter-apply">
                Show this subject’s holds
              </Button>
              {subject ? (
                <Button
                  variant="ghost"
                  data-testid="hold-filter-clear"
                  onClick={() => {
                    setId('');
                    setProblem(undefined);
                    void navigate({ to: '/quality/holds', search: { state: search.state } });
                  }}
                >
                  Every subject
                </Button>
              ) : null}
              {problem ? (
                <p
                  id={problemId}
                  role="alert"
                  data-testid="hold-filter-problem"
                  className="flex w-full items-start gap-1 text-sm font-medium text-alarm-ink"
                >
                  <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
                  {problem}
                </p>
              ) : null}
            </form>
          </>
        }
        summary={read.data ? countOf(holds.length, 'hold') : undefined}
      />
      {read.data?.truncated ? (
        <Callout tone="warn" role="status" data-testid="holds-truncated" className="mb-4">
          More holds match than are listed; filter by state or subject.
        </Callout>
      ) : null}
      {read.isError ? (
        <QueryError what="the holds" error={read.error} onRetry={() => void read.refetch()} />
      ) : (
        <HoldTable
          holds={holds}
          testId="hold-list"
          caption="Quality holds, newest first"
          loading={read.isPending ? 'Loading the holds…' : undefined}
          empty={
            <EmptyState
              testId="holds-empty"
              icon={filtered ? 'search' : 'check'}
              title={filtered ? 'No hold matches these filters' : 'No quality hold yet'}
              body={
                filtered
                  ? 'Choose another state or subject, or show every hold.'
                  : 'Holds are opened from a trace page, an order, an SPC episode or here.'
              }
              action={
                filtered ? (
                  <Link
                    to="/quality/holds"
                    search={{}}
                    data-testid="holds-empty-clear"
                    className={buttonClass({ variant: 'secondary' })}
                    onClick={() => {
                      setId('');
                      setProblem(undefined);
                    }}
                  >
                    Show every hold
                  </Link>
                ) : canHold ? (
                  <Link
                    to="/quality/holds/new"
                    search={{}}
                    className={buttonClass({ variant: 'secondary' })}
                  >
                    Open a hold
                  </Link>
                ) : undefined
              }
            />
          }
        />
      )}
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

/** A subject skipped for its open holds, until the user confirms. */
interface Existing {
  readonly subject: HoldSubjectDto;
  readonly holds: readonly HoldDto[];
}

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
      className="flex flex-col gap-3 rounded-md border border-line bg-surface-sunken p-3 text-sm sm:p-4"
    >
      <div>
        <h2 className="text-base font-semibold text-ink">
          Suggested scope of episode {suggestion.signal}
        </h2>
        <p className="mt-1 text-ink-secondary">
          {suggestion.chart}, rule {suggestion.rule}, on {suggestion.characteristic}: the{' '}
          {countOf(suggestion.readings, 'reading')} (every pass) from{' '}
          <span data-testid="hold-suggestion-from">{timeOf(suggestion.from.at)}</span> (
          {suggestion.after ? (
            <>after the last in-control point at {timeOf(suggestion.after.at)}</>
          ) : (
            'the start of its segment'
          )}
          ) through {timeOf(suggestion.through.at)}: {countOf(suggestion.units.length, 'unit')} in{' '}
          {countOf(suggestion.orders.length, 'order')} and{' '}
          {countOf(suggestion.cartons.length, 'carton')}.
        </p>
      </div>
      {suggestion.final ? null : (
        <Callout tone="warn" data-testid="hold-suggestion-provisional">
          The episode’s extent is not final yet: the window can still grow.
        </Callout>
      )}
      {subjects.length === 0 ? (
        <EmptyState
          size="inline"
          icon="info"
          testId="hold-suggestion-empty"
          title="Nothing to hold yet"
          body="No unit of the window has a serial, an order or a carton yet."
        />
      ) : (
        <ChoiceGroup legend="Hold these (one hold each)" inline>
          {subjects.map((s) => {
            const key = subjectKey(s);
            return (
              <Checkbox
                key={key}
                name="subjects"
                value={key}
                data-testid={`suggest-${s.kind}-${s.id}`}
                checked={selected.has(key)}
                label={
                  <>
                    {SUBJECT_TEXT[s.kind]} <Code className="whitespace-nowrap">{s.id}</Code>
                  </>
                }
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(key);
                  else next.delete(key);
                  setSelected(next);
                }}
              />
            );
          })}
        </ChoiceGroup>
      )}
    </div>
  );
}

/** The header of the new-hold page, with the way back. */
function OpenHeader() {
  return (
    <PageHeader
      id="hold-open-title"
      back={BACK}
      title="Open a quality hold"
      description="One hold per subject; the MES derives its scope from the genealogy and grows it with facts."
      meta={<HoldEffect />}
    />
  );
}

export function HoldOpen() {
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
  const [existing, setExisting] = useState<Existing[]>([]);
  const sending = useRef(false);
  const commentId = useId();
  useUnsavedDraft(
    comment.trim() !== '' || (fromSignal === undefined && id !== (initial?.id ?? '')),
  );
  const openReasons = reasons.data ? reasonsFor(reasons.data.reasons, 'open') : [];
  // The first listed reason until one is chosen.
  const chosenReason = reason === '' ? (openReasons[0]?.id ?? '') : reason;
  const write = useMutation({
    mutationFn: async ({
      subjects,
      confirmed,
    }: {
      readonly subjects: readonly HoldSubjectDto[];
      /** The user confirmed opening these although they have open holds already. */
      readonly confirmed: boolean;
    }) => {
      const out: OpenResult[] = [];
      const held: Existing[] = [];
      for (const subject of subjects) {
        if (!confirmed) {
          // A subject with an open hold is skipped until the user says otherwise (#203 review):
          // a resubmitted form never opens a second hold by accident.
          const existing = await getHolds({ states: ['open'], subject }).then(
            (found) => found.holds,
            () => [],
          );
          if (existing.length > 0) {
            held.push({ subject, holds: existing });
            continue;
          }
        }
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
      return { out, held };
    },
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: ({ out, held }) => {
      const done = new Set(out.map((r) => subjectKey(r.subject)));
      setResults((before) => [...before.filter((r) => !done.has(subjectKey(r.subject))), ...out]);
      setExisting(held);
      // What opened is no longer chosen: sending the form again can't hold it twice.
      const opened = new Set(out.flatMap((r) => (r.hold ? [subjectKey(r.subject)] : [])));
      setSelected((before) => new Set([...before].filter((key) => !opened.has(key))));
      void queryClient.invalidateQueries({ queryKey: qualityKeys.holdsAll });
      const [only] = out;
      if (out.length === 1 && held.length === 0 && only?.hold && fromSignal === undefined) {
        void navigate({ to: '/quality/holds/$id', params: { id: only.hold.id } });
      }
    },
  });
  // One error for the form's reads (#394): the suggested scope and the reasons both failed, or the
  // reasons failed without a suggestion to read, is one error at the top of the form; otherwise
  // each says its own in place. An unknown episode (404) is an answer, said by its own callout.
  const unknownEpisode = suggestion.error instanceof ApiError && suggestion.error.status === 404;
  const errors = useScreenErrors([
    ...(fromSignal !== undefined && !unknownEpisode
      ? [queryRead('the suggested scope', suggestion, 'section')]
      : []),
    queryRead('the hold reasons', reasons, 'section'),
  ]);
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
        <OpenHeader />
        <Forbidden permission="quality:hold" testId="hold-open-forbidden">
          Your role cannot open holds: quality and supervisors can
        </Forbidden>
      </section>
    );
  }
  return (
    <section aria-labelledby="hold-open-title" data-testid="hold-open-page">
      <OpenHeader />
      <form
        noValidate
        aria-label="Open a quality hold"
        data-testid="hold-open-form"
        className="flex max-w-3xl flex-col gap-4 rounded-lg border border-line bg-surface p-4 text-ink sm:p-5"
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
          setExisting([]);
          sending.current = true;
          write.mutate({ subjects: subjects as HoldSubjectDto[], confirmed: false });
        }}
      >
        <ScreenError errors={errors} />
        {fromSignal !== undefined ? (
          unknownEpisode ? (
            // One alert for the form (#394): with the reasons' error up, this answer is polite.
            <Callout
              tone="alarm"
              role={errors.summary.length > 0 ? 'status' : 'alert'}
              data-testid="hold-suggestion-missing"
            >
              Episode {fromSignal} is unknown or withdrawn: it suggests no scope.
            </Callout>
          ) : errors.inSection('the suggested scope') ? (
            <SectionError errors={errors} readKey="the suggested scope" />
          ) : errors.summary.some(
              (read) => read.key === 'the suggested scope',
            ) ? null : suggestion.data ? (
            <Suggestion
              suggestion={suggestion.data}
              selected={selected}
              setSelected={setSelected}
            />
          ) : (
            <Skeleton shape="text" rows={3} label="Loading the episode’s suggested scope…" />
          )
        ) : (
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <Select
              label="Subject"
              name="kind"
              data-testid="open-kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as HoldSubjectKind);
              }}
            >
              {HOLD_SUBJECT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SUBJECT_TEXT[k]}
                </option>
              ))}
            </Select>
            <TextInput
              label={kind === 'order' ? 'Order number' : `${SUBJECT_TEXT[kind]} id`}
              name="id"
              data-testid="open-id"
              value={id}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              fieldClassName="min-w-0 flex-1 basis-56"
              className="w-full max-w-sm font-mono"
              onChange={(event) => {
                setId(event.target.value);
              }}
            />
          </div>
        )}
        {/* The option texts in full (H-05): the select is as wide as its longest option. */}
        <Select
          label="Reason"
          name="reason"
          data-testid="open-reason"
          value={chosenReason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        >
          {openReasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.id})
            </option>
          ))}
        </Select>
        <SectionError errors={errors} readKey="the hold reasons" />
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
          <Callout tone="alarm" role="alert" data-testid="open-invalid">
            {problems.join(' ')}
          </Callout>
        ) : null}
        <div>
          <Button
            type="submit"
            variant="primary"
            data-testid="open-submit"
            loading={write.isPending}
          >
            {fromSignal !== undefined ? `Open ${countOf(selected.size, 'hold')}` : 'Open the hold'}
          </Button>
        </div>
      </form>
      {existing.length > 0 ? (
        <Callout
          tone="warn"
          role="alert"
          data-testid="open-existing"
          className="mt-4 max-w-3xl"
          title="Not opened: these subjects have open holds already."
        >
          <ul className="list-disc pl-5">
            {existing.map((e) => (
              <li
                key={subjectKey(e.subject)}
                data-testid={`open-existing-${e.subject.kind}-${e.subject.id}`}
              >
                {SUBJECT_TEXT[e.subject.kind]}{' '}
                <Code className="whitespace-nowrap">{e.subject.id}</Code>:{' '}
                {e.holds.map((h, i) => (
                  <span key={h.id}>
                    {i > 0 ? ', ' : ''}
                    <Link to="/quality/holds/$id" params={{ id: h.id }} className={idLinkClass}>
                      {h.reason}
                    </Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid="open-skip"
              onClick={() => {
                setExisting([]);
              }}
            >
              Leave {existing.length === 1 ? 'it' : 'them'} as{' '}
              {existing.length === 1 ? 'it is' : 'they are'}
            </Button>
            <Button
              size="sm"
              data-testid="open-confirm"
              loading={write.isPending}
              onClick={() => {
                if (sending.current) return;
                sending.current = true;
                write.mutate({ subjects: existing.map((e) => e.subject), confirmed: true });
              }}
            >
              Open another hold on {existing.length === 1 ? 'it' : 'them'} anyway
            </Button>
          </div>
        </Callout>
      ) : null}
      {results.length > 0 ? (
        <ul className="mt-4 flex max-w-3xl flex-col gap-2" data-testid="open-results">
          {results.map((r) => (
            <li
              key={subjectKey(r.subject)}
              data-testid={`open-result-${r.subject.kind}-${r.subject.id}`}
              data-kind={r.hold ? 'opened' : (r.failure?.kind ?? 'failed')}
            >
              {r.hold ? (
                <Callout tone="ok" role="status">
                  {SUBJECT_TEXT[r.subject.kind]}{' '}
                  <Code className="whitespace-nowrap">{r.subject.id}</Code>: hold opened (
                  <Link to="/quality/holds/$id" params={{ id: r.hold.id }} className={linkClass}>
                    details
                  </Link>
                  ), scope {scopeText(r.hold.scope)} so far.
                </Callout>
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
      'Releases the hold: the goods are used as is; it no longer blocks a close or its cartons. The ERP is told. This cannot be undone.',
    done: 'Hold released',
  },
  reject: {
    label: 'Reject',
    effect:
      'Rejects the goods: quality wants the units scrapped or reworked outside the MES. Quantities and confirmations don’t change; the cartons stay held; a close is no longer blocked by it. The ERP is told. This cannot be undone.',
    done: 'Hold rejected',
  },
};

/**
 * The variant of each action (design system 4.1): release, the forward step, `primary`; reject,
 * which sends the goods to scrap or rework, `danger`; a comment `secondary` in the header and
 * `primary` as its own form's send.
 */
const ACTION_VARIANT: Readonly<Record<HoldAction, ButtonVariant>> = {
  comment: 'secondary',
  reject: 'danger',
  release: 'primary',
};
const SUBMIT_VARIANT: Readonly<Record<HoldAction, ButtonVariant>> = {
  comment: 'primary',
  // A decision cannot be taken back: the destructive one's send is the solid danger (4.1, 4.9).
  reject: 'dangerSolid',
  release: 'primary',
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
  const submit = useRef<HTMLButtonElement>(null);
  const commentId = useId();
  // "Start again" clears the stale state; the send button is enabled only after that render.
  const focusSubmit = useRef(false);
  useUnsavedDraft(draft.comment.trim() !== '');
  // The form takes the focus when it opens (and the browser brings it into view).
  useEffect(() => {
    form.current?.focus();
  }, []);
  // The first listed reason until one is chosen.
  const reason = draft.reason === '' ? (reasons[0]?.id ?? '') : draft.reason;
  const stale = isStale(draft.version, hold.version);
  useEffect(() => {
    if (!focusSubmit.current || stale) return;
    focusSubmit.current = false;
    submit.current?.focus();
  }, [stale]);
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
      className="flex max-w-3xl flex-col gap-4 rounded-lg border border-line bg-surface p-4 text-ink sm:p-5"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        // A ref, not `isPending`: two submits before the next render both see it false.
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
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{text.label}</h2>
        <p className="text-sm">{text.effect}</p>
        <p className="text-xs text-ink-secondary">
          Prepared on version {draft.version} of the hold; the MES refuses it if the hold has
          changed since.
        </p>
      </div>
      {failure ? <FailureMessage failure={failure} testId="hold-message" /> : null}
      {problem ? (
        <Callout tone="alarm" role="alert" data-testid="hold-invalid">
          {problem}
        </Callout>
      ) : null}
      {stale ? (
        <Callout
          tone="warn"
          role="alert"
          data-testid="hold-stale"
          data-version={String(hold.version)}
          title="The hold changed while you prepared this"
        >
          <p>
            It is at version {hold.version} ({HOLD_STATE_TEXT[hold.state]}), you started on version{' '}
            {draft.version}. Nothing is sent with the newer version.{' '}
            {applies
              ? 'Check the hold above, then start again: what you entered is kept.'
              : 'This action no longer applies to the hold.'}
          </p>
          {applies ? (
            <Button
              size="sm"
              data-testid="hold-restart"
              className="mt-2"
              onClick={() => {
                setDraft((d) => ({ ...d, version: hold.version }));
                setFailure(undefined);
                focusSubmit.current = true;
              }}
            >
              Start again on version {hold.version}
            </Button>
          ) : null}
        </Callout>
      ) : null}
      {draft.action !== 'comment' ? (
        <Select
          label="Reason"
          name="reason"
          data-testid="hold-reason"
          value={reason}
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
        </Select>
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
      {/* Cancel first, the send button last, on the right of the pair (design system 4.1). */}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="hold-cancel"
          onClick={() => {
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button
          ref={submit}
          type="submit"
          variant={SUBMIT_VARIANT[draft.action]}
          data-testid="hold-submit"
          disabled={stale || !applies}
          loading={write.isPending}
        >
          {text.label}
        </Button>
      </div>
    </form>
  );
}

/** The actions this role may take on the hold as it is now. */
function useOffered(hold: HoldDto | undefined): HoldAction[] {
  const canHold = useCan('quality:hold');
  const canRelease = useCan('quality:release');
  return [
    ...(canHold ? (['comment'] as const) : []),
    ...(canRelease && hold?.state === 'open' ? (['reject', 'release'] as const) : []),
  ];
}

/**
 * Where the focus goes when an action form closes: the button that opened it, else the header's
 * last action, else the page's heading.
 */
function focusAfterClose(action: HoldAction): void {
  const own = document.querySelector<HTMLElement>(`button[data-testid="hold-action-${action}"]`);
  const actions = document.querySelectorAll<HTMLElement>('button[data-testid^="hold-action-"]');
  (own ?? actions[actions.length - 1] ?? document.getElementById('hold-title'))?.focus();
}

/** The scope's counts as figures (design system 4.4), and the held material consumed. */
function ScopeCounts({ hold }: { readonly hold: HoldDto }) {
  const consumed = hold.heldMaterialConsumed;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div
        data-testid="hold-scope-counts"
        data-units={String(hold.scope.units)}
        data-cartons={String(hold.scope.cartons)}
        data-orders={String(hold.scope.orders)}
        className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4"
      >
        <Stat label="Units" value={hold.scope.units} dataValue={String(hold.scope.units)} />
        <Stat label="Cartons" value={hold.scope.cartons} dataValue={String(hold.scope.cartons)} />
        <Stat label="Orders" value={hold.scope.orders} dataValue={String(hold.scope.orders)} />
        <Stat
          label="Held material consumed"
          value={consumed}
          valueTestId="hold-consumed"
          dataValue={String(consumed)}
          // A consumption of a held lot is abnormal: the only coloured figure.
          tone={consumed > 0 ? 'warn' : undefined}
          hint={consumed > 0 ? 'Cycles that used a held lot after the opening' : undefined}
        />
      </div>
    </div>
  );
}

/** Ids as links, comma-separated, each on one line; an em dash with its reason when none. */
function IdLinks({
  ids,
  none,
  link,
}: {
  readonly ids: readonly string[];
  readonly none: string;
  readonly link: (id: string) => ReactNode;
}) {
  if (ids.length === 0) return <Missing reason={none} />;
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? ', ' : ''}
          {link(id)}
        </span>
      ))}
    </>
  );
}

function Scope({ detail, hold }: { readonly detail: HoldDetailDto; readonly hold: HoldDto }) {
  const facts: Fact[] = [
    {
      term: 'Orders',
      detail: (
        <span data-testid="hold-orders">
          <IdLinks
            ids={detail.orders}
            none="No order in the scope yet"
            link={(id) => <OrderLink order={id} />}
          />
        </span>
      ),
    },
    {
      term: 'Cartons',
      detail: (
        <span data-testid="hold-cartons">
          <IdLinks
            ids={detail.cartons}
            none="No carton in the scope yet"
            link={(id) => <CartonLink carton={id} />}
          />
        </span>
      ),
    },
  ];
  return (
    <Section
      id="hold-scope-title"
      testId="hold-scope"
      title="Scope"
      description="Derived from the genealogy and growing with facts: a unit that consumes a held lot later, or whose fact arrives late, joins it (about a second behind the genealogy)."
    >
      <ScopeCounts hold={hold} />
      <div className="mt-4">
        <DescriptionList facts={facts} columns={2} label="Orders and cartons in the scope" />
      </div>
    </Section>
  );
}

type HoldUnit = HoldDetailDto['units'][number];

const unitKey = (u: HoldUnit): string => `${String(u.epoch)}-${String(u.partId)}`;

/** Units on a page of their own size, as the lot's units on its trace page (#331). */
const UNITS_PAGE_SIZE = 50;

/**
 * One link per row, the serial: the orders and cartons are linked once each in the scope above,
 * so a keyboard user does not tab through the same order on every row (G-33), as on the lot's
 * trace page; the ids and the absences in the trace pages' words.
 */
const UNIT_COLUMNS: readonly Column<HoldUnit>[] = [
  {
    key: 'serial',
    header: 'Serial',
    rowHeader: true,
    nowrap: true,
    cell: (u) => <SerialLink unit={u} />,
  },
  {
    key: 'unit',
    header: 'Unit (epoch / part)',
    numeric: true,
    priority: 3,
    cell: (u) => (
      <>
        {u.epoch} / {u.partId}
      </>
    ),
  },
  {
    key: 'order',
    header: 'Order',
    nowrap: true,
    cell: (u) => <IdText id={u.orderId} kind="order" />,
  },
  {
    key: 'carton',
    header: 'Carton',
    nowrap: true,
    priority: 3,
    cell: (u) => <IdText id={u.carton} kind="carton" />,
  },
  {
    key: 'joined',
    header: 'Joined',
    align: 'end',
    nowrap: true,
    priority: 2,
    cell: (u) => wallTimeOf(u.joinedAt),
  },
];

function Units({ detail }: { readonly detail: HoldDetailDto }) {
  return (
    <Section
      id="hold-units-title"
      testId="hold-units-section"
      title="Units in the scope"
      description={
        detail.unitsTruncated
          ? undefined
          : `${countOf(detail.units.length, 'unit')}, by run and part.`
      }
    >
      {detail.unitsTruncated ? (
        <Callout tone="warn" role="status" data-testid="hold-units-truncated" className="mb-3">
          More units are in the scope than are listed.
        </Callout>
      ) : null}
      <DataTable
        caption="Units in the hold's scope"
        testId="hold-units"
        columns={UNIT_COLUMNS}
        rows={detail.units}
        rowKey={unitKey}
        rowTestId={(u) => `hold-unit-${unitKey(u)}`}
        // At most 50 tab stops, and a way past them to the history (G-33), as the lot's units.
        pageSize={UNITS_PAGE_SIZE}
        skipToDetails="hold-history-title"
        skipLabel="Skip past the units"
        density="compact"
        empty={
          <EmptyState
            size="inline"
            icon="info"
            testId="hold-units-empty"
            title="No unit in the scope yet"
            body="Units join as the genealogy links them to the held subject."
          />
        }
      />
    </Section>
  );
}

const TRANSITION_TEXT: Readonly<Record<HoldDetailDto['transitions'][number]['kind'], string>> = {
  opened: 'Opened',
  commented: 'Commented',
  released: 'Released',
  rejected: 'Rejected',
};

type Transition = HoldDetailDto['transitions'][number];

/** An ERP notification the ERP did not take is abnormal: a badge; the others are words. */
function Notification({ notification }: { readonly notification: Transition['notification'] }) {
  if (notification === null) return <>not notified</>;
  const refused = notification.status === 'refused' || notification.status === 'conflict';
  const attempts = countOf(notification.attempts, 'attempt');
  return (
    <>
      {refused ? (
        <Badge tone="alarm">{notification.status}</Badge>
      ) : (
        <span>{notification.status}</span>
      )}{' '}
      ({attempts})
      {notification.lastError ? (
        <span className="block text-xs text-alarm-ink">{notification.lastError}</span>
      ) : null}
    </>
  );
}

const TRANSITION_COLUMNS: readonly Column<Transition>[] = [
  { key: 'n', header: '#', numeric: true, cell: (t) => t.n },
  {
    key: 'kind',
    header: 'What',
    nowrap: true,
    rowHeader: true,
    cell: (t) => TRANSITION_TEXT[t.kind],
  },
  {
    key: 'reason',
    header: 'Reason',
    nowrap: true,
    priority: 3,
    cell: (t) => (t.reason ? <Code>{t.reason}</Code> : <Missing reason="No reason" />),
  },
  {
    key: 'comment',
    header: 'Comment',
    priority: 2,
    cell: (t) =>
      t.comment ? (
        <span className="break-words">{t.comment}</span>
      ) : (
        <Missing reason="No comment" />
      ),
  },
  { key: 'by', header: 'By', nowrap: true, priority: 2, cell: (t) => t.by },
  {
    key: 'at',
    header: 'When',
    cell: (t) => (
      <span data-testid="hold-transition-at">
        {wallTimeOf(t.at)}
        {plantBeside(t.plantAt)}
      </span>
    ),
  },
  {
    key: 'scope',
    header: 'Scope told',
    priority: 3,
    cell: (t) =>
      t.scope ? (
        `${scopeText(t.scope)}${t.scope.final ? '' : ' (provisional)'}`
      ) : (
        <Missing reason="Not notified" />
      ),
  },
  {
    key: 'notification',
    header: 'ERP notification',
    priority: 3,
    cell: (t) => <Notification notification={t.notification} />,
  },
];

function Transitions({ detail }: { readonly detail: HoldDetailDto }) {
  return (
    <Section
      id="hold-history-title"
      testId="hold-history"
      title="Transitions and comments"
      description="In order, with the notification each sent to the ERP."
    >
      <DataTable
        caption="Transitions and comments in order, with their ERP notifications"
        testId="hold-transitions"
        columns={TRANSITION_COLUMNS}
        rows={detail.transitions}
        rowKey={(t) => String(t.n)}
        rowTestId={(t) => `hold-transition-${String(t.n)}`}
        // On a phone one card per transition, so its comment and its author stay readable.
        narrow="stack"
        rowProps={(t) => ({
          'data-kind': t.kind,
          'data-notification': t.notification?.status ?? '',
        })}
      />
    </Section>
  );
}

type Incident = HoldDetailDto['incidents'][number];

const INCIDENT_COLUMNS: readonly Column<Incident>[] = [
  { key: 'lot', header: 'Lot', nowrap: true, rowHeader: true, cell: (i) => <Code>{i.lot}</Code> },
  { key: 'machine', header: 'Machine', nowrap: true, cell: (i) => <Code>{i.equipment}</Code> },
  { key: 'part', header: 'Part', numeric: true, priority: 3, cell: (i) => i.partId },
  {
    key: 'operation',
    header: 'Operation',
    nowrap: true,
    priority: 3,
    cell: (i) => (
      <>
        {i.operation ?? <Missing reason="No operation" />}
        {i.pass === null ? '' : ` (pass ${String(i.pass)})`}
      </>
    ),
  },
  { key: 'consumed', header: 'Consumed', nowrap: true, cell: (i) => timeOf(i.consumedAt) },
  {
    key: 'detected',
    header: 'Detected',
    nowrap: true,
    priority: 2,
    cell: (i) => wallTimeOf(i.detectedAt),
  },
  { key: 'message', header: 'Message', priority: 3, cell: (i) => i.message },
];

function Incidents({ detail }: { readonly detail: HoldDetailDto }) {
  return (
    <Section
      id="hold-incidents-title"
      testId="hold-incidents"
      title="Held material consumed"
      description="Cycles that consumed a held lot after the opening: the hold never stops a machine."
    >
      <DataTable
        caption="Consumptions of a held lot after the opening"
        testId="hold-incident-list"
        columns={INCIDENT_COLUMNS}
        rows={detail.incidents}
        rowKey={(i) => String(i.id)}
        rowTestId={(i) => `hold-incident-${String(i.id)}`}
        rowTone={() => 'warn'}
        empty={
          <EmptyState
            size="inline"
            icon="check"
            testId="hold-incidents-empty"
            title="No held material consumed"
            body="No cycle consumed a held lot after the opening."
          />
        }
      />
    </Section>
  );
}

/** The page's sections in reading order (design system 3.4). */
const SECTIONS: readonly SectionNavItem[] = [
  { id: 'hold-scope-title', label: 'Scope' },
  { id: 'hold-units-title', label: 'Units in the scope' },
  { id: 'hold-history-title', label: 'Transitions and comments' },
  { id: 'hold-incidents-title', label: 'Held material consumed' },
];

/** The header's title for a hold: "Hold on Lot `K1`", the id in monospace. */
function holdTitle(hold: HoldDto): ReactNode {
  return (
    <>
      Hold on {SUBJECT_TEXT[hold.subject.kind]}{' '}
      <Code className="whitespace-nowrap">{hold.subject.id}</Code>
    </>
  );
}

/** The key facts (Q-02): the subject, the reason, who opened and decided it and when. */
function HoldFacts({ hold }: { readonly hold: HoldDto }) {
  const facts: Fact[] = [
    { term: 'Subject', detail: <SubjectLink subject={hold.subject} /> },
    { term: 'Reason', detail: <Code>{hold.reason}</Code> },
    {
      term: 'Opened',
      detail: (
        <span data-testid="hold-opened">
          {hold.openedBy}, {wallTimeOf(hold.openedAt)}
        </span>
      ),
    },
    {
      term: 'Opened at plant time',
      detail: hold.openedPlantAt === null ? null : timeOf(hold.openedPlantAt),
    },
    {
      term: 'Decided',
      detail: hold.decidedBy ? (
        <span data-testid="hold-decided">
          {hold.decidedBy}, {wallTimeOf(hold.decidedAt)}
          {plantBeside(hold.decidedPlantAt)} ({hold.decisionReason})
        </span>
      ) : null,
    },
    { term: 'Version', detail: <span className="tabular-nums">{hold.version}</span> },
  ];
  return (
    <div data-testid="hold-summary" data-state={hold.state} data-version={String(hold.version)}>
      <DescriptionList facts={facts} columns={4} label="Hold facts" />
      <HoldEffect />
    </div>
  );
}

function HoldDetail({ id }: { readonly id: string }) {
  const queryClient = useQueryClient();
  const read = useQuery({
    queryKey: qualityKeys.hold(id),
    queryFn: ({ signal }) => getHold(id, signal),
  });
  const live = useLiveQuality();
  const detail = read.data;
  const hold = detail ? newestHold(detail.hold, live) : undefined;
  const canHold = useCan('quality:hold');
  const canRelease = useCan('quality:release');
  const offered = useOffered(hold);
  const reasons = useQuery({
    queryKey: qualityKeys.reasons,
    queryFn: ({ signal }) => getHoldReasons(signal),
    staleTime: Infinity,
    enabled: canRelease,
  });
  const [open, setOpen] = useState<HoldDraft | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const onRead = async () => {
    await queryClient.refetchQueries({ queryKey: qualityKeys.hold(id) });
  };

  if (read.isPending) {
    // No `h1` until the hold is read: the heading takes the focus when it mounts.
    return (
      <div className="flex flex-col gap-6" data-testid="hold-detail" data-hold={id}>
        <BackLink back={BACK} />
        <Skeleton shape="card" label="Loading the hold…" />
      </div>
    );
  }
  if (read.error instanceof ApiError && read.error.status === 404) {
    return <HoldNotFound id={id} />;
  }
  if (read.isError || !detail || !hold) {
    return (
      <section aria-labelledby="hold-title" data-testid="hold-detail" data-hold={id}>
        <PageHeader
          id="hold-title"
          back={BACK}
          title={
            <>
              Hold <Code className="break-all">{id}</Code>
            </>
          }
          documentTitle={`Hold ${id}`}
        />
        <QueryError what="the hold" error={read.error} onRetry={() => void read.refetch()} />
      </section>
    );
  }

  return (
    <section
      aria-labelledby="hold-title"
      data-testid="hold-detail"
      data-hold={id}
      data-state={hold.state}
      data-subject={`${hold.subject.kind}:${hold.subject.id}`}
    >
      <PageHeader
        id="hold-title"
        back={BACK}
        title={holdTitle(hold)}
        documentTitle={`Hold on ${subjectText(hold.subject)}`}
        status={<HoldStateBadge state={hold.state} />}
        actions={
          open === undefined && offered.length > 0 ? (
            <>
              {offered.map((action) => (
                <Button
                  key={action}
                  variant={ACTION_VARIANT[action]}
                  data-testid={`hold-action-${action}`}
                  onClick={() => {
                    setDone(undefined);
                    setOpen({ action, version: hold.version, reason: '', comment: '' });
                  }}
                >
                  {ACTION_TEXT[action].label}
                </Button>
              ))}
            </>
          ) : undefined
        }
        meta={<HoldFacts hold={hold} />}
      />
      {!canHold && !canRelease ? (
        <Callout tone="neutral" data-testid="hold-read-only" className="mb-4">
          Your role cannot change holds: shown read-only.
        </Callout>
      ) : null}
      {done && !open ? (
        <Callout tone="ok" role="status" data-testid="hold-done" className="mb-4">
          {done}
        </Callout>
      ) : null}
      {open ? (
        <div className="mb-6">
          <HoldForm
            // A new draft (another action or version) starts a new form: nothing carries over.
            key={`${open.action}:${String(open.version)}`}
            hold={hold}
            initial={open}
            reasons={
              open.action === 'comment' ? [] : reasonsFor(reasons.data?.reasons ?? [], open.action)
            }
            onRead={onRead}
            onClose={(text) => {
              const closed = open.action;
              setOpen(undefined);
              setDone(text);
              requestAnimationFrame(() => {
                focusAfterClose(closed);
              });
            }}
          />
        </div>
      ) : null}
      <SectionNav items={SECTIONS} testId="hold-section-nav" />
      <div className="mt-6">
        <Scope detail={detail} hold={hold} />
        <Units detail={detail} />
        <Transitions detail={detail} />
        <Incidents detail={detail} />
      </div>
    </section>
  );
}

/** An unknown hold, or an id that cannot be one: the not-found page (G-21, H-04). */
function HoldNotFound({ id }: { readonly id: string }) {
  return (
    <NotFound
      kind="hold"
      id={id}
      back={{ to: '/quality/holds', label: BACK.label }}
      testId="hold-missing"
    />
  );
}

/** The route's screen: keyed by the hold id, holding the `quality` topic. */
export function HoldDetailRoute() {
  const { id } = useParams({ from: '/quality/holds/$id' });
  useQualityTopic();
  if (!HOLD_ID.test(id)) return <HoldNotFound id={id} />;
  return <HoldDetail key={id} id={id.toLowerCase()} />;
}
