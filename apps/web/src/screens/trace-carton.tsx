import type { CartonTraceDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { getCartonTrace } from '../api/trace.ts';
import { QueryError } from '../components/query-error.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Code } from '../components/ui/code.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, PlantTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { TRACE_ID, singleRun, unitKey } from '../domain/trace.ts';
import { useTraceTopics } from '../live/live-context.tsx';
import {
  FinalityNotice,
  FinalityStatus,
  HeaderFacts,
  HeldNotice,
  Holds,
  InvalidId,
  LotList,
  CartonStateBadge,
  OrderLink,
  SerialLink,
  TRACE_BACK,
  TraceLoading,
  TraceNotFound,
  UnitStatusBadge,
  idTitle,
  tracePolling,
} from './trace-common.tsx';

type Member = CartonTraceDto['units'][number];

/** The carton's state as badges (`carton-status` keeps the raw status): closed or filling, held. */
function CartonStatus({ carton }: { readonly carton: CartonTraceDto['carton'] }) {
  return (
    <span
      data-testid="carton-status"
      data-status={carton.status}
      className="flex flex-wrap items-center gap-2"
    >
      <CartonStateBadge status={carton.status} />
      {carton.held ? (
        <Badge tone="alarm" icon="ban">
          Held
        </Badge>
      ) : null}
    </span>
  );
}

/** The carton's key facts, in the header. */
function Summary({
  trace,
  run,
}: {
  readonly trace: CartonTraceDto;
  readonly run: number | undefined;
}) {
  const carton = trace.carton;
  const facts: (readonly [string, ReactNode])[] = [
    ['Order', <OrderLink key="order" order={carton.orderId} />],
    ['Product', <Code key="product">{carton.product}</Code>],
    [
      'Members',
      <span key="members" data-testid="carton-members" className="tabular-nums">
        {carton.members} of {carton.capacity}
      </span>,
    ],
    [
      'Closed',
      carton.closedAt === null ? (
        <Missing key="closed" reason="Still filling" />
      ) : (
        <PlantTime key="closed" at={carton.closedAt} />
      ),
    ],
  ];
  // The run every member belongs to, once here rather than on each row (T-05).
  if (run !== undefined)
    facts.push([
      'Run',
      <span key="run" className="tabular-nums">
        {run}
      </span>,
    ]);
  return <HeaderFacts facts={facts} testId="carton-summary" />;
}

function memberColumns(trace: CartonTraceDto, run: number | undefined): readonly Column<Member>[] {
  return [
    {
      key: 'place',
      header: 'No.',
      numeric: true,
      // At the row's start, beside the serial it numbers, not pushed to the far edge.
      align: 'start',
      cell: (unit) => trace.units.indexOf(unit) + 1,
    },
    {
      key: 'serial',
      header: 'Serial',
      rowHeader: true,
      nowrap: true,
      cell: (unit) => <SerialLink unit={unit} />,
    },
    ...(run === undefined
      ? [
          {
            key: 'run',
            header: 'Run',
            numeric: true,
            // Dropped below `sm`, so the status stays in view at 390.
            priority: 2 as const,
            cell: (unit: Member) => unit.epoch,
          },
        ]
      : []),
    { key: 'part', header: 'Part', numeric: true, cell: (unit) => unit.partId },
    {
      key: 'status',
      header: 'Status',
      nowrap: true,
      cell: (unit) => <UnitStatusBadge status={unit.status} />,
    },
  ];
}

function Members({
  trace,
  run,
}: {
  readonly trace: CartonTraceDto;
  readonly run: number | undefined;
}) {
  return (
    <Section
      id="carton-units-section-title"
      testId="carton-units-section"
      title="Members"
      description="In placement order (the packing cycles’ plant time). The MES crew of each cycle is on its serial’s page."
    >
      {trace.units.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            testId="carton-units-empty"
            title="No member yet"
            body="Units appear here as their packing cycles are final."
          />
        </div>
      ) : (
        <DataTable
          caption="Members of the carton"
          testId="carton-units"
          rows={trace.units}
          count={trace.units.length}
          rowKey={unitKey}
          rowTestId={(unit) => `carton-unit-${unitKey(unit)}`}
          rowProps={(unit) => ({ 'data-serial': unit.serial ?? '', 'data-status': unit.status })}
          rowTone={(unit) => (unit.status === 'scrapped' ? 'alarm' : undefined)}
          skipToDetails="carton-lots-title"
          skipLabel="Skip past the members"
          density="compact"
          columns={memberColumns(trace, run)}
        />
      )}
    </Section>
  );
}

function Lots({ trace }: { readonly trace: CartonTraceDto }) {
  return (
    <Section
      id="carton-lots-title"
      testId="carton-lots-section"
      title="Lots of its members"
      description="Every lot the members consumed, by lot id."
    >
      <div className="rounded-lg border border-line bg-surface p-4 text-sm">
        <LotList
          lots={trace.lots}
          testId="carton-lots"
          layout="inline"
          none="No lot reported for its members yet."
        />
      </div>
    </Section>
  );
}

function CartonTrace({ carton }: { readonly carton: string }) {
  const read = useQuery({
    queryKey: queryKeys.traceCarton(carton),
    queryFn: ({ signal }) => getCartonTrace(carton, signal),
    refetchInterval: tracePolling(
      (data: CartonTraceDto) => !data.final || data.carton.status === 'open',
    ),
  });
  const trace = read.data;
  if (trace === undefined) {
    if (read.error instanceof ApiError && read.error.status === 404) {
      return (
        <TraceNotFound
          kind="carton"
          id={carton}
          detail="Cartons form once their packing cycles are final."
        />
      );
    }
    if (read.isError) {
      return (
        <div data-testid="trace-carton" data-carton={carton}>
          <PageHeader
            back={TRACE_BACK}
            title={idTitle('Carton', carton)}
            documentTitle={`Carton ${carton}`}
          />
          <QueryError what="the carton" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      );
    }
    return <TraceLoading label="Loading the carton…" />;
  }
  const run = singleRun(trace.units);
  return (
    <div
      data-testid="trace-carton"
      data-carton={carton}
      data-status={trace.carton.status}
      data-held={String(trace.carton.held)}
      data-members={String(trace.carton.members)}
      data-capacity={String(trace.carton.capacity)}
    >
      <PageHeader
        back={TRACE_BACK}
        id="trace-carton-title"
        title={idTitle('Carton', carton)}
        documentTitle={`Carton ${carton}`}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <CartonStatus carton={trace.carton} />
            <FinalityStatus final={trace.final} />
          </span>
        }
        description="A carton formed by the MES’s packing rule on final data: its members and their lots."
        meta={<Summary trace={trace} run={run} />}
      />
      <FinalityNotice final={trace.final} notFinal={trace.notFinal} />
      {read.isError ? (
        <div className="mb-6">
          <QueryError what="the carton" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {trace.carton.held ? (
        <HeldNotice testId="carton-held">
          A member is in an open or rejected quality hold, so the carton is blocked from shipping.
        </HeldNotice>
      ) : null}
      <Members trace={trace} run={run} />
      <Lots trace={trace} />
      <Holds
        holds={trace.holds}
        what="this carton and its members"
        subject={{ kind: 'carton', id: carton }}
      />
    </div>
  );
}

/** `/trace/cartons/$carton` (#202): a carton's members, keyed by the carton. */
export function TraceCartonRoute() {
  const { carton } = useParams({ from: '/trace/cartons/$carton' });
  useTraceTopics();
  if (!TRACE_ID.test(carton)) return <InvalidId kind="Carton" />;
  return <CartonTrace key={carton} carton={carton} />;
}
