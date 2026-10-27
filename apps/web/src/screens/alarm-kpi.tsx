import {
  ALARMS_TOPIC,
  type AlarmConfig,
  type AlarmKpiBucketDto,
  type AlarmScopes,
  type BadActorDto,
  type FloodEpisodeDto,
} from '@shopfloor/contracts/mes-api';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  getAlarmKpi,
  getAlarmScopes,
  getBadActors,
  getFloods,
  getOperatorKpi,
  listEquipment,
  type AlarmScopeRef,
} from '../api/client.ts';
import { queryKeys, useAlarmConfig, usePlantClock } from '../api/queries.ts';
import {
  alarmHourlyOption,
  alarmHourlyReading,
  type AlarmHourBar,
} from '../chart/alarm-options.ts';
import { EChart } from '../chart/echart.tsx';
import {
  FlagBadges,
  SectionFinality,
  groupFinality,
  itemFlags,
  type GroupFinality,
} from '../components/oee-ui.tsx';
import { QueryError } from '../components/query-error.tsx';
import { ShiftPicker, shiftKeyLabel, useShiftSelection } from '../components/shift-picker.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { Select } from '../components/ui/controls.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { DescriptionList, type Fact } from '../components/ui/description-list.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, Percent, PlantTime, Ratio } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { KpiTile } from '../components/ui/stat.tsx';
import type { Tone } from '../components/ui/tokens.ts';
import {
  alarmBucketFlags,
  alarmShiftHours,
  meanTimeToAck,
  msText,
  parseScopeKey,
  rateBand,
  rateBandText,
  scopeKey,
  windowLabel,
  type AlarmHourRow,
  type RateBand,
} from '../domain/alarms.ts';
import { NOT_APPLICABLE, pickBucket } from '../domain/oee.ts';
import { formatClockTime } from '../domain/time.ts';
import {
  useLiveAlarmKpi,
  useLiveAlarmKpis,
  useLiveAlarms,
  useLiveSubscriptions,
} from '../live/live-context.tsx';
import { ShiftSpan } from './oee-dashboard.tsx';

const HOUR = 3_600_000;
/** How far back the shift buckets of the bucket table reach. */
const SHIFT_BUCKETS_MS = 7 * 24 * HOUR;
/** Floods, bad actors and operator measures are read again at most this often while live. */
const REREAD_THROTTLE_MS = 2_000;

type Scope = AlarmScopes['scopes'][number];
interface Range {
  readonly from: number;
  readonly to: number;
}

/** `plant` → `plant`, `position:cell-m1` → `position-cell-m1` (test ids). */
const testKey = (key: string): string => key.replace(':', '-');

/** Reads `queryKey` again after `trigger` changes, at most every `REREAD_THROTTLE_MS`. */
function useThrottledReread(trigger: unknown, queryKey: readonly unknown[], enabled: boolean) {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const first = useRef(true);
  const key = JSON.stringify(queryKey);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!enabled || trigger === undefined || timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void queryClient.invalidateQueries({ queryKey: JSON.parse(key) as unknown[] });
    }, REREAD_THROTTLE_MS);
  }, [trigger, key, enabled, queryClient]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
}

/**
 * The EEMUA 191 verdict's tone (design system section 1: colour only for abnormal): acceptable
 * is neutral, manageable a warning, over the benchmark an alarm.
 */
const BAND_TONE: Readonly<Record<RateBand, Tone>> = {
  acceptable: 'neutral',
  manageable: 'warn',
  over: 'alarm',
};

/** A measure as a fact whose `dd` carries `data-measure` (the specs read it, #295). */
const measure = (name: string, term: string, detail: ReactNode): Fact => ({
  id: name,
  term,
  detail,
  detailData: { 'data-measure': name },
});

/** The measures of a bucket under its headline and the raises and peak (K-01). */
function bucketFacts(bucket: AlarmKpiBucketDto): Fact[] {
  return [
    measure(
      'flood-windows',
      'Flood windows',
      `${String(bucket.floodWindows)} of ${String(bucket.windows)}`,
    ),
    measure(
      'flood-episodes',
      'Flood episodes (time)',
      `${String(bucket.floods.length)} (${msText(bucket.floodMs)})`,
    ),
    measure(
      'chattering',
      'Chattering raises (points)',
      `${String(bucket.chatteringRaises)} (${String(bucket.chatteringPoints.length)})`,
    ),
    measure(
      'fleeting',
      'Fleeting',
      `${String(bucket.fleeting)}${bucket.fleetingUndecided > 0 ? ` (+${String(bucket.fleetingUndecided)} undecided)` : ''}`,
    ),
    measure(
      'standing',
      'Standing (active at end)',
      `${String(bucket.standing.length)} (${String(bucket.activeAtEnd)})`,
    ),
    measure('active-time', 'Active time', msText(bucket.activeMs)),
  ];
}

