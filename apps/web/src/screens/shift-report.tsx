import {
  DOWNTIME_TOPIC,
  type AlarmKpiBucketDto,
  type EquipmentDto,
  type OeeBucketDto,
  type ShiftReportDto,
} from '@shopfloor/contracts/mes-api';
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  ApiError,
  getReasonCodes,
  getShiftReport,
  listEquipment,
  shiftReportUrl,
  type ShiftRef,
} from '../api/client.ts';
import { queryKeys, useAlarmConfig } from '../api/queries.ts';
import { EChart } from '../chart/echart.tsx';
import { paretoOption, paretoReading } from '../chart/oee-options.ts';
import { FinalityBadge } from '../components/finality-badge.tsx';
import { LossBadge } from '../components/loss-badge.tsx';
import { ShiftStateBadge } from '../components/shift-state-badge.tsx';
import {
  FlagBadges,
  NA_REASON,
  SectionFinality,
  groupFinality,
  itemFlags,
  type GroupFinality,
} from '../components/oee-ui.tsx';
import { QueryError } from '../components/query-error.tsx';
import {
  ScreenError,
  queryRead,
  useScreenErrors,
  type ScreenErrors,
} from '../components/screen-error.tsx';
import {
  ShiftPicker,
  ShiftSpan,
  shiftKeyLabel,
  useShiftSelection,
  type ShiftSelection,
} from '../components/shift-picker.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button, buttonClass } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { DescriptionList, type Fact } from '../components/ui/description-list.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, Percent, PlantTime, Ratio, WallTime } from '../components/ui/format.tsx';
import { Icon } from '../components/ui/icons.tsx';
import { NotFound } from '../components/ui/not-found.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { SectionNav, type SectionNavItem } from '../components/ui/section-nav.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { KpiTile, Stat } from '../components/ui/stat.tsx';
import {
  alarmBucketFlags,
  meanTimeToAck,
  msText,
  rateBand,
  RATE_VERDICT,
  rateBandText,
  scopeKey,
  windowLabel,
} from '../domain/alarms.ts';
import { reasonName } from '../domain/downtime.ts';
import { NOT_APPLICABLE, bucketFlags, minutesText, ratioText } from '../domain/oee.ts';
import {
  changesAfterFinal,
  instanceKey,
  isNewerShift,
  liveAlarmKpi,
  liveOee,
  production,
  revisionText,
} from '../domain/shifts.ts';
import { CREW_END_LABELS } from '../domain/terminal.ts';
import { liveKeys, type LiveAlarmKpi, type LiveOee } from '../live/live-cache.ts';
import {
  useLiveDowntime,
  useLiveShifts,
  useLiveSubscriptions,
  useShiftsTopic,
} from '../live/live-context.tsx';
import { HandoverNotes, NOTES_READ, useShiftNotesRead } from './handover-notes.tsx';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHIFT = /^[A-Za-z0-9_-]{1,16}$/;

/** `plant` → `plant`, `position:cell-m1` → `position-cell-m1` (test ids). */
const testKey = (key: string): string => key.replace(':', '-');

/** How often an ended report is read again at most while downtime pushes arrive. */
const ENDED_REREAD_MS = 5_000;

const BACK = { label: 'Shift reports', link: { to: '/shifts' } } as const;

/**
 * The report's sections in reading order (R-01): the in-page index links to their headings' ids,
 * which are the ids the sections had before.
 */
const SECTIONS: readonly SectionNavItem[] = [
  { id: 'report-oee-title', label: 'OEE' },
  { id: 'report-production-title', label: 'Production' },
  { id: 'report-downtime-title', label: 'Downtime' },
  { id: 'report-alarms-title', label: 'Alarms' },
  { id: 'report-crew-title', label: 'Crew' },
  { id: 'handover-title', label: 'Handover notes' },
];

/** Reads `queryKey` again after `trigger` changes (not on mount), at most every `ENDED_REREAD_MS`. */
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
    }, ENDED_REREAD_MS);
  }, [trigger, key, enabled, queryClient]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
}

/** A figure pushed while the shift runs, newer than the report read; not printed. */
function LiveBadge({ live }: { readonly live: boolean }) {
  if (!live) return null;
  return (
    <span className="print:hidden" title="Pushed while the shift runs; newer than the report read">
      <Badge tone="neutral" variant="outline" data-live="true">
        Live
      </Badge>
    </span>
  );
}

// ---- Live numbers ----

/** The pushed OEE pairs of several topics (`['live', 'oee', id]`), by id. */
function useLiveOeeMap(ids: readonly string[]): ReadonlyMap<string, LiveOee | undefined> {
  const results = useQueries({
    queries: ids.map((id) => ({ queryKey: liveKeys.oee(id), queryFn: skipToken })),
  });
  return new Map(ids.map((id, index) => [id, results[index]?.data as LiveOee | undefined]));
}

function useLiveAlarmKpiMap(
  keys: readonly string[],
): ReadonlyMap<string, LiveAlarmKpi | undefined> {
  const results = useQueries({
    queries: keys.map((key) => ({ queryKey: liveKeys.alarmKpi(key), queryFn: skipToken })),
  });
  return new Map(keys.map((key, index) => [key, results[index]?.data as LiveAlarmKpi | undefined]));
}

interface LineOrder {
  readonly machines: readonly string[];
  readonly workCenters: readonly { readonly id: string; readonly name: string }[];
  readonly names: ReadonlyMap<string, string>;
}

