import type { Clock, CurrentStateDto, EquipmentDto, Metrics } from '@shopfloor/contracts/mes-api';
import { MES_API_LIMITS } from '@shopfloor/contracts/mes-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { getEquipment, getIntervals, getMetrics, getSeries } from '../api/client.ts';
import { plantClock, queryKeys, usePlantClock } from '../api/queries.ts';
import { TrendChart } from '../chart/trend-chart.tsx';
import { QueryError } from '../components/query-error.tsx';
import { StateBadge } from '../components/state-badge.tsx';
import { chartData } from '../domain/series.ts';
import { STALE_TEXT, newest, stateStyle, staleness, timeInState } from '../domain/states.ts';
import {
  formatClockTime,
  formatDuration,
  formatPlantTime,
  RANGES,
  type RangeKey,
} from '../domain/time.ts';
import { stateTotals, timelineBands, withLiveState, type Band } from '../domain/timeline.ts';
import {
  useLiveConnection,
  useLiveStates,
  useLiveSubscription,
  useLiveTelemetry,
} from '../live/live-context.tsx';

/** Buckets per metric: about one per two pixels of a wide chart. */
const CHART_POINTS = 600;
const INTERVALS_REFRESH_MS = 15_000;
const SERIES_REFRESH_MS = 30_000;

interface Window {
  readonly from: number;
  readonly to: number;
}

