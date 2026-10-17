import {
  MES_API_LIMITS as LIMITS,
  abandonRequestSchema,
  ORDER_LIMITS,
  ORDER_STATUSES,
  cancelRequestSchema,
  dispatchRequestSchema,
  orderDetailSchema,
  orderIncidentListSchema,
  orderListSchema,
  orderWriteRequestSchema,
  orderWriteResultSchema,
  redispatchRequestSchema,
} from '@shopfloor/contracts/mes-api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WriteBy } from '../identity/index.ts';
import { OrderError, type Orders } from '../orders/index.ts';
import { commandDto, orderDetailDto, orderDto, orderIncidentDto } from './order-dto.ts';
import { HttpProblem, getRoute, writeRoute, type ErrorStatus } from './routes.ts';

/** What the order routes use of the orders module (#174). */
export type OrdersApi = Pick<
  Orders,
  | 'list'
  | 'detail'
  | 'incidents'
  | 'release'
  | 'dispatch'
  | 'cancel'
  | 'redispatch'
  | 'close'
  | 'abandon'
>;

const ORDER_STATUS = { 'not-found': 404, conflict: 409, invalid: 422 } as const;
const WRITE_ERRORS: readonly ErrorStatus[] = [400, 403, 404, 405, 409, 413, 415, 422, 429, 503];

const queryTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const statuses = z
  .string()
  .regex(/^[a-z-]+(,[a-z-]+)*$/)
  .transform((value) => value.split(','))
  .pipe(z.array(z.enum(ORDER_STATUSES)));

export const orderListQuery = z.strictObject({
  status: statuses
    .optional()
    .describe(`Only these statuses, comma-separated (${ORDER_STATUSES.join(', ')})`),
  from: queryTime.optional().describe('Planned start at or after (ISO 8601)'),
  to: queryTime.optional().describe('Planned start before (ISO 8601)'),
});
export const orderParams = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
    .describe('The ERP order number'),
});
const incidentQuery = z.strictObject({
  open: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
    .describe('Only the incidents still open'),
});

const problemOf = (error: unknown): unknown =>
  error instanceof OrderError
    ? new HttpProblem(ORDER_STATUS[error.kind], error.message, error.type)
    : error;

/**
 * The orders API (#174, plan "API"): `GET /orders`, `GET /orders/{id}`, `GET /order-incidents`,
 * and the supervisor's writes `POST /orders/{id}/release|dispatch|cancel|redispatch|close`, each
 * with the version read (409 `order-stale`), audited with the session's user. Registered in the
 * `/api/v1` scope, behind its guards.
 */
