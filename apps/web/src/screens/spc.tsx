import {
  SPC_CHART_NAMES,
  type CharacteristicDto,
  type LimitVersionDto,
  type SpcChartDto,
  type SpcChartName,
  type SpcPointDto,
  type SpcSignalDto,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState, type SubmitEvent } from 'react';
import { ApiError } from '../api/client.ts';
import {
  acknowledgeSignal,
  createLimits,
  endLimits,
  getCharacteristics,
  getSpcChart,
  qualityKeys,
  type ChartWindow,
} from '../api/quality.ts';
import { useCan, useUnsavedDraft } from '../auth/auth.tsx';
import { EChart } from '../chart/echart.tsx';
import { spcChartOption } from '../chart/spc-options.ts';
import { CHART_SIZES } from '../chart/theme.ts';
import { QueryError } from '../components/query-error.tsx';
import {
  CommentInput,
  FailureMessage,
  SignalStatusBadge,
  plantBeside,
  timeOf,
  wallTimeOf,
} from '../components/quality-ui.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button, buttonClass } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { Select } from '../components/ui/controls.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { DescriptionList, type Fact } from '../components/ui/description-list.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing } from '../components/ui/format.tsx';
import { Icon } from '../components/ui/icons.tsx';
import { NotFound } from '../components/ui/not-found.tsx';
import {
  BACK_LINK_ACTIVE,
  PageHeader,
  type PageHeaderBack,
} from '../components/ui/page-header.tsx';
import { PlantTimeInput, readPlantTime } from '../components/ui/plant-time-input.tsx';
import { Section } from '../components/ui/section.tsx';
import { SectionNav, type SectionNavItem } from '../components/ui/section-nav.tsx';
import { SegmentedLinks } from '../components/ui/segmented-links.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import {
  CHART_TEXT,
  COMMENT_MAX,
  RULE_SHORT,
  canAcknowledgeSignal,
  canSuggestHold,
  commentProblem,
  finalityText,
  fromPlantInput,
  isOpenEpisode,
  isStale,
  limitsDraftProblems,
  mergeSignals,
  newestCharacteristic,
  pointsInWindow,
  qualityFailure,
  rulesText,
  suggestedWindow,
  toPlantInput,
  type QualityFailure,
} from '../domain/quality.ts';
import {
  fixedText,
  plainText,
  pointDecimals,
  spcPrecision,
  spcValueText,
  type SpcPrecision,
} from '../domain/numbers.ts';
import { useLiveQuality, useQualityTopic } from '../live/live-context.tsx';
import { upsertCharacteristic, upsertSignal } from '../live/live-quality.ts';
import type { SpcChartSearch } from '../routes/quality.ts';

// `/quality/spc` and `/quality/spc/$characteristic` (#203, plan "Web", ADR-0032): the
// characteristics, and one characteristic's I-MR and X̄-R charts with limits, zones, provisional
// and final points, retests apart, signal episodes (provisional, final, extent final, withdrawn),
// acknowledgement (`spc:ack`), limit versions with re-estimation and ending (`spc:limits`) and the
// `baseline-changed` notice; live through the `quality` topic (read first, then pushes by id).
// On the design system since UX-9a (#332): `PageHeader`, the range on `SegmentedLinks` and
// `PlantTimeInput`, episodes and limit versions on `DataTable`, every state.

const CHARACTERISTIC_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Episodes listed at most at once (newest first); the rest are counted. */
export const SIGNALS_SHOWN = 100;

const BACK: PageHeaderBack = { label: 'SPC charts', link: { to: '/quality/spc' } };

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Where the focus goes once a form has closed: the control named by its test id (the button that
 * opened the form), else the section's heading. Set when the form closes, applied after the render
 * that removed it.
 */
