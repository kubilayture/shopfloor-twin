import { GENEALOGY_LIMITS, type LotTraceDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { getLotTrace } from '../api/trace.ts';
import { QueryError } from '../components/query-error.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { Select } from '../components/ui/controls.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, Quantity, WallTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { SectionNav } from '../components/ui/section-nav.tsx';
import {
  TRACE_ID,
  UNIT_STATUS_TEXT,
  blocking,
  lotMoving,
  singleRun,
  unitKey,
} from '../domain/trace.ts';
import { useTraceTopics } from '../live/live-context.tsx';
import {
  CartonLink,
  FinalityNotice,
  FinalityStatus,
  HeaderFacts,
  HeldBadge,
  HeldNotice,
  Holds,
  IdLinks,
  IdText,
  InvalidId,
  LotList,
  OrderLink,
  SerialLink,
  TRACE_BACK,
  TraceLoading,
  TraceNotFound,
  UnitStatusBadge,
  idTitle,
  tracePolling,
} from './trace-common.tsx';

type LotUnit = LotTraceDto['units'][number];
type StatusFilter = 'all' | LotUnit['status'];

/** The units of a lot are paged (T-04): 50 a page, above every lot the demo counts on a page. */
const LOT_PAGE_SIZE = 50;

const STATUSES = ['wip', 'packed', 'scrapped', 'lost'] as const;

/** The ERP's view of the lot, as a header badge. */
function ErpStatus({ master }: { readonly master: LotTraceDto['master'] }) {
  if (master === null) {
    return (
      <Badge tone="neutral" variant="dashed" title="Neither the ERP listed it nor imported it">
        Not from the ERP
      </Badge>
    );
  }
  return master.status === 'active' ? (
    <Badge tone="neutral" variant="outline" title="Listed by the ERP">
      ERP listed
    </Badge>
  ) : (
    <Badge tone="warn" title="No longer listed by the ERP">
      ERP retired
    </Badge>
  );
}

/** The lot's key facts, in the header (`lot-master` keeps the ERP's raw status and quantity). */
function Master({ trace, run }: { readonly trace: LotTraceDto; readonly run: number | undefined }) {
  const master = trace.master;
  const facts: (readonly [string, ReactNode])[] = [
    ['Material', <Code key="material">{trace.material}</Code>],
    [
      'Pieces consumed',
      <span key="consumed" data-testid="lot-consumed" className="tabular-nums">
        {trace.consumed}
      </span>,
    ],
    ['Units', <Quantity key="units" value={trace.units.length} />],
    [
      'Received (ERP)',
      master ? (
        <Quantity key="received" value={master.quantity} />
      ) : (
        <Missing key="received" reason="Never imported from the ERP" />
      ),
    ],
    [
      'Imported',
      master ? (
        <WallTime key="imported" at={master.importedAt} />
      ) : (
        <Missing key="imported" reason="Never imported from the ERP" />
      ),
    ],
  ];
  // The run every unit belongs to, once here rather than on each row (T-05).
  if (run !== undefined)
    facts.push([
      'Run',
      <span key="run" className="tabular-nums">
        {run}
      </span>,
    ]);
  return (
    <HeaderFacts
      facts={facts}
      testId="lot-master"
      data={{
        'data-status': master?.status ?? 'not-imported',
        'data-quantity': master ? String(master.quantity) : '',
      }}
    />
  );
}

function unitColumns(run: number | undefined): readonly Column<LotUnit>[] {
  return [
    {
      key: 'serial',
      header: 'Serial',
      rowHeader: true,
      nowrap: true,
      cell: (unit) => <SerialLink unit={unit} />,
    },
    ...(run === undefined
      ? [{ key: 'run', header: 'Run', numeric: true, cell: (unit: LotUnit) => unit.epoch }]
      : []),
    { key: 'part', header: 'Part', numeric: true, priority: 2, cell: (unit) => unit.partId },
    {
      key: 'order',
      header: 'Order',
      nowrap: true,
      cell: (unit) => <IdText id={unit.orderId} kind="order" />,
    },
    {
      key: 'carton',
      header: 'Carton',
      nowrap: true,
      priority: 2,
      cell: (unit) => <IdText id={unit.carton} kind="carton" />,
    },
    {
      key: 'status',
      header: 'Status',
      nowrap: true,
      cell: (unit) => <UnitStatusBadge status={unit.status} />,
    },
  ];
}

function Units({ trace, run }: { readonly trace: LotTraceDto; readonly run: number | undefined }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const count = (value: LotUnit['status']) =>
    trace.units.filter((unit) => unit.status === value).length;
  const rows = status === 'all' ? trace.units : trace.units.filter((u) => u.status === status);
  return (
    <Section
      id="lot-units-section-title"
      testId="lot-units-section"
      title="Units"
      description="Every unit that consumed the lot, at any operation and pass. The MES crew of each cycle is on its serial’s page."
      actions={
        trace.units.length === 0 ? undefined : (
          <Select
            label="Status"
            name="lot-unit-status"
            inline
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as StatusFilter);
            }}
          >
            <option value="all">All ({trace.units.length})</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {UNIT_STATUS_TEXT[value]} ({count(value)})
              </option>
            ))}
          </Select>
        )
      }
    >
      {trace.truncated ? (
        <Callout tone="warn" role="status" className="mb-3" data-testid="lot-truncated">
          More than {GENEALOGY_LIMITS.units} units used this lot: only the first{' '}
          {GENEALOGY_LIMITS.units} are listed.
        </Callout>
      ) : null}
      {trace.units.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            testId="lot-units-empty"
            title="No unit has consumed this lot yet"
            body="Units appear here once a machine reports a cycle that consumed it."
          />
        </div>
      ) : (
        <DataTable
          // A new filter starts on the first page.
          key={status}
          caption={
            status === 'all'
              ? 'Units that consumed the lot'
              : `Units that consumed the lot: ${UNIT_STATUS_TEXT[status].toLowerCase()}`
          }
          testId="lot-units"
          rows={rows}
          rowKey={unitKey}
          rowTestId={(unit) => `lot-unit-${unitKey(unit)}`}
          rowProps={(unit) => ({
            'data-serial': unit.serial ?? '',
            'data-order': unit.orderId ?? '',
            'data-carton': unit.carton ?? '',
            'data-status': unit.status,
          })}
          rowTone={(unit) => (unit.status === 'scrapped' ? 'alarm' : undefined)}
          pageSize={LOT_PAGE_SIZE}
          skipToDetails="lot-orders-title"
          skipLabel="Skip past the units"
          density="compact"
          columns={unitColumns(run)}
          empty={
            <EmptyState
              title={`No unit is ${status === 'all' ? 'listed' : UNIT_STATUS_TEXT[status].toLowerCase()}`}
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setStatus('all');
                  }}
                >
                  Show every unit
                </Button>
              }
            />
          }
        />
      )}
    </Section>
  );
}

