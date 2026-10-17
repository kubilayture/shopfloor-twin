/**
 * Phase 7 exit criterion 3, the MES's cases (#174): real Mosquitto, the edge gateway as its own
 * process and the simulator in production mode `orders` (idle at its start time), with the MES's
 * ingest, master data and orders module on a real database. Orders are imported from a fake ERP,
 * released and dispatched; the outbox publishes `cmd/load-order` on the MES's own connection.
 * TCP proxies hold or cut the OPC UA connections, take the broker away from the gateway, or from
 * the MES's ingest.
 *
 * Every case ends with, for every order, the blanks of the jobs the device accepted (per run) at
 * most the order quantity, and for every command id at most one `accepted` job fact per run; the
 * MES's reading of every command agrees with the device.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { expandErpDataset, type FeedEntry } from '@shopfloor/contracts/erp-api';
import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { TEST_PASSWORDS, startBroker } from '@shopfloor/test-kit/broker';
import {
  TcpProxy,
  opcuaProxies,
  startGateway,
  startSimulator,
  type RunningGateway,
  type RunningSimulator,
  type SimEvent,
} from '@shopfloor/test-kit/processes';
import type { Kysely } from 'kysely';
import mqtt, { type MqttClient } from 'mqtt';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { PLANT_CONFIG, freshDatabase } from './modules/equipment/test-support.ts';
import { Identity } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData, erpMasterData } from './modules/master-data/index.ts';
import {
  MqttCommandPublisher,
  Orders,
  type CommandRecord,
  type CommandTimings,
  type ErpApi,
  type FeedPage,
  type PostOutcome,
} from './modules/orders/index.ts';
import { startDatabase } from './testing.ts';

// The simulator's ports, the OPC UA proxies' block and the proxies' ports are chosen at runtime
// (#212), the broker's by Docker, the gateway's HTTP port per start.
const SIM_ENV = { SIM_PRODUCTION: 'orders' };
const DEADLINE_MS = 1_500;

/** The broker's host port, as Docker mapped it (the broker is never restarted here). */
let brokerPort = 0;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !(await condition());) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await wait(100);
  }
}

const get = (url: string): Promise<string> =>
  fetch(url, { signal: AbortSignal.timeout(2_000) })
    .then((r) => r.text())
    .catch(() => '');

/** The ERP: a feed of the orders the test adds; every message stored. */
class TestErp implements ErpApi {
  readonly entries: FeedEntry[] = [];
  feed(after: number, limit: number): Promise<FeedPage> {
    const entries = this.entries.slice(after, after + limit);
    return Promise.resolve({
      kind: 'page',
      page: {
        feedId: 'e'.repeat(32),
        entries,
        cursor: entries.at(-1)?.feedSeq ?? after,
        more: after + entries.length < this.entries.length,
      },
    });
  }
  post(kind: 'status' | 'confirmation', key: string): Promise<PostOutcome> {
    return Promise.resolve({
      kind: 'stored',
      status: 201,
      receipt: {
        idempotencyKey: key,
        kind,
        orderNumber: key.split('~')[0] ?? '',
        receivedSeq: 1,
        receivedAt: new Date().toISOString(),
      },
    });
  }
}

let plant: PlantConfig;
let container: StartedTestContainer;
let db: Kysely<Database>;
let simulator: RunningSimulator;
let broker: StartedTestContainer;
let gateway: RunningGateway;
let ingest: Ingest;
let masterData: MasterData;
let publisher: MqttCommandPublisher;
let orders: Orders;
let opcua = new Map<string, TcpProxy>();
let brokerProxy: TcpProxy;
let ingestProxy: TcpProxy;
const erp = new TestErp();
const pastRuns: SimEvent[][] = [];
const quantities = new Map<string, number>();
const dir = mkdtempSync(join(tmpdir(), 'mes-orders-e2e-'));
let by: { userId: number; username: string; roles: 'supervisor'[] };
/** A client of the test's own: `mes` reads every command published (to deliver one twice). */
let listener: MqttClient;
const deliveries: { topic: string; payload: string }[] = [];

const gatewayEnv = {
  MQTT_URL: '', // the broker proxy's, once it listens
  MQTT_PASSWORD: TEST_PASSWORDS['gw-01'],
  OPCUA_HOST: 'localhost',
  OPCUA_PORT_OFFSET: '', // the OPC UA proxies' block, once chosen
  OPCUA_PKI_DIR: join(dir, 'pki'),
  MODBUS_PORT: '', // the simulator's, once started
  BUFFER_PATH: join(dir, 'buffer', 'gateway.db'),
  GATEWAY_CALL_DEADLINE_MS: String(DEADLINE_MS),
};

async function gatewayReady(): Promise<boolean> {
  const text = await get(`${gateway.http}/metrics`);
  return (
    (await get(`${gateway.http}/health/ready`)).includes('ok') &&
    ['cnc-01', 'cnc-02'].every((m) => text.includes(`gateway_device_connected{machine="${m}"} 1`))
  );
}

/** A fresh orders module (the MES restarted) with these command timings. */
async function startOrders(
  timings: Partial<CommandTimings>,
  withPublisher = true,
  beforePublish?: (commandId: string) => Promise<void>,
): Promise<Orders> {
  await orders.stop();
  orders = new Orders({
    db,
    ingest,
    masterData,
    ...(withPublisher ? { publisher } : {}),
    ...(beforePublish ? { beforePublish } : {}),
    erp,
    tickMs: 200,
    erpPollMs: 0,
    erpPostMs: 0,
    timings,
  });
  await orders.start();
  return orders;
}

