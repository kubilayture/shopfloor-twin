import {
  GENEALOGY_INCIDENT_TYPES,
  GENEALOGY_LIMITS,
  cartonTraceSchema,
  genealogyIncidentListSchema,
  lotTraceSchema,
  serialTraceSchema,
  traceSearchSchema,
  type CartonTraceDto,
  type LotTraceDto,
  type SerialTraceDto,
  type TraceUnitDto,
} from '@shopfloor/contracts/mes-api';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  CartonTrace,
  Genealogy,
  GenealogyIncident,
  LotTrace,
  SerialTrace,
  TraceUnitRecord,
  UnitRef,
} from '../genealogy/index.ts';
import { HttpProblem, getRoute } from './routes.ts';

/** What the trace routes use of the genealogy module (#199). */
export type GenealogyApi = Pick<Genealogy, 'serial' | 'lot' | 'carton' | 'search' | 'incidents'>;

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

/** A serial, lot or carton id in a path: printable, no slash. */
const idParam = z
  .string()
  .min(1)
  .max(GENEALOGY_LIMITS.id)
  .regex(/^[^/\s]+$/);

export function traceUnitDto(unit: TraceUnitRecord): TraceUnitDto {
  return {
    epoch: unit.epoch,
    partId: unit.partId,
    serial: unit.serial,
    product: unit.product,
    orderId: unit.orderId,
    status: unit.status,
    carton: unit.carton,
    records: unit.records.map((r) => ({
      operation: r.operation,
      pass: r.pass,
      equipment: r.equipment,
      epoch: r.epoch,
      seq: r.seq,
      at: iso(r.at),
      result: r.result,
      reason: r.reason,
      lots: r.lots === null ? null : r.lots.map((l) => ({ material: l.material, lot: l.lot })),
      operator: r.operator,
      operatorReported: r.operatorReported,
      reading:
        r.measurement === null
          ? null
          : {
              characteristic: r.measurement.characteristic,
              value: r.measurement.value,
              unit: r.measurement.unit,
              upperLimit: r.measurement.upperLimit,
            },
      crew: r.crew.map((c) => ({
        userId: c.userId,
        username: c.username,
        from: iso(c.fromPlant),
        to: isoOrNull(c.toPlant),
      })),
    })),
  };
}

const unitRefDto = (unit: UnitRef) => ({
  epoch: unit.epoch,
  partId: unit.partId,
  serial: unit.serial,
  orderId: unit.orderId,
  carton: unit.carton,
  status: unit.status,
});

export function serialTraceDto(trace: SerialTrace): SerialTraceDto {
  return {
    serial: trace.serial,
    units: trace.units.map(traceUnitDto),
    final: trace.final,
    notFinal: [...trace.notFinal],
  };
}

export function lotTraceDto(trace: LotTrace): LotTraceDto {
  return {
    lot: trace.lot,
    material: trace.material,
    master:
      trace.master === null
        ? null
        : {
            id: trace.master.id,
            material: trace.master.material,
            quantity: trace.master.quantity,
            status: trace.master.status,
            importedAt: iso(trace.master.importedAt),
          },
    consumed: trace.consumed,
    units: trace.units.map(unitRefDto),
    truncated: trace.truncated,
    orders: [...trace.orders],
    cartons: [...trace.cartons],
    withLots: trace.withLots.map((l) => ({ material: l.material, lot: l.lot })),
    final: trace.final,
    notFinal: [...trace.notFinal],
  };
}

export function cartonTraceDto(trace: CartonTrace): CartonTraceDto {
  return {
    carton: {
      id: trace.carton.id,
      orderId: trace.carton.orderId,
      product: trace.carton.product,
      capacity: trace.carton.capacity,
      status: trace.carton.status,
      closedAt: isoOrNull(trace.carton.closedAt),
      members: trace.carton.members,
    },
    units: trace.units.map(unitRefDto),
    lots: trace.lots.map((l) => ({ material: l.material, lot: l.lot })),
    final: trace.final,
    notFinal: [...trace.notFinal],
  };
}

const incidentDto = (incident: GenealogyIncident) => ({
  id: incident.id,
  type: incident.type,
  lot: incident.lot,
  epoch: incident.epoch,
  partId: incident.partId,
  equipment: incident.equipment,
  message: incident.message,
  detectedAt: iso(incident.detectedAt),
  closedAt: isoOrNull(incident.closedAt),
  resolution: incident.resolution,
});