/** Machines and work centers in line order: master data, with what the report has added. */
function lineOrder(
  report: ShiftReportDto,
  equipment: readonly EquipmentDto[] | undefined,
): LineOrder {
  const sorted = [...(equipment ?? [])].sort((a, b) => a.position - b.position);
  const names = new Map<string, string>();
  const machines: string[] = [];
  const centers: { id: string; name: string }[] = [];
  for (const item of sorted) {
    names.set(item.id, item.name);
    machines.push(item.id);
    if (!centers.some((center) => center.id === item.workCenter.id)) {
      centers.push({ id: item.workCenter.id, name: item.workCenter.name });
      names.set(item.workCenter.id, item.workCenter.name);
    }
  }
  for (const bucket of report.oee.equipment) {
    if (!machines.includes(bucket.id)) machines.push(bucket.id);
  }
  for (const bucket of report.oee.workCenters) {
    if (!centers.some((center) => center.id === bucket.id)) {
      centers.push({ id: bucket.id, name: bucket.id });
    }
  }
  return { machines, workCenters: centers, names };
}

/** A name with its code beside it in `ink-secondary` (design system 6.4); the code alone when unnamed. */
function NamedCode({ name, code }: { readonly name: string | undefined; readonly code: string }) {
  if (name === undefined || name === code) return <Code className="whitespace-nowrap">{code}</Code>;
  return (
    <>
      {name} <Code className="whitespace-nowrap text-ink-secondary">{code}</Code>
    </>
  );
}

// ---- Header ----

/** The key facts under the title (design system 3.3 `meta`): "label value" pairs that wrap. */
function ReportFacts({ report }: { readonly report: ShiftReportDto }) {
  const pair = 'flex flex-wrap items-baseline gap-x-1.5';
  const term = 'text-ink-secondary';
  return (
    <dl
      data-testid="report-summary"
      className="flex flex-wrap gap-x-6 gap-y-1 print:gap-x-4"
      aria-label="Report facts"
    >
      <div className={pair}>
        <dt className={term}>Revision</dt>
        <dd
          data-testid="report-revision"
          data-inputs={String(report.revision.inputs)}
          data-content={String(report.revision.content)}
          className="tabular-nums"
        >
          {revisionText(report)}
        </dd>
      </div>
      <div className={pair}>
        <dt className={term}>Incidents</dt>
        <dd data-testid="report-incidents" className="tabular-nums">
          {report.incidents}
        </dd>
      </div>
      <div className={pair}>
        <dt className={term}>As of</dt>
        <dd data-testid="report-as-of">
          {report.asOf ? (
            <PlantTime at={report.asOf} />
          ) : (
            <span className="text-ink-secondary">No plant clock yet</span>
          )}
        </dd>
      </div>
      {report.final && report.finalAt ? (
        <div className={pair}>
          <dt className={term}>Final since</dt>
          <dd data-testid="report-final-at">
            <WallTime at={report.finalAt} />
          </dd>
        </div>
      ) : null}
      <div className={pair}>
        <dt className={term}>Generated</dt>
        <dd data-testid="report-generated-at">
          <WallTime at={report.generatedAt} />
        </dd>
      </div>
      {/* The plant run's epoch identifies the instance on screen; never printed (R-05). */}
      <div className={`${pair} print:hidden`}>
        <dt className={term}>Plant epoch</dt>
        <dd data-testid="report-epoch" className="tabular-nums">
          {report.epoch}
        </dd>
      </div>
    </dl>
  );
}

/** The changes after final (#163), said once under the header. */
function RevisedNote({ report }: { readonly report: ShiftReportDto }) {
  const changes = changesAfterFinal(report);
  if (changes === undefined || (changes.inputs === 0 && changes.content === 0)) return null;
  return (
    <Callout
      tone="info"
      role="status"
      data-testid="report-revised"
      data-inputs={String(changes.inputs)}
      data-content={String(changes.content)}
      title="This report changed after it became final."
      className="mb-4 print:border-line-strong print:bg-surface"
    >
      <p>
        {changes.inputs > 0
          ? `${String(changes.inputs)} input revision${changes.inputs === 1 ? '' : 's'} (late OEE or alarm data)`
          : 'No input revision'}
        {'; '}
        {changes.content > 0
          ? `${String(changes.content)} content change${changes.content === 1 ? '' : 's'} (handover notes, downtime recodes or acknowledgements)`
          : 'no content change'}
        .
      </p>
    </Callout>
  );
}

/** What a running or ended report's figures are (R-04: a line of its own, not in the actions). */
function FreshnessNote({ report }: { readonly report: ShiftReportDto }) {
  if (report.status === 'running') {
    return (
      <Callout tone="neutral" data-testid="report-live-note" className="mb-4 print:hidden">
        Live: OEE, production and alarm KPIs follow the plant; downtime, bad actors and operator
        figures are as of the time above.
      </Callout>
    );
  }
  if (report.status === 'ended') {
    return (
      <Callout tone="neutral" data-testid="report-ended-note" className="mb-4 print:hidden">
        Ended, not final yet: the values are as of the time above. The report is read again when a
        downtime record changes and when it becomes final.
      </Callout>
    );
  }
  return null;
}

