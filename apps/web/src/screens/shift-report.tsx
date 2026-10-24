import {
  DOWNTIME_TOPIC,
  type AlarmKpiBucketDto,
  type EquipmentDto,
  type OeeBucketDto,
  type Ratio,
  type ReasonCodes,
  type ShiftReportDto,
} from '@shopfloor/contracts/mes-api';
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  getReasonCodes,
  getShiftReport,
  listEquipment,
  shiftReportUrl,
  type ShiftRef,
} from '../api/client.ts';
import { queryKeys, useAlarmConfig } from '../api/queries.ts';
import { EChart } from '../chart/echart.tsx';
import { paretoOption, paretoReading } from '../chart/oee-options.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { ShiftPicker, shiftLabel, useShiftSelection } from '../components/shift-picker.tsx';
import {
  alarmBucketFlags,
  meanTimeToAck,
  msText,
  rateBand,
  rateBandText,
  scopeKey,
  windowLabel,
} from '../domain/alarms.ts';
import { reasonName } from '../domain/downtime.ts';
import {
  NOT_APPLICABLE,
  bucketFlags,
  minutesText,
  percentText,
  ratioText,
  type BucketFlag,
} from '../domain/oee.ts';
import {
  STATUS_TEXT,
  changesAfterFinal,
  finalityText,
  instanceKey,
  isNewerShift,
  liveAlarmKpi,
  liveOee,
  production,
  revisionText,
} from '../domain/shifts.ts';
import { formatPlantTime } from '../domain/time.ts';
import { liveKeys, type LiveAlarmKpi, type LiveOee } from '../live/live-cache.ts';
import {
  useLiveDowntime,
  useLiveShifts,
  useLiveSubscriptions,
  useShiftsTopic,
} from '../live/live-context.tsx';
import { CREW_END_LABELS } from '../domain/terminal.ts';
import { HandoverNotes } from './handover-notes.tsx';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHIFT = /^[A-Za-z0-9_-]{1,16}$/;

/** `plant` → `plant`, `position:cell-m1` → `position-cell-m1` (test ids). */
const testKey = (key: string): string => key.replace(':', '-');

/** How often an ended report is read again at most while downtime pushes arrive. */
const ENDED_REREAD_MS = 5_000;

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

const tableBox =
  'relative mt-1 min-w-0 overflow-x-auto rounded-lg border border-slate-300 bg-white print:overflow-visible print:border-0';
const th = 'px-2 py-1';
const buttonClass =
  'rounded border border-slate-500 bg-white px-3 py-1 text-sm font-medium hover:bg-slate-100 disabled:opacity-50';

function FlagList({ flags }: { readonly flags: readonly BucketFlag[] }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Status">
      {flags.map((flag) => (
        <li
          key={flag.key}
          title={flag.title}
          data-flag={flag.key}
          className={`rounded border px-1.5 text-xs font-medium ${
            flag.key === 'final'
              ? 'border-emerald-800 text-emerald-900'
              : 'border-amber-700 text-amber-950'
          }`}
        >
          {flag.text}
        </li>
      ))}
    </ul>
  );
}

function LiveMark({ live }: { readonly live: boolean }) {
  if (!live) return null;
  return (
    <span
      data-live="true"
      className="ml-1 rounded bg-sky-100 px-1 text-xs font-medium text-sky-950 print:hidden"
      title="Pushed while the shift runs; newer than the report read"
    >
      Live
    </span>
  );
}

const RatioCell = ({ ratio }: { readonly ratio: Ratio | null }) => (
  <td
    className="px-2 py-1 text-right whitespace-nowrap tabular-nums"
    title={ratio?.fraction}
    data-decimal={ratioText(ratio)}
  >
    {percentText(ratio)}
  </td>
);

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

// ---- Header ----

