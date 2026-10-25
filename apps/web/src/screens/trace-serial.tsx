import {
  BLANK_OPERATION,
  COMPONENTS_OPERATION,
  type SerialTraceDto,
  type TraceRecordDto,
  type TraceUnitDto,
} from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { getSerialTrace } from '../api/trace.ts';
import { QueryError } from '../components/query-error.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { DataTable } from '../components/ui/data-table.tsx';
import { DescriptionList } from '../components/ui/description-list.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, PlantTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { SectionNav } from '../components/ui/section-nav.tsx';
import { plainText } from '../domain/numbers.ts';
import {
  RESULT_TEXT,
  RESULT_TONE,
  TRACE_ID,
  blankLots,
  blocking,
  componentPasses,
  operationText,
  overLimit,
  serialMoving,
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
  InvalidId,
  LotList,
  OrderLink,
  TRACE_BACK,
  TraceLoading,
  TraceNotFound,
  UnitStatusBadge,
  idTitle,
  linkClass,
  tracePolling,
  useMachineName,
} from './trace-common.tsx';

function Crew({ record }: { readonly record: TraceRecordDto }) {
  if (record.crew.length === 0) {
    // The MES joins its crew only where the machine has a device operator.
    return (
      <span data-testid="record-crew" data-count="0">
        <Missing
          reason={
            record.operatorReported
              ? 'Nobody signed on'
              : 'No crew: the machine reports no device operator'
          }
        />
      </span>
    );
  }
  return (
    <ul data-testid="record-crew" data-count={String(record.crew.length)} className="space-y-1">
      {record.crew.map((member) => (
        <li key={`${String(member.userId)}-${member.from}`} data-user={member.username}>
          <span className="font-medium">{member.username}</span>
          <span className="block text-xs text-ink-secondary">
            from <PlantTime at={member.from} />
            {member.to === null ? (
              ', still signed on'
            ) : (
              <>
                {' '}
                to <PlantTime at={member.to} />
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Reading({ record }: { readonly record: TraceRecordDto }) {
  const reading = record.reading;
  if (reading === null) return <Missing reason="No reading at this operation" />;
  const over = overLimit(reading);
  return (
    <span
      data-testid="record-reading"
      data-characteristic={reading.characteristic}
      data-value={String(reading.value)}
      data-limit={String(reading.upperLimit)}
      data-over={String(over)}
      className={`whitespace-nowrap tabular-nums ${over ? 'font-semibold text-alarm-ink' : ''}`}
    >
      {plainText(reading.value)} {reading.unit}{' '}
      <span className="block text-xs font-normal text-ink-secondary">
        ({over ? 'over' : 'within'} the limit {plainText(reading.upperLimit)} {reading.unit})
      </span>
    </span>
  );
}

/** The device operator: the raw user name as reported, nobody, or not reported (6.3). */
function Operator({ record }: { readonly record: TraceRecordDto }) {
  return (
    <span data-testid="record-operator" data-reported={String(record.operatorReported)}>
      {record.operator ??
        (record.operatorReported ? (
          <Missing reason="No device operator signed on" />
        ) : (
          <span className="text-ink-secondary">Not reported</span>
        ))}
    </span>
  );
}

function Result({ record }: { readonly record: TraceRecordDto }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {record.result === 'good' ? (
        // The normal outcome in words; only a rework or a scrap is raised as a badge.
        RESULT_TEXT.good
      ) : (
        <Badge tone={RESULT_TONE[record.result]}>{RESULT_TEXT[record.result]}</Badge>
      )}
      {record.reason ? <span className="text-xs text-ink-secondary">{record.reason}</span> : null}
    </span>
  );
}

function Records({ unit }: { readonly unit: TraceUnitDto }) {
  const machine = useMachineName();
  return (
    <Section
      id="trace-records-section-title"
      testId="trace-records-section"
      title="Operations"
      description="Every cycle by plant time: the machine, the lots consumed, the device operator at its start, the MES users signed on (not reconciled) and the leak reading."
    >
      {unit.records.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            testId="trace-records-empty"
            title="No cycle recorded yet"
            body="The unit’s operations appear here as each machine reports its cycle."
          />
        </div>
      ) : (
        <DataTable
          caption="Operations of the unit"
          testId="trace-records"
          rows={unit.records}
          count={unit.records.length}
          rowKey={(record) => `${record.equipment}-${String(record.epoch)}-${String(record.seq)}`}
          rowTestId={(record) => `record-${record.operation}-${String(record.pass)}`}
          rowProps={(record) => ({
            'data-equipment': record.equipment,
            'data-result': record.result,
            'data-epoch': String(record.epoch),
            'data-seq': String(record.seq),
          })}
          rowTone={(record) => (record.result === 'good' ? undefined : RESULT_TONE[record.result])}
          narrow="stack"
          columns={[
            {
              key: 'operation',
              header: 'Operation',
              rowHeader: true,
              nowrap: true,
              cell: (record) => operationText(record),
            },
            {
              key: 'machine',
              header: 'Machine',
              cell: (record) => (
                <span data-testid="record-machine">{machine(record.equipment)}</span>
              ),
            },
            {
              key: 'at',
              header: 'Completed',
              nowrap: true,
              cell: (record) => <PlantTime at={record.at} />,
            },
            { key: 'result', header: 'Result', cell: (record) => <Result record={record} /> },
            {
              key: 'lots',
              header: 'Lots',
              cell: (record) => <LotList lots={record.lots} testId="record-lots" />,
            },
            {
              key: 'operator',
              header: 'Device operator',
              nowrap: true,
              cell: (record) => <Operator record={record} />,
            },
            { key: 'crew', header: 'MES crew', cell: (record) => <Crew record={record} /> },
            { key: 'reading', header: 'Reading', cell: (record) => <Reading record={record} /> },
          ]}
        />
      )}
    </Section>
  );
}

function BlankLots({ unit }: { readonly unit: TraceUnitDto }) {
  const lots = blankLots(unit);
  if (lots === 'no-record') {
    return (
      <span data-testid="unit-blank-lots" data-reported="no-record" className="text-ink-secondary">
        No {BLANK_OPERATION} record
      </span>
    );
  }
  return <LotList lots={lots} testId="unit-blank-lots" none="No blank lot reported" />;
}

function Materials({ unit }: { readonly unit: TraceUnitDto }) {
  const components = componentPasses(unit);
  const machine = useMachineName();
  return (
    <Section
      id="trace-materials-title"
      testId="trace-materials"
      title="Materials"
      description={`The blank from its ${BLANK_OPERATION} record; the components per ${COMPONENTS_OPERATION} pass.`}
    >
      <div className="rounded-lg border border-line bg-surface p-5">
        <DescriptionList
          columns={2}
          facts={[
            {
              term: `Blank lot (${BLANK_OPERATION})`,
              detail: <BlankLots unit={unit} />,
            },
            {
              id: 'components',
              term: `Components (${COMPONENTS_OPERATION})`,
              detail:
                components.length === 0 ? (
                  <span data-testid="unit-components-empty" className="text-ink-secondary">
                    No component consumed yet (no {COMPONENTS_OPERATION} record).
                  </span>
                ) : (
                  <ul className="flex flex-col gap-2" data-testid="unit-components">
                    {components.map(({ record, lots }) => (
                      <li
                        key={`${record.equipment}-${String(record.epoch)}-${String(record.seq)}`}
                        data-testid={`unit-components-${record.operation}-${String(record.pass)}`}
                      >
                        <span className="block text-xs text-ink-secondary">
                          {operationText(record)} on {machine(record.equipment)}
                        </span>
                        <LotList lots={lots} layout="inline" none="No component reported." />
                      </li>
                    ))}
                  </ul>
                ),
            },
          ]}
        />
      </div>
    </Section>
  );
}

/** The sections of a unit's page, for the in-page index (design system 3.4). */
const UNIT_SECTIONS = [
  { id: 'trace-materials-title', label: 'Materials' },
  { id: 'trace-records-section-title', label: 'Operations' },
  { id: 'trace-holds-title', label: 'Quality holds' },
] as const;

function Unit({ unit }: { readonly unit: TraceUnitDto }) {
  const held = blocking(unit.holds);
  return (
    <div
      data-testid="trace-unit"
      data-epoch={String(unit.epoch)}
      data-part={String(unit.partId)}
      data-status={unit.status}
      data-order={unit.orderId ?? ''}
      data-carton={unit.carton ?? ''}
      data-held={String(held)}
    >
      {held ? (
        <HeldNotice testId="unit-held">
          This unit must not ship until quality releases it.
        </HeldNotice>
      ) : null}
      <SectionNav items={UNIT_SECTIONS} />
      <div className="mt-6">
        <Materials unit={unit} />
        <Records unit={unit} />
        <Holds
          holds={unit.holds}
          what="this unit, its lots, carton and order"
          {...(unit.serial === null
            ? {}
            : { subject: { kind: 'serial' as const, id: unit.serial } })}
        />
      </div>
    </div>
  );
}

/** Serials repeat across simulator runs (ADR-0034): with several units, the page asks which. */
function UnitChoice({
  trace,
  chosen,
}: {
  readonly trace: SerialTraceDto;
  readonly chosen: string | undefined;
}) {
  return (
    <div className="mb-6" data-testid="serial-units" data-count={String(trace.units.length)}>
      <Callout tone="info" title={chosen === undefined ? 'Which one?' : 'Showing one of them'}>
        {trace.units.length} units carry serial <Code>{trace.serial}</Code>: the simulator restarts
        its serial counter with every run.
        {chosen === undefined ? ' Choose the unit to trace.' : ''}
      </Callout>
      <div className="mt-3">
        <DataTable
          caption={`Units with serial ${trace.serial}`}
          testId="serial-units-table"
          rows={trace.units}
          rowKey={unitKey}
          activeRowKey={chosen}
          columns={[
            {
              key: 'unit',
              header: 'Unit',
              rowHeader: true,
              nowrap: true,
              cell: (unit) => (
                <>
                  <Link
                    to="/trace/serials/$serial"
                    params={{ serial: trace.serial }}
                    search={{ unit: unitKey(unit) }}
                    className={unitKey(unit) === chosen ? 'font-semibold text-ink' : linkClass}
                    data-testid={`serial-unit-${unitKey(unit)}`}
                  >
                    Run {unit.epoch}, part {unit.partId}
                  </Link>
                  {unit === trace.units[0] ? (
                    <span className="ml-2 text-xs text-ink-secondary">newest</span>
                  ) : null}
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              nowrap: true,
              cell: (unit) => <UnitStatusBadge status={unit.status} />,
            },
            {
              key: 'order',
              header: 'Order',
              nowrap: true,
              cell: (unit) =>
                unit.orderId === null ? (
                  <Missing reason="No order (schedule mode)" />
                ) : (
                  <Code>{unit.orderId}</Code>
                ),
            },
          ]}
        />
      </div>
    </div>
  );
}

/** The unit's key facts in the header: product, order, carton, run and part. */
function unitFacts(unit: TraceUnitDto): readonly (readonly [string, ReactNode])[] {
  return [
    ['Product', <Code key="product">{unit.product}</Code>],
    ['Order', <OrderLink key="order" order={unit.orderId} />],
    ['Carton', <CartonLink key="carton" carton={unit.carton} />],
    [
      'Run',
      <span key="run" className="tabular-nums">
        {unit.epoch}
      </span>,
    ],
    [
      'Part',
      <span key="part" className="tabular-nums">
        {unit.partId}
      </span>,
    ],
  ];
}

function SerialTrace({ serial, unit }: { readonly serial: string; readonly unit?: string }) {
  const read = useQuery({
    queryKey: queryKeys.traceSerial(serial),
    queryFn: ({ signal }) => getSerialTrace(serial, signal),
    refetchInterval: tracePolling(serialMoving),
  });
  const trace = read.data;
  if (trace === undefined) {
    if (read.error instanceof ApiError && read.error.status === 404) {
      return <TraceNotFound kind="serial" id={serial} />;
    }
    if (read.isError) {
      return (
        <div data-testid="trace-serial" data-serial={serial} data-units="">
          <PageHeader
            back={TRACE_BACK}
            title={idTitle('Serial', serial)}
            documentTitle={`Serial ${serial}`}
          />
          <QueryError what="the trace" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      );
    }
    return <TraceLoading label="Loading the trace…" />;
  }
  const single = trace.units.length === 1;
  const shown = single
    ? trace.units[0]
    : trace.units.find((candidate) => unitKey(candidate) === unit);
  return (
    <div data-testid="trace-serial" data-serial={serial} data-units={String(trace.units.length)}>
      <PageHeader
        back={TRACE_BACK}
        id="trace-serial-title"
        title={idTitle('Serial', serial)}
        documentTitle={`Serial ${serial}`}
        status={
          <span className="flex flex-wrap items-center gap-2">
            {shown ? <UnitStatusBadge status={shown.status} /> : null}
            {shown ? <HeldBadge holds={shown.holds} /> : null}
            <FinalityStatus final={trace.final} />
          </span>
        }
        description="Backward trace: the order, the blank lot, the components per pass, machines, operators, leak readings and the carton."
        meta={shown ? <HeaderFacts facts={unitFacts(shown)} /> : undefined}
      />
      <FinalityNotice final={trace.final} notFinal={trace.notFinal} />
      {read.isError ? (
        // A later read failed: the answer shown is the last one read; polling goes on.
        <div className="mb-6">
          <QueryError what="the trace" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {single ? null : <UnitChoice trace={trace} chosen={shown ? unitKey(shown) : undefined} />}
      {!single && unit !== undefined && !shown ? (
        <Callout tone="warn" role="status" className="mb-6" data-testid="serial-unit-unknown">
          No unit {unit} carries this serial: choose one above.
        </Callout>
      ) : null}
      {shown ? <Unit key={unitKey(shown)} unit={shown} /> : null}
    </div>
  );
}

/** `/trace/serials/$serial?unit=` (#202): the backward trace, keyed by the serial. */
export function TraceSerialRoute() {
  const { serial } = useParams({ from: '/trace/serials/$serial' });
  const { unit } = useSearch({ from: '/trace/serials/$serial' });
  useTraceTopics();
  if (!TRACE_ID.test(serial)) return <InvalidId kind="Serial" />;
  return <SerialTrace key={serial} serial={serial} {...(unit === undefined ? {} : { unit })} />;
}
