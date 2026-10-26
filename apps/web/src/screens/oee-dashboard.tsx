import {
  DOWNTIME_TOPIC,
  type EquipmentDto,
  type OeeBucketDto,
  type Pareto,
} from '@shopfloor/contracts/mes-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { getOee, getPareto, getShiftOee, listEquipment, type OeeScope } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { EChart } from '../chart/echart.tsx';
import {
  hourlyOption,
  hourlyReading,
  paretoOption,
  paretoReading,
  waterfallOption,
  waterfallReading,
} from '../chart/oee-options.ts';
import { LossBadge } from '../components/loss-badge.tsx';
import {
  FlagBadges,
  NA_REASON,
  SectionFinality,
  groupFinality,
  itemFlags,
  ratioStat,
  type GroupFinality,
} from '../components/oee-ui.tsx';
import { QueryError } from '../components/query-error.tsx';
import { ShiftPicker, useShiftSelection } from '../components/shift-picker.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { Select } from '../components/ui/controls.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, Percent, PlantTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { KpiTile } from '../components/ui/stat.tsx';
import {
  NOT_APPLICABLE,
  bottleneckMachines,
  bucketFlags,
  minutesText,
  pickBucket,
  ratioText,
  secondsText,
  stepSign,
  waterfall,
  type WaterfallStep,
} from '../domain/oee.ts';
import { formatClockTime } from '../domain/time.ts';
import {
  useLiveDowntime,
  useLiveOee,
  useLiveOees,
  useLiveSubscriptions,
} from '../live/live-context.tsx';
import { LineOeeCard, useLineOee } from './line-oee.tsx';

const LIVE_REFRESH_MS = 30_000;
/** A downtime push (a new record, a recode) rereads the Pareto, at most this often. */
const PARETO_THROTTLE_MS = 2_000;

type BottleneckState = 'known' | 'loading' | 'unknown';

interface Names {
  readonly equipment: ReadonlyMap<string, EquipmentDto>;
  readonly workCenters: ReadonlyMap<string, { name: string; members: string[] }>;
}

function names(list: readonly EquipmentDto[]): Names {
  const equipment = new Map<string, EquipmentDto>();
  const workCenters = new Map<string, { name: string; members: string[] }>();
  for (const item of [...list].sort((a, b) => a.position - b.position)) {
    equipment.set(item.id, item);
    const center = workCenters.get(item.workCenter.id) ?? {
      name: item.workCenter.name,
      members: [],
    };
    center.members.push(item.id);
    workCenters.set(item.workCenter.id, center);
  }
  return { equipment, workCenters };
}

/** The pushed shift bucket over the REST one, when the clock is in this shift (`pickBucket`). */
function useShiftBucket(
  id: string,
  rest: OeeBucketDto | undefined,
  shiftKey: string,
): OeeBucketDto | undefined {
  const pushed = useLiveOee(id)?.shift;
  return pickBucket(rest, pushed?.key === shiftKey ? pushed : undefined);
}

/**
 * `useShiftBucket` for a whole section at once, in the order of `ids`: the section says its
 * finality once over the buckets it shows (E-03), and a table row's `data-oee` follows the push.
 */
function useShiftBuckets(
  ids: readonly string[],
  rest: readonly OeeBucketDto[],
  shiftKey: string,
): readonly (OeeBucketDto | undefined)[] {
  const pushed = useLiveOees(ids);
  return ids.map((id, index) => {
    const shift = pushed[index]?.shift;
    return pickBucket(
      rest.find((bucket) => bucket.id === id),
      shift?.key === shiftKey ? shift : undefined,
    );
  });
}

/** An availability loss in minutes (the dashboard's unit, as the waterfall and the Pareto). */
function LossMinutes({
  bucket,
  kind,
  testId,
}: {
  readonly bucket: OeeBucketDto;
  readonly kind: 'own' | 'external';
  readonly testId?: string;
}) {
  const losses = bucket.result.losses;
  if (!losses) return <Missing reason="No planned busy time, so no losses" testId={testId} />;
  return (
    <span data-testid={testId} className="tabular-nums">
      {minutesText(losses.availability[kind].total)}
    </span>
  );
}

interface CenterBottleneck {
  readonly equipment: EquipmentDto | undefined;
  readonly id: string;
  readonly products: readonly string[];
}

