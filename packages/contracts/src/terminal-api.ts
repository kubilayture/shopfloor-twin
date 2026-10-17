import { z } from 'zod';
import { scrapRecordSchema } from './execution-api.ts';
import { orderSchema } from './orders-api.ts';

// The MES's operator terminal API (#177, Phase 7 plan "Operator terminal"): sign-on and the crew
// per work center and shift, the orders at a work center with their counts, an operator's start,
// pause and resume on an order operation (activity intervals: the operator's time, never the
// machine's), operation sign-off (what lets a supervisor close the order), and the push topic
// `terminal:<workCenter>`. Scrap coding at the terminal is `PUT /scrap-records/{id}/coding`
// (#175). Shared by `mes-server`, which serves it, and `web`, which parses it (ADR-0020);
// `mes-api` re-exports it.

const time = z.iso.datetime();
const int = z.number().int();

export const TERMINAL_LIMITS = {
  /** Orders one terminal view shows at most, of the active ones and of the queue each. */
  orders: 30,
  /** Uncoded scrap records one terminal view shows at most (newest first). */
  scrapRecords: 50,
  /** Characters of a pause's comment. */
  comment: 500,
} as const;

/** Why an operator pauses work on an order operation. */
export const PAUSE_REASONS = [
  'break',
  'material',
  'quality',
  'maintenance',
  'instruction',
  'other',
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/** Why an activity interval ended. */
export const ACTIVITY_END_REASONS = ['paused', 'resumed', 'signed-off', 'crew-ended'] as const;

/** Why a crew row ended. */
export const CREW_END_REASONS = ['sign-off', 'session-ended', 'shift-ended', 'replaced'] as const;

/** The push topic of a work center's terminal view: `terminal:<workCenter>`. */
export const TERMINAL_TOPIC_PATTERN = /^terminal:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const terminalTopic = (workCenter: string): string => `terminal:${workCenter}`;

export const crewMemberSchema = z
  .object({
    id: int,
    userId: int,
    username: z.string(),
    workCenter: z.string(),
    epoch: int,
    shiftKey: z.string(),
    from: time.describe('Wall time of the sign-on'),
    fromPlant: time.describe('Plant time of the sign-on'),
    to: time.nullable(),
    toPlant: time.nullable(),
    endReason: z.enum(CREW_END_REASONS).nullable(),
  })
  .describe('One sign-on of an operator at a work center during a shift instance');

export const activitySchema = z
  .object({
    id: int,
    orderId: z.string(),
    operation: z.string(),
    workCenter: z.string(),
    userId: int,
    username: z.string(),
    kind: z.enum(['work', 'pause']),
    reason: z.enum(PAUSE_REASONS).nullable().describe('Of a pause'),
    comment: z.string().nullable(),
    from: time,
    fromPlant: time,
    to: time.nullable(),
    toPlant: time.nullable(),
    endReason: z.enum(ACTIVITY_END_REASONS).nullable(),
  })
  .describe("An interval of an operator's work or pause on an order operation");

export const terminalOperationSchema = z
  .object({
    orderId: z.string(),
    operation: z.string(),
    workCenter: z.string(),
    version: int.describe(
      'Raised by every terminal write on it; a sign-off sends the version read (activity writes name their own interval)',
    ),
    complete: z
      .boolean()
      .describe(
        'The MES has it complete (its final confirmation is written): it may be signed off',
      ),
    completedAt: time.nullable().describe('Plant time it was complete by its facts'),
    signedOff: z
      .object({ username: z.string(), at: time, plantAt: time })
      .nullable()
      .describe('The operator who signed it off, wall and plant time'),
    activities: z
      .array(activitySchema)
      .describe('The open intervals, one per operator working or pausing on it'),
  })
  .describe('An order operation as the terminal sees it');

export const terminalCountsSchema = z
  .object({
    operation: z.string(),
    in: int.describe('Completed cycles, every pass'),
    good: int,
    scrap: int.describe('Scrapped units, every reason'),
    rework: int.describe('Cycles that sent a unit back'),
  })
  .describe('Counts of an order operation from execution (#175)');

export const terminalOrderSchema = z
  .object({
    order: orderSchema,
    operations: z
      .array(terminalOperationSchema.extend({ counts: terminalCountsSchema }))
      .describe("The order's operations at this work center, in routing order"),
    wip: int.describe(
      "The order's units in WIP at this work center (at or waiting for its stations)",
    ),
  })
  .describe('An active order at a work center');

export const terminalQueueEntrySchema = z
  .object({
    order: orderSchema,
    equipment: z.string().nullable().describe('The CNC its latest command went to, if dispatched'),
  })
  .describe('A released or dispatched order not yet active here');

export const terminalMachineSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    operation: z.string(),
    state: z
      .object({ state: z.string(), cause: z.string().nullable(), since: time })
      .nullable()
      .describe('The current state; null before any fact'),
    job: z
      .object({ commandId: z.string(), orderId: z.string(), product: z.string() })
      .nullable()
      .describe("A CNC's started job (its current order); null for other machines"),
    orders: z
      .array(z.string())
      .describe('Orders with units at this station (in its cycle, or waiting for it)'),
  })
  .describe('A machine of the work center');

