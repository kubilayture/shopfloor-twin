import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPCUA_EVENT_FIELDS,
  OPCUA_METHODS,
  OPCUA_VARIABLES,
  SHOPFLOOR_NAMESPACE_URI,
  opcuaEndpoint,
  opcuaNodeId,
  toIndexedNodeId,
} from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR } from '@shopfloor/sim-core';
import {
  AttributeIds,
  DataType,
  OPCUAClient,
  TimestampsToReturn,
  constructEventFilter,
  resolveNodeId,
  type ClientSession,
} from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { machineryItemState, machineryOperationMode } from './machinery-state.ts';
import { PlantServers } from './plant-servers.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
const OFFSET = 200;
let config: PlantConfig;
let servers: PlantServers;
let run: LiveRun;
let clock: ManualClock;
const plantEvents: PlantEvent[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(
  port: number,
): Promise<{ session: ClientSession; close: () => Promise<void> }> {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 2 },
  });
  await client.connect(opcuaEndpoint('localhost', port));
  const session = await client.createSession();
  return {
    session,
    close: async () => {
      await session.close();
      await client.disconnect();
    },
  };
}

beforeAll(async () => {
  config = await loadDefaultConfig();
  clock = new ManualClock();
  servers = new PlantServers({
    config,
    start: T0,
    portOffset: OFFSET,
    pkiFolder: join(tmpdir(), 'shopfloor-twin-test-pki'),
  });
  run = createLiveRun({
    config,
    seed: 11,
    start: T0,
    speed: 60,
    clock,
    onEvent: (event) => {
      plantEvents.push(event);
      servers.record(event);
    },
  });
  servers.attach(run);
  await servers.start();
}, 60_000);

afterAll(async () => {
  run.pacer.stop();
  await servers.stop();
});

