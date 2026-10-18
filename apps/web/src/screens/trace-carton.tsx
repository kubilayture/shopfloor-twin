import type { CartonTraceDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ApiError } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { getCartonTrace } from '../api/trace.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { TRACE_ID, unitKey } from '../domain/trace.ts';
import { useTraceTopics } from '../live/live-context.tsx';
import {
  BackToSearch,
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
  tracePolling,
  unitStatus,
} from './trace-common.tsx';

function Summary({ trace }: { readonly trace: CartonTraceDto }) {
  const carton = trace.carton;
  return (
    <div className="mt-3" data-testid="carton-summary">
      {carton.held ? (
        <p
          role="status"
          data-testid="carton-held"
          className="mb-2 rounded border border-red-700 bg-red-50 p-2 text-sm font-semibold text-red-950"
        >
          Held: a member is in an open or rejected quality hold, so the carton is blocked from
          shipping.
        </p>
      ) : null}
      <Facts
        items={[
          ['Order', <OrderLink key="o" order={carton.orderId} />],
          ['Product', carton.product],
          [
            'Status',
            <span key="s" data-testid="carton-status" data-status={carton.status}>
              {carton.status === 'closed' ? 'Closed' : 'Open (still filling)'}
              {carton.held ? ', held' : ''}
            </span>,
          ],
          [
            'Members',
            <span key="m" data-testid="carton-members">
              {carton.members} of {carton.capacity}
            </span>,
          ],
          ['Closed', plantTime(carton.closedAt)],
        ]}
      />
    </div>
  );
}

function Members({ trace }: { readonly trace: CartonTraceDto }) {
  return (
    <Section id="carton-units-section" title="Members">
      <p className="text-sm text-slate-700">In placement order (the packing cycles’ plant time).</p>
      {trace.units.length === 0 ? (
        <p className="mt-1 text-sm" data-testid="carton-units-empty">
          No member yet.
        </p>
      ) : (
        <div className="mt-2">
          <Table
            testId="carton-units"
            caption="Members of the carton"
            count={trace.units.length}
            columns={['No.', 'Serial', 'Run', 'Part', 'Status']}
          >
            {trace.units.map((unit, index) => (
              <tr
                key={unitKey(unit)}
                data-testid={`carton-unit-${unitKey(unit)}`}
                data-serial={unit.serial ?? ''}
                data-status={unit.status}
                className="border-t border-slate-200"
              >
                <td className={`${cell} tabular-nums`}>{index + 1}</td>
                <th scope="row" className={cell}>
                  <SerialLink unit={unit} />
                </th>
                <td className={`${cell} tabular-nums`}>{unit.epoch}</td>
                <td className={`${cell} tabular-nums`}>{unit.partId}</td>
                <td className={cell}>{unitStatus(unit.status)}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      <h3 className="mt-4 font-semibold">Lots of its members</h3>
      <p className="mt-1 text-sm">
        <LotList lots={trace.lots} testId="carton-lots" />
      </p>
    </Section>
  );
}

function CartonTrace({ carton }: { readonly carton: string }) {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const read = useQuery({
    queryKey: queryKeys.traceCarton(carton),
    queryFn: ({ signal }) => getCartonTrace(carton, signal),
    refetchInterval: tracePolling(
      (data: CartonTraceDto) => !data.final || data.carton.status === 'open',
    ),
  });
  const missing = read.error instanceof ApiError && read.error.status === 404;
  const trace = read.data;
  return (
    <section
      aria-labelledby="trace-carton-title"
      data-testid="trace-carton"
      data-carton={carton}
      data-status={trace?.carton.status ?? ''}
      data-held={trace ? String(trace.carton.held) : ''}
      data-members={trace ? String(trace.carton.members) : ''}
      data-capacity={trace ? String(trace.carton.capacity) : ''}
    >
      <BackToSearch />
      <h1 ref={heading} id="trace-carton-title" tabIndex={-1} className="mt-1 text-2xl font-bold">
        Carton {carton}
      </h1>
      <p className="mt-1 text-sm text-slate-700">
        A carton formed by the MES’s packing rule on final data: its members and their lots.
      </p>
      {read.isPending ? <p className="mt-4">Loading the carton…</p> : null}
      {missing ? (
        <p className="mt-4" data-testid="trace-missing">
          The MES has no carton {carton} (cartons form once their packing cycles are final).
        </p>
      ) : read.isError ? (
        <div className="mt-4">
          <QueryError what="the carton" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {trace ? (
        <>
          <Finality final={trace.final} notFinal={trace.notFinal} />
          <Summary trace={trace} />
          <Members trace={trace} />
          <Holds
            holds={trace.holds}
            what="this carton and its members"
            subject={{ kind: 'carton', id: carton }}
          />
          <p className="mt-6 text-sm text-slate-700">
            The MES crew of each cycle is on the serial pages (follow a member’s serial).
          </p>
        </>
      ) : null}
    </section>
  );
}

/** `/trace/cartons/$carton` (#202): a carton's members, keyed by the carton. */
export function TraceCartonRoute() {
  const { carton } = useParams({ from: '/trace/cartons/$carton' });
  useTraceTopics();
  if (!TRACE_ID.test(carton)) {
    return (
      <section>
        <BackToSearch />
        <h1 className="mt-1 text-2xl font-bold">Carton</h1>
        <p className="mt-2" data-testid="trace-invalid">
          This is not a carton id the MES could know.
        </p>
      </section>
    );
  }
  return <CartonTrace key={carton} carton={carton} />;
}
