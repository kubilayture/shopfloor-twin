import { z } from 'zod';

// The MES API's responses and WebSocket messages (#97, ADR-0019), shared by `mes-server`, which
// generates docs/api/mes.openapi.json and mes-realtime.schema.json from them, and `web`, which
// parses what it receives with them (ADR-0020).

/** Limits on what one request may ask for (read-only API, no auth until Phase 9). */
export const MES_API_LIMITS = {
  /** Longest range of `GET …/intervals`. */
  intervalRangeMs: 7 * 24 * 3_600_000,
  /** Most stored pieces one `…/intervals` response is built from; more sets `truncated`. */
  intervalPieces: 20_000,
  /** Longest range of `GET …/telemetry`. */
  telemetryRangeMs: 31 * 24 * 3_600_000,
  /** Metrics per telemetry request. */
  metrics: 8,
  /** Buckets per metric of a telemetry series: at most and by default. */
  maxPoints: 5_000,
  defaultPoints: 1_000,
} as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const identifier = z.string().regex(IDENTIFIER).describe('An id from master data');
export const metricName = z
  .string()
  .regex(IDENTIFIER)
  .describe('A telemetry metric, the last segment of its UNS topic');
/** A time in a response: ISO 8601 UTC with milliseconds. */
const time = z.iso.datetime();
const named = z.object({ id: z.string(), name: z.string() });
const int = z.number().int();

export const problemSchema = z
  .object({
    type: z.string().describe('Always about:blank: the status says it all'),
    title: z.string(),
    status: int,
    detail: z.string(),
    instance: z.string().describe('The request path'),
  })
  .describe('An error (RFC 9457 problem details), served as application/problem+json');

export const currentStateSchema = z
  .object({
    epoch: int.describe('Device epoch (run) the state belongs to'),
    state: z.string(),
    cause: z.string().nullable(),
    since: time.describe('When this state began (simulation time)'),
    seq: int.nullable().describe("The fact's sequence number; null when only the anchor is known"),
    provisionalUntil: time
      .nullable()
      .describe('How far the open interval is stored (provisional, moves with the watermark)'),
    ageMs: int
      .nullable()
      .describe("Time in this state up to the epoch's watermark (simulation ms)"),
  })
  .describe("The equipment's latest state, in its newest device epoch");

export const equipmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  operation: z.string(),
  interface: z.enum(['opcua', 'modbus']),
  position: int.describe('Place in line order'),
  site: named,
  area: named,
  workCenter: named,
  current: currentStateSchema.nullable().describe('Null while the equipment never reported'),
});

export const equipmentListSchema = z.object({ equipment: z.array(equipmentSchema) });

export const clockSchema = z.object({
  epoch: int,
  watermark: time.describe('Latest source time seen in that epoch (simulation time)'),
});

export const plantSchema = z.object({
  site: z
    .object({ id: z.string(), name: z.string(), enterprise: named })
    .nullable()
    .describe('Null before master data is seeded'),
  clock: clockSchema.nullable().describe('The newest epoch and its watermark: the plant clock'),
  epochs: z.array(clockSchema).describe('Every epoch seen since start-up, newest first'),
});

export const intervalSchema = z.object({
  epoch: int,
  start: time.describe('Start, clipped to the requested range'),
  end: time.describe('End, clipped to the requested range'),
  state: z.string(),
  cause: z.string().nullable(),
  provisional: z.boolean().describe('The open interval: its end moves with the watermark'),
  intervalStart: time.describe('Where the whole interval starts (may be before `from`)'),
  startSeq: int.nullable().describe('The fact that opened it; null for an anchor'),
});

export const intervalsSchema = z.object({
  equipment: z.string(),
  from: time,
  to: time,
  truncated: z
    .boolean()
    .describe(
      'True when the range held more pieces than one response takes: intervals that may continue ' +
        'beyond the limit are left out; request again with from = next',
    ),
  next: time
    .nullable()
    .describe(
      'Where to continue when truncated (null otherwise); intervals before it are complete',
    ),
  intervals: z
    .array(intervalSchema)
    .describe('State intervals, the stored hour and shift pieces merged back, by start'),
});

