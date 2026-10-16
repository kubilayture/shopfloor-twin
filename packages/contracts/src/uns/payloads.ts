import { z } from 'zod';
import { JOB_TRANSITIONS } from '../opcua.ts';

export const MACHINE_STATES = [
  'Off',
  'Idle',
  'Running',
  'Stopped',
  'Starved',
  'Blocked',
  'Setup',
  'Down',
  'PlannedStop',
  'Maintenance',
] as const;

export type MachineState = (typeof MACHINE_STATES)[number];

const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const isoTime = z.iso.datetime({ offset: false });
const sequence = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

export const qualitySchema = z
  .enum(['good', 'uncertain', 'bad'])
  .describe('OPC UA-style quality: bad means the value must not be used');

export const sourceSchema = z.strictObject({
  id: id.describe('Equipment id (cnc-01, wsh-01) or component instance (gw-01)'),
  protocol: z.enum(['opcua', 'modbus', 'internal']).describe('Where the gateway got it'),
});

/**
 * Identity (ADR-0015): `scope: device` messages carry the device's own sequence, shared by its
 * state, cycle and alarm messages; `scope: topic` messages carry a gateway counter per topic.
 * `epoch` changes whenever the owner of the sequence restarts.
 */
const identity = {
  epoch: z
    .int()
    .min(0)
    .max(2 ** 32 - 1)
    .describe('Start of the sequence owner, Unix seconds'),
  seq: sequence,
  sourceTime: isoTime.describe('Simulation (device) time of the fact'),
  receivedAt: isoTime.describe('Gateway wall time when it read the fact'),
  quality: qualitySchema,
  source: sourceSchema,
};

/** Each schema adds its `scope` (device or topic) and any extra fields. */
function envelope<
  const N extends string,
  V extends z.ZodType,
  E extends z.ZodRawShape & { scope: z.ZodLiteral<'device' | 'topic'> },
>(name: N, value: V, extra: E) {
  return z.strictObject({
    schema: z.literal(`${name}/1`),
    ...identity,
    ...extra,
    value,
  });
}

const stateValue = z.strictObject({
  state: z.enum(MACHINE_STATES),
  cause: z.string().nullable().describe('Failure code, CHANGEOVER A→B, MATERIAL:SK-1, …'),
});

const DEVICE = { scope: z.literal('device') };
const TOPIC = { scope: z.literal('topic') };

export const stateCurrentSchema = z
  .discriminatedUnion('kind', [
    envelope('uns.state.current', stateValue, { kind: z.literal('event'), ...DEVICE }),
    envelope('uns.state.current', stateValue, {
      kind: z.literal('snapshot').describe('Read from the variables after a (re)connect'),
      ...TOPIC,
      // Added in contract version 1.1 (#95), optional so that older snapshots stay valid.
      deviceEpoch: identity.epoch
        .optional()
        .describe(
          'The device epoch (ADR-0015) the state was read in; epoch is the gateway counter epoch',
        ),
    }),
  ])
  .meta({
    title: 'uns.state.current/1',
    description: 'Current machine state (retained): a state change (event) or a resync snapshot',
  });

export const telemetrySchema = envelope('uns.telemetry', z.number(), {
  unit: z.string().min(1),
  ...TOPIC,
  // Added in contract version 1.1 (#96), optional so that older samples stay valid.
  deviceEpoch: identity.epoch
    .optional()
    .describe(
      'The device epoch (ADR-0015) the value was read in, when known; epoch is the gateway counter epoch',
    ),
}).meta({
  title: 'uns.telemetry/1',
  description: 'A sampled process value (retained, last value)',
});

export const measurementSchema = z.strictObject({
  characteristic: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
  upperLimit: z.number(),
});

export const cycleCompleteSchema = envelope(
  'uns.events.cycle-complete',
  z.strictObject({
    product: z.string().min(1),
    partId: z.int().min(1),
    serial: z.string(),
    result: z.enum(['good', 'scrap', 'rework']),
    reason: z.string().nullable(),
    measurement: measurementSchema.nullable(),
  }),
  { ...DEVICE },
).meta({ title: 'uns.events.cycle-complete/1', description: 'A completed cycle (not retained)' });

/**
 * Orders mode (contract 1.3, #173): a job fact of a CNC (`ShopFloorJobEventType`, ADR-0030). A
 * device fact like a cycle, in the machine's shared sequence, so job facts take part in the
 * device stream's dedup and gap checks.
 */
export const jobEventSchema = envelope(
  'uns.events.job',
  z.strictObject({
    transition: z
      .enum(JOB_TRANSITIONS)
      .describe('accepted (LoadOrder), started (first blank taken) or completed (last OP10 cycle)'),
    commandId: z.string().min(1).max(128).describe('The command that created the job'),
    orderId: z.string().min(1).max(128),
    product: z.string().min(1),
    quantity: z.int().min(1).describe('Blanks to machine'),
  }),
  { ...DEVICE },
).meta({ title: 'uns.events.job/1', description: 'A job transition of a CNC (not retained)' });

