import {
  BLANK_OPERATION,
  COMPONENTS_OPERATION,
  type SerialTraceDto,
  type TraceRecordDto,
  type TraceUnitDto,
} from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ApiError } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { getSerialTrace } from '../api/trace.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { plainText } from '../domain/numbers.ts';
import { QueryError } from '../components/query-error.tsx';
import {
  RESULT_TEXT,
  TRACE_ID,
  blankLots,
  blocking,
  componentPasses,
  operationText,
  operatorText,
  overLimit,
  serialMoving,
  unitKey,
} from '../domain/trace.ts';
import { formatPlantTime } from '../domain/time.ts';
import { useTraceTopics } from '../live/live-context.tsx';
import {
  BackToSearch,
  CartonLink,
  Facts,
  Finality,
  Holds,
  LotList,
  OrderLink,
  Section,
  Table,
  cell,
  linkClass,
  plantTime,
  tracePolling,
  unitStatus,
} from './trace-common.tsx';

function Crew({ record }: { readonly record: TraceRecordDto }) {
  if (record.crew.length === 0) {
    // The MES joins its crew only where the machine has a device operator.
    return (
      <span data-testid="record-crew" data-count="0" className="text-slate-700">
        {record.operatorReported ? 'Nobody signed on' : '–'}
      </span>
    );
  }
  return (
    <ul data-testid="record-crew" data-count={String(record.crew.length)}>
      {record.crew.map((member) => (
        <li key={`${String(member.userId)}-${member.from}`} data-user={member.username}>
          <span className="font-medium">{member.username}</span>{' '}
          <span className="text-xs text-slate-700">
            from <time dateTime={member.from}>{formatPlantTime(member.from)}</time>
            {member.to === null ? (
              ', still signed on'
            ) : (
              <>
                {' '}
                to <time dateTime={member.to}>{formatPlantTime(member.to)}</time>
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
  if (reading === null) return <span className="text-slate-700">–</span>;
  const over = overLimit(reading);
  return (
    <span
      data-testid="record-reading"
      data-characteristic={reading.characteristic}
      data-value={String(reading.value)}
      data-limit={String(reading.upperLimit)}
      data-over={String(over)}
      className={over ? 'font-semibold text-red-900' : ''}
    >
      {plainText(reading.value)} {reading.unit}{' '}
      <span className="text-xs font-normal text-slate-700">
        ({over ? 'over' : 'within'} the limit {plainText(reading.upperLimit)} {reading.unit})
      </span>
    </span>
  );
}

function Records({ unit }: { readonly unit: TraceUnitDto }) {
  return (
    <Section id="trace-records-section" title="Operations">
      <p className="text-sm text-slate-700">
        Every cycle of the unit, by plant time: the machine, the lots it consumed, the device
        operator at the cycle’s start, the MES users signed on to the work center (not reconciled)
        and the leak reading.
      </p>
      {unit.records.length === 0 ? (
        <p className="mt-1 text-sm" data-testid="trace-records-empty">
          No cycle recorded yet.
        </p>
      ) : (
        <div className="mt-2">
          <Table
            testId="trace-records"
            caption="Operations of the unit"
            count={unit.records.length}
            columns={[
              'Operation',
              'Machine',
              'Completed',
              'Result',
              'Lots',
              'Device operator',
              'MES crew',
              'Reading',
            ]}
          >
            {unit.records.map((record) => (
              <tr
                key={`${record.equipment}-${String(record.epoch)}-${String(record.seq)}`}
                data-testid={`record-${record.operation}-${String(record.pass)}`}
                data-equipment={record.equipment}
                data-result={record.result}
                data-epoch={String(record.epoch)}
                data-seq={String(record.seq)}
                className="border-t border-slate-200"
              >
                <th scope="row" className={cell}>
                  {operationText(record)}
                </th>
                <td className={cell} data-testid="record-machine">
                  {record.equipment}
                </td>
                <td className={cell}>{plantTime(record.at)}</td>
                <td className={cell}>
                  {RESULT_TEXT[record.result]}
                  {record.reason ? ` (${record.reason})` : ''}
                </td>
                <td className={cell}>
                  <LotList lots={record.lots} testId="record-lots" />
                </td>
                <td
                  className={cell}
                  data-testid="record-operator"
                  data-reported={String(record.operatorReported)}
                >
                  {operatorText(record)}
                </td>
                <td className={cell}>
                  <Crew record={record} />
                </td>
                <td className={cell}>
                  <Reading record={record} />
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Section>
  );
}

function BlankLots({ unit }: { readonly unit: TraceUnitDto }) {
  const lots = blankLots(unit);
  if (lots === 'no-record') {
    return (
      <span data-testid="unit-blank-lots" data-reported="no-record" className="text-slate-700">
        No {BLANK_OPERATION} record
      </span>
    );
  }
  return <LotList lots={lots} testId="unit-blank-lots" />;
}

function Materials({ unit }: { readonly unit: TraceUnitDto }) {
  const components = componentPasses(unit);
  return (
    <Section id="trace-materials" title="Materials">
      <Facts items={[['Blank lot', <BlankLots key="blank" unit={unit} />]]} />
      {components.length === 0 ? (
        <p className="mt-1 text-sm" data-testid="unit-components-empty">
          No component consumed yet (no {COMPONENTS_OPERATION} record).
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="unit-components">
          {components.map(({ record, lots }) => (
            <li
              key={`${record.equipment}-${String(record.epoch)}-${String(record.seq)}`}
              data-testid={`unit-components-${record.operation}-${String(record.pass)}`}
            >
              <span className="text-slate-700">
                Components at {operationText(record)} on {record.equipment}:
              </span>{' '}
              <LotList lots={lots} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

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
      className="mt-4"
    >
      {held ? (
        <p
          role="status"
          data-testid="unit-held"
          className="mb-2 rounded border border-red-700 bg-red-50 p-2 text-sm font-semibold text-red-950"
        >
          On quality hold: this unit must not ship until quality releases it.
        </p>
      ) : null}
      <Facts
        items={[
          ['Product', unit.product],
          ['Status', unitStatus(unit.status)],
          ['Order', <OrderLink key="o" order={unit.orderId} />],
          ['Carton', <CartonLink key="c" carton={unit.carton} />],
          ['Run (device epoch)', String(unit.epoch)],
          ['Part', String(unit.partId)],
        ]}
      />
      <Materials unit={unit} />
      <Records unit={unit} />
      <Holds
        holds={unit.holds}
        what="this unit, its lots, carton and order"
        {...(unit.serial === null ? {} : { subject: { kind: 'serial' as const, id: unit.serial } })}
      />
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
    <div
      className="mt-3 rounded border border-slate-400 bg-white p-3 text-sm"
      data-testid="serial-units"
      data-count={String(trace.units.length)}
    >
      <p>
        {trace.units.length} units carry serial {trace.serial} (the simulator restarts its serial
        counter with every run). {chosen === undefined ? 'Which one?' : 'Showing:'}
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {trace.units.map((unit, index) => {
          const key = unitKey(unit);
          const current = key === chosen;
          return (
            <li key={key}>
              <Link
                to="/trace/serials/$serial"
                params={{ serial: trace.serial }}
                search={{ unit: key }}
                className={current ? 'font-semibold' : linkClass}
                data-testid={`serial-unit-${key}`}
              >
                Run {unit.epoch}, part {unit.partId}
              </Link>{' '}
              <span className="text-slate-700">
                {unitStatus(unit.status)}
                {unit.orderId ? `, order ${unit.orderId}` : ''}
                {index === 0 ? ' (newest)' : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SerialTrace({ serial, unit }: { readonly serial: string; readonly unit?: string }) {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const read = useQuery({
    queryKey: queryKeys.traceSerial(serial),
    queryFn: ({ signal }) => getSerialTrace(serial, signal),
    refetchInterval: tracePolling(serialMoving),
  });
  const missing = read.error instanceof ApiError && read.error.status === 404;
  const trace = read.data;
  const single = trace?.units.length === 1;
  const shown = single
    ? trace.units[0]
    : trace?.units.find((candidate) => unitKey(candidate) === unit);
  return (
    <section
      aria-labelledby="trace-serial-title"
      data-testid="trace-serial"
      data-serial={serial}
      data-units={trace ? String(trace.units.length) : ''}
    >
      <BackToSearch />
      <h1 ref={heading} id="trace-serial-title" tabIndex={-1} className="mt-1 text-2xl font-bold">
        Serial {serial}
      </h1>
      <p className="mt-1 text-sm text-slate-700">
        Backward trace: the order, the blank lot, the components per pass, machines, operators, leak
        readings and the carton.
      </p>
      {read.isPending ? <p className="mt-4">Loading the trace…</p> : null}
      {missing ? (
        <p className="mt-4" data-testid="trace-missing">
          The MES has no unit with serial {serial}.
        </p>
      ) : read.isError ? (
        <div className="mt-4">
          <QueryError what="the trace" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {trace ? (
        <>
          <Finality final={trace.final} notFinal={trace.notFinal} />
          {single ? null : <UnitChoice trace={trace} chosen={shown ? unitKey(shown) : undefined} />}
          {!single && unit !== undefined && !shown ? (
            <p role="status" className="mt-2 text-sm" data-testid="serial-unit-unknown">
              No unit {unit} carries this serial: choose one above.
            </p>
          ) : null}
          {shown ? <Unit key={unitKey(shown)} unit={shown} /> : null}
        </>
      ) : null}
    </section>
  );
}

/** `/trace/serials/$serial?unit=` (#202): the backward trace, keyed by the serial. */
export function TraceSerialRoute() {
  const { serial } = useParams({ from: '/trace/serials/$serial' });
  const { unit } = useSearch({ from: '/trace/serials/$serial' });
  useTraceTopics();
  if (!TRACE_ID.test(serial)) {
    return (
      <section>
        <BackToSearch />
        <h1 className="mt-1 text-2xl font-bold">Serial</h1>
        <p className="mt-2" data-testid="trace-invalid">
          This is not a serial the MES could know.
        </p>
      </section>
    );
  }
  return <SerialTrace key={serial} serial={serial} {...(unit === undefined ? {} : { unit })} />;
}
