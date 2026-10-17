import { z } from 'zod';

// The MES's `execution` API (#175, Phase 7 plan "Routing execution per part", ADR-0031): units
// tracked through the routing, an order's quantities, material, WIP and completion, scrap records
// and their coding, the confirmations sent to the ERP, and routing-violation incidents. Shared by
// `mes-server`, which serves it, and `web`, which parses it (ADR-0020); `mes-api` re-exports it.

/** A time in a response: ISO 8601 UTC with milliseconds. */
const time = z.iso.datetime();
const int = z.number().int();
const counts = z.record(z.string(), int);
/** A scrap reason id: its path in the tree, e.g. LEAK/POROSITY. */
const SCRAP_REASON = /^[A-Z0-9]+(-[A-Z0-9]+)*(\/[A-Z0-9]+(-[A-Z0-9]+)*){0,7}$/;

export const EXECUTION_LIMITS = {
  /** Units one `GET /execution/units` answers at most; more sets `truncated`. */
  units: 1_000,
  /** Scrap records one `GET /scrap-records` answers at most (newest first). */
  scrapRecords: 500,
  /** Incidents one `GET /execution-incidents` answers at most (newest first). */
  incidents: 500,
  /** Characters of a scrap coding's comment. */
  comment: 500,
} as const;

export const UNIT_STATUSES = ['wip', 'packed', 'scrapped', 'lost'] as const;
export const ROUTING_VIOLATIONS = ['missing-predecessor', 'repeated', 'after-terminal'] as const;

export const operationRecordSchema = z
  .object({
    operation: z.string(),
    equipment: z.string(),
    pass: int.describe('1, or 2 at OP30 and OP40 after a leak-test failure sent the unit back'),
    at: time.describe('Plant time the cycle completed (cycle facts carry no start)'),
    result: z.enum(['good', 'scrap', 'rework']),
    reason: z.string().nullable(),
    seq: int.describe('The cycle fact in the machine’s device sequence'),
  })
  .describe('One cycle of a unit: (unit, operation, pass)');

export const unitSchema = z
  .object({
    epoch: int.describe('The device epoch: units are keyed (epoch, partId)'),
    partId: int,
    serial: z.string().nullable().describe('Given by OP10; unique only within an epoch'),
    product: z.string(),
    orderId: z.string().nullable().describe('By the job facts; null while unattributed'),
    commandId: z.string().nullable(),
    status: z.enum(UNIT_STATUSES),
    position: z
      .string()
      .describe('after:OPxx (buffer, Blocked machine or next cycle), rework:OP30, or done'),
    lastAt: time,
    terminalAt: time.nullable(),
    violation: z.enum(ROUTING_VIOLATIONS).nullable(),
    records: z.array(operationRecordSchema),
  })
  .describe('A part of one simulator run with its operation records');

export const unitListSchema = z.object({
  units: z.array(unitSchema),
  truncated: z.boolean().describe(`More than ${String(EXECUTION_LIMITS.units)} matched`),
});

export const orderOperationSchema = z
  .object({
    operation: z.string(),
    workCenter: z.string().nullable(),
    in: int.describe('Completed cycles, every pass'),
    good: int,
    scrap: counts.describe('Scrap per reason'),
    rework: int.describe('Cycles that sent a unit back (leak-test failures)'),
    material: counts.describe(
      'Backflushed at cycle completion: standard lines on a first pass, rework lines on a later one',
    ),
    completedAt: time
      .nullable()
      .describe('When no unit can come back to it (plan H1); null until then'),
  })
  .describe('One operation of an order as execution sees it');

export const orderExecutionSchema = z
  .object({
    orderId: z.string(),
    operations: z.array(orderOperationSchema),
    units: z.object({ total: int, wip: int, packed: int, scrapped: int, lost: int }),
    wip: counts.describe('Units in WIP per position: after:OPxx, rework:OPxx, at:{equipment}'),
    inMachine: counts.describe(
      'Blanks a CNC holds for the order whose OP10 cycle has not completed, per CNC',
    ),
    reworkPasses: int,
    scrap: z.record(z.string(), counts).describe('Scrap per operation and reason'),
    packedGood: int,
    completedAt: time.nullable(),
  })
  .describe('An order’s quantities, material, units, WIP and completion');

export const scrapRecordSchema = z
  .object({
    id: int,
    equipment: z.string(),
    epoch: int,
    seq: int,
    partId: int,
    serial: z.string().nullable(),
    orderId: z.string().nullable(),
    operation: z.string(),
    pass: int,
    scrappedAt: time,
    machineReason: z.string().describe('The cycle fact’s reason (DIMENSIONAL, LEAK)'),
    codedReason: z.string().nullable(),
    comment: z.string().nullable(),
    codedBy: z.string().nullable(),
    codedAt: time.nullable().describe('Wall time'),
    version: int.describe('Names the version a coding must send'),
  })
  .describe('A machine scrap a person codes with a detailed reason');

export const scrapRecordListSchema = z.object({
  records: z.array(scrapRecordSchema),
  truncated: z.boolean(),
});

export const scrapCodingRequestSchema = z
  .strictObject({
    version: int.min(1).describe('The record version read; 409 when it is not the current one'),
    reason: z
      .string()
      .regex(SCRAP_REASON)
      .describe('An active scrap reason: the machine reason or one below it'),
    comment: z.string().max(EXECUTION_LIMITS.comment).optional(),
  })
  .describe('Codes a scrap record (never changes a quantity)');

export const scrapReasonListSchema = z.object({
  reasons: z
    .array(
      z.object({
        id: z.string().describe('The path in the tree, e.g. LEAK/POROSITY'),
        parent: z.string().nullable(),
        name: z.string(),
        active: z.boolean(),
      }),
    )
    .describe('Parents before children'),
});

export const executionIncidentSchema = z.object({
  id: int,
  type: z.enum(['routing-violation']),
  epoch: int.nullable(),
  partId: int.nullable(),
  orderId: z.string().nullable(),
  equipment: z.string().nullable(),
  message: z.string(),
  detectedAt: time,
  closedAt: time.nullable(),
  resolution: z.string().nullable(),
});

export const executionIncidentListSchema = z.object({
  incidents: z.array(executionIncidentSchema),
});

const confirmationCounts = {
  yield: int,
  scrap: counts,
  reworkPasses: int,
  material: counts,
};

export const confirmationDtoSchema = z
  .object({
    operation: z.string(),
    n: int.describe('1 for the final confirmation, 2 and above for corrections'),
    kind: z.enum(['final', 'correction']),
    revision: int,
    ...confirmationCounts,
    totals: z.object(confirmationCounts).describe('Every confirmation up to this one summed'),
    confirmedAt: time.describe('Plant time the operation was complete'),
    idempotencyKey: z.string().describe('confirmationKey: {order}~{operation}~conf~{n}'),
    createdAt: time,
    messageStatus: z.string().describe('Of its outbound message: pending, sent, conflict, refused'),
  })
  .describe('A confirmation sent to the ERP: counts are deltas in a correction');

export type UnitDto = z.infer<typeof unitSchema>;
export type OrderExecutionDto = z.infer<typeof orderExecutionSchema>;
export type ScrapRecordDto = z.infer<typeof scrapRecordSchema>;
export type ConfirmationDto = z.infer<typeof confirmationDtoSchema>;
