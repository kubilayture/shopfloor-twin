import type { Clock, CurrentStateDto, EquipmentDto, Metrics } from '@shopfloor/contracts/mes-api';
import { MES_API_LIMITS } from '@shopfloor/contracts/mes-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ApiError, getEquipment, getIntervals, getMetrics, getSeries } from '../api/client.ts';
import { plantClock, queryKeys, usePlantClock } from '../api/queries.ts';
import { TrendChart } from '../chart/trend-chart.tsx';
import { CauseText } from '../components/cause-text.tsx';
import { QueryError } from '../components/query-error.tsx';
import { StateBadge } from '../components/state-badge.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Duration, PlantTime } from '../components/ui/format.tsx';
import { NotFound } from '../components/ui/not-found.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { SegmentedLinks } from '../components/ui/segmented-links.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { plainText } from '../domain/numbers.ts';
import { causeWords, metricName } from '../domain/plant.ts';
import { chartData } from '../domain/series.ts';
import {
  isConnectionLost,
  newest,
  STATE_ORDER,
  stateStyle,
  staleness,
  timeInState,
} from '../domain/states.ts';
import {
  durationText,
  formatPlantTime,
  plantRangeText,
  RANGES,
  type RangeKey,
} from '../domain/time.ts';
import {
  stateTotals,
  timelineBands,
  NARROW_TICKS,
  timelineTicks,
  withLiveState,
  type Band,
  type StateTotal,
  type Tick,
} from '../domain/timeline.ts';
import type { LiveTelemetry } from '../live/live-cache.ts';
import {
  useLiveConnection,
  useLiveStates,
  useLiveSubscription,
  useLiveTelemetry,
} from '../live/live-context.tsx';

/**
 * A machine's detail (UX-2, #322; design system 3.3, 3.4, 5): the page header with the machine's
 * name, its state badge (and the Stale tag), where it stands and its key facts, and the range
 * switch (`SegmentedLinks`, M-04) in the filter row; then the state timeline with an axis (M-01),
 * the time per state and every interval, and the telemetry: the metrics by name with their latest
 * value and its age (M-02), and a trend per metric. Tables are `DataTable`s, charts are cards
 * (M-03); an empty chart is an empty state that says when the last sample was (M-05); an unknown
 * machine is a `NotFound` (M-06).
 */

/** Buckets per metric: about one per two pixels of a wide chart. */
const CHART_POINTS = 600;
const INTERVALS_REFRESH_MS = 15_000;
const SERIES_REFRESH_MS = 30_000;
/**
 * A latest value older than this (plant time) says how long it has been unchanged (M-02).
 * Telemetry is sent on change, so a steady signal goes quiet on a machine that runs normally as
 * well as on one that stands: the age is a neutral qualifier, never a warning. Whether the shown
 * values are out of date is the Stale tag's job (the live connection) and the empty trend's.
 */
export const SAMPLE_AGE_SHOWN_MS = 15 * 60_000;

interface Window {
  readonly from: number;
  readonly to: number;
}

const BACK = { label: 'Plant overview', link: { to: '/' } } as const;

function RangeSwitch({ id, range }: { readonly id: string; readonly range: RangeKey }) {
  return (
    <SegmentedLinks
      label="Time range"
      current={range}
      items={(Object.keys(RANGES) as RangeKey[]).map((key) => ({
        key,
        label: RANGES[key].label,
        to: '/equipment/$id',
        params: { id },
        search: { range: key },
      }))}
    />
  );
}

/**
 * Time without a stored state: hatched in `surface` and `line-strong`, so no state's fill can be
 * mistaken for it. Written out in full for Tailwind's scanner; a class, not an inline style.
 */
const NO_DATA_HATCH =
  'bg-[repeating-linear-gradient(135deg,var(--color-surface)_0_5px,var(--color-line-strong)_5px_7px)]';

/** The tick's label sits centred under it, or inside the bar's ends near an edge. */
function tickAlign(tick: Tick): string {
  if (tick.left < 6) return 'items-start';
  if (tick.left > 94) return '-translate-x-full items-end';
  return '-translate-x-1/2 items-center';
}

/**
 * The timeline's axis: ticks at round plant times, dated where the plant day changes. Two of them,
 * one shown per width: `MAX_TICKS` from `sm`, `NARROW_TICKS` below it, so labels and dates never
 * run into each other on a phone.
 */
