import {
  OPCUA_ALARM_FOLDER,
  OPCUA_EVENT_FIELDS,
  OPCUA_EVENT_TYPES,
  OPCUA_MACHINES,
  OPCUA_METHODS,
  OPCUA_VARIABLES,
  SHOPFLOOR_NAMESPACE_URI,
  opcuaAlarmPath,
  opcuaEventTypeId,
  opcuaNodeId,
  toIndexedNodeId,
} from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, SECOND } from '@shopfloor/sim-core';
import { GATEWAY_APPLICATION_URI, OPCUA_USERS, TOOLS_APPLICATION_URI } from '@shopfloor/pki';
import { attachConsumption } from '@shopfloor/trace-core';
import {
  AttributeIds,
  BrowseDirection,
  DataType,
  TimestampsToReturn,
  constructEventFilter,
  resolveNodeId,
  type ClientSession,
  type NodeId,
} from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { onFreeOpcuaPorts, securePki, type SecurePki } from '../testing.ts';
import { PlantServers, alarmCodes } from './plant-servers.ts';
import {
  connect,
  documentedEventFields,
  documentedVariables,
  wait,
  type DocumentedVariable,
  type TestClient,
} from './testing.ts';

/** The plant event type each project event type projects (ADR-0009). */
const PLANT_EVENT_TYPE = new Map<string, string>([
  [OPCUA_EVENT_TYPES.stateChange, 'state'],
  [OPCUA_EVENT_TYPES.cycleComplete, 'cycle-complete'],
  [OPCUA_EVENT_TYPES.alarm, 'alarm'],
  [OPCUA_EVENT_TYPES.job, 'job'],
]);

// Monday 06:00 Istanbul: the scripted shift is the first morning shift of the week.
const T0 = Date.UTC(2026, 9, 12, 3);
let offset: number;
const SPEED = 60;
let config: PlantConfig;
let servers: PlantServers;
let run: LiveRun;
let clock: ManualClock;
/** Set once the servers have started, so that `afterAll` stops only what `beforeAll` started. */
let started: { readonly servers: PlantServers; readonly run: LiveRun } | undefined;
let removePki: (() => Promise<void>) | undefined;
let pki: SecurePki;
/**
 * The servers run SignAndEncrypt with the pki step's pinned certificates (#239, ADR-0038): the
 * tools client as `opcua-reader` reads and subscribes, and the gateway's client as
 * `opcua-gateway` is the second subscriber of every server, as in Compose.
 */
let reader: TestClient;
let gateway: TestClient;
const plantEvents: PlantEvent[] = [];

const port = (machineId: string): number =>
  (OPCUA_MACHINES.find((m) => m.id === machineId)?.port ?? 0) + offset;

/** Advances wall time in 1 s ticks so that the servers publish between bursts, as in a real run. */
async function play(wallMs: number): Promise<void> {
  run.pacer.resume();
  for (let t = 0; t < wallMs; t += 1_000) {
    clock.advance(Math.min(1_000, wallMs - t));
    await wait(5);
  }
  run.pacer.pause();
}

beforeAll(async () => {
  config = await loadDefaultConfig();
  pki = await securePki('integration');
  removePki = pki.remove;
  reader = {
    mode: 'sign-and-encrypt',
    pkiFolder: pki.tools,
    applicationUri: TOOLS_APPLICATION_URI,
    user: { userName: OPCUA_USERS.reader, password: pki.passwords.reader },
  };
  gateway = {
    mode: 'sign-and-encrypt',
    pkiFolder: pki.gateway,
    applicationUri: GATEWAY_APPLICATION_URI,
    user: { userName: OPCUA_USERS.gateway, password: pki.passwords.gateway },
  };
  ({ portOffset: offset } = await onFreeOpcuaPorts((portOffset) => {
    clock = new ManualClock();
    plantEvents.length = 0;
    servers = new PlantServers({
      config,
      start: T0,
      portOffset,
      pkiFolder: pki.folder,
      security: pki.security,
    });
    run = createLiveRun({
      config,
      seed: 20261012,
      start: T0,
      speed: SPEED,
      clock,
      onEvent: (event) => {
        plantEvents.push(event);
        servers.record(event);
      },
    });
    servers.attach(run);
    return servers;
  }));
  started = { servers, run };
  run.pacer.start();
  run.pacer.pause();
}, 60_000);

