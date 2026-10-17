import { ORDER_LIMITS } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useId } from 'react';
import { getOrders } from '../api/orders.ts';
import { queryKeys } from '../api/queries.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { OrderFlags, OrderStatusBadge } from '../components/order-badges.tsx';
import { QueryError } from '../components/query-error.tsx';
import {
  ORDER_FILTERS,
  ORDER_STATUS_TEXT,
  filterStatuses,
  mergeOrders,
  type OrderFilter,
} from '../domain/orders.ts';
import { formatPlantTime } from '../domain/time.ts';
import { useLiveOrders, useOrdersTopic } from '../live/live-context.tsx';

const FILTER_TEXT = (filter: OrderFilter): string =>
  filter === 'open' ? 'Open (not closed, cancelled or rejected)' : ORDER_STATUS_TEXT[filter];

const cell = 'px-2 py-1.5 align-top';

/** The production orders imported from the ERP, live (#176). */
export function OrderList() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  useOrdersTopic();
  const search = useSearch({ from: '/orders' });
  const navigate = useNavigate({ from: '/orders' });
  const filterId = useId();
  const statuses = filterStatuses(search.status);
  const read = useQuery({
    queryKey: queryKeys.orders(statuses.join(',')),
    queryFn: ({ signal }) => getOrders(statuses, signal),
  });
  const pushed = useLiveOrders()?.orders;
  const orders = read.data
    ? mergeOrders(read.data.orders, pushed, statuses, read.data.truncated)
    : [];

  return (
    <section aria-labelledby="order-list-title">
      <h1 ref={heading} id="order-list-title" tabIndex={-1} className="text-2xl font-bold">
        Production orders
      </h1>
      <p className="mt-1 text-sm text-slate-700">
        Orders the MES imported from the ERP, by planned start (plant time). The list follows the
        MES live; open an order for its operations, commands, confirmations and actions.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={filterId} className="text-sm font-medium">
            Show
          </label>
          <select
            id={filterId}
            data-testid="order-filter"
            value={search.status ?? ''}
            onChange={(event) => {
              const value = ORDER_FILTERS.find((filter) => filter === event.target.value);
              void navigate({ search: { status: value } });
            }}
            className="rounded border border-slate-500 bg-white px-2 py-1 text-sm"
          >
            <option value="">All orders</option>
            {ORDER_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {FILTER_TEXT(filter)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {read.isPending ? <p className="mt-4">Loading orders…</p> : null}
      {read.isError ? (
        <div className="mt-4">
          <QueryError what="the orders" error={read.error} onRetry={() => void read.refetch()} />
        </div>
      ) : null}
      {read.data?.truncated ? (
        <p role="status" data-testid="orders-truncated" className="mt-3 text-sm text-amber-950">
          More than {ORDER_LIMITS.list} orders match: only the first {ORDER_LIMITS.list} by planned
          start are shown. Narrow the filter.
        </p>
      ) : null}
      {read.data && orders.length === 0 ? (
        <p className="mt-4" data-testid="orders-empty">
          No order {search.status ? 'matches this filter' : 'yet: the ERP has sent none'}.
        </p>
      ) : null}
      {orders.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
          <table
            className="w-full text-left text-sm"
            data-testid="order-table"
            data-count={String(orders.length)}
          >
            <caption className="sr-only">Production orders</caption>
            <thead className="bg-slate-100">
              <tr>
                <th scope="col" className={cell}>
                  Order
                </th>
                <th scope="col" className={cell}>
                  Product
                </th>
                <th scope="col" className={`${cell} text-right`}>
                  Quantity
                </th>
                <th scope="col" className={`${cell} text-right`}>
                  Dispatched
                </th>
                <th scope="col" className={cell}>
                  Status
                </th>
                <th scope="col" className={cell}>
                  Priority
                </th>
                <th scope="col" className={cell}>
                  Planned start
                </th>
                <th scope="col" className={cell}>
                  Due
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr
                  key={order.id}
                  data-testid={`order-row-${order.id}`}
                  data-status={order.status}
                  data-version={String(order.version)}
                  data-dispatched={String(order.dispatched)}
                  className="border-t border-slate-200"
                >
                  <th scope="row" className={cell}>
                    <Link
                      to="/orders/$id"
                      params={{ id: order.id }}
                      className="font-medium text-sky-800 underline"
                      data-testid={`order-link-${order.id}`}
                    >
                      {order.id}
                    </Link>
                  </th>
                  <td className={cell}>{order.product}</td>
                  <td className={`${cell} text-right tabular-nums`}>{order.quantity}</td>
                  <td className={`${cell} text-right tabular-nums`}>{order.dispatched}</td>
                  <td className={cell}>
                    <span className="flex flex-wrap items-center gap-1">
                      <OrderStatusBadge order={order} />
                      <OrderFlags order={order} />
                    </span>
                  </td>
                  <td className={cell}>{order.priority}</td>
                  <td className={cell}>
                    <time dateTime={order.plannedStart}>{formatPlantTime(order.plannedStart)}</time>
                  </td>
                  <td className={cell}>
                    <time dateTime={order.dueDate}>{formatPlantTime(order.dueDate)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