function RangePicker({ id, range }: { id: string; range: RangeKey }) {
  return (
    <nav aria-label="Time range">
      <ul className="flex flex-wrap gap-2">
        {(Object.keys(RANGES) as RangeKey[]).map((key) => (
          <li key={key}>
            <Link
              to="/equipment/$id"
              params={{ id }}
              search={{ range: key }}
              aria-current={key === range ? 'page' : undefined}
              className={`inline-block rounded border px-3 py-1 text-sm ${
                key === range
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-400 bg-white text-slate-900 hover:bg-slate-100'
              }`}
            >
              {RANGES[key].label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Timeline({ bands, window }: { bands: readonly Band[]; window: Window }) {
  const states = [...new Set(bands.map((band) => band.state))].sort();
  return (
    <div>
      <div
        role="img"
        aria-label={`State timeline from ${formatPlantTime(window.from)} to ${formatPlantTime(window.to)}; the table below lists every interval`}
        data-testid="state-timeline"
        className="relative h-10 w-full overflow-hidden rounded border border-slate-400 bg-slate-100"
      >
        {bands.map((band) => (
          <div
            key={`${String(band.start)}-${band.state}`}
            data-state={band.state}
            title={`${stateStyle(band.state).label}${band.cause ? ` (${band.cause})` : ''}: ${formatPlantTime(band.start)} – ${formatPlantTime(band.end)}`}
            className={`absolute inset-y-0 ${stateStyle(band.state).className}`}
            style={{ left: `${String(band.left)}%`, width: `${String(band.width)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-slate-600" aria-hidden="true">
        <span>{formatClockTime(window.from)}</span>
        <span>{formatClockTime(window.to)}</span>
      </div>
      {states.length > 0 ? (
        <ul aria-label="Legend" className="mt-2 flex flex-wrap gap-2">
          {states.map((state) => (
            <li key={state}>
              <StateBadge state={state} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StateTotals({ bands, label }: { bands: readonly Band[]; label: string }) {
  const totals = stateTotals(bands);
  if (totals.length === 0) return null;
  return (
    <table className="mt-4 w-full max-w-md text-sm">
      <caption className="text-left font-medium">Time per state, {label.toLowerCase()}</caption>
      <thead>
        <tr className="border-b border-slate-300 text-left">
          <th scope="col" className="py-1">
            State
          </th>
          <th scope="col" className="py-1 text-right">
            Time
          </th>
          <th scope="col" className="py-1 text-right">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {totals.map((total) => (
          <tr key={total.state} className="border-b border-slate-200">
            <th scope="row" className="py-1 text-left font-normal">
              {stateStyle(total.state).label}
            </th>
            <td className="py-1 text-right tabular-nums">{formatDuration(total.ms)}</td>
            <td className="py-1 text-right tabular-nums">{(total.share * 100).toFixed(1)} %</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IntervalTable({ bands }: { bands: readonly Band[] }) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm font-medium">
        Intervals as a table ({String(bands.length)})
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2">
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col">Start</th>
              <th scope="col">End</th>
              <th scope="col">State</th>
              <th scope="col">Cause</th>
              <th scope="col" className="text-right">
                Duration
              </th>
            </tr>
          </thead>
          <tbody>
            {bands.map((band) => (
              <tr key={`${String(band.start)}-${band.state}`} className="border-b border-slate-200">
                <td>{formatPlantTime(band.start)}</td>
                <td>
                  {formatPlantTime(band.end)}
                  {band.provisional ? ' (open)' : ''}
                </td>
                <td>{stateStyle(band.state).label}</td>
                <td>{band.cause ?? '—'}</td>
                <td className="text-right tabular-nums">{formatDuration(band.end - band.start)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function StateSection({
  id,
  range,
  current,
  window,
  clockKnown,
}: {
  id: string;
  range: RangeKey;
  current: CurrentStateDto | undefined;
  window: Window | undefined;
  clockKnown: boolean;
}) {
  const queryClient = useQueryClient();
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
  return (
    <section aria-labelledby="timeline-title" className="mt-8">
      <h2 id="timeline-title" className="text-xl font-semibold">
        State timeline
      </h2>
      <div className="mt-3">
        {!clockKnown || intervals.isPending ? <p>Loading intervals…</p> : null}
        {intervals.isError ? (
          <QueryError
            what="the state intervals"
            error={intervals.error}
            onRetry={() => void intervals.refetch()}
          />
        ) : null}
        {intervals.data?.truncated ? (
          <p className="text-sm text-amber-900">
            The range holds more intervals than the page shows; the latest are left out.
          </p>
        ) : null}
        {window && intervals.data ? (
          bands.length === 0 ? (
            <p>No state intervals in this range.</p>
          ) : (
            <>
              <Timeline bands={bands} window={window} />
              <StateTotals bands={bands} label={RANGES[range].label} />
              <IntervalTable bands={bands} />
            </>
          )
        ) : null}
        {clockKnown && !window ? <p>No plant clock yet: nothing has reported.</p> : null}
      </div>
    </section>
  );
}

function MetricTable({ metrics }: { metrics: Metrics['metrics'] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full max-w-2xl text-sm [&_td]:px-2 [&_th]:px-2">
        <caption className="text-left font-medium">Metrics and latest values</caption>
        <thead>
          <tr className="border-b border-slate-300 text-left">
            <th scope="col">Metric</th>
            <th scope="col">Unit</th>
            <th scope="col" className="text-right">
              Latest
            </th>
            <th scope="col">At</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.metric} className="border-b border-slate-200">
              <th scope="row" className="text-left font-mono font-normal">
                {metric.metric}
              </th>
              <td>{metric.unit}</td>
              <td className="text-right tabular-nums">{metric.latest.value}</td>
              <td>
                <time dateTime={metric.latest.t}>{formatPlantTime(metric.latest.t)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TelemetrySection({
  id,
  range,
  window,
}: {
  id: string;
  range: RangeKey;
  window: Window | undefined;
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

  return (
    <section aria-labelledby="telemetry-title" className="mt-8">
      <h2 id="telemetry-title" className="text-xl font-semibold">
        Telemetry
      </h2>
      <div className="mt-3 flex flex-col gap-4">
        {metrics.isPending ? <p>Loading metrics…</p> : null}
        {metrics.isError ? (
          <QueryError
            what="the metrics"
            error={metrics.error}
            onRetry={() => void metrics.refetch()}
          />
        ) : null}
        {metrics.data?.metrics.length === 0 ? <p>This machine sent no telemetry yet.</p> : null}
        {metrics.data && metrics.data.metrics.length > 0 ? (
          <MetricTable metrics={metrics.data.metrics} />
        ) : null}
        {metrics.data && metrics.data.metrics.length > shown.length ? (
          <p className="text-sm">Trends show the first {String(MES_API_LIMITS.metrics)} metrics.</p>
        ) : null}
        {series.isError ? (
          <QueryError
            what="the telemetry trends"
            error={series.error}
            onRetry={() => void series.refetch()}
          />
        ) : null}
        {window && series.data ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {series.data.series.map((item) => (
              <TrendChart
                key={item.metric}
                label={item.metric}
                unit={item.unit}
                window={window}
                data={chartData(
                  item.points,
                  series.data.bucketMs,
                  live?.[item.metric]?.samples ?? [],
                  window,
                )}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Header({
  equipment,
  current,
  clock,
  connected,
}: {
  equipment: EquipmentDto;
  current: CurrentStateDto | undefined;
  clock: Clock | null;
  connected: boolean;
}) {
  const stale = current ? staleness(current, clock, connected) : undefined;
  return (
    <header>
      <h1 className="text-2xl font-bold">{equipment.name}</h1>
      <p className="text-sm text-slate-700">
        <span className="font-mono">{equipment.id}</span> · {equipment.operation} ·{' '}
        {equipment.area.name} / {equipment.workCenter.name}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <StateBadge state={current?.state} testId="current-state" size="lg" />
        {current ? (
          <span className="text-sm">
            {current.cause ? `${current.cause} · ` : ''}
            for {formatDuration(timeInState(current, clock))} since{' '}
            <time dateTime={current.since}>{formatPlantTime(current.since)}</time>
          </span>
        ) : (
          <span className="text-sm">This machine has not reported yet.</span>
        )}
        {stale ? (
          <span className="rounded border border-amber-700 px-1.5 text-xs font-medium text-amber-900">
            {STALE_TEXT[stale]}
          </span>
        ) : null}
      </div>
    </header>
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
  const connected = useLiveConnection().status === 'open';
  const current = newest(equipment.data?.current, live?.states[id]);
  const clockMs = clock ? Date.parse(clock.watermark) : undefined;
  const window =
    clockMs === undefined ? undefined : { from: clockMs - RANGES[range].ms, to: clockMs };

  return (
    <article>
      <p className="mb-4 text-sm">
        <Link to="/" className="text-sky-800 underline">
          ← Plant overview
        </Link>
      </p>
      {equipment.isPending ? <p>Loading machine…</p> : null}
      {equipment.isError ? (
        <QueryError
          what={`machine ${id}`}
          error={equipment.error}
          onRetry={() => void equipment.refetch()}
        />
      ) : null}
      {equipment.data ? (
        <>
          <Header
            equipment={equipment.data}
            current={current}
            clock={clock}
            connected={connected}
          />
          <div className="mt-6">
            <RangePicker id={id} range={range} />
          </div>
          <StateSection
            id={id}
            range={range}
            current={current}
            window={window}
            clockKnown={known}
          />
          <TelemetrySection id={id} range={range} window={window} />
        </>
      ) : null}
    </article>
  );
}