function Axis({
  ticks,
  testId,
  className,
}: {
  readonly ticks: readonly Tick[];
  readonly testId: string;
  readonly className: string;
}) {
  const dated = ticks.some((tick) => tick.date !== undefined);
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className={`relative w-full text-2xs text-ink-secondary ${dated ? 'h-10' : 'h-6'} ${className}`}
    >
      {ticks.map((tick) => (
        <div
          key={tick.at}
          data-tick={new Date(tick.at).toISOString()}
          className={`absolute top-0 flex flex-col ${tickAlign(tick)}`}
          style={{ left: `${String(tick.left)}%` }}
        >
          <span className="h-1.5 w-px bg-line-strong" />
          <span className="whitespace-nowrap tabular-nums">{tick.time}</span>
          {tick.date === undefined ? null : (
            <span className="whitespace-nowrap font-semibold text-ink">{tick.date}</span>
          )}
        </div>
      ))}
    </div>
  );
}

const byStateOrder = (a: string, b: string) => {
  const rank = (state: string) => {
    const index = STATE_ORDER.indexOf(state);
    return index === -1 ? STATE_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
};

function Timeline({ bands, window }: { readonly bands: readonly Band[]; readonly window: Window }) {
  const states = [...new Set(bands.map((band) => band.state))].sort(byStateOrder);
  return (
    <div>
      <div
        role="img"
        aria-label={`State timeline from ${formatPlantTime(window.from)} to ${formatPlantTime(window.to)}; the tables below list the time per state and every interval`}
        data-testid="state-timeline"
        className={`relative h-10 w-full overflow-hidden rounded-sm border border-line-strong ${NO_DATA_HATCH}`}
      >
        {bands.map((band) => (
          <div
            key={`${String(band.epoch)}-${String(band.start)}-${band.state}`}
            data-state={band.state}
            title={`${stateStyle(band.state).label}${band.cause ? ` (${causeWords(band.cause)})` : ''}: ${formatPlantTime(band.start)} – ${formatPlantTime(band.end)}`}
            className={`absolute inset-y-0 ${stateStyle(band.state).band}`}
            style={{ left: `${String(band.left)}%`, width: `${String(band.width)}%` }}
          />
        ))}
      </div>
      <Axis ticks={timelineTicks(window)} testId="timeline-axis" className="max-sm:hidden" />
      <Axis
        ticks={timelineTicks(window, { maxTicks: NARROW_TICKS })}
        testId="timeline-axis-narrow"
        className="sm:hidden"
      />
      <ul aria-label="Legend" className="mt-2 flex flex-wrap items-center gap-2">
        {states.map((state) => (
          <li key={state}>
            <StateBadge state={state} />
          </li>
        ))}
        <li className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span
            aria-hidden="true"
            className={`inline-block h-4 w-6 rounded-sm border border-line-strong ${NO_DATA_HATCH}`}
          />
          No data
        </li>
      </ul>
    </div>
  );
}

const TOTAL_COLUMNS: readonly Column<StateTotal>[] = [
  {
    key: 'state',
    header: 'State',
    rowHeader: true,
    cell: (total) => <StateBadge state={total.state} />,
  },
  { key: 'time', header: 'Time', numeric: true, cell: (total) => durationText(total.ms) },
  {
    key: 'share',
    header: 'Share',
    numeric: true,
    cell: (total) => `${(total.share * 100).toFixed(1)} %`,
  },
];

function intervalColumns(clock: number): readonly Column<Band>[] {
  return [
    {
      key: 'start',
      header: 'Start',
      nowrap: true,
      cell: (band) => <PlantTime at={band.start} clock={clock} />,
    },
    {
      key: 'end',
      header: 'End',
      nowrap: true,
      cell: (band) => (
        <>
          <PlantTime at={band.end} clock={clock} />
          {band.provisional ? <span className="text-ink-secondary"> (open)</span> : null}
        </>
      ),
    },
    { key: 'state', header: 'State', cell: (band) => <StateBadge state={band.state} /> },
    {
      key: 'cause',
      header: 'Cause',
      priority: 2,
      cell: (band) => <CauseText cause={band.cause} />,
    },
    {
      key: 'elapsed',
      header: 'Duration',
      numeric: true,
      cell: (band) => durationText(band.end - band.start),
    },
  ];
}

/** Least time between interval reads caused by pushed state changes. */
export const STATE_REFETCH_MS = 2_000;

/**
 * Reads the intervals again when this machine's state changes (at most every 2 s). The timeline
 * draws the live state on from its start, but a state that came and went between two reads would
 * leave a hole until the next periodic read, 15 s of wall time or 15 simulated minutes at 60×.
 */
function useRefetchIntervalsOnStateChange(id: string, current: CurrentStateDto | undefined) {
  const queryClient = useQueryClient();
  const stateKey = current
    ? `${id}|${String(current.epoch)}|${String(current.seq)}|${current.since}`
    : undefined;
  const seen = useRef<string | undefined>(undefined);
  const lastRead = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (stateKey === undefined || seen.current === stateKey) return;
    const first = seen.current === undefined;
    seen.current = stateKey;
    if (first || timer.current !== undefined) return;
    const read = () => {
      lastRead.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: ['intervals', id] });
    };
    const wait = lastRead.current + STATE_REFETCH_MS - Date.now();
    if (wait <= 0) read();
    else {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        read();
      }, wait);
    }
  }, [id, queryClient, stateKey]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
}