/** The MES's bottleneck in a work center, or that it is not known yet (#233 review). */
function CenterBottleneckNote({
  id,
  state,
  bottlenecks,
}: {
  readonly id: string;
  readonly state: BottleneckState;
  readonly bottlenecks: readonly CenterBottleneck[];
}) {
  const frame = 'rounded-md bg-surface-sunken px-3 py-2 text-sm text-ink';
  if (state !== 'known') {
    return (
      <p data-testid={`bottleneck-${id}`} data-state={state} className={frame}>
        <span className="font-semibold">Bottleneck:</span>{' '}
        {state === 'loading' ? 'loading…' : 'unknown (line OEE unavailable)'}
      </p>
    );
  }
  if (bottlenecks.length === 0) return null;
  return (
    <p
      data-testid={`bottleneck-${id}`}
      data-state="known"
      data-equipment={bottlenecks.map((b) => b.id).join(',')}
      className={frame}
    >
      <span className="font-semibold">Bottleneck:</span>{' '}
      {bottlenecks.map((b, index) => (
        <span key={b.id}>
          {index > 0 ? '; ' : ''}
          {b.equipment?.name ?? b.id} <Code className="whitespace-nowrap">{b.id}</Code> for{' '}
          {b.products.join(', ')}
        </span>
      ))}
      <span className="mt-0.5 block text-xs text-ink-secondary">
        As the MES derives it. A work center’s OEE is time-weighted over its machines, not line
        throughput: that is the line card.
      </span>
    </p>
  );
}

function WorkCenterTile({
  id,
  name,
  bucket,
  finality,
  bottlenecks,
  bottleneckState,
}: {
  readonly id: string;
  readonly name: string;
  readonly bucket: OeeBucketDto | undefined;
  readonly finality: GroupFinality | undefined;
  /** Whether the MES's bottleneck is known yet (#233 review). */
  readonly bottleneckState: BottleneckState;
  /** The MES's bottleneck machines in this work center, with their products (#233). */
  readonly bottlenecks: readonly CenterBottleneck[];
}) {
  const result = bucket?.result;
  const flags = bucket ? itemFlags(bucketFlags(bucket), finality) : [];
  return (
    <KpiTile
      title={name}
      testId={`oee-card-${id}`}
      data-oee={result ? ratioText(result.oee) : NOT_APPLICABLE}
      data-final={bucket ? String(bucket.final) : undefined}
      status={flags.length > 0 ? <FlagBadges flags={flags} /> : undefined}
      headline={
        result
          ? ratioStat('OEE', result.oee, NA_REASON.oee, `oee-value-${id}`)
          : { label: 'OEE', missing: 'No data for this shift' }
      }
      details={
        result
          ? [
              ratioStat('Availability', result.availability, NA_REASON.availability),
              ratioStat('Performance', result.performance, NA_REASON.performance),
              ratioStat('Quality', result.quality, NA_REASON.quality),
            ]
          : []
      }
    >
      {bucket && result ? (
        <p className="text-sm text-ink-secondary">
          Availability loss:{' '}
          <span className="text-ink">
            <LossMinutes bucket={bucket} kind="own" testId={`oee-own-${id}`} />
          </span>{' '}
          own ·{' '}
          <span className="text-ink">
            <LossMinutes bucket={bucket} kind="external" testId={`oee-external-${id}`} />
          </span>{' '}
          external
        </p>
      ) : null}
      <CenterBottleneckNote id={id} state={bottleneckState} bottlenecks={bottlenecks} />
    </KpiTile>
  );
}

interface MachineRow {
  readonly id: string;
  readonly bucket: OeeBucketDto;
  readonly equipment: EquipmentDto | undefined;
  readonly bottleneck: boolean;
}

/**
 * The machine table's columns (design system 4.5): the name names the row (`th`), so the
 * ratios are `td` 0 to 3 (the demo walkthrough reads `td` 1, the availability, by its
 * `data-decimal`); the status column only when a row has something of its own to say (E-03).
 */