function ReportActions({
  report,
  shift,
  refreshing,
  onRefresh,
}: {
  readonly report: ShiftReportDto;
  readonly shift: ShiftRef;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex w-full flex-wrap gap-2 *:max-md:flex-1 print:hidden" data-print="hidden">
      <Button
        data-testid="print-report"
        icon="print"
        onClick={() => {
          window.print();
        }}
      >
        Print
      </Button>
      <a
        data-testid="download-report"
        href={shiftReportUrl({ ...shift, epoch: report.epoch })}
        download={`shift-report-${report.date}-${report.shift}-epoch-${String(report.epoch)}.json`}
        className={buttonClass({ variant: 'secondary' })}
      >
        <Icon name="download" size={16} />
        Download JSON
      </a>
      <Button data-testid="refresh-report" loading={refreshing} onClick={onRefresh}>
        Read again
      </Button>
    </div>
  );
}

// ---- OEE ----

interface OeeRow {
  readonly id: string;
  readonly name: string | undefined;
  readonly kind: 'wc' | 'machine';
  readonly bucket: OeeBucketDto | undefined;
  readonly live: boolean;
}

const NO_DATA = 'No data for this shift';

/** An availability loss in minutes, or why there is none. */
function LossCell({ row, kind }: { readonly row: OeeRow; readonly kind: 'own' | 'external' }) {
  const result = row.bucket?.result;
  if (!result) return <Missing reason={NO_DATA} />;
  if (!result.losses) return <Missing reason="No planned busy time, so no losses" />;
  return <>{minutesText(result.losses.availability[kind].total)}</>;
}

/**
 * The OEE tables' columns (R-02: ratios as percentages, as on the OEE dashboard; the MES's four
 * decimals in `data-decimal`, the fraction in the tooltip): the name names the row; a status
 * column only when a row has something beyond the section's finality (E-03).
 */