describe('OPC UA servers (ADR-0008, ADR-0009)', () => {
  it('serves every OPC UA machine with the project namespace and the Machinery building blocks', async () => {
    for (const server of servers.servers) {
      const { session, close } = await connect(server.port);
      try {
        const namespaces = await session.readNamespaceArray();
        expect(namespaces).toContain(SHOPFLOOR_NAMESPACE_URI);
        expect(namespaces).toContain('http://opcfoundation.org/UA/Machinery/');
        const state = await session.read({
          nodeId: resolveNodeId(
            toIndexedNodeId(opcuaNodeId(server.machineId, OPCUA_VARIABLES.state), namespaces),
          ),
          attributeId: AttributeIds.Value,
        });
        expect(state.statusCode.isGood()).toBe(true);
        const browse = await session.browse({
          nodeId: resolveNodeId(
            toIndexedNodeId(
              `nsu=${SHOPFLOOR_NAMESPACE_URI};s=${server.machineId}.ShopFloor`,
              namespaces,
            ),
          ),
          resultMask: 63,
        });
        expect(browse.references?.map((r) => r.browseName.name)).toEqual(
          expect.arrayContaining(['State', 'StateCause', 'Sequence', 'Counters']),
        );
      } finally {
        await close();
      }
    }
  }, 60_000);

  it('delivers every state and cycle event in order with a gap-free sequence, at 60×', async () => {
    const { session, close } = await connect(4841 + OFFSET);
    try {
      const fields = [...OPCUA_EVENT_FIELDS.common.map((f) => `1:${f}`), 'Time', 'EventType'];
      const namespaces = await session.readNamespaceArray();
      const nsIndex = namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI);
      const filter = constructEventFilter(
        fields.map((f) => f.replace('1:', `${String(nsIndex)}:`)),
      );
      const subscription = await session.createSubscription2({
        requestedPublishingInterval: 50,
        requestedMaxKeepAliveCount: 20,
        requestedLifetimeCount: 600,
        maxNotificationsPerPublish: 0,
        publishingEnabled: true,
        priority: 1,
      });
      const received: { sequence: number; machine: string; time: Date }[] = [];
      const isCncFact = (e: PlantEvent) =>
        (e.type === 'state' || e.type === 'cycle-complete') && e.machineId === 'cnc-01';
      const beforeSubscription = plantEvents.filter(isCncFact).length;
      const item = await subscription.monitor(
        { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
        { samplingInterval: 0, queueSize: 10_000, discardOldest: false, filter },
        TimestampsToReturn.Both,
      );
      item.on('changed', (values: unknown) => {
        const v = values as { value: unknown }[];
        received.push({
          sequence: Number(v[0]?.value),
          machine: String(v[1]?.value),
          time: v[2]?.value as Date,
        });
      });
      await wait(300);
      run.pacer.start();
      for (let i = 0; i < 120; i++) {
        clock.advance(1_000);
        await wait(5);
      }
      run.pacer.pause();
      const expected = plantEvents.filter(isCncFact);
      const ours = () => received.filter((r) => r.machine === 'cnc-01');
      for (let deadline = Date.now() + 15_000; Date.now() < deadline;) {
        if ((ours().at(-1)?.sequence ?? 0) >= expected.length) break;
        await wait(50);
      }
      const firstSeen = beforeSubscription + 1;
      expect(ours().map((r) => r.sequence)).toEqual(
        Array.from({ length: expected.length - firstSeen + 1 }, (_, i) => firstSeen + i),
      );
      expect(ours().length).toBeGreaterThan(20);
      expect(ours().at(-1)?.time.getTime()).toBe(expected.at(-1)?.at);
      await subscription.terminate();
    } finally {
      await close();
    }
  }, 60_000);

  it('exposes current values with simulation time as SourceTimestamp, and telemetry', async () => {
    const { session, close } = await connect(4841 + OFFSET);
    try {
      const namespaces = await session.readNamespaceArray();
      const read = (path: string) =>
        session.read({
          nodeId: resolveNodeId(toIndexedNodeId(opcuaNodeId('cnc-01', path), namespaces)),
          attributeId: AttributeIds.Value,
        });
      const lastState = plantEvents
        .filter((e) => e.type === 'state' && e.machineId === 'cnc-01')
        .at(-1);
      const state = await read(OPCUA_VARIABLES.state);
      expect(state.value.value).toBe(lastState?.type === 'state' ? lastState.to : undefined);
      expect(state.sourceTimestamp?.getTime()).toBe(lastState?.at);
      const produced = await read(OPCUA_VARIABLES.produced);
      const cycles = plantEvents.filter(
        (e) => e.type === 'cycle-complete' && e.machineId === 'cnc-01',
      ).length;
      expect(produced.value.value).toBe(cycles);
      const program = await read(OPCUA_VARIABLES.program);
      expect(program.value.value).toBe('VB-100');
      const load = await read(OPCUA_VARIABLES.spindleLoad);
      expect(load.statusCode.isGood()).toBe(true);
      expect(load.sourceTimestamp?.getTime()).toBe(run.simulation.now);
      const reading = run.processValues.read('cnc-01', run.simulation.now);
      expect(load.value.value).toBe(reading?.spindleLoadPercent);
      expect(run.simulation.now - T0).toBeGreaterThan(HOUR);
    } finally {
      await close();
    }
  }, 60_000);

  it('switches the CNC program through the LoadProgram method', async () => {
    const { session, close } = await connect(4841 + OFFSET);
    try {
      const namespaces = await session.readNamespaceArray();
      const objectId = resolveNodeId(
        toIndexedNodeId(`nsu=${SHOPFLOOR_NAMESPACE_URI};s=cnc-01.ShopFloor`, namespaces),
      );
      const methodId = resolveNodeId(
        toIndexedNodeId(opcuaNodeId('cnc-01', OPCUA_METHODS.loadProgram), namespaces),
      );
      const bad = await session.call({
        objectId,
        methodId,
        inputArguments: [
          { dataType: DataType.String, value: 'VB-999' },
          { dataType: DataType.UInt32, value: 2 },
        ],
      });
      expect(bad.statusCode.name).toBe('BadInvalidArgument');
      const good = await session.call({
        objectId,
        methodId,
        inputArguments: [
          { dataType: DataType.String, value: 'VB-200' },
          { dataType: DataType.UInt32, value: 50 },
        ],
      });
      expect(good.statusCode.isGood()).toBe(true);
      expect(good.outputArguments?.[0]?.value).toBe(1);
      expect(plantEvents.at(-1)).toMatchObject({
        type: 'program-loaded',
        machineId: 'cnc-01',
        product: 'VB-200',
        quantity: 50,
      });
      run.pacer.resume();
      for (let i = 0; i < 60; i++) {
        clock.advance(1_000);
        await wait(5);
      }
      run.pacer.pause();
      await wait(200);
      const program = await session.read({
        nodeId: resolveNodeId(
          toIndexedNodeId(opcuaNodeId('cnc-01', OPCUA_VARIABLES.program), namespaces),
        ),
        attributeId: AttributeIds.Value,
      });
      expect(program.value.value).toBe('VB-200');
    } finally {
      await close();
    }
  }, 60_000);

  it('maps the project state onto the Machinery item state and operation mode', () => {
    expect(machineryItemState('Running')).toBe('Executing');
    expect(machineryItemState('Down')).toBe('OutOfService');
    expect(machineryItemState('Off')).toBe('NotAvailable');
    expect(machineryItemState('Blocked')).toBe('NotExecuting');
    expect(machineryOperationMode('Setup')).toBe('Setup');
    expect(machineryOperationMode('Maintenance')).toBe('Maintenance');
    expect(machineryOperationMode('Off')).toBe('None');
    expect(machineryOperationMode('Starved')).toBe('Processing');
  });
});
