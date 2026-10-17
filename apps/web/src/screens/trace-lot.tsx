import { GENEALOGY_LIMITS, type LotTraceDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ApiError } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { getLotTrace } from '../api/trace.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { TRACE_ID, blocking, lotMoving, tracePoll, unitKey } from '../domain/trace.ts';
import { useTraceTopics } from '../live/live-context.tsx';
import {
  BackToSearch,
  CartonLink,
  Facts,
  Finality,
  Holds,
  LotList,
  OrderLink,
  SerialLink,
  Section,
  Table,
  cell,
  plantTime,
  unitStatus,
} from './trace-common.tsx';

function Master({ trace }: { readonly trace: LotTraceDto }) {
  const master = trace.master;
  return (
    <div
      data-testid="lot-master"
      data-status={master?.status ?? 'not-imported'}
      data-quantity={master ? String(master.quantity) : ''}
      className="mt-3"
    >
      <Facts
        items={[
          ['Material', trace.material],
          [
            'Pieces consumed',
            <span key="c" data-testid="lot-consumed">
              {trace.consumed}
            </span>,
          ],
          ['Units', String(trace.units.length)],
          ['Received (ERP)', master ? String(master.quantity) : '–'],
          [
            'ERP status',
            master === null
              ? 'Never imported from the ERP'
              : master.status === 'active'
                ? 'Listed by the ERP'
                : 'Retired (no longer listed by the ERP)',
          ],
          ['Imported', master ? plantTime(master.importedAt) : '–'],
        ]}
      />
    </div>
  );
}

function Units({ trace }: { readonly trace: LotTraceDto }) {
  return (
    <Section id="lot-units-section" title="Units">
      {trace.truncated ? (
        <p role="status" className="mb-2 text-sm text-amber-950" data-testid="lot-truncated">
          More than {GENEALOGY_LIMITS.units} units used this lot: only the first{' '}
          {GENEALOGY_LIMITS.units} are listed.
        </p>
      ) : null}
      {trace.units.length === 0 ? (
        <p className="text-sm" data-testid="lot-units-empty">
          No unit has consumed this lot yet.
        </p>
      ) : (
        <Table
          testId="lot-units"
          caption="Units that consumed the lot"
          count={trace.units.length}
          columns={['Serial', 'Run', 'Part', 'Order', 'Carton', 'Status']}
        >
          {trace.units.map((unit) => (
            <tr
              key={unitKey(unit)}
              data-testid={`lot-unit-${unitKey(unit)}`}
              data-serial={unit.serial ?? ''}
              data-order={unit.orderId ?? ''}
              data-carton={unit.carton ?? ''}
              data-status={unit.status}
              className="border-t border-slate-200"
            >
              <th scope="row" className={cell}>
                <SerialLink unit={unit} />
              </th>
              <td className={`${cell} tabular-nums`}>{unit.epoch}</td>
              <td className={`${cell} tabular-nums`}>{unit.partId}</td>
              <td className={cell}>
                <OrderLink order={unit.orderId} />
              </td>
              <td className={cell}>
                <CartonLink carton={unit.carton} />
              </td>
              <td className={cell}>{unitStatus(unit.status)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function Where({ trace }: { readonly trace: LotTraceDto }) {
  return (
    <>
      <Section id="lot-orders" title="Orders">
        {trace.orders.length === 0 ? (
          <p className="text-sm">None (or units without an order, in schedule mode).</p>
        ) : (
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
            data-count={String(trace.orders.length)}
          >
            {trace.orders.map((order) => (
              <li key={order}>
                <OrderLink order={order} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="lot-cartons" title="Cartons">
        {trace.cartons.length === 0 ? (
          <p className="text-sm">None yet: a carton is formed once its packing cycles are final.</p>
        ) : (
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
            data-count={String(trace.cartons.length)}
          >
            {trace.cartons.map((carton) => (
              <li key={carton}>
                <CartonLink carton={carton} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="lot-with" title="Where used with">
        <p className="text-sm text-slate-700">
          The other lots the same units consumed (one level): for a component lot, the blank lots of
          its units.
        </p>
        <p className="mt-1 text-sm">
          <LotList lots={trace.withLots} testId="lot-with-lots" />
        </p>
      </Section>
    </>
  );
}

function LotTrace({ lot }: { readonly lot: string }) {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const read = useQuery({
    queryKey: queryKeys.traceLot(lot),
    queryFn: ({ signal }) => getLotTrace(lot, signal),
    refetchInterval: (query) =>
      tracePoll(
        query.state.status === 'error',
        query.state.data === undefined || lotMoving(query.state.data),
      ),
  });
  const missing = read.error instanceof ApiError && read.error.status === 404;
  const trace = read.data;
  const held = trace ? blocking(trace.holds) : false;
  return (
    <section
      aria-labelledby="trace-lot-title"
      data-testid="trace-lot"
      data-lot={lot}
      data-material={trace?.material ?? ''}
      data-consumed={trace ? String(trace.consumed) : ''}
      data-truncated={trace ? String(trace.truncated) : ''}
      data-held={String(held)}
    >
      <BackToSearch />
      <h1 ref={heading} id="trace-lot-title" tabIndex={-1} className="mt-1 text-2xl font-bold">
        Lot {lot}
      </h1>
      <p className="mt-1 text-sm text-slate-700">
        Forward trace: the units that consumed the lot at any operation and pass, their orders and
        cartons, and the lots used with it.
      </p>
      {read.isPending ? <p className="mt-4">Loading the trace…</p> : null}
      {missing ? (
        <p className="mt-4" data-testid="trace-missing">
          The MES knows no lot {lot}: neither the ERP listed it nor a machine reported it.
        </p>
      ) : read.isError ? (
        <div className="mt-4">
          <QueryError what="the trace" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {trace ? (
        <>
          <Finality final={trace.final} notFinal={trace.notFinal} />
          {held ? (
            <p
              role="status"
              data-testid="lot-held"
              className="mt-2 rounded border border-red-700 bg-red-50 p-2 text-sm font-semibold text-red-950"
            >
              On quality hold: an open or rejected hold covers this lot or some of its units
              (below).
            </p>
          ) : null}
          <Master trace={trace} />
          <Units trace={trace} />
          <Where trace={trace} />
          <Holds holds={trace.holds} what="this lot and its units" />
          <p className="mt-6 text-sm text-slate-700">
            The MES crew of each cycle is on the serial pages (follow a serial).
          </p>
        </>
      ) : null}
    </section>
  );
}

/** `/trace/lots/$lot` (#202): the forward trace, keyed by the lot. */
export function TraceLotRoute() {
  const { lot } = useParams({ from: '/trace/lots/$lot' });
  useTraceTopics();
  if (!TRACE_ID.test(lot)) {
    return (
      <section>
        <BackToSearch />
        <h1 className="mt-1 text-2xl font-bold">Lot</h1>
        <p className="mt-2" data-testid="trace-invalid">
          This is not a lot id the MES could know.
        </p>
      </section>
    );
  }
  return <LotTrace key={lot} lot={lot} />;
}
