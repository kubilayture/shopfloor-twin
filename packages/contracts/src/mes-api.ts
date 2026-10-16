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
  /** Longest range of `GET /oee` with hour buckets (#120). */
  oeeHourRangeMs: 7 * 24 * 3_600_000,
  /** Longest range of `GET /oee` with shift buckets, `GET /shifts`, the downtime list and Pareto. */
  oeeShiftRangeMs: 31 * 24 * 3_600_000,
  /** Most downtime records one `GET /downtime` returns; more sets `truncated`. */
  downtimeRecords: 2_000,
  /** OEE topics (`oee:<id>`) one WebSocket client may follow. */
  oeeTopics: 16,
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
  provisional: z
    .boolean()
    .describe(
      'May still change: the piece ends after the last time settled by the machine’s own facts (the open interval, or one behind an open sequence gap); false once its epoch is closed',
    ),
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
      provisionalMs: int.describe(
        'The part of `ms` that may still change: pieces ending after the last time settled by the machine’s own facts (no open sequence gap below), in an epoch not yet closed. 0 for a completed bucket',
      ),
      revision: int.describe(
        'How often the bucket changed after it was final (a late fill after a gap incident, or a late fact of a closed epoch); 0 while unchanged. The same for every state of an (equipment, epoch)',
      ),
      incidents: int.describe(
        'Sequence-gap incidents of the machine’s device stream over the bucket’s final hours; the same for every state of an (equipment, epoch)',
      ),
    }),
  ),
});

// ---- OEE, shifts and downtime (#120, ADR-0021) ----

/** An exact ratio: the reduced fraction and its value rounded half-up to four decimals. */
export const ratioSchema = z
  .object({
    fraction: z.string().describe('Exact reduced fraction `num/den` (BigInt digits)'),
    decimal: z.string().describe('Rounded half-up to four decimals, integer arithmetic only'),
  })
  .describe('An exact ratio');

const ms = int.describe('Milliseconds of simulation time');

/**
 * `bucketOee` / `workCenterOee` of `oee-core` as JSON, the same shape as the simulator's ground
 * truth (`/ground-truth` → `oee`, sim-summary/2), so the two compare with one equality.
 */
export const oeeResultSchema = z
  .object({
    availability: ratioSchema.nullable().describe('APT / PBT; null when PBT = 0'),
    performance: ratioSchema
      .nullable()
      .describe(
        'Ideal time / APT, not clamped (P > 1 is possible per hour); null when PBT or APT is 0',
      ),
    quality: ratioSchema
      .nullable()
      .describe('good / produced (first-pass yield); null when PBT = 0 or nothing was produced'),
    oee: ratioSchema
      .nullable()
      .describe(
        '(ideal × good) / (PBT × produced); 0 when nothing was produced; null when PBT = 0 or anomaly',
      ),
    anomaly: z.boolean().describe('Cycles were counted although APT = 0'),
    provisional: z
      .boolean()
      .describe('An open Stopped interval below the threshold counts as a micro-stop for now'),
    totals: z.object({
      plannedBusyMs: ms,
      actualProductionMs: ms,
      excludedMs: ms.describe('PlannedStop, Maintenance and Off, or the whole unscheduled bucket'),
      longStopMs: ms.describe('Stopped intervals at or above the micro-stop threshold'),
      microStopMs: ms.describe('Stopped intervals below the threshold (part of APT)'),
      idealMs: ms.describe('Σ ideal cycle ms × produced count'),
      good: int,
      scrap: int,
      rework: int,
      produced: int,
    }),
    unplanned: z
      .object({ good: int, produced: int, idealMs: ms })
      .describe('Cycles of the unscheduled no-shift bucket, kept out of P and Q'),
    losses: z
      .object({
        availability: z.object({
          own: z.object({ stopped: ms, down: ms, setup: ms, idle: ms, total: ms }),
          external: z.object({ starved: ms, blocked: ms, total: ms }),
        }),
        performance: z.object({
          microStops: ms,
          speed: ms.describe('APT − micro-stops − ideal time; negative when P > 1'),
          total: ms,
        }),
        quality: ratioSchema.describe('Ideal ms × (1 − Q), exact'),
      })
      .nullable()
      .describe('Inside planned busy time, in ms; null when PBT = 0'),
  })
  .describe('OEE of one bucket (ADR-0021)');

