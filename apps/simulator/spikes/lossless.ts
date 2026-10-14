import {
  AttributeIds,
  DataType,
  OPCUAClient,
  OPCUAServer,
  TimestampsToReturn,
  constructEventFilter,
  nodesets,
  type ClientMonitoredItem,
  type ClientSubscription,
} from 'node-opcua';

const CHANGES = 600;
const exceptionBased = process.argv.includes('--exception');
const server = new OPCUAServer({
  port: 4851,
  nodeset_filename: [nodesets.standard],
  ...(exceptionBased ? { serverCapabilities: { minSupportedSampleRate: 0 } } : {}),
});
await server.initialize();
const addressSpace = server.engine.addressSpace;
if (!addressSpace) throw new Error('no address space');
const ns = addressSpace.getOwnNamespace();
const machine = ns.addObject({
  browseName: 'CNC-01',
  organizedBy: addressSpace.rootFolder.objects,
  eventNotifier: 1,
});
addressSpace.rootFolder.objects.addReference({ referenceType: 'HasNotifier', nodeId: machine });
const state = ns.addVariable({
  componentOf: machine,
  browseName: 'State',
  nodeId: 's=CNC-01.State',
  dataType: 'String',
  minimumSamplingInterval: 0,
  value: { dataType: DataType.String, value: '0:Off' },
});
const eventType = ns.addEventType({
  browseName: 'StateChangeEventType',
  subtypeOf: 'BaseEventType',
});
ns.addVariable({
  propertyOf: eventType,
  browseName: 'Sequence',
  dataType: 'UInt32',
  modellingRule: 'Mandatory',
});
await server.start();

const client = OPCUAClient.create({ endpointMustExist: false });
await client.connect('opc.tcp://localhost:4851');
const session = await client.createSession();
const subscribe = async (): Promise<ClientSubscription> =>
  session.createSubscription2({
    requestedPublishingInterval: 100,
    requestedMaxKeepAliveCount: 20,
    requestedLifetimeCount: 600,
    maxNotificationsPerPublish: 0,
    publishingEnabled: true,
    priority: 1,
  });

const received: Record<string, number[]> = {
  'queue 1, sampling 0': [],
  'queue 1000, sampling 0': [],
  'queue 1000, sampling 100': [],
  events: [],
  'events (Server)': [],
};
const monitor = async (
  label: string,
  queueSize: number,
  samplingInterval: number,
): Promise<ClientMonitoredItem> => {
  const sub = await subscribe();
  const item = await sub.monitor(
    { nodeId: 'ns=1;s=CNC-01.State', attributeId: AttributeIds.Value },
    { samplingInterval, queueSize, discardOldest: false },
    TimestampsToReturn.Both,
  );
  item.on('changed', (v) => {
    received[label]?.push(Number(String(v.value.value).split(':')[0]));
  });
  await new Promise((r) => setTimeout(r, 200));
  console.log(
    `${label}: revised sampling ${String(item.result?.revisedSamplingInterval)}, queue ${String(item.result?.revisedQueueSize)}`,
  );
  return item;
};
await monitor('queue 1, sampling 0', 1, 0);
await monitor('queue 1000, sampling 0', 1000, 0);
await monitor('queue 1000, sampling 100', 1000, 100);
const eventSub = await subscribe();
const eventItem = await eventSub.monitor(
  { nodeId: 'i=2253', attributeId: AttributeIds.EventNotifier },
  {
    samplingInterval: 0,
    queueSize: 1000,
    discardOldest: false,
    filter: constructEventFilter(['Message', '1:Sequence']),
  },
  TimestampsToReturn.Both,
);
eventItem.on('changed', (fields) => {
  const f = fields as unknown as { value: { text?: string } | null }[];
  received['events (Server)']?.push(Number(f[0]?.value?.text));
});
const eventNodeId = machine.nodeId;
const evItem = await eventSub.monitor(
  { nodeId: eventNodeId, attributeId: AttributeIds.EventNotifier },
  {
    samplingInterval: 0,
    queueSize: 1000,
    discardOldest: false,
    filter: constructEventFilter(['Message', '1:Sequence']),
  },
  TimestampsToReturn.Both,
);
evItem.on('err', (e) => {
  console.log('event item error', String(e));
});
console.log('event item', String(evItem.statusCode), String(evItem.result?.revisedQueueSize));
evItem.on('changed', (fields) => {
  const f = fields as unknown as { value: { text?: string } | null }[];
  if (received.events?.length === 0)
    console.log('first event fields', JSON.stringify(f.map((x) => x.value)));
  received.events?.push(Number(f[0]?.value?.text));
});
await new Promise((r) => setTimeout(r, 500));

let seq = 0;
const states = ['Running', 'Stopped', 'Running', 'Blocked', 'Running', 'Down'];
const t0 = performance.now();
while (seq < CHANGES) {
  const burst = seq % 50 === 0 ? 3 : 1;
  for (let b = 0; b < burst && seq < CHANGES; b++) {
    seq++;
    state.setValueFromSource({
      dataType: DataType.String,
      value: `${String(seq)}:${states[seq % states.length] ?? ''}`,
    });
    machine.raiseEvent(eventType, {
      message: { dataType: DataType.LocalizedText, value: { text: String(seq) } },
      sequence: { dataType: DataType.UInt32, value: seq },
    });
  }
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 21)));
}
const sendMs = performance.now() - t0;
await new Promise((r) => setTimeout(r, 1500));

console.log(
  `sent ${String(CHANGES)} changes in ${sendMs.toFixed(0)} ms (${(CHANGES / (sendMs / 1000)).toFixed(0)}/s), bursts of 3 every 50`,
);
for (const [label, values] of Object.entries(received)) {
  const seqs = values.filter((v) => v > 0);
  const set = new Set(seqs);
  let gaps = 0;
  for (let i = 1; i <= CHANGES; i++) if (!set.has(i)) gaps++;
  const ordered = seqs.every((v, i) => i === 0 || v > (seqs[i - 1] ?? 0));
  console.log(
    `${label.padEnd(26)} received ${String(set.size).padStart(5)} / ${String(CHANGES)}  missing ${String(gaps).padStart(5)}  in order: ${String(ordered)}`,
  );
}
await session.close();
await client.disconnect();
await server.shutdown(0);
