import { z } from 'zod';
import { confirmationDtoSchema } from './execution-api.ts';
import { COMMAND_REJECTIONS, COMMAND_RESULTS } from './uns/commands.ts';

// The MES's `orders` API (#174, Phase 7 plan "Orders"): production orders imported from the ERP,
// the supervisor's writes (release, dispatch, cancel, re-dispatch, close), the dispatch commands
// with every result the gateway gave, and the `orders` push topic. Shared by `mes-server`, which
// serves it, and `web`, which parses it (ADR-0020); `mes-api` re-exports it.

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A time in a response: ISO 8601 UTC with milliseconds. */
const time = z.iso.datetime();
const int = z.number().int();

/** Limits of the orders API. */
export const ORDER_LIMITS = {
  /** Orders one `GET /orders` answers at most; more sets `truncated`. */
  list: 500,
  /** Characters of a cancellation reason. */
  reason: 500,
  /** Incidents one `GET /order-incidents` answers at most (newest first). */
  incidents: 500,
} as const;

/**
 * An order's lifecycle (plan "Lifecycle"): `imported → released → dispatched → in-progress →
 * completed → closed`, `cancelled` before dispatch, and `rejected` for an ERP version the MES
 * refused at import (unknown product, routing or BOM that differs from master data).
 */
