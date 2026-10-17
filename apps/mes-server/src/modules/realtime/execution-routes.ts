import {
  EXECUTION_LIMITS,
  MES_API_LIMITS as LIMITS,
  UNIT_STATUSES,
  executionIncidentListSchema,
  orderExecutionSchema,
  scrapCodingRequestSchema,
  scrapReasonListSchema,
  scrapRecordListSchema,
  scrapRecordSchema,
  unitListSchema,
  type OrderExecutionDto,
  type ScrapRecordDto,
  type UnitDto,
} from '@shopfloor/contracts/mes-api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ExecutionError,
  type Execution,
  type ExecutionIncident,
  type OrderExecutionRecord,
  type ScrapRecord,
  type UnitRecord,
} from '../execution/index.ts';
import type { WriteBy } from '../identity/index.ts';
import { orderParams } from './order-routes.ts';
import { HttpProblem, getRoute, writeRoute, type ErrorStatus } from './routes.ts';

/** What the execution routes use of the execution module (#175). */
export type ExecutionApi = Pick<
  Execution,
  'units' | 'orderExecution' | 'scrapRecords' | 'codeScrap' | 'scrapReasons' | 'incidents'
>;

const EXECUTION_STATUS = { 'not-found': 404, conflict: 409, invalid: 422 } as const;
const WRITE_ERRORS: readonly ErrorStatus[] = [400, 403, 404, 405, 409, 413, 415, 422, 429, 503];
const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

const unitStatuses = z
  .string()
  .regex(/^[a-z-]+(,[a-z-]+)*$/)
  .transform((value) => value.split(','))
  .pipe(z.array(z.enum(UNIT_STATUSES)));
export const unitQuery = z.strictObject({
  orderId: orderParams.shape.id.optional().describe('Only the units of this order'),
  epoch: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional()
    .describe('Only the units of this device epoch'),
  status: unitStatuses.optional().describe(`Only these statuses (${UNIT_STATUSES.join(', ')})`),
});
const scrapQuery = z.strictObject({
  orderId: orderParams.shape.id.optional().describe('Only the scrap records of this order'),
  uncoded: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
    .describe('Only the records not coded yet'),
});
const scrapParams = z.strictObject({
  id: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .describe('The scrap record id'),
});
const incidentQuery = z.strictObject({
  orderId: orderParams.shape.id.optional().describe('Only the incidents of this order'),
  open: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
    .describe('Only the incidents still open'),
});

export function unitDto(unit: UnitRecord): UnitDto {
  return {
    epoch: unit.epoch,
    partId: unit.partId,
    serial: unit.serial,
    product: unit.product,
    orderId: unit.orderId,
    commandId: unit.commandId,
    status: unit.status,
    position: unit.position,
    lastAt: iso(unit.lastAt),
    terminalAt: isoOrNull(unit.terminalAt),
    violation: unit.violation,
    records: unit.records.map((r) => ({
      operation: r.operation,
      equipment: r.equipment,
      pass: r.pass,
      at: iso(r.at),
      result: r.result,
      reason: r.reason,
      seq: r.seq,
    })),
  };
}

export function orderExecutionDto(record: OrderExecutionRecord): OrderExecutionDto {
  return {
    orderId: record.orderId,
    operations: record.operations.map((op) => ({
      operation: op.operation,
      workCenter: op.workCenter,
      in: op.in,
      good: op.good,
      scrap: { ...op.scrap },
      rework: op.rework,
      material: { ...op.material },
      completedAt: isoOrNull(op.completedAt),
    })),
    units: { ...record.units },
    wip: { ...record.wip },
    inMachine: { ...record.inMachine },
    reworkPasses: record.reworkPasses,
    scrap: Object.fromEntries(Object.entries(record.scrap).map(([op, s]) => [op, { ...s }])),
    packedGood: record.packedGood,
    completedAt: isoOrNull(record.completedAt),
  };
}

export function scrapRecordDto(record: ScrapRecord): ScrapRecordDto {
  return {
    id: record.id,
    equipment: record.equipment,
    epoch: record.epoch,
    seq: record.seq,
    partId: record.partId,
    serial: record.serial,
    orderId: record.orderId,
    operation: record.operation,
    pass: record.pass,
    scrappedAt: iso(record.scrappedAt),
    machineReason: record.machineReason,
    codedReason: record.codedReason,
    comment: record.comment,
    codedBy: record.codedBy,
    codedAt: isoOrNull(record.codedAt),
    version: record.version,
  };
}

const incidentDto = (incident: ExecutionIncident) => ({
  id: incident.id,
  type: incident.type,
  epoch: incident.epoch,
  partId: incident.partId,
  orderId: incident.orderId,
  equipment: incident.equipment,
  message: incident.message,
  detectedAt: iso(incident.detectedAt),
  closedAt: isoOrNull(incident.closedAt),
  resolution: incident.resolution,
});