function machineColumns(
  finality: GroupFinality | undefined,
  withStatus: boolean,
): readonly Column<MachineRow>[] {
  const ratio = (
    key: 'oee' | 'availability' | 'performance' | 'quality',
    header: string,
  ): Column<MachineRow> => ({
    key,
    header,
    numeric: true,
    cell: (row) => <Percent ratio={row.bucket.result[key]} na={NA_REASON[key]} />,
  });
  return [
    {
      key: 'machine',
      header: 'Machine',
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="font-medium">{row.equipment?.name ?? row.id}</span>
          <Code className="whitespace-nowrap text-ink-secondary">{row.id}</Code>
          {row.bottleneck ? (
            <Badge tone="neutral" variant="outline">
              Bottleneck
            </Badge>
          ) : null}
        </span>
      ),
    },
    ratio('oee', 'OEE'),
    ratio('availability', 'Availability'),
    ratio('performance', 'Performance'),
    ratio('quality', 'Quality'),
    {
      key: 'own',
      header: 'Own loss',
      numeric: true,
      cell: (row) => <LossMinutes bucket={row.bucket} kind="own" />,
    },
    {
      key: 'external',
      header: 'External loss',
      numeric: true,
      cell: (row) => <LossMinutes bucket={row.bucket} kind="external" />,
    },
    ...(withStatus
      ? [
          {
            key: 'status',
            header: 'Status',
            cell: (row: MachineRow) => {
              const flags = itemFlags(bucketFlags(row.bucket), finality);
              return flags.length > 0 ? (
                <FlagBadges flags={flags} />
              ) : (
                <Missing reason="Nothing beyond the section’s status" />
              );
            },
          },
        ]
      : []),
  ];
}

function MachineTable({
  rows,
  finality,
  bottleneckState,
}: {
  readonly rows: readonly MachineRow[];
  readonly finality: GroupFinality | undefined;
  readonly bottleneckState: BottleneckState;
}) {
  const withStatus = rows.some((row) => itemFlags(bucketFlags(row.bucket), finality).length > 0);
  const columns = useMemo(() => machineColumns(finality, withStatus), [finality, withStatus]);
  return (
    <div className="flex flex-col gap-2">
      {bottleneckState !== 'known' ? (
        <p
          className="text-sm text-ink-secondary"
          data-testid="machine-bottleneck-state"
          data-state={bottleneckState}
        >
          Bottleneck:{' '}
          {bottleneckState === 'loading' ? 'loading…' : 'unknown (line OEE unavailable)'}
        </p>
      ) : null}
      <DataTable
        caption="OEE per machine for the selected shift"
        testId="machine-oee-table"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        rowTestId={(row) => `oee-machine-${row.id}`}
        rowProps={(row) => ({ 'data-oee': ratioText(row.bucket.result.oee) })}
        narrow="stack"
        empty={
          <div className="px-4">
            <EmptyState size="inline" icon="info" title="No machine has data for this shift yet" />
          </div>
        }
      />
    </div>
  );
}

const HOUR_COLUMNS: readonly Column<OeeBucketDto>[] = [
  {
    key: 'hour',
    header: 'Hour',
    rowHeader: true,
    nowrap: true,
    cell: (hour) => (
      <time dateTime={hour.start} className="tabular-nums">
        {formatClockTime(hour.start)}
      </time>
    ),
  },
  {
    key: 'oee',
    header: 'OEE',
    numeric: true,
    cell: (hour) => <Percent ratio={hour.result.oee} na={NA_REASON.oee} />,
  },
  { key: 'status', header: 'Status', cell: (hour) => (hour.final ? 'Final' : 'Provisional') },
];

