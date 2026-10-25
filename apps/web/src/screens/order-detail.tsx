import type {
  CommandDetailDto,
  ConfirmationDto,
  ErpMessageDto,
  OrderDetail as OrderDetailDto,
  OrderDto,
  OrderExecutionDto,
  ScrapRecordDto,
} from '@shopfloor/contracts/mes-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ApiError, listEquipment } from '../api/client.ts';
import {
  getExecutionIncidents,
  getOrder,
  getOrderExecution,
  getOrderScrap,
} from '../api/orders.ts';
import { queryKeys, usePlantClock } from '../api/queries.ts';
import { getHolds, holdFilterKey, qualityKeys, type HoldFilter } from '../api/quality.ts';
import { useCan } from '../auth/auth.tsx';
import {
  CommandStateBadge,
  OrderFlags,
  OrderPriorityBadge,
  OrderStatusBadge,
  OverdueBadge,
} from '../components/order-badges.tsx';
import { QueryError } from '../components/query-error.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button, buttonClass, type ButtonVariant } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { CARD_TONE_BAR } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { DescriptionList, type Fact } from '../components/ui/description-list.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, PlantTime, WallTime } from '../components/ui/format.tsx';
import { NotFound } from '../components/ui/not-found.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { SectionNav, type SectionNavItem } from '../components/ui/section-nav.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import {
  ACTION_TEXT,
  COMMAND_STATE_TEXT,
  RESULT_TEXT,
  canAbandon,
  countsText,
  dispatchTargets,
  draftFor,
  erpStatusTone,
  isOverdue,
  mergeCommands,
  newestOrder,
  orderCodeWords,
  type ActionDraft,
  type OrderLevelAction,
} from '../domain/orders.ts';
import { formatPlantTime, formatPlantTimeMinutes, wallTimeText } from '../domain/time.ts';
import { mergeHolds } from '../domain/quality.ts';
import {
  useLiveOrders,
  useLiveQuality,
  useOrdersTopic,
  useQualityTopic,
} from '../live/live-context.tsx';
import { HoldTable } from './holds.tsx';
import { OrderOee } from './order-oee.tsx';
import { ActionForm, offeredActions, useOrderPermissions, type Done } from './order-actions.tsx';