/**
 * One scope's KPIs over the shift (K-01): the average per window with its EEMUA 191 verdict as
 * the headline, the other measures in a compact list under it; its own flags beside the title
 * only where they differ from the section's finality (E-03).
 */
function ScopeTile({
  scope,
  bucket,
  read,
  finality,
  config,
}: {
  readonly scope: Scope;
  readonly bucket: AlarmKpiBucketDto | undefined;
  readonly read: {
    readonly isError: boolean;
    readonly error: unknown;
    readonly loaded: boolean;
    readonly retry: () => void;
  };
  readonly finality: GroupFinality | undefined;
  readonly config: AlarmConfig | undefined;
}) {
  const key = testKey(scopeKey(scope));
  // The window as served (#160, #147): `10 min` by default, `window` until the answer arrived.
  const per = windowLabel(config?.kpi.windowMs);
  const label = `Average per ${per}`;
  // The benchmarks are the MES's (#160): no verdict until they arrived.
  const band = bucket && config ? rateBand(bucket.averageRate, config) : undefined;
  const flags = bucket ? itemFlags(alarmBucketFlags(bucket), finality) : [];
  return (
    <KpiTile
      title={scope.name}
      testId={`kpi-card-${key}`}
      data-raises={bucket ? String(bucket.raises) : NOT_APPLICABLE}
      data-final={bucket ? String(bucket.final) : undefined}
      data-revision={bucket ? String(bucket.revision) : undefined}
      status={flags.length > 0 ? <FlagBadges flags={flags} /> : undefined}
      headline={
        bucket
          ? {
              label,
              value: <Ratio ratio={bucket.averageRate} na="No raise rate" />,
              verdict:
                band && config
                  ? { tone: BAND_TONE[band], text: rateBandText(band, config) }
                  : undefined,
              tone: band === 'over' ? 'alarm' : undefined,
              hint: 'Verdict against the EEMUA 191 benchmarks',
              detailData: { 'data-measure': 'average-rate', 'data-band': band },
            }
          : {
              label,
              testId: read.loaded ? `kpi-empty-${key}` : undefined,
              missing: read.isError
                ? 'Not available: the read failed'
                : read.loaded
                  ? 'No alarm KPIs for this shift yet'
                  : 'Loading…',
            }
      }
      details={
        bucket
          ? [
              {
                label: 'Raises',
                value: String(bucket.raises),
                hint: `${String(bucket.byPriority.high)} high · ${String(bucket.byPriority.medium)} medium · ${String(bucket.byPriority.low)} low`,
                detailData: { 'data-measure': 'raises' },
              },
              {
                label: `Peak per ${per}`,
                value: String(bucket.peak10),
                detailData: { 'data-measure': 'peak10' },
              },
            ]
          : []
      }
    >
      {read.isError ? <QueryError what="the KPIs" error={read.error} onRetry={read.retry} /> : null}
      {bucket ? (
        <DescriptionList
          columns="tile"
          label={`Measures of ${scope.name}`}
          facts={bucketFacts(bucket)}
        />
      ) : null}
    </KpiTile>
  );
}

/** REST buckets with the pushed one of the same key over them, or added when it is new. */
function withPushed(
  rest: readonly AlarmKpiBucketDto[],
  pushed: AlarmKpiBucketDto | null | undefined,
  range: Range,
): AlarmKpiBucketDto[] {
  if (!pushed) return [...rest];
  const inRange = Date.parse(pushed.from) >= range.from && Date.parse(pushed.from) < range.to;
  const merged = rest.map((bucket) =>
    bucket.key === pushed.key ? (pickBucket(bucket, pushed) ?? bucket) : bucket,
  );
  if (inRange && !rest.some((bucket) => bucket.key === pushed.key)) merged.push(pushed);
  return merged.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
}

const QUIET = 'No alarm activity';
const QUIET_STATUS = 'No bucket from the MES for this hour, so no finality';

/** A cell of a row: the bucket's value, or the empty bucket's for an hour without activity. */
function quietOr(
  row: AlarmHourRow,
  value: (bucket: AlarmKpiBucketDto) => ReactNode,
  empty: string,
) {
  return row.bucket ? value(row.bucket) : <span className="text-ink-secondary">{empty}</span>;
}