const cycleCountSchema = z.object({
  product: z.string(),
  result: z.enum(['good', 'scrap', 'rework']),
  count: int,
});

const oeeScope = z.enum(['equipment', 'work-center']);
const oeeBucketKind = z.enum(['hour', 'shift']);
const member = z.object({ equipment: z.string(), epoch: int });

export const oeeBucketSchema = z
  .object({
    scope: oeeScope,
    id: z.string(),
    bucket: oeeBucketKind,
    key: z
      .string()
      .describe('The hour start (ISO 8601 UTC) or the shift key (`2026-10-12/A`, `no-shift`)'),
    shiftKey: z.string().describe('The shift bucket the bucket lies in'),
    start: time.describe('Start of the bucket (a no-shift bucket is clipped to the range)'),
    end: time.describe('End of the bucket (exclusive)'),
    members: z
      .array(member)
      .describe('The machines summed, each with the device epoch read (the newest by default)'),
    inputs: z.object({
      stateMs: z.record(z.string(), ms).describe('Time per state, every state (0 when absent)'),
      cycles: z.array(cycleCountSchema).describe('Cycles per product and result'),
      stops: int.describe('Stopped pieces read (each with its whole interval length)'),
    }),
    result: oeeResultSchema,
    final: z
      .boolean()
      .describe(
        'Nothing that can still arrive changes it: every hour final in equipment, both hourly aggregates refreshed through it, no Stopped interval still being classified, every member complete',
      ),
    provisionalMs: ms.describe('Time in pieces that may still change'),
    revision: int.describe('How often one of its hours changed after it was final (the highest)'),
    incidents: int.describe('Distinct sequence-gap incidents over its hours'),
  })
  .describe('OEE of one equipment or work center over one hour or shift bucket');

export const oeeListSchema = z.object({
  scope: oeeScope,
  id: z.string(),
  bucket: oeeBucketKind,
  from: time,
  to: time,
  buckets: z.array(oeeBucketSchema).describe('Buckets with data, by start'),
});

export const shiftInstanceSchema = z
  .object({
    key: z.string().describe('`date/shift`, as shift buckets are keyed'),
    date: z.string().describe('The day the shift starts (plant time zone)'),
    shift: z.string(),
    start: time,
    end: time,
    breaks: z.array(z.object({ start: time, end: time })),
  })
  .describe('One scheduled shift of the shift calendar');

export const shiftListSchema = z.object({
  from: time,
  to: time,
  shifts: z.array(shiftInstanceSchema).describe('Shifts overlapping the range, by start'),
});

export const currentShiftSchema = z.object({
  clock: clockSchema.nullable().describe('The plant clock the shift is read at'),
  shiftKey: z.string().nullable().describe('`no-shift` between shifts; null without a clock'),
  shift: shiftInstanceSchema.nullable().describe('Null between shifts or without a clock'),
});

export const shiftOeeSchema = z.object({
  shiftKey: z.string(),
  start: time,
  end: time,
  equipment: z.array(oeeBucketSchema).describe('Every machine with data, in line order'),
  workCenters: z.array(oeeBucketSchema).describe('Every work center with data'),
});

export const reasonCodesSchema = z.object({
  reasons: z
    .array(
      z.object({
        id: z.string().describe('The path in the tree, e.g. BREAKDOWN/SPINDLE-OVERLOAD'),
        parent: z.string().nullable(),
        name: z.string(),
        active: z.boolean(),
      }),
    )
    .describe('Parents before children'),
});