afterAll(async () => {
  try {
    started?.run.pacer.stop();
    await started?.servers.stop();
  } finally {
    await removePki?.();
  }
});

const DATA_TYPES: Record<DocumentedVariable['type'], number> = {
  Boolean: DataType.Boolean,
  String: DataType.String,
  UInt32: DataType.UInt32,
  Double: DataType.Double,
};

function appliesTo(machines: string, machineId: string): boolean {
  switch (machines) {
    case 'all':
      return true;
    case 'CNCs':
      return machineId.startsWith('cnc-');
    default:
      return machines.toLowerCase() === machineId;
  }
}

async function nodeId(session: ClientSession, expanded: string) {
  return resolveNodeId(toIndexedNodeId(expanded, await session.readNamespaceArray()));
}

describe('OPC UA contract against the live servers (#56, plan section 9)', () => {
  it('documents exactly the variables the code serves', async () => {
    const documented = await documentedVariables();
    const paths = documented.map((v) => v.path).sort();
    expect(paths).toEqual([...Object.values(OPCUA_VARIABLES), opcuaAlarmPath('<CODE>')].sort());
    expect(new Set(documented.map((v) => v.type))).toEqual(
      new Set(['String', 'UInt32', 'Double', 'Boolean']),
    );
  });

  it('serves every documented variable with its data type on exactly the documented machines', async () => {
    const documented = await documentedVariables();
    for (const machine of OPCUA_MACHINES) {
      const { session, close } = await connect(port(machine.id), reader);
      try {
        const rows = documented.flatMap((v) =>
          v.path === opcuaAlarmPath('<CODE>')
            ? alarmCodes(config, machine.id).map((code) => ({ ...v, path: opcuaAlarmPath(code) }))
            : [v],
        );
        for (const row of rows) {
          const read = await session.read({
            nodeId: await nodeId(session, opcuaNodeId(machine.id, row.path)),
            attributeId: AttributeIds.DataType,
          });
          const where = `${machine.id} ${row.path}`;
          if (appliesTo(row.machines, machine.id)) {
            expect(read.statusCode.isGood(), where).toBe(true);
            expect((read.value.value as { value: number }).value, where).toBe(DATA_TYPES[row.type]);
          } else {
            expect(read.statusCode.name, where).toBe('BadNodeIdUnknown');
          }
        }
        const alarms = await session.browse({
          nodeId: await nodeId(session, opcuaNodeId(machine.id, OPCUA_ALARM_FOLDER)),
          referenceTypeId: 'HasComponent',
          resultMask: 63,
        });
        expect(
          alarms.references
            ?.map((r) => r.browseName.name)
            .filter((name) => name !== 'ActiveCount')
            .sort(),
        ).toEqual([...alarmCodes(config, machine.id)].sort());
        const method = await session.read({
          nodeId: await nodeId(session, opcuaNodeId(machine.id, OPCUA_METHODS.loadProgram)),
          attributeId: AttributeIds.Executable,
        });
        expect(method.statusCode.isGood(), machine.id).toBe(machine.kind === 'machine-tool');
        const loadOrder = await session.read({
          nodeId: await nodeId(session, opcuaNodeId(machine.id, OPCUA_METHODS.loadOrder)),
          attributeId: AttributeIds.Executable,
        });
        expect(loadOrder.statusCode.isGood(), machine.id).toBe(machine.kind === 'machine-tool');
      } finally {
        await close();
      }
    }
  }, 60_000);

  it('declares each project event type with the documented fields', async () => {
    const documented = await documentedEventFields();
    expect([...documented.keys()].sort()).toEqual(Object.values(OPCUA_EVENT_TYPES).sort());
    const { session, close } = await connect(port('cnc-01'), reader);
    try {
      for (const [kind, name] of Object.entries(OPCUA_EVENT_TYPES) as [
        keyof typeof OPCUA_EVENT_TYPES,
        string,
      ][]) {
        const browse = await session.browse({
          nodeId: await nodeId(session, opcuaEventTypeId(name)),
          browseDirection: BrowseDirection.Forward,
          referenceTypeId: 'HasProperty',
          resultMask: 63,
        });
        const served = browse.references?.map((r) => r.browseName.name).sort();
        expect(served, name).toEqual(
          [...OPCUA_EVENT_FIELDS.common, ...OPCUA_EVENT_FIELDS[kind]].sort(),
        );
        expect(served, `${name} in the contract`).toEqual([...(documented.get(name) ?? [])].sort());
      }
    } finally {
      await close();
    }
  });
});

