import {
  DOWNTIME_TOPIC,
  type EquipmentDto,
  type OeeBucketDto,
  type Pareto,
  type Ratio,
} from '@shopfloor/contracts/mes-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef } from 'react';
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
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { ShiftPicker, useShiftSelection } from '../components/shift-picker.tsx';
import {
  NOT_APPLICABLE,
  bottleneckMachines,
  bucketFlags,
  minutesText,
  percentText,
  pickBucket,
  ratioText,
  secondsText,
  stepSign,
  waterfall,
} from '../domain/oee.ts';
import { formatClockTime, formatPlantTime } from '../domain/time.ts';
import { useLiveDowntime, useLiveOee, useLiveSubscriptions } from '../live/live-context.tsx';
import { LineOeeCard, useLineOee } from './line-oee.tsx';

const LIVE_REFRESH_MS = 30_000;
/** A downtime push (a new record, a recode) rereads the Pareto, at most this often. */
const PARETO_THROTTLE_MS = 2_000;

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

function Flags({ bucket }: { readonly bucket: OeeBucketDto }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Status">
      {bucketFlags(bucket).map((flag) => (
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

/** A ratio cell of the machine table: the four decimals, raw in `data-decimal` too (UX-1c). */
function RatioTd({ ratio }: { readonly ratio: Ratio | null }) {
  return (
    <td className="px-2 py-1 text-right font-mono tabular-nums" data-decimal={ratioText(ratio)}>
      {ratioText(ratio)}
    </td>
  );
}

function RatioRow({ label, ratio }: { readonly label: string; readonly ratio: Ratio | null }) {
  return (
    <>
      <dt className="text-slate-700">{label}</dt>
      <dd
        className="text-right font-mono tabular-nums"
        title={ratio?.fraction}
        data-decimal={ratioText(ratio)}
      >
        {ratioText(ratio)}
      </dd>
    </>
  );
}

function WorkCenterCard({
  id,
  name,
  rest,
  shiftKey,
  bottlenecks,
  bottleneckState,
}: {
  readonly id: string;
  readonly name: string;
  readonly rest: OeeBucketDto | undefined;
  readonly shiftKey: string;
  /** Whether the MES's bottleneck is known yet (#233 review). */
  readonly bottleneckState: 'known' | 'loading' | 'unknown';
  /** The MES's bottleneck machines in this work center, with their products (#233). */
  readonly bottlenecks: readonly {
    equipment: EquipmentDto | undefined;
    id: string;
    products: readonly string[];
  }[];
}) {
  const bucket = useShiftBucket(id, rest, shiftKey);
  const result = bucket?.result;
  const titleId = useId();
  return (
    <li>
      <article
        aria-labelledby={titleId}
        data-testid={`oee-card-${id}`}
        data-oee={result ? ratioText(result.oee) : NOT_APPLICABLE}
        data-final={bucket ? String(bucket.final) : undefined}
        className="flex h-full flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4 shadow-sm"
      >
        <h3 id={titleId} className="font-semibold">
          {name}
        </h3>
        {result ? (
          <>
            <p>
              <span className="text-sm text-slate-700">OEE </span>
              <span
                className="text-3xl font-bold tabular-nums"
                data-testid={`oee-value-${id}`}
                data-decimal={ratioText(result.oee)}
              >
                {percentText(result.oee)}
              </span>
              <span
                className="ml-2 font-mono text-sm text-slate-700"
                data-decimal={ratioText(result.oee)}
              >
                {ratioText(result.oee)}
              </span>
            </p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 text-sm">
              <RatioRow label="Availability" ratio={result.availability} />
              <RatioRow label="Performance" ratio={result.performance} />
              <RatioRow label="Quality" ratio={result.quality} />
              <dt className="text-slate-700">Availability loss, own</dt>
              <dd className="text-right tabular-nums" data-testid={`oee-own-${id}`}>
                {result.losses ? minutesText(result.losses.availability.own.total) : NOT_APPLICABLE}
              </dd>
              <dt className="text-slate-700">Availability loss, external</dt>
              <dd className="text-right tabular-nums" data-testid={`oee-external-${id}`}>
                {result.losses
                  ? minutesText(result.losses.availability.external.total)
                  : NOT_APPLICABLE}
              </dd>
            </dl>
            <Flags bucket={bucket} />
          </>
        ) : (
          <p className="text-sm text-slate-700">No data for this shift.</p>
        )}
        {bottleneckState !== 'known' ? (
          <p
            data-testid={`bottleneck-${id}`}
            data-state={bottleneckState}
            className="rounded bg-slate-100 px-2 py-1 text-sm text-slate-900"
          >
            <span className="font-semibold">Bottleneck:</span>{' '}
            {bottleneckState === 'loading' ? 'loading…' : 'unknown (line OEE unavailable)'}
          </p>
        ) : bottlenecks.length > 0 ? (
          <p
            data-testid={`bottleneck-${id}`}
            data-state="known"
            data-equipment={bottlenecks.map((b) => b.id).join(',')}
            className="rounded bg-slate-100 px-2 py-1 text-sm text-slate-900"
          >
            <span className="font-semibold">Bottleneck:</span>{' '}
            {bottlenecks.map((b, index) => (
              <span key={b.id}>
                {index > 0 ? '; ' : ''}
                {b.equipment?.name ?? b.id} (<span className="font-mono">{b.id}</span>) for{' '}
                {b.products.join(', ')}
              </span>
            ))}
            , as the MES derives it. A work center&apos;s OEE is time-weighted over its machines,
            not line throughput: that is the line card.
          </p>
        ) : null}
      </article>
    </li>
  );
}

function MachineRow({
  id,
  equipment,
  rest,
  shiftKey,
  bottleneck,
}: {
  readonly id: string;
  readonly equipment: EquipmentDto | undefined;
  readonly rest: OeeBucketDto;
  readonly shiftKey: string;
  readonly bottleneck: boolean;
}) {
  const bucket = useShiftBucket(id, rest, shiftKey) ?? rest;
  const { result } = bucket;
  return (
    <tr
      data-testid={`oee-machine-${id}`}
      data-oee={ratioText(result.oee)}
      className="border-t border-slate-200"
    >
      <th scope="row" className="px-2 py-1 text-left font-medium">
        {equipment?.name ?? id}{' '}
        <span className="font-mono text-xs font-normal text-slate-700">{id}</span>
        {bottleneck ? (
          <span className="ml-1 rounded border border-slate-600 px-1 text-xs font-normal">
            Bottleneck
          </span>
        ) : null}
      </th>
      <RatioTd ratio={result.oee} />
      <RatioTd ratio={result.availability} />
      <RatioTd ratio={result.performance} />
      <RatioTd ratio={result.quality} />
      <td className="px-2 py-1 text-right tabular-nums">
        {result.losses ? minutesText(result.losses.availability.own.total) : NOT_APPLICABLE}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">
        {result.losses ? minutesText(result.losses.availability.external.total) : NOT_APPLICABLE}
      </td>
      <td className="px-2 py-1">
        <Flags bucket={bucket} />
      </td>
    </tr>
  );
}

function MachineTable({
  buckets,
  names: known,
  shiftKey,
  bottlenecks,
  bottleneckState,
}: {
  readonly buckets: readonly OeeBucketDto[];
  readonly names: Names;
  readonly shiftKey: string;
  readonly bottlenecks: ReadonlyMap<string, readonly string[]>;
  readonly bottleneckState: 'known' | 'loading' | 'unknown';
}) {
  if (buckets.length === 0) return <p className="mt-2 text-sm">No machine has data yet.</p>;
  return (
    <>
      {bottleneckState !== 'known' ? (
        <p
          className="mt-2 text-sm"
          data-testid="machine-bottleneck-state"
          data-state={bottleneckState}
        >
          Bottleneck:{' '}
          {bottleneckState === 'loading' ? 'loading…' : 'unknown (line OEE unavailable)'}
        </p>
      ) : null}
      <div className="relative mt-2 overflow-x-auto rounded-lg border border-slate-300 bg-white">
        <table className="w-full min-w-[44rem] text-sm">
          <caption className="sr-only">OEE per machine for the selected shift</caption>
          <thead className="bg-slate-100 text-left">
            <tr>
              <th scope="col" className="px-2 py-1">
                Machine
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                OEE
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                A
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                P
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Q
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Own loss
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                External loss
              </th>
              <th scope="col" className="px-2 py-1">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <MachineRow
                key={bucket.id}
                id={bucket.id}
                equipment={known.equipment.get(bucket.id)}
                rest={bucket}
                shiftKey={shiftKey}
                bottleneck={bottlenecks.has(bucket.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

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
  const byKey = new Map((hours.data?.buckets ?? []).map((bucket) => [bucket.key, bucket]));
  if (pushed) {
    const at = Date.parse(pushed.start);
    const shown = at >= start && at < end ? pickBucket(byKey.get(pushed.key), pushed) : undefined;
    if (shown) byKey.set(shown.key, shown);
  }
  const rows = [...byKey.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return (
    <EChart
      testId="hourly"
      title="OEE per hour"
      description={`${hourlyReading(rows)}; the table below lists every value.`}
      option={rows.some((hour) => hour.result.oee) ? hourlyOption(rows) : null}
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
      {hours.isPending ? <p className="text-sm">Loading hours…</p> : null}
      {rows.length > 0 ? (
        <p className="flex flex-wrap gap-x-4 text-xs text-slate-700">
          <span>
            <span aria-hidden="true" className="mr-1 inline-block size-2.5 bg-sky-700" />
            Final
          </span>
          <span>
            <span aria-hidden="true" className="mr-1 inline-block size-2.5 bg-slate-500" />
            Provisional
          </span>
          <span>Hours without planned time: n/a, no bar</span>
        </p>
      ) : null}
      {rows.length > 0 ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer">Hourly values</summary>
          <table className="mt-1 w-full">
            <thead>
              <tr className="text-left">
                <th scope="col">Hour</th>
                <th scope="col" className="text-right">
                  OEE
                </th>
                <th scope="col" className="pl-2">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((hour) => (
                <tr key={hour.key} data-testid={`hour-${hour.key}`}>
                  <td>{formatClockTime(hour.start)}</td>
                  <td className="text-right font-mono" data-decimal={ratioText(hour.result.oee)}>
                    {ratioText(hour.result.oee)}
                  </td>
                  <td className="pl-2">{hour.final ? 'Final' : 'Provisional'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </EChart>
  );
}

function WaterfallChart({ bucket }: { readonly bucket: OeeBucketDto | undefined }) {
  const steps = bucket ? waterfall(bucket.result) : null;
  return (
    <EChart
      testId="waterfall"
      title="Loss waterfall"
      description={`${steps ? waterfallReading(steps) : 'Loss waterfall'}; the table below lists every step.`}
      option={steps ? waterfallOption(steps) : null}
      empty={
        !bucket
          ? 'No data for this shift.'
          : 'No planned busy time in this shift, so there are no losses.'
      }
    >
      {steps ? (
        <>
          {!steps.consistent ? (
            <p role="alert" className="text-sm text-red-900">
              The losses sent do not add up; showing them as sent.
            </p>
          ) : null}
          <table className="mt-2 w-full text-sm">
            <caption className="sr-only">Loss waterfall steps</caption>
            <tbody>
              {steps.steps.map((step) => (
                <tr
                  key={step.key}
                  data-testid={`waterfall-${step.key}`}
                  data-kind={step.kind}
                  className={step.kind === 'total' ? 'font-semibold' : 'font-normal'}
                >
                  <th scope="row" className="py-0.5 text-left font-[inherit]">
                    {step.label}
                  </th>
                  <td
                    className="text-right tabular-nums"
                    title={`${stepSign(step)}${secondsText(step.ms)} exactly`}
                    data-seconds={secondsText(step.ms)}
                  >
                    {stepSign(step)} {minutesText(step.ms)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-slate-700">
            Minutes are rounded to 0.1 (half-up); the exact time of each step is in its tooltip. The
            steps add up exactly.
          </p>
        </>
      ) : null}
    </EChart>
  );
}

function ParetoTable({ pareto }: { readonly pareto: Pareto }) {
  const total = pareto.reasons.reduce((sum, row) => sum + row.ms, 0);
  const cumulative = pareto.reasons.map((_row, index) =>
    pareto.reasons.slice(0, index + 1).reduce((sum, row) => sum + row.ms, 0),
  );
  return (
    <>
      <table className="mt-2 w-full text-sm">
        <caption className="sr-only">Availability loss by reason</caption>
        <thead>
          <tr className="text-left">
            <th scope="col">Reason</th>
            <th scope="col">Loss</th>
            <th scope="col" className="text-right">
              Time
            </th>
            <th scope="col" className="text-right">
              Cum.
            </th>
          </tr>
        </thead>
        <tbody>
          {pareto.reasons.map((row, index) => (
            <tr key={`${row.reason}-${row.loss}`} data-testid={`pareto-${row.reason}`}>
              <td>{row.name}</td>
              <td>{row.loss === 'own' ? 'Own' : 'External'}</td>
              <td className="text-right tabular-nums">{minutesText(row.ms)}</td>
              <td className="text-right tabular-nums">
                {total > 0
                  ? `${String(Math.round(((cumulative[index] ?? 0) * 100) / total))} %`
                  : '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pareto.microStops.length > 0 ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer">Micro-stops by cause (performance loss)</summary>
          <ul className="mt-1">
            {pareto.microStops.map((row) => (
              <li key={row.cause ?? 'none'}>
                {row.cause ?? 'No cause'}: {minutesText(row.ms)} in {String(row.stops)} stops
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
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

  const chart = pareto.data && pareto.data.reasons.length > 0 ? paretoOption(pareto.data) : null;
  return (
    <EChart
      testId="pareto"
      title="Downtime Pareto"
      description={`${pareto.data ? paretoReading(pareto.data) : 'Availability loss by reason'}; the table below lists every reason.`}
      option={chart?.option ?? null}
      height={chart?.height ?? 200}
      empty={pareto.data ? 'No availability loss in this shift.' : undefined}
    >
      {pareto.isPending ? <p className="text-sm">Loading the Pareto…</p> : null}
      {pareto.isError ? (
        <QueryError what="the Pareto" error={pareto.error} onRetry={() => void pareto.refetch()} />
      ) : null}
      {pareto.data ? (
        <>
          <p className="text-sm">
            Own {minutesText(pareto.data.availability.own)} · external{' '}
            {minutesText(pareto.data.availability.external)}
          </p>
          {pareto.data.reasons.length === 0 ? null : <ParetoTable pareto={pareto.data} />}
        </>
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
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        Details for
      </label>
      <select
        id={id}
        data-testid="focus-select"
        value={focus}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="max-w-full rounded border border-slate-500 bg-white px-2 py-1 text-sm"
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
      </select>
    </div>
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
    <div className="mt-3 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
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

export function OeeDashboard() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
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
  const topics = [...known.workCenters.keys(), ...known.equipment.keys()].map((id) => `oee:${id}`);
  useLiveSubscriptions(topics.length > 0 ? [...topics, DOWNTIME_TOPIC] : []);

  const firstCenter = known.workCenters.keys().next().value;
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

  return (
    <section aria-labelledby="oee-title">
      <h1 ref={heading} id="oee-title" tabIndex={-1} className="text-2xl font-bold">
        OEE
      </h1>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
        <ShiftPicker
          selection={selection}
          onChange={(shift) => {
            void navigate({ search: (previous) => ({ ...previous, shift }) });
          }}
        />
        {data ? (
          <p className="text-sm text-slate-700">
            <time dateTime={data.start}>{formatPlantTime(data.start)}</time> to{' '}
            <time dateTime={data.end}>{formatPlantTime(data.end)}</time>
            {selection.isCurrent ? ' · live' : ''}
          </p>
        ) : null}
      </div>
      {selection.pending ? <p className="mt-4">Loading shifts…</p> : null}
      {selection.error ? (
        <div className="mt-4">
          <QueryError what="the shifts" error={selection.error} onRetry={selection.retry} />
        </div>
      ) : null}
      {!selection.pending && shiftKey === undefined && !selection.error ? (
        <p className="mt-4">No shift yet: the plant clock has not started.</p>
      ) : null}
      {equipment.isError ? (
        <div className="mt-4">
          <QueryError
            what="the equipment"
            error={equipment.error}
            onRetry={() => void equipment.refetch()}
          />
        </div>
      ) : null}
      {shiftOee.isError ? (
        <div className="mt-4">
          <QueryError
            what="the shift's OEE"
            error={shiftOee.error}
            onRetry={() => void shiftOee.refetch()}
          />
        </div>
      ) : null}
      {shiftOee.isPending && shiftKey !== undefined ? <p className="mt-4">Loading OEE…</p> : null}

      {data && shiftKey !== undefined ? (
        <>
          <section aria-labelledby="line-title" className="mt-6">
            <h2 id="line-title" className="text-xl font-semibold">
              Line
            </h2>
            <div className="mt-2">
              <LineOeeCard view={line} equipment={known.equipment} />
            </div>
          </section>
          <section aria-labelledby="wc-title" className="mt-6">
            <h2 id="wc-title" className="text-xl font-semibold">
              Work centers
            </h2>
            <ul className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
              {[...known.workCenters].map(([center, { name, members }]) => (
                <WorkCenterCard
                  key={center}
                  id={center}
                  name={name}
                  rest={data.workCenters.find((bucket) => bucket.id === center)}
                  shiftKey={shiftKey}
                  bottleneckState={line.bottleneckState}
                  bottlenecks={members.flatMap((member) => {
                    const products = bottlenecks.get(member);
                    return products
                      ? [{ id: member, equipment: known.equipment.get(member), products }]
                      : [];
                  })}
                />
              ))}
            </ul>
          </section>
          <section aria-labelledby="machines-title" className="mt-6">
            <h2 id="machines-title" className="text-xl font-semibold">
              Machines
            </h2>
            <MachineTable
              buckets={data.equipment}
              names={known}
              shiftKey={shiftKey}
              bottlenecks={bottlenecks}
              bottleneckState={line.bottleneckState}
            />
          </section>
          {focus !== undefined ? (
            <section aria-labelledby="details-title" className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="details-title" className="text-xl font-semibold">
                  Hours, losses and downtime
                </h2>
                <FocusPicker
                  focus={focus}
                  known={known}
                  onChange={(id) => {
                    void navigate({ search: (previous) => ({ ...previous, focus: id }) });
                  }}
                />
              </div>
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
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
