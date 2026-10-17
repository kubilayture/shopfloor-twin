import { z } from 'zod';

// The MES's `genealogy` API (#199, Phase 8 plan "Genealogy", ADR-0034): lots imported from the ERP,
// units by serial, cartons formed by the packing rule, and the backward and forward trace queries,
// each saying whether its answer is final. Shared by `mes-server`, which serves it, and `web`,
// which parses it (ADR-0020); `mes-api` re-exports it.

/** A time in a response: ISO 8601 UTC with milliseconds. */
const time = z.iso.datetime();
const int = z.number().int();

export const GENEALOGY_LIMITS = {
  /** Characters of a trace search (`q`) and of a serial, lot or carton id in a path. */
  id: 128,
  /** Results per kind one `GET /trace/search` answers at most. */
  search: 20,
  /** Units one forward trace or carton answers at most; more sets `truncated`. */
  units: 5_000,
  /** Incidents one `GET /genealogy-incidents` answers at most (newest first). */
  incidents: 500,
} as const;

export const LOT_STATUSES = ['active', 'retired'] as const;
export const CARTON_STATUSES = ['open', 'closed'] as const;
export const GENEALOGY_INCIDENT_TYPES = [
  'unknown-lot',
  'serial-reused',
  'material-mismatch',
  'rebuild-failed',
] as const;
export const TRACE_SEARCH_KINDS = ['serial', 'lot', 'carton', 'order'] as const;

export const lotRefDtoSchema = z.object({ material: z.string(), lot: z.string() });

export const materialLotSchema = z
  .object({
    id: z.string(),
    material: z.string(),
    quantity: int.describe('Quantity received, as the ERP lists it'),
    status: z
      .enum(LOT_STATUSES)
      .describe('retired: no longer in the ERP’s lot list (kept, never deleted)'),
    importedAt: time.describe('Wall time of the first import'),
  })
  .describe('A material lot imported from the ERP’s lot list');

export const crewSchema = z
  .object({
    userId: int,
    username: z.string(),
    from: time.describe('Plant time of the sign-on'),
    to: time.nullable(),
  })
  .describe('A crew row of the MES signed on to the work center during the cycle (not reconciled)');

export const traceRecordSchema = z
  .object({
    operation: z.string(),
    pass: int.describe('1, or 2 at OP30 and OP40 after a leak-test failure sent the unit back'),
    equipment: z.string(),
    epoch: int,
    seq: int.describe('The cycle fact in the machine’s device sequence'),
    at: time.describe('Plant time the cycle completed'),
    result: z.enum(['good', 'scrap', 'rework']),
    reason: z.string().nullable(),
    lots: z
      .array(lotRefDtoSchema)
      .nullable()
      .describe(
        'The lots consumed for the unit on this cycle, in consumption order; [] when none; null when the fact reported none (WSH-01 on Modbus, a gateway before UNS 1.4, or fields ingest dropped)',
      ),
    operator: z
      .string()
      .nullable()
      .describe('The device operator at the cycle’s start; null when none or not reported'),
    operatorReported: z.boolean().describe('Whether the fact carried the operator field'),
    reading: z
      .object({
        characteristic: z.string(),
        value: z.number(),
        unit: z.string(),
        upperLimit: z.number(),
      })
      .nullable()
      .describe('The measurement the cycle reported (the leak test), else null'),
    crew: z
      .array(crewSchema)
      .describe(
        'MES users signed on to the machine’s work center during the cycle, where it has a device operator',
      ),
  })
  .describe('One cycle of a unit with what it consumed and measured');

export const traceUnitSchema = z
  .object({
    epoch: int.describe('Units are keyed (device epoch, partId); serials repeat across runs'),
    partId: int,
    serial: z.string().nullable(),
    product: z.string(),
    orderId: z.string().nullable(),
    status: z.enum(['wip', 'packed', 'scrapped', 'lost']),
    carton: z.string().nullable(),
    records: z.array(traceRecordSchema),
  })
  .describe('A unit traced back: its records, lots, operators, readings and carton');