describe('OPC UA integration at 60× under SignAndEncrypt (#56, #239, plan section 11, Phase 2 exit criteria)', () => {
  it('lets a generic client find every machine under Machinery/Machines; values follow the chosen speed', async () => {
    for (const machine of OPCUA_MACHINES) {
      const { session, close } = await connect(port(machine.id), reader);
      try {
        const namespaces = await session.readNamespaceArray();
        const machinery = namespaces.indexOf('http://opcfoundation.org/UA/Machinery/');
        const machines = await session.browse({
          nodeId: resolveNodeId(`ns=${String(machinery)};i=1001`),
          resultMask: 63,
        });
        const found = machines.references?.find(
          (r) => r.nodeId.namespace === namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI),
        );
        expect(found?.nodeId.value, machine.id).toBe(machine.id);
      } finally {
        await close();
      }
    }

    const { session, close } = await connect(port('cnc-01'), reader);
    try {
      const load = await nodeId(session, opcuaNodeId('cnc-01', OPCUA_VARIABLES.spindleLoad));
      const read = async () =>
        (
          await session.read({ nodeId: load, attributeId: AttributeIds.Value })
        ).sourceTimestamp?.getTime() ?? 0;
      const before = await read();
      await play(10_000);
      const after = await read();
      expect(after - before).toBe(10 * SECOND * SPEED);
      // A second speed, so that a pacer ignoring its setting can't pass by using the same constant.
      run.pacer.setSpeed(SPEED / 4);
      await play(10_000);
      expect((await read()) - after).toBe((10 * SECOND * SPEED) / 4);
      run.pacer.setSpeed(SPEED);
    } finally {
      await close();
    }
  }, 60_000);

  it('delivers every event of a scripted shift to two clients per server on all five servers, without a gap', async () => {
    const fields = (nsIndex: number) =>
      constructEventFilter([
        ...OPCUA_EVENT_FIELDS.common.map((f) => `${String(nsIndex)}:${f}`),
        'Time',
        'EventType',
      ]);
    const clients = await Promise.all(
      OPCUA_MACHINES.flatMap((machine) =>
        [1, 2].map(async (client) => {
          const connection = await connect(port(machine.id), client === 1 ? gateway : reader);
          const namespaces = await connection.session.readNamespaceArray();
          const subscription = await connection.session.createSubscription2({
            requestedPublishingInterval: 100,
            requestedMaxKeepAliveCount: 20,
            requestedLifetimeCount: 600,
            maxNotificationsPerPublish: 0,
            publishingEnabled: true,
            priority: 1,
          });
          const sequences: number[] = [];
          const times: number[] = [];
          const types: string[] = [];
          const item = await subscription.monitor(
            { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
            {
              samplingInterval: 0,
              queueSize: 5_000,
              discardOldest: false,
              filter: fields(namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI)),
            },
            TimestampsToReturn.Both,
          );
          item.on('changed', (values: unknown) => {
            const [sequence, machineId, time, eventType] = (values as { value: unknown }[]).map(
              (v) => v.value,
            );
            if (machineId === machine.id) {
              sequences.push(Number(sequence));
              times.push((time as Date).getTime());
              types.push(PLANT_EVENT_TYPE.get(String((eventType as NodeId).value)) ?? 'other');
            }
          });
          return {
            machine: machine.id,
            client,
            connection,
            subscription,
            sequences,
            times,
            types,
          };
        }),
      ),
    );
    await wait(300);
    const firstSeq = new Map(servers.servers.map((s) => [s.machineId, s.sequence + 1]));
    const shiftStart = run.simulation.now;
    const startIndex = plantEvents.length;

    // The rest of the morning shift, to 14:00, at 60×. The manual clock advances 1 s of wall time
    // every 5 ms, so the servers publish about 200 times faster than in a real 60× run: stricter.
    await play(Math.ceil((T0 + 8 * HOUR - shiftStart) / SPEED));
    const lastSeq = new Map(servers.servers.map((s) => [s.machineId, s.sequence]));
    for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
      if (clients.every((c) => (c.sequences.at(-1) ?? 0) >= (lastSeq.get(c.machine) ?? 0))) break;
      await wait(100);
    }
    const shiftEvents = plantEvents
      .slice(startIndex)
      .filter((e) => e.type === 'state' || e.type === 'cycle-complete' || e.type === 'alarm');
    expect(shiftEvents.length).toBeGreaterThan(1_000);
    for (const c of clients) {
      const first = firstSeq.get(c.machine) ?? 0;
      const last = lastSeq.get(c.machine) ?? 0;
      expect(last - first, c.machine).toBeGreaterThan(50);
      expect(c.sequences, `${c.machine} client ${String(c.client)}`).toEqual(
        Array.from({ length: last - first + 1 }, (_, i) => first + i),
      );
    }
    for (const machine of OPCUA_MACHINES) {
      const emitted = shiftEvents.filter((e) => 'machineId' in e && e.machineId === machine.id);
      expect((lastSeq.get(machine.id) ?? 0) - (firstSeq.get(machine.id) ?? 0) + 1).toBe(
        emitted.length,
      );
      // Content, not just numbering: event N carries the simulation time of the model's N-th event.
      for (const c of clients.filter((client) => client.machine === machine.id)) {
        expect(c.times, machine.id).toEqual(emitted.map((e) => e.at));
        // And its type (exit criterion 9: every event keeps its (machine, seq, type) under
        // SignAndEncrypt, #239).
        expect(c.types, machine.id).toEqual(emitted.map((e) => e.type));
      }
    }
    await Promise.all(
      clients.map(async (c) => {
        await c.subscription.terminate();
        await c.connection.close();
      }),
    );
  }, 120_000);

  it('carries the lots and the operator of every cycle as fields a generic client reads (address space 1.2, #196)', async () => {
    const machines = ['cnc-01', 'cnc-02', 'asm-01', 'lkt-01'];
    const fieldNames = ['Sequence', 'MachineId', 'PartId', 'LotMaterials', 'LotIds', 'Operator'];
    interface Received {
      readonly partId: number;
      readonly materials: unknown;
      readonly lots: unknown;
      readonly operator: unknown;
      readonly arrays: boolean;
    }
    const clients = await Promise.all(
      machines.map(async (machine) => {
        const connection = await connect(port(machine), reader);
        const namespaces = await connection.session.readNamespaceArray();
        const ns = String(namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI));
        const subscription = await connection.session.createSubscription2({
          requestedPublishingInterval: 100,
          requestedMaxKeepAliveCount: 20,
          requestedLifetimeCount: 600,
          maxNotificationsPerPublish: 0,
          publishingEnabled: true,
          priority: 1,
        });
        const cycles: Received[] = [];
        const others: Received[] = [];
        let last = 0;
        const item = await subscription.monitor(
          { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
          {
            samplingInterval: 0,
            queueSize: 5_000,
            discardOldest: false,
            filter: constructEventFilter(fieldNames.map((f) => `${ns}:${f}`)),
          },
          TimestampsToReturn.Both,
        );
        item.on('changed', (values: unknown) => {
          const variants = values as { value: unknown; dataType: number; arrayType: number }[];
          const [sequence, machineId, partId, materials, lots, operator] = variants;
          if (machineId?.value !== machine) return;
          last = Number(sequence?.value);
          const received = {
            partId: Number(partId?.value),
            materials: materials?.value === null ? null : [...(materials?.value as string[])],
            lots: lots?.value === null ? null : [...(lots?.value as string[])],
            operator: operator?.value,
            arrays: materials?.arrayType === 1 && lots?.arrayType === 1,
          };
          (partId?.dataType === DataType.Null ? others : cycles).push(received);
        });
        return { machine, connection, subscription, cycles, others, last: () => last };
      }),
    );
    await wait(300);
    const startIndex = plantEvents.length;
    // Into shift B, so ASM-01's operator changes on the way.
    await play(Math.ceil((T0 + 9 * HOUR - run.simulation.now) / SPEED));
    const lastSeq = new Map(servers.servers.map((s) => [s.machineId, s.sequence]));
    for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
      if (clients.every((c) => c.last() >= (lastSeq.get(c.machine) ?? 0))) break;
      await wait(100);
    }
    // The truth: trace-core's fold over the whole event stream (consumption before the window
    // attaches to cycles inside it).
    const attachments = attachConsumption(plantEvents);
    for (const c of clients) {
      const expected = plantEvents.flatMap((event, index) => {
        if (index < startIndex || event.type !== 'cycle-complete' || event.machineId !== c.machine)
          return [];
        const attachment = attachments[index];
        return [
          {
            partId: event.partId,
            materials: attachment?.lots.map((lot) => lot.material),
            lots: attachment?.lots.map((lot) => lot.lot),
            operator: attachment?.operator ?? '',
            arrays: true,
          },
        ];
      });
      expect(expected.length, c.machine).toBeGreaterThan(10);
      expect(c.cycles, c.machine).toEqual(expected);
      // Other event types have no such fields: they arrive as Null, not as empty arrays.
      expect(
        c.others.every((o) => o.materials === null && o.lots === null),
        c.machine,
      ).toBe(true);
    }
    expect(clients.reduce((sum, c) => sum + c.others.length, 0)).toBeGreaterThan(0);
    const byMachine = new Map(clients.map((c) => [c.machine, c.cycles]));
    expect(byMachine.get('cnc-01')?.every((r) => (r.materials as string[]).length === 1)).toBe(
      true,
    );
    expect(byMachine.get('cnc-01')?.every((r) => r.operator === '')).toBe(true);
    expect(byMachine.get('lkt-01')?.every((r) => (r.lots as string[]).length === 0)).toBe(true);
    const operators = new Set(byMachine.get('asm-01')?.map((r) => r.operator));
    expect(operators.size).toBeGreaterThanOrEqual(2);
    expect(operators.has('')).toBe(false);
    await Promise.all(
      clients.map(async (c) => {
        await c.subscription.terminate();
        await c.connection.close();
      }),
    );
  }, 120_000);

  it('makes queue overflow visible: a deliberately small queue loses events, and Sequence shows the gap', async () => {
    const { session, close } = await connect(port('cnc-01'), reader);
    try {
      const namespaces = await session.readNamespaceArray();
      const nsIndex = namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI);
      const subscription = await session.createSubscription2({
        requestedPublishingInterval: 2_000,
        requestedMaxKeepAliveCount: 20,
        requestedLifetimeCount: 600,
        maxNotificationsPerPublish: 0,
        publishingEnabled: true,
        priority: 1,
      });
      const sequences: number[] = [];
      const item = await subscription.monitor(
        { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
        {
          samplingInterval: 0,
          // node-opcua revises an event queue to at least 100 entries (and at most 5000).
          queueSize: 3,
          discardOldest: true,
          filter: constructEventFilter([
            `${String(nsIndex)}:Sequence`,
            `${String(nsIndex)}:MachineId`,
          ]),
        },
        TimestampsToReturn.Both,
      );
      item.on('changed', (values: unknown) => {
        const [sequence, machineId] = (values as { value: unknown }[]).map((v) => v.value);
        if (machineId === 'cnc-01') {
          sequences.push(Number(sequence));
        }
      });
      await wait(300);
      const first = (servers.servers.find((s) => s.machineId === 'cnc-01')?.sequence ?? 0) + 1;
      expect(item.result?.revisedQueueSize).toBe(100);
      // One burst: a day of simulation in one tick, far more events than the queue holds.
      run.pacer.resume();
      clock.advance((24 * HOUR) / SPEED);
      run.pacer.pause();
      const last = servers.servers.find((s) => s.machineId === 'cnc-01')?.sequence ?? 0;
      expect(last - first).toBeGreaterThan(150);
      await wait(4_500);
      // The overflow signature: with discardOldest, only the newest 100 queue entries survive, as one
      // unbroken tail ending at the last event. The queue also holds the Machinery TransitionEvents
      // (filtered out above), so fewer than 100 of the survivors are project events. node-opcua raises
      // no EventQueueOverflow event for event items, so the jump in Sequence is the only sign.
      expect(sequences.length).toBeGreaterThan(10);
      expect(sequences.length).toBeLessThanOrEqual(100);
      expect(sequences).toEqual(
        Array.from({ length: sequences.length }, (_, i) => last - sequences.length + 1 + i),
      );
      expect(sequences[0]).toBeGreaterThan(first);
      // Resynchronisation (ADR-0009): the Sequence variable says how far the server got.
      const current = await session.read({
        nodeId: resolveNodeId(
          toIndexedNodeId(opcuaNodeId('cnc-01', OPCUA_VARIABLES.sequence), namespaces),
        ),
        attributeId: AttributeIds.Value,
      });
      expect(current.value.value).toBe(last);
      await subscription.terminate();
    } finally {
      await close();
    }
  }, 60_000);
});
