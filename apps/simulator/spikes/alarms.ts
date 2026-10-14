import {
  AttributeIds,
  DataType,
  NodeId,
  OPCUAClient,
  OPCUAServer,
  TimestampsToReturn,
  constructEventFilter,
  nodesets,
  type ClientSession,
} from 'node-opcua';

const server = new OPCUAServer({
  port: 4861,
  nodeset_filename: [nodesets.standard],
  serverCapabilities: { minSupportedSampleRate: 0 },
});
await server.initialize();
const addressSpace = server.engine.addressSpace;
if (!addressSpace) throw new Error('no address space');
addressSpace.installAlarmsAndConditionsService();
const ns = addressSpace.getOwnNamespace();
const objects = addressSpace.rootFolder.objects;
const machine = ns.addObject({ browseName: 'CNC-01', organizedBy: objects, eventNotifier: 1 });
objects.server.addReference({ referenceType: 'HasNotifier', nodeId: machine });
machine.addReference({ referenceType: 'HasEventSource', nodeId: machine, isForward: true });
objects.server.addReference({ referenceType: 'HasEventSource', nodeId: machine });

const stateVar = ns.addVariable({
  componentOf: machine,
  browseName: 'State',
  dataType: 'String',
  value: { dataType: DataType.String, value: 'Running' },
});
const alarmType = ns.addEventType({
  browseName: 'MachineFailureAlarmType',
  subtypeOf: 'AlarmConditionType',
  isAbstract: false,
});
ns.addVariable({
  propertyOf: alarmType,
  browseName: 'Sequence',
  dataType: 'UInt32',
  modellingRule: 'Mandatory',
});
const alarm = ns.instantiateAlarmCondition(alarmType, {
  browseName: 'SpindleOverload',
  componentOf: machine,
  conditionSource: machine,
  conditionName: 'SPINDLE-OVERLOAD',
  inputNode: stateVar,
});
alarm.setEnabledState(true);
let seq = 0;
const setSequence = (): void => {
  seq++;
  const node = alarm.getPropertyByName('Sequence');
  node?.setValueFromSource({ dataType: DataType.UInt32, value: seq });
};
const serverLog: string[] = [];
alarm.on('acknowledged', (_eventId: unknown, comment: { text?: string } | null) => {
  serverLog.push(`server saw acknowledge: ${String(comment?.text)}`);
});
await server.start();

const fields = [
  'EventId',
  'ConditionId',
  'ConditionName',
  'ActiveState.Id',
  'AckedState.Id',
  'Retain',
  'Severity',
  'Message',
  '1:Sequence',
  'EventType',
];
const connect = async (): Promise<{
  session: ClientSession;
  seen: Record<string, unknown>[];
  subscriptionId: number;
  close: () => Promise<void>;
}> => {
  const client = OPCUAClient.create({ endpointMustExist: false });
  await client.connect('opc.tcp://localhost:4861');
  const session = await client.createSession();
  const sub = await session.createSubscription2({
    requestedPublishingInterval: 100,
    requestedMaxKeepAliveCount: 20,
    requestedLifetimeCount: 600,
    maxNotificationsPerPublish: 0,
    publishingEnabled: true,
    priority: 1,
  });
  const seen: Record<string, unknown>[] = [];
  const item = await sub.monitor(
    { nodeId: 'i=2253', attributeId: AttributeIds.EventNotifier },
    {
      samplingInterval: 0,
      queueSize: 1000,
      discardOldest: false,
      filter: constructEventFilter(fields, [new NodeId()]),
    },
    TimestampsToReturn.Both,
  );
  item.on('changed', (values) => {
    const v = values as unknown as { value: unknown }[];
    seen.push(Object.fromEntries(fields.map((f, i) => [f, v[i]?.value])));
  });
  await new Promise((r) => setTimeout(r, 300));
  return {
    session,
    seen,
    subscriptionId: sub.subscriptionId,
    close: async () => {
      await session.close();
      await client.disconnect();
    },
  };
};
const dump = (label: string): void => {
  console.log(
    `server ${label}: active=${String(alarm.activeState.getValue())} acked=${String(alarm.ackedState.getValue())} retain=${String(alarm.retain.readValue().value.value)}`,
  );
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (e: Record<string, unknown>) =>
  `${String(e.ConditionName ?? (e.EventType as { toString(): string } | undefined)?.toString())} active=${String(e['ActiveState.Id'])} acked=${String(e['AckedState.Id'])} retain=${String(e.Retain)} seq=${String(e['1:Sequence'])} msg="${String((e.Message as { text?: string } | null)?.text ?? '')}"`;

const a = await connect();
setSequence();
alarm.activateAlarm();
alarm.raiseNewCondition({ message: 'Spindle overload', severity: 800, retain: true });
await wait(400);
dump('after activate');
const active = a.seen.at(-1);
if (!active) throw new Error('no alarm event received');
const status = await a.session.acknowledgeCondition(
  active.ConditionId as NodeId,
  active.EventId as Buffer,
  'operator: spindle checked',
);
console.log('acknowledge status', status.toString());
await wait(200);
dump('after ack');
await wait(400);
setSequence();
alarm.deactivateAlarm(false);
alarm.raiseNewCondition({ message: 'Spindle overload cleared', severity: 800, retain: false });
await wait(400);
dump('after deactivate');
console.log('client A saw:');
a.seen.forEach((e) => {
  console.log('  ' + short(e));
});
console.log(serverLog.join('\n'));

setSequence();
alarm.activateAlarm();
alarm.raiseNewCondition({ message: 'Spindle overload again', severity: 800, retain: true });
await wait(300);
dump('after second activate');
const b = await connect();
const refresh = await b.session.call({
  objectId: 'i=2782',
  methodId: 'i=3875',
  inputArguments: [{ dataType: DataType.UInt32, value: b.subscriptionId }],
});
console.log('ConditionRefresh status', refresh.statusCode.toString());
await wait(500);
console.log('client B after ConditionRefresh saw:');
b.seen.forEach((e) => {
  console.log('  ' + short(e));
});
await a.close();
await b.close();
await server.shutdown(0);
