import { MES_API_LIMITS as LIMITS, identifier, metricName } from '@shopfloor/contracts';
import { z } from 'zod';

// Responses and WebSocket messages are shared with `web` through `contracts` (ADR-0020); the
// request schemas, with their transforms to parsed values, are the server's own.
export {
  ALARMS_TOPIC,
  ALARM_VIEWS,
  DOWNTIME_TOPIC,
  acknowledgeRequestSchema,
  acknowledgeResultSchema,
  alarmPointAuditSchema,
  alarmPointListSchema,
  alarmPointSchema,
  bulkAcknowledgeRequestSchema,
  bulkAcknowledgeResultSchema,
  commentRequestSchema,
  commentResultSchema,
  shelfResultSchema,
  shelveRequestSchema,
  unshelveRequestSchema,
  alarmDetailSchema,
  alarmHistorySchema,
  alarmKpiBucketSchema,
  alarmKpiListSchema,
  alarmListSchema,
  alarmOccurrenceSchema,
  alarmScopesSchema,
  badActorListSchema,
  floodListSchema,
  STATES_TOPIC,
  clientMessageSchema,
  codingRequestSchema,
  codingResultSchema,
  currentShiftSchema,
  currentStateSchema,
  downtimeAuditSchema,
  downtimeListSchema,
  downtimeRecordSchema,
  equipmentListSchema,
  equipmentSchema,
  identifier,
  intervalSchema,
  intervalsSchema,
  metricName,
  metricsSchema,
  oeeBucketSchema,
  oeeListSchema,
  oeeResultSchema,
  paretoSchema,
  plantSchema,
  problemSchema,
  reasonCodesSchema,
  serverMessageSchema,
  seriesSchema,
  shiftListSchema,
  shiftOeeSchema,
  shiftTotalsSchema,
} from '@shopfloor/contracts';
export type {
  AlarmCommentDto,
  AlarmPointDto,
  AlarmShelfDto,
  AlarmTransitionDto,
  AlarmHistory,
  AlarmKpiBucketDto,
  AlarmOccurrenceDto,
  BadActorDto,
  ClientMessage,
  FloodEpisodeDto,
  CodingResult,
  CurrentStateDto,
  DowntimeRecordDto,
  EquipmentDto,
  IntervalDto,
  OeeBucketDto,
  OeeResultDto,
  Ratio,
  ServerMessage,
  ShiftInstanceDto,
} from '@shopfloor/contracts';
export { LIMITS };

const isoTime = z.iso.datetime({ offset: true });
/** A time in a query: ISO 8601 with `Z` or an offset, parsed to a Date. */
const queryTime = isoTime.transform((value) => new Date(value));

const decimal = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/, 'expected a decimal integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const range =
  (maxMs: number) =>
  ({ from, to }: { from: unknown; to: unknown }, ctx: z.core.$RefinementCtx) => {
    // Zod runs object refinements even when a field failed; that field is already reported.
    if (!(from instanceof Date && to instanceof Date)) return;
    const span = to.getTime() - from.getTime();
    if (span <= 0) ctx.addIssue({ code: 'custom', message: '`to` must be after `from`' });
    else if (span > maxMs) {
      ctx.addIssue({
        code: 'custom',
        message: `range longer than ${String(maxMs / 86_400_000)} days`,
      });
    }
  };

/** A real calendar day: 2026-02-30 and 2026-13-45 are not. */
function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// ---- requests ----

export const noQuery = z.strictObject({});
/** Path parameters of a write route without any (`POST /alarms/ack`). */
export const noParams = z.strictObject({});
export const equipmentParams = z.strictObject({ id: identifier });
export const shiftParams = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarDate, 'no such date')
    .describe('Shift date (the day the shift starts, Istanbul)'),
  shift: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,16}$/)
    .describe('Shift id from the shift pattern, for example A'),
});

export const intervalsQuery = z
  .strictObject({
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe('End of the range (exclusive), ISO 8601; at most 7 days after `from`'),
  })
  .superRefine(range(LIMITS.intervalRangeMs));

