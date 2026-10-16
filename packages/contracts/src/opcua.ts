export const SHOPFLOOR_NAMESPACE_URI = 'urn:orbis-components:shopfloor-twin';

export const OPCUA_BASE_PORT = 4841;

export const OPCUA_MACHINES = [
  { id: 'cnc-01', port: 4841, kind: 'machine-tool' },
  { id: 'cnc-02', port: 4842, kind: 'machine-tool' },
  { id: 'asm-01', port: 4843, kind: 'station' },
  { id: 'lkt-01', port: 4844, kind: 'station' },
  { id: 'pck-01', port: 4845, kind: 'station' },
] as const;

export type OpcuaMachineId = (typeof OPCUA_MACHINES)[number]['id'];

export const OPCUA_VARIABLES = {
  state: 'ShopFloor.State',
  stateCause: 'ShopFloor.StateCause',
  sequence: 'ShopFloor.Sequence',
  epoch: 'ShopFloor.Epoch',
  produced: 'ShopFloor.Counters.Produced',
  good: 'ShopFloor.Counters.Good',
  scrap: 'ShopFloor.Counters.Scrap',
  rework: 'ShopFloor.Counters.Rework',
  lastSerial: 'ShopFloor.LastSerial',
  program: 'ShopFloor.Program',
  operator: 'ShopFloor.Operator',
  spindleLoad: 'ShopFloor.ProcessValues.SpindleLoad',
  coolantTemperature: 'ShopFloor.ProcessValues.CoolantTemperature',
  leakRate: 'ShopFloor.LeakTest.LastReading',
  leakUpperLimit: 'ShopFloor.LeakTest.UpperLimit',
  alarmsActiveCount: 'ShopFloor.Alarms.ActiveCount',
  /** Orders mode (#172): the order of the job the CNC works on now, empty if none. */
  activeOrder: 'ShopFloor.ActiveOrder',
  /** Orders mode (#172): jobs accepted and not completed, the active one included. */
  queuedJobs: 'ShopFloor.QueuedJobs',
} as const;

export type OpcuaVariable = keyof typeof OPCUA_VARIABLES;

export const OPCUA_METHODS = {
  loadProgram: 'ShopFloor.LoadProgram',
  /** Orders mode (#172, ADR-0030): append an idempotent job to a CNC's queue. */
  loadOrder: 'ShopFloor.LoadOrder',
} as const;

/**
 * `LoadOrder`'s input arguments, in call order (#172, ADR-0030). A refusal flags the offending
 * argument in `inputArgumentResults` at its index here, which is how a client tells
 * `epoch-mismatch` (DeviceEpoch) from `expired` (ExpiresAt): both are `BadInvalidState`.
 */
export const LOAD_ORDER_INPUTS = [
  'CommandId',
  'OrderId',
  'Product',
  'Quantity',
  'NotBefore',
  'DeviceEpoch',
  'ExpiresAt',
] as const;

/** `LoadOrder`'s output arguments, in order. */
export const LOAD_ORDER_OUTPUTS = ['Position', 'Duplicate', 'AcceptedSeq', 'AcceptedAt'] as const;

/** At most this many jobs accepted and not completed per CNC. */
export const MAX_QUEUED_JOBS = 50;

/** The transitions of a job fact (`ShopFloorJobEventType`, event-log type `job`). */
export const JOB_TRANSITIONS = ['accepted', 'started', 'completed'] as const;

export type JobTransition = (typeof JOB_TRANSITIONS)[number];

export const OPCUA_EVENT_TYPES = {
  stateChange: 'ShopFloorStateChangeEventType',
  cycleComplete: 'CycleCompleteEventType',
  alarm: 'ShopFloorAlarmEventType',
  /** Orders mode (#172): a job accepted, started (first blank) or completed (last OP10 cycle). */
  job: 'ShopFloorJobEventType',
} as const;

export const OPCUA_EVENT_FIELDS = {
  common: ['Sequence', 'MachineId'],
  stateChange: ['FromState', 'ToState', 'Cause'],
  cycleComplete: ['Product', 'PartId', 'Serial', 'Result', 'Reason', 'MeasurementValue'],
  alarm: ['AlarmCode', 'Transition'],
  job: ['Transition', 'CommandId', 'OrderId', 'Product', 'Quantity'],
} as const;

export const OPCUA_EVENT_FIELD_TYPES = {
  Sequence: 'UInt32',
  MachineId: 'String',
  FromState: 'String',
  ToState: 'String',
  Cause: 'String',
  Product: 'String',
  PartId: 'UInt32',
  Serial: 'String',
  Result: 'String',
  Reason: 'String',
  MeasurementValue: 'Double',
  AlarmCode: 'String',
  Transition: 'String',
  CommandId: 'String',
  OrderId: 'String',
  Quantity: 'UInt32',
} as const satisfies Record<string, 'String' | 'UInt32' | 'Double'>;

export const opcuaNodeId = (machineId: string, path: string): string =>
  `nsu=${SHOPFLOOR_NAMESPACE_URI};s=${machineId}.${path}`;

export const OPCUA_ALARM_FOLDER = 'ShopFloor.Alarms';

export const opcuaAlarmPath = (code: string): string => `${OPCUA_ALARM_FOLDER}.${code}.Active`;

export const opcuaEventTypeId = (eventType: string): string =>
  `nsu=${SHOPFLOOR_NAMESPACE_URI};s=${eventType}`;

export const opcuaEndpoint = (host: string, port: number): string =>
  `opc.tcp://${host}:${String(port)}`;

export function toIndexedNodeId(expandedNodeId: string, namespaceArray: readonly string[]): string {
  const match = /^nsu=([^;]+);(.+)$/.exec(expandedNodeId);
  if (!match) {
    return expandedNodeId;
  }
  const [, uri = '', identifier = ''] = match;
  const index = namespaceArray.indexOf(uri);
  if (index < 0) {
    throw new RangeError(`namespace ${uri} is not served by this server`);
  }
  return `ns=${String(index)};${identifier}`;
}