export const terminalViewSchema = z
  .object({
    workCenter: z.object({ id: z.string(), name: z.string() }),
    shift: z
      .object({ epoch: int, key: z.string(), start: time, end: time })
      .nullable()
      .describe('The shift instance the plant clock is in; sign-on needs one'),
    machines: z.array(terminalMachineSchema),
    crew: z.array(crewMemberSchema).describe('Who is signed on here now'),
    orders: z
      .array(terminalOrderSchema)
      .describe(
        'Active orders: in progress, completed and not closed, or dispatched with units already; by planned start',
      ),
    queue: z
      .array(terminalQueueEntrySchema)
      .describe('Released and dispatched orders not active yet, by planned start'),
    scrapRecords: z
      .array(scrapRecordSchema)
      .describe('Uncoded scrap records of operations at this work center, newest first'),
    truncated: z.boolean().describe('More orders or scrap records than the view shows'),
  })
  .describe("A work center's terminal view (also the push topic's content)");

const version = int
  .min(1)
  .describe('The operation version read; 409 when it is not the current one');

export const terminalEmptyRequestSchema = z.strictObject({}).describe('An empty JSON object');

/**
 * What an activity write read: the id of the operator's own open interval on the operation, null
 * when none. 409 operation-stale when it is not theirs now; other operators' writes never make it
 * stale (#177 review).
 */
const activity = int
  .min(1)
  .nullable()
  .describe("The operator's own open interval as read (its id), null when none");

export const activityWriteRequestSchema = z
  .strictObject({ activity })
  .describe("A start (activity null) or resume (the operator's open pause)");

export const operationWriteRequestSchema = z
  .strictObject({ version })
  .describe('A sign-off: the operation version read');

export const pauseRequestSchema = z
  .strictObject({
    activity,
    reason: z.enum(PAUSE_REASONS),
    comment: z.string().trim().min(1).max(TERMINAL_LIMITS.comment).optional(),
  })
  .describe("Pauses the operator's work (their open work interval) with a reason");

export const crewResultSchema = z.object({ crew: crewMemberSchema });

export const operationResultSchema = z.object({ operation: terminalOperationSchema });

/** Push messages of `terminal:<workCenter>`: the whole view, as a snapshot and as an update. */
export const terminalTopicSchema = z
  .string()
  .regex(TERMINAL_TOPIC_PATTERN)
  .describe('terminal:<work center>');
export const terminalPushMessages = [
  z.object({
    type: z.literal('snapshot'),
    topic: terminalTopicSchema,
    view: terminalViewSchema,
  }),
  z.object({
    type: z.literal('terminal'),
    topic: terminalTopicSchema,
    view: terminalViewSchema,
  }),
] as const;

export type CrewMemberDto = z.infer<typeof crewMemberSchema>;
export type ActivityDto = z.infer<typeof activitySchema>;
export type TerminalOperationDto = z.infer<typeof terminalOperationSchema>;
export type TerminalOrderDto = z.infer<typeof terminalOrderSchema>;
export type TerminalQueueEntryDto = z.infer<typeof terminalQueueEntrySchema>;
export type TerminalMachineDto = z.infer<typeof terminalMachineSchema>;
export type TerminalViewDto = z.infer<typeof terminalViewSchema>;
export type OperationWriteRequest = z.infer<typeof operationWriteRequestSchema>;
export type ActivityWriteRequest = z.infer<typeof activityWriteRequestSchema>;
export type PauseRequest = z.input<typeof pauseRequestSchema>;
export type CrewResult = z.infer<typeof crewResultSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