export const telemetryQuery = z
  .strictObject({
    metric: z
      .union([metricName, z.array(metricName).min(1).max(LIMITS.metrics)])
      .optional()
      .transform((value) => (value === undefined ? undefined : [value].flat()))
      .describe('Metrics to return (repeat the parameter for several, up to 8); default: all'),
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe('End of the range (exclusive), ISO 8601; at most 31 days after `from`'),
    maxPoints: decimal(2, LIMITS.maxPoints)
      .optional()
      .transform((value) => value ?? LIMITS.defaultPoints)
      .describe('Most buckets per metric (2 to 5000, default 1000)'),
  })
  .superRefine(range(LIMITS.telemetryRangeMs));

export const shiftTotalsQuery = z.strictObject({
  equipment: identifier.optional().describe('Only this equipment'),
});

// ---- OEE, shifts and downtime (#120) ----

const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const epochParam = z
  .string()
  .regex(/^\d{1,15}$/, 'expected a decimal integer')
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
  .describe('Device epoch (run) to read; default: per machine the newest with data in the range');

const oeeScope = z
  .enum(['equipment', 'work-center'])
  .describe('An equipment, or a work center (the sums of its machines’ inputs)');

export const oeeQuery = z
  .strictObject({
    scope: oeeScope,
    id: identifier.describe('Equipment or work center id'),
    bucket: z.enum(['hour', 'shift']).describe('UTC hours, or shift buckets (whole shifts)'),
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe(
      'End of the range (exclusive), ISO 8601; at most 7 days after `from` for hours, 31 for shifts',
    ),
    epoch: epochParam.optional(),
  })
  .superRefine((query, ctx) => {
    range(query.bucket === 'hour' ? LIMITS.oeeHourRangeMs : LIMITS.oeeShiftRangeMs)(query, ctx);
  });

export const shiftOeeQuery = z.strictObject({ epoch: epochParam.optional() });

export const shiftsQuery = z
  .strictObject({
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe('End of the range (exclusive), ISO 8601; at most 31 days after `from`'),
  })
  .superRefine(range(LIMITS.oeeShiftRangeMs));

export const reasonCodesQuery = z.strictObject({
  inactive: flag.describe('Also the reasons the configuration no longer lists'),
});

export const downtimeQuery = z
  .strictObject({
    equipment: identifier.optional().describe('Only this equipment'),
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe('End of the range (exclusive), ISO 8601; at most 31 days after `from`'),
    uncoded: flag.describe('Only records with time still UNCODED (the coding screen)'),
  })
  .superRefine(range(LIMITS.oeeShiftRangeMs));

export const paretoQuery = z
  .strictObject({
    scope: oeeScope,
    id: identifier.describe('Equipment or work center id'),
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe('End of the range (exclusive), ISO 8601; at most 31 days after `from`'),
    epoch: epochParam.optional(),
  })
  .superRefine(range(LIMITS.oeeShiftRangeMs));

// ---- Downtime coding writes (#121) ----

export const downtimeParams = z.strictObject({
  id: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}~\d{1,15}~\d{1,15}$/,
      'expected {equipment}~{epoch}~{startMs}',
    )
    .describe('A downtime record id: `{equipment}~{epoch}~{startMs}`'),
});

// ---- Alarms (#142, ADR-0024) ----

const alarmScopeParam = z
  .enum(['plant', 'position', 'equipment'])
  .describe('The plant, an operator position (a set of work centers) or one equipment');
const priorityParam = z.enum(['high', 'medium', 'low']);

/** An occurrence id: `{equipment}~{epoch}~{seq}`. */
export const alarmParams = z.strictObject({
  id: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}~\d{1,15}~\d{1,15}$/,
      'expected {equipment}~{epoch}~{seq}',
    )
    .describe('An occurrence id: `{equipment}~{epoch}~{seq}` (the raise’s device seq)'),
});

/** Both ends of a range, or neither; at most `maxMs` long. */
const optionalRange =
  (maxMs: number) => (query: { from?: unknown; to?: unknown }, ctx: z.core.$RefinementCtx) => {
    if ((query.from === undefined) !== (query.to === undefined)) {
      ctx.addIssue({ code: 'custom', message: '`from` and `to` go together' });
      return;
    }
    if (query.from !== undefined) range(maxMs)({ from: query.from, to: query.to }, ctx);
  };

