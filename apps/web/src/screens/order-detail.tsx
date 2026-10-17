import type {
  CommandDetailDto,
  ConfirmationDto,
  EquipmentDto,
  OrderDetail as OrderDetailDto,
  OrderDto,
  OrderExecutionDto,
} from '@shopfloor/contracts/mes-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState, type ReactNode } from 'react';
import { ApiError, listEquipment } from '../api/client.ts';
import {
  getExecutionIncidents,
  getOrder,
  getOrderExecution,
  getOrderScrap,
} from '../api/orders.ts';
import { queryKeys } from '../api/queries.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { CommandStateBadge, OrderFlags, OrderStatusBadge } from '../components/order-badges.tsx';
import { QueryError } from '../components/query-error.tsx';
import {
  ACTION_TEXT,
  COMMAND_STATE_TEXT,
  RESULT_TEXT,
  canAbandon,
  countsText,
  dispatchTargets,
  draftFor,
  mergeCommands,
  newestOrder,
  type ActionDraft,
} from '../domain/orders.ts';
import { formatPlantTime } from '../domain/time.ts';
import { useLiveOrders, useOrdersTopic } from '../live/live-context.tsx';
import {
  ActionForm,
  buttonClass,
  offeredActions,
  useOrderPermissions,
  type Done,
} from './order-actions.tsx';

