import type {
  BottleneckDto,
  EquipmentDto,
  LineBucketDto,
  LineOeeDto,
} from '@shopfloor/contracts/mes-api';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getLineOee } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { NA_REASON, StatusFlags, ratioStat } from '../components/oee-ui.tsx';
import { QueryError } from '../components/query-error.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, Percent } from '../components/ui/format.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { Stat } from '../components/ui/stat.tsx';
import {
  ABOVE_ONE_TEXT,
  cycleText,
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
  /**
   * Whether the bottleneck is known (#233 review): `loading` until `GET /oee/line` or `oee:line`
   * answered, `unknown` when the read failed and nothing was pushed.
   */
  readonly bottleneckState: 'known' | 'loading' | 'unknown';
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
  const bottlenecks = pushed?.bottlenecks ?? shiftRead.data?.bottlenecks;
  return {
    shift,
    hours,
    bottlenecks: bottlenecks ?? [],
    bottleneckState:
      bottlenecks !== undefined ? 'known' : shiftRead.isError ? 'unknown' : 'loading',
    productionMode: pushed?.productionMode ?? shiftRead.data?.productionMode,
    shiftRead,
    hoursRead,
  };
}

/** Units packed good per product, one per line: "VB-100: 38" (never run together, Q-04). */
export function PackedGood({ good }: { readonly good: Readonly<Record<string, number>> }) {
  const entries = Object.entries(good)
    .filter(([, n]) => n !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return <Missing reason="Nothing packed good" />;
  return (
    // Phrasing content only: it sits inside a figure's `<span>` too.
    <span className="inline-flex flex-col">
      {entries.map(([product, n]) => (
        <span key={product} className="whitespace-nowrap">
          <Code>{product}</Code>: <span className="tabular-nums">{n}</span>
        </span>
      ))}
    </span>
  );
}

/** Exact milliseconds as minutes with one decimal, in tabular figures (the dashboard's unit). */
function Minutes({ ms, testId }: { readonly ms: number | string; readonly testId?: string }) {
  return (
    <span data-testid={testId} className="tabular-nums">
      {minutesText(typeof ms === 'number' ? ms : parseFraction(ms))}
    </span>
  );
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
    <div className="flex flex-col gap-1 text-sm" data-testid="line-bottlenecks">
      <h4 className="font-semibold text-ink">Bottleneck per product</h4>
      <ul className="flex flex-col gap-1">
        {bottlenecks.map((b) => (
          <li
            key={b.product}
            data-testid={`line-bottleneck-${b.product}`}
            data-operation={b.operation}
            data-equipment={b.equipment.join(',')}
          >
            <Code className="font-medium">{b.product}</Code>: {b.operation} on{' '}
            {b.equipment.map((id) => equipment.get(id)?.name ?? id).join(', ')}
            <span className="block text-xs text-ink-secondary">
              Effective cycle <span className="tabular-nums">{cycleText(b.effectiveCycleMs)}</span>{' '}
              (ideal{' '}
              <span className="tabular-nums">{cycleText(`${String(b.idealCycleMs)}/1`)}</span> ÷{' '}
              {b.equipment.length} machine{b.equipment.length === 1 ? '' : 's'})
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-secondary">
        As the MES derives it: the operation with the largest effective cycle on the routing. It
        stays the bottleneck when only one CNC has work; that shows as a lower line OEE.
      </p>
    </div>
  );
}

/** An hour row's status as text: finality, revision, incidents, may be revised, above 1. */
export function hourStatus(hour: LineBucketDto): string {
  const n = hour.incidents.length;
  return [
    hour.final ? 'Final' : 'Provisional',
    ...(hour.revision > 0 ? [`revision ${String(hour.revision)}`] : []),
    ...(n > 0 ? [`${String(n)} incident${n === 1 ? '' : 's'}`] : []),
    ...(hour.mayRevise ? ['may be revised'] : []),
    ...(hour.aboveOne ? ['above 1'] : []),
  ].join(', ');
}

/** Whether an hour has anything to show: a line OEE or units packed good. */
function hasData(hour: LineBucketDto): boolean {
  return hour.oee !== null || Object.values(hour.good).some((n) => n !== 0);
}

const HOUR_COLUMNS: readonly Column<LineBucketDto>[] = [
  {
    key: 'hour',
    header: 'Hour',
    rowHeader: true,
    nowrap: true,
    cell: (hour) => (
      <time dateTime={hour.from} className="tabular-nums">
        {formatClockTime(hour.from)}
      </time>
    ),
  },
  {
    key: 'oee',
    header: 'Line OEE',
    numeric: true,
    cell: (hour) => <Percent ratio={hour.oee} na={NA_REASON.line} />,
  },
  { key: 'good', header: 'Packed good', cell: (hour) => <PackedGood good={hour.good} /> },
  { key: 'status', header: 'Status', cell: (hour) => hourStatus(hour) },
];

function LineHours({
  hours,
  read,
}: {
  readonly hours: readonly LineBucketDto[];
  readonly read: LineOeeView['hoursRead'];
}) {
  // E-01: the hours without planned line time (the rest of a running shift, an idle hour) are
  // counted, not listed as rows of dashes.
  const shown = hours.filter(hasData);
  const left = hours.length - shown.length;
  return (
    <Disclosure summary="Line OEE per hour" defaultOpen>
      {read.isError ? (
        <QueryError
          what="the hourly line OEE"
          error={read.error}
          onRetry={() => void read.refetch()}
        />
      ) : read.isPending && hours.length === 0 ? (
        <Skeleton shape="table" rows={3} label="Loading hours…" />
      ) : (
        <div className="flex flex-col gap-2">
          <DataTable
            caption="Line throughput OEE per hour of the shift"
            testId="line-hours"
            columns={HOUR_COLUMNS}
            rows={shown}
            rowKey={(hour) => hour.key}
            rowTestId={(hour) => `line-hour-${hour.key}`}
            rowProps={(hour) => ({
              'data-oee': hour.oee?.decimal ?? 'n/a',
              'data-final': String(hour.final),
              'data-above-one': String(hour.aboveOne),
              'data-revision': String(hour.revision),
              'data-may-revise': String(hour.mayRevise),
            })}
            density="compact"
            narrow="stack"
            empty={
              <div className="px-4">
                <EmptyState size="inline" icon="info" title="No hour with planned line time yet" />
              </div>
            }
          />
          {left > 0 && shown.length > 0 ? (
            <p className="text-xs text-ink-secondary">
              {left} hour{left === 1 ? '' : 's'} without planned line time not listed.
            </p>
          ) : null}
        </div>
      )}
    </Disclosure>
  );
}

/** How the line OEE is computed, said once as a hint under the figures. */
function ModeHint({ mode }: { readonly mode: LineOeeView['productionMode'] }) {
  return (
    <p className="text-xs text-ink-secondary" data-testid="line-oee-mode">
      Good units packed × the bottleneck’s effective cycle ÷ the line’s planned busy time (the shift
      less breaks and the bottleneck’s maintenance
      {mode === 'orders' ? '; only while an order is in progress' : ''}). One ratio, no A × P × Q
      split: the machines’ losses are in the waterfall below.
    </p>
  );
}

/** The figures of a shift with line time: the headline, its inputs, its status. */
function LineFigures({ shift }: { readonly shift: LineBucketDto }) {
  return (
    <>
      <Stat
        {...ratioStat('Line OEE', shift.oee, NA_REASON.line, 'line-oee-value')}
        emphasis="headline"
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Stat
          label="Packed good"
          emphasis="compact"
          value={
            <span data-testid="line-oee-good" className="text-sm font-normal">
              <PackedGood good={shift.good} />
            </span>
          }
        />
        <Stat
          label="Ideal time at the bottleneck"
          emphasis="compact"
          value={<Minutes ms={shift.idealMs} testId="line-oee-ideal" />}
        />
        <Stat
          label="Line planned busy time"
          emphasis="compact"
          value={<Minutes ms={shift.plannedBusyMs} testId="line-oee-planned" />}
        />
      </div>
      <StatusFlags flags={lineFlags(shift)} />
      {shift.aboveOne ? (
        <Callout tone="warn" data-testid="line-oee-above-one">
          {ABOVE_ONE_TEXT}
        </Callout>
      ) : null}
    </>
  );
}

/**
 * The line card of the OEE dashboard (#233): the line throughput OEE of the selected shift (good
 * packed × the bottleneck's effective cycle ÷ the line's planned busy time, one ratio, not
 * capped), its hours, the bottleneck per product and the production mode. A shift without line
 * time (no order in progress) is an empty state with its reason, not a card of dashes (E-01).
 */
export function LineOeeCard({
  view,
  equipment,
}: {
  readonly view: LineOeeView;
  readonly equipment: ReadonlyMap<string, EquipmentDto>;
}) {
  const { shift, shiftRead } = view;
  const idle = shift?.oee === null;
  return (
    <Card
      as="article"
      headingLevel={3}
      title="Line A1 throughput"
      description="The line OEE of the shift: what the line packed against what its bottleneck could."
      tone={shift?.aboveOne ? 'warn' : undefined}
      testId="line-oee-card"
      data-key={shift?.key}
      data-oee={shift?.oee?.decimal ?? 'n/a'}
      data-final={shift ? String(shift.final) : undefined}
      data-above-one={shift ? String(shift.aboveOne) : undefined}
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          {shiftRead.isError ? (
            <QueryError
              what="the line OEE"
              error={shiftRead.error}
              onRetry={() => void shiftRead.refetch()}
            />
          ) : null}
          {shift && !idle ? (
            <LineFigures shift={shift} />
          ) : shift && idle ? (
            <>
              <EmptyState
                size="inline"
                icon="info"
                testId="line-oee-idle"
                title="No line time this shift"
                body={
                  view.productionMode === 'orders'
                    ? 'No order was in progress, so the line had no planned busy time and its OEE does not apply.'
                    : 'The line had no planned busy time, so its OEE does not apply.'
                }
              />
              <StatusFlags flags={lineFlags(shift)} />
            </>
          ) : shiftRead.isPending ? (
            <Skeleton shape="stat" label="Loading the line OEE…" />
          ) : shiftRead.isError ? null : (
            <EmptyState
              size="inline"
              icon="info"
              title="No line OEE for this shift"
              body="The MES has no line bucket for it."
            />
          )}
          <ModeHint mode={view.productionMode} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Bottlenecks bottlenecks={view.bottlenecks} equipment={equipment} />
          <LineHours hours={view.hours} read={view.hoursRead} />
        </div>
      </div>
    </Card>
  );
}