/**
 * The bucket table's columns (design system 4.5): the hour or shift names its row; numbers right
 * aligned; the status only when a row says something its section does not (E-03). An hour the MES
 * did not list (ADR-0024) holds the empty bucket's zeros under "No alarm activity" and no status.
 */
function bucketColumns(
  bucket: 'hour' | 'shift',
  per: string,
  finality: GroupFinality | undefined,
  withStatus: boolean,
): readonly Column<AlarmHourRow>[] {
  return [
    {
      key: 'when',
      header: bucket === 'hour' ? 'Hour' : 'Shift',
      rowHeader: true,
      nowrap: true,
      cell: (row) =>
        bucket === 'hour' ? (
          <span className="flex flex-col">
            <span className="tabular-nums">
              <time dateTime={row.from}>{formatClockTime(row.from)}</time>–
              <time dateTime={row.to}>{formatClockTime(row.to)}</time>
            </span>
            {row.bucket ? null : <span className="text-xs text-ink-secondary">{QUIET}</span>}
          </span>
        ) : (
          shiftKeyLabel(row.key)
        ),
    },
    {
      key: 'raises',
      header: 'Raises',
      numeric: true,
      cell: (row) => quietOr(row, (b) => b.raises, '0'),
    },
    {
      key: 'average',
      header: `Avg / ${per}`,
      numeric: true,
      cell: (row) =>
        quietOr(row, (b) => <Ratio ratio={b.averageRate} na="No raise rate" />, '0.0000'),
    },
    {
      key: 'peak',
      header: 'Peak',
      numeric: true,
      cell: (row) => quietOr(row, (b) => b.peak10, '0'),
    },
    {
      key: 'flood-windows',
      header: 'Flood windows',
      numeric: true,
      priority: 2,
      cell: (row) => quietOr(row, (b) => b.floodWindows, '0'),
    },
    {
      key: 'flood-time',
      header: 'Flood time',
      numeric: true,
      priority: 3,
      cell: (row) => quietOr(row, (b) => msText(b.floodMs), msText(0)),
    },
    {
      key: 'chattering',
      header: 'Chattering',
      numeric: true,
      priority: 3,
      cell: (row) => quietOr(row, (b) => b.chatteringRaises, '0'),
    },
    {
      key: 'fleeting',
      header: 'Fleeting',
      numeric: true,
      priority: 3,
      cell: (row) =>
        quietOr(
          row,
          (b) => (
            <>
              {b.fleeting}
              {b.fleetingUndecided > 0 ? (
                <span title={`${String(b.fleetingUndecided)} not yet decided`}>
                  {` +${String(b.fleetingUndecided)}?`}
                </span>
              ) : null}
            </>
          ),
          '0',
        ),
    },
    {
      key: 'standing',
      header: 'Standing',
      numeric: true,
      priority: 2,
      cell: (row) => quietOr(row, (b) => b.standing.length, '0'),
    },
    ...(withStatus
      ? [
          {
            key: 'status',
            header: 'Status',
            cell: (row: AlarmHourRow) => {
              if (!row.bucket) return <Missing reason={QUIET_STATUS} />;
              const flags = itemFlags(alarmBucketFlags(row.bucket), finality);
              return flags.length > 0 ? (
                <FlagBadges flags={flags} />
              ) : (
                <Missing reason="Nothing beyond the table’s status" />
              );
            },
          },
        ]
      : []),
  ];
}

/** The hourly chart's swatches: what the peak bars' shades mean, and the hours without a bar. */
function HourLegend() {
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 text-xs text-ink-secondary">
      <span>
        <span aria-hidden="true" className="mr-1 inline-block size-2.5 bg-chart-1" />
        Peak, final
      </span>
      <span>
        <span aria-hidden="true" className="mr-1 inline-block size-2.5 bg-line-strong" />
        Peak, provisional
      </span>
      <span>No bar: no raise in that hour</span>
    </p>
  );
}

/**
 * The focus's KPIs per hour of the shift, or per shift of the last week. Per hour (K-02, UX-B5):
 * the MES lists only the hours where something happened and the hour in progress (ADR-0024), so
 * the table fills in every other hour of the shift that has begun by the plant clock as "No alarm
 * activity", with a zero bar in the chart, which so covers the shift as the OEE chart does.
 */