function HourlyChart({
  scope,
  id,
  shiftKey,
  start,
  end,
  live,
}: {
  readonly scope: OeeScope;
  readonly id: string;
  readonly shiftKey: string;
  readonly start: number;
  readonly end: number;
  readonly live: boolean;
}) {
  const hours = useQuery({
    queryKey: queryKeys.hourlyOee(id, shiftKey),
    queryFn: ({ signal }) => getOee({ scope, id, bucket: 'hour', from: start, to: end }, signal),
    refetchInterval: live ? LIVE_REFRESH_MS : false,
  });
  // Only the hour the clock is in is pushed; earlier hours come from REST, read again when the
  // clock moves into a new hour (live-cache).
  const pushed = useLiveOee(id)?.hour;
  // Built again only when the data changes: a new option redraws the chart (`notMerge`), which
  // drops an open tooltip, so an unrelated re-render must hand the chart the same option.
  const { rows, option } = useMemo(() => {
    const byKey = new Map((hours.data?.buckets ?? []).map((bucket) => [bucket.key, bucket]));
    if (pushed) {
      const at = Date.parse(pushed.start);
      const shown = at >= start && at < end ? pickBucket(byKey.get(pushed.key), pushed) : undefined;
      if (shown) byKey.set(shown.key, shown);
    }
    const sorted = [...byKey.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return {
      rows: sorted,
      option: sorted.some((hour) => hour.result.oee) ? hourlyOption(sorted) : null,
    };
  }, [hours.data, pushed, start, end]);
  return (
    <EChart
      testId="hourly"
      title="OEE per hour"
      description={`${hourlyReading(rows)}; the table below lists every value.`}
      option={option}
      empty={
        !hours.isSuccess
          ? undefined
          : rows.length === 0
            ? 'No hours with data yet.'
            : 'No planned time in this shift.'
      }
    >
      {hours.isError ? (
        <QueryError
          what="the hourly OEE"
          error={hours.error}
          onRetry={() => void hours.refetch()}
        />
      ) : null}
      {hours.isPending ? <Skeleton shape="chart" label="Loading hours…" /> : null}
      {rows.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="flex flex-wrap gap-x-4 text-xs text-ink-secondary">
            <span>
              <span aria-hidden="true" className="mr-1 inline-block size-2.5 bg-chart-1" />
              Final
            </span>
            <span>
              <span aria-hidden="true" className="mr-1 inline-block size-2.5 bg-line-strong" />
              Provisional
            </span>
            <span>No bar: no planned time in that hour</span>
          </p>
          <Disclosure summary="Hourly values">
            <DataTable
              caption="OEE per hour of the shift"
              testId="hourly-values"
              columns={HOUR_COLUMNS}
              rows={rows}
              rowKey={(hour) => hour.key}
              rowTestId={(hour) => `hour-${hour.key}`}
              density="compact"
            />
          </Disclosure>
        </div>
      ) : null}
    </EChart>
  );
}

/** A step's minutes with its sign against the number, as the chart writes it: "−93.1 min" (E-06). */
const stepText = (step: WaterfallStep): string => `${stepSign(step)}${minutesText(step.ms)}`;

const WATERFALL_COLUMNS: readonly Column<WaterfallStep>[] = [
  {
    key: 'step',
    header: 'Step',
    rowHeader: true,
    cell: (step) => (
      <span className={step.kind === 'total' ? 'font-semibold' : undefined}>{step.label}</span>
    ),
  },
  {
    key: 'time',
    header: 'Time',
    numeric: true,
    cell: (step) => (
      <span
        title={`${stepSign(step)}${secondsText(step.ms)} exactly`}
        data-seconds={secondsText(step.ms)}
        className={step.kind === 'total' ? 'font-semibold' : undefined}
      >
        {stepText(step)}
      </span>
    ),
  },
];

function WaterfallChart({ bucket }: { readonly bucket: OeeBucketDto | undefined }) {
  // Memoised on the bucket (see HourlyChart): the same option across unrelated re-renders.
  const { steps, option } = useMemo(() => {
    const found = bucket ? waterfall(bucket.result) : null;
    return { steps: found, option: found ? waterfallOption(found) : null };
  }, [bucket]);
  return (
    <EChart
      testId="waterfall"
      title="Loss waterfall"
      description={`${steps ? waterfallReading(steps) : 'Loss waterfall'}; the table below lists every step.`}
      option={option}
      empty={
        !bucket
          ? 'No data for this shift.'
          : 'No planned busy time in this shift, so there are no losses.'
      }
    >
      {steps ? (
        <div className="mt-2 flex flex-col gap-2">
          {!steps.consistent ? (
            <Callout tone="warn" role="alert">
              The losses sent do not add up; showing them as sent.
            </Callout>
          ) : null}
          <DataTable
            caption="Loss waterfall steps"
            testId="waterfall-steps"
            columns={WATERFALL_COLUMNS}
            rows={steps.steps}
            rowKey={(step) => step.key}
            rowTestId={(step) => `waterfall-${step.key}`}
            rowProps={(step) => ({ 'data-kind': step.kind })}
            density="compact"
          />
          <p className="text-xs text-ink-secondary">
            Minutes rounded to 0.1 (half-up); each step’s exact time is in its tooltip. The steps
            add up exactly.
          </p>
        </div>
      ) : null}
    </EChart>
  );
}