function ReportHeader({
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
  const changes = changesAfterFinal(report);
  const revised = changes !== undefined && (changes.inputs > 0 || changes.content > 0);
  return (
    <div className="mt-3 flex flex-col gap-3">
      <dl
        data-testid="report-summary"
        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 rounded-lg border border-slate-300 bg-white p-3 text-sm sm:grid-cols-[auto_1fr_auto_1fr] print:border-slate-500"
      >
        <dt className="text-slate-700">Status</dt>
        <dd data-testid="report-status" data-status={report.status} className="font-semibold">
          {STATUS_TEXT[report.status]}
        </dd>
        <dt className="text-slate-700">Report</dt>
        <dd data-testid="report-finality" data-final={String(report.final)}>
          <span
            className={`rounded border px-1.5 text-xs font-semibold ${
              report.final
                ? 'border-emerald-800 text-emerald-900'
                : 'border-amber-700 text-amber-950'
            }`}
          >
            {finalityText(report)}
          </span>
          {report.final && report.finalAt ? (
            <span className="ml-2 text-slate-700">
              since <time dateTime={report.finalAt}>{formatPlantTime(report.finalAt)}</time> (wall)
            </span>
          ) : null}
          {!report.final ? (
            <span className="ml-2 text-slate-700">its inputs may still change</span>
          ) : null}
        </dd>
        <dt className="text-slate-700">Revision</dt>
        <dd
          data-testid="report-revision"
          data-inputs={String(report.revision.inputs)}
          data-content={String(report.revision.content)}
        >
          {revisionText(report)}
        </dd>
        <dt className="text-slate-700">Plant epoch</dt>
        <dd data-testid="report-epoch">{report.epoch}</dd>
        <dt className="text-slate-700">Shift</dt>
        <dd>
          <time dateTime={report.start}>{formatPlantTime(report.start)}</time> to{' '}
          <time dateTime={report.end}>{formatPlantTime(report.end)}</time>
          {report.breaks.length > 0
            ? ` · ${String(report.breaks.length)} break${report.breaks.length === 1 ? '' : 's'}`
            : ''}
        </dd>
        <dt className="text-slate-700">Incidents</dt>
        <dd data-testid="report-incidents">{report.incidents}</dd>
        <dt className="text-slate-700">As of (plant time)</dt>
        <dd data-testid="report-as-of">
          {report.asOf ? (
            <time dateTime={report.asOf}>{formatPlantTime(report.asOf)}</time>
          ) : (
            'no plant clock'
          )}
        </dd>
        <dt className="text-slate-700">Generated (wall clock)</dt>
        <dd data-testid="report-generated-at">
          <time dateTime={report.generatedAt}>{formatPlantTime(report.generatedAt)}</time>
        </dd>
      </dl>
      {revised ? (
        <div
          role="status"
          data-testid="report-revised"
          data-inputs={String(changes.inputs)}
          data-content={String(changes.content)}
          className="rounded border border-amber-700 bg-amber-50 p-3 text-sm text-amber-950 print:border-slate-700 print:bg-white"
        >
          <p className="font-semibold">This report changed after it became final.</p>
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
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 print:hidden" data-print="hidden">
        <button
          type="button"
          data-testid="print-report"
          className={buttonClass}
          onClick={() => {
            window.print();
          }}
        >
          Print
        </button>
        <a
          data-testid="download-report"
          href={shiftReportUrl({ ...shift, epoch: report.epoch })}
          download={`shift-report-${report.date}-${report.shift}-epoch-${String(report.epoch)}.json`}
          className={buttonClass}
        >
          Download JSON
        </a>
        <button
          type="button"
          data-testid="refresh-report"
          className={buttonClass}
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? 'Reading…' : 'Read again'}
        </button>
        {report.status === 'running' ? (
          <span className="text-sm text-slate-700" data-testid="report-live-note">
            Live: OEE, production and alarm KPIs follow the plant; downtime, bad actors and operator
            figures are as of the time above.
          </span>
        ) : null}
        {report.status === 'ended' ? (
          <span className="text-sm text-slate-700" data-testid="report-ended-note">
            Ended, not final yet: the values are as of the time above. The report is read again when
            a downtime record changes and when it becomes final.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---- OEE ----

function OeeRow({
  id,
  name,
  kind,
  bucket,
  live,
}: {
  readonly id: string;
  readonly name: string;
  readonly kind: 'wc' | 'machine';
  readonly bucket: OeeBucketDto | undefined;
  readonly live: boolean;
}) {
  const result = bucket?.result;
  return (
    <tr
      data-testid={`report-oee-${kind}-${id}`}
      data-oee={result ? ratioText(result.oee) : NOT_APPLICABLE}
      data-final={bucket ? String(bucket.final) : undefined}
      data-live={String(live)}
      className="border-t border-slate-200"
    >
      <th
        scope="row"
        className={`${th} text-left ${kind === 'wc' ? 'font-semibold' : 'font-normal'}`}
      >
        {name}
        <LiveMark live={live} />
      </th>
      {result ? (
        <>
          <td
            className="px-2 py-1 text-right font-semibold whitespace-nowrap tabular-nums"
            title={result.oee?.fraction}
            data-decimal={ratioText(result.oee)}
          >
            {percentText(result.oee)}
          </td>
          <RatioCell ratio={result.availability} />
          <RatioCell ratio={result.performance} />
          <RatioCell ratio={result.quality} />
          <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
            {result.losses ? minutesText(result.losses.availability.own.total) : NOT_APPLICABLE}
          </td>
          <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
            {result.losses
              ? minutesText(result.losses.availability.external.total)
              : NOT_APPLICABLE}
          </td>
          <td className="px-2 py-1">
            <FlagList flags={bucketFlags(bucket)} />
          </td>
        </>
      ) : (
        <td colSpan={7} className="px-2 py-1 text-slate-700">
          n/a: no data for this shift
        </td>
      )}
    </tr>
  );
}

function OeeSection({
  report,
  order,
  bucketOf,
  centerOf,
}: {
  readonly report: ShiftReportDto;
  readonly order: LineOrder;
  readonly bucketOf: (id: string) => { bucket: OeeBucketDto | undefined; live: boolean };
  readonly centerOf: (id: string) => { bucket: OeeBucketDto | undefined; live: boolean };
}) {
  return (
    <section aria-labelledby="report-oee-title" data-testid="report-oee" className="report-section">
      <h2 id="report-oee-title" className="text-xl font-semibold">
        OEE
      </h2>
      <p className="text-sm text-slate-700">
        As the MES computes it (exact fractions, four decimals); n/a when not applicable.
      </p>
      <div className={tableBox}>
        <table className="w-full min-w-[44rem] text-sm print:min-w-0">
          <caption className="sr-only">OEE per work center and machine for the shift</caption>
          <thead className="bg-slate-100 text-left">
            <tr>
              <th scope="col" className={th}>
                Work center / machine
              </th>
              <th scope="col" className={`${th} text-right`}>
                OEE
              </th>
              <th scope="col" className={`${th} text-right`}>
                Availability
              </th>
              <th scope="col" className={`${th} text-right`}>
                Performance
              </th>
              <th scope="col" className={`${th} text-right`}>
                Quality
              </th>
              <th scope="col" className={`${th} text-right`}>
                Loss, own
              </th>
              <th scope="col" className={`${th} text-right`}>
                Loss, external
              </th>
              <th scope="col" className={th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {order.workCenters.map((center) => (
              <OeeRow
                key={center.id}
                id={center.id}
                name={center.name}
                kind="wc"
                {...centerOf(center.id)}
              />
            ))}
            {order.machines.map((id) => (
              <OeeRow
                key={id}
                id={id}
                name={order.names.get(id) ?? id}
                kind="machine"
                {...bucketOf(id)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {report.oee.equipment.length === 0 && report.oee.workCenters.length === 0 ? (
        <p className="mt-1 text-sm" data-testid="report-oee-empty">
          No OEE data in this shift.
        </p>
      ) : null}
    </section>
  );
}

// ---- Downtime ----

function DowntimeSection({
  report,
  reasons,
  names,
}: {
  readonly report: ShiftReportDto;
  readonly reasons: ReasonCodes | undefined;
  readonly names: ReadonlyMap<string, string>;
}) {
  const { downtime } = report;
  const pareto = downtime.reasons.length > 0 ? paretoOption({ reasons: downtime.reasons }) : null;
  return (
    <section
      aria-labelledby="report-downtime-title"
      data-testid="report-downtime"
      className="report-section"
    >
      <h2 id="report-downtime-title" className="text-xl font-semibold">
        Downtime
      </h2>
      <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 text-sm sm:max-w-md">
        <dt className="text-slate-700">Availability loss, own</dt>
        <dd className="text-right tabular-nums" data-testid="report-loss-own">
          {minutesText(downtime.availability.own)}
        </dd>
        <dt className="text-slate-700">Availability loss, external</dt>
        <dd className="text-right tabular-nums" data-testid="report-loss-external">
          {minutesText(downtime.availability.external)}
        </dd>
        <dt className="text-slate-700">Downtime records</dt>
        <dd className="text-right tabular-nums" data-testid="report-records">
          {downtime.records}
        </dd>
        <dt className="text-slate-700">Still uncoded</dt>
        <dd
          className="text-right tabular-nums"
          data-testid="report-uncoded"
          data-ms={String(downtime.uncodedMs)}
        >
          {minutesText(downtime.uncodedMs)}
          {downtime.uncodedMs > 0 ? (
            <Link
              to="/downtime"
              search={{ shift: report.key, uncoded: true }}
              className="ml-2 text-sky-800 underline print:hidden"
            >
              Code them
            </Link>
          ) : null}
        </dd>
      </dl>
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2 print:block">
        <EChart
          testId="report-pareto-chart"
          title="Availability loss by reason"
          description={`${paretoReading({ reasons: downtime.reasons })}; the table lists every value.`}
          option={pareto?.option ?? null}
          {...(pareto ? { height: pareto.height } : { height: 160 })}
          empty="No availability loss in this shift."
        />
        <div className="min-w-0">
          <h3 className="font-semibold">Pareto by reason</h3>
          <div className={tableBox}>
            <table
              className="w-full min-w-[28rem] text-sm print:min-w-0"
              data-testid="report-pareto"
            >
              <caption className="sr-only">Availability loss by reason, largest first</caption>
              <thead className="bg-slate-100 text-left">
                <tr>
                  <th scope="col" className={th}>
                    Reason
                  </th>
                  <th scope="col" className={th}>
                    Loss
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Time
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Records
                  </th>
                </tr>
              </thead>
              <tbody>
                {downtime.reasons.map((row) => (
                  <tr
                    key={`${row.reason}/${row.loss}`}
                    data-testid={`report-pareto-${row.reason}`}
                    data-ms={String(row.ms)}
                    className="border-t border-slate-200"
                  >
                    <td className="px-2 py-1">{row.name}</td>
                    <td className="px-2 py-1">{row.loss === 'own' ? 'Own' : 'External'}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                      {minutesText(row.ms)}
                    </td>
                    <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                      {row.records}
                    </td>
                  </tr>
                ))}
                {downtime.reasons.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-2 py-3">
                      No availability loss.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {downtime.microStops.length > 0 ? (
            <>
              <h3 className="mt-3 font-semibold">Micro-stops by cause</h3>
              <ul className="text-sm" data-testid="report-micro-stops">
                {downtime.microStops.map((row) => (
                  <li key={row.cause ?? 'none'}>
                    {row.cause ?? 'No cause'}: {minutesText(row.ms)} ({row.stops} stops)
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
      <h3 className="mt-4 font-semibold">Longest downtime records</h3>
      <div className={tableBox}>
        <table className="w-full min-w-[40rem] text-sm print:min-w-0" data-testid="report-longest">
          <caption className="sr-only">The ten longest downtime records, longest first</caption>
          <thead className="bg-slate-100 text-left">
            <tr>
              <th scope="col" className={th}>
                Machine
              </th>
              <th scope="col" className={th}>
                Start
              </th>
              <th scope="col" className={th}>
                End
              </th>
              <th scope="col" className={`${th} text-right`}>
                Length
              </th>
              <th scope="col" className={th}>
                State
              </th>
              <th scope="col" className={th}>
                Reason
              </th>
            </tr>
          </thead>
          <tbody>
            {downtime.longest.map((record) => (
              <tr
                key={record.id}
                data-testid={`report-longest-${record.id}`}
                data-reason={record.reason}
                data-uncoded={String(record.uncoded)}
                className="border-t border-slate-200"
              >
                <td className="px-2 py-1">{names.get(record.equipment) ?? record.equipment}</td>
                <td className="px-2 py-1">
                  <time dateTime={record.start}>{formatPlantTime(record.start)}</time>
                </td>
                <td className="px-2 py-1">
                  {record.end ? (
                    <time dateTime={record.end}>{formatPlantTime(record.end)}</time>
                  ) : (
                    'open'
                  )}
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                  {minutesText(record.ms)}
                </td>
                <td className="px-2 py-1">
                  {record.state} ({record.loss === 'own' ? 'own' : 'external'})
                </td>
                <td className="px-2 py-1">
                  {reasonName(reasons, record.reason)}
                  {record.uncoded ? <span className="ml-1 font-semibold">(uncoded)</span> : null}
                  {record.provisional ? <span className="ml-1">(provisional)</span> : null}
                </td>
              </tr>
            ))}
            {downtime.longest.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-3">
                  No downtime record in this shift.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- Production ----

function ProductionSection({
  report,
  order,
  bucketOf,
}: {
  readonly report: ShiftReportDto;
  readonly order: LineOrder;
  readonly bucketOf: (id: string) => { bucket: OeeBucketDto | undefined; live: boolean };
}) {
  const shown = production(report, order.machines, bucketOf);
  return (
    <section
      aria-labelledby="report-production-title"
      data-testid="report-production"
      data-live={String(shown.live)}
      className="report-section"
    >
      <h2 id="report-production-title" className="text-xl font-semibold">
        Production
      </h2>
      <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 text-sm sm:max-w-md">
        <dt className="text-slate-700">
          Finished parts
          {shown.finished.equipment
            ? ` (good of ${order.names.get(shown.finished.equipment) ?? shown.finished.equipment})`
            : ''}
        </dt>
        <dd
          className="text-right font-semibold tabular-nums"
          data-testid="report-finished"
          data-good={shown.finished.good === null ? NOT_APPLICABLE : String(shown.finished.good)}
        >
          {shown.finished.good ?? NOT_APPLICABLE}
        </dd>
        <dt className="text-slate-700">Scrap, all machines</dt>
        <dd className="text-right tabular-nums" data-testid="report-scrap-total">
          {shown.scrap}
        </dd>
      </dl>
      <div className={tableBox}>
        <table className="w-full min-w-[30rem] text-sm print:min-w-0">
          <caption className="sr-only">Cycles per machine in the shift</caption>
          <thead className="bg-slate-100 text-left">
            <tr>
              <th scope="col" className={th}>
                Machine
              </th>
              <th scope="col" className={`${th} text-right`}>
                Produced
              </th>
              <th scope="col" className={`${th} text-right`}>
                Good
              </th>
              <th scope="col" className={`${th} text-right`}>
                Scrap
              </th>
              <th scope="col" className={`${th} text-right`}>
                Rework
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.machines.map((row) => (
              <tr
                key={row.equipment}
                data-testid={`report-production-${row.equipment}`}
                data-produced={String(row.produced)}
                data-good={String(row.good)}
                data-scrap={String(row.scrap)}
                data-rework={String(row.rework)}
                data-live={String(row.live)}
                className="border-t border-slate-200"
              >
                <th scope="row" className={`${th} text-left font-normal`}>
                  {order.names.get(row.equipment) ?? row.equipment}
                  <LiveMark live={row.live} />
                </th>
                <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                  {row.produced}
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{row.good}</td>
                <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{row.scrap}</td>
                <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                  {row.rework}
                </td>
              </tr>
            ))}
            {shown.machines.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-3">
                  No cycles in this shift.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- Alarms ----

function Measure({
  name,
  label,
  children,
}: {
  readonly name: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-slate-700">{label}</dt>
      <dd data-measure={name} className="text-right tabular-nums">
        {children}
      </dd>
    </>
  );
}

type AlarmScope = ShiftReportDto['alarms']['scopes'][number];

function AlarmScopeCard({
  scope,
  bucket,
  live,
}: {
  readonly scope: AlarmScope;
  readonly bucket: AlarmKpiBucketDto | undefined;
  readonly live: boolean;
}) {
  const key = testKey(scopeKey(scope));
  const titleId = useId();
  const na = NOT_APPLICABLE;
  // The benchmarks are the MES's (#160): no band until they arrived.
  const config = useAlarmConfig();
  const band = bucket && config ? rateBand(bucket.averageRate, config) : undefined;
  // The window as served (#160, #147): `10 min` by default, `window` until the answer arrived.
  const per = windowLabel(config?.kpi.windowMs);
  const operator = scope.operator;
  return (
    <li className="report-section">
      <article
        aria-labelledby={titleId}
        data-testid={`report-alarm-scope-${key}`}
        data-raises={bucket ? String(bucket.raises) : na}
        data-final={bucket ? String(bucket.final) : undefined}
        data-live={String(live)}
        className="flex h-full flex-col gap-2 rounded-lg border border-slate-300 bg-white p-3"
      >
        <h3 id={titleId} className="font-semibold">
          {scope.scope === 'position' ? `Position ${scope.name}` : scope.name}
          <LiveMark live={live} />
        </h3>
        {bucket ? <FlagList flags={alarmBucketFlags(bucket)} /> : null}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
          <Measure name="raises" label="Raises (high / medium / low)">
            {bucket
              ? `${String(bucket.raises)} (${String(bucket.byPriority.high)} / ${String(bucket.byPriority.medium)} / ${String(bucket.byPriority.low)})`
              : na}
          </Measure>
          <Measure name="average-rate" label={`Average per ${per}`}>
            {bucket ? (
              <span title={bucket.averageRate.fraction}>
                <span className="font-mono">{bucket.averageRate.decimal}</span>
                {config && band ? (
                  <>
                    {' '}
                    <span data-band={band} className="text-xs">
                      {rateBandText(band, config)}
                    </span>
                  </>
                ) : null}
              </span>
            ) : (
              na
            )}
          </Measure>
          <Measure name="peak10" label={`Peak per ${per}`}>
            {bucket ? bucket.peak10 : na}
          </Measure>
          <Measure name="flood-windows" label="Flood windows">
            {bucket ? `${String(bucket.floodWindows)} of ${String(bucket.windows)}` : na}
          </Measure>
          <Measure name="flood-episodes" label="Flood episodes (time)">
            {bucket ? `${String(bucket.floods.length)} (${msText(bucket.floodMs)})` : na}
          </Measure>
          <Measure name="standing" label="Standing (active at end)">
            {bucket ? `${String(bucket.standing.length)} (${String(bucket.activeAtEnd)})` : na}
          </Measure>
          <Measure name="chattering" label="Chattering raises (points)">
            {bucket
              ? `${String(bucket.chatteringRaises)} (${String(bucket.chatteringPoints.length)})`
              : na}
          </Measure>
          <Measure name="fleeting" label="Fleeting">
            {bucket
              ? `${String(bucket.fleeting)}${bucket.fleetingUndecided > 0 ? ` (+${String(bucket.fleetingUndecided)} undecided)` : ''}`
              : na}
          </Measure>
        </dl>
        <h4 className="text-sm font-medium">Top 5 bad actors</h4>
        <ol className="text-sm" data-testid={`report-bad-actors-${key}`}>
          {scope.badActors.map((actor) => (
            <li
              key={`${actor.equipment}/${actor.code}`}
              data-testid={`report-bad-actor-${key}-${actor.equipment}-${actor.code}`}
              data-raises={String(actor.raises)}
            >
              {actor.equipment} <span className="font-mono text-xs">{actor.code}</span>:{' '}
              {actor.raises} raises (
              <span title={actor.share.fraction} data-decimal={ratioText(actor.share)}>
                {percentText(actor.share)}
              </span>
              ), {msText(actor.activeMs)} active
            </li>
          ))}
          {scope.badActors.length === 0 ? <li>No alarm in this shift.</li> : null}
        </ol>
        <h4 className="text-sm font-medium">Operator figures (MES only, not reconciled)</h4>
        <dl
          className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm"
          data-testid={`report-operator-${key}`}
          data-provisional={operator ? String(operator.provisional) : undefined}
        >
          <Measure name="annunciated" label="Annunciated raises">
            {operator ? operator.annunciatedRaises : na}
          </Measure>
          <Measure name="shelved-raises" label="Raises while shelved">
            {operator ? operator.shelvedRaises : na}
          </Measure>
          <Measure name="acknowledged" label="Acknowledged">
            {operator ? operator.timeToAck.count : na}
          </Measure>
          <Measure name="mean-time-to-ack" label="Mean time to acknowledge">
            {operator ? meanTimeToAck(operator.timeToAck) : na}
          </Measure>
          <Measure name="max-time-to-ack" label="Longest time to acknowledge">
            {operator ? msText(operator.timeToAck.maxMs) : na}
          </Measure>
          <Measure name="unacknowledged" label="Unacknowledged at the end">
            {operator ? operator.unacknowledgedAtEnd : na}
          </Measure>
        </dl>
        {operator && operator.shelvedMs.length > 0 ? (
          <ul className="text-sm" data-testid={`report-shelved-${key}`}>
            {operator.shelvedMs.map((point) => (
              <li key={`${point.equipment}/${point.code}`}>
                Shelved {point.equipment} <span className="font-mono text-xs">{point.code}</span>:{' '}
                {msText(point.ms)}
              </li>
            ))}
          </ul>
        ) : null}
      </article>
    </li>
  );
}

function AlarmSection({
  report,
  pushed,
}: {
  readonly report: ShiftReportDto;
  readonly pushed: ReadonlyMap<string, LiveAlarmKpi | undefined>;
}) {
  return (
    <section
      aria-labelledby="report-alarms-title"
      data-testid="report-alarms"
      className="report-section"
    >
      <h2 id="report-alarms-title" className="text-xl font-semibold">
        Alarms
      </h2>
      <p className="text-sm text-slate-700">
        ISA-18.2 KPIs of the shift per operator position and for the plant (as on Alarm KPIs).
      </p>
      <ul className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 print:grid-cols-2">
        {report.alarms.scopes.map((scope) => {
          const { bucket, live } = liveAlarmKpi(
            scope.kpis,
            pushed.get(scopeKey(scope))?.shift,
            report,
          );
          return <AlarmScopeCard key={scopeKey(scope)} scope={scope} bucket={bucket} live={live} />;
        })}
      </ul>
    </section>
  );
}

/** Who signed on at a terminal during the shift (#177), per work center. */
function CrewSection({ report }: { readonly report: ShiftReportDto }) {
  return (
    <section
      aria-labelledby="report-crew-title"
      data-testid="report-crew"
      className="report-section"
    >
      <h2 id="report-crew-title" className="text-xl font-semibold">
        Crew
      </h2>
      {report.crew.length === 0 ? (
        <p className="text-sm text-slate-700">Nobody signed on at a terminal during this shift.</p>
      ) : (
        <table className="mt-2 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-400">
              <th scope="col" className="py-1 pr-3">
                Work center
              </th>
              <th scope="col" className="py-1 pr-3">
                Operator
              </th>
              <th scope="col" className="py-1 pr-3">
                Signed on
              </th>
              <th scope="col" className="py-1 pr-3">
                Until
              </th>
            </tr>
          </thead>
          <tbody>
            {report.crew.map((row) => (
              <tr key={row.id} className="border-b border-slate-200">
                <td className="py-1 pr-3 font-mono">{row.workCenter}</td>
                <td className="py-1 pr-3">{row.username}</td>
                <td className="py-1 pr-3">{formatPlantTime(row.fromPlant)}</td>
                <td className="py-1 pr-3">
                  {row.toPlant === null
                    ? 'still signed on'
                    : `${formatPlantTime(row.toPlant)}${row.endReason ? ` (${CREW_END_LABELS[row.endReason]})` : ''}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---- The page ----

function ReportBody({
  report,
  shift,
}: {
  readonly report: ShiftReportDto;
  readonly shift: ShiftRef;
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

  return (
    <>
      <ReportHeader
        report={report}
        shift={shift}
        refreshing={queryClient.isFetching({ queryKey: reportKey }) > 0}
        onRefresh={() => void queryClient.invalidateQueries({ queryKey: reportKey })}
      />
      <div className="mt-6 flex flex-col gap-8 print:mt-4 print:gap-4">
        <OeeSection report={report} order={order} bucketOf={bucketOf} centerOf={centerOf} />
        <ProductionSection report={report} order={order} bucketOf={bucketOf} />
        <DowntimeSection report={report} reasons={reasons.data} names={order.names} />
        <AlarmSection report={report} pushed={pushedAlarms} />
        <CrewSection report={report} />
        <HandoverNotes report={report} shift={{ ...shift, epoch: report.epoch }} />
      </div>
    </>
  );
}

export function ShiftReport() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
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
  const calendar =
    selection.shifts.find((candidate) => candidate.key === key) ??
    (selection.current?.shift?.key === key ? selection.current.shift : undefined);

  return (
    <section aria-labelledby="shift-report-title" data-testid="shift-report-page">
      <h1 ref={heading} id="shift-report-title" tabIndex={-1} className="text-2xl font-bold">
        Shift report{calendar ? `: ${shiftLabel(calendar)}` : `: ${key}`}
      </h1>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6 print:hidden">
        <ShiftPicker
          selection={selection}
          onChange={(next) => {
            const [date = '', name = ''] = next.split('/');
            if (!DATE.test(date) || !SHIFT.test(name)) return;
            void navigate({
              to: '/shifts/$date/$shift',
              params: { date, shift: name },
              search: {},
            });
          }}
        />
        <Link to="/shifts" className="text-sm text-sky-800 underline">
          All shift reports
        </Link>
      </div>
      {!valid ? (
        <p role="alert" className="mt-4" data-testid="report-invalid">
          {key} is not a shift key (a date and a shift, such as 2026-10-15/A).
        </p>
      ) : null}
      {valid && report.isPending ? <p className="mt-4">Loading the report…</p> : null}
      {report.isError ? (
        <div className="mt-4" data-testid="report-error">
          <QueryError
            what="the shift report"
            error={report.error}
            onRetry={() => void report.refetch()}
          />
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
          <ReportBody key={`${String(data.epoch)}~${data.key}`} report={data} shift={shift} />
        </div>
      ) : null}
    </section>
  );
}