function BucketTable({
  scope,
  bucket,
  range,
  until,
  live,
}: {
  readonly scope: AlarmScopeRef;
  readonly bucket: 'hour' | 'shift';
  readonly range: Range;
  /** The plant clock's hour (its start): hours after it have not begun. */
  readonly until: number | undefined;
  readonly live: boolean;
}) {
  const key = scopeKey(scope);
  const rest = useQuery({
    queryKey: queryKeys.alarmKpi(key, bucket, range.from, range.to),
    queryFn: ({ signal }) =>
      getAlarmKpi({ ...scope, bucket, from: range.from, to: range.to }, signal),
  });
  const pushedKpi = useLiveAlarmKpi(key);
  const config = useAlarmConfig();
  const per = windowLabel(config?.kpi.windowMs);
  const pushed = pushedKpi?.[bucket];
  const loaded = rest.data !== undefined;
  const rows = useMemo((): AlarmHourRow[] => {
    const buckets = withPushed(rest.data?.buckets ?? [], pushed, range);
    if (bucket === 'hour') return loaded ? alarmShiftHours(buckets, range, until) : [];
    return buckets.map((b) => ({ key: b.key, from: b.from, to: b.to, bucket: b }));
  }, [rest.data, pushed, range, until, bucket, loaded]);
  const listed = useMemo(() => rows.flatMap((row) => (row.bucket ? [row.bucket] : [])), [rows]);
  const finality = groupFinality(listed);
  const withStatus = rows.some(
    (row) => row.bucket && itemFlags(alarmBucketFlags(row.bucket), finality).length > 0,
  );
  const quiet = rows.some((row) => !row.bucket);
  const columns = useMemo(
    () => bucketColumns(bucket, per, finality, withStatus),
    [bucket, per, finality, withStatus],
  );

  // Built again only when the data or the served config changes: a new option redraws the chart
  // (`notMerge`), which drops an open tooltip.
  const floodThreshold = config?.kpi.floodThreshold;
  const windowMs = config?.kpi.windowMs;
  const bars = useMemo(
    (): AlarmHourBar[] =>
      rows.map((row) => ({
        from: row.from,
        raises: row.bucket?.raises ?? 0,
        peak10: row.bucket?.peak10 ?? 0,
        final: row.bucket?.final,
      })),
    [rows],
  );
  const option = useMemo(
    () =>
      bars.some((bar) => bar.raises > 0) ? alarmHourlyOption(bars, floodThreshold, windowMs) : null,
    [bars, floodThreshold, windowMs],
  );
  const title = bucket === 'hour' ? 'Hours of the shift' : 'Shifts of the last week';
  return (
    <div className="flex flex-col gap-4">
      {bucket === 'hour' && !rest.isError ? (
        <EChart
          testId="kpi-hourly"
          title={`Raises and peak per ${per}, by hour`}
          description={`${alarmHourlyReading(bars, floodThreshold, windowMs)}; the table below lists every value.`}
          option={option}
          empty={
            !loaded
              ? undefined
              : rows.length === 0
                ? 'No hour of this shift has begun yet.'
                : live
                  ? 'No alarm raised in this shift so far.'
                  : 'No alarm raised in this shift.'
          }
        >
          {option ? <HourLegend /> : null}
        </EChart>
      ) : null}
      <Section
        level={3}
        id={`kpi-${bucket}-title`}
        title={title}
        status={<SectionFinality buckets={listed} testId="kpi-buckets-finality" />}
      >
        {rest.isError ? (
          <QueryError what="the buckets" error={rest.error} onRetry={() => void rest.refetch()} />
        ) : null}
        <div data-testid="kpi-buckets" data-bucket={bucket} className="flex flex-col gap-2">
          {rest.isError ? null : (
            <DataTable
              caption={`Alarm KPIs per ${bucket === 'hour' ? 'hour of the shift' : 'shift of the last week'}`}
              testId="kpi-bucket-table"
              columns={columns}
              rows={rows}
              rowKey={(row) => row.key}
              rowTestId={(row) => (row.bucket ? `kpi-row-${row.key}` : `kpi-quiet-${row.key}`)}
              rowProps={(row) =>
                row.bucket
                  ? {
                      'data-final': String(row.bucket.final),
                      'data-revision': String(row.bucket.revision),
                    }
                  : { 'data-quiet': 'true' }
              }
              density="compact"
              loading={
                rest.isPending
                  ? `Loading the ${bucket === 'hour' ? 'hours' : 'shifts'}…`
                  : undefined
              }
              empty={
                <div className="px-4">
                  <EmptyState
                    size="inline"
                    icon="info"
                    title={
                      bucket === 'hour'
                        ? 'No hour of this shift has begun yet'
                        : 'No shift in the last week'
                    }
                  />
                </div>
              }
            />
          )}
          {bucket === 'hour' && quiet ? (
            <p className="text-xs text-ink-secondary" data-testid="kpi-quiet-note">
              The MES does not list an hour without alarm activity: it shows here as “{QUIET}”, with
              no finality.
            </p>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

function PointName({
  equipment,
  code,
  name,
}: {
  readonly equipment: string;
  readonly code: string;
  readonly name: (id: string) => string;
}) {
  return (
    <span className="flex flex-col">
      <span>{name(equipment)}</span>
      <Code className="whitespace-nowrap text-xs text-ink-secondary">{code}</Code>
    </span>
  );
}

function floodColumns(
  clock: string | undefined,
  name: (id: string) => string,
): readonly Column<FloodEpisodeDto>[] {
  return [
    {
      key: 'start',
      header: 'Start',
      nowrap: true,
      cell: (episode) => <PlantTime at={episode.startAt} clock={clock} />,
    },
    {
      key: 'end',
      header: 'End',
      nowrap: true,
      cell: (episode) =>
        episode.endAt ? (
          <PlantTime at={episode.endAt} clock={clock} />
        ) : (
          <Badge tone="alarm" variant="soft">
            In flood
          </Badge>
        ),
    },
    { key: 'peak', header: 'Peak', numeric: true, cell: (episode) => episode.peak },
    { key: 'raises', header: 'Raises', numeric: true, cell: (episode) => episode.raises },
    {
      key: 'by',
      header: 'Started by',
      cell: (episode) => (
        <PointName equipment={episode.equipment} code={episode.code} name={name} />
      ),
    },
  ];
}

function FloodTable({
  scope,
  range,
  live,
  name,
}: {
  readonly scope: AlarmScopeRef;
  readonly range: Range;
  readonly live: boolean;
  readonly name: (id: string) => string;
}) {
  const key = scopeKey(scope);
  const queryKey = queryKeys.alarmFloods(key, range.from, range.to);
  const floods = useQuery({
    queryKey,
    queryFn: ({ signal }) => getFloods({ ...scope, ...range }, signal),
  });
  useThrottledReread(useLiveAlarmKpi(key), queryKey, live);
  const { clock } = usePlantClock();
  return (
    <Section
      level={3}
      id="kpi-floods-title"
      title="Flood episodes"
      description="Sliding windows with more raises than the flood threshold."
      className="min-w-0"
    >
      {floods.isError ? (
        <QueryError what="the floods" error={floods.error} onRetry={() => void floods.refetch()} />
      ) : (
        <DataTable
          caption="Sliding flood episodes in the shift"
          testId="kpi-floods"
          columns={floodColumns(clock?.watermark, name)}
          rows={floods.data?.episodes ?? []}
          rowKey={(episode) => episode.id}
          rowTestId={(episode) => `flood-${episode.id}`}
          rowProps={(episode) => ({ 'data-open': String(episode.endAt === null) })}
          rowTone={(episode) => (episode.endAt === null ? 'alarm' : undefined)}
          density="compact"
          narrow="stack"
          loading={floods.isPending ? 'Loading flood episodes…' : undefined}
          empty={
            <div className="px-4">
              <EmptyState size="inline" icon="check" title="No flood in this shift" />
            </div>
          }
        />
      )}
    </Section>
  );
}

function actorColumns(
  name: (id: string) => string,
): readonly Column<{ actor: BadActorDto; rank: number }>[] {
  return [
    { key: 'rank', header: 'Rank', numeric: true, cell: ({ rank }) => rank },
    {
      key: 'point',
      header: 'Point',
      rowHeader: true,
      cell: ({ actor }) => <PointName equipment={actor.equipment} code={actor.code} name={name} />,
    },
    { key: 'raises', header: 'Raises', numeric: true, cell: ({ actor }) => actor.raises },
    {
      key: 'share',
      header: 'Share',
      numeric: true,
      cell: ({ actor }) => <Percent ratio={actor.share} na="No raise in the shift" />,
    },
    {
      key: 'active',
      header: 'Active time',
      numeric: true,
      cell: ({ actor }) => msText(actor.activeMs),
    },
    {
      key: 'chattering',
      header: 'Chattering',
      numeric: true,
      cell: ({ actor }) => actor.chatteringRaises,
    },
  ];
}

function BadActorTable({
  scope,
  range,
  live,
  name,
}: {
  readonly scope: AlarmScopeRef;
  readonly range: Range;
  readonly live: boolean;
  readonly name: (id: string) => string;
}) {
  const key = scopeKey(scope);
  const queryKey = queryKeys.badActors(key, range.from, range.to);
  const actors = useQuery({
    queryKey,
    queryFn: ({ signal }) => getBadActors({ ...scope, ...range }, signal),
  });
  useThrottledReread(useLiveAlarmKpi(key), queryKey, live);
  const rows = (actors.data?.actors ?? []).map((actor, index) => ({ actor, rank: index + 1 }));
  return (
    <Section
      level={3}
      id="kpi-bad-actors-title"
      title="Top 10 bad actors"
      description="The alarm points with the most raises in the shift, most first."
      className="min-w-0"
    >
      {actors.isError ? (
        <QueryError
          what="the bad actors"
          error={actors.error}
          onRetry={() => void actors.refetch()}
        />
      ) : (
        <DataTable
          caption="Alarm points with the most raises in the shift, most first"
          testId="kpi-bad-actors"
          columns={actorColumns(name)}
          rows={rows}
          rowKey={({ actor }) => `${actor.equipment}/${actor.code}`}
          rowTestId={({ actor }) => `bad-actor-${actor.equipment}-${actor.code}`}
          rowProps={({ actor }) => ({ 'data-raises': String(actor.raises) })}
          density="compact"
          narrow="stack"
          loading={actors.isPending ? 'Loading bad actors…' : undefined}
          empty={
            <div className="px-4">
              <EmptyState size="inline" icon="check" title="No alarm in this shift" />
            </div>
          }
        />
      )}
    </Section>
  );
}

function OperatorMeasures({
  scope,
  range,
  live,
  name,
}: {
  readonly scope: AlarmScopeRef;
  readonly range: Range;
  readonly live: boolean;
  readonly name: (id: string) => string;
}) {
  const key = scopeKey(scope);
  const queryKey = queryKeys.operatorKpi(key, range.from, range.to);
  const measures = useQuery({
    queryKey,
    queryFn: ({ signal }) => getOperatorKpi({ ...scope, bucket: 'range', ...range }, signal),
  });
  // Acknowledgements and shelves change them; they come on the `alarms` topic.
  useThrottledReread(useLiveAlarms()?.seq, queryKey, live);
  const bucket = measures.data?.buckets[0];
  return (
    <Card
      as="section"
      title="Operator measures"
      headingLevel={3}
      testId="kpi-operator"
      data-provisional={bucket ? String(bucket.provisional) : undefined}
      status={
        bucket?.provisional ? (
          <Badge
            tone="neutral"
            variant="dashed"
            title="The shift is not over: these may still change"
          >
            Provisional
          </Badge>
        ) : undefined
      }
      description="From the MES only, not reconciled with the ground truth: they depend on what operators do."
    >
      {measures.isError ? (
        <QueryError
          what="the operator measures"
          error={measures.error}
          onRetry={() => void measures.refetch()}
        />
      ) : null}
      {measures.isPending ? <Skeleton shape="text" label="Loading operator measures…" /> : null}
      {measures.isSuccess && !bucket ? (
        <EmptyState size="inline" icon="info" title="No operator measures for this shift yet" />
      ) : null}
      {bucket ? (
        <div className="flex flex-col gap-2">
          <DescriptionList
            facts={[
              measure('annunciated', 'Annunciated raises', String(bucket.annunciatedRaises)),
              measure('shelved-raises', 'Raises while shelved', String(bucket.shelvedRaises)),
              measure('acknowledged', 'Acknowledged', String(bucket.timeToAck.count)),
              measure(
                'mean-time-to-ack',
                'Mean time to acknowledge',
                bucket.timeToAck.count === 0 ? (
                  <Missing reason="No acknowledgement in this shift" />
                ) : (
                  meanTimeToAck(bucket.timeToAck)
                ),
              ),
              measure(
                'max-time-to-ack',
                'Longest time to acknowledge',
                bucket.timeToAck.maxMs === null ? (
                  <Missing reason="No acknowledgement in this shift" />
                ) : (
                  msText(bucket.timeToAck.maxMs)
                ),
              ),
              measure(
                'unacknowledged',
                'Unacknowledged at the end',
                String(bucket.unacknowledgedAtEnd),
              ),
            ]}
          />
          {bucket.shelvedMs.length > 0 ? (
            <div>
              <h4 className="text-sm font-semibold text-ink">Shelved time per point</h4>
              <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="kpi-shelved-points">
                {bucket.shelvedMs.map((point) => (
                  <li key={`${point.equipment}/${point.code}`} className="flex flex-wrap gap-x-2">
                    <span>{name(point.equipment)}</span>
                    <Code className="whitespace-nowrap text-ink-secondary">{point.code}</Code>
                    <span className="tabular-nums">{msText(point.ms)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The alarm KPIs (UX-4b, #325; design system section 10): per scope a KPI tile with the average
 * per window and its EEMUA 191 verdict as the headline (K-01), then one scope's hours, floods, bad
 * actors and operator measures. Finality is said once per section (E-03); every hour of the shift
 * is listed, the quiet ones as "No alarm activity" (K-02).
 */
export function AlarmKpi() {
  const search = useSearch({ from: '/alarms/kpi' });
  const navigate = useNavigate({ from: '/alarms/kpi' });
  const selection = useShiftSelection(search.shift);
  const shiftKey = selection.selected;
  const { clock } = usePlantClock();
  const config = useAlarmConfig();
  const scopes = useQuery({
    queryKey: queryKeys.alarmScopes,
    queryFn: ({ signal }) => getAlarmScopes(signal),
    staleTime: 5 * 60_000,
  });
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const all = scopes.data?.scopes ?? [];
  const cards = all.filter((scope) => scope.scope !== 'equipment');
  const requested = parseScopeKey(search.focus);
  const focus: Scope | undefined =
    all.find((scope) => scope.scope === requested?.scope && scope.id === requested.id) ?? cards[0];
  const bucket = search.bucket ?? 'hour';

  const currentShift = selection.current?.shift ?? undefined;
  const shift =
    selection.shifts.find((candidate) => candidate.key === shiftKey) ??
    (currentShift?.key === shiftKey ? currentShift : undefined);
  const from = shift ? Date.parse(shift.start) : undefined;
  const to = shift ? Date.parse(shift.end) : undefined;
  const range = useMemo(
    () => (from === undefined || to === undefined ? undefined : { from, to }),
    [from, to],
  );
  const watermark = clock ? Date.parse(clock.watermark) : undefined;
  // The hour the plant clock is in: stable within the hour, so the chart keeps its option.
  const clockHour = watermark === undefined ? undefined : Math.floor(watermark / HOUR) * HOUR;
  const weekTo = clockHour === undefined ? undefined : clockHour + HOUR;
  const live = selection.isCurrent;
  // A past shift has ended by the plant clock: all of it, even before the clock is known.
  const until = clockHour ?? (live || to === undefined ? undefined : to);
  const week = useMemo(
    () => (weekTo === undefined ? undefined : { from: weekTo - SHIFT_BUCKETS_MS, to: weekTo }),
    [weekTo],
  );

  // Live: the plant and every position (cards), and the focus (an equipment as well), plus
  // `alarms` for the operator measures; at most a handful of the MES's 16 alarm KPI topics.
  const topics = [...new Set([...cards, ...(focus ? [focus] : [])].map(scopeKey))].map(
    (key) => `alarm-kpi:${key}`,
  );
  useLiveSubscriptions(topics.length > 0 ? [...topics, ALARMS_TOPIC] : []);
  const machineName = (id: string) => equipment.data?.find((item) => item.id === id)?.name ?? id;

  // Each card's shift bucket: the pushed one over the REST one (`pickBucket`), read here so the
  // section says its finality once (E-03).
  const cardKeys = cards.map(scopeKey);
  const cardReads = useQueries({
    queries: cards.map((scope) => ({
      queryKey: queryKeys.alarmKpi(scopeKey(scope), 'shift', range?.from ?? 0, range?.to ?? 0),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getAlarmKpi(
          { ...scope, bucket: 'shift', from: range?.from ?? 0, to: range?.to ?? 0 },
          signal,
        ),
      enabled: range !== undefined,
    })),
  });
  const cardPushed = useLiveAlarmKpis(cardKeys);
  const cardBuckets = cards.map((_, index) => {
    const pushed = cardPushed[index]?.shift;
    return pickBucket<AlarmKpiBucketDto>(
      cardReads[index]?.data?.buckets.find((candidate) => candidate.key === shiftKey),
      pushed && pushed.key === shiftKey ? pushed : undefined,
    );
  });
  const shownBuckets = cardBuckets.filter((b) => b !== undefined);
  const cardFinality = groupFinality(shownBuckets);

  const focusName = focus ? (focus.scope === 'equipment' ? machineName(focus.id) : focus.name) : '';

  return (
    <section aria-labelledby="alarm-kpi-title">
      <PageHeader
        id="alarm-kpi-title"
        title="Alarm KPIs"
        size="dashboard"
        description="The alarm load of each operator position and of the plant, by ISA-18.2 and EEMUA 191."
        filters={
          <ShiftPicker
            selection={selection}
            onChange={(key) => {
              void navigate({ search: (previous) => ({ ...previous, shift: key }) });
            }}
          />
        }
        summary={
          shift ? (
            <span data-testid="kpi-shift-span">
              <ShiftSpan start={shift.start} end={shift.end} />
              {live ? ' · live' : ''}
            </span>
          ) : undefined
        }
      />
      {selection.pending ? <Skeleton shape="card" label="Loading shifts…" /> : null}
      {selection.error ? (
        <QueryError what="the shifts" error={selection.error} onRetry={selection.retry} />
      ) : null}
      {scopes.isError ? (
        <QueryError
          what="the alarm scopes"
          error={scopes.error}
          onRetry={() => void scopes.refetch()}
        />
      ) : null}
      {!selection.pending && !selection.error && shiftKey !== undefined && !range ? (
        <Card padding="compact">
          <EmptyState
            icon="info"
            title={`No KPIs for ${shiftKeyLabel(shiftKey)}`}
            body="Choose a shift of the last week from the list."
          />
        </Card>
      ) : null}
      {!selection.pending && shiftKey === undefined && !selection.error ? (
        <Card padding="compact">
          <EmptyState
            icon="clock"
            title="No shift yet"
            body="No shift yet: the plant clock has not started."
          />
        </Card>
      ) : null}
      {range && shiftKey && scopes.isPending ? (
        <Skeleton shape="card" label="Loading the alarm scopes…" />
      ) : null}

      {range && shiftKey && scopes.data ? (
        <Section
          id="kpi-scopes-title"
          title="Plant and operator positions"
          status={<SectionFinality buckets={shownBuckets} testId="kpi-finality" />}
          description="Over the shift, exact as the MES computes them; every raise counts, shelved or not."
        >
          {cards.length === 0 ? (
            <Card padding="compact">
              <EmptyState icon="info" title="No alarm scopes yet" body="No equipment is seeded." />
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {cards.map((scope, index) => {
                const read = cardReads[index];
                return (
                  <ScopeTile
                    key={scopeKey(scope)}
                    scope={scope}
                    bucket={cardBuckets[index]}
                    read={{
                      isError: read?.isError ?? false,
                      error: read?.error,
                      loaded: read?.data !== undefined,
                      retry: () => void read?.refetch(),
                    }}
                    finality={cardFinality}
                    config={config}
                  />
                );
              })}
            </div>
          )}
        </Section>
      ) : null}

      {range && focus ? (
        <Section
          id="kpi-details-title"
          title={`Details: ${focusName}`}
          description="Per hour or shift, the flood episodes, the bad actors and the operator measures of one scope."
          actions={
            <>
              <Select
                label="Details for"
                inline
                name="focus"
                data-testid="kpi-focus"
                value={scopeKey(focus)}
                onChange={(event) => {
                  const value = event.target.value;
                  void navigate({ search: (previous) => ({ ...previous, focus: value }) });
                }}
              >
                {all.map((scope) => (
                  <option key={scopeKey(scope)} value={scopeKey(scope)}>
                    {scope.scope === 'equipment'
                      ? `Machine ${machineName(scope.id)}`
                      : scope.scope === 'position'
                        ? `Position ${scope.name}`
                        : scope.name}
                  </option>
                ))}
              </Select>
              <Select
                label="Buckets"
                inline
                name="bucket"
                data-testid="kpi-bucket"
                value={bucket}
                onChange={(event) => {
                  const value = event.target.value === 'shift' ? 'shift' : 'hour';
                  void navigate({ search: (previous) => ({ ...previous, bucket: value }) });
                }}
              >
                <option value="hour">Hours of the shift</option>
                <option value="shift">Shifts of the last week</option>
              </Select>
            </>
          }
        >
          <div className="flex flex-col gap-6">
            {bucket === 'hour' ? (
              <BucketTable scope={focus} bucket="hour" range={range} until={until} live={live} />
            ) : week === undefined ? (
              <Card padding="compact">
                <EmptyState
                  icon="clock"
                  title="No plant clock yet"
                  body="The shifts of the last week follow the plant clock."
                />
              </Card>
            ) : (
              <BucketTable
                scope={focus}
                bucket="shift"
                range={week}
                until={undefined}
                live={live}
              />
            )}
            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
              {/* Each in its own cell, so each section is the first of its kind (no top margin). */}
              <div className="min-w-0">
                <FloodTable scope={focus} range={range} live={live} name={machineName} />
              </div>
              <div className="min-w-0">
                <BadActorTable scope={focus} range={range} live={live} name={machineName} />
              </div>
            </div>
            <OperatorMeasures scope={focus} range={range} live={live} name={machineName} />
          </div>
        </Section>
      ) : null}
    </section>
  );
}