export const metricsSchema = z.object({
  equipment: z.string(),
  metrics: z.array(
    z.object({
      metric: z.string(),
      unit: z.string(),
      latest: z.object({ t: time, value: z.number() }),
    }),
  ),
});

export const seriesSchema = z.object({
  equipment: z.string(),
  from: time,
  to: time,
  bucketMs: int.describe('Width of each bucket; buckets are aligned on `from`'),
  series: z.array(
    z.object({
      metric: z.string(),
      unit: z.string(),
      points: z
        .array(
          z.object({
            t: time.describe('Bucket start'),
            min: z.number(),
            max: z.number(),
            avg: z.number(),
            n: int.describe('Samples in the bucket'),
          }),
        )
        .describe('Non-empty buckets by time'),
    }),
  ),
});

export const shiftTotalsSchema = z.object({
  shiftKey: z.string(),
  totals: z.array(
    z.object({
      equipment: z.string(),
      epoch: int,
      state: z.string(),
      ms: int,
      provisionalMs: int.describe('The part of `ms` in the open interval'),
    }),
  ),
});

export type Problem = z.infer<typeof problemSchema>;
export type CurrentStateDto = z.infer<typeof currentStateSchema>;
export type EquipmentDto = z.infer<typeof equipmentSchema>;
export type EquipmentList = z.infer<typeof equipmentListSchema>;
export type Clock = z.infer<typeof clockSchema>;
export type Plant = z.infer<typeof plantSchema>;
export type IntervalDto = z.infer<typeof intervalSchema>;
export type Intervals = z.infer<typeof intervalsSchema>;
export type Metrics = z.infer<typeof metricsSchema>;
export type Series = z.infer<typeof seriesSchema>;
export type ShiftTotals = z.infer<typeof shiftTotalsSchema>;

// ---- WebSocket messages (docs/api/realtime.md) ----

export const STATES_TOPIC = 'states';
const telemetryTopic = z
  .string()
  .regex(/^telemetry:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .describe('telemetry:<equipment>');
const topic = z.union([z.literal(STATES_TOPIC), telemetryTopic]);

export const clientMessageSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('subscribe'),
      topic,
      metric: metricName.optional().describe('Telemetry topics only: one metric instead of all'),
    }),
    z.strictObject({
      type: z.literal('unsubscribe'),
      topic,
      metric: metricName.optional(),
    }),
  ])
  .describe('A message from the client');

const telemetrySample = z.object({
  equipment: z.string(),
  metric: z.string(),
  unit: z.string(),
  t: time,
  value: z.number(),
});

export const serverMessageSchema = z
  .union([
    z.object({
      type: z.literal('subscribed'),
      topic: z.string(),
      metric: z.string().nullable(),
    }),
    z.object({
      type: z.literal('unsubscribed'),
      topic: z.string(),
      metric: z.string().nullable(),
    }),
    z.object({
      type: z.literal('snapshot'),
      topic: z.literal(STATES_TOPIC),
      clock: clockSchema.nullable(),
      states: z.array(z.object({ equipment: z.string(), current: currentStateSchema })),
    }),
    z.object({
      type: z.literal('snapshot'),
      topic: telemetryTopic,
      samples: z.array(telemetrySample).describe('The latest stored sample per metric'),
    }),
    z.object({ type: z.literal('state'), equipment: z.string(), current: currentStateSchema }),
    z.object({ type: z.literal('telemetry'), ...telemetrySample.shape }),
    z.object({ type: z.literal('clock'), ...clockSchema.shape }),
    z.object({
      type: z.literal('error'),
      code: z.enum([
        'invalid-message',
        'unknown-equipment',
        'too-many-subscriptions',
        'busy',
        'rate-limited',
        'unavailable',
      ]),
      detail: z.string(),
    }),
  ])
  .describe('A message from the server');

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type TelemetrySample = z.infer<typeof telemetrySample>;