const FINAL =
  ' `final` is true once every machine of the routing is final through the answer’s latest record and genealogy has processed it; `notFinal` names the others (facts may still arrive).';

/**
 * The trace API (#199, plan "Trace queries"): a serial backward, a lot forward, a carton and a
 * search; the genealogy incidents. Read-only; registered in the `/api/v1` scope, behind its guards.
 */
export function genealogyRoutes(
  api: FastifyInstance,
  deps: {
    /** The genealogy module, or 503 while the MES starts. */
    readonly genealogy: () => GenealogyApi;
  },
): void {
  getRoute(
    api,
    {
      url: '/trace/serials/:serial',
      summary: 'Backward trace of a serial',
      description: `Every unit with the serial (serials repeat across simulator runs, ADR-0034), newest device epoch first: per operation and pass its machine, time, result, lots, device operator and MES crew, reading, order and carton.${FINAL}`,
      tags: ['genealogy'],
      params: z.strictObject({ serial: idParam.describe('A serial (DMC), e.g. VB-100-000042') }),
      query: z.strictObject({}),
      response: serialTraceSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => {
      const found = await deps.genealogy().serial(params.serial);
      if (!found) throw new HttpProblem(404, `no unit with serial ${params.serial}`);
      return serialTraceDto(found);
    },
  );

  getRoute(
    api,
    {
      url: '/trace/lots/:lot',
      summary: 'Forward trace of a lot',
      description: `The units that consumed the lot at any operation and pass (at most ${String(GENEALOGY_LIMITS.units)}, \`truncated\` when more), their orders and cartons, the pieces consumed, the lot as imported from the ERP, and the other lots of the same units.${FINAL}`,
      tags: ['genealogy'],
      params: z.strictObject({ lot: idParam.describe('A lot id, e.g. BL100-2610-01') }),
      query: z.strictObject({}),
      response: lotTraceSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => {
      const found = await deps.genealogy().lot(params.lot);
      if (!found) throw new HttpProblem(404, `no lot ${params.lot}`);
      return lotTraceDto(found);
    },
  );

  getRoute(
    api,
    {
      url: '/trace/cartons/:carton',
      summary: 'A carton with its members',
      description: `A carton formed by the packing rule on final data (packing.yaml): its members in placement order and every lot they consumed.${FINAL}`,
      tags: ['genealogy'],
      params: z.strictObject({ carton: idParam.describe('A carton id, e.g. PO-2610-101-C01') }),
      query: z.strictObject({}),
      response: cartonTraceSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => {
      const found = await deps.genealogy().carton(params.carton);
      if (!found) throw new HttpProblem(404, `no carton ${params.carton}`);
      return cartonTraceDto(found);
    },
  );

  getRoute(
    api,
    {
      url: '/trace/search',
      summary: 'Serials, lots, cartons and orders by the start of their id',
      description: `At most ${String(GENEALOGY_LIMITS.search)} of each kind, by id.`,
      tags: ['genealogy'],
      query: z.strictObject({
        q: z.string().min(1).max(GENEALOGY_LIMITS.id).describe('The start of an id'),
      }),
      response: traceSearchSchema,
      errors: [400, 503],
    },
    async ({ query }) => ({
      q: query.q,
      results: await deps.genealogy().search(query.q, GENEALOGY_LIMITS.search),
    }),
  );

  getRoute(
    api,
    {
      url: '/genealogy-incidents',
      summary: 'Incidents of the genealogy module, newest first',
      description:
        'unknown-lot (a fact names a lot the ERP doesn’t list; closed when an import lists it), serial-reused (one per pair of device epochs sharing serials) and material-mismatch (a lot of a material the BOM doesn’t list for that operation and pass).',
      tags: ['genealogy'],
      query: z.strictObject({
        open: z
          .enum(['true', 'false'])
          .optional()
          .transform((value) => value === 'true')
          .describe('Only the incidents still open'),
        type: z.enum(GENEALOGY_INCIDENT_TYPES).optional().describe('Only this type'),
      }),
      response: genealogyIncidentListSchema,
      errors: [400, 503],
    },
    async ({ query }) => ({
      incidents: (
        await deps.genealogy().incidents({
          open: query.open,
          ...(query.type === undefined ? {} : { type: query.type }),
          limit: GENEALOGY_LIMITS.incidents,
        })
      ).map(incidentDto),
    }),
  );
}
