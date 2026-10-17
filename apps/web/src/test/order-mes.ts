import type {
  OrderDetail,
  OrderDto,
  OrderExecutionDto,
  executionIncidentListSchema,
} from '@shopfloor/contracts/mes-api';
import type { z } from 'zod';
import { PLANT, json, problem } from './fixtures.ts';
import { requestBody, requestUrl } from './oee-fixtures.ts';
import { ORDER_EQUIPMENT, detail as detailOf, execution as executionOf } from './order-fixtures.ts';

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** What the fake MES holds; tests change it between reads. */
export interface OrderState {
  orders: OrderDto[];
  /** Details by order id; built from `orders` when absent. */
  details: Record<string, OrderDetail>;
  executions: Record<string, OrderExecutionDto>;
  executionIncidents: z.output<typeof executionIncidentListSchema>['incidents'];
}

export type Write = (method: string, path: string, body: unknown) => Response;

export function orderState(orders: OrderDto[], overrides: Partial<OrderState> = {}): OrderState {
  return { orders, details: {}, executions: {}, executionIncidents: [], ...overrides };
}

/** The MES as the orders screens see it; `write` answers the POSTs. */
export function orderMes(state: OrderState, write: Write = () => json({})) {
  const calls: Call[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = requestBody(init);
    const path = url.pathname;
    calls.push({ method, path: path + url.search, body });
    if (method !== 'GET') return Promise.resolve(write(method, path, body));
    if (path === '/api/v1/equipment') return Promise.resolve(json({ equipment: ORDER_EQUIPMENT }));
    if (path === '/api/v1/plant') return Promise.resolve(json(PLANT));
    if (path === '/api/v1/orders') {
      const statuses = url.searchParams.get('status')?.split(',');
      const orders = statuses
        ? state.orders.filter((item) => statuses.includes(item.status))
        : state.orders;
      return Promise.resolve(json({ orders, truncated: false }));
    }
    if (path === '/api/v1/execution-incidents') {
      return Promise.resolve(json({ incidents: state.executionIncidents }));
    }
    if (path === '/api/v1/scrap-records') {
      return Promise.resolve(json({ records: [], truncated: false }));
    }
    const match = /^\/api\/v1\/orders\/([^/]+)(\/execution)?$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1] ?? '');
      const found = state.orders.find((item) => item.id === id);
      if (!found) return Promise.resolve(problem(404, 'Not Found', `no order ${id}`, path));
      if (match[2]) return Promise.resolve(json(state.executions[id] ?? executionOf(id)));
      const held = state.details[id];
      return Promise.resolve(json(held ? { ...held, order: found } : detailOf(found)));
    }
    return Promise.resolve(problem(404, 'Not Found', 'no route', path));
  };
  return { fetch, calls, posts: () => calls.filter((call) => call.method === 'POST') };
}