function oeeColumns(
  finality: GroupFinality | undefined,
  withStatus: boolean,
  header: string,
): readonly Column<OeeRow>[] {
  const ratio = (
    key: 'oee' | 'availability' | 'performance' | 'quality',
    title: string,
  ): Column<OeeRow> => ({
    key,
    header: title,
    numeric: true,
    cell: (row) => (
      <Percent
        ratio={row.bucket?.result[key]}
        na={row.bucket ? NA_REASON[key] : NO_DATA}
        className={key === 'oee' ? 'font-semibold' : undefined}
      />
    ),
  });
  return [
    {
      key: 'name',
      header,
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="font-medium">
            {row.kind === 'machine' ? <NamedCode name={row.name} code={row.id} /> : row.name}
          </span>
          <LiveBadge live={row.live} />
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
      cell: (row) => <LossCell row={row} kind="own" />,
    },
    {
      key: 'external',
      header: 'External loss',
      numeric: true,
      cell: (row) => <LossCell row={row} kind="external" />,
    },
    ...(withStatus
      ? [
          {
            key: 'status',
            header: 'Status',
            cell: (row: OeeRow) => {
              const flags = row.bucket ? itemFlags(bucketFlags(row.bucket), finality) : [];
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

function OeeTable({
  rows,
  finality,
  header,
  caption,
  testId,
}: {
  readonly rows: readonly OeeRow[];
  readonly finality: GroupFinality | undefined;
  readonly header: string;
  readonly caption: string;
  readonly testId: string;
}) {
  const withStatus = rows.some(
    (row) => row.bucket !== undefined && itemFlags(bucketFlags(row.bucket), finality).length > 0,
  );
  const columns = useMemo(
    () => oeeColumns(finality, withStatus, header),
    [finality, withStatus, header],
  );
  return (
    <DataTable
      caption={caption}
      testId={testId}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      rowTestId={(row) => `report-oee-${row.kind}-${row.id}`}
      rowProps={(row) => ({
        'data-oee': row.bucket ? ratioText(row.bucket.result.oee) : NOT_APPLICABLE,
        'data-final': row.bucket ? String(row.bucket.final) : undefined,
        'data-live': String(row.live),
      })}
      density="compact"
      narrow="stack"
    />
  );
}

type BucketOf = (id: string) => { bucket: OeeBucketDto | undefined; live: boolean };

function OeeSection({
  report,
  order,
  bucketOf,
  centerOf,
}: {
  readonly report: ShiftReportDto;
  readonly order: LineOrder;
  readonly bucketOf: BucketOf;
  readonly centerOf: BucketOf;
}) {
  const centers: OeeRow[] = order.workCenters.map((center) => ({
    id: center.id,
    name: center.name,
    kind: 'wc',
    ...centerOf(center.id),
  }));
  const machines: OeeRow[] = order.machines.map((id) => ({
    id,
    name: order.names.get(id),
    kind: 'machine',
    ...bucketOf(id),
  }));
  const buckets = [...centers, ...machines].flatMap((row) => (row.bucket ? [row.bucket] : []));
  const finality = groupFinality(buckets);
  const empty = report.oee.equipment.length === 0 && report.oee.workCenters.length === 0;
  return (
    <Section
      id="report-oee-title"
      title="OEE"
      testId="report-oee"
      className="report-section"
      status={<SectionFinality buckets={buckets} testId="report-oee-finality" />}
      description="Each work center’s and machine’s OEE for the shift; losses are availability losses."
    >
      {empty ? (
        <Card padding="compact">
          <EmptyState
            size="inline"
            icon="info"
            title="No OEE data in this shift"
            testId="report-oee-empty"
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <OeeTable
            rows={centers}
            finality={finality}
            header="Work center"
            caption="OEE per work center for the shift"
            testId="report-oee-work-centers"
          />
          <OeeTable
            rows={machines}
            finality={finality}
            header="Machine"
            caption="OEE per machine for the shift"
            testId="report-oee-machines"
          />
        </div>
      )}
    </Section>
  );
}

// ---- Production ----

interface ProductionRow {
  readonly equipment: string;
  readonly produced: number;
  readonly good: number;
  readonly scrap: number;
  readonly rework: number;
  readonly live: boolean;
}

function productionColumns(names: ReadonlyMap<string, string>): readonly Column<ProductionRow>[] {
  const count = (key: 'produced' | 'good' | 'scrap' | 'rework', header: string) => ({
    key,
    header,
    numeric: true,
    cell: (row: ProductionRow) => row[key],
  });
  return [
    {
      key: 'machine',
      header: 'Machine',
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span>
            <NamedCode name={names.get(row.equipment)} code={row.equipment} />
          </span>
          <LiveBadge live={row.live} />
        </span>
      ),
    },
    count('produced', 'Produced'),
    count('good', 'Good'),
    count('scrap', 'Scrap'),
    count('rework', 'Rework'),
  ];
}

function ProductionSection({
  report,
  order,
  bucketOf,
}: {
  readonly report: ShiftReportDto;
  readonly order: LineOrder;
  readonly bucketOf: BucketOf;
}) {
  const shown = production(report, order.machines, bucketOf);
  const finishedBy = shown.finished.equipment;
  return (
    <Section
      id="report-production-title"
      title="Production"
      testId="report-production"
      data-live={String(shown.live)}
      className="report-section"
      description="Cycles per machine in the shift; finished parts are the good ones of the line’s last machine."
    >
      <div className="flex flex-col gap-4">
        <Card padding="compact">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Finished parts"
              value={
                <span
                  data-testid="report-finished"
                  data-good={
                    shown.finished.good === null ? NOT_APPLICABLE : String(shown.finished.good)
                  }
                >
                  {shown.finished.good ?? <Missing reason="No last machine in the line" />}
                </span>
              }
              hint={finishedBy ? `Good of ${order.names.get(finishedBy) ?? finishedBy}` : undefined}
            />
            <Stat
              label="Scrap, all machines"
              value={<span data-testid="report-scrap-total">{shown.scrap}</span>}
            />
          </div>
        </Card>
        <DataTable
          caption="Cycles per machine in the shift"
          testId="report-production-machines"
          columns={productionColumns(order.names)}
          rows={shown.machines}
          rowKey={(row) => row.equipment}
          rowTestId={(row) => `report-production-${row.equipment}`}
          rowProps={(row) => ({
            'data-produced': String(row.produced),
            'data-good': String(row.good),
            'data-scrap': String(row.scrap),
            'data-rework': String(row.rework),
            'data-live': String(row.live),
          })}
          density="compact"
          empty={<EmptyState size="inline" icon="info" title="No cycles in this shift" />}
        />
      </div>
    </Section>
  );
}

// ---- Downtime ----

type Reason = ShiftReportDto['downtime']['reasons'][number];
type Longest = ShiftReportDto['downtime']['longest'][number];

/** The reason is a plain cell, as in the OEE dashboard's Pareto table. */
const PARETO_COLUMNS: readonly Column<Reason>[] = [
  { key: 'reason', header: 'Reason', cell: (row) => row.name },
  { key: 'loss', header: 'Loss', cell: (row) => <LossBadge kind={row.loss} /> },
  { key: 'time', header: 'Time', numeric: true, cell: (row) => minutesText(row.ms) },
  { key: 'records', header: 'Records', numeric: true, cell: (row) => row.records },
];

function longestColumns(
  names: ReadonlyMap<string, string>,
  reasons: Parameters<typeof reasonName>[0],
): readonly Column<Longest>[] {
  return [
    {
      key: 'machine',
      header: 'Machine',
      rowHeader: true,
      cell: (record) => <NamedCode name={names.get(record.equipment)} code={record.equipment} />,
    },
    {
      key: 'start',
      header: 'Start',
      nowrap: true,
      cell: (record) => <PlantTime at={record.start} />,
    },
    {
      key: 'end',
      header: 'End',
      nowrap: true,
      cell: (record) =>
        record.end ? (
          <PlantTime at={record.end} />
        ) : (
          <Badge tone="neutral" variant="outline">
            Open
          </Badge>
        ),
    },
    { key: 'length', header: 'Length', numeric: true, cell: (record) => minutesText(record.ms) },
    {
      key: 'state',
      header: 'State',
      priority: 2,
      cell: (record) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {record.state} <LossBadge kind={record.loss} />
        </span>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (record) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {reasonName(reasons, record.reason)}
          {record.uncoded ? (
            <Badge tone="warn" variant="soft">
              Uncoded
            </Badge>
          ) : null}
          {record.provisional ? (
            <Badge tone="neutral" variant="dashed">
              Provisional
            </Badge>
          ) : null}
        </span>
      ),
    },
  ];
}

function DowntimeSection({
  report,
  reasons,
  names,
}: {
  readonly report: ShiftReportDto;
  readonly reasons: Parameters<typeof reasonName>[0];
  readonly names: ReadonlyMap<string, string>;
}) {
  const { downtime } = report;
  // Memoised on the reasons: the same option across unrelated re-renders (a new one redraws the
  // chart and drops an open tooltip).
  const pareto = useMemo(
    () => (downtime.reasons.length > 0 ? paretoOption({ reasons: downtime.reasons }) : null),
    [downtime.reasons],
  );
  return (
    <Section
      id="report-downtime-title"
      title="Downtime"
      testId="report-downtime"
      className="report-section"
      description="Availability losses by reason and the longest downtime records of the shift."
    >
      <div className="flex flex-col gap-4">
        <Card padding="compact">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Availability loss, own"
              value={
                <span data-testid="report-loss-own">{minutesText(downtime.availability.own)}</span>
              }
            />
            <Stat
              label="Availability loss, external"
              value={
                <span data-testid="report-loss-external">
                  {minutesText(downtime.availability.external)}
                </span>
              }
            />
            <Stat
              label="Downtime records"
              value={<span data-testid="report-records">{downtime.records}</span>}
            />
            <Stat
              label="Still uncoded"
              tone={downtime.uncodedMs > 0 ? 'warn' : undefined}
              value={
                <span data-testid="report-uncoded" data-ms={String(downtime.uncodedMs)}>
                  {minutesText(downtime.uncodedMs)}
                </span>
              }
              hint={
                downtime.uncodedMs > 0 ? (
                  <Link
                    to="/downtime"
                    search={{ shift: report.key, uncoded: true }}
                    className="text-link underline underline-offset-2 hover:text-accent-hover print:hidden"
                  >
                    Code them
                  </Link>
                ) : undefined
              }
            />
          </div>
        </Card>
        {pareto ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 print:block">
            <EChart
              testId="report-pareto-chart"
              title="Availability loss by reason"
              description={`${paretoReading({ reasons: downtime.reasons })}; the table lists every value.`}
              option={pareto.option}
              height={pareto.height}
            />
            <div className="flex min-w-0 flex-col gap-3 print:mt-3">
              <DataTable
                caption="Availability loss by reason, largest first"
                testId="report-pareto"
                columns={PARETO_COLUMNS}
                rows={downtime.reasons}
                rowKey={(row) => `${row.reason}/${row.loss}`}
                rowTestId={(row) => `report-pareto-${row.reason}`}
                rowProps={(row) => ({ 'data-ms': String(row.ms) })}
                density="compact"
                narrow="stack"
              />
              {downtime.microStops.length > 0 ? (
                <Section level={4} title="Micro-stops by cause (performance loss)">
                  <ul className="flex flex-col gap-0.5 text-sm" data-testid="report-micro-stops">
                    {downtime.microStops.map((row) => (
                      <li key={row.cause ?? 'none'}>
                        {row.cause ?? 'No cause'}:{' '}
                        <span className="tabular-nums">{minutesText(row.ms)}</span> in{' '}
                        <span className="tabular-nums">{row.stops}</span> stops
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>
          </div>
        ) : (
          <Card padding="compact">
            <EmptyState
              size="inline"
              icon="info"
              title="No availability loss in this shift"
              testId="report-pareto-empty"
            />
          </Card>
        )}
        <Section
          level={3}
          title="Longest downtime records"
          description="The ten longest, longest first."
        >
          <DataTable
            caption="The ten longest downtime records, longest first"
            testId="report-longest"
            columns={longestColumns(names, reasons)}
            rows={downtime.longest}
            rowKey={(record) => record.id}
            rowTestId={(record) => `report-longest-${record.id}`}
            rowProps={(record) => ({
              'data-reason': record.reason,
              'data-uncoded': String(record.uncoded),
            })}
            density="compact"
            narrow="stack"
            empty={
              <EmptyState size="inline" icon="info" title="No downtime record in this shift" />
            }
          />
        </Section>
      </div>
    </Section>
  );
}

// ---- Alarms ----

/** A measure as a fact whose `dd` carries `data-measure` (the tests read it, #295), as on Alarm KPIs. */
const measure = (name: string, term: string, detail: ReactNode): Fact => ({
  id: name,
  term,
  detail,
  detailData: { 'data-measure': name },
});

type AlarmScope = ShiftReportDto['alarms']['scopes'][number];

/** The measures under the headline, the raises and the peak (K-01), as on Alarm KPIs. */
function kpiFacts(bucket: AlarmKpiBucketDto): Fact[] {
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

const NO_ACK = 'No acknowledgement in this shift';

/** A time to acknowledge without any: the dash with its reason as visible text, as on Alarm KPIs. */
function NoAck() {
  return (
    <span className="flex flex-col">
      <Missing reason={NO_ACK} reasonShown />
      <span className="text-xs text-ink-secondary">{NO_ACK}</span>
    </span>
  );
}

function operatorFacts(operator: NonNullable<AlarmScope['operator']>): Fact[] {
  return [
    measure('annunciated', 'Annunciated raises', String(operator.annunciatedRaises)),
    measure('shelved-raises', 'Raises while shelved', String(operator.shelvedRaises)),
    measure('acknowledged', 'Acknowledged', String(operator.timeToAck.count)),
    measure(
      'mean-time-to-ack',
      'Mean time to acknowledge',
      operator.timeToAck.count === 0 ? <NoAck /> : meanTimeToAck(operator.timeToAck),
    ),
    measure(
      'max-time-to-ack',
      'Longest time to acknowledge',
      operator.timeToAck.maxMs === null ? <NoAck /> : msText(operator.timeToAck.maxMs),
    ),
    measure('unacknowledged', 'Unacknowledged at the end', String(operator.unacknowledgedAtEnd)),
  ];
}

/**
 * One alarm scope's KPIs of the shift, built as on Alarm KPIs (UX-4b's `ScopeTile`; design system
 * 4.4, K-01): a `KpiTile` with the average per window and its EEMUA 191 verdict as the headline,
 * the raises and the peak under it, the other measures in a compact list; then the report's own
 * parts, the top bad actors and the operator measures. Named as on Alarm KPIs (R-03).
 */
function AlarmScopeTile({
  scope,
  bucket,
  live,
  running,
  finality,
  names,
}: {
  readonly scope: AlarmScope;
  readonly bucket: AlarmKpiBucketDto | undefined;
  readonly live: boolean;
  /** The shift is running: the average is over the whole shift, which is not over. */
  readonly running: boolean;
  readonly finality: GroupFinality | undefined;
  readonly names: ReadonlyMap<string, string>;
}) {
  const key = testKey(scopeKey(scope));
  // The benchmarks are the MES's (#160): no verdict until they arrived.
  const config = useAlarmConfig();
  const band = bucket && config ? rateBand(bucket.averageRate, config) : undefined;
  // The window as served (#160, #147): `10 min` by default, `window` until the answer arrived.
  const per = windowLabel(config?.kpi.windowMs);
  const label = `Average per ${per}`;
  const operator = scope.operator;
  const flags = bucket ? itemFlags(alarmBucketFlags(bucket), finality) : [];
  return (
    // On paper the tiles flow one under the other, each kept whole (R-05: no orphan third).
    <div className="report-section print:mb-4">
      <KpiTile
        title={scope.name}
        testId={`report-alarm-scope-${key}`}
        data-raises={bucket ? String(bucket.raises) : NOT_APPLICABLE}
        data-final={bucket ? String(bucket.final) : undefined}
        data-live={String(live)}
        status={
          flags.length > 0 || live ? (
            <span className="flex flex-wrap items-center gap-1.5">
              {flags.length > 0 ? <FlagBadges flags={flags} /> : null}
              <LiveBadge live={live} />
            </span>
          ) : undefined
        }
        headline={
          bucket
            ? {
                label,
                value: <Ratio ratio={bucket.averageRate} na="No raise rate" />,
                verdict:
                  band && config
                    ? { tone: RATE_VERDICT[band].tone, text: rateBandText(band, config) }
                    : undefined,
                tone: band === 'over' ? 'alarm' : undefined,
                hint: running
                  ? 'Over the whole shift; the shift is not over'
                  : 'Verdict against the EEMUA 191 benchmarks',
                detailData: { 'data-measure': 'average-rate', 'data-band': band },
              }
            : { label, missing: 'No alarm KPIs for this shift' }
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
        {bucket ? (
          <DescriptionList
            columns="tile"
            label={`Measures of ${scope.name}`}
            facts={kpiFacts(bucket)}
          />
        ) : null}
        <Section level={4} title="Top 5 bad actors">
          {scope.badActors.length === 0 ? (
            <EmptyState size="inline" title="No bad actor listed" />
          ) : (
            <ol className="flex flex-col gap-1 text-sm" data-testid={`report-bad-actors-${key}`}>
              {scope.badActors.map((actor) => (
                <li
                  key={`${actor.equipment}/${actor.code}`}
                  data-testid={`report-bad-actor-${key}-${actor.equipment}-${actor.code}`}
                  data-raises={String(actor.raises)}
                >
                  {names.get(actor.equipment) ?? actor.equipment}{' '}
                  <Code className="text-ink-secondary">{actor.code}</Code>:{' '}
                  <span className="tabular-nums">{actor.raises}</span> raises (
                  <Percent ratio={actor.share} na="No raise in the shift" />
                  ), {msText(actor.activeMs)} active
                </li>
              ))}
            </ol>
          )}
        </Section>
        <Section
          level={4}
          title="Operator measures"
          description="From the MES only, not reconciled with the ground truth: they depend on what operators do."
        >
          <div
            data-testid={`report-operator-${key}`}
            data-provisional={operator ? String(operator.provisional) : undefined}
          >
            {operator ? (
              <DescriptionList columns="tile" facts={operatorFacts(operator)} />
            ) : (
              <EmptyState size="inline" title="No operator measures for this scope" />
            )}
          </div>
          {operator && operator.shelvedMs.length > 0 ? (
            <div className="mt-2">
              <h5 className="text-sm font-semibold text-ink">Shelved time per point</h5>
              <ul
                className="mt-1 flex flex-col gap-1 text-sm"
                data-testid={`report-shelved-${key}`}
              >
                {operator.shelvedMs.map((point) => (
                  <li key={`${point.equipment}/${point.code}`} className="flex flex-wrap gap-x-2">
                    <span>{names.get(point.equipment) ?? point.equipment}</span>
                    <Code className="whitespace-nowrap text-ink-secondary">{point.code}</Code>
                    <span className="tabular-nums">{msText(point.ms)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      </KpiTile>
    </div>
  );
}

function AlarmSection({
  report,
  pushed,
  names,
}: {
  readonly report: ShiftReportDto;
  readonly pushed: ReadonlyMap<string, LiveAlarmKpi | undefined>;
  readonly names: ReadonlyMap<string, string>;
}) {
  const scopes = report.alarms.scopes.map((scope) => ({
    scope,
    ...liveAlarmKpi(scope.kpis, pushed.get(scopeKey(scope))?.shift, report),
  }));
  const buckets = scopes.flatMap(({ bucket }) => (bucket ? [bucket] : []));
  const finality = groupFinality(buckets);
  return (
    <Section
      id="report-alarms-title"
      title="Alarms"
      testId="report-alarms"
      status={<SectionFinality buckets={buckets} testId="report-alarms-finality" />}
      description="ISA-18.2 KPIs of the shift for the plant and per operator position, as on Alarm KPIs."
    >
      {scopes.length === 0 ? (
        <Card padding="compact">
          <EmptyState size="inline" icon="info" title="No alarm scope in this report" />
        </Card>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3 print:block">
          {scopes.map(({ scope, bucket, live }) => (
            <AlarmScopeTile
              key={scopeKey(scope)}
              scope={scope}
              bucket={bucket}
              live={live}
              running={report.status === 'running'}
              finality={finality}
              names={names}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

// ---- Crew ----

type CrewRow = ShiftReportDto['crew'][number];

function crewColumns(names: ReadonlyMap<string, string>): readonly Column<CrewRow>[] {
  return [
    {
      key: 'work-center',
      header: 'Work center',
      cell: (row) => <NamedCode name={names.get(row.workCenter)} code={row.workCenter} />,
    },
    { key: 'operator', header: 'Operator', rowHeader: true, cell: (row) => row.username },
    {
      key: 'from',
      header: 'Signed on',
      nowrap: true,
      cell: (row) => <PlantTime at={row.fromPlant} />,
    },
    {
      key: 'to',
      header: 'Until',
      cell: (row) =>
        row.toPlant === null ? (
          <Badge tone="neutral" variant="outline">
            Still signed on
          </Badge>
        ) : (
          <span>
            <PlantTime at={row.toPlant} />
            {row.endReason ? (
              <span className="text-ink-secondary"> ({CREW_END_LABELS[row.endReason]})</span>
            ) : null}
          </span>
        ),
    },
  ];
}

/** Who signed on at a terminal during the shift (#177), per work center. */
function CrewSection({
  report,
  names,
}: {
  readonly report: ShiftReportDto;
  readonly names: ReadonlyMap<string, string>;
}) {
  return (
    <Section
      id="report-crew-title"
      title="Crew"
      testId="report-crew"
      className="report-section"
      description="Who signed on at a terminal during the shift."
    >
      <DataTable
        caption="Operators signed on at a terminal during the shift"
        testId="report-crew-table"
        columns={crewColumns(names)}
        rows={report.crew}
        rowKey={(row) => String(row.id)}
        density="compact"
        narrow="stack"
        empty={
          <EmptyState
            size="inline"
            icon="user"
            title="Nobody signed on at a terminal during this shift"
          />
        }
      />
    </Section>
  );
}

// ---- The page ----

function ReportPage({
  report,
  shift,
  selection,
  onPick,
  notes,
  errors,
}: {
  readonly report: ShiftReportDto;
  readonly shift: ShiftRef;
  readonly selection: ShiftSelection;
  readonly onPick: (key: string) => void;
  readonly notes: ReturnType<typeof useShiftNotesRead>;
  readonly errors: ScreenErrors;
}) {
  const queryClient = useQueryClient();
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const reasons = useQuery({
    queryKey: queryKeys.reasonCodes,
    queryFn: ({ signal }) => getReasonCodes(signal),
    staleTime: 5 * 60_000,
  });
  const order = lineOrder(report, equipment.data);
  const running = report.status === 'running';
  // Live numbers while the shift runs (ADR-0025): `oee:<id>` per work center and machine and
  // `alarm-kpi:<scope>` per scope of the report; the composed sections stay as read.
  const oeeIds = [...order.workCenters.map((center) => center.id), ...order.machines];
  const scopeKeys = report.alarms.scopes.map(scopeKey);
  useLiveSubscriptions(
    running
      ? [...oeeIds.map((id) => `oee:${id}`), ...scopeKeys.map((key) => `alarm-kpi:${key}`)]
      : [],
  );
  const pushedOee = useLiveOeeMap(oeeIds);
  const pushedAlarms = useLiveAlarmKpiMap(scopeKeys);
  const restMachine = new Map(report.oee.equipment.map((bucket) => [bucket.id, bucket]));
  const restCenter = new Map(report.oee.workCenters.map((bucket) => [bucket.id, bucket]));
  const bucketOf = (id: string) => liveOee(restMachine.get(id), pushedOee.get(id)?.shift, report);
  const centerOf = (id: string) => liveOee(restCenter.get(id), pushedOee.get(id)?.shift, report);
  const reportKey = queryKeys.shiftReport(report.key, shift.epoch);
  // Ended but not final: late facts still close or re-cut downtime records, which have their
  // own push (`downtime`) but none in the report; read it again on them, at most every 5 s.
  const ended = report.status === 'ended';
  useLiveSubscriptions(ended ? [DOWNTIME_TOPIC] : []);
  useThrottledReread(useLiveDowntime()?.seq, reportKey, ended);
  const breaks = report.breaks.length;

  return (
    <>
      <PageHeader
        id="shift-report-title"
        back={BACK}
        title={`Shift report: ${shiftKeyLabel(report.key)}`}
        status={
          <span className="flex flex-wrap items-center gap-1.5">
            <span data-testid="report-status" data-status={report.status}>
              <ShiftStateBadge status={report.status} />
            </span>
            <span data-testid="report-finality" data-final={String(report.final)}>
              <FinalityBadge
                final={report.final}
                title={
                  report.final
                    ? 'Every input (OEE, downtime, alarm KPIs) is final'
                    : 'Its inputs may still change'
                }
              />
            </span>
          </span>
        }
        actions={
          <ReportActions
            report={report}
            shift={shift}
            refreshing={queryClient.isFetching({ queryKey: reportKey }) > 0}
            onRefresh={() => void queryClient.invalidateQueries({ queryKey: reportKey })}
          />
        }
        description={
          <span data-testid="report-span">
            <ShiftSpan start={report.start} end={report.end} />
            {breaks > 0 ? ` · ${String(breaks)} break${breaks === 1 ? '' : 's'}` : ''}
          </span>
        }
        meta={<ReportFacts report={report} />}
        filters={
          <div className="print:hidden">
            <ShiftPicker selection={selection} onChange={onPick} />
          </div>
        }
      />
      <RevisedNote report={report} />
      <FreshnessNote report={report} />
      <SectionNav items={SECTIONS} testId="report-section-nav" />
      <div className="mt-6 print:mt-0">
        <OeeSection report={report} order={order} bucketOf={bucketOf} centerOf={centerOf} />
        <ProductionSection report={report} order={order} bucketOf={bucketOf} />
        <DowntimeSection report={report} reasons={reasons.data} names={order.names} />
        <AlarmSection report={report} pushed={pushedAlarms} names={order.names} />
        <CrewSection report={report} names={order.names} />
        <HandoverNotes
          report={report}
          shift={{ ...shift, epoch: report.epoch }}
          read={notes}
          errors={errors}
        />
      </div>
    </>
  );
}

/**
 * One shift's report (#146; UX-5b, #327; design system section 10, R-01 … R-05): the header with
 * its state, finality and key facts, then OEE, production, downtime, alarms, crew and the handover
 * notes, reachable from the in-page index. Laid out for A4 when printed (index.css): no shell, no
 * controls, each section kept on one page where it fits, the charts as still images.
 */
export function ShiftReport() {
  const params = useParams({ from: '/shifts/$date/$shift' });
  const search = useSearch({ from: '/shifts/$date/$shift' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const valid = DATE.test(params.date) && SHIFT.test(params.shift);
  const key = `${params.date}/${params.shift}`;
  const shift: ShiftRef = { date: params.date, shift: params.shift, epoch: search.epoch };
  useShiftsTopic();
  const selection = useShiftSelection(valid ? key : undefined);
  const reportKey = queryKeys.shiftReport(key, search.epoch);
  const report = useQuery({
    queryKey: reportKey,
    queryFn: ({ signal }) => getShiftReport(shift, signal),
    enabled: valid,
  });
  const data = report.data;
  // The notes, read here so that the report's and the notes' failures are one error (#394).
  const notes = useShiftNotesRead(data, shift);
  const errors = useScreenErrors([
    queryRead('the shift report', report, 'main'),
    queryRead(NOTES_READ, notes, 'section'),
  ]);
  // Read the report again when its instance's status or revision moves (the `shifts` topic).
  const pushed = useLiveShifts()?.instances[instanceKey(data?.epoch ?? -1, data?.key ?? '')];
  const behind = data !== undefined && pushed !== undefined && isNewerShift(pushed, data);
  const pushedRevision = pushed
    ? `${pushed.status}/${String(pushed.revision.inputs)}/${String(pushed.revision.content)}`
    : undefined;
  useEffect(() => {
    if (!behind) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.shiftReport(key, search.epoch) });
  }, [behind, pushedRevision, queryClient, key, search.epoch]);
  const onPick = (next: string) => {
    const [date = '', name = ''] = next.split('/');
    if (!DATE.test(date) || !SHIFT.test(name)) return;
    void navigate({ to: '/shifts/$date/$shift', params: { date, shift: name }, search: {} });
  };

  if (!valid) {
    return (
      <NotFound
        kind="shift"
        id={key}
        back={{ to: '/shifts', label: BACK.label }}
        detail="It is not a shift key: a date and a shift, such as 2026-10-15/A."
        testId="report-invalid"
      />
    );
  }
  if (report.error instanceof ApiError && report.error.status === 404) {
    return (
      <NotFound
        kind="shift"
        id={key}
        back={{ to: '/shifts', label: BACK.label }}
        detail="A shift has a report once the plant clock has entered it."
        testId="report-missing"
      />
    );
  }

  return (
    <section aria-labelledby="shift-report-title" data-testid="shift-report-page">
      {report.isPending ? (
        // No `h1` until the report is read: the heading takes the focus when it mounts.
        <div className="flex flex-col gap-6">
          <p className="text-sm">
            <Link {...BACK.link} className="text-link underline-offset-4 hover:underline">
              ‹ {BACK.label}
            </Link>
          </p>
          <Skeleton shape="card" label="Loading the report…" />
        </div>
      ) : null}
      {report.isError && !data ? (
        <>
          <PageHeader
            id="shift-report-title"
            back={BACK}
            title={`Shift report: ${shiftKeyLabel(key)}`}
            filters={
              <div className="print:hidden">
                <ShiftPicker selection={selection} onChange={onPick} />
              </div>
            }
          />
          <div data-testid="report-error">
            <QueryError
              what="the shift report"
              error={report.error}
              onRetry={() => void report.refetch()}
            />
          </div>
        </>
      ) : null}
      {data && errors.summary.length > 0 ? (
        <div data-testid="report-error" className="mb-4 print:hidden">
          <ScreenError errors={errors} />
        </div>
      ) : null}
      {data ? (
        <div
          data-testid="shift-report"
          data-key={data.key}
          data-epoch={String(data.epoch)}
          data-status={data.status}
          data-final={String(data.final)}
          data-revision-inputs={String(data.revision.inputs)}
          data-revision-content={String(data.revision.content)}
          className="shift-report"
        >
          {/* Keyed by the instance: no draft or open editor carries over to another shift. */}
          <ReportPage
            key={`${String(data.epoch)}~${data.key}`}
            report={data}
            shift={shift}
            selection={selection}
            onPick={onPick}
            notes={notes}
            errors={errors}
          />
        </div>
      ) : null}
    </section>
  );
}
