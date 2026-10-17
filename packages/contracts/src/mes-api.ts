import { z } from 'zod';
import {
  PASSWORD_LENGTH,
  PERMISSIONS,
  ROLES,
  SESSION_KINDS,
  USERNAME_PATTERN,
  passwordLength,
} from './identity.ts';
import { ORDERS_TOPIC, orderPushMessages } from './orders-api.ts';

export * from './orders-api.ts';

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
  /** Writes (#121, ADR-0023): most bytes in a request body. */
  writeBodyBytes: 16 * 1024,
  /** Segments in one coding write. */
  codingSegments: 32,
  /** Characters of a coding's comment and of `codedBy`. */
  codingComment: 500,
  codedBy: 100,
  /** The global write rate (all clients together): tokens per second and the burst. */
  writesPerSecond: 10,
  writeBurst: 20,
  /** Identity (#168, ADR-0026): each user's own write bucket, beside the global one. */
  userWritesPerSecond: 5,
  userWriteBurst: 10,
  /** Logins (#168 review): all together, and per user name; apart from the write buckets. */
  loginsPerSecond: 5,
  loginBurst: 10,
  userLoginsPerSecond: 1,
  userLoginBurst: 5,
  /** Alarm list (#142): occurrences per page, by default and at most. */
  alarmPage: 100,
  alarmPageMax: 500,
  /** Longest range of the alarm history, by raise time. */
  alarmRangeMs: 7 * 24 * 3_600_000,
  /** Longest range of `GET /alarms/kpi` with hour buckets (shift buckets: `oeeShiftRangeMs`). */
  alarmHourRangeMs: 7 * 24 * 3_600_000,
  /** Bad actors per request, by default and at most. */
  badActors: 10,
  badActorsMax: 50,
  /** Alarm KPI topics (`alarm-kpi:<scope>`) one WebSocket client may follow. */
  alarmKpiTopics: 16,
  /** Alarm writes (#143): occurrences in one bulk acknowledgement. */
  alarmAckBulk: 100,
  /** Characters of an alarm write's `actor`, a comment (and an acknowledgement's), a shelf reason. */
  alarmActor: 100,
  alarmComment: 500,
  shelveReason: 200,
  /** The shortest shelf; the longest is `maxShelveMs` of alarms.yaml. */
  minShelveMs: 60_000,
  /** Entries of one alarm point's audit. */
  alarmAudit: 500,
  /** Handover notes (#144): characters of a note's text and of its author; notes per shift. */
  noteText: 4_000,
  noteAuthor: 100,
  notesPerShift: 200,
} as const;

/**
 * Stable problem+json `type` URIs (RFC 9457) of the answers a client tells apart (#163, ADR-0023):
 * the write conflicts and refusals. A client matches on `type`, never on the `detail` prose;
 * every other problem is `about:blank` (its status says it all).
 */
export const PROBLEM_TYPES = {
  /** 409: the handover window of the shift is closed (plant time, a newer epoch, no clock). */
  handoverClosed: 'urn:shopfloor:handover-closed',
  /** 409: the shift has not begun (plant time), so its handover is not open yet. */
  handoverNotOpen: 'urn:shopfloor:handover-not-open',
  /** 409: the note's `version` sent is not its current one. */
  noteStale: 'urn:shopfloor:note-stale',
  /** 422: the shift instance already holds `notesPerShift` notes. */
  noteLimit: 'urn:shopfloor:note-limit',
  /** 409: the coding set's `version` sent is not its current one. */
  codingStale: 'urn:shopfloor:coding-stale',
  /** 409: the alarm point shelf's `version` sent is not its current one. */
  shelfStale: 'urn:shopfloor:shelf-stale',
  /** 403: the `Host` header is not in `HTTP_ALLOWED_HOSTS` (reads and writes). */
  hostNotAllowed: 'urn:shopfloor:host-not-allowed',
  /** 403: a write without an `Origin`, from another origin, or with `Sec-Fetch-Site` not same-origin. */
  writeOrigin: 'urn:shopfloor:write-origin',
  /** 405: writes are turned off (`MES_WRITES=off`). */
  writesOff: 'urn:shopfloor:writes-off',
  /** 415: a write that is not application/json. */
  writeNotJson: 'urn:shopfloor:write-not-json',
  /** 429: the global or the user's write rate limit; retry after `Retry-After` seconds. */
  writeRate: 'urn:shopfloor:write-rate',
  /**
   * 401 (#168, ADR-0026): no session, or one that ended or expired; also a failed login (the same
   * answer whatever failed).
   */
  unauthenticated: 'urn:shopfloor:unauthenticated',
  /** 403: the session's roles lack the route's permission. */
  forbidden: 'urn:shopfloor:forbidden',
  /** 403: the user must change the password first (only the session and password routes answer). */
  passwordChangeRequired: 'urn:shopfloor:password-change-required',
  /**
   * 422: a new password shorter or longer than allowed or equal to the current one, or a wrong
   * current password in a password change.
   */
  passwordRejected: 'urn:shopfloor:password-rejected',
  /** 409: a user with that name exists. */
  userExists: 'urn:shopfloor:user-exists',
  /** 429: too many logins, all together or for one user name; retry after `Retry-After` seconds. */
  loginRate: 'urn:shopfloor:login-rate',
  /** 409 (#174): the order's `version` sent is not its current one. */
  orderStale: 'urn:shopfloor:order-stale',
  /** 409: the order's status doesn't allow the write (release of a dispatched order, …). */
  orderState: 'urn:shopfloor:order-state',
  /**
   * 409: a re-dispatch while an earlier command of the order is not settled (no final answer, and
   * the CNC's facts have not reached its `seqAfterExpiry`), ADR-0029.
   */
  commandsUnsettled: 'urn:shopfloor:commands-unsettled',
} as const;