/** The MES's order id rule (`orderParams`): anything else is no order. */
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** Execution has no push yet (#177 may add one): its reads are polled while the order is open. */
export const EXECUTION_POLL_MS = 10_000;

const cell = 'px-2 py-1.5 align-top';
const head = `${cell} font-semibold`;

const time = (value: string | null): ReactNode =>
  value === null ? '–' : <time dateTime={value}>{formatPlantTime(value)}</time>;

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} data-testid={id} className="mt-6">
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Table({
  testId,
  caption,
  columns,
  children,
}: {
  readonly testId: string;
  readonly caption: string;
  readonly columns: readonly string[];
  readonly children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-300 bg-white">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-slate-100">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className={head}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Facts({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="text-slate-700">{label}:</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OrderSummary({ order }: { readonly order: OrderDto }) {
  return (
    <div data-testid="order-summary" data-version={String(order.version)}>
      <p className="flex flex-wrap items-center gap-2">
        <OrderStatusBadge order={order} />
        <OrderFlags order={order} />
        <span className="text-sm text-slate-700">
          Version {order.version}, ERP revision {order.revision}
          {order.erpStatus === 'cancelled' ? ', cancelled in the ERP' : ''}
        </span>
      </p>
      {order.rejection ? (
        <p role="status" className="mt-2 text-sm text-red-900" data-testid="order-rejection">
          Rejected at import: {order.rejection}
        </p>
      ) : null}
      <div className="mt-3">
        <Facts
          items={[
            ['Product', order.product],
            ['Quantity', `${String(order.quantity)} blanks`],
            [
              'Dispatched',
              <span key="v" data-testid="order-dispatched">
                {order.dispatched}
              </span>,
            ],
            [
              'Remaining',
              <span key="v" data-testid="order-remaining">
                {order.remaining}
              </span>,
            ],
            ['Priority', order.priority],
            ['Planned start', time(order.plannedStart)],
            ['Due', time(order.dueDate)],
            ['Released', time(order.releasedAt)],
            ['Dispatched at', time(order.dispatchedAt)],
            ['Started', time(order.startedAt)],
            ['Completed', time(order.completedAt)],
            ['Closed', time(order.closedAt)],
            ['Cancelled', time(order.cancelledAt)],
          ]}
        />
      </div>
    </div>
  );
}

function Actions({
  order,
  commands,
  targets,
  open,
  setOpen,
  onWritten,
}: {
  readonly order: OrderDto;
  readonly commands: readonly CommandDetailDto[];
  readonly targets: readonly EquipmentDto[];
  readonly open: ActionDraft | undefined;
  readonly setOpen: (draft: ActionDraft | undefined) => void;
  readonly onWritten: () => Promise<void>;
}) {
  const allowed = useOrderPermissions();
  const offered = offeredActions(order, allowed);
  const [done, setDone] = useState<Done | undefined>(undefined);
  const anyPermission = Object.values(allowed).some(Boolean);
  const opener = useRef<HTMLDivElement>(null);
  return (
    <Section id="order-actions" title="Actions">
      {!anyPermission ? (
        <p className="text-sm" data-testid="order-read-only">
          Your role cannot change orders: they are shown read-only.
        </p>
      ) : offered.length === 0 && !open ? (
        <p className="text-sm" data-testid="order-no-actions">
          No action applies to an order in this status.
        </p>
      ) : null}
      {done && !open ? (
        <p role="status" data-testid="action-done" className="mb-2 text-sm text-emerald-900">
          {done.text}
        </p>
      ) : null}
      {!open ? (
        <div ref={opener} className="flex flex-wrap gap-2">
          {offered.map((action) => (
            <button
              key={action}
              type="button"
              data-testid={`action-${action}`}
              className={buttonClass}
              onClick={() => {
                setDone(undefined);
                setOpen(draftFor(action, order));
              }}
            >
              {ACTION_TEXT[action].label}
            </button>
          ))}
        </div>
      ) : (
        <ActionForm
          // A new draft (another action, command or version) starts a new form: no state of the
          // previous one carries over (#176 review M2).
          key={`${open.action}:${open.commandId}:${String(open.version)}`}
          order={order}
          commands={commands}
          targets={targets}
          initial={open}
          onWritten={onWritten}
          onClose={(result) => {
            setOpen(undefined);
            setDone(result);
            requestAnimationFrame(() => opener.current?.querySelector('button')?.focus());
          }}
        />
      )}
    </Section>
  );
}

function CommandRow({
  command,
  order,
  mayAbandon,
  onAbandon,
}: {
  readonly command: CommandDetailDto;
  readonly order: OrderDto;
  readonly mayAbandon: boolean;
  readonly onAbandon: () => void;
}) {
  const state = COMMAND_STATE_TEXT[command.state];
  return (
    <li
      data-testid={`command-${command.commandId}`}
      data-state={command.state}
      className="rounded-lg border border-slate-300 bg-white p-3"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold">{command.commandId}</span>
        <CommandStateBadge state={command.state} />
        {command.confirmed ? (
          <span className="text-xs text-emerald-900" data-testid="command-confirmed">
            Confirmed by its device fact
          </span>
        ) : null}
        {command.failed && command.state !== 'failed' ? (
          <span className="text-xs text-amber-950">Declared failed once (incident raised)</span>
        ) : null}
      </p>
      <p className="mt-1 text-sm text-slate-800">{state.meaning}</p>
      <div className="mt-2">
        <Facts
          items={[
            ['CNC', command.equipment],
            ['Blanks', command.quantity],
            ['Not before', time(command.notBefore)],
            ['Device run', command.deviceEpoch],
            ['Settled', command.settled ? 'yes' : 'no'],
            ['Job', command.job ?? '–'],
            [
              'Accepted',
              command.acceptedAt === null ? (
                '–'
              ) : (
                <span>
                  {time(command.acceptedAt)} (seq {command.acceptedSeq ?? '–'}, by{' '}
                  {command.acceptedBy ?? '–'})
                </span>
              ),
            ],
            ['Started', time(command.startedAt)],
            ['Completed', time(command.completedAt)],
            ['Rejection', command.rejection ?? '–'],
            ['Seq after expiry', command.seqAfterExpiry ?? '–'],
            ['Deliveries', command.attempts],
          ]}
        />
      </div>
      {mayAbandon && canAbandon(order, command) ? (
        <button
          type="button"
          data-testid={`abandon-${command.commandId}`}
          className={`${buttonClass} mt-2`}
          onClick={onAbandon}
        >
          {ACTION_TEXT.abandon.label}
        </button>
      ) : null}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">
          Deliveries ({command.attemptList.length}) and results ({command.results.length})
        </summary>
        <ol className="mt-1 flex flex-col gap-1" aria-label="Deliveries">
          {command.attemptList.map((attempt) => (
            <li key={attempt.attempt} data-testid="command-attempt">
              Delivery {attempt.attempt}: written{' '}
              <time dateTime={attempt.issuedAt}>{attempt.issuedAt}</time>,{' '}
              {attempt.publishedAt ? (
                <>
                  published <time dateTime={attempt.publishedAt}>{attempt.publishedAt}</time>
                </>
              ) : (
                'never published'
              )}
              , expires <time dateTime={attempt.expiresAt}>{attempt.expiresAt}</time> (wall time)
            </li>
          ))}
        </ol>
        <ol className="mt-2 flex flex-col gap-1" aria-label="Results">
          {command.results.map((result, index) => (
            <li
              key={`${result.receivedAt}-${String(index)}`}
              data-testid="command-result"
              data-result={result.result}
            >
              <span className="font-medium">{RESULT_TEXT[result.result]}</span>
              {result.code ? ` (${result.code})` : ''} from {result.equipment}, run{' '}
              {result.deviceEpoch}, for the delivery expiring {result.expiresAt}
              {result.acceptedSeq === null ? '' : `; accepted seq ${String(result.acceptedSeq)}`}
              {result.position === null ? '' : `, queue position ${String(result.position)}`}
              {result.seqAfterExpiry === null
                ? ''
                : `; seq after expiry ${String(result.seqAfterExpiry)}`}
              {result.reason ? `; ${result.reason}` : ''}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function Commands({
  order,
  commands,
  formOpen,
  onAbandon,
}: {
  readonly order: OrderDto;
  readonly commands: readonly CommandDetailDto[];
  /** An action form is open: no second one is started from a command (#176 review M2). */
  readonly formOpen: boolean;
  readonly onAbandon: (commandId: string) => void;
}) {
  const mayAbandon = useOrderPermissions().abandon && !formOpen;
  return (
    <Section id="order-commands" title="Commands and results">
      {commands.length === 0 ? (
        <p className="text-sm" data-testid="commands-empty">
          No command yet: the order is dispatched with one.
        </p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Commands">
          {commands.map((command) => (
            <CommandRow
              key={command.commandId}
              command={command}
              order={order}
              mayAbandon={mayAbandon}
              onAbandon={() => {
                onAbandon(command.commandId);
              }}
            />
          ))}
        </ol>
      )}
    </Section>
  );
}

function Operations({
  detail,
  execution,
}: {
  readonly detail: OrderDetailDto;
  readonly execution: { data?: OrderExecutionDto; error: unknown; refetch: () => void };
}) {
  const operations = execution.data?.operations;
  return (
    <Section id="order-operations" title="Operations and quantities">
      {execution.error ? (
        <QueryError
          what="the order's execution"
          error={execution.error}
          onRetry={execution.refetch}
        />
      ) : null}
      <Table
        testId="operation-table"
        caption="Operations and quantities"
        columns={[
          'Operation',
          'Work center',
          'In',
          'Good',
          'Scrap',
          'Rework',
          'Material',
          'Complete',
        ]}
      >
        {(operations ?? detail.routing.map((step) => ({ ...step, missing: true as const }))).map(
          (row) =>
            'missing' in row ? (
              <tr key={row.operation} className="border-t border-slate-200">
                <th scope="row" className={cell}>
                  {row.operation}
                </th>
                <td className={cell}>{row.workCenter}</td>
                <td className={cell} colSpan={6}>
                  {execution.error ? '–' : 'Loading…'}
                </td>
              </tr>
            ) : (
              <tr
                key={row.operation}
                data-testid={`operation-${row.operation}`}
                className="border-t border-slate-200"
              >
                <th scope="row" className={cell}>
                  {row.operation}
                </th>
                <td className={cell}>{row.workCenter ?? '–'}</td>
                <td className={`${cell} tabular-nums`}>{row.in}</td>
                <td className={`${cell} tabular-nums`} data-testid={`good-${row.operation}`}>
                  {row.good}
                </td>
                <td className={cell}>{countsText(row.scrap)}</td>
                <td className={`${cell} tabular-nums`}>{row.rework}</td>
                <td className={cell}>{countsText(row.material)}</td>
                <td className={cell}>{time(row.completedAt)}</td>
              </tr>
            ),
        )}
      </Table>
      {execution.data ? <Wip execution={execution.data} /> : null}
      {detail.bom.length > 0 ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer">
            Bill of materials ({detail.bom.length} lines)
          </summary>
          <ul className="mt-1">
            {detail.bom.map((line) => (
              <li key={`${line.operation}-${line.material}-${line.usage}`}>
                {line.operation}: {line.quantityPerUnit} × {line.material}
                {line.usage === 'rework' ? ' (rework)' : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

function Wip({ execution }: { readonly execution: OrderExecutionDto }) {
  return (
    <div className="mt-3" data-testid="order-wip">
      <h3 className="font-semibold">Execution and WIP</h3>
      <Facts
        items={[
          ['Units', execution.units.total],
          [
            'In WIP',
            <span key="v" data-testid="wip-count">
              {execution.units.wip}
            </span>,
          ],
          ['Packed', execution.units.packed],
          ['Scrapped', execution.units.scrapped],
          ['Lost', execution.units.lost],
          ['Packed good', execution.packedGood],
          ['Rework passes', execution.reworkPasses],
          ['WIP by position', countsText(execution.wip)],
          ['Blanks in a CNC', countsText(execution.inMachine)],
          ['Complete', time(execution.completedAt)],
        ]}
      />
    </div>
  );
}

function Incidents({
  detail,
  execution,
}: {
  readonly detail: OrderDetailDto;
  readonly execution: {
    readonly id: number;
    readonly message: string;
    readonly detectedAt: string;
    readonly closedAt: string | null;
    readonly resolution: string | null;
  }[];
}) {
  const rows = [
    ...detail.incidents.map((incident) => ({ ...incident, key: `o${String(incident.id)}` })),
    ...execution.map((incident) => ({
      ...incident,
      type: 'routing-violation' as const,
      key: `e${String(incident.id)}`,
    })),
  ].sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  return (
    <Section id="order-incidents" title="Incidents">
      {rows.length === 0 ? (
        <p className="text-sm" data-testid="incidents-empty">
          No incident for this order.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Incidents">
          {rows.map((incident) => (
            <li
              key={incident.key}
              data-testid="order-incident"
              data-type={incident.type}
              data-open={String(incident.closedAt === null)}
              className={`rounded border p-2 ${incident.closedAt === null ? 'border-red-800 bg-red-50' : 'border-slate-300 bg-white'}`}
            >
              <p>
                <span className="font-semibold">{incident.type}</span>
                {incident.closedAt === null ? ' (open)' : ' (closed)'}: {incident.message}
              </p>
              <p className="text-xs text-slate-700">
                Detected <time dateTime={incident.detectedAt}>{incident.detectedAt}</time>
                {incident.closedAt ? `, closed ${incident.closedAt}` : ''}
                {incident.resolution ? ` (${incident.resolution})` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Confirmations({ confirmations }: { readonly confirmations: readonly ConfirmationDto[] }) {
  return (
    <Section id="order-confirmations" title="Confirmations to the ERP">
      {confirmations.length === 0 ? (
        <p className="text-sm" data-testid="confirmations-empty">
          None yet: an operation is confirmed once no unit can come back to it.
        </p>
      ) : (
        <Table
          testId="confirmation-table"
          caption="Confirmations to the ERP"
          columns={[
            'Operation',
            'No.',
            'Kind',
            'Yield',
            'Scrap',
            'Rework',
            'Material',
            'Confirmed',
            'Message',
          ]}
        >
          {confirmations.map((row) => (
            <tr
              key={row.idempotencyKey}
              data-testid={`confirmation-${row.operation}-${String(row.n)}`}
              data-status={row.messageStatus}
              className="border-t border-slate-200"
            >
              <th scope="row" className={cell}>
                {row.operation}
              </th>
              <td className={cell}>{row.n}</td>
              <td className={cell}>{row.kind === 'final' ? 'Final' : 'Correction (deltas)'}</td>
              <td className={`${cell} tabular-nums`}>{row.yield}</td>
              <td className={cell}>{countsText(row.scrap)}</td>
              <td className={`${cell} tabular-nums`}>{row.reworkPasses}</td>
              <td className={cell}>{countsText(row.material)}</td>
              <td className={cell}>{time(row.confirmedAt)}</td>
              <td className={cell}>{row.messageStatus}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function Scrap({ id }: { readonly id: string }) {
  const read = useQuery({
    queryKey: queryKeys.orderScrap(id),
    queryFn: ({ signal }) => getOrderScrap(id, signal),
    refetchInterval: EXECUTION_POLL_MS,
  });
  const records = read.data?.records ?? [];
  return (
    <Section id="order-scrap" title="Scrap records">
      <p className="text-sm text-slate-700">
        Machine scrap of the order; operators and quality code it on the terminal.
      </p>
      {read.isError ? (
        <QueryError
          what="the scrap records"
          error={read.error}
          onRetry={() => void read.refetch()}
        />
      ) : null}
      {read.data && records.length === 0 ? (
        <p className="mt-1 text-sm" data-testid="scrap-empty">
          No scrap.
        </p>
      ) : null}
      {records.length > 0 ? (
        <Table
          testId="scrap-table"
          caption="Scrap records"
          columns={['Part', 'Operation', 'Machine reason', 'Coded reason', 'Scrapped']}
        >
          {records.map((record) => (
            <tr key={record.id} className="border-t border-slate-200" data-testid="scrap-record">
              <th scope="row" className={cell}>
                {record.serial ?? `part ${String(record.partId)}`}
              </th>
              <td className={cell}>
                {record.operation} on {record.equipment}
                {record.pass > 1 ? ` (pass ${String(record.pass)})` : ''}
              </td>
              <td className={cell}>{record.machineReason}</td>
              <td className={cell}>
                {record.codedReason
                  ? `${record.codedReason} by ${record.codedBy ?? '–'}`
                  : 'not coded'}
              </td>
              <td className={cell}>{time(record.scrappedAt)}</td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Section>
  );
}

function ErpMessages({ detail }: { readonly detail: OrderDetailDto }) {
  return (
    <Section id="order-erp" title="ERP messages">
      {detail.erpMessages.length === 0 ? (
        <p className="text-sm">None.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm" aria-label="ERP messages">
          {detail.erpMessages.map((message) => (
            <li
              key={message.id}
              data-testid="erp-message"
              className="rounded border border-slate-300 bg-white p-2"
            >
              <p>
                {message.direction === 'in' ? 'From the ERP' : 'To the ERP'}: {message.kind},
                revision {message.revision}, <span className="font-semibold">{message.status}</span>
                {message.detail ? ` (${message.detail})` : ''}
                {message.attempts > 1 ? `, ${String(message.attempts)} attempts` : ''}
                {message.lastError ? `; last error: ${message.lastError}` : ''}
              </p>
              <details>
                <summary className="cursor-pointer text-xs">Payload</summary>
                <pre className="overflow-x-auto text-xs">
                  {JSON.stringify(message.payload, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function History({ detail }: { readonly detail: OrderDetailDto }) {
  return (
    <Section id="order-history" title="History">
      {detail.history.length === 0 ? (
        <p className="text-sm">No change recorded.</p>
      ) : (
        <ol className="flex flex-col gap-1 text-sm" aria-label="History">
          {detail.history.map((entry) => (
            <li key={entry.id} data-testid="order-history-entry" data-action={entry.action}>
              <span className="font-medium">{entry.action}</span> by {entry.actor}
              {entry.authenticated ? '' : ' (not authenticated)'} at{' '}
              <time dateTime={entry.at}>{entry.at}</time>
              {entry.plantAt ? <> (plant {formatPlantTime(entry.plantAt)})</> : null}
              {entry.requestId ? `, request ${entry.requestId}` : ''}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/** One order (#176): what it is, its actions, operations, commands, incidents and confirmations. */
function OrderDetail({ id }: { readonly id: string }) {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const queryClient = useQueryClient();
  const read = useQuery({
    queryKey: queryKeys.order(id),
    queryFn: ({ signal }) => getOrder(id, signal),
  });
  const execution = useQuery({
    queryKey: queryKeys.orderExecution(id),
    queryFn: ({ signal }) => getOrderExecution(id, signal),
    refetchInterval: EXECUTION_POLL_MS,
    enabled: read.data !== undefined,
  });
  const executionIncidents = useQuery({
    queryKey: queryKeys.executionIncidents(id),
    queryFn: ({ signal }) => getExecutionIncidents(id, signal),
    refetchInterval: EXECUTION_POLL_MS,
    enabled: read.data !== undefined,
  });
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const live = useLiveOrders();
  const [open, setOpen] = useState<ActionDraft | undefined>(undefined);
  const onWritten = async () => {
    await queryClient.refetchQueries({ queryKey: queryKeys.order(id) });
  };
  const missing = read.error instanceof ApiError && read.error.status === 404;
  const detail = read.data;
  const order = detail ? newestOrder(detail.order, live?.orders[id]) : undefined;
  const commands = detail ? mergeCommands(id, detail.commands, live?.commands) : [];
  return (
    <section aria-labelledby="order-title" data-testid="order-detail" data-order={id}>
      <p className="text-sm">
        <Link to="/orders" search={{}} className="text-sky-800 underline">
          All orders
        </Link>
      </p>
      <h1 ref={heading} id="order-title" tabIndex={-1} className="mt-1 text-2xl font-bold">
        Order {id}
      </h1>
      {read.isPending ? <p className="mt-4">Loading the order…</p> : null}
      {missing ? (
        <p className="mt-4" data-testid="order-missing">
          The MES has no order {id}.
        </p>
      ) : read.isError ? (
        <div className="mt-4">
          <QueryError what="the order" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {detail && order ? (
        <>
          <div className="mt-3">
            <OrderSummary order={order} />
          </div>
          <Actions
            order={order}
            commands={commands}
            targets={dispatchTargets(equipment.data ?? [], detail.routing)}
            open={open}
            setOpen={setOpen}
            onWritten={onWritten}
          />
          <Operations
            detail={detail}
            execution={{
              ...(execution.data ? { data: execution.data } : {}),
              error: execution.error,
              refetch: () => void execution.refetch(),
            }}
          />
          <Commands
            order={order}
            commands={commands}
            formOpen={open !== undefined}
            onAbandon={(commandId) => {
              setOpen(draftFor('abandon', order, commandId));
            }}
          />
          <Incidents detail={detail} execution={executionIncidents.data?.incidents ?? []} />
          <Confirmations confirmations={detail.confirmations} />
          <Scrap id={id} />
          <ErpMessages detail={detail} />
          <History detail={detail} />
        </>
      ) : null}
    </section>
  );
}

/**
 * The route's screen: keyed by the order id, so another order starts with no open action, draft
 * or message of this one (the lesson of #146: panels keyed by id), and holding the `orders` topic.
 */
export function OrderDetailRoute() {
  const { id } = useParams({ from: '/orders/$id' });
  useOrdersTopic();
  if (!ORDER_ID.test(id)) {
    return (
      <section>
        <h1 className="text-2xl font-bold">Order {id}</h1>
        <p className="mt-2" data-testid="order-missing">
          No order has this id.
        </p>
      </section>
    );
  }
  return <OrderDetail key={id} id={id} />;
}