export const downtimeRecordSchema = z.object({
  id: z.string().describe('`{equipment}~{epoch}~{startMs}`'),
  equipment: z.string(),
  epoch: int,
  start: time.describe('The later of the interval start and its shift bucket start'),
  end: time.nullable().describe('Null while open'),
  intervalStart: time,
  shiftKey: z.string(),
  state: z.string(),
  cause: z.string().nullable(),
  loss: z.enum(['own', 'external']),
  autoReason: z.string().describe('From the auto-rules; UNCODED when none matched'),
  reason: z
    .string()
    .describe('The reason in effect: the auto reason until operator coding arrives (#121)'),
  provisional: z.boolean(),
  ms: ms.describe('Length so far (to the epoch watermark while open)'),
});

export const downtimeListSchema = z.object({
  from: time,
  to: time,
  truncated: z.boolean().describe('More records matched than one response takes'),
  records: z
    .array(downtimeRecordSchema)
    .describe('Records overlapping the range; uncoded ones first when asked, then by start'),
});

export const paretoSchema = z.object({
  scope: oeeScope,
  id: z.string(),
  from: time,
  to: time,
  members: z.array(member),
  availability: z.object({ own: ms, external: ms }),
  reasons: z
    .array(
      z.object({
        reason: z.string(),
        name: z.string(),
        loss: z.enum(['own', 'external']),
        ms: ms.describe('Clipped to the range'),
        records: int,
      }),
    )
    .describe('Availability loss by reason, largest first'),
  microStops: z
    .array(z.object({ cause: z.string().nullable(), ms, stops: int }))
    .describe('Micro-stops (performance loss) in scheduled buckets by cause, largest first'),
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
export type Ratio = z.infer<typeof ratioSchema>;
export type OeeResultDto = z.infer<typeof oeeResultSchema>;
export type OeeBucketDto = z.infer<typeof oeeBucketSchema>;
export type OeeList = z.infer<typeof oeeListSchema>;
export type ShiftInstanceDto = z.infer<typeof shiftInstanceSchema>;
export type ShiftList = z.infer<typeof shiftListSchema>;
export type CurrentShift = z.infer<typeof currentShiftSchema>;
export type ShiftOee = z.infer<typeof shiftOeeSchema>;
export type ReasonCodes = z.infer<typeof reasonCodesSchema>;
export type DowntimeRecordDto = z.infer<typeof downtimeRecordSchema>;
export type DowntimeList = z.infer<typeof downtimeListSchema>;
export type Pareto = z.infer<typeof paretoSchema>;

// ---- WebSocket messages (docs/api/realtime.md) ----

export const STATES_TOPIC = 'states';
export const DOWNTIME_TOPIC = 'downtime';
const telemetryTopic = z
  .string()
  .regex(/^telemetry:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .describe('telemetry:<equipment>');
const oeeTopic = z
  .string()
  .regex(/^oee:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .describe('oee:<equipment or work center>');
const topic = z.union([
  z.literal(STATES_TOPIC),
  z.literal(DOWNTIME_TOPIC),
  telemetryTopic,
  oeeTopic,
]);

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
    z.object({
      type: z.literal('snapshot'),
      topic: oeeTopic,
      hour: oeeBucketSchema
        .nullable()
        .describe('The hour the plant clock is in; null without data'),
      shift: oeeBucketSchema
        .nullable()
        .describe('The shift bucket the plant clock is in; null without data'),
    }),
    z.object({ type: z.literal('state'), equipment: z.string(), current: currentStateSchema }),
    z.object({
      type: z.literal('oee'),
      topic: oeeTopic,
      hour: oeeBucketSchema.nullable(),
      shift: oeeBucketSchema.nullable(),
    }),
    z.object({
      type: z.literal('downtime'),
      event: z
        .enum(['created', 'closed', 'recoded', 'updated', 'removed'])
        .describe('What happened to the record since the last message about it'),
      record: downtimeRecordSchema,
    }),
    z.object({ type: z.literal('telemetry'), ...telemetrySample.shape }),
    z.object({ type: z.literal('clock'), ...clockSchema.shape }),
    z.object({
      type: z.literal('error'),
      code: z.enum([
        'invalid-message',
        'unknown-equipment',
        'too-many-subscriptions',
        'unknown-topic',
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
