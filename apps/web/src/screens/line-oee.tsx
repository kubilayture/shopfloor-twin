import type {
  BottleneckDto,
  EquipmentDto,
  LineBucketDto,
  LineOeeDto,
} from '@shopfloor/contracts/mes-api';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useId } from 'react';
import { getLineOee } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { RatioHeadline, RatioValue, StatusFlags } from '../components/oee-ui.tsx';
import { QueryError } from '../components/query-error.tsx';
import {
  ABOVE_ONE_TEXT,
  cycleText,
  goodText,
  lineFlags,
  minutesText,
  parseFraction,
  pickBucket,
} from '../domain/oee.ts';
import { formatClockTime } from '../domain/time.ts';
import { useLiveLineOee } from '../live/live-context.tsx';

/** As the other OEE reads of the dashboard: read again this often while the shift is current. */
const LIVE_REFRESH_MS = 30_000;

export interface LineOeeView {
  /** The selected shift's line bucket: the pushed one over the REST one (`pickBucket`). */
  readonly shift: LineBucketDto | undefined;
  /** The shift's hours, by start, the pushed current hour merged in. */
  readonly hours: readonly LineBucketDto[];
  /** The MES's bottleneck per product (`deriveBottlenecks`, ADR-0036); empty until read. */
  readonly bottlenecks: readonly BottleneckDto[];
  readonly productionMode: LineOeeDto['productionMode'] | undefined;
  readonly shiftRead: UseQueryResult<LineOeeDto>;
  readonly hoursRead: UseQueryResult<LineOeeDto>;
}

/**
 * The line throughput OEE of one shift (#233): `GET /oee/line` per shift bucket and per hour
 * over the shift, followed live on `oee:line` (the current hour and shift and the bottlenecks).
 * `range` is undefined until the shift's span is known.
 */
export function useLineOee(
  shiftKey: string | undefined,
  range: { readonly start: number; readonly end: number } | undefined,
  live: boolean,
): LineOeeView {
  const enabled = shiftKey !== undefined && range !== undefined;
  const from = range?.start ?? 0;
  const to = range?.end ?? 0;
  const refetchInterval = live ? LIVE_REFRESH_MS : false;
  const shiftRead = useQuery({
    queryKey: queryKeys.lineOee('shift', shiftKey ?? ''),
    queryFn: ({ signal }) => getLineOee({ bucket: 'shift', from, to }, signal),
    enabled,
    refetchInterval,
  });
  const hoursRead = useQuery({
    queryKey: queryKeys.lineOee('hour', shiftKey ?? ''),
    queryFn: ({ signal }) => getLineOee({ bucket: 'hour', from, to }, signal),
    enabled,
    refetchInterval,
  });
  const pushed = useLiveLineOee();

  const restShift = shiftRead.data?.buckets.find((bucket) => bucket.key === shiftKey);
  const pushedShift = pushed?.shift;
  const shift = pickBucket<LineBucketDto>(
    restShift,
    pushedShift && pushedShift.key === shiftKey ? pushedShift : undefined,
  );
  const byKey = new Map((hoursRead.data?.buckets ?? []).map((bucket) => [bucket.key, bucket]));
  const hour = pushed?.hour;
  if (hour && range) {
    const at = Date.parse(hour.from);
    const shown =
      at >= range.start && at < range.end
        ? pickBucket<LineBucketDto>(byKey.get(hour.key), hour)
        : undefined;
    if (shown) byKey.set(shown.key, shown);
  }
  const hours = [...byKey.values()].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  return {
    shift,
    hours,
    bottlenecks: pushed?.bottlenecks ?? shiftRead.data?.bottlenecks ?? [],
    productionMode: pushed?.productionMode ?? shiftRead.data?.productionMode,
    shiftRead,
    hoursRead,
  };
}

