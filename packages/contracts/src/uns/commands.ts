import { z } from 'zod';
import { sourceSchema } from './payloads.ts';

/**
 * Commands and their results (UNS contract 1.3, #173, ADR-0029). A command is not a fact, so it
 * has its own envelope: who issued it (`source`, `epoch`, `seq` per topic, as a topic-scoped
 * stream of ADR-0015), when (`issuedAt`) and until when the device may still accept it
 * (`expiresAt`, wall time). The gateway answers every delivery on `cmd-res`.
 */

const isoTime = z.iso.datetime({ offset: false });
const epoch = z
  .int()
  .min(0)
  .max(2 ** 32 - 1);
const sequence = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
/** The device's own rule for ids (`LoadOrder`): 1–128 characters, no surrounding spaces. */
const deviceId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\S(.*\S)?$/, 'no surrounding spaces');

/** The commands the UNS carries; the topic name under `cmd/` and `cmd-res/`. */
export const UNS_COMMANDS = ['load-order'] as const;

export type UnsCommand = (typeof UNS_COMMANDS)[number];

/** The MES's command id for dispatch `n` of an order (plan, "Command identity"). */
export const loadOrderCommandId = (orderId: string, n: number): string =>
  `${orderId}~OP10~${String(n)}`;

const COMMAND_ID = /^(.+)~OP10~[1-9]\d*$/;

export const loadOrderCommandSchema = z
  .strictObject({
    schema: z.literal('uns.cmd.load-order/1'),
    scope: z.literal('topic'),
    epoch: epoch.describe('Start of the issuer (the MES process), Unix seconds'),
    seq: sequence.describe('Per topic, from the issuer'),
    source: sourceSchema.describe('The issuer, e.g. { id: mes-server, protocol: internal }'),
    issuedAt: isoTime.describe('Wall time the command (or this resend) was published'),
    expiresAt: isoTime.describe(
      'Wall time; a command the device has not accepted by then is refused (ExpiresAt)',
    ),
    value: z
      .strictObject({
        commandId: deviceId.describe('{orderId}~OP10~{n}; resends reuse it'),
        orderId: deviceId,
        operation: z.literal('OP10'),
        product: z.string().min(1),
        quantity: z.int().min(1).max(100_000).describe('Blanks to machine'),
        notBefore: isoTime.describe('Plant (simulation) time; the job does not start earlier'),
        deviceEpoch: epoch.describe('The simulator run (ShopFloor.Epoch) the command is meant for'),
      })
      .refine((v) => COMMAND_ID.exec(v.commandId)?.[1] === v.orderId, {
        message: 'commandId must be {orderId}~OP10~{n}',
        path: ['commandId'],
      }),
  })
  .meta({
    title: 'uns.cmd.load-order/1',
    description: 'Append a job to a CNC queue through LoadOrder (QoS 1, not retained)',
  });

/** Why the device (or, for `unsupported-equipment`, the gateway) refused a job for good. */
export const COMMAND_REJECTIONS = [
  'invalid-product',
  'invalid-quantity',
  'invalid-argument',
  'command-conflict',
  'epoch-mismatch',
  'wrong-mode',
  'queue-full',
  'unsupported-equipment',
] as const;

export type CommandRejection = (typeof COMMAND_REJECTIONS)[number];

export const COMMAND_RESULTS = ['accepted', 'duplicate', 'rejected', 'expired', 'unknown'] as const;

export type CommandResultKind = (typeof COMMAND_RESULTS)[number];

const answered = {
  commandId: deviceId,
  orderId: deviceId,
  deviceEpoch: epoch.describe('The deviceEpoch of the command'),
  expiresAt: isoTime.describe('The expiresAt of the delivery this result answers'),
  statusCode: z
    .string()
    .min(1)
    .nullable()
    .describe('The OPC UA status of the call that gave the answer; null if none'),
};

const acceptance = {
  position: z.int().min(1).describe('Place of the job in the queue when it was accepted'),
  acceptedSeq: sequence.describe("Device sequence number of the job's accepted fact (M4)"),
  acceptedAt: isoTime.describe('Plant time of that fact'),
};

const seqAfterExpiry = z
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable()
  .describe(
    'ShopFloor.Sequence read after expiresAt + 1 s (gateway and device clocks), before the settle ' +
      'call; null when not read. Every accepted fact of the command has seq <= seqAfterExpiry, so ' +
      'a re-dispatch may follow once the final-through is >= seqAfterExpiry with none of them',
  );

export const commandResultSchema = z
  .strictObject({
    schema: z.literal('uns.cmd-res/1'),
    scope: z.literal('topic'),
    epoch: epoch.describe('Start of the gateway, Unix seconds'),
    seq: sequence.describe('Per topic, from the gateway'),
    source: sourceSchema.describe('The equipment, protocol opcua'),
    respondedAt: isoTime.describe('Gateway wall time of the answer'),
    value: z.discriminatedUnion('result', [
      z.strictObject({
        result: z.literal('accepted').describe('The device accepted the job now'),
        ...answered,
        ...acceptance,
      }),
      z.strictObject({
        result: z.literal('duplicate').describe('The device had already accepted this command id'),
        ...answered,
        ...acceptance,
      }),
      z.strictObject({
        result: z.literal('rejected').describe('The device refused the job: no job'),
        ...answered,
        code: z.enum(COMMAND_REJECTIONS),
      }),
      z.strictObject({
        result: z
          .literal('expired')
          .describe('The device answered expired on a dedup miss: never accepted'),
        ...answered,
        seqAfterExpiry,
      }),
      z.strictObject({
        result: z.literal('unknown').describe('Not final: the outcome is still being settled'),
        ...answered,
        seqAfterExpiry,
        reason: z.string().min(1),
      }),
    ]),
  })
  .meta({
    title: 'uns.cmd-res/1',
    description: "The gateway's answer to one command delivery (QoS 1, not retained)",
  });

export const UNS_COMMAND_SCHEMAS = {
  'uns.cmd.load-order/1': loadOrderCommandSchema,
  'uns.cmd-res/1': commandResultSchema,
} as const;

export type LoadOrderCommand = z.infer<typeof loadOrderCommandSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type CommandResultValue = CommandResult['value'];
export type UnsCommandMessage = LoadOrderCommand | CommandResult;

/** Parses a command or a command result by its `schema` field. */
export function parseUnsCommandMessage(
  input: unknown,
): { ok: true; message: UnsCommandMessage } | { ok: false; error: string } {
  const name =
    typeof input === 'object' && input !== null && 'schema' in input ? String(input.schema) : '';
  const schema = (UNS_COMMAND_SCHEMAS as Record<string, z.ZodType<UnsCommandMessage> | undefined>)[
    name
  ];
  if (!schema) {
    return { ok: false, error: `unknown schema "${name}"` };
  }
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}