function StateSection({
  id,
  range,
  current,
  window,
  clockKnown,
}: {
  readonly id: string;
  readonly range: RangeKey;
  readonly current: CurrentStateDto | undefined;
  readonly window: Window | undefined;
  readonly clockKnown: boolean;
}) {
  const queryClient = useQueryClient();
  useRefetchIntervalsOnStateChange(id, current);
  const rangeMs = RANGES[range].ms;
  const intervals = useQuery({
    queryKey: queryKeys.intervals(id, range),
    queryFn: ({ signal }) => {
      const to = Date.parse(plantClock(queryClient)?.watermark ?? '') || Date.now();
      return getIntervals(id, { from: new Date(to - rangeMs), to: new Date(to) }, signal);
    },
    enabled: clockKnown,
    refetchInterval: INTERVALS_REFRESH_MS,
  });
  const bands =
    window && intervals.data
      ? timelineBands(withLiveState(intervals.data.intervals, current, window.to), window)
      : [];
  const label = RANGES[range].label;
  return (
    <Section
      id="timeline-title"
      title="State timeline"
      description={
        window ? `${label}: ${plantRangeText(window.from, window.to)}` : `${label}, plant time`
      }
    >
      {!clockKnown || intervals.isPending ? (
        <Skeleton shape="text" rows={2} label="Loading intervals…" />
      ) : null}
      {intervals.isError ? (
        <QueryError
          what="the state intervals"
          error={intervals.error}
          onRetry={() => void intervals.refetch()}
        />
      ) : null}
      {clockKnown && !window ? (
        <Card padding="compact">
          <EmptyState
            title="No plant clock yet"
            body="Nothing has reported, so there is no time to draw the states against."
            icon="clock"
          />
        </Card>
      ) : null}
      {window && intervals.data ? (
        <div className="flex flex-col gap-4">
          {intervals.data.truncated ? (
            <Callout tone="warn">
              The range holds more intervals than the page shows; the latest are left out.
            </Callout>
          ) : null}
          {bands.length === 0 ? (
            <Card padding="compact">
              <EmptyState
                title="No state intervals in this range"
                body="The machine reported no state in this time; try a longer range."
                icon="clock"
              />
            </Card>
          ) : (
            <>
              <Card padding="compact">
                <Timeline bands={bands} window={window} />
              </Card>
              <Section level={3} title="Time per state">
                <DataTable
                  caption={`Time per state, ${label.toLowerCase()}`}
                  testId="state-totals"
                  columns={TOTAL_COLUMNS}
                  rows={stateTotals(bands)}
                  rowKey={(total) => total.state}
                  rowProps={(total) => ({ 'data-state': total.state })}
                  density="compact"
                />
              </Section>
              <Disclosure summary={`Every interval (${String(bands.length)})`}>
                <DataTable
                  caption={`State intervals, ${label.toLowerCase()}`}
                  testId="state-intervals"
                  columns={intervalColumns(window.to)}
                  rows={bands}
                  rowKey={(band) => `${String(band.epoch)}-${String(band.start)}-${band.state}`}
                  rowProps={(band) => ({ 'data-state': band.state })}
                  density="compact"
                  pageSize={50}
                />
              </Disclosure>
            </>
          )}
        </div>
      ) : null}
    </Section>
  );
}

/** The newer of the stored latest value and the last pushed sample. */
function latestOf(
  metric: Metrics['metrics'][number],
  live: LiveTelemetry | undefined,
): { t: string; value: number } {
  const pushed = live?.[metric.metric]?.samples.at(-1);
  if (pushed && pushed.t >= Date.parse(metric.latest.t)) {
    return { t: new Date(pushed.t).toISOString(), value: pushed.value };
  }
  return metric.latest;
}

interface MetricRow {
  readonly metric: string;
  readonly unit: string;
  readonly latest: { readonly t: string; readonly value: number };
}