export type ProblemType = (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES];

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A reason code id: its path in the tree, e.g. BREAKDOWN/SPINDLE-OVERLOAD. */
const REASON_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}){0,7}$/;

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
    type: z
      .string()
      .describe(
        `about:blank (the status says it all), or a stable URI a client tells apart: ${Object.values(PROBLEM_TYPES).join(', ')}`,
      ),
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

export const codingSchema = z
  .object({
    from: time,
    to: time,
    reason: z.string().describe('A reason code id'),
    comment: z.string(),
    codedBy: z
      .string()
      .describe('The user name from the session, or (MES_AUTH=off) the name as typed'),
    codedAt: time.describe('Wall time of the write'),
    version: int.describe("The coding set's version it was written at"),
  })
  .describe('An operator coding: a time range of a record with a reason (#121)');

export const reasonSegmentSchema = z
  .object({
    from: time,
    to: time,
    reason: z.string(),
    coded: z.boolean().describe('Coded by an operator; otherwise the auto reason'),
  })
  .describe('A stretch of a record with the reason in effect there');

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
    .describe(
      'The reason in effect over most of the record: codings where they lie, the auto reason elsewhere (#121)',
    ),
  provisional: z.boolean(),
  ms: ms.describe('Length so far (to the epoch watermark while open)'),
  segments: z
    .array(reasonSegmentSchema)
    .describe('The reasons in effect over the record (to the watermark while open), by time'),
  codings: z.array(codingSchema).describe('Operator codings inside the record, by time'),
  uncoded: z.boolean().describe('Some of its time is still UNCODED'),
  version: int.describe(
    "The version of its (equipment, epoch)'s coding set: send it with a coding write",
  ),
});

export const downtimeListSchema = z.object({
  from: time,
  to: time,
  truncated: z.boolean().describe('More records matched than one response takes'),
  records: z
    .array(downtimeRecordSchema)
    .describe('Records overlapping the range: UNCODED ones first, then by start'),
});

// ---- Downtime coding writes (#121, ADR-0023) ----

/** A time in a request body: ISO 8601 with `Z` or an offset. */
const bodyTime = z.iso.datetime({ offset: true });

export const codingRequestSchema = z
  .strictObject({
    segments: z
      .array(
        z.strictObject({
          from: bodyTime.describe('Start (inclusive), inside the record'),
          to: bodyTime.describe(
            'End (exclusive), inside the record (an open one: up to its watermark)',
          ),
          reason: z.string().regex(REASON_ID).describe('An active reason code id, not UNCODED'),
          comment: z.string().max(MES_API_LIMITS.codingComment).optional(),
        }),
      )
      .max(MES_API_LIMITS.codingSegments)
      .describe(
        'Non-overlapping ranges inside the record; empty clears its codings. A split is two',
      ),
    codedBy: z
      .string()
      .trim()
      .min(1)
      .max(MES_API_LIMITS.codedBy)
      .optional()
      .describe(
        'Who codes, as typed, recorded as unauthenticated: only with MES_AUTH=off (until #170): with a session the user is taken from it and this is ignored',
      ),
    version: int.min(0).describe("The record's `version` as read: 409 when the set moved on"),
  })
  .describe('Replaces the codings of one downtime record');

export const codingResultSchema = z.object({
  record: downtimeRecordSchema,
  version: int.describe("The coding set's new version"),
});

const auditCodingSchema = z.object({
  from: time,
  to: time,
  reason: z.string(),
  comment: z.string(),
  codedBy: z.string(),
  codedAt: time,
  orphaned: z
    .boolean()
    .optional()
    .describe('After a clip: true for the part left outside every loss interval'),
});

