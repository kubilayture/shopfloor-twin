import type { OrderJobOeeDto, OrderOeeDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { ApiError, getOrderOee } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { FinalityBadge } from '../components/finality-badge.tsx';
import { NA_REASON, StatusFlags, ratioStat } from '../components/oee-ui.tsx';
import { QueryError } from '../components/query-error.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Duration, Missing, Percent, PlantTime } from '../components/ui/format.tsx';
import { Section } from '../components/ui/section.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { KpiTile } from '../components/ui/stat.tsx';
import {
  ABOVE_ONE_TEXT,
  orderFlags,
  orderLineFlags,
  orderPending,
  parseFraction,
  pickOrderOee,
} from '../domain/oee.ts';
import { useLiveOrderOee } from '../live/live-context.tsx';

const HEAD_SOURCE_TEXT: Record<NonNullable<OrderJobOeeDto['head']['source']>, string> = {
  accepted: 'its accepted fact',
  acceptedAt: 'the command result’s accepted time',
  'previous-completed': 'the previous job’s completion',
  'previous-last-cycle': 'the previous job’s last cycle',
  notBefore: 'its not-before time',
};

const HEAD_UNKNOWN_TEXT: Record<NonNullable<OrderJobOeeDto['head']['reason']>, string> = {
  'accepted-unknown': 'accepted time not known yet',
  'accepted-lost': 'accepted fact lost',
  'previous-completed-lost': 'previous job’s completion lost',
  'previous-completed-missing': 'previous job’s completion not seen yet',
};

function Head({ job }: { readonly job: OrderJobOeeDto }) {
  const { head } = job;
  if (head.kind === 'waiting') return <>Waiting in the queue</>;
  if (head.kind === 'unknown') {
    return <>Unknown ({head.reason ? HEAD_UNKNOWN_TEXT[head.reason] : 'not known'})</>;
  }
  return (
    <>
      {head.at === null ? <Missing reason="No head time" /> : <PlantTime at={head.at} />}
      {head.source ? (
        <span className="block text-xs text-ink-secondary">
          from {HEAD_SOURCE_TEXT[head.source]}
        </span>
      ) : null}
    </>
  );
}

/** A job's window: from its head time to its completion, "(open)" while it runs. */
function JobWindow({ job }: { readonly job: OrderJobOeeDto }) {
  const { window } = job;
  if (!window) return <Missing reason="No window yet: the job has not reached the head" />;
  return (
    <>
      <span className="whitespace-nowrap">
        <PlantTime at={window.from} />
      </span>{' '}
      to{' '}
      <span className="whitespace-nowrap">
        <PlantTime at={window.to} />
      </span>
      {window.open ? ' (open)' : ''}
      {window.headTimeUnknown ? (
        <span className="block text-xs text-warn-ink">from its start: no changeover</span>
      ) : null}
    </>
  );
}

/** The jobs table (design system 4.5): one row per job, the ratios as percentages. */
const JOB_COLUMNS: readonly Column<OrderJobOeeDto>[] = [
  {
    key: 'job',
    header: 'Job',
    rowHeader: true,
    nowrap: true,
    cell: (job) => <Code className="font-medium">{job.commandId}</Code>,
  },
  { key: 'cnc', header: 'CNC', nowrap: true, cell: (job) => <Code>{job.machine}</Code> },
  { key: 'head', header: 'Head time', priority: 3, cell: (job) => <Head job={job} /> },
  { key: 'window', header: 'Window', priority: 2, cell: (job) => <JobWindow job={job} /> },
  { key: 'cycles', header: 'Cycles', numeric: true, cell: (job) => job.cycles },
  {
    key: 'oee',
    header: 'OEE',
    numeric: true,
    cell: (job) => <Percent ratio={job.oee?.oee} na={NA_REASON.oee} />,
  },
  {
    key: 'availability',
    header: 'Availability',
    numeric: true,
    priority: 3,
    cell: (job) => <Percent ratio={job.oee?.availability} na={NA_REASON.availability} />,
  },
  {
    key: 'performance',
    header: 'Performance',
    numeric: true,
    priority: 3,
    cell: (job) => <Percent ratio={job.oee?.performance} na={NA_REASON.performance} />,
  },
  {
    key: 'quality',
    header: 'Quality',
    numeric: true,
    priority: 3,
    cell: (job) => <Percent ratio={job.oee?.quality} na={NA_REASON.quality} />,
  },
  {
    key: 'status',
    header: 'Status',
    nowrap: true,
    cell: (job) => <FinalityBadge final={job.final} />,
  },
];

/** Exact milliseconds (`num/den`) as a number, for display only. */
function msOf(text: string): number {
  const exact = parseFraction(text);
  return Number(exact.num) / Number(exact.den);
}

function OrderOeeTile({ order }: { readonly order: OrderOeeDto }) {
  const { oee } = order;
  return (
    <KpiTile
      title="Order OEE"
      testId="order-oee-card"
      headline={ratioStat('OEE', oee.oee, NA_REASON.oee, 'order-oee-oee')}
      details={[
        ratioStat(
          'Availability',
          oee.availability,
          NA_REASON.availability,
          'order-oee-availability',
        ),
        ratioStat('Performance', oee.performance, NA_REASON.performance, 'order-oee-performance'),
        ratioStat('Quality (OP10)', oee.quality, NA_REASON.quality, 'order-oee-quality'),
        {
          label: 'Planned busy time',
          value: <Duration ms={oee.totals.plannedBusyMs} />,
        },
      ]}
    >
      <p className="text-sm text-ink-secondary">
        OP10 cycles: <span className="tabular-nums text-ink">{oee.totals.produced}</span>, of which{' '}
        <span className="tabular-nums text-ink">{oee.totals.good}</span> good.
      </p>
      <StatusFlags flags={orderFlags(order)} />
      {oee.anomaly ? (
        <Callout tone="warn">
          Anomaly: cycles were counted although there was no production time.
        </Callout>
      ) : null}
    </KpiTile>
  );
}

function FirstPassYieldTile({ order }: { readonly order: OrderOeeDto }) {
  const fpy = order.firstPassYield;
  return (
    <KpiTile
      title="First-pass yield"
      testId="order-fpy"
      data-final={String(fpy.final)}
      data-yield={fpy.yield?.decimal ?? 'n/a'}
      headline={ratioStat('Yield', fpy.yield, NA_REASON.yield, 'order-fpy-yield')}
      details={[
        {
          label: 'Packed good first time',
          // The bare count: the specs read the element's text as the number.
          value: <span data-testid="order-fpy-good">{fpy.firstPassGood}</span>,
          unit: 'blanks',
        },
        {
          label: 'Blanks taken',
          value: <span data-testid="order-fpy-started">{fpy.started}</span>,
          unit: 'blanks',
        },
      ]}
    >
      <p className="text-sm text-ink-secondary">
        Packed good with every record good, across the routing. Beside the order OEE, never
        multiplied into it: OP10 quality alone hides the leak test’s scrap.
      </p>
      <StatusFlags
        flags={[
          fpy.final
            ? {
                key: 'final',
                text: 'Final',
                title: 'The order is complete: no unit can come back',
                tone: 'final',
              }
            : {
                key: 'provisional',
                text: 'Provisional',
                title: 'The order is not complete: units may still be packed or scrapped',
                tone: 'notice',
              },
        ]}
      />
    </KpiTile>
  );
}

/** Units packed good per product: "VB-100: 59", one product per line, never run together (Q-04). */
function PackedGood({ good }: { readonly good: Readonly<Record<string, number>> }) {
  const entries = Object.entries(good)
    .filter(([, n]) => n !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return <Missing reason="Nothing packed good yet" />;
  return (
    <ul className="flex flex-col">
      {entries.map(([product, n]) => (
        <li key={product}>
          <Code>{product}</Code>: <span className="tabular-nums">{n}</span>
        </li>
      ))}
    </ul>
  );
}

function OrderLineTile({ order }: { readonly order: OrderOeeDto }) {
  const { line } = order;
  if (!line) {
    return (
      <KpiTile
        title="Line OEE of this order"
        testId="order-line-oee"
        data-oee="n/a"
        headline={{
          label: 'Line OEE',
          missing: 'No job of this order is head of its CNC’s queue yet.',
        }}
      />
    );
  }
  return (
    <KpiTile
      title="Line OEE of this order"
      testId="order-line-oee"
      data-final={String(line.final)}
      data-oee={line.oee?.decimal ?? 'n/a'}
      data-above-one={String(line.aboveOne)}
      tone={line.aboveOne ? 'warn' : undefined}
      headline={ratioStat('Line OEE', line.oee, NA_REASON.line, 'order-line-oee-value')}
      details={[
        { label: 'Planned busy time', value: <Duration ms={line.plannedBusyMs} /> },
        { label: 'Ideal time at the bottleneck', value: <Duration ms={msOf(line.idealMs)} /> },
      ]}
    >
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          {/* Q-04: a completed order's window is its whole run, not "In progress". */}
          <dt className="text-xs font-medium text-ink-secondary">
            {line.open ? 'In progress' : 'Window'}
          </dt>
          <dd data-testid="order-line-window">
            <span className="whitespace-nowrap">
              <PlantTime at={line.from} />
            </span>{' '}
            to{' '}
            <span className="whitespace-nowrap">
              <PlantTime at={line.to} />
            </span>
            {line.open ? ' (open: to the plant clock)' : ''}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-ink-secondary">Packed good</dt>
          <dd data-testid="order-line-good">
            <PackedGood good={line.good} />
          </dd>
        </div>
      </dl>
      <StatusFlags flags={orderLineFlags(line)} />
      {line.aboveOne ? <Callout tone="warn">{ABOVE_ONE_TEXT}</Callout> : null}
      <p className="text-xs text-ink-secondary" data-testid="order-line-not-additive">
        Its own good units × the bottleneck’s effective cycle ÷ the line’s planned time while it was
        in progress. Not additive across orders: orders overlap in time.
      </p>
    </KpiTile>
  );
}

/**
 * The order's OEE (#233, ADR-0036): A, P, Q and OEE over its job windows, each job's head time,
 * window and OEE, the first-pass yield across the routing beside it, and the order's own line
 * OEE; read once and followed live on `oee:order:<id>`. The ratios are percentages; each keeps
 * the MES's four decimals in `data-decimal` and the exact fraction in `data-fraction` and its
 * tooltip (E-02).
 */
export function OrderOee({ id }: { readonly id: string }) {
  const read = useQuery({
    queryKey: queryKeys.orderOee(id),
    queryFn: ({ signal }) => getOrderOee(id, signal),
  });
  const pushed = useLiveOrderOee(id);
  const order = pickOrderOee(read.data, pushed);
  const missing = read.error instanceof ApiError && read.error.status === 404 && !order;
  return (
    <Section
      id="order-oee-title"
      testId="order-oee-section"
      title="OEE and first-pass yield"
      description="Over the order’s job windows on its CNCs: each from the job’s head time (its changeover counts against this order) to its completion."
    >
      {read.isPending && !order ? <Skeleton shape="card" label="Loading the order’s OEE…" /> : null}
      {missing ? (
        <div className="rounded-lg border border-line bg-surface px-4">
          <EmptyState
            size="inline"
            icon="info"
            testId="order-oee-missing"
            title="The MES has no OEE for this order"
            body="It has one once a job of the order is accepted."
          />
        </div>
      ) : read.isError && !order ? (
        <QueryError what="the order’s OEE" error={read.error} onRetry={() => void read.refetch()} />
      ) : null}
      {order ? (
        <div
          data-testid="order-oee"
          data-final={String(order.final)}
          data-oee={order.oee.oee?.decimal ?? 'n/a'}
          data-revision={String(order.revision)}
          data-incidents={String(order.incidents.length)}
          className="flex flex-col gap-4"
        >
          {!order.final ? (
            <p className="text-sm text-ink-secondary" data-testid="order-oee-pending">
              Provisional: {orderPending(order).join('; ')}.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <OrderOeeTile order={order} />
            <FirstPassYieldTile order={order} />
            <OrderLineTile order={order} />
          </div>
          {order.incidents.length > 0 ? (
            <Callout
              tone="warn"
              data-testid="order-oee-incidents"
              title="Written-off gaps under it (a final value may change)"
            >
              <ul>
                {order.incidents.map((incident) => (
                  <li key={`${incident.machine}-${String(incident.epoch)}-${String(incident.id)}`}>
                    <Code>{incident.machine}</Code>, run {incident.epoch}: sequence{' '}
                    {incident.seqFrom} to {incident.seqTo}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <Section level={3} title="Per job" description="One row per job of the order, by CNC.">
            <DataTable
              caption="OEE per job of the order"
              testId="order-oee-jobs"
              columns={JOB_COLUMNS}
              rows={order.jobs}
              rowKey={(job) => job.commandId}
              rowTestId={(job) => `order-oee-job-${job.commandId}`}
              rowProps={(job) => ({
                'data-final': String(job.final),
                'data-oee': job.oee?.oee?.decimal ?? 'n/a',
              })}
              narrow="stack"
              empty={
                <div className="px-4">
                  <EmptyState
                    size="inline"
                    icon="info"
                    testId="order-oee-jobs-empty"
                    title="No job accepted yet"
                  />
                </div>
              }
            />
          </Section>
        </div>
      ) : null}
    </Section>
  );
}