/** How long a latest value has been unchanged against the plant clock, when worth saying. */
function sampleAge(t: string, clock: number | undefined): number | undefined {
  if (clock === undefined) return undefined;
  const ms = clock - Date.parse(t);
  return ms > SAMPLE_AGE_SHOWN_MS ? ms : undefined;
}

function metricColumns(clock: number | undefined): readonly Column<MetricRow>[] {
  return [
    {
      key: 'metric',
      header: 'Metric',
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-col">
          <span className="text-ink">{metricName(row.metric)}</span>{' '}
          <Code className="whitespace-nowrap text-xs text-ink-secondary">{row.metric}</Code>
        </span>
      ),
    },
    {
      key: 'latest',
      header: 'Latest',
      numeric: true,
      cell: (row) => (
        <>
          <span data-testid={`latest-${row.metric}`}>{plainText(row.latest.value)}</span>
          <span className="text-ink-secondary"> {row.unit}</span>
        </>
      ),
    },
    {
      key: 'at',
      header: 'Last sample',
      cell: (row) => {
        const age = sampleAge(row.latest.t, clock);
        return (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <PlantTime at={row.latest.t} clock={clock} />
            {age === undefined ? null : (
              <span data-testid={`age-${row.metric}`} className="text-ink-secondary">
                unchanged for {durationText(age)}
              </span>
            )}
          </span>
        );
      },
    },
  ];
}