/**
 * The execution API (#175): units, an order's execution, scrap records and their coding, the
 * scrap reason tree and routing-violation incidents. Registered in the `/api/v1` scope, behind its
 * guards.
 */
export function executionRoutes(
  api: FastifyInstance,
  deps: {
    /** The execution module, or 503 while the MES starts. */
    readonly execution: () => ExecutionApi;
    /** Who writes: the session's user; 401 without a session, whatever `MES_AUTH` says. */
    readonly writer: (request: FastifyRequest) => Promise<WriteBy>;
  },
): void {
  getRoute(
    api,
    {
      url: '/execution/units',
      summary: 'Units tracked through the routing, with their operation records',
      description: `By (epoch, partId); at most ${String(EXECUTION_LIMITS.units)}, \`truncated\` when more matched. A unit is keyed (device epoch, partId) and attributed to an order by the job facts (ADR-0031).`,
      tags: ['execution'],
      query: unitQuery,
      response: unitListSchema,
      errors: [400, 503],
    },
    async ({ query }) => {
      const found = await deps.execution().units({
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        ...(query.epoch === undefined ? {} : { epoch: query.epoch }),
        ...(query.status === undefined ? {} : { status: query.status }),
        limit: EXECUTION_LIMITS.units,
      });
      return { units: found.units.map(unitDto), truncated: found.truncated };
    },
  );

  getRoute(
    api,
    {
      url: '/orders/:id/execution',
      summary: 'An order’s quantities, backflushed material, units, WIP and completion',
      description:
        'Per routing operation: in, good, scrap by reason, rework, material backflushed at cycle completion, and when no unit can come back to it (plan H1). WIP per position; blanks a CNC holds whose OP10 cycle has not completed.',
      tags: ['execution'],
      params: orderParams,
      query: z.strictObject({}),
      response: orderExecutionSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => {
      const found = await deps.execution().orderExecution(params.id);
      if (!found) throw new HttpProblem(404, `no order ${params.id}`);
      return orderExecutionDto(found);
    },
  );

  getRoute(
    api,
    {
      url: '/scrap-records',
      summary: 'Scrap records, newest first',
      description: `At most ${String(EXECUTION_LIMITS.scrapRecords)}. Every machine scrap (OP10 DIMENSIONAL, OP40 second LEAK) with its coding, if any.`,
      tags: ['execution'],
      query: scrapQuery,
      response: scrapRecordListSchema,
      errors: [400, 503],
    },
    async ({ query }) => {
      const found = await deps.execution().scrapRecords({
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        uncoded: query.uncoded,
        limit: EXECUTION_LIMITS.scrapRecords,
      });
      return { records: found.records.map(scrapRecordDto), truncated: found.truncated };
    },
  );

  getRoute(
    api,
    {
      url: '/scrap-reasons',
      summary: 'The scrap reason tree',
      tags: ['execution'],
      query: z.strictObject({}),
      response: scrapReasonListSchema,
      errors: [400, 503],
    },
    async () => ({
      reasons: (await deps.execution().scrapReasons()).map((r) => ({
        id: r.id,
        parent: r.parent,
        name: r.name,
        active: r.active,
      })),
    }),
  );

  getRoute(
    api,
    {
      url: '/execution-incidents',
      summary: 'Incidents of the execution module, newest first',
      description:
        'Routing violations: a unit seen without its predecessor once that operation’s machines are final through its time, repeated, or after it was packed or scrapped.',
      tags: ['execution'],
      query: incidentQuery,
      response: executionIncidentListSchema,
      errors: [400, 503],
    },
    async ({ query }) => ({
      incidents: (
        await deps.execution().incidents({
          open: query.open,
          ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
          limit: EXECUTION_LIMITS.incidents,
        })
      ).map(incidentDto),
    }),
  );

  writeRoute(
    api,
    {
      method: 'PUT',
      url: '/scrap-records/:id/coding',
      access: 'scrap:code',
      summary: 'Codes a scrap record with a detailed reason',
      description:
        "The record's machine reason or a reason below it in the active scrap tree (422 otherwise); names the record's `version` (409 urn:shopfloor:scrap-stale when it is not the current one); audited with the session's user. Coding never changes a quantity or a confirmation. " +
        'Writes need an Origin of this host (or allowlisted), `Sec-Fetch-Site: same-origin` when sent, and application/json (ADR-0023).',
      tags: ['execution'],
      params: scrapParams,
      body: scrapCodingRequestSchema,
      response: scrapRecordSchema,
      errors: WRITE_ERRORS,
    },
    LIMITS.writeBodyBytes,
    async ({ params, body, requestId, request }) => {
      const by = await deps.writer(request);
      const record = await deps
        .execution()
        .codeScrap(params.id, body, { by, requestId })
        .catch((error: unknown) => {
          throw error instanceof ExecutionError
            ? new HttpProblem(EXECUTION_STATUS[error.kind], error.message, error.type)
            : error;
        });
      return scrapRecordDto(record);
    },
  );
}
