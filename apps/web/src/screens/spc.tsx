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
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import {
  CommentInput,
  FailureMessage,
  Section,
  SignalStatusBadge,
  Table,
  buttonClass,
  cell,
  inputClass,
  primaryClass,
  timeOf,
} from '../components/quality-ui.tsx';
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
import { useLiveQuality, useQualityTopic } from '../live/live-context.tsx';
import { upsertCharacteristic, upsertSignal } from '../live/live-quality.ts';
import type { SpcChartSearch } from '../routes/quality.ts';

// `/quality/spc` and `/quality/spc/$characteristic` (#203, plan "Web", ADR-0032): the
// characteristics, and one characteristic's I-MR and X̄-R charts with limits, zones, provisional
// and final points, retests apart, signal episodes (provisional, final, extent final, withdrawn),
// acknowledgement (`spc:ack`), limit versions with re-estimation and ending (`spc:limits`) and the
// `baseline-changed` notice; live through the `quality` topic (read first, then pushes by id).

const CHARACTERISTIC_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Episodes listed at most at once (newest first); the rest are counted. */
export const SIGNALS_SHOWN = 100;

function Baseline({ characteristic }: { readonly characteristic: CharacteristicDto }) {
  const { baseline, currentLimits } = characteristic;
  return (
    <p
      className="text-sm"
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
    <div
      role="alert"
      data-testid="spc-notice"
      data-kind={notice.kind}
      className="mt-3 rounded border border-amber-800 bg-amber-50 p-3 text-sm text-amber-950"
    >
      <p className="font-semibold">Baseline changed</p>
      <p>
        {notice.detail} Version 1 is not re-derived: a quality user decides whether to estimate a
        new version (noticed {timeOf(notice.at)}).
      </p>
      {onEstimate ? (
        <button
          type="button"
          data-testid="notice-estimate"
          className={`${buttonClass} mt-2`}
          onClick={onEstimate}
        >
          Estimate a new version
        </button>
      ) : null}
    </div>
  );
}

