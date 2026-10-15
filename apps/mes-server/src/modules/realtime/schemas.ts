import { MES_API_LIMITS as LIMITS, identifier, metricName } from '@shopfloor/contracts';
import { z } from 'zod';

// Responses and WebSocket messages are shared with `web` through `contracts` (ADR-0020); the
// request schemas, with their transforms to parsed values, are the server's own.
export {
  STATES_TOPIC,
  clientMessageSchema,
  currentStateSchema,
  equipmentListSchema,
  equipmentSchema,
  identifier,
  intervalSchema,
  intervalsSchema,
  metricName,
  metricsSchema,
  plantSchema,
  problemSchema,
  serverMessageSchema,
  seriesSchema,
  shiftTotalsSchema,
} from '@shopfloor/contracts';
export type {
  ClientMessage,
  CurrentStateDto,
  EquipmentDto,
  IntervalDto,
  ServerMessage,
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
