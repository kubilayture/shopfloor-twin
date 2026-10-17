import {
  abandonRequestSchema,
  cancelRequestSchema,
  dispatchRequestSchema,
  executionIncidentListSchema,
  orderDetailSchema,
  orderExecutionSchema,
  orderListSchema,
  orderWriteRequestSchema,
  orderWriteResultSchema,
  redispatchRequestSchema,
  scrapRecordListSchema,
  type AbandonRequest,
  type CancelRequest,
  type DispatchRequest,
  type OrderDetail,
  type OrderExecutionDto,
  type OrderList,
  type OrderStatus,
  type OrderWriteRequest,
  type OrderWriteResult,
  type RedispatchRequest,
} from '@shopfloor/contracts/mes-api';
import type { z } from 'zod';
import { getJson, sendJson } from './client.ts';

// The orders screens' reads and writes (#176): the orders API of #174 and the execution reads of
// #175, parsed with the shared schemas (ADR-0020).

const segment = encodeURIComponent;

/** `GET /orders`, only the statuses given (all when none). */
export function getOrders(
  statuses: readonly OrderStatus[],
  signal?: AbortSignal,
): Promise<OrderList> {
  const query = statuses.length > 0 ? `?status=${statuses.join(',')}` : '';
  return getJson(`/orders${query}`, orderListSchema, signal);
}

export function getOrder(id: string, signal?: AbortSignal): Promise<OrderDetail> {
  return getJson(`/orders/${segment(id)}`, orderDetailSchema, signal);
}

export function getOrderExecution(id: string, signal?: AbortSignal): Promise<OrderExecutionDto> {
  return getJson(`/orders/${segment(id)}/execution`, orderExecutionSchema, signal);
}

export function getOrderScrap(
  id: string,
  signal?: AbortSignal,
): Promise<z.output<typeof scrapRecordListSchema>> {
  return getJson(`/scrap-records?orderId=${segment(id)}`, scrapRecordListSchema, signal);
}

/** Every execution incident (at most 500, newest first); the screen keeps one order's. */
export function getExecutionIncidents(
  signal?: AbortSignal,
): Promise<z.output<typeof executionIncidentListSchema>> {
  return getJson('/execution-incidents', executionIncidentListSchema, signal);
}

/** The supervisor's writes on an order, each with the version read (409 `order-stale`). */
export type OrderAction = 'release' | 'dispatch' | 'cancel' | 'redispatch' | 'close' | 'abandon';

export type OrderActionBody =
  | { readonly action: 'release' | 'close'; readonly body: OrderWriteRequest }
  | { readonly action: 'dispatch'; readonly body: DispatchRequest }
  | { readonly action: 'cancel'; readonly body: CancelRequest }
  | { readonly action: 'redispatch'; readonly body: RedispatchRequest }
  | { readonly action: 'abandon'; readonly body: AbandonRequest };

/** Checks the body with the action's shared request schema, then sends it (ADR-0023). */
export function writeOrder(id: string, write: OrderActionBody): Promise<OrderWriteResult> {
  const path = (action: string) => `/orders/${segment(id)}/${action}`;
  switch (write.action) {
    case 'release':
    case 'close':
      return sendJson(
        'POST',
        path(write.action),
        orderWriteRequestSchema.parse(write.body),
        orderWriteResultSchema,
      );
    case 'dispatch':
      return sendJson(
        'POST',
        path('dispatch'),
        dispatchRequestSchema.parse(write.body),
        orderWriteResultSchema,
      );
    case 'cancel':
      return sendJson(
        'POST',
        path('cancel'),
        cancelRequestSchema.parse(write.body),
        orderWriteResultSchema,
      );
    case 'redispatch':
      return sendJson(
        'POST',
        path('redispatch'),
        redispatchRequestSchema.parse(write.body),
        orderWriteResultSchema,
      );
    case 'abandon':
      return sendJson(
        'POST',
        path('abandon-command'),
        abandonRequestSchema.parse(write.body),
        orderWriteResultSchema,
      );
  }
}