function Where({ trace }: { readonly trace: LotTraceDto }) {
  return (
    <>
      <Section
        id="lot-orders-title"
        testId="lot-orders"
        title="Orders"
        description="The production orders of the units that used the lot."
      >
        {trace.orders.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface px-4">
            <EmptyState
              size="inline"
              title="No order"
              body="None yet, or the units ran without an order (schedule mode)."
            />
          </div>
        ) : (
          <IdLinks count={trace.orders.length}>
            {trace.orders.map((order) => (
              <li key={order}>
                <OrderLink order={order} />
              </li>
            ))}
          </IdLinks>
        )}
      </Section>
      <Section
        id="lot-cartons-title"
        testId="lot-cartons"
        title="Cartons"
        description="The cartons its units were packed into."
      >
        {trace.cartons.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface px-4">
            <EmptyState
              size="inline"
              title="No carton yet"
              body="A carton is formed once its packing cycles are final."
            />
          </div>
        ) : (
          <IdLinks count={trace.cartons.length}>
            {trace.cartons.map((carton) => (
              <li key={carton}>
                <CartonLink carton={carton} />
              </li>
            ))}
          </IdLinks>
        )}
      </Section>
      <Section
        id="lot-with-title"
        testId="lot-with"
        title="Where used with"
        description="The other lots the same units consumed (one level): for a component lot, the blank lots of its units."
      >
        <div className="rounded-lg border border-line bg-surface p-4 text-sm">
          <LotList
            lots={trace.withLots}
            testId="lot-with-lots"
            layout="inline"
            none="No other lot was used with it."
          />
        </div>
      </Section>
    </>
  );
}