let numbers = 0;
/** Imports a new order and releases it; returns its id and version. */
async function released(
  product = 'VB-200',
  quantity = 2,
): Promise<{ id: string; version: number }> {
  numbers++;
  const id = `PO-M${String(numbers)}`;
  quantities.set(id, quantity);
  const expanded = expandErpDataset(
    {
      orders: [
        {
          orderNumber: id,
          revision: 1,
          product,
          quantity,
          plannedStart: '2026-10-12T06:00:00+03:00',
          dueDate: '2026-10-12T14:00:00+03:00',
        },
      ],
    },
    erpMasterData(plant),
  );
  if (!expanded.ok) throw new Error(expanded.issues.join(', '));
  erp.entries.push(...expanded.feed.map((e) => ({ ...e, feedSeq: erp.entries.length + 1 })));
  await orders.importNow();
  const imported = await orders.order(id);
  if (!imported) throw new Error(`${id} not imported`);
  const order = await orders.release(id, { version: imported.version }, { by });
  return { id, version: order.version };
}

async function dispatch(product = 'VB-200', quantity = 2, equipment = 'cnc-01') {
  const order = await released(product, quantity);
  const result = await orders.dispatch(order.id, { version: order.version, equipment }, { by });
  return result.command;
}

const command = async (commandId: string): Promise<CommandRecord> => {
  const [found] = await orders.commands({ commandIds: [commandId] });
  if (!found) throw new Error(commandId);
  return found;
};

/** `accepted` facts of the command on the device, this run or all runs. */
const deviceAccepted = (commandId: string, runs: 'current' | 'all' = 'all'): number =>
  (runs === 'all' ? [...pastRuns, simulator.events] : [simulator.events])
    .flat()
    .filter((e) => e.type === 'job' && e.transition === 'accepted' && e.commandId === commandId)
    .length;

const proxy = (machine: string): TcpProxy => {
  const p = opcua.get(machine);
  if (!p) throw new Error(machine);
  return p;
};

/** A gauge of the gateway's `/metrics`, optionally of one `result` label; NaN when absent. */
async function gatewayMetric(name: string, result?: string): Promise<number> {
  const text = await get(`${gateway.http}/metrics`);
  const label = result === undefined ? '' : `\\{result="${result}"\\}`;
  const found = new RegExp(`^${name}${label} (\\S+)$`, 'm').exec(text)?.[1];
  return found === undefined ? Number.NaN : Number(found);
}

let injected = 0;
/** Publishes a `cmd-res` as the gateway's own user (`gw-01`), as its settle step would. */
async function injectResult(message: {
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  readonly value: Record<string, unknown>;
}): Promise<void> {
  const injector = await mqtt.connectAsync(`mqtt://127.0.0.1:${String(brokerPort)}`, {
    username: 'gw-01',
    password: TEST_PASSWORDS['gw-01'],
    protocolVersion: 5,
    clientId: `mes-orders-e2e-gateway-voice-${String(message.seq)}`,
  });
  try {
    await injector.publishAsync(
      `orbis/gebze/machining/cell-m1/${message.equipment}/cmd-res/load-order`,
      JSON.stringify({
        schema: 'uns.cmd-res/1',
        scope: 'topic',
        epoch: message.epoch,
        seq: message.seq,
        source: { id: message.equipment, protocol: 'opcua' },
        respondedAt: new Date().toISOString(),
        value: message.value,
      }),
      { qos: 1 },
    );
  } finally {
    await injector.endAsync(true);
  }
}

beforeAll(async () => {
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  let serverUrl: string;
  ({ url: serverUrl, container } = await startDatabase());
  db = await freshDatabase(serverUrl, 'orders_e2e');
  masterData = new MasterData(db);
  await masterData.seed(plant);
  const user = await new Identity({
    db,
    sweepMs: 0,
    hashParams: { N: 1024, r: 8, p: 1 },
  }).createUser(
    { username: 'sup', roles: ['supervisor'], password: 'a-long-test-password' },
    { system: 'test' },
  );
  by = { userId: user.id, username: 'sup', roles: ['supervisor'] };
  simulator = await startSimulator(undefined, SIM_ENV);
  const block = await opcuaProxies(OPCUA_MACHINES, simulator.opcuaOffset);
  opcua = block.proxies;
  broker = (await startBroker()).container;
  brokerPort = broker.getMappedPort(1883);
  brokerProxy = await TcpProxy.start(0, { host: '127.0.0.1', port: brokerPort });
  ingestProxy = await TcpProxy.start(0, { host: '127.0.0.1', port: brokerPort });
  gatewayEnv.MQTT_URL = `mqtt://127.0.0.1:${String(brokerProxy.port)}`;
  gatewayEnv.OPCUA_PORT_OFFSET = String(block.offset);
  gatewayEnv.MODBUS_PORT = String(simulator.modbusPort);
  ingest = new Ingest({
    db,
    url: `mqtt://127.0.0.1:${String(ingestProxy.port)}`,
    username: 'mes',
    password: TEST_PASSWORDS.mes,
    clientId: 'mes-orders-e2e',
    gapGraceMs: 60_000,
  });
  await ingest.start();
  await ingest.waitSubscribed();
  publisher = new MqttCommandPublisher({
    url: `mqtt://127.0.0.1:${String(brokerPort)}`,
    username: 'mes',
    password: TEST_PASSWORDS.mes,
    clientId: 'mes-orders-e2e-cmd',
  });
  orders = new Orders({ db, ingest, masterData, erp, tickMs: 0, erpPollMs: 0, erpPostMs: 0 });
  await orders.start();
  gateway = await startGateway(gatewayEnv);
  await until('the gateway ready with both CNCs', gatewayReady, 60_000);
  // The MES knows both CNCs' runs (the gateway's snapshots).
  await until('both device runs known', async () => {
    const epochs = await ingest.newestDeviceEpochs();
    return epochs.has('cnc-01') && epochs.has('cnc-02');
  });
  await until('the command connection', () => publisher.connected);
  listener = await mqtt.connectAsync(`mqtt://127.0.0.1:${String(brokerPort)}`, {
    username: 'mes',
    password: TEST_PASSWORDS.mes,
    protocolVersion: 5,
    clientId: 'mes-orders-e2e-listener',
  });
  listener.on('message', (topic, payload) => {
    deliveries.push({ topic, payload: payload.toString() });
  });
  await listener.subscribeAsync('orbis/gebze/+/+/+/cmd/#', { qos: 1 });
}, 240_000);

