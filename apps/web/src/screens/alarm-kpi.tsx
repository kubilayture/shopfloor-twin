import {
  ALARMS_TOPIC,
  type AlarmKpiBucketDto,
  type AlarmScopes,
} from '@shopfloor/contracts/mes-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, type ReactNode } from 'react';
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
import { alarmHourlyOption } from '../chart/alarm-options.ts';
import { EChart } from '../chart/echart.tsx';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { ShiftPicker, useShiftSelection } from '../components/shift-picker.tsx';
import {
  alarmBucketFlags,
  meanTimeToAck,
  msText,
  parseScopeKey,
  rateBand,
  rateBandText,
  scopeKey,
  windowLabel,
} from '../domain/alarms.ts';
import { NOT_APPLICABLE, percentText, pickBucket } from '../domain/oee.ts';
import { formatClockTime, formatPlantTime } from '../domain/time.ts';
import { useLiveAlarmKpi, useLiveAlarms, useLiveSubscriptions } from '../live/live-context.tsx';

const HOUR = 3_600_000;
/** How far back the shift buckets of the bucket table reach. */
const SHIFT_BUCKETS_MS = 7 * 24 * HOUR;
/** Floods, bad actors and operator measures are read again at most this often while live. */
const REREAD_THROTTLE_MS = 2_000;

type Scope = AlarmScopes['scopes'][number];

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