/** `/quality/spc`: the characteristics with their limits, baseline, notice and open episodes. */
export function SpcList() {
  useQualityTopic();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const read = useQuery({
    queryKey: qualityKeys.characteristics,
    queryFn: ({ signal }) => getCharacteristics(signal),
  });
  const live = useLiveQuality();
  const items = (read.data?.characteristics ?? []).map((c) => newestCharacteristic(c, live));
  return (
    <section aria-labelledby="spc-title" data-testid="spc-list">
      <h1 ref={heading} id="spc-title" tabIndex={-1} className="text-2xl font-bold">
        SPC charts
      </h1>
      <p className="mt-1 text-sm text-slate-700">
        Statistical process control on first-pass readings: I-MR and X̄-R charts against frozen limit
        versions. A signal is an episode a person acknowledges; no hold opens by itself.
      </p>
      {read.isPending ? <p className="mt-4">Loading the characteristics…</p> : null}
      {read.isError ? (
        <div className="mt-4">
          <QueryError
            what="the characteristics"
            error={read.error}
            onRetry={() => void read.refetch()}
          />
        </div>
      ) : null}
      {read.data && items.length === 0 ? (
        <p className="mt-4" data-testid="spc-empty">
          No characteristic is configured.
        </p>
      ) : null}
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {items.map((c) => (
          <li
            key={c.id}
            data-testid={`spc-characteristic-${c.id}`}
            data-version={String(c.version)}
            data-limits={c.currentLimits === null ? 'none' : String(c.currentLimits)}
            data-open={String(c.signals.open)}
            data-unacknowledged={String(c.signals.unacknowledged)}
            data-notice={c.notice ? c.notice.kind : ''}
            className="rounded-lg border border-slate-300 bg-white p-4"
          >
            <h2 className="text-lg font-semibold">
              <Link
                to="/quality/spc/$characteristic"
                params={{ characteristic: c.id }}
                search={{}}
                data-testid={`spc-link-${c.id}`}
                className="text-sky-800 underline"
              >
                {c.name}
              </Link>
            </h2>
            <p className="text-sm text-slate-700">
              {c.equipment} · {c.operation} · {c.unit} · upper specification {c.upperSpec}
            </p>
            <p className="mt-2 text-sm">
              {c.signals.open} open episode{c.signals.open === 1 ? '' : 's'},{' '}
              {c.signals.unacknowledged} not acknowledged
            </p>
            <Baseline characteristic={c} />
            {c.notice ? (
              <p className="mt-1 text-sm font-semibold text-amber-900">
                Baseline changed: a decision on a new limit version is pending.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- One characteristic ----

type WindowMode = 'recent' | 'all' | 'range';

function WindowPicker({
  id,
  search,
  pointsFrom,
}: {
  readonly id: string;
  readonly search: SpcChartSearch;
  readonly pointsFrom: string | null;
}) {
  const navigate = useNavigate();
  const mode: WindowMode =
    search.from !== undefined || search.to !== undefined ? 'range' : search.all ? 'all' : 'recent';
  const [from, setFrom] = useState(search.from ? toPlantInput(search.from) : '');
  const [to, setTo] = useState(search.to ? toPlantInput(search.to) : '');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const modeId = useId();
  const go = (next: SpcChartSearch) => {
    void navigate({
      to: '/quality/spc/$characteristic',
      params: { characteristic: id },
      search: next,
    });
  };
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 text-sm" data-testid="chart-window">
      <div className="flex flex-col gap-1">
        <label htmlFor={modeId} className="font-medium">
          Points shown
        </label>
        <select
          id={modeId}
          data-testid="chart-window-mode"
          value={mode}
          className={inputClass}
          onChange={(event) => {
            const value = event.target.value as WindowMode;
            setProblem(undefined);
            if (value === 'recent') go({});
            else if (value === 'all') go({ all: true });
          }}
        >
          <option value="recent">The last 500 first-pass readings</option>
          <option value="all">Every reading</option>
          <option value="range">A plant-time range</option>
        </select>
      </div>
      <label className="flex flex-col gap-1 font-medium">
        From (plant time)
        <input
          type="datetime-local"
          step={1}
          data-testid="chart-window-from"
          value={from}
          className={inputClass}
          onChange={(event) => {
            setFrom(event.target.value);
          }}
        />
      </label>
      <label className="flex flex-col gap-1 font-medium">
        To (plant time)
        <input
          type="datetime-local"
          step={1}
          data-testid="chart-window-to"
          value={to}
          className={inputClass}
          onChange={(event) => {
            setTo(event.target.value);
          }}
        />
      </label>
      <button
        type="button"
        data-testid="chart-window-apply"
        className={buttonClass}
        onClick={() => {
          const a = from === '' ? undefined : fromPlantInput(from);
          const b = to === '' ? undefined : fromPlantInput(to);
          if ((from !== '' && a === undefined) || (to !== '' && b === undefined)) {
            setProblem('Give each time as a date and a time.');
            return;
          }
          if (a === undefined && b === undefined) {
            setProblem('Give at least one end of the range.');
            return;
          }
          setProblem(undefined);
          go({ from: a, to: b });
        }}
      >
        Show the range
      </button>
      {problem ? (
        <p role="alert" className="text-red-900" data-testid="chart-window-problem">
          {problem}
        </p>
      ) : null}
      <p className="w-full text-slate-700" data-testid="chart-points-from">
        {pointsFrom === null ? (
          'Every point up to the end of the range is shown.'
        ) : (
          <>
            Points before {timeOf(pointsFrom)} are left out; limits, counts and episodes stay whole.
          </>
        )}
      </p>
    </div>
  );
}

function pointRows(points: readonly SpcPointDto[]) {
  return points.map((p) => (
    <tr
      key={`${String(p.epoch)}-${String(p.seq)}-${String(p.partId)}`}
      data-final={String(p.final)}
      data-rules={p.rules.join(',')}
    >
      <td className={cell}>{timeOf(p.at)}</td>
      <td className={cell}>{p.partId}</td>
      <td className={`${cell} font-mono`}>{p.value.value}</td>
      <td className={cell}>{p.version === null ? 'not judged' : `v${String(p.version)}`}</td>
      <td className={cell}>{p.rules.length === 0 ? '–' : p.rules.join(', ')}</td>
      <td className={cell}>
        {p.final ? 'Final' : 'Provisional'}
        {p.baseline ? ', baseline' : ''}
      </td>
    </tr>
  ));
}

const POINT_COLUMNS = ['Plant time', 'Part', 'Value', 'Limits', 'Rules firing', 'Status'];

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
  const points = view.points[chart];
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
            unit: chart === 'I' || chart === 'Xbar' ? view.characteristic.unit : 'range',
          }),
    [chart, points, view.limits, view.retests, view.characteristic.unit, signals],
  );
  const firing = points.filter((p) => p.rules.length > 0);
  const provisional = points.filter((p) => !p.final).length;
  return (
    <EChart
      testId={`spc-chart-${chart}`}
      title={CHART_TEXT[chart].label}
      description={`${CHART_TEXT[chart].label}: ${String(points.length)} points, ${String(firing.length)} firing a rule, ${String(provisional)} provisional; the values are in the tables below.`}
      option={option}
      height={240}
    >
      <p className="mt-2 text-sm" data-testid={`spc-summary-${chart}`}>
        {points.length} points ({provisional} provisional), {firing.length} firing a rule.
      </p>
      {points.length === 0 ? (
        <p className="text-sm text-slate-700" data-testid={`spc-no-points-${chart}`}>
          No point yet.
        </p>
      ) : null}
      {firing.length > 0 ? (
        <div className="mt-2">
          <Table
            testId={`spc-signal-points-${chart}`}
            caption={`${CHART_TEXT[chart].label}: points firing a rule`}
            columns={POINT_COLUMNS}
            count={firing.length}
          >
            {pointRows(firing.slice(-50))}
          </Table>
        </div>
      ) : null}
      {points.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            className={buttonClass}
            data-testid={`spc-values-toggle-${chart}`}
            aria-expanded={showAll}
            onClick={() => {
              setShowAll((v) => !v);
            }}
          >
            {showAll ? 'Hide the values' : `Show all ${String(points.length)} values`}
          </button>
          {showAll ? (
            <div className="mt-2 max-h-96 overflow-y-auto">
              <Table
                testId={`spc-values-${chart}`}
                caption={`${CHART_TEXT[chart].label}: every point shown`}
                columns={POINT_COLUMNS}
                count={points.length}
              >
                {pointRows(points)}
              </Table>
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
      className="mt-2 flex flex-col gap-2 rounded border border-slate-400 bg-slate-50 p-3"
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
      <p className="text-sm">
        Acknowledges the episode once, with your comment (audited). No hold follows by itself.
      </p>
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
      {stale ? (
        <div
          role="alert"
          data-testid="ack-stale"
          data-version={String(signal.rowVersion)}
          className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          <p>
            The episode changed while you wrote this (now version {signal.rowVersion},{' '}
            {signal.status}
            {signal.acknowledged ? `, acknowledged by ${signal.acknowledged.by}` : ''}). Nothing is
            sent with the newer version.
            {applies ? ' Check it, then start again: your comment is kept.' : ''}
          </p>
          {applies ? (
            <button
              type="button"
              data-testid="ack-restart"
              className={`${buttonClass} mt-2`}
              onClick={() => {
                setDraft((d) => ({ ...d, version: signal.rowVersion }));
                setFailure(undefined);
              }}
            >
              Start again on version {signal.rowVersion}
            </button>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-red-900" data-testid="ack-invalid">
          {problem}
        </p>
      ) : null}
      {failure ? <FailureMessage failure={failure} testId="ack-message" /> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid="ack-submit"
          disabled={write.isPending || stale || !applies}
          className={primaryClass}
        >
          {write.isPending ? 'Sending…' : 'Acknowledge'}
        </button>
        <button
          type="button"
          data-testid="ack-cancel"
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

function SignalRow({
  signal,
  ackOpen,
  canAck,
  canHold,
  onAck,
}: {
  readonly signal: SpcSignalDto;
  readonly ackOpen: boolean;
  readonly canAck: boolean;
  readonly canHold: boolean;
  readonly onAck: () => void;
}) {
  return (
    <tr
      data-testid={`signal-row-${String(signal.id)}`}
      data-status={signal.status}
      data-chart={signal.chart}
      data-rule={String(signal.rule)}
      data-open={String(isOpenEpisode(signal))}
      data-extent-final={String(signal.extentFinal)}
      data-baseline={String(signal.baseline)}
      data-acknowledged={String(signal.acknowledged !== null)}
      data-orphaned={String(signal.orphaned)}
      data-row-version={String(signal.rowVersion)}
    >
      <td className={cell}>{signal.id}</td>
      <td className={cell}>
        {CHART_TEXT[signal.chart].short}, rule {signal.rule}
        <span className="block text-xs text-slate-700">{signal.ruleText}</span>
      </td>
      <td className={cell}>
        <SignalStatusBadge signal={signal} />
        <span className="block text-xs" data-testid="signal-finality">
          {finalityText(signal)}
        </span>
        {signal.baseline ? (
          <span className="block text-xs font-semibold" data-testid="signal-baseline">
            Baseline episode (judged when version {signal.version} was created)
          </span>
        ) : null}
        {signal.withdrawnReason ? (
          <span className="block text-xs" data-testid="signal-withdrawn-reason">
            Withdrawn: {signal.withdrawnReason}
          </span>
        ) : null}
      </td>
      <td className={cell}>
        {timeOf(signal.first.at)} (part {signal.first.partId})
        <span className="block text-xs text-slate-700">
          {isOpenEpisode(signal) ? 'open, last ' : 'closed, last '}
          {timeOf(signal.last.at)} · {signal.points} point{signal.points === 1 ? '' : 's'} · v
          {signal.version}
        </span>
      </td>
      <td className={cell}>
        {signal.acknowledged ? (
          <span data-testid="signal-ack">
            {signal.acknowledged.by}, {timeOf(signal.acknowledged.at)}: “
            {signal.acknowledged.comment}”
            {signal.orphaned ? ' (orphaned: the episode was withdrawn)' : ''}
          </span>
        ) : (
          '–'
        )}
      </td>
      <td className={cell}>
        <div className="flex flex-wrap gap-2">
          {canAck && canAcknowledgeSignal(signal) && !ackOpen ? (
            <button
              type="button"
              data-testid={`ack-${String(signal.id)}`}
              className={buttonClass}
              aria-label={`Acknowledge episode ${String(signal.id)}`}
              onClick={onAck}
            >
              Acknowledge
            </button>
          ) : null}
          {canHold && canSuggestHold(signal) ? (
            <Link
              to="/quality/holds/new"
              search={{ signal: signal.id }}
              data-testid={`hold-from-${String(signal.id)}`}
              className="text-sm text-sky-800 underline"
            >
              Hold from this episode
            </Link>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

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
  const filterId = useId();
  const shown = filtered(signals, filter);
  const opened = open === undefined ? undefined : signals.find((s) => s.id === open);
  return (
    <Section id="spc-signals" title="Signal episodes">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label htmlFor={filterId} className="flex flex-col gap-1 font-medium">
          Show
          <select
            id={filterId}
            data-testid="signal-filter"
            value={filter}
            className={inputClass}
            onChange={(event) => {
              setFilter(event.target.value as SignalFilter);
            }}
          >
            {SIGNAL_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-slate-700">
          Provisional until the tester is final through the triggering point; final episodes keep
          their identity, their extent is final with “extent final”.
        </p>
      </div>
      {done ? (
        <p role="status" data-testid="ack-done" className="mt-2 text-sm text-emerald-900">
          {done}
        </p>
      ) : null}
      {opened ? (
        <AckForm
          key={opened.id}
          signal={opened}
          onRead={onRead}
          onClose={(text) => {
            setOpen(undefined);
            setDone(text);
          }}
        />
      ) : null}
      {shown.length === 0 ? (
        <p className="mt-2 text-sm" data-testid="signals-empty">
          No episode in this view.
        </p>
      ) : (
        <div className="mt-2">
          <Table
            testId="signal-list"
            caption="Signal episodes, newest first"
            columns={['Id', 'Chart and rule', 'Status', 'First point', 'Acknowledged', 'Actions']}
            count={shown.length}
          >
            {shown.slice(0, SIGNALS_SHOWN).map((s) => (
              <SignalRow
                key={s.id}
                signal={s}
                canAck={canAck}
                canHold={canHold}
                ackOpen={open === s.id}
                onAck={() => {
                  setDone(undefined);
                  setOpen(s.id);
                }}
              />
            ))}
          </Table>
          {shown.length > SIGNALS_SHOWN ? (
            <p className="mt-1 text-sm" data-testid="signals-more">
              {shown.length - SIGNALS_SHOWN} older episodes are not listed.
            </p>
          ) : null}
        </div>
      )}
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
  readonly from: string;
  readonly to: string;
  readonly comment: string;
}

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
    from !== undefined && to !== undefined ? pointsInWindow(chart.points.I, from, to) : undefined;
  return (
    <form
      ref={form}
      tabIndex={-1}
      noValidate
      aria-label={draft.kind === 'create' ? 'Estimate a new limit version' : 'End a limit version'}
      data-testid={draft.kind === 'create' ? 'limits-form' : 'limits-end-form'}
      data-version={String(draft.version)}
      className="mt-2 flex flex-col gap-2 rounded border border-slate-400 bg-slate-50 p-3"
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
      <h3 className="font-semibold">
        {draft.kind === 'create'
          ? 'Estimate a new limit version'
          : `End limit version ${String(draft.limit)}`}
      </h3>
      <p className="text-sm">
        {draft.kind === 'create'
          ? 'From the final first-pass readings whose plant time lies in the window (both ends included): I-MR from every reading, X̄-R from the complete subgroups inside. It applies after every reading received so far; earlier points keep their version. Clears a baseline-changed notice. Audited.'
          : 'Points after every reading received so far are judged by the highest other version open there, or not at all. Audited.'}
      </p>
      <p className="text-xs text-slate-700">
        Prepared on version {draft.version} of the characteristic; the MES refuses it if the
        characteristic has changed since (409).
      </p>
      {draft.kind === 'create' ? (
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Window from (plant time)
            <input
              type="datetime-local"
              step={1}
              data-testid="limits-from"
              value={draft.from}
              className={inputClass}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((d) => ({ ...d, from: value }));
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Window to (plant time)
            <input
              type="datetime-local"
              step={1}
              data-testid="limits-to"
              value={draft.to}
              className={inputClass}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((d) => ({ ...d, to: value }));
              }}
            />
          </label>
          {inWindow !== undefined ? (
            <p className="self-end text-sm" data-testid="limits-window-points">
              {inWindow} first-pass points shown lie in it.
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
      {stale ? (
        <div
          role="alert"
          data-testid="limits-stale"
          data-version={String(characteristic.version)}
          className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          <p>
            The characteristic changed while you prepared this (now version {characteristic.version}
            : limits or a notice moved). Nothing is sent with the newer version. Check the limits
            above, then start again: what you entered is kept.
          </p>
          <button
            type="button"
            data-testid="limits-restart"
            className={`${buttonClass} mt-2`}
            onClick={() => {
              setDraft((d) => ({ ...d, version: characteristic.version }));
              setFailure(undefined);
            }}
          >
            Start again on version {characteristic.version}
          </button>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <p role="alert" className="text-sm text-red-900" data-testid="limits-invalid">
          {problems.join(' ')}
        </p>
      ) : null}
      {failure ? <FailureMessage failure={failure} testId="limits-message" /> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid="limits-submit"
          disabled={write.isPending || stale}
          className={primaryClass}
        >
          {write.isPending ? 'Sending…' : draft.kind === 'create' ? 'Create the version' : 'End it'}
        </button>
        <button
          type="button"
          data-testid="limits-cancel"
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

const value3 = (v: { value: number }): string => String(Math.round(v.value * 1000) / 1000);

function LimitRow({
  limit,
  canLimits,
  onEnd,
}: {
  readonly limit: LimitVersionDto;
  readonly canLimits: boolean;
  readonly onEnd: () => void;
}) {
  const open = limit.endedAt === null;
  return (
    <tr
      data-testid={`limit-version-${String(limit.version)}`}
      data-open={String(open)}
      data-created-by={limit.createdBy}
    >
      <td className={cell}>v{limit.version}</td>
      <td className={cell}>
        {limit.createdBy}, {timeOf(limit.createdAt)}
        {limit.comment ? <span className="block text-xs">“{limit.comment}”</span> : null}
      </td>
      <td className={cell}>
        {timeOf(limit.window.from.at)} – {timeOf(limit.window.to.at)}
        <span className="block text-xs text-slate-700">
          {limit.counts.readings} readings, {limit.counts.subgroups} subgroups
        </span>
      </td>
      <td className={cell}>
        {limit.from === null ? 'from the first reading' : <>from {timeOf(limit.from.at)}</>}
        {limit.until ? <> until {timeOf(limit.until.at)}</> : null}
        {limit.endedAt ? (
          <span className="block text-xs" data-testid="limit-ended">
            ended by {limit.endedBy ?? '–'}, {timeOf(limit.endedAt)}
          </span>
        ) : null}
      </td>
      <td className={`${cell} font-mono`}>
        {value3(limit.charts.I.lower)} / {value3(limit.charts.I.centre)} /{' '}
        {value3(limit.charts.I.upper)}
      </td>
      <td className={`${cell} font-mono`}>
        {value3(limit.charts.Xbar.lower)} / {value3(limit.charts.Xbar.centre)} /{' '}
        {value3(limit.charts.Xbar.upper)}
      </td>
      <td className={`${cell} font-mono`}>
        {value3(limit.charts.MR.upper)} / {value3(limit.charts.R.upper)}
      </td>
      <td className={cell} data-testid="limit-cpk">
        {limit.capability === null
          ? 'n/a'
          : (Math.round(limit.capability.cpk * 100) / 100).toFixed(2)}
      </td>
      <td className={cell}>
        {canLimits && open ? (
          <button
            type="button"
            data-testid={`limits-end-${String(limit.version)}`}
            className={buttonClass}
            onClick={onEnd}
          >
            End
          </button>
        ) : null}
      </td>
    </tr>
  );
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
  return (
    <Section id="spc-limits" title="Control limit versions">
      <p className="text-sm text-slate-700">
        Frozen and append-only: limits never move by themselves, so a drift can’t hide in its own
        limits. Values as lower / centre / upper; MR and R as upper limits; Cpk against the upper
        specification ({characteristic.upperSpec} {characteristic.unit}), shown, not reconciled.
      </p>
      <p className="mt-1 text-sm">
        Rules on I: {rulesText(characteristic.rules.I)}; MR: {rulesText(characteristic.rules.MR)};
        X̄: {rulesText(characteristic.rules.Xbar)}; R: {rulesText(characteristic.rules.R)} (
        {[...new Set(Object.values(characteristic.rules).flat())]
          .sort((a, b) => a - b)
          .map((r) => `${String(r)}: ${RULE_SHORT[r] ?? ''}`)
          .join('; ')}
        ).
      </p>
      {done && !draft ? (
        <p role="status" data-testid="limits-done" className="mt-2 text-sm text-emerald-900">
          {done}
        </p>
      ) : null}
      {canLimits && !draft && characteristic.currentLimits !== null ? (
        <button
          type="button"
          data-testid="limits-create"
          className={`${buttonClass} mt-2`}
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
        </button>
      ) : null}
      {draft ? (
        <LimitsForm
          key={`${draft.kind}:${String(draft.limit)}`}
          characteristic={characteristic}
          chart={chart}
          initial={draft}
          onRead={onRead}
          onClose={(text) => {
            setDraft(undefined);
            setDone(text);
          }}
        />
      ) : null}
      {versions.length === 0 ? (
        <p className="mt-2 text-sm" data-testid="limits-empty">
          No limit version yet.
        </p>
      ) : (
        <div className="mt-2">
          <Table
            testId="limit-versions"
            caption="Control limit versions, newest first"
            columns={[
              'Version',
              'Created',
              'Window',
              'Applies',
              'I limits',
              'X̄ limits',
              'MR / R upper',
              'Cpk',
              'Actions',
            ]}
            count={versions.length}
          >
            {versions.map((limit) => (
              <LimitRow
                key={limit.version}
                limit={limit}
                canLimits={canLimits && !draft}
                onEnd={() => {
                  setDone(undefined);
                  setDraft({
                    kind: 'end',
                    version: characteristic.version,
                    limit: limit.version,
                    from: '',
                    to: '',
                    comment: '',
                  });
                }}
              />
            ))}
          </Table>
        </div>
      )}
    </Section>
  );
}

function SpcChartScreen({ id, search }: { readonly id: string; readonly search: SpcChartSearch }) {
  const heading = useHeadingFocus<HTMLHeadingElement>();
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
  const missing = read.error instanceof ApiError && read.error.status === 404;
  const view = read.data;
  const characteristic = view ? newestCharacteristic(view.characteristic, live) : undefined;
  const signals = useMemo(
    () => (view ? mergeSignals(id, view.signals, live) : []),
    [id, view, live],
  );
  return (
    <section
      aria-labelledby="spc-chart-title"
      data-testid="spc-chart-page"
      data-characteristic={id}
    >
      <p className="text-sm">
        <Link to="/quality/spc" className="text-sky-800 underline">
          All characteristics
        </Link>
      </p>
      <h1 ref={heading} id="spc-chart-title" tabIndex={-1} className="mt-1 text-2xl font-bold">
        {characteristic ? characteristic.name : `Characteristic ${id}`}
      </h1>
      {read.isPending ? <p className="mt-4">Loading the charts…</p> : null}
      {missing ? (
        <p className="mt-4" data-testid="spc-missing">
          The MES has no characteristic {id}.
        </p>
      ) : read.isError ? (
        <div className="mt-4">
          <QueryError what="the charts" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {view && characteristic ? (
        <>
          <p
            className="text-sm text-slate-700"
            data-testid="spc-header"
            data-version={String(characteristic.version)}
          >
            {characteristic.equipment} · {characteristic.operation} · {characteristic.unit} ·
            subgroups of {characteristic.subgroupSize} · {view.readings.firstPass} first-pass
            readings, {view.readings.retests} retests (shown apart, never charted) ·{' '}
            {view.subgroups.complete} complete subgroups, {view.subgroups.pending} readings waiting
            {view.finalThrough ? <> · tester final through {timeOf(view.finalThrough.at)}</> : null}
          </p>
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
          <Baseline characteristic={characteristic} />
          <WindowPicker id={id} search={search} pointsFrom={view.pointsFrom} />
          <div className="mt-4 grid gap-4 xl:grid-cols-2" data-testid="spc-charts">
            {SPC_CHART_NAMES.map((chart) => (
              <ChartFigure key={chart} chart={chart} view={view} signals={signals} />
            ))}
          </div>
          {view.retests.length > 0 ? (
            <p
              className="mt-2 text-sm"
              data-testid="spc-retests"
              data-count={String(view.retests.length)}
            >
              {view.retests.length} retests after rework are marked as triangles on the I chart and
              never charted as points (another population).
            </p>
          ) : null}
          <Signals signals={signals} onRead={onRead} />
          <Limits
            characteristic={characteristic}
            chart={view}
            draft={limitsDraft}
            setDraft={setLimitsDraft}
            onRead={onRead}
          />
        </>
      ) : null}
    </section>
  );
}

/** The route's screen: keyed by the characteristic, holding the `quality` topic. */
export function SpcChartRoute() {
  const { characteristic } = useParams({ from: '/quality/spc/$characteristic' });
  const search = useSearch({ from: '/quality/spc/$characteristic' });
  useQualityTopic();
  if (!CHARACTERISTIC_ID.test(characteristic)) {
    return (
      <section>
        <h1 className="text-2xl font-bold">Characteristic {characteristic}</h1>
        <p className="mt-2" data-testid="spc-missing">
          No characteristic has this id.
        </p>
      </section>
    );
  }
  return <SpcChartScreen key={characteristic} id={characteristic} search={search} />;
}
