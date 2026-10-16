/**
 * `LoadOrder` over OPC UA in production mode `orders` (#172, ADR-0030): acceptance outputs from the
 * device's own sequence, dedup first (a late or wrong-epoch call for an accepted job answers
 * `Duplicate`), the device's epoch and expiry checks with the offending argument flagged, the job
 * event and the job variables, no initial `Program`, and `LoadProgram` refused. The run is attached
 * and idle at its start time, as a live dispatch finds it (B3).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOAD_ORDER_INPUTS,
  OPCUA_EVENT_FIELDS,
  OPCUA_EVENT_TYPES,
  OPCUA_METHODS,
  OPCUA_VARIABLES,
  SHOPFLOOR_NAMESPACE_URI,
  opcuaEventTypeId,
  opcuaNodeId,
  toIndexedNodeId,
} from '@shopfloor/contracts';
import { HOUR } from '@shopfloor/sim-core';
import {
  AttributeIds,
  DataType,
  TimestampsToReturn,
  constructEventFilter,
  resolveNodeId,
  type ClientSession,
  type VariantOptions,
} from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { PlantServers } from './plant-servers.ts';
import { connect, wait } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
const OFFSET = 600;
const EPOCH = 1_791_000_000;
const WALL = Date.UTC(2026, 9, 16, 12);
let servers: PlantServers;
let run: LiveRun;
const plantEvents: PlantEvent[] = [];

beforeAll(async () => {
  const config = await loadDefaultConfig();
  servers = new PlantServers({
    config,
    start: T0,
    portOffset: OFFSET,
    epoch: EPOCH,
    production: 'orders',
    wallClock: () => WALL,
    pkiFolder: join(tmpdir(), 'shopfloor-twin-load-order-pki'),
  });
  run = createLiveRun({
    config,
    seed: 20261012,
    start: T0,
    speed: 60,
    clock: new ManualClock(),
    production: 'orders',
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

interface Call {
  readonly commandId?: string;
  readonly orderId?: string;
  readonly product?: string;
  readonly quantity?: number;
  readonly notBefore?: number;
  readonly deviceEpoch?: number;
  readonly expiresAt?: number;
}

async function loadOrder(session: ClientSession, machine: string, call: Call = {}) {
  const namespaces = await session.readNamespaceArray();
  const args: VariantOptions[] = [
    { dataType: DataType.String, value: call.commandId ?? 'PO-1~OP10~1' },
    { dataType: DataType.String, value: call.orderId ?? 'PO-1' },
    { dataType: DataType.String, value: call.product ?? 'VB-100' },
    { dataType: DataType.UInt32, value: call.quantity ?? 4 },
    { dataType: DataType.DateTime, value: new Date(call.notBefore ?? T0) },
    { dataType: DataType.UInt32, value: call.deviceEpoch ?? EPOCH },
    { dataType: DataType.DateTime, value: new Date(call.expiresAt ?? WALL + 60_000) },
  ];
  const result = await session.call({
    objectId: resolveNodeId(
      toIndexedNodeId(`nsu=${SHOPFLOOR_NAMESPACE_URI};s=${machine}.ShopFloor`, namespaces),
    ),
    methodId: resolveNodeId(
      toIndexedNodeId(opcuaNodeId(machine, OPCUA_METHODS.loadOrder), namespaces),
    ),
    inputArguments: args,
  });
  return {
    status: result.statusCode.name,
    flagged: (result.inputArgumentResults ?? [])
      .map((r, i) => (r.name === 'Good' ? undefined : `${LOAD_ORDER_INPUTS[i] ?? '?'} ${r.name}`))
      .filter((x) => x !== undefined),
    outputs: (result.outputArguments ?? []).map((o) =>
      o.value instanceof Date ? o.value.getTime() : (o.value as unknown),
    ),
  };
}

async function read(session: ClientSession, machine: string, path: string): Promise<unknown> {
  const namespaces = await session.readNamespaceArray();
  const value = await session.read({
    nodeId: resolveNodeId(toIndexedNodeId(opcuaNodeId(machine, path), namespaces)),
    attributeId: AttributeIds.Value,
  });
  return value.value.value as unknown;
}

describe('LoadOrder over OPC UA in orders mode (#172)', () => {
  it('accepts a job with the acceptance from the device sequence, raises its event and shows the queue', async () => {
    const { session, close } = await connect(4841 + OFFSET);
    try {
      expect(run.pacer.state).toBe('idle');
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.program)).toBe('');
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.queuedJobs)).toBe(0);
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.stateCause)).toBe('NO-ORDER');

      const namespaces = await session.readNamespaceArray();
      const ns = String(namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI));
      const subscription = await session.createSubscription2({
        requestedPublishingInterval: 50,
        requestedMaxKeepAliveCount: 20,
        requestedLifetimeCount: 600,
        maxNotificationsPerPublish: 0,
        publishingEnabled: true,
        priority: 1,
      });
      const fields = [...OPCUA_EVENT_FIELDS.common, ...OPCUA_EVENT_FIELDS.job];
      const item = await subscription.monitor(
        { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
        {
          samplingInterval: 0,
          queueSize: 100,
          discardOldest: false,
          filter: constructEventFilter([...fields.map((f) => `${ns}:${f}`), 'EventType']),
        },
        TimestampsToReturn.Both,
      );
      const jobType = resolveNodeId(
        toIndexedNodeId(opcuaEventTypeId(OPCUA_EVENT_TYPES.job), namespaces),
      ).toString();
      const received: unknown[][] = [];
      item.on('changed', (values: unknown) => {
        const row = (values as { value: unknown }[]).map((v) => v.value);
        if (String(row.at(-1)) === jobType) received.push(row.slice(0, -1));
      });
      await wait(200);

      const before = servers.servers[0]?.sequence ?? 0;
      const accepted = await loadOrder(session, 'cnc-01');
      expect(accepted).toEqual({
        status: 'Good',
        flagged: [],
        outputs: [1, false, before + 1, T0],
      });
      expect(servers.servers[0]?.acceptance('PO-1~OP10~1')).toEqual({ seq: before + 1, at: T0 });
      // The dispatch moved the idle CNC to its first changeover at the same instant.
      expect(
        plantEvents.filter((e) => e.type === 'state' && e.machineId === 'cnc-01').at(-1),
      ).toMatchObject({
        at: T0,
        to: 'Setup',
        cause: 'CHANGEOVER none→VB-100',
      });
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.queuedJobs)).toBe(1);
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.program)).toBe('VB-100');
      for (let deadline = Date.now() + 10_000; Date.now() < deadline && received.length < 1;) {
        await wait(50);
      }
      expect(received[0]?.map((v) => (typeof v === 'number' ? v : String(v)))).toEqual([
        before + 1,
        'cnc-01',
        'accepted',
        'PO-1~OP10~1',
        'PO-1',
        'VB-100',
        4,
      ]);
      await subscription.terminate();
    } finally {
      await close();
    }
  }, 60_000);

  it('answers a late or wrong-epoch call for an accepted command as a duplicate with the original acceptance', async () => {
    const { session, close } = await connect(4841 + OFFSET);
    try {
      const first = servers.servers[0]?.acceptance('PO-1~OP10~1');
      const late = await loadOrder(session, 'cnc-01', {
        expiresAt: WALL - 1,
        deviceEpoch: EPOCH + 1,
      });
      expect(late).toEqual({ status: 'Good', flagged: [], outputs: [1, true, first?.seq, T0] });
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.queuedJobs)).toBe(1);
      const conflict = await loadOrder(session, 'cnc-01', { quantity: 5 });
      expect(conflict).toMatchObject({
        status: 'BadInvalidArgument',
        flagged: ['CommandId BadInvalidArgument'],
        outputs: [],
      });
    } finally {
      await close();
    }
  }, 60_000);

  it.each<[string, Call, string, string[]]>([
    [
      'another device epoch',
      { deviceEpoch: EPOCH - 1 },
      'BadInvalidState',
      ['DeviceEpoch BadInvalidState'],
    ],
    [
      'an expired command',
      { expiresAt: WALL - 1 },
      'BadInvalidState',
      ['ExpiresAt BadInvalidState'],
    ],
    [
      'an unknown product',
      { product: 'VB-999' },
      'BadInvalidArgument',
      ['Product BadInvalidArgument'],
    ],
    ['a zero quantity', { quantity: 0 }, 'BadInvalidArgument', ['Quantity BadInvalidArgument']],
  ])(
    'refuses %s on a miss with the argument flagged',
    async (_case, call, status, flagged) => {
      const { session, close } = await connect(4842 + OFFSET);
      try {
        const sequence = servers.servers[1]?.sequence;
        const refused = await loadOrder(session, 'cnc-02', { ...call, commandId: 'PO-2~OP10~1' });
        expect(refused).toEqual({ status, flagged, outputs: [] });
        expect(servers.servers[1]?.sequence).toBe(sequence);
        expect(servers.servers[1]?.acceptance('PO-2~OP10~1')).toBeUndefined();
      } finally {
        await close();
      }
    },
    60_000,
  );

  it('refuses LoadProgram in orders mode', async () => {
    const { session, close } = await connect(4842 + OFFSET);
    try {
      const namespaces = await session.readNamespaceArray();
      const result = await session.call({
        objectId: resolveNodeId(
          toIndexedNodeId(`nsu=${SHOPFLOOR_NAMESPACE_URI};s=cnc-02.ShopFloor`, namespaces),
        ),
        methodId: resolveNodeId(
          toIndexedNodeId(opcuaNodeId('cnc-02', OPCUA_METHODS.loadProgram), namespaces),
        ),
        inputArguments: [
          { dataType: DataType.String, value: 'VB-100' },
          { dataType: DataType.UInt32, value: 1 },
        ],
      });
      expect(result.statusCode.name).toBe('BadInvalidState');
    } finally {
      await close();
    }
  }, 60_000);

  it('shows the active order while the job runs and clears it at its last OP10 cycle', async () => {
    const { session, close } = await connect(4841 + OFFSET);
    try {
      while (run.simulation.now < T0 + 2 * HOUR && run.pacer.step()) {
        if (plantEvents.some((e) => e.type === 'job' && e.transition === 'started')) break;
      }
      await wait(100);
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.activeOrder)).toBe('PO-1');
      while (run.simulation.now < T0 + 3 * HOUR && run.pacer.step()) {
        if (plantEvents.some((e) => e.type === 'job' && e.transition === 'completed')) break;
      }
      await wait(100);
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.activeOrder)).toBe('');
      expect(await read(session, 'cnc-01', OPCUA_VARIABLES.queuedJobs)).toBe(0);
      expect(plantEvents.flatMap((e) => (e.type === 'job' ? [e.transition] : []))).toEqual([
        'accepted',
        'started',
        'completed',
      ]);
    } finally {
      await close();
    }
  }, 60_000);
});
