import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPCUA_EVENT_FIELDS,
  OPCUA_EVENT_TYPES,
  OPCUA_METHODS,
  OPCUA_VARIABLES,
  SHOPFLOOR_NAMESPACE_URI,
  opcuaAlarmPath,
  opcuaEventTypeId,
  opcuaNodeId,
  toIndexedNodeId,
} from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR } from '@shopfloor/sim-core';
import {
  AttributeIds,
  DataType,
  TimestampsToReturn,
  constructEventFilter,
  resolveNodeId,
} from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import {
  CALIBRATION_ALARM_CODE,
  CALIBRATION_ALARM_SEVERITY,
  type PlantEvent,
} from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { machineryItemState, machineryOperationMode } from './machinery-state.ts';
import { PlantServers, alarmCodes } from './plant-servers.ts';
import { connect, wait } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
const OFFSET = 200;
let config: PlantConfig;
let servers: PlantServers;
let run: LiveRun;
let clock: ManualClock;
const plantEvents: PlantEvent[] = [];

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
        (e.type === 'state' || e.type === 'cycle-complete' || e.type === 'alarm') &&
        e.machineId === 'cnc-01';
      const beforeSubscription = plantEvents.filter(isCncFact).length;
      const item = await subscription.monitor(
        { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
        { samplingInterval: 0, queueSize: 5_000, discardOldest: false, filter },
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
      expect(bad.inputArgumentResults?.map((r) => r.name)).toEqual(['BadInvalidArgument', 'Good']);
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

  it('exposes alarm states and raises an alarm event per transition (ADR-0010)', async () => {
    const port = 4844 + OFFSET;
    const { session, close } = await connect(port);
    try {
      const namespaces = await session.readNamespaceArray();
      const nsIndex = namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI);
      const read = async (path: string) =>
        (
          await session.read({
            nodeId: resolveNodeId(toIndexedNodeId(opcuaNodeId('lkt-01', path), namespaces)),
            attributeId: AttributeIds.Value,
          })
        ).value.value as unknown;
      expect(alarmCodes(config, 'lkt-01')).toEqual(['FIXTURE-SEAL', CALIBRATION_ALARM_CODE]);
      expect(alarmCodes(config, 'cnc-01')).toEqual(['SPINDLE-OVERLOAD', 'COOLANT-PRESSURE']);
      for (const code of alarmCodes(config, 'lkt-01')) {
        expect(await read(opcuaAlarmPath(code))).toBe(false);
      }
      const fields = [
        ...[...OPCUA_EVENT_FIELDS.common, ...OPCUA_EVENT_FIELDS.alarm].map(
          (f) => `${String(nsIndex)}:${f}`,
        ),
        'Severity',
        'EventType',
      ];
      const subscription = await session.createSubscription2({
        requestedPublishingInterval: 50,
        requestedMaxKeepAliveCount: 20,
        requestedLifetimeCount: 600,
        maxNotificationsPerPublish: 0,
        publishingEnabled: true,
        priority: 1,
      });
      const received: unknown[][] = [];
      const item = await subscription.monitor(
        { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
        {
          samplingInterval: 0,
          queueSize: 100,
          discardOldest: false,
          filter: constructEventFilter(fields),
        },
        TimestampsToReturn.Both,
      );
      const alarmType = resolveNodeId(
        toIndexedNodeId(opcuaEventTypeId(OPCUA_EVENT_TYPES.alarm), namespaces),
      ).toString();
      item.on('changed', (values: unknown) => {
        const row = (values as { value: unknown }[]).map((v) => v.value);
        if (String(row.at(-1)) === alarmType) {
          received.push(row);
        }
      });
      expect(run.pacer.state).toBe('paused');
      await wait(300);
      const before = servers.servers.find((s) => s.machineId === 'lkt-01')?.sequence ?? 0;
      const at = run.simulation.now;
      const alarm = (transition: 'active' | 'cleared'): PlantEvent => ({
        type: 'alarm',
        at,
        machineId: 'lkt-01',
        code: CALIBRATION_ALARM_CODE,
        transition,
        severity: CALIBRATION_ALARM_SEVERITY,
      });
      servers.record(alarm('active'));
      expect(await read(opcuaAlarmPath(CALIBRATION_ALARM_CODE))).toBe(true);
      expect(await read(OPCUA_VARIABLES.alarmsActiveCount)).toBe(1);
      servers.record(alarm('cleared'));
      expect(await read(opcuaAlarmPath(CALIBRATION_ALARM_CODE))).toBe(false);
      expect(await read(OPCUA_VARIABLES.alarmsActiveCount)).toBe(0);
      for (let deadline = Date.now() + 10_000; Date.now() < deadline && received.length < 2;) {
        await wait(50);
      }
      expect(
        received.map(([sequence, machine, code, transition, severity, type]) => [
          Number(sequence),
          machine,
          code,
          transition,
          severity,
          String(type),
        ]),
      ).toEqual([
        [
          before + 1,
          'lkt-01',
          CALIBRATION_ALARM_CODE,
          'active',
          CALIBRATION_ALARM_SEVERITY,
          alarmType,
        ],
        [
          before + 2,
          'lkt-01',
          CALIBRATION_ALARM_CODE,
          'cleared',
          CALIBRATION_ALARM_SEVERITY,
          alarmType,
        ],
      ]);
      await subscription.terminate();
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
