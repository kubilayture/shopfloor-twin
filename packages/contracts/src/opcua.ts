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
} as const;

export type OpcuaVariable = keyof typeof OPCUA_VARIABLES;

export const OPCUA_METHODS = {
  loadProgram: 'ShopFloor.LoadProgram',
} as const;

export const OPCUA_EVENT_TYPES = {
  stateChange: 'ShopFloorStateChangeEventType',
  cycleComplete: 'CycleCompleteEventType',
  alarm: 'ShopFloorAlarmEventType',
} as const;

export const OPCUA_EVENT_FIELDS = {
  common: ['Sequence', 'MachineId'],
  stateChange: ['FromState', 'ToState', 'Cause'],
  cycleComplete: ['Product', 'PartId', 'Serial', 'Result', 'Reason', 'MeasurementValue'],
  alarm: ['AlarmCode', 'Transition'],
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