function useFocusAfterClose(): (testId: string | undefined, headingId: string) => void {
  const next = useRef<{ testId: string | undefined; headingId: string } | null>(null);
  useEffect(() => {
    const target = next.current;
    if (!target) return;
    next.current = null;
    const own =
      target.testId === undefined
        ? null
        : document.querySelector<HTMLElement>(`[data-testid="${target.testId}"]`);
    const heading = document.getElementById(target.headingId);
    if (heading && !heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    (own ?? heading)?.focus();
  });
  return (testId, headingId) => {
    next.current = { testId, headingId };
  };
}

function Baseline({ characteristic }: { readonly characteristic: CharacteristicDto }) {
  const { baseline, currentLimits } = characteristic;
  return (
    <p
      className="text-sm text-ink-secondary"
      data-testid="spc-baseline"
      data-limits={currentLimits === null ? 'none' : String(currentLimits)}
      data-final={String(baseline.final)}
      data-needed={String(baseline.needed)}
    >
      {currentLimits === null
        ? `No control limits yet: version 1 is estimated once the baseline's ${String(baseline.needed)} first-pass readings are final (${String(Math.min(baseline.final, baseline.needed))} so far).`
        : `Judged by limit version ${String(currentLimits)} (the highest); version 1 came from the first ${String(baseline.needed)} final first-pass readings and is never re-derived.`}
    </p>
  );
}

function Notice({
  characteristic,
  onEstimate,
}: {
  readonly characteristic: CharacteristicDto;
  readonly onEstimate: (() => void) | undefined;
}) {
  const notice = characteristic.notice;
  if (!notice) return null;
  return (
    <Callout
      tone="warn"
      role="alert"
      title="Baseline changed"
      data-testid="spc-notice"
      data-kind={notice.kind}
      className="mb-6"
    >
      <p>
        {notice.detail} Version 1 is not re-derived: a quality user decides whether to estimate a
        new version (noticed {wallTimeOf(notice.at)}).
      </p>
      {onEstimate ? (
        <Button size="sm" data-testid="notice-estimate" className="mt-2" onClick={onEstimate}>
          Estimate a new version
        </Button>
      ) : null}
    </Callout>
  );
}

/** The unacknowledged episodes as a count (C-01): `warn`, the reason to open the chart. */
function UnacknowledgedBadge({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <Badge tone="warn" data-testid="spc-unacknowledged" data-count={String(count)}>
      {count} not acknowledged
    </Badge>
  );
}

function NoticeBadge({ characteristic }: { readonly characteristic: CharacteristicDto }) {
  return characteristic.notice ? (
    <Badge tone="warn" variant="outline">
      Baseline changed
    </Badge>
  ) : null;
}

// ---- The characteristics ----

function CharacteristicCard({ characteristic: c }: { readonly characteristic: CharacteristicDto }) {
  const facts: Fact[] = [
    { term: 'Equipment', detail: <Code>{c.equipment}</Code> },
    { term: 'Operation', detail: <Code>{c.operation}</Code> },
    { term: 'Unit', detail: c.unit },
    { term: 'Upper specification', detail: `${plainText(c.upperSpec)} ${c.unit}` },
    {
      term: 'Open episodes',
      detail: <span className="tabular-nums">{c.signals.open}</span>,
    },
    {
      term: 'Limits',
      detail:
        c.currentLimits === null ? (
          <Missing reason="No limit version yet" />
        ) : (
          `Version ${String(c.currentLimits)}`
        ),
    },
  ];
  return (
    <Card
      as="article"
      tone={c.signals.unacknowledged > 0 || c.notice ? 'warn' : undefined}
      title={
        <Link
          to="/quality/spc/$characteristic"
          params={{ characteristic: c.id }}
          search={{}}
          data-testid={`spc-link-${c.id}`}
          className="text-link underline-offset-4 hover:underline"
        >
          {c.name}
        </Link>
      }
      status={
        <>
          <UnacknowledgedBadge count={c.signals.unacknowledged} />
          <NoticeBadge characteristic={c} />
        </>
      }
      className="h-full"
    >
      <DescriptionList facts={facts} columns={2} label={`${c.name}: facts`} />
      <div className="mt-1">
        <Baseline characteristic={c} />
      </div>
      {c.notice ? (
        <p className="mt-2 text-sm text-ink">
          A late reading changed the baseline: a decision on a new limit version is pending.
        </p>
      ) : null}
    </Card>
  );
}

/** `/quality/spc`: the characteristics with their limits, baseline, notice and open episodes. */
export function SpcList() {
  useQualityTopic();
  const read = useQuery({
    queryKey: qualityKeys.characteristics,
    queryFn: ({ signal }) => getCharacteristics(signal),
  });
  const live = useLiveQuality();
  const items = (read.data?.characteristics ?? []).map((c) => newestCharacteristic(c, live));
  return (
    <section aria-labelledby="spc-title" data-testid="spc-list">
      <PageHeader
        id="spc-title"
        title="SPC charts"
        description="Control charts of first-pass readings; a signal is an episode a person acknowledges."
        meta={
          <Disclosure summary="What this page shows">
            <p className="max-w-[90ch] text-ink-secondary">
              Statistical process control on first-pass readings: I-MR and X̄-R charts against frozen
              limit versions. A signal is an episode a person acknowledges; no hold opens by itself.
            </p>
          </Disclosure>
        }
        summary={read.data ? plural(items.length, 'characteristic') : undefined}
      />
      {read.isPending ? (
        <Skeleton shape="card" label="Loading the characteristics…" />
      ) : read.isError ? (
        <QueryError
          what="the characteristics"
          error={read.error}
          onRetry={() => void read.refetch()}
        />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            testId="spc-empty"
            icon="search"
            title="No characteristic is configured"
            body="A characteristic is charted here once the plant configuration names one."
          />
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {items.map((c) => (
            <li
              key={c.id}
              data-testid={`spc-characteristic-${c.id}`}
              data-version={String(c.version)}
              data-limits={c.currentLimits === null ? 'none' : String(c.currentLimits)}
              data-open={String(c.signals.open)}
              data-unacknowledged={String(c.signals.unacknowledged)}
              data-notice={c.notice ? c.notice.kind : ''}
            >
              <CharacteristicCard characteristic={c} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- One characteristic: the points shown ----

type WindowMode = 'recent' | 'all' | 'range';

/** The range's two ends read from the form: each empty, an instant, or not a time. */
function readEnd(form: FormData, name: string): { kind: 'empty' | 'ok' | 'error'; iso?: string } {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === 'string' ? value : '';
  };
  const reading = readPlantTime(text(`${name}-date`), text(`${name}-time`), {
    withSeconds: true,
    variant: 'plant',
  });
  return reading.kind === 'ok'
    ? { kind: 'ok', iso: new Date(reading.instant).toISOString() }
    : { kind: reading.kind };
}

/**
 * The points shown (C-07): the last 500 readings or every reading as links that change the URL,
 * and a plant-time range on `PlantTimeInput` (two plain boxes each, not the native pickers).
 */
function WindowPicker({ id, search }: { readonly id: string; readonly search: SpcChartSearch }) {
  const navigate = useNavigate();
  const mode: WindowMode =
    search.from !== undefined || search.to !== undefined ? 'range' : search.all ? 'all' : 'recent';
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const problemId = useId();
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const a = readEnd(data, 'chart-window-from');
    const b = readEnd(data, 'chart-window-to');
    if (a.kind === 'error' || b.kind === 'error') {
      setProblem('Give each time as a date and a time.');
      return;
    }
    if (a.iso === undefined && b.iso === undefined) {
      setProblem('Give at least one end of the range.');
      return;
    }
    if (a.iso !== undefined && b.iso !== undefined && Date.parse(a.iso) > Date.parse(b.iso)) {
      setProblem('The range’s end must not be before its start.');
      return;
    }
    setProblem(undefined);
    void navigate({
      to: '/quality/spc/$characteristic',
      params: { characteristic: id },
      search: { from: a.iso, to: b.iso },
    });
  };
  return (
    <div data-testid="chart-window" data-mode={mode} className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden="true" className="text-sm font-medium text-ink">
          Points shown
        </span>
        <SegmentedLinks
          label="Points shown"
          testId="chart-window-mode"
          current={mode}
          items={[
            {
              key: 'recent',
              label: 'Last 500 readings',
              to: '/quality/spc/$characteristic',
              params: { characteristic: id },
              search: {},
              testId: 'chart-window-recent',
            },
            {
              key: 'all',
              label: 'Every reading',
              to: '/quality/spc/$characteristic',
              params: { characteristic: id },
              search: { all: true },
              testId: 'chart-window-all',
            },
          ]}
        />
        {mode === 'range' ? (
          <p className="text-sm text-ink" data-testid="chart-window-range">
            Showing a plant-time range:{' '}
            {search.from === undefined ? 'from the first reading' : timeOf(search.from)} –{' '}
            {search.to === undefined ? 'the latest reading' : timeOf(search.to)}.{' '}
            <Link
              to="/quality/spc/$characteristic"
              params={{ characteristic: id }}
              search={{}}
              // Not the page: `{}` is a subset of the range's search, which the router counts.
              activeOptions={{ exact: true, includeSearch: true }}
              data-testid="chart-window-clear"
              className="text-link underline underline-offset-2 hover:text-accent-hover"
            >
              Clear the range
            </Link>
          </p>
        ) : null}
      </div>
      <form
        noValidate
        aria-label="A plant-time range"
        className="flex flex-wrap items-end gap-x-4 gap-y-3"
        onSubmit={onSubmit}
      >
        <PlantTimeInput
          label="From"
          name="chart-window-from"
          testId="chart-window-from"
          withSeconds
          value={search.from ?? null}
          onChange={() => {
            setProblem(undefined);
          }}
        />
        <PlantTimeInput
          label="To"
          name="chart-window-to"
          testId="chart-window-to"
          withSeconds
          value={search.to ?? null}
          onChange={() => {
            setProblem(undefined);
          }}
        />
        {/* Level with the boxes, above their hint lines. */}
        <div className="pb-5">
          <Button
            type="submit"
            data-testid="chart-window-apply"
            aria-describedby={problem ? problemId : undefined}
          >
            Show the range
          </Button>
        </div>
        {problem ? (
          <p
            id={problemId}
            role="alert"
            data-testid="chart-window-problem"
            className="flex w-full items-start gap-1 text-sm font-medium text-alarm-ink"
          >
            <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
            {problem}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function PointsFrom({ pointsFrom }: { readonly pointsFrom: string | null }) {
  return (
    <span data-testid="chart-points-from">
      {pointsFrom === null ? (
        'Every point up to the end of the range is shown.'
      ) : (
        <>
          Points before {timeOf(pointsFrom)} are left out; limits, counts and episodes stay whole.
        </>
      )}
    </span>
  );
}

// ---- The charts ----

function pointColumns(
  precision: SpcPrecision,
  places: number,
  unit: string,
): readonly Column<SpcPointDto>[] {
  return [
    { key: 'at', header: 'Plant time', nowrap: true, cell: (p) => timeOf(p.at) },
    { key: 'part', header: 'Part', numeric: true, priority: 2, cell: (p) => p.partId },
    {
      key: 'value',
      // The unit on a line of its own, so the column is no wider than its figures.
      header: (
        <>
          Value <span className="block font-normal">({unit})</span>
        </>
      ),
      numeric: true,
      cell: (p) => <span className="font-mono">{spcValueText(p.value, precision, places)}</span>,
    },
    {
      key: 'rules',
      header: 'Rules',
      cell: (p) => (p.rules.length === 0 ? <Missing reason="No rule fires" /> : p.rules.join(', ')),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => (
        <>
          {p.final ? 'Final' : 'Provisional'}
          {p.baseline ? ', baseline' : ''}
          {/* The limits that judged it: a column of its own did not fit beside the chart. */}
          <span className="block text-xs whitespace-nowrap text-ink-secondary">
            {p.version === null ? 'Not judged' : `Limits v${String(p.version)}`}
          </span>
        </>
      ),
    },
  ];
}

const pointKey = (p: SpcPointDto): string =>
  `${String(p.epoch)}-${String(p.seq)}-${String(p.partId)}`;
const pointProps = (p: SpcPointDto) => ({
  'data-final': String(p.final),
  'data-rules': p.rules.join(','),
});

function ChartFigure({
  chart,
  view,
  signals,
}: {
  readonly chart: SpcChartName;
  readonly view: SpcChartDto;
  readonly signals: readonly SpcSignalDto[];
}) {
  const [showAll, setShowAll] = useState(false);
  const valuesId = useId();
  const points = view.points[chart];
  const precision = spcPrecision(view.characteristic.resolution);
  const places = pointDecimals(precision, chart);
  const unit = chart === 'I' || chart === 'Xbar' ? view.characteristic.unit : 'range';
  const option = useMemo(
    () =>
      points.length === 0
        ? null
        : spcChartOption({
            chart,
            points,
            limits: view.limits,
            signals,
            retests: view.retests,
            unit,
            resolution: view.characteristic.resolution,
          }),
    [chart, points, view.limits, view.retests, unit, view.characteristic.resolution, signals],
  );
  const columns = useMemo(
    () => pointColumns(precision, places, view.characteristic.unit),
    [precision, places, view.characteristic.unit],
  );
  const firing = points.filter((p) => p.rules.length > 0);
  const provisional = points.filter((p) => !p.final).length;
  const label = CHART_TEXT[chart].label;
  return (
    <EChart
      testId={`spc-chart-${chart}`}
      title={label}
      description={`${label}: ${String(points.length)} points, ${String(firing.length)} firing a rule, ${String(provisional)} provisional; the values are in the tables below.`}
      option={option}
      height={CHART_SIZES.compact}
    >
      {points.length === 0 ? (
        <EmptyState
          testId={`spc-no-points-${chart}`}
          title="No point yet"
          body="Points appear as the tester's first-pass readings arrive."
        />
      ) : null}
      <p className="mt-2 text-sm text-ink-secondary" data-testid={`spc-summary-${chart}`}>
        {points.length} points ({provisional} provisional), {firing.length} firing a rule.
      </p>
      {firing.length > 0 ? (
        <div className="mt-2">
          <DataTable
            testId={`spc-signal-points-${chart}`}
            caption={`${label}: points firing a rule`}
            columns={columns}
            rows={firing.slice(-50)}
            count={firing.length}
            rowKey={pointKey}
            rowProps={pointProps}
            density="compact"
            bounded
          />
        </div>
      ) : null}
      {points.length > 0 ? (
        <div className="mt-3">
          <Button
            size="sm"
            data-testid={`spc-values-toggle-${chart}`}
            aria-expanded={showAll}
            aria-controls={showAll ? valuesId : undefined}
            onClick={() => {
              setShowAll((v) => !v);
            }}
          >
            {showAll ? 'Hide the values' : `Show all ${String(points.length)} values`}
          </Button>
          {showAll ? (
            <div id={valuesId} className="mt-2">
              <DataTable
                bounded
                testId={`spc-values-${chart}`}
                caption={`${label}: every point shown`}
                columns={columns}
                rows={points}
                count={points.length}
                rowKey={pointKey}
                rowProps={pointProps}
                density="compact"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </EChart>
  );
}

// ---- Signals and acknowledgement ----

type SignalFilter = 'all' | 'unacknowledged' | 'open' | 'withdrawn';

const SIGNAL_FILTERS: readonly { id: SignalFilter; label: string }[] = [
  { id: 'all', label: 'Not withdrawn' },
  { id: 'unacknowledged', label: 'Not acknowledged' },
  { id: 'open', label: 'Open' },
  { id: 'withdrawn', label: 'Withdrawn' },
];

function filtered(signals: readonly SpcSignalDto[], filter: SignalFilter): SpcSignalDto[] {
  switch (filter) {
    case 'all':
      return signals.filter((s) => s.status !== 'withdrawn');
    case 'unacknowledged':
      return signals.filter(canAcknowledgeSignal);
    case 'open':
      return signals.filter(isOpenEpisode);
    case 'withdrawn':
      return signals.filter((s) => s.status === 'withdrawn');
  }
}

interface AckDraft {
  readonly signal: number;
  /** The `rowVersion` it started on. */
  readonly version: number;
  readonly comment: string;
}

/** The inline forms' frame, as the hold and order actions' (UX-9b). */
const FORM_FRAME =
  'mb-4 flex max-w-3xl flex-col gap-4 rounded-lg border border-line bg-surface p-4 text-ink sm:p-5';

function AckForm({
  signal,
  onClose,
  onRead,
}: {
  readonly signal: SpcSignalDto;
  readonly onClose: (done?: string) => void;
  readonly onRead: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AckDraft>({
    signal: signal.id,
    version: signal.rowVersion,
    comment: '',
  });
  const [failure, setFailure] = useState<QualityFailure | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const sending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const commentId = useId();
  useUnsavedDraft(draft.comment.trim() !== '');
  useEffect(() => {
    form.current?.querySelector('textarea')?.focus();
  }, []);
  const stale = isStale(draft.version, signal.rowVersion);
  const applies = canAcknowledgeSignal(signal);
  const write = useMutation({
    mutationFn: (from: AckDraft) =>
      acknowledgeSignal(from.signal, { version: from.version, comment: from.comment.trim() }),
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: (answer) => {
      upsertSignal(queryClient, answer);
      void onRead();
      onClose(`Episode ${String(answer.id)} acknowledged.`);
    },
    onError: async (error) => {
      const found = qualityFailure(error, {
        not: 'Not acknowledged',
        what: 'this acknowledgement',
        thing: 'episode',
      });
      setFailure(found);
      if (found.kind !== 'invalid' && found.kind !== 'busy' && found.kind !== 'unavailable') {
        await onRead();
      }
    },
  });
  return (
    <form
      ref={form}
      noValidate
      aria-label={`Acknowledge episode ${String(signal.id)}`}
      data-testid="ack-form"
      data-signal={String(signal.id)}
      data-version={String(draft.version)}
      className={FORM_FRAME}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (stale || !applies || sending.current) return;
        const found = commentProblem(draft.comment, true);
        setProblem(found);
        if (found) return;
        setFailure(undefined);
        sending.current = true;
        write.mutate(draft);
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">Acknowledge episode {signal.id}</h3>
        <p className="text-sm">
          {CHART_TEXT[signal.chart].short} chart, rule {signal.rule}: {signal.ruleText}.
          Acknowledges the episode once, with your comment (audited). No hold follows by itself.
        </p>
      </div>
      {failure ? <FailureMessage failure={failure} testId="ack-message" /> : null}
      {problem ? (
        <Callout tone="alarm" role="alert" data-testid="ack-invalid">
          {problem}
        </Callout>
      ) : null}
      {stale ? (
        <Callout
          tone="warn"
          role="alert"
          data-testid="ack-stale"
          data-version={String(signal.rowVersion)}
          title="The episode changed while you wrote this"
        >
          <p>
            It is now at version {signal.rowVersion}, {signal.status}
            {signal.acknowledged ? `, acknowledged by ${signal.acknowledged.by}` : ''}. Nothing is
            sent with the newer version.
            {applies ? ' Check it, then start again: your comment is kept.' : ''}
          </p>
          {applies ? (
            <Button
              size="sm"
              data-testid="ack-restart"
              className="mt-2"
              onClick={() => {
                setDraft((d) => ({ ...d, version: signal.rowVersion }));
                setFailure(undefined);
              }}
            >
              Start again on version {signal.rowVersion}
            </Button>
          ) : null}
        </Callout>
      ) : null}
      <CommentInput
        id={commentId}
        label="Comment"
        value={draft.comment}
        testId="ack-comment"
        max={COMMENT_MAX}
        required
        onChange={(comment) => {
          setDraft((d) => ({ ...d, comment }));
        }}
      />
      {/* Cancel first, the send button last (design system 4.1). */}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="ack-cancel"
          onClick={() => {
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="ack-submit"
          disabled={stale || !applies}
          loading={write.isPending}
        >
          Acknowledge
        </Button>
      </div>
    </form>
  );
}

const SIGNAL_COLUMNS: readonly Column<SpcSignalDto>[] = [
  { key: 'id', header: 'Id', numeric: true, cell: (s) => s.id },
  {
    key: 'rule',
    header: 'Chart and rule',
    cell: (s) => (
      <>
        <span className="whitespace-nowrap">
          {CHART_TEXT[s.chart].short}, rule {s.rule}
        </span>
        <span className="block text-xs text-ink-secondary">{s.ruleText}</span>
      </>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (s) => (
      <>
        <SignalStatusBadge signal={s} />
        <span className="mt-0.5 block text-xs text-ink-secondary" data-testid="signal-finality">
          {finalityText(s)}
        </span>
        {s.baseline ? (
          <span className="block text-xs font-semibold" data-testid="signal-baseline">
            Baseline episode (judged when version {s.version} was created)
          </span>
        ) : null}
        {s.withdrawnReason ? (
          <span className="block text-xs" data-testid="signal-withdrawn-reason">
            Withdrawn: {s.withdrawnReason}
          </span>
        ) : null}
        {/* The acknowledgement as the status's last line, so the table fits at 768. */}
        {s.acknowledged ? (
          <span className="mt-1 block text-xs">
            Acknowledged:{' '}
            <span data-testid="signal-ack">
              {s.acknowledged.by}, {wallTimeOf(s.acknowledged.at)}
              {plantBeside(s.acknowledged.plantAt)}: “{s.acknowledged.comment}”
              {s.orphaned ? ' (orphaned: the episode was withdrawn)' : ''}
            </span>
          </span>
        ) : s.status === 'withdrawn' ? null : (
          <span className="mt-1 block text-xs text-ink-secondary">Not acknowledged</span>
        )}
      </>
    ),
  },
  {
    key: 'first',
    header: 'First point',
    cell: (s) => (
      <>
        <span className="whitespace-nowrap">{timeOf(s.first.at)}</span>{' '}
        <span className="whitespace-nowrap">(part {s.first.partId})</span>
        <span className="block text-xs text-ink-secondary">
          {isOpenEpisode(s) ? 'open, last ' : 'closed, last '}
          {timeOf(s.last.at)} · {plural(s.points, 'point')} · v{s.version}
        </span>
      </>
    ),
  },
];

function Signals({
  signals,
  onRead,
}: {
  readonly signals: readonly SpcSignalDto[];
  readonly onRead: () => Promise<void>;
}) {
  const canAck = useCan('spc:ack');
  const canHold = useCan('quality:hold');
  const [filter, setFilter] = useState<SignalFilter>('all');
  const [open, setOpen] = useState<number | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const shown = filtered(signals, filter);
  const opened = open === undefined ? undefined : signals.find((s) => s.id === open);
  const hasActions = canAck || canHold;
  const focusAfterClose = useFocusAfterClose();
  const rowActions = (s: SpcSignalDto) => (
    <>
      {canAck && canAcknowledgeSignal(s) && open !== s.id ? (
        <Button
          variant="ghost"
          size="sm"
          data-testid={`ack-${String(s.id)}`}
          aria-label={`Acknowledge episode ${String(s.id)}`}
          onClick={() => {
            setDone(undefined);
            setOpen(s.id);
          }}
        >
          Acknowledge
        </Button>
      ) : null}
      {canHold && canSuggestHold(s) ? (
        <Link
          to="/quality/holds/new"
          search={{ signal: s.id }}
          data-testid={`hold-from-${String(s.id)}`}
          // The containing block of its visually hidden words (UX-8).
          className={`${buttonClass({ variant: 'ghost', size: 'sm' })} relative`}
        >
          Open a hold <span className="sr-only">from episode {s.id}</span>
        </Link>
      ) : null}
    </>
  );
  return (
    <Section
      id="spc-signals-title"
      testId="spc-signals"
      title="Signal episodes"
      description="Provisional until the tester is final through the triggering point; final episodes keep their identity, their extent is final with “extent final”."
      actions={
        <Select
          label="Show"
          inline
          name="signal-filter"
          data-testid="signal-filter"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as SignalFilter);
          }}
        >
          {SIGNAL_FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      }
    >
      {done && !opened ? (
        <Callout tone="ok" role="status" data-testid="ack-done" className="mb-4">
          {done}
        </Callout>
      ) : null}
      {opened ? (
        <AckForm
          key={opened.id}
          signal={opened}
          onRead={onRead}
          onClose={(text) => {
            const id = opened.id;
            setOpen(undefined);
            setDone(text);
            // Back to the button that opened it; once acknowledged (it is gone), the heading.
            focusAfterClose(
              text === undefined ? `ack-${String(id)}` : undefined,
              'spc-signals-title',
            );
          }}
        />
      ) : null}
      <DataTable
        testId="signal-list"
        caption="Signal episodes, newest first"
        columns={SIGNAL_COLUMNS}
        rows={shown.slice(0, SIGNALS_SHOWN)}
        count={shown.length}
        rowKey={(s) => String(s.id)}
        rowTestId={(s) => `signal-row-${String(s.id)}`}
        rowProps={(s) => ({
          'data-status': s.status,
          'data-chart': s.chart,
          'data-rule': String(s.rule),
          'data-open': String(isOpenEpisode(s)),
          'data-extent-final': String(s.extentFinal),
          'data-baseline': String(s.baseline),
          'data-acknowledged': String(s.acknowledged !== null),
          'data-orphaned': String(s.orphaned),
          'data-row-version': String(s.rowVersion),
        })}
        // Not yet acknowledged is what needs a person: the bar, as the list's count badge.
        rowTone={(s) => (canAcknowledgeSignal(s) ? 'warn' : undefined)}
        {...(hasActions ? { actions: rowActions } : {})}
        narrow="stack"
        skipToDetails={hasActions && shown.length > 0 ? 'spc-limits-title' : undefined}
        skipLabel="Skip past the episodes"
        empty={
          <EmptyState
            testId="signals-empty"
            icon={filter === 'all' ? 'check' : 'search'}
            title="No episode in this view"
            body={
              filter === 'all'
                ? 'No rule has fired on this characteristic’s points.'
                : 'Choose another view of the episodes.'
            }
          />
        }
      />
      {shown.length > SIGNALS_SHOWN ? (
        <p className="mt-2 text-sm text-ink-secondary" data-testid="signals-more">
          {shown.length - SIGNALS_SHOWN} older episodes are not listed.
        </p>
      ) : null}
    </Section>
  );
}

// ---- Limit versions ----

interface LimitsDraft {
  readonly kind: 'create' | 'end';
  /** The characteristic's version it started on. */
  readonly version: number;
  /** The limit version to end. */
  readonly limit?: number | undefined;
  /** Plant-time inputs (`toPlantInput`), empty for none. */
  readonly from: string;
  readonly to: string;
  readonly comment: string;
}

const isoOf = (input: string): string | null =>
  input === '' ? null : (fromPlantInput(input) ?? null);

function LimitsForm({
  characteristic,
  chart,
  initial,
  onClose,
  onRead,
}: {
  readonly characteristic: CharacteristicDto;
  readonly chart: SpcChartDto;
  readonly initial: LimitsDraft;
  readonly onClose: (done?: string) => void;
  readonly onRead: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [failure, setFailure] = useState<QualityFailure | undefined>(undefined);
  const [problems, setProblems] = useState<string[]>([]);
  const sending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const commentId = useId();
  useUnsavedDraft(draft.comment.trim() !== '');
  useEffect(() => {
    form.current?.focus();
  }, []);
  const stale = isStale(draft.version, characteristic.version);
  const write = useMutation({
    mutationFn: (from: LimitsDraft) =>
      from.kind === 'create'
        ? createLimits(characteristic.id, {
            version: from.version,
            from: fromPlantInput(from.from) ?? '',
            to: fromPlantInput(from.to) ?? '',
            comment: from.comment.trim(),
          })
        : endLimits(characteristic.id, from.limit ?? 0, {
            version: from.version,
            comment: from.comment.trim(),
          }),
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: (answer) => {
      upsertCharacteristic(queryClient, answer.characteristic);
      void onRead();
      onClose(
        draft.kind === 'create'
          ? `Limit version ${String(answer.limits.version)} created; it applies from the plant clock on.`
          : `Limit version ${String(answer.limits.version)} ended.`,
      );
    },
    onError: async (error) => {
      const found = qualityFailure(error, {
        not: draft.kind === 'create' ? 'Not created' : 'Not ended',
        what: draft.kind === 'create' ? 'this window' : 'this end',
        thing: 'characteristic',
      });
      setFailure(found);
      if (found.kind === 'stale' || found.kind === 'state') await onRead();
    },
  });
  const from = fromPlantInput(draft.from);
  const to = fromPlantInput(draft.to);
  const inWindow =
    from !== undefined && to !== undefined
      ? pointsInWindow(chart.points.I, from, to, chart.pointsFrom)
      : undefined;
  const title =
    draft.kind === 'create'
      ? 'Estimate a new limit version'
      : `End limit version ${String(draft.limit)}`;
  return (
    <form
      ref={form}
      tabIndex={-1}
      noValidate
      aria-label={draft.kind === 'create' ? 'Estimate a new limit version' : 'End a limit version'}
      data-testid={draft.kind === 'create' ? 'limits-form' : 'limits-end-form'}
      data-version={String(draft.version)}
      className={FORM_FRAME}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (stale || sending.current) return;
        const found =
          draft.kind === 'create'
            ? limitsDraftProblems(draft)
            : [commentProblem(draft.comment, true)].filter((p): p is string => p !== undefined);
        setProblems(found);
        if (found.length > 0) return;
        setFailure(undefined);
        sending.current = true;
        write.mutate(draft);
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm">
          {draft.kind === 'create'
            ? 'From the final first-pass readings whose plant time lies in the window (both ends included): I-MR from every reading, X̄-R from the complete subgroups inside. It applies after every reading received so far; earlier points keep their version. Clears a baseline-changed notice. Audited.'
            : 'Points after every reading received so far are judged by the highest other version open there, or not at all. Audited.'}
        </p>
        <p className="text-xs text-ink-secondary">
          Prepared on version {draft.version} of the characteristic; the MES refuses it if the
          characteristic has changed since.
        </p>
      </div>
      {failure ? <FailureMessage failure={failure} testId="limits-message" /> : null}
      {problems.length > 0 ? (
        <Callout tone="alarm" role="alert" data-testid="limits-invalid">
          {problems.join(' ')}
        </Callout>
      ) : null}
      {stale ? (
        <Callout
          tone="warn"
          role="alert"
          data-testid="limits-stale"
          data-version={String(characteristic.version)}
          title="The characteristic changed while you prepared this"
        >
          <p>
            It is now at version {characteristic.version}: limits or a notice moved. Nothing is sent
            with the newer version. Check the limits, then start again: what you entered is kept.
          </p>
          <Button
            size="sm"
            data-testid="limits-restart"
            className="mt-2"
            onClick={() => {
              setDraft((d) => ({ ...d, version: characteristic.version }));
              setFailure(undefined);
            }}
          >
            Start again on version {characteristic.version}
          </Button>
        </Callout>
      ) : null}
      {draft.kind === 'create' ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-x-4 gap-y-3">
            <PlantTimeInput
              label="Window from"
              name="limits-from"
              testId="limits-from"
              withSeconds
              required
              value={isoOf(draft.from)}
              onChange={(iso) => {
                setDraft((d) => ({ ...d, from: iso === null ? '' : toPlantInput(iso) }));
              }}
            />
            <PlantTimeInput
              label="Window to"
              name="limits-to"
              testId="limits-to"
              withSeconds
              required
              value={isoOf(draft.to)}
              onChange={(iso) => {
                setDraft((d) => ({ ...d, to: iso === null ? '' : toPlantInput(iso) }));
              }}
            />
          </div>
          {inWindow !== undefined ? (
            <p
              className="text-sm"
              data-testid="limits-window-points"
              data-final={String(inWindow.final)}
              data-beyond-shown={String(inWindow.beyondShown)}
            >
              {inWindow.final} final first-pass points shown lie in it
              {inWindow.beyondShown
                ? '; it starts before the first point shown, so the MES counts more readings than this page shows (show every reading to see them)'
                : ''}
              .
            </p>
          ) : null}
        </div>
      ) : null}
      <CommentInput
        id={commentId}
        label="Comment"
        value={draft.comment}
        testId="limits-comment"
        max={COMMENT_MAX}
        required
        onChange={(comment) => {
          setDraft((d) => ({ ...d, comment }));
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="limits-cancel"
          onClick={() => {
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant={draft.kind === 'create' ? 'primary' : 'danger'}
          data-testid="limits-submit"
          disabled={stale}
          loading={write.isPending}
        >
          {draft.kind === 'create' ? 'Create the version' : 'End it'}
        </Button>
      </div>
    </form>
  );
}

/** One column per value (C-07): the I and X̄ limits as lower, centre, upper; MR and R upper. */
function limitColumns(precision: SpcPrecision): readonly Column<LimitVersionDto>[] {
  const stat = (v: LimitVersionDto['charts']['I']['centre']) => (
    <span className="font-mono">{spcValueText(v, precision, precision.statistic)}</span>
  );
  const value = (
    key: string,
    header: string,
    pick: (l: LimitVersionDto) => LimitVersionDto['charts']['I']['centre'],
  ): Column<LimitVersionDto> => ({ key, header, numeric: true, cell: (l) => stat(pick(l)) });
  return [
    {
      // The version names its row; where it applies, who made it, from which window and why go
      // under it, so the values keep one column each and the table fits from 1024 (C-07).
      key: 'version',
      header: 'Version',
      rowHeader: true,
      width: '13rem',
      cell: (l) => (
        <>
          <span className="font-semibold">v{l.version}</span>
          <span className="block text-xs" data-testid="limit-applies">
            Applies {l.from === null ? 'from the first reading' : <>from {timeOf(l.from.at)}</>}
            {l.until ? <> until {timeOf(l.until.at)}</> : null}
          </span>
          {l.endedAt ? (
            <span className="block text-xs" data-testid="limit-ended">
              Ended by {l.endedBy ?? <Missing reason="Not recorded" />}, {timeOf(l.endedAt)}
            </span>
          ) : null}
          <span className="block text-xs text-ink-secondary" data-testid="limit-created">
            Created by {l.createdBy}, {timeOf(l.createdAt)}
          </span>
          <span className="block text-xs text-ink-secondary">
            From {timeOf(l.window.from.at)} – {timeOf(l.window.to.at)}: {l.counts.readings}{' '}
            readings, {l.counts.subgroups} subgroups
          </span>
          {l.comment ? (
            <span className="block text-xs text-ink-secondary">“{l.comment}”</span>
          ) : null}
        </>
      ),
    },
    value('i-lower', 'I lower', (l) => l.charts.I.lower),
    value('i-centre', 'I centre', (l) => l.charts.I.centre),
    value('i-upper', 'I upper', (l) => l.charts.I.upper),
    value('xbar-lower', 'X̄ lower', (l) => l.charts.Xbar.lower),
    value('xbar-centre', 'X̄ centre', (l) => l.charts.Xbar.centre),
    value('xbar-upper', 'X̄ upper', (l) => l.charts.Xbar.upper),
    value('mrange-upper', 'MR upper', (l) => l.charts.MR.upper),
    value('r-upper', 'R upper', (l) => l.charts.R.upper),
    {
      key: 'cpk',
      header: 'Cpk',
      numeric: true,
      cell: (l) => (
        <span data-testid="limit-cpk">
          {l.capability === null ? (
            <Missing reason="Not estimated" />
          ) : (
            fixedText(l.capability.cpk, 2)
          )}
        </span>
      ),
    },
  ];
}

function Limits({
  characteristic,
  chart,
  draft,
  setDraft,
  onRead,
}: {
  readonly characteristic: CharacteristicDto;
  readonly chart: SpcChartDto;
  readonly draft: LimitsDraft | undefined;
  readonly setDraft: (draft: LimitsDraft | undefined) => void;
  readonly onRead: () => Promise<void>;
}) {
  const canLimits = useCan('spc:limits');
  const [done, setDone] = useState<string | undefined>(undefined);
  const versions = [...chart.limits].sort((a, b) => b.version - a.version);
  const precision = spcPrecision(characteristic.resolution);
  const columns = useMemo(() => limitColumns(precision), [precision]);
  const canCreate = canLimits && !draft && characteristic.currentLimits !== null;
  const focusAfterClose = useFocusAfterClose();
  const endAction = (l: LimitVersionDto) =>
    l.endedAt === null ? (
      <Button
        variant="ghost"
        size="sm"
        data-testid={`limits-end-${String(l.version)}`}
        aria-label={`End limit version ${String(l.version)}`}
        onClick={() => {
          setDone(undefined);
          setDraft({
            kind: 'end',
            version: characteristic.version,
            limit: l.version,
            from: '',
            to: '',
            comment: '',
          });
        }}
      >
        End
      </Button>
    ) : null;
  return (
    <Section
      id="spc-limits-title"
      testId="spc-limits"
      title="Control limit versions"
      description={`Frozen and append-only: limits never move by themselves, so a drift can’t hide in its own limits. Values in ${characteristic.unit}; Cpk against the upper specification (${plainText(characteristic.upperSpec)} ${characteristic.unit}), shown, not reconciled.`}
      actions={
        canCreate ? (
          <Button
            data-testid="limits-create"
            onClick={() => {
              const window = suggestedWindow(chart);
              setDone(undefined);
              setDraft({
                kind: 'create',
                version: characteristic.version,
                from: window ? toPlantInput(window.from) : '',
                to: window ? toPlantInput(window.to) : '',
                comment: '',
              });
            }}
          >
            Estimate a new version
          </Button>
        ) : undefined
      }
    >
      <p className="mb-4 text-sm text-ink-secondary" data-testid="spc-rules">
        Rules on I: {rulesText(characteristic.rules.I)}; MR: {rulesText(characteristic.rules.MR)};
        X̄: {rulesText(characteristic.rules.Xbar)}; R: {rulesText(characteristic.rules.R)} (
        {[...new Set(Object.values(characteristic.rules).flat())]
          .sort((a, b) => a - b)
          .map((r) => `${String(r)}: ${RULE_SHORT[r] ?? ''}`)
          .join('; ')}
        ).
      </p>
      {done && !draft ? (
        <Callout tone="ok" role="status" data-testid="limits-done" className="mb-4">
          {done}
        </Callout>
      ) : null}
      {draft ? (
        <LimitsForm
          key={`${draft.kind}:${String(draft.limit)}`}
          characteristic={characteristic}
          chart={chart}
          initial={draft}
          onRead={onRead}
          onClose={(text) => {
            const opener =
              draft.kind === 'end' ? `limits-end-${String(draft.limit)}` : 'limits-create';
            setDraft(undefined);
            setDone(text);
            // Back to the button that opened it; once done, the heading above the outcome.
            focusAfterClose(text === undefined ? opener : undefined, 'spc-limits-title');
          }}
        />
      ) : null}
      <DataTable
        testId="limit-versions"
        caption="Control limit versions, newest first"
        columns={columns}
        rows={versions}
        rowKey={(l) => String(l.version)}
        rowTestId={(l) => `limit-version-${String(l.version)}`}
        rowProps={(l) => ({
          'data-open': String(l.endedAt === null),
          'data-created-by': l.createdBy,
        })}
        {...(canLimits && !draft ? { actions: endAction } : {})}
        empty={
          <EmptyState
            testId="limits-empty"
            title="No limit version yet"
            body="Version 1 is estimated from the baseline once its first-pass readings are final."
          />
        }
      />
    </Section>
  );
}

// ---- The chart page ----

const SECTIONS: readonly SectionNavItem[] = [
  { id: 'spc-charts-title', label: 'Charts' },
  { id: 'spc-signals-title', label: 'Signal episodes' },
  { id: 'spc-limits-title', label: 'Control limit versions' },
];

function ChartFacts({
  characteristic,
  view,
}: {
  readonly characteristic: CharacteristicDto;
  readonly view: SpcChartDto;
}) {
  const count = (n: number) => <span className="tabular-nums">{n}</span>;
  const facts: Fact[] = [
    { term: 'Equipment', detail: <Code>{characteristic.equipment}</Code> },
    { term: 'Operation', detail: <Code>{characteristic.operation}</Code> },
    { term: 'Unit', detail: characteristic.unit },
    { term: 'Subgroup size', detail: count(characteristic.subgroupSize) },
    { term: 'First-pass readings', detail: count(view.readings.firstPass) },
    { term: 'Retests (shown apart, never charted)', detail: count(view.readings.retests) },
    { term: 'Complete subgroups', detail: count(view.subgroups.complete) },
    { term: 'Readings waiting', detail: count(view.subgroups.pending) },
    {
      term: 'Tester final through',
      detail: view.finalThrough ? (
        timeOf(view.finalThrough.at)
      ) : (
        <Missing reason="No final reading yet" />
      ),
    },
  ];
  return (
    <div
      data-testid="spc-header"
      data-version={String(characteristic.version)}
      className="flex flex-col gap-2"
    >
      <DescriptionList facts={facts} columns="compact" label="Characteristic facts" />
    </div>
  );
}

function SpcChartScreen({ id, search }: { readonly id: string; readonly search: SpcChartSearch }) {
  const queryClient = useQueryClient();
  const canLimits = useCan('spc:limits');
  const window: ChartWindow = { all: search.all ?? false, from: search.from, to: search.to };
  const read = useQuery({
    queryKey: qualityKeys.chart(id, window),
    queryFn: ({ signal }) => getSpcChart(id, window, signal),
  });
  const live = useLiveQuality();
  const [limitsDraft, setLimitsDraft] = useState<LimitsDraft | undefined>(undefined);
  const onRead = async () => {
    await queryClient.refetchQueries({ queryKey: qualityKeys.chartAll(id) });
  };
  const view = read.data;
  const characteristic = view ? newestCharacteristic(view.characteristic, live) : undefined;
  const signals = useMemo(
    () => (view ? mergeSignals(id, view.signals, live) : []),
    [id, view, live],
  );

  if (read.error instanceof ApiError && read.error.status === 404) {
    return <CharacteristicNotFound id={id} />;
  }
  if (read.isPending) {
    // No `h1` until the chart is read: the heading takes the focus when it mounts.
    return (
      <div className="flex flex-col gap-6" data-testid="spc-chart-page" data-characteristic={id}>
        <p className="text-sm">
          <Link
            {...BACK.link}
            activeOptions={BACK_LINK_ACTIVE}
            className="text-link underline-offset-4 hover:underline"
          >
            ‹ {BACK.label}
          </Link>
        </p>
        <Skeleton shape="chart" label="Loading the charts…" />
      </div>
    );
  }
  if (read.isError || !view || !characteristic) {
    return (
      <section
        aria-labelledby="spc-chart-title"
        data-testid="spc-chart-page"
        data-characteristic={id}
      >
        <PageHeader
          id="spc-chart-title"
          back={BACK}
          title={
            <>
              Characteristic <Code className="break-all">{id}</Code>
            </>
          }
          documentTitle={`Characteristic ${id}`}
        />
        <QueryError what="the charts" error={read.error} onRetry={() => void read.refetch()} />
      </section>
    );
  }

  return (
    <section
      aria-labelledby="spc-chart-title"
      data-testid="spc-chart-page"
      data-characteristic={id}
      data-limits={
        characteristic.currentLimits === null ? 'none' : String(characteristic.currentLimits)
      }
    >
      <PageHeader
        id="spc-chart-title"
        back={BACK}
        title={characteristic.name}
        status={
          <>
            <UnacknowledgedBadge count={characteristic.signals.unacknowledged} />
            <NoticeBadge characteristic={characteristic} />
          </>
        }
        description="I-MR and X̄-R charts of first-pass readings against frozen limit versions."
        meta={<ChartFacts characteristic={characteristic} view={view} />}
        filters={
          <WindowPicker key={`${search.from ?? ''}|${search.to ?? ''}`} id={id} search={search} />
        }
        summary={<PointsFrom pointsFrom={view.pointsFrom} />}
      />
      <Notice
        characteristic={characteristic}
        onEstimate={
          canLimits && characteristic.currentLimits !== null && !limitsDraft
            ? () => {
                const suggested = suggestedWindow(view);
                setLimitsDraft({
                  kind: 'create',
                  version: characteristic.version,
                  from: suggested ? toPlantInput(suggested.from) : '',
                  to: suggested ? toPlantInput(suggested.to) : '',
                  comment: '',
                });
                // The form takes focus when it opens, so the browser brings it into view.
              }
            : undefined
        }
      />
      <SectionNav items={SECTIONS} testId="spc-section-nav" />
      <div className="mt-6">
        <Section id="spc-charts-title" testId="spc-charts-section" title="Charts">
          <Baseline characteristic={characteristic} />
          <div className="mt-3 grid gap-4 xl:grid-cols-2" data-testid="spc-charts">
            {SPC_CHART_NAMES.map((chart) => (
              <ChartFigure key={chart} chart={chart} view={view} signals={signals} />
            ))}
          </div>
          {view.retests.length > 0 ? (
            <p
              className="mt-3 text-sm text-ink-secondary"
              data-testid="spc-retests"
              data-count={String(view.retests.length)}
            >
              {view.retests.length} retests after rework are marked as triangles on the I chart and
              never charted as points (another population).
            </p>
          ) : null}
        </Section>
        <Signals signals={signals} onRead={onRead} />
        <Limits
          characteristic={characteristic}
          chart={view}
          draft={limitsDraft}
          setDraft={setLimitsDraft}
          onRead={onRead}
        />
      </div>
    </section>
  );
}

/** An unknown characteristic, or an id that cannot be one: the not-found page (G-21). */
function CharacteristicNotFound({ id }: { readonly id: string }) {
  return (
    <NotFound
      kind="characteristic"
      id={id}
      back={{ to: '/quality/spc', label: BACK.label }}
      testId="spc-missing"
    />
  );
}

/** The route's screen: keyed by the characteristic, holding the `quality` topic. */
export function SpcChartRoute() {
  const { characteristic } = useParams({ from: '/quality/spc/$characteristic' });
  const search = useSearch({ from: '/quality/spc/$characteristic' });
  useQualityTopic();
  if (!CHARACTERISTIC_ID.test(characteristic)) {
    return <CharacteristicNotFound id={characteristic} />;
  }
  return <SpcChartScreen key={characteristic} id={characteristic} search={search} />;
}