export const downtimeAuditSchema = z.object({
  record: z.string().describe('The record id asked for'),
  entries: z
    .array(
      z.object({
        id: int,
        recordId: z.string().nullable().describe('The record written to; null for a clip'),
        from: time,
        to: time.nullable(),
        action: z
          .enum(['coded', 'cleared', 'orphaned'])
          .describe('A write, a write with no segments, or a clip after a re-cut'),
        before: z.array(auditCodingSchema),
        after: z.array(auditCodingSchema),
        actor: z.string().describe("The user name, the name as typed, or 'system' for a clip"),
        authenticated: z.boolean().describe('True when the actor came from a session (#169)'),
        at: time.describe('Wall time'),
        requestId: z.string().nullable(),
        version: int.describe("The coding set's version after the change"),
      }),
    )
    .describe('Newest first: entries of the record and of codings that lay in its time'),
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

// ---- Alarms (#142, ADR-0024) ----

const priority = z.enum(['high', 'medium', 'low']);
const alarmScope = z.enum(['plant', 'position', 'equipment']);
const alarmBucketKind = z.enum(['hour', 'shift']);
export const ALARM_VIEWS = ['active', 'acknowledged', 'shelved', 'history'] as const;
const alarmView = z.enum(ALARM_VIEWS);
export const ALARM_STATES = [
  'unacked-active',
  'acked-active',
  'unacked-cleared',
  'closed',
] as const;
const alarmState = z.enum(ALARM_STATES);
const alarmActor = z
  .string()
  .trim()
  .min(1)
  .max(MES_API_LIMITS.alarmActor)
  .optional()
  .describe(
    'Who acts, as typed, recorded as unauthenticated: only with MES_AUTH=off (until #170): with a session the user is taken from it and this is ignored',
  );
const occurrenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}~\d{1,15}~\d{1,15}$/;

export const acknowledgementSchema = z.object({
  by: z.string().describe('The user name from the session, or (MES_AUTH=off) the name as typed'),
  at: time.describe('Wall time'),
  plantAt: time.nullable().describe('The plant clock at that moment; null without one'),
  comment: z.string(),
});

export const alarmCommentSchema = z.object({
  id: int,
  text: z.string(),
  actor: z.string().describe('The user name from the session, or (MES_AUTH=off) as typed'),
  authenticated: z.boolean().describe('True when the actor came from a session (#169)'),
  at: time.describe('Wall time'),
  plantAt: time.nullable().describe('The plant clock at that moment'),
  requestId: z.string().nullable(),
});

export const alarmShelfSchema = z
  .object({
    shelved: z.boolean(),
    version: int.describe("The shelf's version: send it with shelve or unshelve (409 if moved)"),
    by: z.string().nullable(),
    reason: z.string().nullable(),
    shelvedAt: time.nullable().describe('Wall time of the shelve'),
    epoch: int.nullable().describe("The plant clock's epoch at the shelve"),
    plantAt: time.nullable().describe('The plant clock at the shelve'),
    until: time
      .nullable()
      .describe('Plant time: the point unshelves itself once the plant clock passes it'),
    durationMs: int.nullable(),
  })
  .describe('The shelf of an alarm point (ISA-18.2 shelves a point, not an occurrence)');

export const alarmOccurrenceSchema = z
  .object({
    id: z
      .string()
      .describe('`{equipment}~{epoch}~{seq}`: stable under reordering, rebuilds and restarts'),
    equipment: z.string(),
    epoch: int.describe('The device epoch (run)'),
    seq: int.describe('The device sequence number of the raise'),
    code: z.string(),
    priority: priority.describe(
      "From the point's definition, or from the severity for a code without one",
    ),
    defined: z.boolean().describe('False for a code without a definition in alarms.yaml'),
    text: z.string().nullable().describe("The definition's operator text"),
    severity: int.describe('The wire severity of the raise, 1 to 1000'),
    source: z
      .enum(['fact', 'anchor'])
      .describe('The raise fact, or a retained alarm delivery whose fact is not stored'),
    raisedAt: time,
    endedAt: time.nullable().describe('When it stopped being active; null while active'),
    endReason: z
      .enum(['cleared', 'lost', 'superseded', 'epoch-ended'])
      .nullable()
      .describe(
        'cleared: the device clear; lost: a resync snapshot showed it inactive (the clear was lost); superseded: the next raise of the point (a lost clear); epoch-ended: a newer run',
      ),
    endSeq: int
      .nullable()
      .describe("The clear's seq, the snapshot's asOfSeq or the superseding raise's seq"),
    active: z.boolean(),
    final: z
      .boolean()
      .describe('Its raise and its end (or that it is still open) can no longer change'),
    state: alarmState.describe(
      'ISA-18.2 (#143): a clear does not acknowledge, so a cleared occurrence stays unacked-cleared until acknowledged; closed: ended and acknowledged, or ended by a newer epoch',
    ),
    acknowledged: acknowledgementSchema.nullable(),
    shelved: z
      .boolean()
      .describe('Its point is shelved now: an overlay, the state is kept; KPIs count it anyway'),
    comments: int.describe('Comments on it (GET /alarms/{id} lists them)'),
  })
  .describe('One alarm occurrence: one per device raise (ADR-0024)');

export const alarmListSchema = z.object({
  view: alarmView,
  from: time.nullable(),
  to: time.nullable(),
  next: z
    .string()
    .nullable()
    .describe('Pass as `cursor` for the following page; null on the last page'),
  alarms: z.array(alarmOccurrenceSchema).describe('By raise time, newest first'),
});

export const alarmDetailSchema = z.object({
  occurrence: alarmOccurrenceSchema,
  definition: z
    .object({
      text: z.string(),
      consequence: z.string().nullable(),
      response: z.string().nullable(),
    })
    .nullable(),
  shelf: alarmShelfSchema.describe("Its point's shelf now"),
  comments: z.array(alarmCommentSchema).describe('Oldest first'),
});

export const alarmHistorySchema = z.object({
  id: z.string(),
  entries: z
    .array(
      z.object({
        source: z
          .enum(['fact', 'anchor', 'snapshot', 'mes', 'audit'])
          .describe(
            'A device fact, a retained delivery, a resync snapshot, the MES deriving it, or an entry of the audit (alarms.alarm_transition, #143)',
          ),
        transition: z.enum([
          'raised',
          'cleared',
          'lost',
          'superseded',
          'epoch-ended',
          'ack',
          'comment',
          'shelve',
          'unshelve',
          'expire',
        ]),
        at: time.describe(
          'Simulation (plant) time; for an audit entry the plant clock at the transition',
        ),
        seq: int.nullable(),
        receivedAt: time.nullable().describe('When the gateway received the fact'),
        protocol: z.string().nullable(),
        actor: z.string().nullable().describe("Audit entries: as typed, or 'system'"),
        authenticated: z.boolean().nullable().describe('Audit entries: always false (Phase 7)'),
        recordedAt: time.nullable().describe('Audit entries: wall time'),
        requestId: z.string().nullable().describe('Audit entries: the X-Request-Id of the write'),
        auditId: int.nullable(),
        detail: z
          .record(z.string(), z.unknown())
          .nullable()
          .describe('Audit entries: the state after (comment text, shelf)'),
      }),
    )
    .describe(
      "By time: the device raise and end, the occurrence's acknowledgement and comments, and its point's shelf transitions while it was active",
    ),
});

const bucketFloodSchema = z.object({
  id: z.string().describe('`{startAt ms}~{equipment}~{code}` of the starting raise, per scope'),
  startAt: time,
  floodMs: ms.describe('Flood time inside the bucket'),
  peak: int.describe("The highest count from the episode's start to the bucket's end"),
  open: z.boolean().describe("Still in flood at the bucket's end"),
  ended: z
    .object({ endAt: time, peak: int, raises: int })
    .nullable()
    .describe('The final attributes, in the bucket where the episode ends'),
});

export const alarmKpiBucketSchema = z
  .object({
    scope: alarmScope,
    id: z.string(),
    bucket: alarmBucketKind,
    key: z
      .string()
      .describe(
        'The hour start (ISO 8601 UTC) or the shift key (`2026-10-12/A`, `no-shift/{start}`)',
      ),
    epoch: int,
    from: time,
    to: time,
    raises: int,
    byPriority: z.object({ high: int, medium: int, low: int }),
    averageRate: ratioSchema.describe('Raises per window (10 minutes) over the whole bucket'),
    windows: int.describe('Fixed windows aligned on the hour'),
    peak10: int.describe('The most raises in one fixed window'),
    floodWindows: int.describe('Fixed windows with more than floodThreshold raises'),
    floods: z.array(bucketFloodSchema).describe('Sliding flood episodes in flood in the bucket'),
    floodMs: ms,
    activeAtEnd: int,
    standing: z
      .array(z.object({ id: z.string(), equipment: z.string(), code: z.string(), raisedAt: time }))
      .describe("Active at the bucket's end and raised at least standingMs before it"),
    chatteringRaises: int,
    chatteringPoints: z.array(z.string()).describe('`equipment/code`, sorted'),
    fleeting: int,
    fleetingUndecided: int,
    activeMs: ms,
    provisional: z
      .boolean()
      .describe('Not over at the plant clock, or a raise may still turn out fleeting'),
    final: z
      .boolean()
      .describe(
        'Nothing that can still arrive changes it: every equipment of the scope is final through its end plus fleetingMs',
      ),
    revision: int.describe('How often one of its hours changed after it was final (the highest)'),
    incidents: int.describe('Distinct sequence-gap incidents of its equipment over it'),
  })
  .describe('Alarm KPIs of one scope over one hour or shift bucket (ADR-0024)');

export const alarmKpiListSchema = z.object({
  scope: alarmScope,
  id: z.string(),
  bucket: alarmBucketKind,
  from: time,
  to: time,
  buckets: z
    .array(alarmKpiBucketSchema)
    .describe('Hours where something happened and the hour in progress; every shift bucket begun'),
});

export const floodEpisodeSchema = z.object({
  id: z.string(),
  startAt: time,
  equipment: z.string().describe("The starting raise's equipment"),
  code: z.string(),
  endAt: time.nullable().describe('Null while in flood'),
  peak: int,
  raises: int.describe('Raises from the starting raise until the end, so far'),
});

export const floodListSchema = z.object({
  scope: alarmScope,
  id: z.string(),
  from: time,
  to: time,
  epoch: int.nullable(),
  episodes: z.array(floodEpisodeSchema).describe('In flood at some instant of the range, by start'),
});

export const badActorSchema = z.object({
  equipment: z.string(),
  code: z.string(),
  raises: int,
  share: ratioSchema.describe("Of the scope's raises in the range"),
  activeMs: ms,
  chatteringRaises: int,
});

export const badActorListSchema = z.object({
  scope: alarmScope,
  id: z.string(),
  from: time,
  to: time,
  epoch: int.nullable(),
  actors: z
    .array(badActorSchema)
    .describe('By raises, then active time descending, then equipment and code'),
});

export const alarmScopesSchema = z.object({
  scopes: z.array(
    z.object({
      scope: alarmScope,
      id: z.string(),
      name: z.string(),
      equipment: z.array(z.string()),
    }),
  ),
});

const positiveInt = int.min(1);

export const alarmConfigSchema = z
  .object({
    maxShelveMs: positiveInt.describe(
      'The longest shelf, in plant time (a longer one is 422); the shortest is `minShelveMs`',
    ),
    minShelveMs: positiveInt.describe('The shortest shelf (MES_API_LIMITS.minShelveMs)'),
    kpi: z
      .object({
        floodThreshold: positiveInt.describe('A flood is more than this many raises in one window'),
        windowMs: positiveInt.describe(
          'The window of the rate and flood measures (`averageRate` is per window); it divides an hour',
        ),
        chatterCount: positiveInt.describe(
          'A raise is chattering when its point raised at least this often in `chatterWindowMs`',
        ),
        chatterWindowMs: positiveInt,
        fleetingMs: positiveInt.describe(
          'An occurrence that clears less than this after its raise is fleeting',
        ),
        standingMs: positiveInt.describe(
          'An occurrence active at a bucket’s end and raised at least this long before it is standing',
        ),
      })
      .describe('The KPI thresholds alarm-core computes with (ISA-18.2, EEMUA 191)'),
    benchmarks: z
      .object({
        acceptablePer10Min: positiveInt.describe('Average raises per 10 minutes still acceptable'),
        manageablePer10Min: positiveInt.describe(
          'Average raises per 10 minutes at most manageable (≥ acceptablePer10Min)',
        ),
        floodWindowsPercent: int
          .min(0)
          .max(100)
          .describe('Windows in flood, at most this percentage'),
        topTenSharePercent: int
          .min(0)
          .max(100)
          .describe('The top 10 points’ share of the raises, at most this percentage'),
      })
      .describe('Benchmarks for colouring only; no KPI depends on them'),
  })
  .describe('The alarm configuration of config/plant/alarms.yaml that a client shows (#160)');

export const alarmPointSchema = z
  .object({
    equipment: z.string(),
    code: z.string(),
    defined: z.boolean().describe('It has a definition in alarms.yaml'),
    priority: priority.nullable().describe('From the definition; null without one'),
    text: z.string().nullable(),
    shelf: alarmShelfSchema,
    activeOccurrence: z
      .string()
      .nullable()
      .describe('The id of its occurrence still active (device), if any'),
  })
  .describe('An alarm point (equipment, code): its definition, shelf and active occurrence');

export const alarmPointListSchema = z.object({
  points: z
    .array(alarmPointSchema)
    .describe(
      'Every defined point, and every other point with an active occurrence or a shelf, by equipment and code',
    ),
});

/** An occurrence id in a request body. */
const occurrenceIdBody = z
  .string()
  .regex(occurrenceIdPattern, 'expected {equipment}~{epoch}~{seq}');

export const acknowledgeRequestSchema = z
  .strictObject({
    actor: alarmActor,
    comment: z.string().max(MES_API_LIMITS.alarmComment).optional(),
  })
  .describe('Acknowledges one occurrence (monotonic: no version)');

export const bulkAcknowledgeRequestSchema = z
  .strictObject({
    ids: z
      .array(occurrenceIdBody)
      .min(1)
      .max(MES_API_LIMITS.alarmAckBulk)
      .describe('Occurrence ids (at most 100); an unknown one is 404 and nothing changes'),
    actor: alarmActor,
    comment: z.string().max(MES_API_LIMITS.alarmComment).optional(),
  })
  .describe('Acknowledges up to 100 occurrences in one transaction');

export const acknowledgeResultSchema = z.object({
  occurrence: alarmOccurrenceSchema,
  changed: z.boolean().describe('False: it was acknowledged already (no audit entry)'),
});

export const bulkAcknowledgeResultSchema = z.object({
  results: z
    .array(z.object({ id: z.string(), changed: z.boolean() }))
    .describe('Per distinct id, in request order'),
  acknowledged: int.describe('How many this request acknowledged (audited)'),
});

export const commentRequestSchema = z
  .strictObject({
    actor: alarmActor,
    text: z.string().trim().min(1).max(MES_API_LIMITS.alarmComment),
  })
  .describe('Adds a comment to an occurrence (append-only: no version)');

export const commentResultSchema = z.object({
  comment: alarmCommentSchema,
  occurrence: alarmOccurrenceSchema,
});

export const shelveRequestSchema = z
  .strictObject({
    actor: alarmActor,
    reason: z.string().trim().min(1).max(MES_API_LIMITS.shelveReason),
    durationMs: int
      .min(MES_API_LIMITS.minShelveMs)
      .max(Number.MAX_SAFE_INTEGER)
      .describe('Plant time, 1 minute to maxShelveMs of alarms.yaml (8 hours): longer is 422'),
    version: int.min(0).describe("The shelf's `version` as read: 409 when it moved on"),
  })
  .describe('Shelves an alarm point (or changes its shelf) for a duration of plant time');

export const unshelveRequestSchema = z
  .strictObject({
    actor: alarmActor,
    version: int.min(0).describe("The shelf's `version` as read: 409 when it moved on"),
  })
  .describe('Unshelves an alarm point');

export const shelfResultSchema = z.object({ point: alarmPointSchema });

export const alarmTransitionSchema = z.object({
  id: int,
  equipment: z.string(),
  code: z.string(),
  occurrence: z.string().nullable().describe('The occurrence id for ack and comment'),
  action: z
    .enum(['ack', 'comment', 'shelve', 'unshelve', 'expire', 'epoch-ended'])
    .describe(
      'expire: the plant-time limit passed; epoch-ended: a newer plant epoch ended the shelf',
    ),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  actor: z.string().describe("The user name, the name as typed, or 'system' (expire, epoch-ended)"),
  authenticated: z.boolean().describe('True when the actor came from a session (#169)'),
  at: time.describe('Wall time'),
  plantAt: time.nullable().describe('The plant clock at the transition (expire: the `until`)'),
  plantEpoch: int.nullable(),
  requestId: z.string().nullable(),
  version: int.nullable().describe("The shelf's version after a point action"),
});

export const alarmPointAuditSchema = z.object({
  equipment: z.string(),
  code: z.string(),
  entries: z
    .array(alarmTransitionSchema)
    .describe(
      "Newest first, at most 500: the point's shelf transitions and its occurrences' acknowledgements and comments",
    ),
});

export const operatorBucketSchema = z
  .object({
    key: z
      .string()
      .describe('The hour start, the shift key (`2026-10-12/A`, `no-shift/{start}`) or `range`'),
    from: time,
    to: time,
    raises: int.describe('Raises in the bucket, as the KPIs count them'),
    shelvedRaises: int.describe('Raises while their point was shelved'),
    annunciatedRaises: int.describe('Raises while their point was not shelved'),
    timeToAck: z
      .object({
        count: int,
        sumMs: ms,
        maxMs: ms.nullable(),
      })
      .describe(
        "Plant time from raise to acknowledgement of the raises in the bucket acknowledged in the same epoch (exact integers: the mean is sumMs / count). Counted in the raise's bucket: a later acknowledgement still changes it after the bucket is over (provisional: false)",
      ),
    unacknowledgedAtEnd: int.describe(
      "Occurrences raised before the bucket's end (or the plant clock) not acknowledged in this epoch by then, whatever their device state: shelved ones and cleared ones never acknowledged count too; one ended by a newer epoch by then is closed and does not. Fixed once the bucket is over",
    ),
    shelvedMs: z
      .array(z.object({ equipment: z.string(), code: z.string(), ms }))
      .describe('Shelved time per point inside the bucket, up to the plant clock'),
    provisional: z
      .boolean()
      .describe(
        'The bucket is not over at the plant clock. False does not settle timeToAck: a late acknowledgement of a raise in the bucket still adds to it',
      ),
  })
  .describe('Operator measures of one bucket (MES only, not reconciled; #143)');

export const operatorKpiListSchema = z.object({
  scope: alarmScope,
  id: z.string(),
  bucket: z.enum(['hour', 'shift', 'range']),
  from: time,
  to: time,
  epoch: int.nullable(),
  buckets: z.array(operatorBucketSchema).describe('Every bucket begun by the plant clock'),
});

export type OperatorBucketDto = z.infer<typeof operatorBucketSchema>;
export type OperatorKpiList = z.infer<typeof operatorKpiListSchema>;

// ---- Shifts: instances, report and handover notes (#144, ADR-0025) ----

const shiftStatus = z
  .enum(['running', 'ended', 'final'])
  .describe(
    'running: the plant clock is inside it; ended: past its end (or a newer epoch began); final: the report’s inputs are final (never goes back)',
  );

export const shiftRecordSchema = z
  .object({
    key: z.string().describe('`date/shift`'),
    date: z.string(),
    shift: z.string(),
    epoch: int.describe('The plant epoch (the simulator run every device shares, ADR-0015)'),
    start: time,
    end: time,
    breaks: z.array(z.object({ start: time, end: time })),
    status: shiftStatus,
    final: z.boolean().describe('The report is final (status final)'),
    finalAt: time.nullable().describe('Wall time the report became final'),
    revision: z
      .object({
        inputs: int.describe(
          'Starts at 0 when the report becomes final; +1 per revision of an input after that (an OEE hour of a machine, an alarm KPI hour of a scope)',
        ),
        content: int.describe(
          '+1 per handover note create or edit; once final, +1 per operator recode inside the shift (recoding never changes OEE, only the downtime section) and per acknowledgement of an alarm raised in it (its time to acknowledge)',
        ),
        contentAtFinal: int
          .nullable()
          .describe(
            '`content` at the moment the report became final, stored with `finalAt` under the row lock (#163); null until final. `content - contentAtFinal` is how often the content changed after final',
          ),
      })
      .describe('The composite revision (ADR-0025): both stored counters'),
  })
  .describe('One shift instance: a scheduled shift the plant clock entered, per plant epoch');

export const NOTE_CATEGORIES = ['safety', 'quality', 'equipment', 'material', 'general'] as const;
const noteCategory = z.enum(NOTE_CATEGORIES);

const noteContentSchema = z.object({
  category: noteCategory,
  text: z.string(),
  retracted: z.boolean(),
});

export const handoverNoteSchema = z
  .object({
    id: int,
    epoch: int,
    shiftKey: z.string(),
    category: noteCategory,
    text: z.string(),
    retracted: z.boolean().describe('A wrong note is retracted, never deleted'),
    createdBy: z.string().describe('The user name, or (MES_AUTH=off) the name as typed'),
    author: z.string().describe('Who wrote the current version: user name, or as typed'),
    version: int.describe('1 when created, +1 per edit: send it with an edit (409 when stale)'),
    createdAt: time.describe('Wall time'),
    createdPlantAt: time.describe('Plant time (the epoch’s clock)'),
    updatedAt: time.describe('Wall time of the latest version'),
    updatedPlantAt: time,
  })
  .describe('A handover note of one shift instance (#144)');

export const handoverAuditEntrySchema = z.object({
  id: int,
  noteId: int,
  action: z.enum(['created', 'edited']),
  before: noteContentSchema.nullable().describe('Null for a create'),
  after: noteContentSchema,
  actor: z.string().describe('The author: the user name, or (MES_AUTH=off) as typed'),
  authenticated: z.boolean().describe('True when the actor came from a session (#169)'),
  at: time.describe('Wall time'),
  plantAt: time.describe('Plant time'),
  requestId: z.string().nullable(),
  version: int.describe("The note's version after the change"),
});

const noteWithHistorySchema = z.object({
  note: handoverNoteSchema,
  history: z.array(handoverAuditEntrySchema).describe('Every version, newest first'),
});

export const handoverNotesSchema = z.object({
  shiftKey: z.string(),
  epoch: int,
  notes: z.array(noteWithHistorySchema).describe('By creation'),
});

export const noteCreateSchema = z
  .strictObject({
    author: z
      .string()
      .trim()
      .min(1)
      .max(MES_API_LIMITS.noteAuthor)
      .optional()
      .describe(
        'Who writes, as typed, recorded as unauthenticated: only with MES_AUTH=off (until #170): with a session the user is taken from it and this is ignored',
      ),
    text: z.string().trim().min(1).max(MES_API_LIMITS.noteText),
    category: noteCategory,
  })
  .describe('A new handover note');

export const noteEditSchema = z
  .strictObject({
    author: noteCreateSchema.shape.author,
    text: noteCreateSchema.shape.text,
    category: noteCategory,
    retracted: z.boolean().describe('Retract (or restore) the note; it stays in the history'),
    version: int.min(1).describe("The note's `version` as read: 409 when it moved on"),
  })
  .describe('A new version of a handover note');

export const noteResultSchema = z.object({
  note: handoverNoteSchema,
  shift: shiftRecordSchema.describe('The instance after the write (its content revision rose)'),
});

export const handoverAuditSchema = z.object({
  note: int,
  entries: z.array(handoverAuditEntrySchema).describe('Newest first'),
});

export const shiftReportSchema = z
  .object({
    ...shiftRecordSchema.shape,
    incidents: int.describe('The most sequence-gap incidents of one of its OEE or alarm buckets'),
    asOf: time.nullable().describe('The plant clock of the epoch when the report was computed'),
    generatedAt: time.describe('Wall time the report was computed (for the printout)'),
    oee: shiftOeeSchema.describe('Exactly the body of GET /shifts/{date}/{shift}/oee'),
    downtime: z.object({
      availability: z.object({ own: ms, external: ms }).describe('Equal to the OEE losses'),
      reasons: paretoSchema.shape.reasons,
      microStops: paretoSchema.shape.microStops,
      records: int.describe('Downtime records of the shift'),
      uncodedMs: ms.describe('Time still UNCODED'),
      longest: z
        .array(downtimeRecordSchema)
        .describe('The ten longest records with the reasons in effect, longest first'),
    }),
    production: z.object({
      machines: z
        .array(
          z.object({
            equipment: z.string(),
            produced: int,
            good: int,
            scrap: int,
            rework: int,
            cycles: z.array(cycleCountSchema),
          }),
        )
        .describe('From the OEE inputs, in line order'),
      finished: z
        .object({ equipment: z.string().nullable(), good: int })
        .describe('Finished parts: good cycles of the line’s last machine'),
      scrap: int.describe('Scrap cycles of every machine'),
    }),
    alarms: z.object({
      scopes: z
        .array(
          z.object({
            scope: alarmScope,
            id: z.string(),
            name: z.string(),
            kpis: alarmKpiBucketSchema
              .nullable()
              .describe('The KPIs of the shift bucket (equal to GET /alarms/kpi)'),
            badActors: z.array(badActorSchema).describe('The top 5 of the shift'),
            operator: operatorBucketSchema
              .nullable()
              .describe(
                'MES-only operator figures of the shift bucket (equal to GET /alarms/operator-kpi): shelved and annunciated raises, time to acknowledge, unacknowledged at the end, shelved time per point. Not reconciled with the ground truth, and no input of `final`; an acknowledgement after final raises `revision.content`',
              ),
          }),
        )
        .describe('The plant and every operator position'),
    }),
    notes: z.array(noteWithHistorySchema),
  })
  .describe(
    'The shift report (ADR-0025), computed on read: final when its inputs are, with the composite revision',
  );

export type ShiftRecordDto = z.infer<typeof shiftRecordSchema>;
export type HandoverNoteDto = z.infer<typeof handoverNoteSchema>;
export type HandoverAuditEntryDto = z.infer<typeof handoverAuditEntrySchema>;
export type HandoverNotes = z.infer<typeof handoverNotesSchema>;
export type NoteCreate = z.input<typeof noteCreateSchema>;
export type NoteEdit = z.input<typeof noteEditSchema>;
export type NoteResult = z.infer<typeof noteResultSchema>;
export type HandoverAudit = z.infer<typeof handoverAuditSchema>;
export type ShiftReportDto = z.infer<typeof shiftReportSchema>;

export type AlarmOccurrenceDto = z.infer<typeof alarmOccurrenceSchema>;
export type AlarmShelfDto = z.infer<typeof alarmShelfSchema>;
export type AlarmCommentDto = z.infer<typeof alarmCommentSchema>;
export type AlarmPointDto = z.infer<typeof alarmPointSchema>;
export type AlarmPointList = z.infer<typeof alarmPointListSchema>;
export type AlarmTransitionDto = z.infer<typeof alarmTransitionSchema>;
export type AlarmPointAudit = z.infer<typeof alarmPointAuditSchema>;
export type AcknowledgeRequest = z.input<typeof acknowledgeRequestSchema>;
export type BulkAcknowledgeRequest = z.input<typeof bulkAcknowledgeRequestSchema>;
export type AcknowledgeResult = z.infer<typeof acknowledgeResultSchema>;
export type BulkAcknowledgeResult = z.infer<typeof bulkAcknowledgeResultSchema>;
export type CommentRequest = z.input<typeof commentRequestSchema>;
export type CommentResult = z.infer<typeof commentResultSchema>;
export type ShelveRequest = z.input<typeof shelveRequestSchema>;
export type UnshelveRequest = z.input<typeof unshelveRequestSchema>;
export type ShelfResult = z.infer<typeof shelfResultSchema>;
export type AlarmList = z.infer<typeof alarmListSchema>;
export type AlarmDetail = z.infer<typeof alarmDetailSchema>;
export type AlarmHistory = z.infer<typeof alarmHistorySchema>;
export type AlarmKpiBucketDto = z.infer<typeof alarmKpiBucketSchema>;
export type AlarmKpiList = z.infer<typeof alarmKpiListSchema>;
export type FloodEpisodeDto = z.infer<typeof floodEpisodeSchema>;
export type FloodList = z.infer<typeof floodListSchema>;
export type BadActorDto = z.infer<typeof badActorSchema>;
export type BadActorList = z.infer<typeof badActorListSchema>;
export type AlarmScopes = z.infer<typeof alarmScopesSchema>;
export type AlarmConfig = z.infer<typeof alarmConfigSchema>;

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
export type CodingDto = z.infer<typeof codingSchema>;
export type ReasonSegmentDto = z.infer<typeof reasonSegmentSchema>;
export type CodingRequest = z.input<typeof codingRequestSchema>;
export type CodingResult = z.infer<typeof codingResultSchema>;
export type DowntimeAudit = z.infer<typeof downtimeAuditSchema>;

// ---- WebSocket messages (docs/api/realtime.md) ----

export const STATES_TOPIC = 'states';
export const DOWNTIME_TOPIC = 'downtime';
export const ALARMS_TOPIC = 'alarms';
export const SHIFTS_TOPIC = 'shifts';
const telemetryTopic = z
  .string()
  .regex(/^telemetry:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .describe('telemetry:<equipment>');
const oeeTopic = z
  .string()
  .regex(/^oee:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .describe('oee:<equipment or work center>');
const alarmKpiTopic = z
  .string()
  .regex(/^alarm-kpi:(plant|(position|equipment):[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/)
  .describe('alarm-kpi:plant, alarm-kpi:position:<id> or alarm-kpi:equipment:<id>');
const topic = z.union([
  z.literal(STATES_TOPIC),
  z.literal(DOWNTIME_TOPIC),
  z.literal(ALARMS_TOPIC),
  z.literal(SHIFTS_TOPIC),
  z.literal(ORDERS_TOPIC),
  telemetryTopic,
  oeeTopic,
  alarmKpiTopic,
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
    z.object({
      type: z.literal('snapshot'),
      topic: alarmKpiTopic,
      hour: alarmKpiBucketSchema
        .nullable()
        .describe('The hour the plant clock is in; null without a clock'),
      shift: alarmKpiBucketSchema
        .nullable()
        .describe('The shift bucket the plant clock is in; null without a clock'),
      floods: z.array(floodEpisodeSchema).describe('Flood episodes still in flood'),
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
    z.object({
      type: z.literal('alarm'),
      event: z
        .enum(['raised', 'cleared', 'updated', 'acknowledged', 'commented', 'shelf'])
        .describe(
          "What happened to the occurrence since the last message about it (shelf: its point's shelf changed)",
        ),
      occurrence: alarmOccurrenceSchema,
    }),
    z.object({
      type: z.literal('alarm-point'),
      event: z
        .enum(['shelved', 'unshelved', 'expire', 'epoch-ended'])
        .describe('A shelf change on the `alarms` topic (#143)'),
      point: alarmPointSchema,
    }),
    z.object({
      type: z.literal('alarm-kpi'),
      topic: alarmKpiTopic,
      hour: alarmKpiBucketSchema.nullable(),
      shift: alarmKpiBucketSchema.nullable(),
      floods: z.array(floodEpisodeSchema),
    }),
    z.object({
      type: z.literal('shift'),
      event: z
        .enum(['created', 'status', 'revised'])
        .describe('The plant clock entered it, its status moved, or its revision rose'),
      shift: shiftRecordSchema,
    }),
    z.object({
      type: z.literal('handover-note'),
      event: z.enum(['created', 'edited']),
      note: handoverNoteSchema,
    }),
    ...orderPushMessages,
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

// Identity (#168, ADR-0026): the session and user administration routes.

const username = z
  .string()
  .regex(USERNAME_PATTERN)
  .describe('A user name: lower case, 2–64 characters of a–z, 0–9, `.`, `_`, `-`');
// Counted in characters (code points), as the MES's policy counts them (#168 review, L2); the
// UTF-16 bound only keeps the JSON Schema's maxLength meaningful.
const password = z
  .string()
  .min(1)
  .max(PASSWORD_LENGTH.max * 2)
  .refine(
    (value) => passwordLength(value) <= PASSWORD_LENGTH.max,
    `at most ${String(PASSWORD_LENGTH.max)} characters`,
  )
  .describe(
    `A password (${String(PASSWORD_LENGTH.min)}–${String(PASSWORD_LENGTH.max)} characters when set)`,
  );
const role = z.enum(ROLES);
const roles = z
  .array(role)
  .min(1)
  .max(ROLES.length)
  .refine((list) => new Set(list).size === list.length, 'roles must not repeat')
  .describe('One or more roles');

export const loginRequestSchema = z
  .strictObject({
    // Not the user name pattern: an unknown or malformed name gets the same 401 as a wrong password.
    username: z.string().min(1).max(64),
    password,
    kind: z
      .enum(SESSION_KINDS)
      .default('desk')
      .describe('desk (idle timeout 60 min) or terminal (15 min); absolute limit 12 h'),
  })
  .describe('A login: sets the session cookie');

export const sessionUserSchema = z.object({
  id: int,
  username: z.string(),
  roles: z.array(role),
  permissions: z.array(z.enum(PERMISSIONS)),
  mustChangePassword: z
    .boolean()
    .describe('Only the session and password routes answer until the password is changed'),
});

export const sessionSchema = z
  .object({
    user: sessionUserSchema,
    kind: z.enum(SESSION_KINDS),
    createdAt: time,
    idleExpiresAt: time.describe('When the session ends unless used before (wall time)'),
    expiresAt: time.describe('When the session ends at the latest (wall time)'),
  })
  .describe("The caller's session");

export const passwordChangeRequestSchema = z
  .strictObject({
    currentPassword: password,
    newPassword: password,
  })
  .describe("A change of the caller's own password; ends the user's other sessions");

export const passwordChangeResultSchema = z.object({
  changed: z.literal(true),
  endedSessions: int.describe("The user's other sessions that ended"),
});

export const userSchema = z.object({
  id: int,
  username: z.string(),
  roles: z.array(role),
  enabled: z.boolean(),
  mustChangePassword: z.boolean(),
  locked: z.boolean().describe('Locked after failed logins (not for admins, who get a delay)'),
  createdAt: time,
  updatedAt: time,
});

export const userListSchema = z.object({ users: z.array(userSchema) });

export const userCreateRequestSchema = z
  .strictObject({
    username,
    roles,
    password: password.describe('A temporary password: the user must change it at first login'),
  })
  .describe('A new user');

export const userUpdateRequestSchema = z
  .strictObject({
    roles: roles.optional(),
    enabled: z
      .boolean()
      .optional()
      .describe('false ends every session of the user and closes their sockets'),
  })
  .describe("A change of a user's roles or whether it may log in");

export const passwordResetRequestSchema = z
  .strictObject({
    password: password.describe('A temporary password: the user must change it at next login'),
  })
  .describe('Resets a password; ends every session of the user and clears a lock');

export type LoginRequest = z.input<typeof loginRequestSchema>;
export type SessionDto = z.infer<typeof sessionSchema>;
export type SessionUserDto = z.infer<typeof sessionUserSchema>;
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;
export type PasswordChangeResult = z.infer<typeof passwordChangeResultSchema>;
export type UserDto = z.infer<typeof userSchema>;
export type UserList = z.infer<typeof userListSchema>;
export type UserCreateRequest = z.infer<typeof userCreateRequestSchema>;
export type UserUpdateRequest = z.infer<typeof userUpdateRequestSchema>;
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;