function Flags({ bucket }: { readonly bucket: AlarmKpiBucketDto }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Status">
      {alarmBucketFlags(bucket).map((flag) => (
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

function RateText({ bucket }: { readonly bucket: AlarmKpiBucketDto }) {
  // The benchmarks are the MES's (#160): no band until they arrived.
  const config = useAlarmConfig();
  const band = config ? rateBand(bucket.averageRate, config) : undefined;
  return (
    <span title={bucket.averageRate.fraction}>
      <span className="font-mono tabular-nums">{bucket.averageRate.decimal}</span>{' '}
      {config && band ? (
        <span
          data-band={band}
          className={`rounded px-1 text-xs font-medium ${
            band === 'acceptable'
              ? 'bg-emerald-50 text-emerald-900'
              : band === 'manageable'
                ? 'bg-amber-100 text-amber-950'
                : 'bg-red-700 text-white'
          }`}
        >
          {rateBandText(band, config)}
        </span>
      ) : null}
    </span>
  );
}

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

/** One scope's KPIs over the shift: the pushed shift bucket over the REST one (`pickBucket`). */
function ScopeCard({
  scope,
  range,
  shiftKey,
}: {
  readonly scope: Scope;
  readonly range: { readonly from: number; readonly to: number };
  readonly shiftKey: string;
}) {
  const key = scopeKey(scope);
  const titleId = useId();
  const rest = useQuery({
    queryKey: queryKeys.alarmKpi(key, 'shift', range.from, range.to),
    queryFn: ({ signal }) =>
      getAlarmKpi({ ...scope, bucket: 'shift', from: range.from, to: range.to }, signal),
  });
  const pushed = useLiveAlarmKpi(key)?.shift;
  const bucket = pickBucket(
    rest.data?.buckets.find((candidate) => candidate.key === shiftKey),
    pushed?.key === shiftKey ? pushed : undefined,
  );
  const na = <span>{NOT_APPLICABLE}</span>;
  // The window as served (#160, #147): `10 min` by default, `window` until the answer arrived.
  const per = windowLabel(useAlarmConfig()?.kpi.windowMs);
  return (
    <li>
      <article
        aria-labelledby={titleId}
        data-testid={`kpi-card-${testKey(key)}`}
        data-raises={bucket ? String(bucket.raises) : NOT_APPLICABLE}
        data-final={bucket ? String(bucket.final) : undefined}
        data-revision={bucket ? String(bucket.revision) : undefined}
        className="flex h-full flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4 shadow-sm"
      >
        <h3 id={titleId} className="font-semibold">
          {scope.name}
        </h3>
        {rest.isError ? (
          <QueryError what="the KPIs" error={rest.error} onRetry={() => void rest.refetch()} />
        ) : null}
        {bucket ? <Flags bucket={bucket} /> : null}
        {!bucket && rest.data ? (
          <p className="text-sm" data-testid={`kpi-empty-${testKey(key)}`}>
            No alarm KPIs for this shift yet: n/a.
          </p>
        ) : null}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
          <Measure name="raises" label="Raises (high / medium / low)">
            {bucket ? (
              <>
                <span className="font-semibold">{bucket.raises}</span> ({bucket.byPriority.high} /{' '}
                {bucket.byPriority.medium} / {bucket.byPriority.low})
              </>
            ) : (
              na
            )}
          </Measure>
          <Measure name="average-rate" label={`Average per ${per}`}>
            {bucket ? <RateText bucket={bucket} /> : na}
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
          <Measure name="standing" label="Standing (active at end)">
            {bucket ? `${String(bucket.standing.length)} (${String(bucket.activeAtEnd)})` : na}
          </Measure>
          <Measure name="active-time" label="Active time">
            {bucket ? msText(bucket.activeMs) : na}
          </Measure>
        </dl>
      </article>
    </li>
  );
}

function bucketLabel(bucket: AlarmKpiBucketDto): string {
  return bucket.bucket === 'hour'
    ? `${formatClockTime(bucket.from)}–${formatClockTime(bucket.to)}`
    : bucket.key;
}

/** REST buckets with the pushed one of the same key over them, or added when it is new. */
function withPushed(
  rest: readonly AlarmKpiBucketDto[],
  pushed: AlarmKpiBucketDto | null | undefined,
  range: { readonly from: number; readonly to: number },
): AlarmKpiBucketDto[] {
  if (!pushed) return [...rest];
  const inRange = Date.parse(pushed.from) >= range.from && Date.parse(pushed.from) < range.to;
  const merged = rest.map((bucket) =>
    bucket.key === pushed.key ? (pickBucket(bucket, pushed) ?? bucket) : bucket,
  );
  if (inRange && !rest.some((bucket) => bucket.key === pushed.key)) merged.push(pushed);
  return merged.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
}

function BucketTable({
  scope,
  bucket,
  range,
}: {
  readonly scope: AlarmScopeRef;
  readonly bucket: 'hour' | 'shift';
  readonly range: { readonly from: number; readonly to: number };
}) {
  const key = scopeKey(scope);
  const rest = useQuery({
    queryKey: queryKeys.alarmKpi(key, bucket, range.from, range.to),
    queryFn: ({ signal }) =>
      getAlarmKpi({ ...scope, bucket, from: range.from, to: range.to }, signal),
  });
  const live = useLiveAlarmKpi(key);
  const config = useAlarmConfig();
  const per = windowLabel(config?.kpi.windowMs);
  const buckets = withPushed(rest.data?.buckets ?? [], live?.[bucket], range);
  return (
    <div className="flex flex-col gap-3">
      {rest.isError ? (
        <QueryError what="the buckets" error={rest.error} onRetry={() => void rest.refetch()} />
      ) : null}
      {bucket === 'hour' ? (
        <EChart
          testId="kpi-hourly"
          title={`Raises and peak per ${per}, by hour`}
          description={`Bars per hour of raises and of the most raises in one ${per} window, with the flood threshold as a dashed line; the table below lists every value.`}
          option={
            buckets.length > 0
              ? alarmHourlyOption(buckets, config?.kpi.floodThreshold, config?.kpi.windowMs)
              : null
          }
        >
          {buckets.length === 0 && rest.data ? (
            <p className="text-sm">No hour with alarms in this shift.</p>
          ) : null}
        </EChart>
      ) : null}
      <div className="relative min-w-0 overflow-x-auto rounded-lg border border-slate-300 bg-white">
        <table
          className="w-full min-w-[48rem] text-sm"
          data-testid="kpi-buckets"
          data-bucket={bucket}
        >
          <caption className="sr-only">
            Alarm KPIs per {bucket === 'hour' ? 'hour of the shift' : 'shift of the last week'}
          </caption>
          <thead className="bg-slate-100 text-left">
            <tr>
              <th scope="col" className="px-2 py-1">
                {bucket === 'hour' ? 'Hour' : 'Shift'}
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Raises
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Avg / {per}
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Peak
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Flood windows
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Flood time
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Chattering
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Fleeting
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Standing
              </th>
              <th scope="col" className="px-2 py-1">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((row) => (
              <tr
                key={row.key}
                data-testid={`kpi-row-${row.key}`}
                data-final={String(row.final)}
                data-revision={String(row.revision)}
                className="border-t border-slate-200"
              >
                <th scope="row" className="px-2 py-1 text-left font-normal">
                  {bucketLabel(row)}
                </th>
                <td className="px-2 py-1 text-right tabular-nums">{row.raises}</td>
                <td className="px-2 py-1 text-right font-mono" title={row.averageRate.fraction}>
                  {row.averageRate.decimal}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{row.peak10}</td>
                <td className="px-2 py-1 text-right tabular-nums">{row.floodWindows}</td>
                <td className="px-2 py-1 text-right">{msText(row.floodMs)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{row.chatteringRaises}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {row.fleeting}
                  {row.fleetingUndecided > 0 ? ` +${String(row.fleetingUndecided)}?` : ''}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{row.standing.length}</td>
                <td className="px-2 py-1">
                  <Flags bucket={row} />
                </td>
              </tr>
            ))}
            {rest.data && buckets.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-2 py-3">
                  No buckets with alarms.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FloodTable({
  scope,
  range,
  live,
}: {
  readonly scope: AlarmScopeRef;
  readonly range: { readonly from: number; readonly to: number };
  readonly live: boolean;
}) {
  const key = scopeKey(scope);
  const queryKey = queryKeys.alarmFloods(key, range.from, range.to);
  const floods = useQuery({
    queryKey,
    queryFn: ({ signal }) => getFloods({ ...scope, ...range }, signal),
  });
  useThrottledReread(useLiveAlarmKpi(key), queryKey, live);
  return (
    <section aria-labelledby="kpi-floods-title" className="min-w-0">
      <h3 id="kpi-floods-title" className="font-semibold">
        Flood episodes
      </h3>
      {floods.isError ? (
        <QueryError what="the floods" error={floods.error} onRetry={() => void floods.refetch()} />
      ) : null}
      <div className="relative mt-1 overflow-x-auto rounded-lg border border-slate-300 bg-white">
        <table className="w-full min-w-[30rem] text-sm" data-testid="kpi-floods">
          <caption className="sr-only">Sliding flood episodes in the shift</caption>
          <thead className="bg-slate-100 text-left">
            <tr>
              <th scope="col" className="px-2 py-1">
                Start
              </th>
              <th scope="col" className="px-2 py-1">
                End
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Peak
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Raises
              </th>
              <th scope="col" className="px-2 py-1">
                Started by
              </th>
            </tr>
          </thead>
          <tbody>
            {floods.data?.episodes.map((episode) => (
              <tr
                key={episode.id}
                data-testid={`flood-${episode.id}`}
                data-open={String(episode.endAt === null)}
                className="border-t border-slate-200"
              >
                <td className="px-2 py-1">
                  <time dateTime={episode.startAt}>{formatPlantTime(episode.startAt)}</time>
                </td>
                <td className="px-2 py-1">
                  {episode.endAt ? (
                    <time dateTime={episode.endAt}>{formatPlantTime(episode.endAt)}</time>
                  ) : (
                    <span className="font-semibold text-red-900">In flood</span>
                  )}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{episode.peak}</td>
                <td className="px-2 py-1 text-right tabular-nums">{episode.raises}</td>
                <td className="px-2 py-1">
                  {episode.equipment} {episode.code}
                </td>
              </tr>
            ))}
            {floods.data?.episodes.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-3">
                  No flood in this shift.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BadActorTable({
  scope,
  range,
  live,
}: {
  readonly scope: AlarmScopeRef;
  readonly range: { readonly from: number; readonly to: number };
  readonly live: boolean;
}) {
  const key = scopeKey(scope);
  const queryKey = queryKeys.badActors(key, range.from, range.to);
  const actors = useQuery({
    queryKey,
    queryFn: ({ signal }) => getBadActors({ ...scope, ...range }, signal),
  });
  useThrottledReread(useLiveAlarmKpi(key), queryKey, live);
  return (
    <section aria-labelledby="kpi-bad-actors-title" className="min-w-0">
      <h3 id="kpi-bad-actors-title" className="font-semibold">
        Top 10 bad actors
      </h3>
      {actors.isError ? (
        <QueryError
          what="the bad actors"
          error={actors.error}
          onRetry={() => void actors.refetch()}
        />
      ) : null}
      <div className="relative mt-1 overflow-x-auto rounded-lg border border-slate-300 bg-white">
        <table className="w-full min-w-[30rem] text-sm" data-testid="kpi-bad-actors">
          <caption className="sr-only">
            Alarm points with the most raises in the shift, most first
          </caption>
          <thead className="bg-slate-100 text-left">
            <tr>
              <th scope="col" className="px-2 py-1 text-right">
                #
              </th>
              <th scope="col" className="px-2 py-1">
                Point
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Raises
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Share
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Active time
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                Chattering
              </th>
            </tr>
          </thead>
          <tbody>
            {actors.data?.actors.map((actor, index) => (
              <tr
                key={`${actor.equipment}/${actor.code}`}
                data-testid={`bad-actor-${actor.equipment}-${actor.code}`}
                data-raises={String(actor.raises)}
                className="border-t border-slate-200"
              >
                <td className="px-2 py-1 text-right tabular-nums">{index + 1}</td>
                <td className="px-2 py-1">
                  {actor.equipment} <span className="font-mono text-xs">{actor.code}</span>
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{actor.raises}</td>
                <td className="px-2 py-1 text-right" title={actor.share.fraction}>
                  {percentText(actor.share)}
                </td>
                <td className="px-2 py-1 text-right">{msText(actor.activeMs)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{actor.chatteringRaises}</td>
              </tr>
            ))}
            {actors.data?.actors.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-3">
                  No alarm in this shift.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OperatorMeasures({
  scope,
  range,
  live,
}: {
  readonly scope: AlarmScopeRef;
  readonly range: { readonly from: number; readonly to: number };
  readonly live: boolean;
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
  const na = NOT_APPLICABLE;
  return (
    <section
      aria-labelledby="kpi-operator-title"
      data-testid="kpi-operator"
      data-provisional={bucket ? String(bucket.provisional) : undefined}
      className="min-w-0 rounded-lg border border-slate-300 bg-white p-4"
    >
      <h3 id="kpi-operator-title" className="font-semibold">
        Operator measures
      </h3>
      <p className="text-xs text-slate-700">
        MES only, not reconciled with the ground truth: they depend on what operators do.
        {bucket?.provisional ? ' Provisional: the shift is not over.' : ''}
      </p>
      {measures.isError ? (
        <QueryError
          what="the operator measures"
          error={measures.error}
          onRetry={() => void measures.refetch()}
        />
      ) : null}
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
        <Measure name="annunciated" label="Annunciated raises">
          {bucket ? bucket.annunciatedRaises : na}
        </Measure>
        <Measure name="shelved-raises" label="Raises while shelved">
          {bucket ? bucket.shelvedRaises : na}
        </Measure>
        <Measure name="acknowledged" label="Acknowledged">
          {bucket ? bucket.timeToAck.count : na}
        </Measure>
        <Measure name="mean-time-to-ack" label="Mean time to acknowledge">
          {bucket ? meanTimeToAck(bucket.timeToAck) : na}
        </Measure>
        <Measure name="max-time-to-ack" label="Longest time to acknowledge">
          {bucket ? msText(bucket.timeToAck.maxMs) : na}
        </Measure>
        <Measure name="unacknowledged" label="Unacknowledged at the end">
          {bucket ? bucket.unacknowledgedAtEnd : na}
        </Measure>
      </dl>
      {bucket && bucket.shelvedMs.length > 0 ? (
        <>
          <h4 className="mt-2 text-sm font-medium">Shelved time per point</h4>
          <ul className="text-sm" data-testid="kpi-shelved-points">
            {bucket.shelvedMs.map((point) => (
              <li key={`${point.equipment}/${point.code}`}>
                {point.equipment} <span className="font-mono text-xs">{point.code}</span>:{' '}
                {msText(point.ms)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function AlarmKpi() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const search = useSearch({ from: '/alarms/kpi' });
  const navigate = useNavigate({ from: '/alarms/kpi' });
  const selection = useShiftSelection(search.shift);
  const shiftKey = selection.selected;
  const focusId = useId();
  const bucketId = useId();
  const { clock } = usePlantClock();
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
  const range = shift ? { from: Date.parse(shift.start), to: Date.parse(shift.end) } : undefined;
  const watermark = clock ? Date.parse(clock.watermark) : undefined;
  const weekTo = watermark === undefined ? undefined : Math.floor(watermark / HOUR) * HOUR + HOUR;

  // Live: the plant and every position (cards), and the focus (an equipment as well), plus
  // `alarms` for the operator measures; at most a handful of the MES's 16 alarm KPI topics.
  const topics = [...new Set([...cards, ...(focus ? [focus] : [])].map(scopeKey))].map(
    (key) => `alarm-kpi:${key}`,
  );
  useLiveSubscriptions(topics.length > 0 ? [...topics, ALARMS_TOPIC] : []);
  const live = selection.isCurrent;
  const machineName = (id: string) => equipment.data?.find((item) => item.id === id)?.name ?? id;

  return (
    <section aria-labelledby="alarm-kpi-title">
      <h1 ref={heading} id="alarm-kpi-title" tabIndex={-1} className="text-2xl font-bold">
        Alarm KPIs
      </h1>
      <p className="mt-1 text-sm text-slate-700">
        ISA-18.2 and EEMUA 191 measures per operator position and for the plant, exact as the MES
        computes them. Every raise counts, shelved or not.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
        <ShiftPicker
          selection={selection}
          onChange={(key) => {
            void navigate({ search: (previous) => ({ ...previous, shift: key }) });
          }}
        />
        {shift ? (
          <p className="text-sm text-slate-700">
            <time dateTime={shift.start}>{formatPlantTime(shift.start)}</time> to{' '}
            <time dateTime={shift.end}>{formatPlantTime(shift.end)}</time>
            {live ? ' · live' : ''}
          </p>
        ) : null}
      </div>
      {selection.pending ? <p className="mt-4">Loading shifts…</p> : null}
      {selection.error ? (
        <div className="mt-4">
          <QueryError what="the shifts" error={selection.error} onRetry={selection.retry} />
        </div>
      ) : null}
      {scopes.isError ? (
        <div className="mt-4">
          <QueryError
            what="the alarm scopes"
            error={scopes.error}
            onRetry={() => void scopes.refetch()}
          />
        </div>
      ) : null}
      {!selection.pending && !selection.error && shiftKey !== undefined && !range ? (
        <p className="mt-4">Choose a shift of the last week from the list.</p>
      ) : null}
      {!selection.pending && shiftKey === undefined && !selection.error ? (
        <p className="mt-4">No shift yet: the plant clock has not started.</p>
      ) : null}

      {range && shiftKey ? (
        <ul
          className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          aria-label="Alarm KPIs of the shift per scope"
        >
          {cards.map((scope) => (
            <ScopeCard key={scopeKey(scope)} scope={scope} range={range} shiftKey={shiftKey} />
          ))}
        </ul>
      ) : null}

      {range && focus ? (
        <section aria-labelledby="kpi-details-title" className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
            <h2 id="kpi-details-title" className="text-xl font-semibold">
              Details: {focus.scope === 'equipment' ? machineName(focus.id) : focus.name}
            </h2>
            <div className="flex items-center gap-2">
              <label htmlFor={focusId} className="text-sm font-medium">
                Details for
              </label>
              <select
                id={focusId}
                data-testid="kpi-focus"
                value={scopeKey(focus)}
                onChange={(event) => {
                  const value = event.target.value;
                  void navigate({ search: (previous) => ({ ...previous, focus: value }) });
                }}
                className="max-w-full rounded border border-slate-500 bg-white px-2 py-1 text-sm"
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
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor={bucketId} className="text-sm font-medium">
                Buckets
              </label>
              <select
                id={bucketId}
                data-testid="kpi-bucket"
                value={bucket}
                onChange={(event) => {
                  const value = event.target.value === 'shift' ? 'shift' : 'hour';
                  void navigate({ search: (previous) => ({ ...previous, bucket: value }) });
                }}
                className="rounded border border-slate-500 bg-white px-2 py-1 text-sm"
              >
                <option value="hour">Hours of the shift</option>
                <option value="shift">Shifts of the last week</option>
              </select>
            </div>
          </div>
          {bucket === 'hour' ? (
            <BucketTable scope={focus} bucket="hour" range={range} />
          ) : weekTo === undefined ? (
            <p>No plant clock yet.</p>
          ) : (
            <BucketTable
              scope={focus}
              bucket="shift"
              range={{ from: weekTo - SHIFT_BUCKETS_MS, to: weekTo }}
            />
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <FloodTable scope={focus} range={range} live={live} />
            <BadActorTable scope={focus} range={range} live={live} />
          </div>
          <OperatorMeasures scope={focus} range={range} live={live} />
        </section>
      ) : null}
    </section>
  );
}