export const alarmListQuery = z
  .strictObject({
    view: z
      .enum(['active', 'acknowledged', 'shelved', 'history'])
      .optional()
      .transform((value) => value ?? 'active')
      .describe(
        'The operator lists (#143), a partition: active (default): not acknowledged and not closed, point not shelved (a cleared one stays until acknowledged); acknowledged: acknowledged and still active, point not shelved; shelved: not closed, point shelved; history: closed (ended and acknowledged, or ended by a newer epoch), needs a range',
      ),
    position: identifier.optional().describe('Only the equipment of this operator position'),
    equipment: identifier.optional().describe('Only this equipment'),
    priority: priorityParam.optional(),
    from: queryTime.optional().describe('Raised at or after (ISO 8601)'),
    to: queryTime.optional().describe('Raised before (ISO 8601); at most 7 days after `from`'),
    limit: decimal(1, LIMITS.alarmPageMax)
      .optional()
      .transform((value) => value ?? LIMITS.alarmPage)
      .describe('Occurrences per page (1 to 500, default 100)'),
    cursor: z
      .string()
      .regex(/^\d{1,15}~[A-Za-z0-9][A-Za-z0-9_-]{0,63}~\d{1,15}~\d{1,15}$/, 'expected `next`')
      .optional()
      .describe('`next` of the previous page'),
  })
  .superRefine((query, ctx) => {
    if (query.view === 'history' && query.from === undefined) {
      ctx.addIssue({ code: 'custom', message: 'the history needs `from` and `to`' });
    }
    optionalRange(LIMITS.alarmRangeMs)(query, ctx);
  });

const scopeId = (query: { scope: string; id?: string | undefined }, ctx: z.core.$RefinementCtx) => {
  if (query.scope !== 'plant' && query.id === undefined) {
    ctx.addIssue({ code: 'custom', message: '`id` names the position or equipment' });
  }
};

export const alarmKpiQuery = z
  .strictObject({
    scope: alarmScopeParam,
    id: identifier.optional().describe('Position or equipment id (not for the plant)'),
    bucket: z
      .enum(['hour', 'shift'])
      .describe('UTC hours, or shift buckets (shifts whole, no-shift stretches clipped)'),
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe(
      'End of the range (exclusive), ISO 8601; at most 7 days after `from` for hours, 31 for shifts',
    ),
    epoch: epochParam.optional(),
  })
  .superRefine((query, ctx) => {
    scopeId(query, ctx);
    range(query.bucket === 'hour' ? LIMITS.alarmHourRangeMs : LIMITS.oeeShiftRangeMs)(query, ctx);
  });

export const alarmRangeQuery = z
  .strictObject({
    scope: alarmScopeParam,
    id: identifier.optional().describe('Position or equipment id (not for the plant)'),
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe('End of the range (exclusive), ISO 8601; at most 31 days after `from`'),
    epoch: epochParam.optional(),
  })
  .superRefine((query, ctx) => {
    scopeId(query, ctx);
    range(LIMITS.oeeShiftRangeMs)(query, ctx);
  });

export const badActorsQuery = z
  .strictObject({
    scope: alarmScopeParam,
    id: identifier.optional().describe('Position or equipment id (not for the plant)'),
    from: queryTime.describe('Start of the range (inclusive), ISO 8601'),
    to: queryTime.describe('End of the range (exclusive), ISO 8601; at most 31 days after `from`'),
    epoch: epochParam.optional(),
    limit: decimal(1, LIMITS.badActorsMax)
      .optional()
      .transform((value) => value ?? LIMITS.badActors)
      .describe('Points to return (1 to 50, default 10)'),
  })
  .superRefine((query, ctx) => {
    scopeId(query, ctx);
    range(LIMITS.oeeShiftRangeMs)(query, ctx);
  });

// ---- Alarm writes and points (#143) ----

/** An alarm point: `/alarm-points/{equipment}/{code}`. */
export const alarmPointParams = z.strictObject({
  equipment: identifier.describe('Equipment id'),
  code: identifier.describe('Alarm code, e.g. COOLANT-PRESSURE'),
});

export const alarmPointsQuery = z.strictObject({
  equipment: identifier.optional().describe('Only this equipment'),
  position: identifier.optional().describe('Only the equipment of this operator position'),
  shelved: flag.describe('Only points shelved now'),
});
