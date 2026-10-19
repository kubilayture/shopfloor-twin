import type { OrderJobOeeDto, OrderOeeDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError, getOrderOee } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { NA_REASON, RatioHeadline, RatioValue, StatusFlags } from '../components/oee-ui.tsx';
import { QueryError } from '../components/query-error.tsx';
import {
  ABOVE_ONE_TEXT,
  goodText,
  minutesText,
  orderFlags,
  orderLineFlags,
  orderPending,
  parseFraction,
  pickOrderOee,
} from '../domain/oee.ts';
import { formatPlantTime } from '../domain/time.ts';
import { useLiveOrderOee } from '../live/live-context.tsx';

const cell = 'px-2 py-1.5 align-top';

const time = (value: string | null): ReactNode =>
  value === null ? '–' : <time dateTime={value}>{formatPlantTime(value)}</time>;

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
      {time(head.at)}
      {head.source ? (
        <span className="block text-xs text-slate-700">from {HEAD_SOURCE_TEXT[head.source]}</span>
      ) : null}
    </>
  );
}

function JobRow({ job }: { readonly job: OrderJobOeeDto }) {
  const { window } = job;
  return (
    <tr
      data-testid={`order-oee-job-${job.commandId}`}
      data-final={String(job.final)}
      data-oee={job.oee?.oee?.decimal ?? 'n/a'}
      className="border-t border-slate-200"
    >
      <th scope="row" className={`${cell} font-mono font-medium`}>
        {job.commandId}
      </th>
      <td className={cell}>{job.machine}</td>
      <td className={cell}>
        <Head job={job} />
      </td>
      <td className={cell}>
        {window ? (
          <>
            {time(window.from)} to {time(window.to)}
            {window.open ? ' (open)' : ''}
            {window.headTimeUnknown ? (
              <span className="block text-xs text-amber-950">from its start: no changeover</span>
            ) : null}
          </>
        ) : (
          '–'
        )}
      </td>
      <td className={`${cell} tabular-nums`}>{job.cycles}</td>
      <td className={cell}>
        <RatioValue ratio={job.oee?.oee} na={NA_REASON.oee} />
      </td>
      <td className={cell}>
        <RatioValue ratio={job.oee?.availability} na={NA_REASON.availability} />
      </td>
      <td className={cell}>
        <RatioValue ratio={job.oee?.performance} na={NA_REASON.performance} />
      </td>
      <td className={cell}>
        <RatioValue ratio={job.oee?.quality} na={NA_REASON.quality} />
      </td>
      <td className={cell}>{job.final ? 'Final' : 'Provisional'}</td>
    </tr>
  );
}

function OrderOeeCard({ order }: { readonly order: OrderOeeDto }) {
  const { oee } = order;
  return (
    <article
      data-testid="order-oee-card"
      className="flex flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4 shadow-sm"
    >
      <h3 className="font-semibold">Order OEE</h3>
      <RatioHeadline label="OEE" ratio={oee.oee} na={NA_REASON.oee} testId="order-oee-oee" />
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 text-sm">
        <dt className="text-slate-700">Availability</dt>
        <dd className="text-right">
          <RatioValue
            ratio={oee.availability}
            na={NA_REASON.availability}
            testId="order-oee-availability"
          />
        </dd>
        <dt className="text-slate-700">Performance</dt>
        <dd className="text-right">
          <RatioValue
            ratio={oee.performance}
            na={NA_REASON.performance}
            testId="order-oee-performance"
          />
        </dd>
        <dt className="text-slate-700">Quality (OP10)</dt>
        <dd className="text-right">
          <RatioValue ratio={oee.quality} na={NA_REASON.quality} testId="order-oee-quality" />
        </dd>
        <dt className="text-slate-700">Planned busy time</dt>
        <dd className="text-right tabular-nums">{minutesText(oee.totals.plannedBusyMs)}</dd>
        <dt className="text-slate-700">OP10 cycles (good)</dt>
        <dd className="text-right tabular-nums">
          {oee.totals.produced} ({oee.totals.good})
        </dd>
      </dl>
      <StatusFlags flags={orderFlags(order)} />
      {oee.anomaly ? (
        <p className="text-sm text-amber-950">
          Anomaly: cycles were counted although there was no production time.
        </p>
      ) : null}
    </article>
  );
}

function FirstPassYieldCard({ order }: { readonly order: OrderOeeDto }) {
  const fpy = order.firstPassYield;
  return (
    <article
      data-testid="order-fpy"
      data-final={String(fpy.final)}
      data-yield={fpy.yield?.decimal ?? 'n/a'}
      className="flex flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4 shadow-sm"
    >
      <h3 className="font-semibold">First-pass yield</h3>
      <RatioHeadline
        label="Yield"
        ratio={fpy.yield}
        na={NA_REASON.yield}
        testId="order-fpy-yield"
      />
      <p className="text-sm">
        <span data-testid="order-fpy-good">{fpy.firstPassGood}</span> of{' '}
        <span data-testid="order-fpy-started">{fpy.started}</span> blanks taken packed good with
        every record good, across the routing.
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
      <p className="text-xs text-slate-700">
        Beside the order OEE, never multiplied into it: OP10 quality alone hides the leak test’s
        scrap.
      </p>
    </article>
  );
}