/** The MES's order id rule (`orderParams`): anything else is no order. */
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** Execution has no push yet (#177 may add one): its reads are polled while the order is open. */
export const EXECUTION_POLL_MS = 10_000;

const BACK = { label: 'All orders', link: { to: '/orders', search: {} } } as const;

/**
 * The page's sections in reading order: the in-page index (Q-01) links to their headings' ids,
 * which are also the ids the sections had before (`order-oee-title` is `OrderOee`'s own).
 */
const SECTIONS: readonly SectionNavItem[] = [
  { id: 'order-operations-title', label: 'Operations' },
  { id: 'order-oee-title', label: 'OEE and yield' },
  { id: 'order-commands-title', label: 'Commands' },
  { id: 'order-holds-title', label: 'Quality holds' },
  { id: 'order-incidents-title', label: 'Incidents' },
  { id: 'order-confirmations-title', label: 'Confirmations' },
  { id: 'order-scrap-title', label: 'Scrap' },
  { id: 'order-erp-title', label: 'ERP messages' },
  { id: 'order-history-title', label: 'History' },
];

/** A plant time or, when the step has not happened, nothing (the fact is left out). */
const happened = (value: string | null): ReactNode =>
  value === null ? null : <PlantTime at={value} />;

/** An empty section's one line, in the frame tables and cards have (design system 4.11). */
function EmptyBlock({
  testId,
  title,
  body,
}: {
  readonly testId?: string;
  readonly title: ReactNode;
  readonly body?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4">
      <EmptyState size="inline" icon="info" testId={testId} title={title} body={body} />
    </div>
  );
}

/** The key facts (Q-02): flowing by column, the steps not taken yet left out. */
function OrderFacts({ order }: { readonly order: OrderDto }) {
  const facts: Fact[] = [
    {
      term: 'Blanks dispatched',
      detail: (
        <span className="tabular-nums" data-testid="order-dispatched">
          {order.dispatched}
        </span>
      ),
    },
    {
      term: 'Blanks remaining',
      detail: (
        <span className="tabular-nums" data-testid="order-remaining">
          {order.remaining}
        </span>
      ),
    },
    { term: 'Priority', detail: <OrderPriorityBadge priority={order.priority} /> },
    { term: 'Planned start', detail: <PlantTime at={order.plannedStart} seconds={false} /> },
    { term: 'Released', detail: happened(order.releasedAt) },
    { term: 'Dispatched', detail: happened(order.dispatchedAt) },
    { term: 'Started', detail: happened(order.startedAt) },
    { term: 'Completed', detail: happened(order.completedAt) },
    { term: 'Closed', detail: happened(order.closedAt) },
    { term: 'Cancelled', detail: happened(order.cancelledAt) },
    {
      term: 'Version',
      detail: (
        <span className="tabular-nums">
          {order.version} (ERP revision {order.revision})
        </span>
      ),
    },
  ];
  return (
    <div data-testid="order-summary" data-version={String(order.version)} className="mt-2">
      <DescriptionList facts={facts} label="Order facts" />
    </div>
  );
}

/** The variant of an order action (design system 4.1): cancel `danger`, the first other `primary`. */
function variantOf(action: OrderLevelAction, offered: readonly OrderLevelAction[]): ButtonVariant {
  if (action === 'cancel') return 'danger';
  return offered.find((other) => other !== 'cancel') === action ? 'primary' : 'secondary';
}

/**
 * The header's actions (Q-01): the order's writes beside its status, the primary one last (on the
 * right), and the way to hold the order. Every `action-*` stays a visible button: the specs click
 * them by id. While a write is being prepared its form replaces the buttons.
 */
function HeaderActions({
  id,
  offered,
  formOpen,
  noneApplies,
  canHold,
  onOpen,
}: {
  readonly id: string;
  readonly offered: readonly OrderLevelAction[];
  readonly formOpen: boolean;
  readonly noneApplies: boolean;
  readonly canHold: boolean;
  readonly onOpen: (action: OrderLevelAction) => void;
}) {
  const ordered = [...offered].sort(
    (a, b) =>
      Number(variantOf(a, offered) === 'primary') - Number(variantOf(b, offered) === 'primary'),
  );
  return (
    <>
      {noneApplies ? (
        <p className="self-center text-sm text-ink-secondary" data-testid="order-no-actions">
          No action applies to an order in this status.
        </p>
      ) : null}
      {canHold ? (
        <Link
          to="/quality/holds/new"
          search={{ kind: 'order', id }}
          data-testid="order-hold-open"
          className={buttonClass({ variant: 'secondary' })}
        >
          Hold this order
        </Link>
      ) : null}
      {formOpen
        ? null
        : ordered.map((action) => (
            <Button
              key={action}
              variant={variantOf(action, offered)}
              data-testid={`action-${action}`}
              onClick={() => {
                onOpen(action);
              }}
            >
              {ACTION_TEXT[action].label}
            </Button>
          ))}
    </>
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
  const facts: Fact[] = [
    { term: 'CNC', detail: <Code>{command.equipment}</Code> },
    { term: 'Blanks', detail: <span className="tabular-nums">{command.quantity}</span> },
    { term: 'Not before', detail: <PlantTime at={command.notBefore} /> },
    { term: 'Device run', detail: <span className="tabular-nums">{command.deviceEpoch}</span> },
    { term: 'Settled', detail: command.settled ? 'Yes' : 'No' },
    { term: 'Job', detail: command.job === null ? null : orderCodeWords(command.job) },
    {
      term: 'Accepted',
      detail:
        command.acceptedAt === null ? null : (
          <span>
            <PlantTime at={command.acceptedAt} /> (seq {command.acceptedSeq ?? '–'}, by{' '}
            {command.acceptedBy ?? '–'})
          </span>
        ),
    },
    { term: 'Started', detail: happened(command.startedAt) },
    { term: 'Completed', detail: happened(command.completedAt) },
    { term: 'Rejection', detail: command.rejection },
    { term: 'Seq after expiry', detail: command.seqAfterExpiry },
    { term: 'Deliveries', detail: <span className="tabular-nums">{command.attempts}</span> },
  ];
  return (
    <li
      data-testid={`command-${command.commandId}`}
      data-state={command.state}
      className="rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <Code className="font-semibold">{command.commandId}</Code>
            <CommandStateBadge state={command.state} />
            {command.confirmed ? (
              <Badge tone="ok" icon="check" data-testid="command-confirmed">
                Confirmed by its device fact
              </Badge>
            ) : null}
            {command.failed && command.state !== 'failed' ? (
              <Badge tone="warn" icon="alert">
                Declared failed once (incident raised)
              </Badge>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-ink-secondary">{state.meaning}</p>
        </div>
        {mayAbandon && canAbandon(order, command) ? (
          <Button
            variant="secondary"
            size="sm"
            data-testid={`abandon-${command.commandId}`}
            onClick={onAbandon}
          >
            {ACTION_TEXT.abandon.label}
          </Button>
        ) : null}
      </div>
      <div className="mt-3">
        <DescriptionList facts={facts} label={`Command ${command.commandId}`} />
      </div>
      <Disclosure
        summary={`Deliveries (${String(command.attemptList.length)}) and results (${String(command.results.length)})`}
      >
        <ol className="flex flex-col gap-1" aria-label="Deliveries">
          {command.attemptList.map((attempt) => (
            <li key={attempt.attempt} data-testid="command-attempt">
              Delivery {attempt.attempt}: written{' '}
              <time dateTime={attempt.issuedAt}>{wallTimeText(attempt.issuedAt)}</time>,{' '}
              {attempt.publishedAt ? (
                <>
                  published{' '}
                  <time dateTime={attempt.publishedAt}>{wallTimeText(attempt.publishedAt)}</time>
                </>
              ) : (
                'never published'
              )}
              , expires <time dateTime={attempt.expiresAt}>{wallTimeText(attempt.expiresAt)}</time>
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
              {result.deviceEpoch}, for the delivery expiring{' '}
              <time dateTime={result.expiresAt}>{wallTimeText(result.expiresAt)}</time>
              {result.acceptedSeq === null ? '' : `; accepted seq ${String(result.acceptedSeq)}`}
              {result.position === null ? '' : `, queue position ${String(result.position)}`}
              {result.seqAfterExpiry === null
                ? ''
                : `; seq after expiry ${String(result.seqAfterExpiry)}`}
              {result.reason ? `; ${result.reason}` : ''}
            </li>
          ))}
        </ol>
      </Disclosure>
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
    <Section
      id="order-commands-title"
      testId="order-commands"
      title="Commands and results"
      description="The jobs sent to the CNCs, and what each device answered."
    >
      {commands.length === 0 ? (
        <EmptyBlock
          testId="commands-empty"
          title="No command yet"
          body="The order is dispatched with one."
        />
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Commands">
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

type OperationRow = OrderExecutionDto['operations'][number];

const notComplete = (value: string | null): ReactNode =>
  value === null ? <Missing reason="Not complete yet" /> : <PlantTime at={value} />;

const OPERATION_COLUMNS: readonly Column<OperationRow>[] = [
  {
    key: 'operation',
    header: 'Operation',
    rowHeader: true,
    nowrap: true,
    cell: (row) => <Code>{row.operation}</Code>,
  },
  {
    key: 'workCenter',
    header: 'Work center',
    nowrap: true,
    cell: (row) =>
      row.workCenter === null ? <Missing reason="No work center" /> : <Code>{row.workCenter}</Code>,
  },
  { key: 'in', header: 'In', numeric: true, cell: (row) => row.in },
  {
    key: 'good',
    header: 'Good',
    numeric: true,
    cell: (row) => <span data-testid={`good-${row.operation}`}>{row.good}</span>,
  },
  { key: 'scrap', header: 'Scrap by reason', priority: 2, cell: (row) => countsText(row.scrap) },
  { key: 'rework', header: 'Rework', numeric: true, priority: 3, cell: (row) => row.rework },
  { key: 'material', header: 'Material', priority: 3, cell: (row) => countsText(row.material) },
  {
    key: 'complete',
    header: 'Complete',
    align: 'end',
    nowrap: true,
    priority: 2,
    cell: (row) => notComplete(row.completedAt),
  },
];

function Operations({
  detail,
  execution,
}: {
  readonly detail: OrderDetailDto;
  readonly execution: { data?: OrderExecutionDto; error: unknown; refetch: () => void };
}) {
  return (
    <Section
      id="order-operations-title"
      testId="order-operations"
      title="Operations and quantities"
      description="Per operation of the routing: units in, good, scrapped and reworked."
    >
      {execution.error ? (
        <QueryError
          what="the order's execution"
          error={execution.error}
          onRetry={execution.refetch}
        />
      ) : (
        <DataTable
          caption="Operations and quantities"
          testId="operation-table"
          columns={OPERATION_COLUMNS}
          rows={execution.data?.operations ?? []}
          rowKey={(row) => row.operation}
          rowTestId={(row) => `operation-${row.operation}`}
          loading={execution.data ? undefined : 'Loading the operations…'}
        />
      )}
      {execution.data ? <Wip execution={execution.data} /> : null}
      {detail.bom.length > 0 ? (
        <Disclosure
          className="mt-4"
          summary={`Bill of materials (${String(detail.bom.length)} lines)`}
        >
          <ul className="flex flex-col gap-0.5">
            {detail.bom.map((line) => (
              <li key={`${line.operation}-${line.material}-${line.usage}`}>
                <Code>{line.operation}</Code>: {line.quantityPerUnit} × <Code>{line.material}</Code>
                {line.usage === 'rework' ? ' (rework)' : ''}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </Section>
  );
}

function Wip({ execution }: { readonly execution: OrderExecutionDto }) {
  const counts = (value: number) => <span className="tabular-nums">{value}</span>;
  const facts: Fact[] = [
    { term: 'Units', detail: counts(execution.units.total) },
    {
      term: 'In WIP',
      detail: (
        <span className="tabular-nums" data-testid="wip-count">
          {execution.units.wip}
        </span>
      ),
    },
    { term: 'Packed', detail: counts(execution.units.packed) },
    { term: 'Scrapped', detail: counts(execution.units.scrapped) },
    { term: 'Lost', detail: counts(execution.units.lost) },
    { term: 'Packed good', detail: counts(execution.packedGood) },
    { term: 'Rework passes', detail: counts(execution.reworkPasses) },
    { term: 'WIP by position', detail: countsText(execution.wip) },
    { term: 'Blanks in a CNC', detail: countsText(execution.inMachine) },
    { term: 'Complete', detail: notComplete(execution.completedAt) },
  ];
  return (
    <Section level={3} title="Execution and WIP" testId="order-wip" className="mt-6">
      <div className="rounded-lg border border-line bg-surface p-4 pb-1">
        <DescriptionList facts={facts} />
      </div>
    </Section>
  );
}

interface IncidentRow {
  readonly key: string;
  readonly type: string;
  readonly message: string;
  readonly detectedAt: string;
  readonly closedAt: string | null;
  readonly resolution: string | null;
}

function Incidents({
  detail,
  execution,
}: {
  readonly detail: OrderDetailDto;
  readonly execution: readonly (Omit<IncidentRow, 'key' | 'type'> & { readonly id: number })[];
}) {
  const rows: IncidentRow[] = [
    ...detail.incidents.map((incident) => ({ ...incident, key: `o${String(incident.id)}` })),
    ...execution.map((incident) => ({
      ...incident,
      type: 'routing-violation' as const,
      key: `e${String(incident.id)}`,
    })),
  ].sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  return (
    <Section
      id="order-incidents-title"
      testId="order-incidents"
      title="Incidents"
      description="What went wrong on the order's path, newest first; open ones need a person."
    >
      {rows.length === 0 ? (
        <EmptyBlock testId="incidents-empty" title="No incident for this order" />
      ) : (
        <ul className="flex flex-col gap-2 text-sm" aria-label="Incidents">
          {rows.map((incident) => {
            const open = incident.closedAt === null;
            return (
              <li
                key={incident.key}
                data-testid="order-incident"
                data-type={incident.type}
                data-open={String(open)}
                className={`rounded-md border border-line bg-surface px-4 py-3 ${open ? CARD_TONE_BAR.alarm : ''}`}
              >
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{orderCodeWords(incident.type)}</span>
                  <Badge tone={open ? 'alarm' : 'neutral'} variant={open ? 'soft' : 'outline'}>
                    {open ? 'Open' : 'Closed'}
                  </Badge>
                  <span>{incident.message}</span>
                </p>
                <p className="mt-1 text-xs text-ink-secondary">
                  Detected{' '}
                  <time dateTime={incident.detectedAt}>{wallTimeText(incident.detectedAt)}</time>
                  {incident.closedAt ? (
                    <>
                      , closed{' '}
                      <time dateTime={incident.closedAt}>{wallTimeText(incident.closedAt)}</time>
                    </>
                  ) : null}
                  {incident.resolution ? ` (${incident.resolution})` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

const CONFIRMATION_COLUMNS: readonly Column<ConfirmationDto>[] = [
  {
    key: 'operation',
    header: 'Operation',
    rowHeader: true,
    nowrap: true,
    cell: (row) => <Code>{row.operation}</Code>,
  },
  { key: 'n', header: 'No.', numeric: true, cell: (row) => row.n },
  {
    key: 'kind',
    header: 'Kind',
    cell: (row) => (row.kind === 'final' ? 'Final' : 'Correction (deltas)'),
  },
  { key: 'yield', header: 'Yield', numeric: true, cell: (row) => row.yield },
  { key: 'scrap', header: 'Scrap by reason', priority: 2, cell: (row) => countsText(row.scrap) },
  {
    key: 'rework',
    header: 'Rework passes',
    numeric: true,
    priority: 3,
    cell: (row) => row.reworkPasses,
  },
  { key: 'material', header: 'Material', priority: 3, cell: (row) => countsText(row.material) },
  {
    key: 'confirmed',
    header: 'Confirmed',
    align: 'end',
    nowrap: true,
    priority: 2,
    cell: (row) => <PlantTime at={row.confirmedAt} />,
  },
  {
    key: 'message',
    header: 'Message',
    cell: (row) => (
      <Badge tone={erpStatusTone(row.messageStatus)}>{orderCodeWords(row.messageStatus)}</Badge>
    ),
  },
];

function Confirmations({ confirmations }: { readonly confirmations: readonly ConfirmationDto[] }) {
  return (
    <Section
      id="order-confirmations-title"
      testId="order-confirmations"
      title="Confirmations to the ERP"
      description="An operation is confirmed once no unit can come back to it."
    >
      <DataTable
        caption="Confirmations to the ERP"
        testId="confirmation-table"
        columns={CONFIRMATION_COLUMNS}
        rows={confirmations}
        rowKey={(row) => row.idempotencyKey}
        rowTestId={(row) => `confirmation-${row.operation}-${String(row.n)}`}
        rowProps={(row) => ({ 'data-status': row.messageStatus })}
        empty={<EmptyBlockInner testId="confirmations-empty" title="No confirmation yet" />}
      />
    </Section>
  );
}

/** An empty table's line inside the table's own frame. */
function EmptyBlockInner({ testId, title }: { readonly testId: string; readonly title: string }) {
  return (
    <div className="px-4">
      <EmptyState size="inline" icon="info" testId={testId} title={title} />
    </div>
  );
}

const SCRAP_COLUMNS: readonly Column<ScrapRecordDto>[] = [
  {
    key: 'part',
    header: 'Part',
    rowHeader: true,
    nowrap: true,
    cell: (record) =>
      record.serial ? <Code>{record.serial}</Code> : `Part ${String(record.partId)}`,
  },
  {
    key: 'operation',
    header: 'Operation',
    cell: (record) => (
      <>
        <Code>{record.operation}</Code> on <Code>{record.equipment}</Code>
        {record.pass > 1 ? ` (pass ${String(record.pass)})` : ''}
      </>
    ),
  },
  {
    key: 'machine',
    header: 'Machine reason',
    priority: 2,
    cell: (record) => <Code>{record.machineReason}</Code>,
  },
  {
    key: 'coded',
    header: 'Coded reason',
    cell: (record) =>
      record.codedReason ? (
        <>
          <Code>{record.codedReason}</Code> by {record.codedBy ?? '–'}
        </>
      ) : (
        <Badge tone="warn" variant="outline">
          Not coded
        </Badge>
      ),
  },
  {
    key: 'scrapped',
    header: 'Scrapped',
    align: 'end',
    nowrap: true,
    priority: 2,
    cell: (record) => <PlantTime at={record.scrappedAt} />,
  },
];

function Scrap({ id }: { readonly id: string }) {
  const read = useQuery({
    queryKey: queryKeys.orderScrap(id),
    queryFn: ({ signal }) => getOrderScrap(id, signal),
    refetchInterval: EXECUTION_POLL_MS,
  });
  return (
    <Section
      id="order-scrap-title"
      testId="order-scrap"
      title="Scrap records"
      description="Machine scrap of the order; operators and quality code it on the terminal."
    >
      {read.isError ? (
        <QueryError
          what="the scrap records"
          error={read.error}
          onRetry={() => void read.refetch()}
        />
      ) : (
        <DataTable
          caption="Scrap records"
          testId="scrap-table"
          columns={SCRAP_COLUMNS}
          rows={read.data?.records ?? []}
          rowKey={(record) => String(record.id)}
          rowTestId={() => 'scrap-record'}
          loading={read.isPending ? 'Loading the scrap records…' : undefined}
          empty={<EmptyBlockInner testId="scrap-empty" title="No scrap" />}
        />
      )}
    </Section>
  );
}

const ERP_COLUMNS: readonly Column<ErpMessageDto>[] = [
  {
    key: 'direction',
    header: 'Direction',
    nowrap: true,
    cell: (message) => (message.direction === 'in' ? 'From the ERP' : 'To the ERP'),
  },
  { key: 'kind', header: 'Kind', nowrap: true, cell: (message) => orderCodeWords(message.kind) },
  {
    key: 'revision',
    header: 'Revision',
    numeric: true,
    priority: 3,
    cell: (message) => message.revision ?? <Missing reason="No revision" />,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (message) => (
      <div className="flex flex-col items-start gap-0.5">
        <Badge tone={erpStatusTone(message.status)}>{orderCodeWords(message.status)}</Badge>
        {message.detail ? (
          <span className="text-xs text-ink-secondary">{message.detail}</span>
        ) : null}
        {message.lastError ? (
          <span className="text-xs text-ink-secondary">Last error: {message.lastError}</span>
        ) : null}
      </div>
    ),
  },
  { key: 'attempts', header: 'Attempts', numeric: true, priority: 3, cell: (m) => m.attempts },
  {
    key: 'at',
    header: 'Received or sent',
    align: 'end',
    priority: 2,
    cell: (message) => <WallTime at={message.createdAt} />,
  },
  {
    key: 'payload',
    header: 'Payload',
    cell: (message) => (
      <Disclosure summary="Payload">
        <pre className="max-w-[32rem] font-mono text-xs break-all whitespace-pre-wrap">
          {JSON.stringify(message.payload, null, 2)}
        </pre>
      </Disclosure>
    ),
  },
];

function ErpMessages({ detail }: { readonly detail: OrderDetailDto }) {
  return (
    <Section
      id="order-erp-title"
      testId="order-erp"
      title="ERP messages"
      description="The feed entries imported from the ERP and the messages sent to it (Q-05)."
    >
      <DataTable
        caption="ERP messages"
        testId="erp-message-table"
        columns={ERP_COLUMNS}
        rows={detail.erpMessages}
        rowKey={(message) => String(message.id)}
        rowTestId={() => 'erp-message'}
        density="compact"
        empty={<EmptyBlockInner testId="erp-messages-empty" title="No ERP message" />}
      />
    </Section>
  );
}

function History({ detail }: { readonly detail: OrderDetailDto }) {
  return (
    <Section
      id="order-history-title"
      testId="order-history"
      title="History"
      description="Every change to the order, newest first, at wall time with the plant time beside it."
    >
      {detail.history.length === 0 ? (
        <EmptyBlock title="No change recorded" />
      ) : (
        <ol
          className="divide-y divide-line-subtle rounded-lg border border-line bg-surface text-sm"
          aria-label="History"
        >
          {detail.history.map((entry) => (
            <li
              key={entry.id}
              data-testid="order-history-entry"
              data-action={entry.action}
              className="px-4 py-2.5"
            >
              <span className="font-medium">{entry.action}</span> by {entry.actor}
              {entry.authenticated ? '' : ' (not authenticated)'} at{' '}
              <time dateTime={entry.at}>{wallTimeText(entry.at)}</time>
              {entry.plantAt ? (
                <span className="text-ink-secondary">
                  {' '}
                  (plant {formatPlantTime(entry.plantAt)})
                </span>
              ) : null}
              {entry.requestId ? (
                <Disclosure className="mt-1" summary="Request id">
                  <Code>{entry.requestId}</Code>
                </Disclosure>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/**
 * The holds on this order as a subject (#203), live. Holds on a lot, serial or carton that cover
 * units of the order are named when a close is refused for them. The way to open one is the
 * header's "Hold this order".
 */
function OrderHolds({ id }: { readonly id: string }) {
  const filter: HoldFilter = { states: [], subject: { kind: 'order', id } };
  const read = useQuery({
    queryKey: qualityKeys.holds(holdFilterKey(filter)),
    queryFn: ({ signal }) => getHolds(filter, signal),
  });
  const live = useLiveQuality();
  const holds = read.data ? mergeHolds(read.data.holds, live, filter) : [];
  return (
    <Section
      id="order-holds-title"
      testId="order-holds"
      title="Quality holds"
      description="An open hold on the order, or on a lot, serial or carton with units in it, stops its close."
    >
      {read.isError ? (
        <QueryError what="the holds" error={read.error} onRetry={() => void read.refetch()} />
      ) : read.isPending ? (
        <Skeleton shape="text" rows={1} label="Loading the holds…" />
      ) : holds.length === 0 ? (
        <EmptyBlock
          testId="order-holds-empty"
          title="No hold is on this order itself"
          body="A close may still wait a moment while the genealogy catches up with the order's last facts."
        />
      ) : (
        <HoldTable holds={holds} testId="order-hold-list" caption="Holds on this order" />
      )}
    </Section>
  );
}

/** The heading of the page while it cannot name the order yet (error), with the way back. */
function OrderTitle({ id }: { readonly id: string }) {
  return (
    <PageHeader
      id="order-title"
      back={BACK}
      title={
        <>
          Order <Code>{id}</Code>
        </>
      }
      documentTitle={`Order ${id}`}
    />
  );
}

/**
 * Where the focus goes when an action form closes: the button that opened it, else the header's
 * primary action (the last one), else the page's heading.
 */
function focusAfterClose(draft: ActionDraft): void {
  const own = document.querySelector<HTMLElement>(
    draft.action === 'abandon'
      ? `[data-testid="abandon-${draft.commandId}"]`
      : `button[data-testid="action-${draft.action}"]`,
  );
  const actions = document.querySelectorAll<HTMLElement>('button[data-testid^="action-"]');
  (own ?? actions[actions.length - 1] ?? document.getElementById('order-title'))?.focus();
}

/** One order (#176): what it is, its actions, operations, commands, incidents and confirmations. */
function OrderDetail({ id }: { readonly id: string }) {
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
  const { clock } = usePlantClock();
  const allowed = useOrderPermissions();
  const canHold = useCan('quality:hold');
  const [open, setOpen] = useState<ActionDraft | undefined>(undefined);
  const [done, setDone] = useState<Done | undefined>(undefined);
  const onWritten = async () => {
    await queryClient.refetchQueries({ queryKey: queryKeys.order(id) });
  };

  if (read.isPending) {
    // No `h1` until the order is read: the heading takes the focus when it mounts.
    return (
      <div className="flex flex-col gap-6" data-testid="order-detail" data-order={id}>
        <p className="text-sm">
          <Link {...BACK.link} className="text-link underline-offset-4 hover:underline">
            ‹ {BACK.label}
          </Link>
        </p>
        <Skeleton shape="card" label="Loading the order…" />
      </div>
    );
  }
  if (read.error instanceof ApiError && read.error.status === 404) {
    return (
      <NotFound
        kind="order"
        id={id}
        back={{ to: '/orders', label: BACK.label }}
        testId="order-missing"
      />
    );
  }
  if (read.isError) {
    return (
      <section aria-labelledby="order-title" data-testid="order-detail" data-order={id}>
        <OrderTitle id={id} />
        <QueryError what="the order" error={read.error} onRetry={() => void read.refetch()} />
      </section>
    );
  }

  const detail = read.data;
  const order = newestOrder(detail.order, live?.orders[id]);
  const commands = mergeCommands(id, detail.commands, live?.commands);
  const offered = offeredActions(order, allowed);
  const anyPermission = Object.values(allowed).some(Boolean);
  const clockMs = clock ? Date.parse(clock.watermark) : undefined;
  const startAction = (draft: ActionDraft) => {
    setDone(undefined);
    setOpen(draft);
  };

  return (
    <section aria-labelledby="order-title" data-testid="order-detail" data-order={id}>
      <PageHeader
        id="order-title"
        testId="order-header"
        back={BACK}
        title={
          <>
            Order <Code>{id}</Code>
          </>
        }
        documentTitle={`Order ${id}`}
        status={
          <span className="flex flex-wrap items-center gap-1.5">
            <OrderStatusBadge order={order} />
            <OrderFlags order={order} />
            {isOverdue(order, clockMs) ? <OverdueBadge /> : null}
            {order.erpStatus === 'cancelled' ? (
              <Badge tone="neutral" variant="outline">
                Cancelled in the ERP
              </Badge>
            ) : null}
          </span>
        }
        actions={
          anyPermission || canHold ? (
            <HeaderActions
              id={id}
              offered={offered}
              formOpen={open !== undefined}
              noneApplies={anyPermission && offered.length === 0 && open === undefined}
              canHold={canHold}
              onOpen={(action) => {
                startAction(draftFor(action, order));
              }}
            />
          ) : undefined
        }
        description={
          <>
            {order.product} · <span className="tabular-nums">{order.quantity}</span> blanks · due{' '}
            <time dateTime={order.dueDate} title={formatPlantTime(order.dueDate)}>
              {formatPlantTimeMinutes(order.dueDate)}
            </time>
          </>
        }
        meta={<OrderFacts order={order} />}
      />
      {order.rejection ? (
        <Callout tone="alarm" role="status" data-testid="order-rejection" className="mb-4">
          Rejected at import: {order.rejection}
        </Callout>
      ) : null}
      {!anyPermission ? (
        <Callout tone="info" data-testid="order-read-only" className="mb-4">
          Your role cannot change orders: they are shown read-only.
        </Callout>
      ) : null}
      {done && !open ? (
        <Callout tone="ok" role="status" data-testid="action-done" className="mb-4">
          {done.text}
        </Callout>
      ) : null}
      {open ? (
        <div className="mb-6">
          <ActionForm
            // A new draft (another action, command or version) starts a new form: no state of the
            // previous one carries over (#176 review M2).
            key={`${open.action}:${open.commandId}:${String(open.version)}`}
            order={order}
            commands={commands}
            targets={dispatchTargets(equipment.data ?? [], detail.routing)}
            initial={open}
            onWritten={onWritten}
            onClose={(result) => {
              const closed = open;
              setOpen(undefined);
              setDone(result);
              requestAnimationFrame(() => {
                focusAfterClose(closed);
              });
            }}
          />
        </div>
      ) : null}
      <SectionNav items={SECTIONS} testId="order-section-nav" />
      <div className="mt-6">
        <Operations
          detail={detail}
          execution={{
            ...(execution.data ? { data: execution.data } : {}),
            error: execution.error,
            refetch: () => void execution.refetch(),
          }}
        />
        <OrderOee id={id} />
        <Commands
          order={order}
          commands={commands}
          formOpen={open !== undefined}
          onAbandon={(commandId) => {
            startAction(draftFor('abandon', order, commandId));
          }}
        />
        <OrderHolds id={id} />
        <Incidents detail={detail} execution={executionIncidents.data?.incidents ?? []} />
        <Confirmations confirmations={detail.confirmations} />
        <Scrap id={id} />
        <ErpMessages detail={detail} />
        <History detail={detail} />
      </div>
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
  useQualityTopic();
  if (!ORDER_ID.test(id)) {
    return (
      <NotFound
        kind="order"
        id={id}
        back={{ to: '/orders', label: BACK.label }}
        testId="order-missing"
      />
    );
  }
  return <OrderDetail key={id} id={id} />;
}