function TelemetrySection({
  id,
  range,
  window,
  clock,
}: {
  readonly id: string;
  readonly range: RangeKey;
  readonly window: Window | undefined;
  readonly clock: number | undefined;
}) {
  const queryClient = useQueryClient();
  useLiveSubscription(`telemetry:${id}`);
  const live = useLiveTelemetry(id);
  const metrics = useQuery({
    queryKey: queryKeys.metrics(id),
    queryFn: ({ signal }) => getMetrics(id, signal),
  });
  const shown = (metrics.data?.metrics ?? []).slice(0, MES_API_LIMITS.metrics);
  const names = shown.map((metric) => metric.metric);
  const rangeMs = RANGES[range].ms;
  const series = useQuery({
    queryKey: queryKeys.series(id, range, names),
    queryFn: ({ signal }) => {
      const to = Date.parse(plantClock(queryClient)?.watermark ?? '') || Date.now();
      return getSeries(
        id,
        names,
        { from: new Date(to - rangeMs), to: new Date(to) },
        CHART_POINTS,
        signal,
      );
    },
    enabled: names.length > 0 && window !== undefined,
    refetchInterval: SERIES_REFRESH_MS,
  });
  const rows: MetricRow[] = (metrics.data?.metrics ?? []).map((metric) => ({
    metric: metric.metric,
    unit: metric.unit,
    latest: latestOf(metric, live),
  }));
  const latestAt = new Map(rows.map((row) => [row.metric, row.latest.t]));

  return (
    <Section
      id="telemetry-title"
      title="Telemetry"
      description="Each metric's latest value and its trend: minimum to maximum, and the average."
    >
      <div className="flex flex-col gap-4">
        {metrics.isError ? (
          <QueryError
            what="the metrics"
            error={metrics.error}
            onRetry={() => void metrics.refetch()}
          />
        ) : (
          <DataTable
            caption="Metrics and latest values"
            testId="metrics"
            columns={metricColumns(clock)}
            rows={rows}
            rowKey={(row) => row.metric}
            loading={metrics.isPending ? 'Loading metrics…' : undefined}
            density="compact"
            empty={
              <EmptyState
                title="No telemetry yet"
                body="This machine sent no telemetry yet."
                icon="info"
              />
            }
          />
        )}
        {metrics.data && metrics.data.metrics.length > shown.length ? (
          <p className="text-sm text-ink-secondary">
            Trends show the first {String(MES_API_LIMITS.metrics)} metrics.
          </p>
        ) : null}
        {series.isError ? (
          <QueryError
            what="the telemetry trends"
            error={series.error}
            onRetry={() => void series.refetch()}
          />
        ) : null}
        {names.length > 0 && window && series.isPending ? (
          <Skeleton shape="chart" label="Loading trends…" />
        ) : null}
        {window && series.data ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {series.data.series.map((item) => {
              const last = latestAt.get(item.metric);
              return (
                <TrendChart
                  key={item.metric}
                  label={metricName(item.metric)}
                  unit={item.unit}
                  window={window}
                  empty={
                    last === undefined ? undefined : (
                      <>
                        The last sample was at <PlantTime at={last} />
                        {Date.parse(last) < window.from ? ', before this range.' : '.'}
                      </>
                    )
                  }
                  data={chartData(
                    item.points,
                    series.data.bucketMs,
                    live?.[item.metric]?.samples ?? [],
                    window,
                  )}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/** Where the machine stands and its state's facts, as "label value" pairs (design system 3.3). */
function Facts({
  equipment,
  current,
  clock,
}: {
  readonly equipment: EquipmentDto;
  readonly current: CurrentStateDto | undefined;
  readonly clock: Clock | null;
}) {
  const fact = (term: string, detail: ReactNode) => (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="text-ink-secondary">{term}</dt>
      <dd className="min-w-0">{detail}</dd>
    </div>
  );
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1">
      {fact(
        'Where',
        <>
          {equipment.area.name} › {equipment.workCenter.name} · {equipment.operation} ·{' '}
          <Code>{equipment.id}</Code>
        </>,
      )}
      {current ? (
        <>
          {fact('In state', <Duration ms={timeInState(current, clock)} seconds />)}
          {fact('Since', <PlantTime at={current.since} clock={clock?.watermark} />)}
          {current.cause === null ? null : fact('Cause', <CauseText cause={current.cause} />)}
        </>
      ) : (
        fact(
          'State',
          <span className="text-ink-secondary">This machine has not reported yet.</span>,
        )
      )}
    </dl>
  );
}

function MachineHeader({
  equipment,
  current,
  clock,
  connectionLost,
  range,
}: {
  readonly equipment: EquipmentDto;
  readonly current: CurrentStateDto | undefined;
  readonly clock: Clock | null;
  readonly connectionLost: boolean;
  readonly range: RangeKey;
}) {
  const stale = current ? staleness(current, clock, connectionLost) : undefined;
  return (
    <PageHeader
      back={BACK}
      title={equipment.name}
      status={
        <span className="flex flex-wrap items-center gap-2">
          <StateBadge
            state={current?.state}
            testId="current-state"
            size="lg"
            stale={stale}
            staleTestId="current-stale"
          />
          {current?.seq === null ? (
            <Badge
              tone="neutral"
              variant="dashed"
              size="lg"
              title="Known from the device's start-up state only; no state change seen yet"
            >
              Provisional
            </Badge>
          ) : null}
        </span>
      }
      meta={<Facts equipment={equipment} current={current} clock={clock} />}
      filters={<RangeSwitch id={equipment.id} range={range} />}
    />
  );
}

export function MachineDetail() {
  const { id } = useParams({ from: '/equipment/$id' });
  const { range } = useSearch({ from: '/equipment/$id' });
  const equipment = useQuery({
    queryKey: queryKeys.equipment(id),
    queryFn: ({ signal }) => getEquipment(id, signal),
  });
  const live = useLiveStates();
  const { clock, known } = usePlantClock();
  const connectionLost = isConnectionLost(useLiveConnection().status);
  const current = newest(equipment.data?.current, live?.states[id]);
  const clockMs = clock ? Date.parse(clock.watermark) : undefined;
  const window =
    clockMs === undefined ? undefined : { from: clockMs - RANGES[range].ms, to: clockMs };

  if (equipment.isPending) {
    // No `h1` until the machine is read: the heading takes the focus when it mounts.
    return (
      <div className="flex flex-col gap-6">
        <p className="text-sm">
          <Link to="/" className="text-link underline-offset-4 hover:underline">
            ‹ {BACK.label}
          </Link>
        </p>
        <Skeleton shape="card" label="Loading machine…" />
      </div>
    );
  }
  if (equipment.error instanceof ApiError && equipment.error.status === 404) {
    return <NotFound kind="machine" id={id} back={{ to: '/', label: BACK.label }} />;
  }
  if (equipment.isError) {
    return (
      <div>
        <PageHeader
          back={BACK}
          title={
            <>
              Machine <Code>{id}</Code>
            </>
          }
          documentTitle={`Machine ${id}`}
        />
        <QueryError
          what={`machine ${id}`}
          error={equipment.error}
          onRetry={() => void equipment.refetch()}
        />
      </div>
    );
  }
  return (
    <div>
      <MachineHeader
        equipment={equipment.data}
        current={current}
        clock={clock}
        connectionLost={connectionLost}
        range={range}
      />
      <StateSection id={id} range={range} current={current} window={window} clockKnown={known} />
      <TelemetrySection id={id} range={range} window={window} clock={clockMs} />
    </div>
  );
}
