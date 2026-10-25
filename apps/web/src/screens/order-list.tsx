import { ORDER_LIMITS, type OrderDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { getOrders } from '../api/orders.ts';
import { queryKeys, usePlantClock } from '../api/queries.ts';
import {
  OrderFlags,
  OrderPriorityBadge,
  OrderStatusBadge,
  OverdueBadge,
} from '../components/order-badges.tsx';
import { QueryError } from '../components/query-error.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { Select } from '../components/ui/controls.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { PlantTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import {
  ORDER_FILTERS,
  ORDER_STATUS_TEXT,
  filterStatuses,
  isOverdue,
  mergeOrders,
  type OrderFilter,
} from '../domain/orders.ts';
import { useLiveOrders, useOrdersTopic } from '../live/live-context.tsx';

const FILTER_TEXT = (filter: OrderFilter): string =>
  filter === 'open' ? 'Open (not closed, cancelled or rejected)' : ORDER_STATUS_TEXT[filter];

const countText = (count: number): string => `${String(count)} order${count === 1 ? '' : 's'}`;

function columns(clockMs: number | undefined): readonly Column<OrderDto>[] {
  return [
    {
      key: 'order',
      header: 'Order',
      rowHeader: true,
      nowrap: true,
      cell: (order) => (
        <Link
          to="/orders/$id"
          params={{ id: order.id }}
          className="font-medium text-link underline underline-offset-4"
          data-testid={`order-link-${order.id}`}
        >
          <Code>{order.id}</Code>
        </Link>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      priority: 2,
      nowrap: true,
      cell: (order) => order.product,
    },
    {
      key: 'quantity',
      header: 'Quantity (blanks)',
      numeric: true,
      priority: 3,
      cell: (order) => order.quantity,
    },
    {
      key: 'dispatched',
      header: 'Dispatched',
      numeric: true,
      priority: 3,
      cell: (order) => order.dispatched,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (order) => (
        <span className="flex flex-wrap items-center gap-1">
          <OrderStatusBadge order={order} />
          <OrderFlags order={order} />
        </span>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      priority: 3,
      cell: (order) => <OrderPriorityBadge priority={order.priority} />,
    },
    {
      key: 'start',
      header: 'Planned start',
      align: 'end',
      nowrap: true,
      priority: 2,
      cell: (order) => <PlantTime at={order.plannedStart} seconds={false} />,
    },
    {
      key: 'due',
      header: 'Due',
      align: 'end',
      cell: (order) => (
        <span className="inline-flex flex-wrap items-center justify-end gap-1">
          {isOverdue(order, clockMs) ? <OverdueBadge /> : null}
          <PlantTime at={order.dueDate} seconds={false} className="whitespace-nowrap" />
        </span>
      ),
    },
  ];
}

/** The production orders imported from the ERP, live (#176; UX-6a, #328). */
export function OrderList() {
  useOrdersTopic();
  const search = useSearch({ from: '/orders' });
  const navigate = useNavigate({ from: '/orders' });
  const statuses = filterStatuses(search.status);
  const read = useQuery({
    queryKey: queryKeys.orders(statuses.join(',')),
    queryFn: ({ signal }) => getOrders(statuses, signal),
  });
  const pushed = useLiveOrders()?.orders;
  const { clock } = usePlantClock();
  const clockMs = clock ? Date.parse(clock.watermark) : undefined;
  const orders = read.data
    ? mergeOrders(read.data.orders, pushed, statuses, read.data.truncated)
    : [];

  return (
    <section aria-labelledby="order-list-title">
      <PageHeader
        id="order-list-title"
        title="Production orders"
        description="Imported from the ERP, by planned start (plant time); the list follows the MES live."
        filters={
          <Select
            label="Show"
            inline
            name="status"
            data-testid="order-filter"
            value={search.status ?? ''}
            onChange={(event) => {
              const value = ORDER_FILTERS.find((filter) => filter === event.target.value);
              void navigate({ search: { status: value } });
            }}
          >
            <option value="">All orders</option>
            {ORDER_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {FILTER_TEXT(filter)}
              </option>
            ))}
          </Select>
        }
        summary={read.data ? countText(orders.length) : undefined}
      />
      {read.data?.truncated ? (
        <Callout tone="warn" role="status" data-testid="orders-truncated" className="mb-4">
          More than {ORDER_LIMITS.list} orders match: only the first {ORDER_LIMITS.list} by planned
          start are shown. Narrow the filter.
        </Callout>
      ) : null}
      {read.isError ? (
        <QueryError what="the orders" error={read.error} onRetry={() => void read.refetch()} />
      ) : (
        <DataTable
          caption="Production orders"
          testId="order-table"
          columns={columns(clockMs)}
          rows={orders}
          rowKey={(order) => order.id}
          rowTestId={(order) => `order-row-${order.id}`}
          rowProps={(order) => ({
            'data-status': order.status,
            'data-version': String(order.version),
            'data-dispatched': String(order.dispatched),
            'data-overdue': String(isOverdue(order, clockMs)),
          })}
          rowTone={(order) => (isOverdue(order, clockMs) ? 'warn' : undefined)}
          narrow="stack"
          loading={read.isPending ? 'Loading orders…' : undefined}
          empty={
            <EmptyState
              testId="orders-empty"
              icon="search"
              title={search.status ? 'No order matches this filter' : 'No order yet'}
              body={
                search.status
                  ? 'Choose another status, or show all orders.'
                  : 'The ERP has sent none; the list fills as the MES imports them.'
              }
            />
          }
        />
      )}
    </section>
  );
}