/** The lot page's sections, reachable from above the long units table (T-04). */
const LOT_SECTIONS = [
  { id: 'lot-units-section-title', label: 'Units' },
  { id: 'lot-orders-title', label: 'Orders' },
  { id: 'lot-cartons-title', label: 'Cartons' },
  { id: 'lot-with-title', label: 'Where used with' },
  { id: 'trace-holds-title', label: 'Quality holds' },
] as const;

function LotTrace({ lot }: { readonly lot: string }) {
  const read = useQuery({
    queryKey: queryKeys.traceLot(lot),
    queryFn: ({ signal }) => getLotTrace(lot, signal),
    refetchInterval: tracePolling(lotMoving),
  });
  const trace = read.data;
  if (trace === undefined) {
    if (read.error instanceof ApiError && read.error.status === 404) {
      return (
        <TraceNotFound
          kind="lot"
          id={lot}
          detail="Neither the ERP listed it nor a machine reported it."
        />
      );
    }
    if (read.isError) {
      return (
        <div data-testid="trace-lot" data-lot={lot}>
          <PageHeader back={TRACE_BACK} title={idTitle('Lot', lot)} documentTitle={`Lot ${lot}`} />
          <QueryError what="the trace" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      );
    }
    return <TraceLoading label="Loading the trace…" />;
  }
  const held = blocking(trace.holds);
  const run = singleRun(trace.units);
  return (
    <div
      data-testid="trace-lot"
      data-lot={lot}
      data-material={trace.material}
      data-consumed={String(trace.consumed)}
      data-truncated={String(trace.truncated)}
      data-held={String(held)}
    >
      <PageHeader
        back={TRACE_BACK}
        id="trace-lot-title"
        title={idTitle('Lot', lot)}
        documentTitle={`Lot ${lot}`}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <HeldBadge holds={trace.holds} />
            <ErpStatus master={trace.master} />
            <FinalityStatus final={trace.final} />
          </span>
        }
        description="Forward trace: the units that consumed the lot at any operation and pass, their orders and cartons, and the lots used with it."
        meta={<Master trace={trace} run={run} />}
      />
      <FinalityNotice final={trace.final} notFinal={trace.notFinal} />
      {read.isError ? (
        <div className="mb-6">
          <QueryError what="the trace" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {held ? (
        <HeldNotice testId="lot-held">
          An open or rejected hold covers this lot or some of its units (Quality holds, below).
        </HeldNotice>
      ) : null}
      <SectionNav items={LOT_SECTIONS} />
      <div className="mt-6">
        <Units trace={trace} run={run} />
        <Where trace={trace} />
        <Holds
          holds={trace.holds}
          what="this lot and its units"
          subject={{ kind: 'lot', id: lot }}
        />
      </div>
    </div>
  );
}

/** `/trace/lots/$lot` (#202): the forward trace, keyed by the lot. */
export function TraceLotRoute() {
  const { lot } = useParams({ from: '/trace/lots/$lot' });
  useTraceTopics();
  if (!TRACE_ID.test(lot)) return <InvalidId kind="Lot" />;
  return <LotTrace key={lot} lot={lot} />;
}