function OrderLineCard({ order }: { readonly order: OrderOeeDto }) {
  const { line } = order;
  return (
    <article
      data-testid="order-line-oee"
      data-final={line ? String(line.final) : undefined}
      data-oee={line?.oee?.decimal ?? 'n/a'}
      data-above-one={line ? String(line.aboveOne) : undefined}
      className="flex flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4 shadow-sm"
    >
      <h3 className="font-semibold">Line OEE of this order</h3>
      {line ? (
        <>
          <RatioHeadline
            label="Line OEE"
            ratio={line.oee}
            na={NA_REASON.line}
            testId="order-line-oee-value"
          />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm [&_dd]:text-right [&_dt]:whitespace-nowrap">
            <dt className="text-slate-700">In progress</dt>
            <dd className="text-right">
              {time(line.from)} to {time(line.to)}
            </dd>
            <dt className="text-slate-700">Planned busy time</dt>
            <dd className="text-right tabular-nums">{minutesText(line.plannedBusyMs)}</dd>
            <dt className="text-slate-700">Packed good</dt>
            <dd className="text-right tabular-nums">{goodText(line.good)}</dd>
            <dt className="text-slate-700">Ideal time at the bottleneck</dt>
            <dd className="text-right tabular-nums">{minutesText(parseFraction(line.idealMs))}</dd>
          </dl>
          <StatusFlags flags={orderLineFlags(line)} />
          {line.aboveOne ? <p className="text-sm text-amber-950">{ABOVE_ONE_TEXT}</p> : null}
          <p className="text-xs text-slate-700" data-testid="order-line-not-additive">
            Its own good units × the bottleneck’s effective cycle ÷ the line’s planned time while it
            was in progress. Not additive across orders: orders overlap in time.
          </p>
        </>
      ) : (
        <p className="text-sm">No job of this order is head of its CNC’s queue yet.</p>
      )}
    </article>
  );
}

/**
 * The order's OEE (#233, ADR-0036): A, P, Q and OEE over its job windows, each job's head time,
 * window and OEE, the first-pass yield across the routing beside it, and the order's own line
 * OEE; read once and followed live on `oee:order:<id>`.
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
    <section aria-labelledby="order-oee-title" data-testid="order-oee-section" className="mt-6">
      <h2 id="order-oee-title" className="text-xl font-semibold">
        OEE and first-pass yield
      </h2>
      <p className="mt-1 text-sm text-slate-700">
        Over the order’s job windows on its CNCs: each from the job’s head time (its changeover
        counts against this order) to its completion.
      </p>
      {read.isPending && !order ? <p className="mt-2 text-sm">Loading the order’s OEE…</p> : null}
      {missing ? (
        <p className="mt-2 text-sm" data-testid="order-oee-missing">
          The MES has no OEE for this order.
        </p>
      ) : read.isError && !order ? (
        <div className="mt-2">
          <QueryError
            what="the order’s OEE"
            error={read.error}
            onRetry={() => void read.refetch()}
          />
        </div>
      ) : null}
      {order ? (
        <div
          data-testid="order-oee"
          data-final={String(order.final)}
          data-oee={order.oee.oee?.decimal ?? 'n/a'}
          data-revision={String(order.revision)}
          data-incidents={String(order.incidents.length)}
          className="mt-2"
        >
          {!order.final ? (
            <p className="mb-2 text-sm text-amber-950" data-testid="order-oee-pending">
              Provisional: {orderPending(order).join('; ')}.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <OrderOeeCard order={order} />
            <FirstPassYieldCard order={order} />
            <OrderLineCard order={order} />
          </div>
          {order.incidents.length > 0 ? (
            <div className="mt-2 text-sm" data-testid="order-oee-incidents">
              <p className="font-medium">Written-off gaps under it (a final value may change):</p>
              <ul>
                {order.incidents.map((incident) => (
                  <li key={`${incident.machine}-${String(incident.epoch)}-${String(incident.id)}`}>
                    {incident.machine}, run {incident.epoch}: sequence {incident.seqFrom} to{' '}
                    {incident.seqTo}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-300 bg-white">
            <table className="w-full min-w-[48rem] text-left text-sm" data-testid="order-oee-jobs">
              <caption className="sr-only">OEE per job of the order</caption>
              <thead className="bg-slate-100">
                <tr>
                  {[
                    'Job',
                    'CNC',
                    'Head time',
                    'Window',
                    'Cycles',
                    'OEE',
                    'A',
                    'P',
                    'Q',
                    'Status',
                  ].map((column) => (
                    <th key={column} scope="col" className={`${cell} font-semibold`}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.jobs.length === 0 ? (
                  <tr>
                    <td colSpan={10} className={cell}>
                      No job accepted yet.
                    </td>
                  </tr>
                ) : (
                  order.jobs.map((job) => <JobRow key={job.commandId} job={job} />)
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
