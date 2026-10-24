import { createRoute } from '@tanstack/react-router';
import { ORDER_FILTERS, type OrderFilter } from '../domain/orders.ts';
import { OrderDetailRoute } from '../screens/order-detail.tsx';
import { OrderList } from '../screens/order-list.tsx';
import { rootRoute } from './root.tsx';

// Orders (#176): the list and one order's detail with the supervisor's writes.

export interface OrderListSearch {
  /** The statuses shown: `open`, one status, or all when absent. */
  readonly status?: OrderFilter | undefined;
}

export const orderListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orders',
  validateSearch: (search: Record<string, unknown>): OrderListSearch => ({
    status: (ORDER_FILTERS as readonly unknown[]).includes(search.status)
      ? (search.status as OrderFilter)
      : undefined,
  }),
  staticData: { title: 'Production orders' },
  component: OrderList,
});

export const orderDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orders/$id',
  staticData: { title: ({ id }) => `Order ${id ?? ''}` },
  component: OrderDetailRoute,
});

export const orderRoutes = [orderListRoute, orderDetailRoute] as const;