interface ParetoRow {
  readonly row: Pareto['reasons'][number];
  /** The cumulative share in whole per cent; undefined when the total is 0. */
  readonly cumulative: number | undefined;
}

/**
 * The Pareto's table. The reason is a plain `td`, not a row header: the demo walkthrough reads
 * the time as `td` 2.
 */
const PARETO_COLUMNS: readonly Column<ParetoRow>[] = [
  { key: 'reason', header: 'Reason', cell: ({ row }) => row.name },
  { key: 'loss', header: 'Loss', cell: ({ row }) => <LossBadge kind={row.loss} /> },
  { key: 'time', header: 'Time', numeric: true, cell: ({ row }) => minutesText(row.ms) },
  {
    key: 'cumulative',
    header: 'Cumulative',
    numeric: true,
    cell: ({ cumulative }) =>
      cumulative === undefined ? <Missing reason="No loss time" /> : `${String(cumulative)} %`,
  },
];

function ParetoTable({ pareto }: { readonly pareto: Pareto }) {
  const total = pareto.reasons.reduce((sum, row) => sum + row.ms, 0);
  const rows = pareto.reasons.map((row, index): ParetoRow => {
    const running = pareto.reasons.slice(0, index + 1).reduce((sum, r) => sum + r.ms, 0);
    return {
      row,
      cumulative: total > 0 ? Math.round((running * 100) / total) : undefined,
    };
  });
  return (
    <div className="flex flex-col gap-2">
      <DataTable
        caption="Availability loss by reason"
        testId="pareto-table"
        columns={PARETO_COLUMNS}
        rows={rows}
        rowKey={({ row }) => `${row.reason}-${row.loss}`}
        rowTestId={({ row }) => `pareto-${row.reason}`}
        density="compact"
        narrow="stack"
      />
      {pareto.microStops.length > 0 ? (
        <Disclosure summary="Micro-stops by cause (performance loss)">
          <ul className="flex flex-col gap-0.5">
            {pareto.microStops.map((row) => (
              <li key={row.cause ?? 'none'}>
                {row.cause ?? 'No cause'}:{' '}
                <span className="tabular-nums">{minutesText(row.ms)}</span> in{' '}
                <span className="tabular-nums">{row.stops}</span> stops
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}

function ParetoChart({
  scope,
  id,
  shiftKey,
  start,
  end,
  live,
}: {
  readonly scope: OeeScope;
  readonly id: string;
  readonly shiftKey: string;
  readonly start: number;
  readonly end: number;
  readonly live: boolean;
}) {
  const queryClient = useQueryClient();
  const pareto = useQuery({
    queryKey: queryKeys.pareto(id, shiftKey),
    queryFn: ({ signal }) => getPareto({ scope, id, from: start, to: end }, signal),
    refetchInterval: live ? LIVE_REFRESH_MS : false,
  });
  // A downtime push (created, closed, recoded) changes the Pareto: read it again, throttled.
  const seq = useLiveDowntime()?.seq;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (seq === undefined || timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void queryClient.invalidateQueries({ queryKey: queryKeys.paretoAll });
    }, PARETO_THROTTLE_MS);
  }, [seq, queryClient]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  // Memoised on the data (see HourlyChart): the same option across unrelated re-renders.
  const chart = useMemo(
    () => (pareto.data && pareto.data.reasons.length > 0 ? paretoOption(pareto.data) : null),
    [pareto.data],
  );
  return (
    <EChart
      testId="pareto"
      title="Downtime Pareto"
      description={`${pareto.data ? paretoReading(pareto.data) : 'Availability loss by reason'}; the table below lists every reason.`}
      option={chart?.option ?? null}
      height={chart?.height ?? 200}
      empty={pareto.data ? 'No availability loss in this shift.' : undefined}
    >
      {pareto.isPending ? <Skeleton shape="chart" label="Loading the Pareto…" /> : null}
      {pareto.isError ? (
        <QueryError what="the Pareto" error={pareto.error} onRetry={() => void pareto.refetch()} />
      ) : null}
      {pareto.data ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-sm text-ink-secondary">
            Availability loss:{' '}
            <span className="tabular-nums text-ink">
              {minutesText(pareto.data.availability.own)}
            </span>{' '}
            own ·{' '}
            <span className="tabular-nums text-ink">
              {minutesText(pareto.data.availability.external)}
            </span>{' '}
            external
          </p>
          {pareto.data.reasons.length === 0 ? null : <ParetoTable pareto={pareto.data} />}
        </div>
      ) : null}
    </EChart>
  );
}

function FocusPicker({
  focus,
  known,
  onChange,
}: {
  readonly focus: string;
  readonly known: Names;
  readonly onChange: (id: string) => void;
}) {
  return (
    <Select
      label="Details for"
      inline
      name="focus"
      data-testid="focus-select"
      value={focus}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {[...known.workCenters].map(([center, { name, members }]) => (
        <optgroup key={center} label={name}>
          <option value={center}>{name} (work center)</option>
          {members.map((member) => (
            <option key={member} value={member}>
              {known.equipment.get(member)?.name ?? member}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

function FocusDetails({
  focus,
  scope,
  shiftKey,
  start,
  end,
  live,
  rest,
}: {
  readonly focus: string;
  readonly scope: OeeScope;
  readonly shiftKey: string;
  readonly start: number;
  readonly end: number;
  readonly live: boolean;
  readonly rest: OeeBucketDto | undefined;
}) {
  const bucket = useShiftBucket(focus, rest, shiftKey);
  return (
    // Each chart card as tall as its own content (E-05: the hourly card was stretched to the
    // waterfall's height and stood half empty).
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <HourlyChart
        scope={scope}
        id={focus}
        shiftKey={shiftKey}
        start={start}
        end={end}
        live={live}
      />
      <WaterfallChart bucket={bucket} />
      <div className="lg:col-span-2">
        <ParetoChart
          scope={scope}
          id={focus}
          shiftKey={shiftKey}
          start={start}
          end={end}
          live={live}
        />
      </div>
    </div>
  );
}

/**
 * The OEE dashboard (UX-3, #323; design system section 10): the line's throughput OEE, then each
 * work center's OEE as a KPI tile, the machines in a table, and the hours, losses and downtime of
 * one of them. Ratios are percentages; each keeps the MES's four decimals in `data-decimal` and
 * the exact fraction in `data-fraction` and its tooltip (E-02). Finality is said once per
 * section (E-03).
 */
export function OeeDashboard() {
  const search = useSearch({ from: '/oee' });
  const navigate = useNavigate({ from: '/oee' });
  const selection = useShiftSelection(search.shift);
  const shiftKey = selection.selected;
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const known = names(equipment.data ?? []);
  const shiftOee = useQuery({
    queryKey: queryKeys.shiftOee(shiftKey ?? ''),
    queryFn: ({ signal }) => getShiftOee(shiftKey ?? '', signal),
    enabled: shiftKey !== undefined,
    refetchInterval: selection.isCurrent ? LIVE_REFRESH_MS : false,
  });

  // Live: every work center and machine (8 of the MES's 16 OEE topics) and downtime records;
  // `oee:line` (useLineOee) counts against a budget of its own (#232).
  const centerIds = [...known.workCenters.keys()];
  const topics = [...centerIds, ...known.equipment.keys()].map((id) => `oee:${id}`);
  useLiveSubscriptions(topics.length > 0 ? [...topics, DOWNTIME_TOPIC] : []);

  const firstCenter = centerIds[0];
  const focus =
    search.focus !== undefined &&
    (known.workCenters.has(search.focus) || known.equipment.has(search.focus))
      ? search.focus
      : firstCenter;
  const scope: OeeScope =
    focus !== undefined && known.workCenters.has(focus) ? 'work-center' : 'equipment';
  const data = shiftOee.data;
  const line = useLineOee(
    data ? shiftKey : undefined,
    data ? { start: Date.parse(data.start), end: Date.parse(data.end) } : undefined,
    selection.isCurrent,
  );
  const bottlenecks = bottleneckMachines(line.bottlenecks);
  const focusRest = data
    ? [...data.workCenters, ...data.equipment].find((bucket) => bucket.id === focus)
    : undefined;

  const centerBuckets = useShiftBuckets(centerIds, data?.workCenters ?? [], shiftKey ?? '');
  const machineIds = (data?.equipment ?? []).map((bucket) => bucket.id);
  const machineBuckets = useShiftBuckets(machineIds, data?.equipment ?? [], shiftKey ?? '');
  const shownCenters = centerBuckets.filter((bucket) => bucket !== undefined);
  const centerFinality = groupFinality(shownCenters);
  const machineRows: MachineRow[] = (data?.equipment ?? []).map((rest, index) => ({
    id: rest.id,
    bucket: machineBuckets[index] ?? rest,
    equipment: known.equipment.get(rest.id),
    bottleneck: bottlenecks.has(rest.id),
  }));
  const machineFinality = groupFinality(machineRows.map((row) => row.bucket));

  return (
    <section aria-labelledby="oee-title">
      <PageHeader
        id="oee-title"
        title="OEE"
        size="dashboard"
        description="Overall equipment effectiveness of one shift: the line, its work centers and machines, and where the time went."
        filters={
          <ShiftPicker
            selection={selection}
            onChange={(shift) => {
              void navigate({ search: (previous) => ({ ...previous, shift }) });
            }}
          />
        }
        summary={
          data ? (
            <span data-testid="oee-shift-span">
              <PlantTime at={data.start} seconds={false} /> to{' '}
              <PlantTime at={data.end} seconds={false} />
              {selection.isCurrent ? ' · live' : ''}
            </span>
          ) : undefined
        }
      />
      {selection.pending ? <Skeleton shape="card" label="Loading shifts…" /> : null}
      {selection.error ? (
        <QueryError what="the shifts" error={selection.error} onRetry={selection.retry} />
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
      {equipment.isError ? (
        <QueryError
          what="the equipment"
          error={equipment.error}
          onRetry={() => void equipment.refetch()}
        />
      ) : null}
      {shiftOee.isError ? (
        <QueryError
          what="the shift's OEE"
          error={shiftOee.error}
          onRetry={() => void shiftOee.refetch()}
        />
      ) : null}
      {shiftOee.isPending && shiftKey !== undefined ? (
        <Skeleton shape="card" label="Loading OEE…" />
      ) : null}

      {data && shiftKey !== undefined ? (
        <>
          <Section id="line-title" title="Line">
            <LineOeeCard view={line} equipment={known.equipment} />
          </Section>
          <Section
            id="wc-title"
            title="Work centers"
            status={<SectionFinality buckets={shownCenters} testId="wc-finality" />}
            description="Each one’s OEE, time-weighted over its machines, with availability, performance and quality."
          >
            {centerIds.length === 0 ? (
              <Card padding="compact">
                <EmptyState
                  icon="info"
                  title="No work centers yet"
                  body="No equipment is seeded."
                />
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {[...known.workCenters].map(([center, { name, members }], index) => (
                  <WorkCenterTile
                    key={center}
                    id={center}
                    name={name}
                    bucket={centerBuckets[index]}
                    finality={centerFinality}
                    bottleneckState={line.bottleneckState}
                    bottlenecks={members.flatMap((member) => {
                      const products = bottlenecks.get(member);
                      return products
                        ? [{ id: member, equipment: known.equipment.get(member), products }]
                        : [];
                    })}
                  />
                ))}
              </div>
            )}
          </Section>
          <Section
            id="machines-title"
            title="Machines"
            status={
              <SectionFinality
                buckets={machineRows.map((row) => row.bucket)}
                testId="machine-finality"
              />
            }
            description="Each machine’s OEE for the shift; losses are availability losses."
          >
            <MachineTable
              rows={machineRows}
              finality={machineFinality}
              bottleneckState={line.bottleneckState}
            />
          </Section>
          {focus !== undefined ? (
            <Section
              id="details-title"
              title="Hours, losses and downtime"
              description="Per hour, the loss waterfall and the downtime Pareto of one work center or machine."
              actions={
                <FocusPicker
                  focus={focus}
                  known={known}
                  onChange={(id) => {
                    void navigate({ search: (previous) => ({ ...previous, focus: id }) });
                  }}
                />
              }
            >
              <FocusDetails
                key={`${focus}|${shiftKey}`}
                focus={focus}
                scope={scope}
                shiftKey={shiftKey}
                start={Date.parse(data.start)}
                end={Date.parse(data.end)}
                live={selection.isCurrent}
                rest={focusRest}
              />
            </Section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
