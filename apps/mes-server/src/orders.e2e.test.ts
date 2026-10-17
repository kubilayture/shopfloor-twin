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
import { TEST_PASSWORDS, freePort, startBroker } from '@shopfloor/test-kit/broker';
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

const SIM = { opcuaOffset: 3700, modbusPort: 8720, controlPort: 8500 };
const PROXY_OFFSET = 3750;
const DEADLINE_MS = 1_500;

const BROKER_PORT = await freePort();
const GATEWAY_MQTT = await freePort();
const INGEST_MQTT = await freePort();
const GATEWAY_HTTP = await freePort();

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
let opcua: Map<string, TcpProxy>;
let brokerProxy: TcpProxy;
let ingestProxy: TcpProxy;
const erp = new TestErp();
const pastRuns: SimEvent[][] = [];
const quantities = new Map<string, number>();
const dir = mkdtempSync(join(tmpdir(), 'mes-orders-e2e-'));
let by: { userId: number; username: string; roles: 'supervisor'[] };

const gatewayEnv = {
  MQTT_URL: `mqtt://127.0.0.1:${String(GATEWAY_MQTT)}`,
  MQTT_PASSWORD: TEST_PASSWORDS['gw-01'],
  OPCUA_HOST: 'localhost',
  OPCUA_PORT_OFFSET: String(PROXY_OFFSET),
  OPCUA_PKI_DIR: join(dir, 'pki'),
  MODBUS_PORT: String(SIM.modbusPort),
  BUFFER_PATH: join(dir, 'buffer', 'gateway.db'),
  HTTP_PORT: String(GATEWAY_HTTP),
  GATEWAY_CALL_DEADLINE_MS: String(DEADLINE_MS),
};

async function gatewayReady(): Promise<boolean> {
  const text = await get(`http://127.0.0.1:${String(GATEWAY_HTTP)}/metrics`);
  return (
    (await get(`http://127.0.0.1:${String(GATEWAY_HTTP)}/health/ready`)).includes('ok') &&
    ['cnc-01', 'cnc-02'].every((m) => text.includes(`gateway_device_connected{machine="${m}"} 1`))
  );
}

/** A fresh orders module (the MES restarted) with these command timings. */
async function startOrders(
  timings: Partial<CommandTimings>,
  withPublisher = true,
): Promise<Orders> {
  await orders.stop();
  orders = new Orders({
    db,
    ingest,
    masterData,
    ...(withPublisher ? { publisher } : {}),
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
  simulator = await startSimulator(SIM, { SIM_PRODUCTION: 'orders' });
  opcua = await opcuaProxies(OPCUA_MACHINES, PROXY_OFFSET, SIM.opcuaOffset);
  broker = (await startBroker({ hostPort: BROKER_PORT })).container;
  brokerProxy = await TcpProxy.start(GATEWAY_MQTT, { host: '127.0.0.1', port: BROKER_PORT });
  ingestProxy = await TcpProxy.start(INGEST_MQTT, { host: '127.0.0.1', port: BROKER_PORT });
  ingest = new Ingest({
    db,
    url: `mqtt://127.0.0.1:${String(INGEST_MQTT)}`,
    username: 'mes',
    password: TEST_PASSWORDS.mes,
    clientId: 'mes-orders-e2e',
    gapGraceMs: 60_000,
  });
  await ingest.start();
  await ingest.waitSubscribed();
  publisher = new MqttCommandPublisher({
    url: `mqtt://127.0.0.1:${String(BROKER_PORT)}`,
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
}, 240_000);

afterAll(async () => {
  await orders.stop().catch(() => undefined);
  await publisher.close().catch(() => undefined);
  await ingest.stop().catch(() => undefined);
  await gateway.stop('SIGKILL').catch(() => undefined);
  await brokerProxy.close();
  await ingestProxy.close();
  for (const p of opcua.values()) await p.close();
  await broker.stop().catch(() => undefined);
  await simulator.stop();
  await db.destroy();
  await container.stop();
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

  it('re-dispatches to the new run after a simulator restart: the old job lost, one job in the new run', async () => {
    await startOrders({ ttlMs: 20_000, resendMs: 10_000, maxAttempts: 3, failMarginMs: 5_000 });
    const sent = await dispatch('VB-200', 3, 'cnc-01');
    await until('confirmed', async () => (await command(sent.commandId)).confirmed, 60_000);
    const before = (await ingest.newestDeviceEpochs()).get('cnc-01') ?? 0;
    pastRuns.push(simulator.events);
    await simulator.stop();
    await wait(1_100); // a new run, a new epoch
    simulator = await startSimulator(SIM, { SIM_PRODUCTION: 'orders' });
    for (const p of opcua.values()) p.cut();
    await until(
      'the new run known',
      async () => ((await ingest.newestDeviceEpochs()).get('cnc-01') ?? 0) > before,
      90_000,
    );
    await until('the job lost', async () => (await command(sent.commandId)).job === 'lost');
    const order = await orders.order(sent.orderId);
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

  it('ends exactly once: per run at most the order quantity accepted, at most one accepted fact per command', async () => {
    for (const run of [...pastRuns, simulator.events]) {
      const perOrder = new Map<string, number>();
      const perCommand = new Map<string, number>();
      for (const e of run) {
        if (e.type !== 'job' || e.transition !== 'accepted') continue;
        perOrder.set(
          String(e.orderId),
          (perOrder.get(String(e.orderId)) ?? 0) + Number(e.quantity),
        );
        perCommand.set(String(e.commandId), (perCommand.get(String(e.commandId)) ?? 0) + 1);
      }
      for (const [order, quantity] of perOrder) {
        expect(quantity, order).toBeLessThanOrEqual(quantities.get(order) ?? 0);
      }
      for (const [id, count] of perCommand) expect(count, id).toBe(1);
    }
    // The MES's reading agrees with the device: a command it holds accepted was accepted there.
    for (const c of await orders.commands()) {
      expect(c.job !== null, c.commandId).toBe(deviceAccepted(c.commandId) === 1);
    }
    expect(
      (await orders.incidents()).filter(
        (i) => i.type === 'unknown-job' || i.type === 'duplicate-job',
      ),
    ).toEqual([]);
  });
});