export const alarmSchema = envelope(
  'uns.alarms',
  z.strictObject({
    code: z.string().min(1),
    transition: z.enum(['active', 'cleared']),
    severity: z.int().min(1).max(1000),
  }),
  { ...DEVICE },
).meta({ title: 'uns.alarms/1', description: 'Last transition of one alarm code (retained)' });

/**
 * The gateway's alarm snapshot (contract 1.2, #141): on every resync, the device's active alarm
 * codes read together with its `Sequence` (OPC UA, one Read call) or ring head (Modbus, one register
 * read). Topic-scoped like the state snapshot: `epoch` and `seq` are the gateway's, `deviceEpoch`
 * and `asOfSeq` place it in the device's stream. Never a fact: it takes no part in dedup or gaps.
 */
export const alarmSnapshotSchema = envelope(
  'uns.alarm-snapshot',
  z.strictObject({
    active: z
      .array(z.string().min(1))
      .describe('Codes active at asOfSeq, sorted and without duplicates; empty when none'),
  }),
  {
    kind: z.literal('snapshot'),
    ...TOPIC,
    deviceEpoch: identity.epoch.describe(
      'The device epoch (ADR-0015) the alarms were read in; epoch is the gateway counter epoch',
    ),
    asOfSeq: z
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .describe(
        'The device sequence the alarm bits are consistent with: every fact up to it is reflected, none after it (0: no fact yet)',
      ),
  },
).meta({
  title: 'uns.alarm-snapshot/1',
  description: 'Active alarm codes of one device, read atomically on resync (retained)',
});

export const statusSchema = envelope(
  'uns.sys.status',
  z.strictObject({
    status: z.enum(['online', 'offline']),
    startedAt: isoTime,
    version: z.string().min(1),
  }),
  { ...TOPIC },
).meta({
  title: 'uns.sys.status/1',
  description: 'Component health (retained; last will offline)',
});

export const INCIDENT_TYPES = [
  'sequence-gap',
  'epoch-change',
  'ring-overrun',
  'device-silent',
  'device-recovered',
  'disconnected',
  'reconnected',
  'buffer-overflow',
] as const;

export const incidentSchema = envelope(
  'uns.sys.incident',
  z.strictObject({
    type: z.enum(INCIDENT_TYPES),
    equipment: id.nullable(),
    lost: z.int().min(0).nullable().describe('Number of facts known to be lost, if known'),
    message: z.string().min(1),
  }),
  { ...TOPIC },
).meta({ title: 'uns.sys.incident/1', description: 'A data-quality incident (not retained)' });

export const UNS_SCHEMAS = {
  'uns.state.current/1': stateCurrentSchema,
  'uns.telemetry/1': telemetrySchema,
  'uns.events.cycle-complete/1': cycleCompleteSchema,
  'uns.events.job/1': jobEventSchema,
  'uns.alarms/1': alarmSchema,
  'uns.alarm-snapshot/1': alarmSnapshotSchema,
  'uns.sys.status/1': statusSchema,
  'uns.sys.incident/1': incidentSchema,
} as const;

export type UnsSchemaName = keyof typeof UNS_SCHEMAS;
export type StateCurrent = z.infer<typeof stateCurrentSchema>;
export type Telemetry = z.infer<typeof telemetrySchema>;
export type CycleComplete = z.infer<typeof cycleCompleteSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type Alarm = z.infer<typeof alarmSchema>;
export type AlarmSnapshot = z.infer<typeof alarmSnapshotSchema>;
export type Status = z.infer<typeof statusSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type UnsMessage =
  StateCurrent | Telemetry | CycleComplete | JobEvent | Alarm | AlarmSnapshot | Status | Incident;

/** Parses any UNS payload by its `schema` field. */
export function parseUnsMessage(
  input: unknown,
): { ok: true; message: UnsMessage } | { ok: false; error: string } {
  const name =
    typeof input === 'object' && input !== null && 'schema' in input ? String(input.schema) : '';
  const schema = (UNS_SCHEMAS as Record<string, z.ZodType<UnsMessage> | undefined>)[name];
  if (!schema) {
    return { ok: false, error: `unknown schema "${name}"` };
  }
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

/** Telemetry names and units per protocol source (docs/contracts/uns.md). */
export const UNS_TELEMETRY = {
  'spindle-load': { unit: '%', equipment: ['cnc-01', 'cnc-02'] },
  'coolant-temperature': { unit: '°C', equipment: ['cnc-01', 'cnc-02'] },
  'leak-rate': { unit: 'Pa/min', equipment: ['lkt-01'] },
  'bath-temperature': { unit: '°C', equipment: ['wsh-01'] },
  'conveyor-speed': { unit: 'm/min', equipment: ['wsh-01'] },
} as const;