export const ORDER_STATUSES = [
  'imported',
  'rejected',
  'released',
  'dispatched',
  'in-progress',
  'completed',
  'closed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * A dispatch command's state, read from its results and the device's job facts (ADR-0029):
 * - `queued`: in the outbox, not published yet (its CNC's previous command is not settled, or
 *   the gateway is offline);
 * - `sent`: published, no final answer yet; `unknown`: the gateway is settling its latest delivery;
 * - `failed`: the MES's own state, no final answer after the last `expiresAt` plus the margin (not
 *   final: an incident and the order flag `dispatch-failed`);
 * - `accepted`: the job exists (an `accepted` fact, or an `accepted`/`duplicate` result);
 * - `rejected`, `expired` (every published attempt), `not-accepted` (`unknown`/`failed`, settled
 *   once the CNC's facts arrived through `seqAfterExpiry` without its `accepted` fact) and
 *   `epoch-ended` (the device run ended first): no job;
 * - `conflict`: the device answered `command-conflict`, so it holds another job under this id. Not
 *   settled (an incident) until the device run ends;
 * - `abandoned`: written off by a supervisor after its device run ended (`order:abandon`); its
 *   quantity counts as started unless the facts prove otherwise.
 */
export const COMMAND_STATES = [
  'queued',
  'sent',
  'unknown',
  'failed',
  'accepted',
  'rejected',
  'expired',
  'not-accepted',
  'epoch-ended',
  'conflict',
  'abandoned',
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

/** A job's state on the device, from its facts; `lost` when its run ended before `completed`. */
export const JOB_STATES = ['accepted', 'started', 'completed', 'lost'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** What the orders module reports for a person to look at. */
export const ORDER_INCIDENT_TYPES = [
  /** The ERP's feed changed identity (or the cursor was ahead): the cursor was reset to 0. */
  'erp-feed-changed',
  /** The ERP answered 409 to a message: the MES built two bodies under one key (a defect). */
  'erp-conflict',
  /** The ERP refused a message for good (422 or another 4xx): not retried. */
  'erp-refused',
  /** No final answer to a command after its last `expiresAt` plus the margin. */
  'command-failed',
  /** An `accepted` result whose job fact never arrived though the CNC's facts passed it. */
  'command-unconfirmed',
  /** A job fact of a command id the MES never issued. */
  'unknown-job',
  /**
   * More than one `accepted` fact for one command id, or an `accepted` fact for a command settled
   * without a job: exactly-once broken, or a reading proven wrong.
   */
  'duplicate-job',
  /** The device answered `command-conflict`: it holds another job under this command id. */
  'command-conflict',
  /** The broker refused a command delivery (PUBACK reason code ≥ 0x80, e.g. not authorised). */
  'command-publish-refused',
  /** A feed entry the database could not store: recorded as rejected, the page committed. */
  'erp-invalid-entry',
  /** A device run ended with jobs of the order not completed, or commands not answered. */
  'dispatch-lost',
] as const;
export type OrderIncidentType = (typeof ORDER_INCIDENT_TYPES)[number];

/** The push topic of order and command upserts. */
export const ORDERS_TOPIC = 'orders';

export const orderSchema = z
  .object({
    id: z.string().describe('The ERP order number'),
    revision: int.describe('The ERP revision the MES holds'),
    product: z.string(),
    quantity: int.describe('Units to produce (blanks to machine: no allowance for scrap)'),
    priority: int.describe('1 most urgent'),
    plannedStart: time.describe('Plant time; the jobs are dispatched with it as `notBefore`'),
    dueDate: time,
    erpStatus: z.enum(['open', 'cancelled']),
    status: z.enum(ORDER_STATUSES),
    flags: z.object({
      short: z.boolean().describe('Completed with packed good below the quantity'),
      dispatchFailed: z
        .boolean()
        .describe('A command failed or ended without a job: re-dispatch the remainder'),
      dispatchLost: z
        .boolean()
        .describe('A device run ended with jobs of the order open: re-dispatch the remainder'),
    }),
    rejection: z.string().nullable().describe('Why the import refused the version (`rejected`)'),
    dispatched: int.describe(
      "Blanks of the order's jobs the device accepted; a lost job counts the blanks it started",
    ),
    remaining: int.describe('Blanks a re-dispatch may still send: quantity − dispatched'),
    version: int.describe('Raised by every change; a write sends the version it read (409 else)'),
    importedAt: time,
    updatedAt: time,
    releasedAt: time.nullable(),
    dispatchedAt: time.nullable(),
    startedAt: time.nullable().describe('Plant time of the first job started'),
    completedAt: time.nullable(),
    closedAt: time.nullable(),
    cancelledAt: time.nullable(),
  })
  .describe('A production order');

export const commandSchema = z
  .object({
    commandId: z.string().describe('{orderId}~OP10~{n}'),
    orderId: z.string(),
    n: int.describe('Dispatch number of the order: 1, then 2 after a re-dispatch'),
    equipment: z.string(),
    product: z.string(),
    quantity: int.describe('Blanks to machine'),
    notBefore: time.describe('Plant time'),
    deviceEpoch: int.describe('The simulator run the command was meant for'),
    createdAt: time,
    updatedAt: time,
    state: z.enum(COMMAND_STATES),
    settled: z
      .boolean()
      .describe('Whether a job exists is known for good; a re-dispatch needs every one settled'),
    failed: z.boolean().describe('Declared failed at least once (an incident was raised)'),
    confirmed: z.boolean().describe('Its `accepted` job fact arrived (the proof of execution)'),
    acceptedBy: z.enum(['fact', 'result']).nullable(),
    acceptedSeq: int.nullable().describe("Device sequence number of the job's acceptance"),
    acceptedAt: time.nullable().describe('Plant time of the acceptance'),
    rejection: z.string().nullable(),
    seqAfterExpiry: int.nullable(),
    attempts: int.describe('Deliveries written (published or not; see `attemptList`)'),
    lastExpiresAt: time.nullable(),
    job: z.enum(JOB_STATES).nullable(),
    startedAt: time.nullable(),
    completedAt: time.nullable(),
  })
  .describe('A dispatch command (`cmd/load-order`) and the job it made');

export const commandAttemptSchema = z.object({
  attempt: int,
  issuedAt: time.describe('Wall time the delivery was written, just before its publish'),
  publishedAt: time
    .nullable()
    .describe('Wall time the broker acknowledged it (PUBACK); null: never published'),
  expiresAt: time.describe('Wall time; the device refuses the delivery after it'),
});

export const commandResultDtoSchema = z
  .object({
    result: z.enum(COMMAND_RESULTS),
    equipment: z.string(),
    deviceEpoch: int,
    expiresAt: time.describe('Of the delivery answered'),
    respondedAt: time,
    receivedAt: time.describe('When the MES stored it'),
    statusCode: z.string().nullable(),
    code: z.enum(COMMAND_REJECTIONS).nullable(),
    position: int.nullable(),
    acceptedSeq: int.nullable(),
    acceptedAt: time.nullable(),
    seqAfterExpiry: int.nullable(),
    reason: z.string().nullable(),
  })
  .describe('One `cmd-res` the gateway published for the command');

export const commandDetailSchema = commandSchema.extend({
  attemptList: z.array(commandAttemptSchema),
  results: z.array(commandResultDtoSchema).describe('Every result, in the order received'),
});

export const erpMessageSchema = z
  .object({
    id: int,
    direction: z.enum(['in', 'out']),
    kind: z.enum(['feed-entry', 'status', 'confirmation']),
    revision: int,
    idempotencyKey: z.string().nullable(),
    status: z
      .string()
      .describe(
        'in: imported, rejected, unchanged, cancelled, revision-refused; out: pending, sent, conflict, refused',
      ),
    detail: z.string().nullable(),
    attempts: int,
    lastError: z.string().nullable(),
    createdAt: time,
    updatedAt: time,
    payload: z.unknown(),
  })
  .describe('A feed entry imported from the ERP, or a message to it');

export const orderIncidentSchema = z.object({
  id: int,
  type: z.enum(ORDER_INCIDENT_TYPES),
  orderId: z.string().nullable(),
  commandId: z.string().nullable(),
  equipment: z.string().nullable(),
  message: z.string(),
  detectedAt: time,
  closedAt: time.nullable(),
  resolution: z.string().nullable(),
});

export const orderHistoryEntrySchema = z.object({
  id: int,
  at: time.describe('Wall time'),
  plantAt: time.nullable(),
  actor: z.string(),
  roles: z.array(z.string()),
  authenticated: z.boolean(),
  action: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  requestId: z.string().nullable(),
});

export const orderDetailSchema = z
  .object({
    order: orderSchema,
    routing: z.array(z.object({ operation: z.string(), workCenter: z.string() })),
    bom: z.array(
      z.object({
        material: z.string(),
        operation: z.string(),
        quantityPerUnit: int,
        usage: z.enum(['standard', 'rework']),
      }),
    ),
    commands: z.array(commandDetailSchema),
    confirmations: z
      .array(confirmationDtoSchema)
      .describe('Confirmations sent to the ERP (#175), by operation and number'),
    erpMessages: z.array(erpMessageSchema),
    incidents: z.array(orderIncidentSchema),
    history: z.array(orderHistoryEntrySchema).describe('The audit, newest first'),
  })
  .describe('One order with its routing, BOM, commands, ERP messages, incidents and history');

export const orderListSchema = z.object({
  orders: z.array(orderSchema),
  truncated: z.boolean().describe(`More than ${String(ORDER_LIMITS.list)} matched`),
});

export const orderIncidentListSchema = z.object({ incidents: z.array(orderIncidentSchema) });

const version = int.min(1).describe('The order version read; 409 when it is not the current one');
const equipmentId = z
  .string()
  .regex(IDENTIFIER)
  .describe('A CNC; by default the dispatch rule chooses');

export const orderWriteRequestSchema = z
  .strictObject({ version })
  .describe('A release or close: the version read');

export const dispatchRequestSchema = z
  .strictObject({ version, equipment: equipmentId.optional() })
  .describe('Dispatches the whole order to a CNC');

export const cancelRequestSchema = z
  .strictObject({
    version,
    reason: z.string().trim().min(1).max(ORDER_LIMITS.reason).optional(),
  })
  .describe('Cancels an order not dispatched yet');

export const redispatchRequestSchema = z
  .strictObject({
    version,
    equipment: equipmentId.optional(),
    quantity: int
      .min(1)
      .max(100_000)
      .optional()
      .describe('At most the remaining blanks (the default)'),
  })
  .describe('Dispatches the remainder again with a new command (n + 1)');

export const abandonRequestSchema = z
  .strictObject({
    version,
    commandId: z.string().min(1).max(128).describe('A command of the order'),
  })
  .describe(
    'Writes off a command whose device run has ended: settled as `abandoned`, counted as started',
  );

export const orderWriteResultSchema = z.object({
  order: orderSchema,
  command: commandSchema.nullable().describe('The command a dispatch or re-dispatch created'),
});

/** Push messages of the `orders` topic: upserts by id; a client reads first, then applies them. */
export const orderPushMessages = [
  z.object({
    type: z.literal('order'),
    event: z
      .enum(['imported', 'updated'])
      .describe('A new order, or any change of one (status, flags, revision, quantities)'),
    order: orderSchema,
  }),
  z.object({
    type: z.literal('command'),
    event: z.enum(['created', 'updated']),
    command: commandSchema,
  }),
] as const;

export type OrderDto = z.infer<typeof orderSchema>;
export type CommandDto = z.infer<typeof commandSchema>;
export type CommandAttemptDto = z.infer<typeof commandAttemptSchema>;
export type CommandResultDto = z.infer<typeof commandResultDtoSchema>;
export type CommandDetailDto = z.infer<typeof commandDetailSchema>;
export type ErpMessageDto = z.infer<typeof erpMessageSchema>;
export type OrderIncidentDto = z.infer<typeof orderIncidentSchema>;
export type OrderHistoryEntryDto = z.infer<typeof orderHistoryEntrySchema>;
export type OrderDetail = z.infer<typeof orderDetailSchema>;
export type OrderList = z.infer<typeof orderListSchema>;
export type OrderIncidentList = z.infer<typeof orderIncidentListSchema>;
export type OrderWriteRequest = z.infer<typeof orderWriteRequestSchema>;
export type DispatchRequest = z.infer<typeof dispatchRequestSchema>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type RedispatchRequest = z.infer<typeof redispatchRequestSchema>;
export type AbandonRequest = z.infer<typeof abandonRequestSchema>;
export type OrderWriteResult = z.infer<typeof orderWriteResultSchema>;