function Bottlenecks({
  bottlenecks,
  equipment,
}: {
  readonly bottlenecks: readonly BottleneckDto[];
  readonly equipment: ReadonlyMap<string, EquipmentDto>;
}) {
  if (bottlenecks.length === 0) return null;
  return (
    <div className="text-sm" data-testid="line-bottlenecks">
      <h4 className="font-medium">Bottleneck per product (from the MES)</h4>
      <ul className="mt-1 flex flex-col gap-0.5">
        {bottlenecks.map((b) => (
          <li
            key={b.product}
            data-testid={`line-bottleneck-${b.product}`}
            data-operation={b.operation}
            data-equipment={b.equipment.join(',')}
          >
            <span className="font-semibold">{b.product}</span>: {b.operation} on{' '}
            {b.equipment.map((id) => equipment.get(id)?.name ?? id).join(', ')}, effective cycle{' '}
            {cycleText(b.effectiveCycleMs)} (ideal {cycleText(`${String(b.idealCycleMs)}/1`)} ÷{' '}
            {b.equipment.length} machine{b.equipment.length === 1 ? '' : 's'})
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-slate-700">
        The operation with the largest effective cycle on the routing (ideal cycle ÷ the machines
        that run it). It stays the bottleneck when only one CNC has work: that shows as a lower line
        OEE.
      </p>
    </div>
  );
}

function LineHours({
  hours,
  read,
}: {
  readonly hours: readonly LineBucketDto[];
  readonly read: LineOeeView['hoursRead'];
}) {
  return (
    <details className="text-sm" open>
      <summary className="cursor-pointer font-medium">Line OEE per hour</summary>
      {read.isError ? (
        <QueryError
          what="the hourly line OEE"
          error={read.error}
          onRetry={() => void read.refetch()}
        />
      ) : null}
      {hours.length === 0 ? (
        <p className="mt-1">{read.isPending ? 'Loading hours…' : 'No hours with data yet.'}</p>
      ) : (
        <table className="mt-1 w-full" data-testid="line-hours">
          <caption className="sr-only">Line throughput OEE per hour of the shift</caption>
          <thead>
            <tr className="text-left">
              <th scope="col">Hour</th>
              <th scope="col" className="text-right">
                Line OEE
              </th>
              <th scope="col" className="text-right">
                Packed good
              </th>
              <th scope="col" className="pl-2">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {hours.map((hour) => (
              <tr
                key={hour.key}
                data-testid={`line-hour-${hour.key}`}
                data-oee={hour.oee?.decimal ?? 'n/a'}
                data-final={String(hour.final)}
                data-above-one={String(hour.aboveOne)}
              >
                <td>{formatClockTime(hour.from)}</td>
                <td className="text-right">
                  <RatioValue ratio={hour.oee} />
                </td>
                <td className="text-right tabular-nums">{goodText(hour.good)}</td>
                <td className="pl-2">
                  {hour.final ? 'Final' : 'Provisional'}
                  {hour.aboveOne ? ', above 1' : ''}
                  {hour.incidents.length > 0 ? `, ${String(hour.incidents.length)} incidents` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

/**
 * The line card of the OEE dashboard (#233): the line throughput OEE of the selected shift (good
 * packed × the bottleneck's effective cycle ÷ the line's planned busy time, one ratio, not
 * capped), its hours, the bottleneck per product and the production mode.
 */
export function LineOeeCard({
  view,
  equipment,
}: {
  readonly view: LineOeeView;
  readonly equipment: ReadonlyMap<string, EquipmentDto>;
}) {
  const titleId = useId();
  const { shift, shiftRead } = view;
  return (
    <article
      aria-labelledby={titleId}
      data-testid="line-oee-card"
      data-key={shift?.key}
      data-oee={shift?.oee?.decimal ?? 'n/a'}
      data-final={shift ? String(shift.final) : undefined}
      data-above-one={shift ? String(shift.aboveOne) : undefined}
      className="flex flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4 shadow-sm"
    >
      <h3 id={titleId} className="font-semibold">
        Line A1 throughput (line OEE)
      </h3>
      {shiftRead.isError ? (
        <QueryError
          what="the line OEE"
          error={shiftRead.error}
          onRetry={() => void shiftRead.refetch()}
        />
      ) : null}
      {shift ? (
        <>
          <RatioHeadline label="Line OEE" ratio={shift.oee} testId="line-oee-value" />
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 text-sm">
            <dt className="text-slate-700">Packed good</dt>
            <dd className="text-right tabular-nums" data-testid="line-oee-good">
              {goodText(shift.good)}
            </dd>
            <dt className="text-slate-700">Ideal time at the bottleneck</dt>
            <dd className="text-right tabular-nums" data-testid="line-oee-ideal">
              {minutesText(parseFraction(shift.idealMs))}
            </dd>
            <dt className="text-slate-700">Line planned busy time</dt>
            <dd className="text-right tabular-nums" data-testid="line-oee-planned">
              {minutesText(shift.plannedBusyMs)}
            </dd>
          </dl>
          <StatusFlags flags={lineFlags(shift)} />
          {shift.aboveOne ? (
            <p className="text-sm text-amber-950" data-testid="line-oee-above-one">
              {ABOVE_ONE_TEXT}
            </p>
          ) : null}
        </>
      ) : shiftRead.isPending ? (
        <p className="text-sm">Loading the line OEE…</p>
      ) : (
        <p className="text-sm">No line OEE for this shift.</p>
      )}
      <p className="text-xs text-slate-700" data-testid="line-oee-mode">
        Good units packed × the bottleneck’s effective cycle ÷ the line’s planned busy time (the
        shift less breaks and the bottleneck’s maintenance
        {view.productionMode === 'orders' ? '; only while an order is in progress' : ''}). One
        ratio, no A × P × Q split; the machines’ waterfall is below.
      </p>
      <Bottlenecks bottlenecks={view.bottlenecks} equipment={equipment} />
      <LineHours hours={view.hours} read={view.hoursRead} />
    </article>
  );
}