// Also after a failed beforeAll: whatever was started is stopped, processes above all (#212).
afterAll(async () => {
  await (listener as MqttClient | undefined)?.endAsync(true).catch(() => undefined);
  await (orders as Orders | undefined)?.stop().catch(() => undefined);
  await (publisher as MqttCommandPublisher | undefined)?.close().catch(() => undefined);
  await (ingest as Ingest | undefined)?.stop().catch(() => undefined);
  await (gateway as RunningGateway | undefined)?.stop('SIGKILL').catch(() => undefined);
  await (brokerProxy as TcpProxy | undefined)?.close();
  await (ingestProxy as TcpProxy | undefined)?.close();
  for (const p of opcua.values()) await p.close();
  await (broker as StartedTestContainer | undefined)?.stop().catch(() => undefined);
  await (simulator as RunningSimulator | undefined)?.stop();
  await (db as Kysely<Database> | undefined)?.destroy();
  await (container as StartedTestContainer | undefined)?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('commands exactly once from the MES (#174, exit criterion 3)', () => {
  it('dispatches through the outbox; the device accepts once and its fact confirms the command', async () => {
    await startOrders({ ttlMs: 20_000, resendMs: 10_000, maxAttempts: 3, failMarginMs: 5_000 });
    const sent = await dispatch('VB-200', 2, 'cnc-01');
    await until('confirmed by its fact', async () => (await command(sent.commandId)).confirmed);
    expect(await command(sent.commandId)).toMatchObject({
      state: 'accepted',
      acceptedBy: 'fact',
      job: 'accepted',
      settled: true,
    });
    expect(deviceAccepted(sent.commandId)).toBe(1);
    const results = await ingest.commandResults([sent.commandId]);
    expect(results.map((r) => r.value.result)).toEqual(['accepted']);
  });

  it('publishes after a restart between the outbox commit and the publish', async () => {
    // A MES without its command connection commits the dispatch, then stops.
    await startOrders(
      { ttlMs: 20_000, resendMs: 10_000, maxAttempts: 3, failMarginMs: 5_000 },
      false,
    );
    const sent = await dispatch('VB-200', 2, 'cnc-02');
    await wait(500);
    expect(deviceAccepted(sent.commandId)).toBe(0);
    expect((await command(sent.commandId)).state).toBe('queued');
    await startOrders({ ttlMs: 20_000, resendMs: 10_000, maxAttempts: 3, failMarginMs: 5_000 });
    await until(
      'confirmed after the restart',
      async () => (await command(sent.commandId)).confirmed,
    );
    expect(deviceAccepted(sent.commandId)).toBe(1);
    expect((await command(sent.commandId)).attempts).toHaveLength(1);
  });

  it('resends while its results are lost to the MES; the gateway answers from its table, one job', async () => {
    await startOrders({ ttlMs: 20_000, resendMs: 1_500, maxAttempts: 3, failMarginMs: 5_000 });
    ingestProxy.setDown(true); // the MES hears nothing (its session queues on the broker)
    const sent = await dispatch('VB-100', 1, 'cnc-01');
    await until('resent twice', async () => (await command(sent.commandId)).attempts.length === 3);
    await until('accepted on the device', () => deviceAccepted(sent.commandId) === 1);
    ingestProxy.setDown(false);
    await until('confirmed', async () => (await command(sent.commandId)).confirmed, 60_000);
    await until(
      'every answer heard',
      async () => (await ingest.commandResults([sent.commandId])).length === 3,
    );
    const results = (await ingest.commandResults([sent.commandId])).map((r) => r.value.result);
    expect(results.filter((r) => r === 'accepted' || r === 'duplicate')).toHaveLength(3);
    expect(deviceAccepted(sent.commandId)).toBe(1);
    expect((await command(sent.commandId)).state).toBe('accepted');
  }, 120_000);

  it('rejects a command for another device run and an invalid product: no job, the order flagged', async () => {
    await startOrders({ ttlMs: 20_000, resendMs: 10_000, maxAttempts: 3, failMarginMs: 5_000 });
    const epochs = await ingest.newestDeviceEpochs();
    const cases: { id: string; product: string; epoch: number }[] = [];
    for (const [product, epoch] of [
      ['VB-200', (epochs.get('cnc-02') ?? 0) + 1_000],
      ['VB-999', epochs.get('cnc-02') ?? 0],
    ] as const) {
      // Written as the outbox would hold them (the MES itself validates products and epochs).
      const order = await released();
      await db
        .insertInto('orders.dispatch_command')
        .values({
          command_id: `${order.id}~OP10~1`,
          order_id: order.id,
          n: 1,
          equipment: 'cnc-02',
          product,
          quantity: 2,
          not_before: new Date('2026-10-12T03:00:00.000Z'),
          device_epoch: epoch,
        })
        .execute();
      await db
        .updateTable('orders.production_order')
        .set({ status: 'dispatched' })
        .where('id', '=', order.id)
        .execute();
      cases.push({ id: order.id, product, epoch });
    }
    for (const [i, code] of (['epoch-mismatch', 'invalid-product'] as const).entries()) {
      const id = `${cases[i]?.id ?? ''}~OP10~1`;
      await until(`${id} rejected`, async () => (await command(id)).state === 'rejected');
      expect(await command(id)).toMatchObject({ settled: true, rejection: code, job: null });
      expect(await orders.order(cases[i]?.id ?? '')).toMatchObject({ dispatchFailed: true });
      expect(deviceAccepted(id)).toBe(0);
    }
  }, 120_000);

  it('answers expired after every delivery expired unanswered; a re-dispatch then makes the one job', async () => {
    await startOrders({ ttlMs: 3_000, resendMs: 1_500, maxAttempts: 2, failMarginMs: 2_000 });
    proxy('cnc-02').setDown(true); // the gateway can't reach the CNC: deliveries wait, then expire
    const sent = await dispatch('VB-200', 2, 'cnc-02');
    await until(
      'failed (no final answer)',
      async () => (await command(sent.commandId)).state === 'failed',
      60_000,
    );
    const order = await orders.order(sent.orderId);
    await expect(
      orders.redispatch(sent.orderId, { version: order?.version ?? 0 }, { by }),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.commandsUnsettled });
    proxy('cnc-02').setDown(false);
    await until(
      'expired, settled',
      async () => (await command(sent.commandId)).state === 'expired',
      90_000,
    );
    expect(deviceAccepted(sent.commandId)).toBe(0);
    const current = await orders.order(sent.orderId);
    expect(current).toMatchObject({ dispatchFailed: true, dispatched: 0 });
    const again = await orders.redispatch(sent.orderId, { version: current?.version ?? 0 }, { by });
    expect(again.command).toMatchObject({ n: 2, quantity: 2 });
    await until(
      'the re-dispatch confirmed',
      async () => (await command(again.command.commandId)).confirmed,
      60_000,
    );
    expect(deviceAccepted(again.command.commandId)).toBe(1);
  }, 180_000);

  it('declares failed a command the device accepted with its answer held; the re-dispatch is refused, then nothing remains', async () => {
    await startOrders({ ttlMs: 3_000, resendMs: 10_000, maxAttempts: 1, failMarginMs: 2_000 });
    proxy('cnc-01').hold();
    const sent = await dispatch('VB-100', 1, 'cnc-01');
    await until('accepted on the device', () => deviceAccepted(sent.commandId) === 1);
    await until('failed', async () => (await command(sent.commandId)).state === 'failed', 60_000);
    expect(await orders.incidents({ open: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'command-failed', commandId: sent.commandId }),
      ]),
    );
    const order = await orders.order(sent.orderId);
    await expect(
      orders.redispatch(sent.orderId, { version: order?.version ?? 0 }, { by }),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.commandsUnsettled });
    proxy('cnc-01').release();
    await until(
      'accepted',
      async () => (await command(sent.commandId)).state === 'accepted',
      90_000,
    );
    await until('gateway ready again', gatewayReady, 60_000);
    const after = await orders.order(sent.orderId);
    await expect(
      orders.redispatch(sent.orderId, { version: after?.version ?? 0 }, { by }),
    ).rejects.toThrow(/nothing to dispatch/);
    expect(deviceAccepted(sent.commandId)).toBe(1);
    expect((await command(sent.commandId)).failed).toBe(true);
  }, 180_000);

  it('keeps a command failed while its fact and answer wait in the gateway outbox, then counts the held job: no second job', async () => {
    await startOrders({ ttlMs: 3_000, resendMs: 10_000, maxAttempts: 1, failMarginMs: 2_000 });
    proxy('cnc-02').hold();
    const sent = await dispatch('VB-200', 1, 'cnc-02');
    await until('accepted on the device', () => deviceAccepted(sent.commandId) === 1);
    brokerProxy.setDown(true); // the gateway loses the broker; the MES stays connected
    proxy('cnc-02').release(); // the device's answer and fact reach the gateway: into its outbox
    await until(
      'failed past the margin',
      async () => (await command(sent.commandId)).state === 'failed',
      60_000,
    );
    const order = await orders.order(sent.orderId);
    await expect(
      orders.redispatch(sent.orderId, { version: order?.version ?? 0 }, { by }),
    ).rejects.toMatchObject({ type: PROBLEM_TYPES.commandsUnsettled });
    expect(await ingest.commandResults([sent.commandId])).toEqual([]);
    brokerProxy.setDown(false); // the outbox delivers the held fact and answer
    await until(
      'accepted from the held messages',
      async () => (await command(sent.commandId)).state === 'accepted',
      90_000,
    );
    // The held fact itself arrived (the outbox kept it): the job is confirmed by the device.
    await until(
      'confirmed by the held fact',
      async () => (await command(sent.commandId)).confirmed,
    );
    await until('gateway ready again', gatewayReady, 60_000);
    const after = await orders.order(sent.orderId);
    await expect(
      orders.redispatch(sent.orderId, { version: after?.version ?? 0 }, { by }),
    ).rejects.toThrow(/nothing to dispatch/);
    expect(deviceAccepted(sent.commandId)).toBe(1);
  }, 180_000);

  // Exit criterion 3's last case, both ways out (#178 review): a call that times out on the
  // gateway but executes on the device, its `accepted` fact and `cmd-res` held in the gateway's
  // outbox (broker down) past the MES's failure margin. The re-dispatch stays refused until a
  // `duplicate` answer arrives (a) or the CNC's final-through reaches `seqAfterExpiry` (b). Each
  // way out is proven while the fact is still held, so the fact can't be what settles it; the
  // held fact then confirms the job, and no second one is made. Each case runs three times, and
  // each is self-contained (`-t` alone).

  /**
   * cnc-02's final-through at its newest fact, and the number its next fact gets. Self-contained:
   * a CNC the MES has no device fact of yet (this case run alone) first gets one job, confirmed by
   * its fact; numbers below the stream's first one (from before the MES heard it) are then written
   * off by a sweep without grace.
   */
  async function cnc02Next(): Promise<number> {
    if ((await ingest.deviceProgress('cnc-02')).lastSeq === null) {
      const first = await dispatch('VB-200', 1, 'cnc-02');
      await until(
        'a first job on cnc-02 confirmed',
        async () => (await command(first.commandId)).confirmed,
        60_000,
      );
    }
    await ingest.sweep(0);
    let progress = await ingest.deviceProgress('cnc-02');
    await until('cnc-02 final through its newest fact', async () => {
      progress = await ingest.deviceProgress('cnc-02');
      return progress.lastSeq !== null && progress.settledSeq === progress.lastSeq;
    }).catch((error: unknown) => {
      throw new Error(`${String(error)}: ${JSON.stringify(progress)}`, { cause: error });
    });
    expect(progress.settledSeq).toBe(progress.lastSeq);
    return (progress.lastSeq ?? 0) + 1;
  }

  /** The epoch of the gateway's `cmd-res` stream on cnc-02 (or now), for injected answers. */
  async function resultEpoch(): Promise<number> {
    const known = await db
      .selectFrom('ingest.command_result')
      .select(['epoch'])
      .where('equipment', '=', 'cnc-02')
      .orderBy('arrival', 'desc')
      .limit(1)
      .executeTakeFirst();
    return known?.epoch ?? Math.floor(Date.now() / 1000);
  }

  /**
   * cnc-02 held, an order dispatched to it and the device's acceptance seen (its plant time from
   * the simulator's event).
   */
  async function dispatchedHeld() {
    proxy('cnc-02').hold();
    const sent = await dispatch('VB-200', 1, 'cnc-02');
    await until('accepted on the device', () => deviceAccepted(sent.commandId) === 1);
    const acceptance = simulator.events.find(
      (e) => e.type === 'job' && e.transition === 'accepted' && e.commandId === sent.commandId,
    );
    return { sent, acceptedAt: acceptance?.at ?? '' };
  }

  async function refusedTwice(orderId: string): Promise<void> {
    for (let refusal = 0; refusal < 2; refusal++) {
      const order = await orders.order(orderId);
      await expect(
        orders.redispatch(orderId, { version: order?.version ?? 0 }, { by }),
      ).rejects.toMatchObject({ type: PROBLEM_TYPES.commandsUnsettled });
      await wait(500);
    }
  }

  async function nothingToDispatch(orderId: string): Promise<void> {
    const order = await orders.order(orderId);
    await expect(
      orders.redispatch(orderId, { version: order?.version ?? 0 }, { by }),
    ).rejects.toThrow(/nothing to dispatch/);
  }

  it.each([1, 2, 3])(
    '(a, round %i) a call timed out on the gateway, executed on the device, fact and answer held: refused until a duplicate answer, which counts the job while the fact is still held; no second job',
    async () => {
      await startOrders({ ttlMs: 4_000, resendMs: 60_000, maxAttempts: 1, failMarginMs: 2_000 });
      await until('gateway ready', gatewayReady, 60_000);
      const held = await cnc02Next();
      const timeouts = await gatewayMetric('gateway_command_call_timeouts');
      const duplicates = await gatewayMetric('gateway_command_results', 'duplicate');
      try {
        const { sent, acceptedAt } = await dispatchedHeld();
        await wait(DEADLINE_MS + 500);
        await until(
          'the gateway counted the call timeout',
          async () => (await gatewayMetric('gateway_command_call_timeouts')) > timeouts,
        );
        brokerProxy.setDown(true); // the gateway loses the broker; the MES stays connected
        proxy('cnc-02').release(); // the fact and every later answer go to the gateway's outbox
        await until(
          'failed past the margin',
          async () => (await command(sent.commandId)).state === 'failed',
          60_000,
        );
        await refusedTwice(sent.orderId);
        // A later call of the gateway (a retry or its settle step) got the device's Duplicate,
        // held in its outbox with everything else.
        await until(
          'the device answered the gateway Duplicate',
          async () => (await gatewayMetric('gateway_command_results', 'duplicate')) > duplicates,
          90_000,
        );
        expect(await ingest.commandResults([sent.commandId])).toEqual([]); // nothing reached the MES
        // INJECTED as gw-01 (the gateway's own answer is in its outbox): a `duplicate` with the
        // device's acceptance number and plant time, reaching the MES while the fact is held.
        const [delivery] = (await command(sent.commandId)).attempts;
        await injectResult({
          equipment: 'cnc-02',
          epoch: await resultEpoch(),
          seq: 3_000_000 + injected++,
          value: {
            result: 'duplicate',
            commandId: sent.commandId,
            orderId: sent.orderId,
            deviceEpoch: sent.deviceEpoch,
            expiresAt: delivery?.expiresAt.toISOString(),
            statusCode: 'Good',
            position: 1,
            acceptedSeq: held,
            acceptedAt,
          },
        });
        // Counted as accepted from the answer alone: the fact (number `held`) has not arrived.
        await until(
          'accepted from the duplicate answer',
          async () => (await command(sent.commandId)).state === 'accepted',
          30_000,
        );
        expect((await ingest.deviceProgress('cnc-02')).settledSeq ?? 0).toBeLessThan(held);
        expect(await command(sent.commandId)).toMatchObject({
          state: 'accepted',
          acceptedBy: 'result',
          confirmed: false,
        });
        await nothingToDispatch(sent.orderId);
        brokerProxy.setDown(false); // the held fact arrives and confirms the job
        await until(
          'confirmed by the held fact',
          async () => (await command(sent.commandId)).confirmed,
          90_000,
        );
        expect(await command(sent.commandId)).toMatchObject({ state: 'accepted', confirmed: true });
        expect(deviceAccepted(sent.commandId)).toBe(1);
        await until('gateway ready again', gatewayReady, 60_000);
        await nothingToDispatch(sent.orderId);
        expect(deviceAccepted(sent.commandId)).toBe(1);
      } finally {
        proxy('cnc-02').release();
        brokerProxy.setDown(false);
      }
    },
    240_000,
  );

  it.each([1, 2, 3])(
    '(b, round %i) refused while final-through is below seqAfterExpiry (the held fact’s own number); the held fact fills the gap and counts the job, no second job',
    async () => {
      await startOrders({ ttlMs: 4_000, resendMs: 60_000, maxAttempts: 1, failMarginMs: 2_000 });
      await until('gateway ready', gatewayReady, 60_000);
      // The simulator is idle: the acceptance is cnc-02's next device fact, number `held`.
      const held = await cnc02Next();
      try {
        const { sent } = await dispatchedHeld();
        brokerProxy.setDown(true);
        proxy('cnc-02').release(); // the fact (number `held`) and the answers wait in the outbox
        await until(
          'failed past the margin',
          async () => (await command(sent.commandId)).state === 'failed',
          60_000,
        );
        const [delivery] = (await command(sent.commandId)).attempts;
        // INJECTED, not the gateway's own: an `unknown` whose settle step read the device's
        // sequence after the expiry, at the held fact's number. Once the fact arrives the CNC's
        // final-through equals it exactly (the boundary: "at or above"). A number above it would
        // prove nothing more, since the acceptance then settles the command by itself.
        await injectResult({
          equipment: 'cnc-02',
          epoch: await resultEpoch(),
          seq: 2_000_000 + injected++,
          value: {
            result: 'unknown',
            commandId: sent.commandId,
            orderId: sent.orderId,
            deviceEpoch: sent.deviceEpoch,
            expiresAt: delivery?.expiresAt.toISOString(),
            statusCode: null,
            seqAfterExpiry: held,
            reason: 'settle call failed after reading the sequence',
          },
        });
        await until('the unknown heard', async () =>
          (await ingest.commandResults([sent.commandId])).some((r) => r.value.result === 'unknown'),
        );
        // Final-through is below seqAfterExpiry: no re-dispatch, twice, a while apart.
        expect((await ingest.deviceProgress('cnc-02')).settledSeq ?? 0).toBeLessThan(held);
        await refusedTwice(sent.orderId);
        expect((await ingest.deviceProgress('cnc-02')).settledSeq ?? 0).toBeLessThan(held);
        brokerProxy.setDown(false); // the held fact fills the gap
        await until(
          'confirmed by the held fact',
          async () => (await command(sent.commandId)).confirmed,
          90_000,
        );
        const [fact] = (await ingest.jobFacts({ commandIds: [sent.commandId] })).filter(
          (f) => f.transition === 'accepted',
        );
        expect(fact?.seq).toBe(held);
        expect((await ingest.deviceProgress('cnc-02')).settledSeq ?? 0).toBeGreaterThanOrEqual(
          held,
        );
        expect((await command(sent.commandId)).state).toBe('accepted');
        expect(deviceAccepted(sent.commandId)).toBe(1);
        await until('gateway ready again', gatewayReady, 60_000);
        await nothingToDispatch(sent.orderId);
        expect(deviceAccepted(sent.commandId)).toBe(1);
      } finally {
        proxy('cnc-02').release();
        brokerProxy.setDown(false);
      }
    },
    240_000,
  );

  it('settles not-accepted when the CNC’s facts pass seqAfterExpiry without the acceptance; the re-dispatch makes the one job', async () => {
    await startOrders({ ttlMs: 4_000, resendMs: 20_000, maxAttempts: 1, failMarginMs: 3_000 });
    proxy('cnc-02').setDown(true); // the device is out of the gateway's reach: never accepted
    try {
      const sent = await dispatch('VB-200', 2, 'cnc-02');
      await until('published', async () => (await command(sent.commandId)).attempts.length === 1);
      const [delivery] = (await command(sent.commandId)).attempts;
      // The gateway's settle call read seqAfterExpiry and then failed: an `unknown` with it (the
      // gateway's own message, as `gw-01`, on its stream with a number of its own).
      // As the gateway does it: after the delivery's expiresAt plus a second (the device refuses
      // it from then on), read the device's sequence, then the settle call fails.
      const expiresAt = delivery?.expiresAt.getTime() ?? 0;
      await until('past the expiry', () => Date.now() > expiresAt + 1_500, 30_000);
      // Read after the expiry: every number up to it stored (the MES saw these before the command).
      const progress = await ingest.deviceProgress('cnc-02');
      expect(progress.lastSeq).not.toBeNull();
      const [last] = (await ingest.commandResults([`${sent.orderId}~OP10~1`])).slice(-1);
      const known = await db
        .selectFrom('ingest.command_result')
        .select(['epoch'])
        .where('equipment', '=', 'cnc-02')
        .orderBy('arrival', 'desc')
        .limit(1)
        .executeTakeFirst();
      expect(last === undefined || last.value.result === 'unknown').toBe(true);
      const injector = await mqtt.connectAsync(`mqtt://127.0.0.1:${String(brokerPort)}`, {
        username: 'gw-01',
        password: TEST_PASSWORDS['gw-01'],
        protocolVersion: 5,
        clientId: 'mes-orders-e2e-gateway-voice',
      });
      try {
        await injector.publishAsync(
          'orbis/gebze/machining/cell-m1/cnc-02/cmd-res/load-order',
          JSON.stringify({
            schema: 'uns.cmd-res/1',
            scope: 'topic',
            epoch: known?.epoch ?? Math.floor(Date.now() / 1000),
            seq: 1_000_000,
            source: { id: 'cnc-02', protocol: 'opcua' },
            respondedAt: new Date().toISOString(),
            value: {
              result: 'unknown',
              commandId: sent.commandId,
              orderId: sent.orderId,
              deviceEpoch: sent.deviceEpoch,
              expiresAt: delivery?.expiresAt.toISOString(),
              statusCode: null,
              seqAfterExpiry: progress.lastSeq ?? 0,
              reason: 'settle call failed after reading the sequence',
            },
          }),
          { qos: 1 },
        );
      } finally {
        await injector.endAsync(true);
      }
      await until(
        'not-accepted',
        async () => (await command(sent.commandId)).state === 'not-accepted',
        60_000,
      );
      expect(deviceAccepted(sent.commandId)).toBe(0);
      const order = await orders.order(sent.orderId);
      expect(order).toMatchObject({ dispatchFailed: true, dispatched: 0 });
      const again = await orders.redispatch(sent.orderId, { version: order?.version ?? 0 }, { by });
      proxy('cnc-02').setDown(false);
      await until(
        'the re-dispatch confirmed',
        async () => (await command(again.command.commandId)).confirmed,
        90_000,
      );
      expect(deviceAccepted(again.command.commandId)).toBe(1);
      expect(deviceAccepted(sent.commandId)).toBe(0);
    } finally {
      proxy('cnc-02').setDown(false);
    }
    await until('gateway ready again', gatewayReady, 60_000);
  }, 240_000);

  it('gets the job once after a gateway restart between the call and its result', async () => {
    await startOrders({ ttlMs: 30_000, resendMs: 20_000, maxAttempts: 3, failMarginMs: 5_000 });
    proxy('cnc-02').hold();
    const sent = await dispatch('VB-200', 1, 'cnc-02');
    await until('accepted on the device', () => deviceAccepted(sent.commandId) === 1);
    await gateway.stop('SIGKILL');
    proxy('cnc-02').cut();
    gateway = await startGateway(gatewayEnv);
    await until('the gateway ready again', gatewayReady, 60_000);
    await until(
      'accepted after the restart',
      async () => (await command(sent.commandId)).state === 'accepted',
      90_000,
    );
    expect(deviceAccepted(sent.commandId)).toBe(1);
    const results = (await ingest.commandResults([sent.commandId])).map((r) => r.value.result);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r === 'accepted' || r === 'duplicate' || r === 'unknown')).toBe(
      true,
    );
  }, 180_000);

  it('answers a duplicated delivery from the gateway’s table: one job', async () => {
    await startOrders({ ttlMs: 30_000, resendMs: 20_000, maxAttempts: 3, failMarginMs: 5_000 });
    const sent = await dispatch('VB-100', 1, 'cnc-01');
    await until('confirmed', async () => (await command(sent.commandId)).confirmed, 60_000);
    const copy = deliveries.find((d) => d.payload.includes(`"${sent.commandId}"`));
    if (!copy) throw new Error('the delivery was not seen');
    await listener.publishAsync(copy.topic, copy.payload, { qos: 1 }); // the broker's duplicate
    await until(
      'both deliveries answered',
      async () => (await ingest.commandResults([sent.commandId])).length >= 2,
      60_000,
    );
    expect(deviceAccepted(sent.commandId)).toBe(1);
    expect((await command(sent.commandId)).state).toBe('accepted');
  }, 120_000);

  it('resends a delivery written but never published when the MES crashed before the publish', async () => {
    let crash = true;
    await startOrders(
      { ttlMs: 30_000, resendMs: 2_000, maxAttempts: 1, failMarginMs: 5_000 },
      true,
      () => {
        if (!crash) return Promise.resolve();
        crash = false;
        return Promise.reject(new Error('crash between the attempt row and the publish'));
      },
    );
    const sent = await dispatch('VB-100', 1, 'cnc-01');
    await until(
      'the attempt written',
      async () => (await command(sent.commandId)).attempts.length >= 1,
    );
    // The restarted MES finds an unpublished delivery: it doesn't count, and is sent again.
    await startOrders({ ttlMs: 30_000, resendMs: 2_000, maxAttempts: 1, failMarginMs: 5_000 });
    await until('confirmed', async () => (await command(sent.commandId)).confirmed, 60_000);
    const attempts = (await command(sent.commandId)).attempts;
    expect(attempts[0]?.publishedAt).toBeNull();
    expect(attempts.filter((a) => a.publishedAt !== null)).toHaveLength(1);
    expect(deviceAccepted(sent.commandId)).toBe(1);
  }, 120_000);

  it('re-dispatches to the new run after a simulator restart: the old job lost, one job in the new run', async () => {
    await startOrders({ ttlMs: 20_000, resendMs: 10_000, maxAttempts: 3, failMarginMs: 5_000 });
    const sent = await dispatch('VB-200', 3, 'cnc-01');
    await until('confirmed', async () => (await command(sent.commandId)).confirmed, 60_000);
    const before = (await ingest.newestDeviceEpochs()).get('cnc-01') ?? 0;
    pastRuns.push(simulator.events);
    const ports = simulator.ports;
    await simulator.stop();
    await wait(1_100); // a new run, a new epoch
    simulator = await startSimulator(ports, SIM_ENV); // where the gateway left it
    for (const p of opcua.values()) p.cut();
    await until(
      'the new run known',
      async () => ((await ingest.newestDeviceEpochs()).get('cnc-01') ?? 0) > before,
      90_000,
    );
    await until('the job lost', async () => (await command(sent.commandId)).job === 'lost');
    const order = await orders.order(sent.orderId);
    // Accepted behind the earlier cases' jobs on cnc-01 (the idle run completes none) and never
    // started: it took no blank (at the head of its queue it would count one).
    expect(order).toMatchObject({ dispatchLost: true, dispatched: 0 });
    const again = await orders.redispatch(
      sent.orderId,
      { version: order?.version ?? 0, equipment: 'cnc-01' },
      { by },
    );
    expect(again.command.deviceEpoch).toBeGreaterThan(before);
    await until(
      'the new job confirmed',
      async () => (await command(again.command.commandId)).confirmed,
      90_000,
    );
    expect(deviceAccepted(again.command.commandId, 'current')).toBe(1);
  }, 240_000);

  it('ends exactly once per order across runs and per command: never more blanks than the order', async () => {
    // Per order, across every run: the blanks of the jobs accepted in the current run, plus those
    // of jobs of ended runs that started (a job that never started there made nothing).
    const perOrder = new Map<string, number>();
    const perCommand = new Map<string, number>();
    const runs = [...pastRuns, simulator.events];
    for (const [index, run] of runs.entries()) {
      const current = index === runs.length - 1;
      const started = new Set(
        run
          .filter((e) => e.type === 'job' && e.transition === 'started')
          .map((e) => String(e.commandId)),
      );
      for (const e of run) {
        if (e.type !== 'job' || e.transition !== 'accepted') continue;
        perCommand.set(String(e.commandId), (perCommand.get(String(e.commandId)) ?? 0) + 1);
        if (current || started.has(String(e.commandId))) {
          const order = String(e.orderId);
          perOrder.set(order, (perOrder.get(order) ?? 0) + Number(e.quantity));
        }
      }
    }
    for (const [order, quantity] of perOrder) {
      expect(quantity, order).toBeLessThanOrEqual(quantities.get(order) ?? 0);
    }
    for (const [id, count] of perCommand) expect(count, id).toBe(1);
    // The MES's reading agrees with the device: a command it holds accepted was accepted there.
    for (const c of await orders.commands()) {
      expect(c.job !== null, `${c.commandId} ${c.state}`).toBe(deviceAccepted(c.commandId) === 1);
    }
    expect(
      (await orders.incidents()).filter(
        (i) => i.type === 'unknown-job' || i.type === 'duplicate-job',
      ),
    ).toEqual([]);
  });
});