export function orderRoutes(
  api: FastifyInstance,
  deps: {
    /** The orders module, or 503 while the MES starts. */
    readonly orders: () => OrdersApi;
    /** Who writes: the session's user; 401 without a session, whatever `MES_AUTH` says. */
    readonly writer: (request: FastifyRequest) => Promise<WriteBy>;
  },
): void {
  getRoute(
    api,
    {
      url: '/orders',
      summary: 'Production orders imported from the ERP, by planned start',
      description: `At most ${String(ORDER_LIMITS.list)}; \`truncated\` when more matched. Each order carries its status, flags, the blanks the device accepted (\`dispatched\`) and the \`version\` a write must name.`,
      tags: ['orders'],
      query: orderListQuery,
      response: orderListSchema,
      errors: [400, 503],
    },
    async ({ query }) => {
      const found = await deps.orders().list({
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        limit: ORDER_LIMITS.list,
      });
      return { orders: found.orders.map(orderDto), truncated: found.truncated };
    },
  );

  getRoute(
    api,
    {
      url: '/orders/:id',
      summary:
        'One order with its routing, BOM, commands and every result, ERP messages and history',
      description:
        'Commands list every delivery published (`attemptList`) and every `cmd-res` the gateway answered; ' +
        '`state` is read from them and the device’s job facts (ADR-0029). `confirmations` are filled from #175.',
      tags: ['orders'],
      params: orderParams,
      query: z.strictObject({}),
      response: orderDetailSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => {
      const detail = await deps.orders().detail(params.id);
      if (!detail) throw new HttpProblem(404, `no order ${params.id}`);
      return orderDetailDto(detail);
    },
  );

  getRoute(
    api,
    {
      url: '/order-incidents',
      summary: 'Incidents of the orders module, newest first',
      description:
        'ERP feed changes, ERP conflicts and refusals, failed and unconfirmed commands, unknown and duplicate jobs, lost dispatches.',
      tags: ['orders'],
      query: incidentQuery,
      response: orderIncidentListSchema,
      errors: [400, 503],
    },
    async ({ query }) => ({
      incidents: (
        await deps.orders().incidents({ open: query.open, limit: ORDER_LIMITS.incidents })
      ).map(orderIncidentDto),
    }),
  );

  const write = (
    action: 'release' | 'dispatch' | 'cancel' | 'redispatch' | 'close' | 'abandon',
    summary: string,
    description: string,
    body: z.ZodType,
    run: (
      orders: OrdersApi,
      id: string,
      body: never,
      context: { by: WriteBy; requestId: string },
    ) => Promise<{
      order: Parameters<typeof orderDto>[0];
      command?: Parameters<typeof commandDto>[0];
    }>,
  ) => {
    writeRoute(
      api,
      {
        method: 'POST',
        url: action === 'abandon' ? '/orders/:id/abandon-command' : `/orders/:id/${action}`,
        access: `order:${action}`,
        summary,
        description:
          `${description} Names the order's \`version\` (409 urn:shopfloor:order-stale when it is not the current one); ` +
          'audited with the session’s user; a write needs a session also with MES_AUTH=off (401). ' +
          'Writes need an Origin of this host (or allowlisted), `Sec-Fetch-Site: same-origin` when sent, and application/json (ADR-0023).',
        tags: ['orders'],
        params: orderParams,
        body,
        response: orderWriteResultSchema,
        errors: WRITE_ERRORS,
      },
      LIMITS.writeBodyBytes,
      async ({ params, body: parsed, requestId, request }) => {
        const by = await deps.writer(request);
        const result = await run(deps.orders(), params.id, parsed as never, {
          by,
          requestId,
        }).catch((error: unknown) => {
          throw problemOf(error);
        });
        return {
          order: orderDto(result.order),
          command: result.command ? commandDto(result.command) : null,
        };
      },
    );
  };

  write(
    'release',
    'Releases an imported order for dispatch',
    'imported → released; posts `released` to the ERP. 409 urn:shopfloor:order-state in another status.',
    orderWriteRequestSchema,
    async (orders, id, body: z.output<typeof orderWriteRequestSchema>, context) => ({
      order: await orders.release(id, body, context),
    }),
  );
  write(
    'dispatch',
    'Dispatches a released order as one job to a CNC',
    'released → dispatched: the whole order goes to the CNC the dispatch rule chooses (the queue finishing first by ideal time, NotBefore waits and changeovers counted, ties to the lower id), or the one named; the command is published by the outbox (ADR-0029). 422 for an unknown CNC or one with no known device run.',
    dispatchRequestSchema,
    async (orders, id, body: z.output<typeof dispatchRequestSchema>, context) =>
      orders.dispatch(id, body, context),
  );
  write(
    'cancel',
    'Cancels an order not dispatched yet',
    'imported or released → cancelled; posts `cancelled` to the ERP.',
    cancelRequestSchema,
    async (orders, id, body: z.output<typeof cancelRequestSchema>, context) => ({
      order: await orders.cancel(id, body, context),
    }),
  );
  write(
    'redispatch',
    'Dispatches the remainder of an order again (new command n + 1)',
    'Only when every earlier command of the order is settled (409 urn:shopfloor:commands-unsettled otherwise: a re-dispatch could make a second job), and at most the order quantity minus the blanks the device accepted (422 when nothing remains). Clears the flags dispatch-failed and dispatch-lost.',
    redispatchRequestSchema,
    async (orders, id, body: z.output<typeof redispatchRequestSchema>, context) =>
      orders.redispatch(id, body, context),
  );
  write(
    'abandon',
    'Writes off a command of the order whose device run has ended',
    'The command becomes `abandoned` (settled, its incidents closed) and its whole quantity counts as dispatched, so the order can end short, never over. 409 urn:shopfloor:order-state while its device run goes on, or when it is abandoned already; 404 for a command of another order.',
    abandonRequestSchema,
    async (orders, id, body: z.output<typeof abandonRequestSchema>, context) => ({
      order: await orders.abandon(id, body, context),
    }),
  );
  write(
    'close',
    'Closes a completed order',
    'completed → closed; posts `closed` to the ERP.',
    orderWriteRequestSchema,
    async (orders, id, body: z.output<typeof orderWriteRequestSchema>, context) => ({
      order: await orders.close(id, body, context),
    }),
  );
}