/** The `final` part of every trace answer. */
const finality = {
  final: z
    .boolean()
    .describe(
      'Every machine of the routing is final through the answer’s latest record (ADR-0018) and genealogy has processed it',
    ),
  notFinal: z
    .array(z.string())
    .describe('The machines whose processed final-through is below the answer’s latest record'),
};

export const serialTraceSchema = z
  .object({
    serial: z.string(),
    units: z.array(traceUnitSchema).describe('Every unit with this serial, newest epoch first'),
    ...finality,
  })
  .describe('`GET /trace/serials/{serial}`: backward trace');

export const unitRefSchema = z.object({
  epoch: int,
  partId: int,
  serial: z.string().nullable(),
  orderId: z.string().nullable(),
  carton: z.string().nullable(),
  status: z.enum(['wip', 'packed', 'scrapped', 'lost']),
});

export const lotTraceSchema = z
  .object({
    lot: z.string(),
    material: z.string().describe('As the facts or the lot list name it'),
    master: materialLotSchema.nullable().describe('The imported lot; null if never imported'),
    consumed: int.describe('Pieces consumed: lot references over every record of every unit'),
    units: z.array(unitRefSchema).describe('By (epoch, partId)'),
    truncated: z.boolean(),
    orders: z.array(z.string()),
    cartons: z.array(z.string()),
    withLots: z
      .array(lotRefDtoSchema)
      .describe('“Where used with”: every other lot the same units consumed, by lot id'),
    ...finality,
  })
  .describe('`GET /trace/lots/{lot}`: forward trace');

export const cartonSchema = z.object({
  id: z.string().describe('{orderId}-C{nn}'),
  orderId: z.string(),
  product: z.string(),
  capacity: int,
  status: z.enum(CARTON_STATUSES),
  closedAt: time.nullable().describe('Plant time: its last member’s, or the order’s completion'),
  members: int,
});

export const cartonTraceSchema = z
  .object({
    carton: cartonSchema,
    units: z.array(unitRefSchema).describe('In placement order'),
    lots: z.array(lotRefDtoSchema).describe('Every lot its members consumed, by lot id'),
    ...finality,
  })
  .describe('`GET /trace/cartons/{id}`: a carton and its members');

export const traceSearchSchema = z
  .object({
    q: z.string(),
    results: z.array(
      z.object({
        kind: z.enum(TRACE_SEARCH_KINDS),
        id: z.string(),
      }),
    ),
  })
  .describe('`GET /trace/search?q=`: serials, lots, cartons and orders starting with q');

export const genealogyIncidentSchema = z.object({
  id: int,
  type: z.enum(GENEALOGY_INCIDENT_TYPES),
  lot: z.string().nullable(),
  epoch: int.nullable(),
  partId: int.nullable(),
  equipment: z.string().nullable(),
  message: z.string(),
  detectedAt: time,
  closedAt: time.nullable(),
  resolution: z.string().nullable(),
});

export const genealogyIncidentListSchema = z.object({
  incidents: z.array(genealogyIncidentSchema),
});

export type LotRefDto = z.infer<typeof lotRefDtoSchema>;
export type MaterialLotDto = z.infer<typeof materialLotSchema>;
export type TraceRecordDto = z.infer<typeof traceRecordSchema>;
export type TraceUnitDto = z.infer<typeof traceUnitSchema>;
export type SerialTraceDto = z.infer<typeof serialTraceSchema>;
export type LotTraceDto = z.infer<typeof lotTraceSchema>;
export type CartonDto = z.infer<typeof cartonSchema>;
export type CartonTraceDto = z.infer<typeof cartonTraceSchema>;
export type TraceSearchDto = z.infer<typeof traceSearchSchema>;
export type GenealogyIncidentDto = z.infer<typeof genealogyIncidentSchema>;
