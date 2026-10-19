/**
 * The command path end to end (#173; Phase 7 exit criterion 3, the gateway's cases): real
 * Mosquitto, the gateway as its own process and the simulator in production mode `orders`, idle at
 * its start time. The test plays the MES: it publishes `cmd/load-order` as `mes` and reads
 * `cmd-res` and `events/job`. TCP proxies in front of the OPC UA servers hold the device's answers
 * or cut the connection mid-call, and one in front of the broker takes it away from the gateway.
 *
 * Every case ends with, for every command id, exactly one `accepted` job fact when the device
 * accepted it and none otherwise, and for every order the accepted job quantities at most the
 * order quantity.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Deduplicator,
  OPCUA_MACHINES,
  loadOrderCommandId,
  parseUnsCommandMessage,
  parseUnsMessage,
  type CommandResultValue,
  type JobEvent,
  type LoadOrderCommand,
} from '@shopfloor/contracts';
import mqtt, { type MqttClient } from 'mqtt';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORDS,
  TcpProxy,
  opcuaProxies,
  startBroker,
  startGateway,
  startSimulator,
  type RunningGateway,
  type RunningSimulator,
  type SimEvent,
} from './testing.ts';

// The simulator's ports, the OPC UA proxies' block and the broker proxy's port are chosen at
// runtime (#212), the broker's by Docker, the gateway's HTTP port per start.
const SIM_ENV = { SIM_PRODUCTION: 'orders' };
const DEADLINE_MS = 1_500;
const NOT_BEFORE = '2026-10-12T03:00:00.000Z';
const PATHS = {
  'cnc-01': 'orbis/gebze/machining/cell-m1/cnc-01',
  'cnc-02': 'orbis/gebze/machining/cell-m1/cnc-02',
} as const;
type Cnc = keyof typeof PATHS;

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

const metrics = (): Promise<string> => get(`${gateway.http}/metrics`);

async function metric(name: string): Promise<number> {
  const match = new RegExp(`^${name} (\\S+)$`, 'm').exec(await metrics());
  return match ? Number(match[1]) : Number.NaN;
}

let simulator: RunningSimulator;
let broker: StartedTestContainer;
let gateway: RunningGateway;
let mes: MqttClient;
let opcua = new Map<string, TcpProxy>();
let brokerProxy: TcpProxy;
const pastRuns: SimEvent[][] = [];
const dir = mkdtempSync(join(tmpdir(), 'gateway-commands-e2e-'));
const env = {
  MQTT_URL: '', // the broker proxy's, once it listens
  MQTT_PASSWORD: TEST_PASSWORDS['gw-01'],
  OPCUA_HOST: 'localhost',
  OPCUA_PORT_OFFSET: '', // the OPC UA proxies' block, once chosen
  OPCUA_PKI_DIR: join(dir, 'pki'),
  MODBUS_PORT: '', // the simulator's, once started
  BUFFER_PATH: join(dir, 'buffer', 'gateway.db'),
  GATEWAY_CALL_DEADLINE_MS: String(DEADLINE_MS),
};

/** The MES's view: every cmd-res and every job fact, deduplicated as ADR-0015 says. */
const results: { equipment: string; value: CommandResultValue }[] = [];
const jobFacts: JobEvent[] = [];
const dedup = new Deduplicator();
const invalid: string[] = [];
/** Order quantities, for the per-order exactly-once check. */
const orderQuantity = new Map<string, number>();

async function ready(): Promise<boolean> {
  const text = await metrics();
  return (
    (await get(`${gateway.http}/health/ready`)).includes('ok') &&
    ['cnc-01', 'cnc-02'].every((m) => text.includes(`gateway_device_connected{machine="${m}"} 1`))
  );
}

async function startTheGateway(): Promise<void> {
  gateway = await startGateway(env);
  await until('the gateway ready with both CNCs', ready, 60_000);
}

async function deviceEpoch(): Promise<number> {
  const response = await fetch(`${simulator.control}/api/v1/ground-truth`, {
    headers: simulator.auth,
  });
  return ((await response.json()) as { epoch: number }).epoch;
}

let orders = 0;
async function command(
  options: { product?: string; deviceEpoch?: number; expiresInMs?: number; quantity?: number } = {},
): Promise<LoadOrderCommand> {
  orders++;
  const orderId = `PO-E${String(orders)}`;
  const quantity = options.quantity ?? 3;
  orderQuantity.set(orderId, quantity);
  const now = Date.now();
  return {
    schema: 'uns.cmd.load-order/1',
    scope: 'topic',
    epoch: 1_800_000_000,
    seq: orders,
    source: { id: 'mes-server', protocol: 'internal' },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.expiresInMs ?? 20_000)).toISOString(),
    value: {
      commandId: loadOrderCommandId(orderId, 1),
      orderId,
      operation: 'OP10',
      product: options.product ?? 'VB-200',
      quantity,
      notBefore: NOT_BEFORE,
      deviceEpoch: options.deviceEpoch ?? (await deviceEpoch()),
    },
  };
}

async function send(message: LoadOrderCommand, cnc: Cnc = 'cnc-01'): Promise<void> {
  await mes.publishAsync(`${PATHS[cnc]}/cmd/load-order`, JSON.stringify(message), { qos: 1 });
}

const answers = (message: LoadOrderCommand): CommandResultValue[] =>
  results.map((r) => r.value).filter((v) => v.commandId === message.value.commandId);

/** The device's own record (control API event stream) of `accepted` facts, every run. */
const deviceAccepted = (message: LoadOrderCommand): number =>
  [...pastRuns, simulator.events]
    .flat()
    .filter(
      (e) =>
        e.type === 'job' && e.transition === 'accepted' && e.commandId === message.value.commandId,
    ).length;

/** The `accepted` job facts that reached the MES through the UNS, after dedup. */
const unsAccepted = (message: LoadOrderCommand): number =>
  jobFacts.filter(
    (f) => f.value.commandId === message.value.commandId && f.value.transition === 'accepted',
  ).length;

function proxy(machine: string): TcpProxy {
  const p = opcua.get(machine);
  if (!p) throw new Error(machine);
  return p;
}

beforeAll(async () => {
  simulator = await startSimulator(undefined, SIM_ENV);
  const block = await opcuaProxies(OPCUA_MACHINES, simulator.opcuaOffset);
  opcua = block.proxies;
  broker = (await startBroker()).container;
  brokerPort = broker.getMappedPort(1883);
  brokerProxy = await TcpProxy.start(0, { host: '127.0.0.1', port: brokerPort });
  env.MQTT_URL = `mqtt://127.0.0.1:${String(brokerProxy.port)}`;
  env.OPCUA_PORT_OFFSET = String(block.offset);
  env.MODBUS_PORT = String(simulator.modbusPort);
  mes = await mqtt.connectAsync(`mqtt://127.0.0.1:${String(brokerPort)}`, {
    username: 'mes',
    password: TEST_PASSWORDS.mes,
    protocolVersion: 5,
    reconnectPeriod: 0,
  });
  mes.on('message', (topic, payload, packet) => {
    const json = JSON.parse(payload.toString()) as unknown;
    if (topic.includes('/cmd-res/')) {
      const parsed = parseUnsCommandMessage(json);
      if (!parsed.ok || parsed.message.schema !== 'uns.cmd-res/1') {
        invalid.push(`${topic}: ${parsed.ok ? parsed.message.schema : parsed.error}`);
        return;
      }
      results.push({ equipment: parsed.message.source.id, value: parsed.message.value });
      return;
    }
    const parsed = parseUnsMessage(json);
    if (!parsed.ok || parsed.message.schema !== 'uns.events.job/1') {
      invalid.push(`${topic}: ${parsed.ok ? parsed.message.schema : parsed.error}`);
      return;
    }
    if (dedup.accept(topic, parsed.message, { retained: packet.retain }).status === 'new') {
      jobFacts.push(parsed.message);
    }
  });
  await mes.subscribeAsync({
    'orbis/gebze/+/+/+/cmd-res/+': { qos: 1 },
    'orbis/gebze/+/+/+/events/job': { qos: 1 },
  });
  await startTheGateway();
}, 180_000);

// Also after a failed beforeAll: whatever was started is stopped (#212).
afterAll(async () => {
  await (gateway as RunningGateway | undefined)?.stop('SIGKILL').catch(() => undefined);
  await (mes as MqttClient | undefined)?.endAsync(true);
  await (brokerProxy as TcpProxy | undefined)?.close();
  for (const p of opcua.values()) await p.close();
  await (broker as StartedTestContainer | undefined)?.stop().catch(() => undefined);
  await (simulator as RunningSimulator | undefined)?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('commands exactly once through Mosquitto, the gateway and the simulator (#173)', () => {
  const sent: LoadOrderCommand[] = [];
  /**
   * Commands whose accepted fact the gateway saw live. A fact raised while the gateway's session
   * was cut or the gateway was down is history to the next session (no event history, ADR-0009):
   * the MES sees it as a sequence gap, and the device's answer (`duplicate`) carries its `seq`.
   */
  const factOnUns: LoadOrderCommand[] = [];
  const track = async (options?: Parameters<typeof command>[0]) => {
    const c = await command(options);
    sent.push(c);
    return c;
  };

  it('answers a duplicate delivery and a resend after a lost cmd-res from the result table', async () => {
    const c = await track();
    await send(c);
    await send(c); // duplicated delivery
    await until('both answered', () => answers(c).length === 2);
    expect(answers(c).map((a) => a.result)).toEqual(['accepted', 'accepted']);
    const calls = await metric('gateway_command_calls');
    // The MES lost the cmd-res and resends with a new expiresAt: no call, the stored answer.
    const resend = { ...c, expiresAt: new Date(Date.now() + 30_000).toISOString() };
    await send(resend);
    await until('the resend answered', () => answers(c).length === 3);
    expect(answers(c)[2]).toEqual({ ...answers(c)[0], expiresAt: resend.expiresAt });
    expect(await metric('gateway_command_calls')).toBe(calls);
    factOnUns.push(c);
    // The job fact travels apart from the call's answer (subscription vs. call): wait for it here,
    // before a later case holds or cuts the session it is still on.
    await until('the job fact on the UNS', () => unsAccepted(c) === 1);
  });

  it('answers a wrong device epoch, an invalid product and an expired command from the device', async () => {
    const wrongEpoch = await track({ deviceEpoch: (await deviceEpoch()) - 1 });
    const invalidProduct = await track({ product: 'VB-999' });
    const expired = await track({ expiresInMs: -3_000 });
    for (const c of [wrongEpoch, invalidProduct, expired]) await send(c);
    await until('all answered', () =>
      [wrongEpoch, invalidProduct, expired].every((c) => answers(c).length === 1),
    );
    expect(answers(wrongEpoch)[0]).toMatchObject({ result: 'rejected', code: 'epoch-mismatch' });
    expect(answers(invalidProduct)[0]).toMatchObject({
      result: 'rejected',
      code: 'invalid-product',
    });
    expect(answers(expired)[0]).toMatchObject({ result: 'expired', statusCode: 'BadInvalidState' });
  });

  it('retries a call that timed out on the gateway after the device acted (Duplicate)', async () => {
    const c = await track();
    proxy('cnc-01').hold();
    await send(c);
    await until('the device accepted it', () => deviceAccepted(c) === 1);
    await wait(DEADLINE_MS + 500);
    proxy('cnc-01').release();
    await until('answered', () => answers(c).length === 1);
    expect(answers(c)[0]).toMatchObject({ result: 'duplicate' });
    factOnUns.push(c);
    // The job fact travels apart from the call's answer (subscription vs. call): wait for it here,
    // before a later case holds or cuts the session it is still on.
    await until('the job fact on the UNS', () => unsAccepted(c) === 1);
  });

  it('retries after a TCP cut mid-call (Duplicate)', async () => {
    const c = await track();
    proxy('cnc-02').hold();
    await send(c, 'cnc-02');
    await until('the device accepted it', () => deviceAccepted(c) === 1);
    proxy('cnc-02').cut();
    await until('answered', () => answers(c).length === 1, 60_000);
    expect(answers(c)[0]).toMatchObject({ result: 'duplicate' });
  }, 90_000);

  it('delivers a result from the outbox after a broker outage while it was pending', async () => {
    const c = await track();
    proxy('cnc-01').hold();
    await send(c);
    await until('the device accepted it', () => deviceAccepted(c) === 1);
    brokerProxy.setDown(true); // the gateway loses the broker; the MES stays connected
    proxy('cnc-01').release(); // the answer arrives in time: accepted, into the outbox
    await until('the result held in the outbox', () => {
      const db = new DatabaseSync(env.BUFFER_PATH, { readOnly: true });
      try {
        return (
          Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM outbox WHERE topic LIKE '%/cmd-res/%' AND payload LIKE ?",
              )
              .get(`%${c.value.commandId}%`)?.n ?? 0,
          ) === 1
        );
      } finally {
        db.close();
      }
    });
    expect(answers(c)).toEqual([]);
    brokerProxy.setDown(false);
    await until('delivered after the outage', () => answers(c).length === 1, 30_000);
    expect(answers(c)[0]).toMatchObject({ result: 'accepted' });
    await until('the gateway ready again', ready, 30_000);
    factOnUns.push(c);
    // The job fact travels apart from the call's answer (subscription vs. call): wait for it here,
    // before a later case holds or cuts the session it is still on.
    await until('the job fact on the UNS', () => unsAccepted(c) === 1);
  }, 90_000);

  it('processes again a command the gateway crashed on between the call and storing its result', async () => {
    const c = await track();
    proxy('cnc-01').hold();
    await send(c);
    await until('the device accepted it', () => deviceAccepted(c) === 1);
    await gateway.stop('SIGKILL');
    proxy('cnc-01').cut();
    expect(answers(c)).toEqual([]);
    await startTheGateway();
    await until('answered after the restart', () => answers(c).length === 1, 60_000);
    expect(answers(c)[0]).toMatchObject({ result: 'duplicate' });
  }, 120_000);

  it('answers Duplicate to an expired resend after a crash after the call: no second job', async () => {
    const c = await track({ expiresInMs: 4_000 });
    proxy('cnc-02').hold();
    await send(c, 'cnc-02');
    await until('the device accepted it', () => deviceAccepted(c) === 1);
    await gateway.stop('SIGKILL');
    proxy('cnc-02').cut();
    await until('expired', () => Date.now() > Date.parse(c.expiresAt) + 1_500);
    await send(c, 'cnc-02'); // the resend: already expired, queued for the gateway's session
    await startTheGateway();
    await until('both deliveries answered', () => answers(c).length >= 2, 60_000);
    expect(new Set(answers(c).map((a) => a.result))).toEqual(new Set(['duplicate']));
  }, 120_000);

  it('gets a command again that the gateway received but could not record before a restart', async () => {
    const c = await track();
    const lock = new DatabaseSync(env.BUFFER_PATH);
    lock.exec('PRAGMA busy_timeout = 5000');
    lock.exec('BEGIN EXCLUSIVE'); // the gateway's insert can't commit: no PUBACK
    await send(c);
    await wait(1_500);
    await gateway.stop('SIGKILL');
    lock.exec('ROLLBACK');
    lock.close();
    expect(answers(c)).toEqual([]);
    expect(deviceAccepted(c)).toBe(0);
    await startTheGateway();
    await until('redelivered, recorded and answered', () => answers(c).length >= 1, 60_000);
    expect(answers(c)[0]).toMatchObject({ result: 'accepted' });
    factOnUns.push(c);
    // The job fact travels apart from the call's answer (subscription vs. call): wait for it here,
    // before a later case holds or cuts the session it is still on.
    await until('the job fact on the UNS', () => unsAccepted(c) === 1);
  }, 120_000);

  it('answers rejected (epoch-mismatch) after a simulator restart mid-call, without a second job', async () => {
    const c = await track();
    proxy('cnc-01').hold();
    await send(c);
    await until('the device accepted it', () => deviceAccepted(c) === 1);
    pastRuns.push(simulator.events);
    const ports = simulator.ports;
    await simulator.stop();
    await wait(1_100); // a new run, a new epoch
    simulator = await startSimulator(ports, SIM_ENV); // where the gateway left it
    for (const p of opcua.values()) p.cut();
    await until('answered', () => answers(c).length === 1, 90_000);
    expect(answers(c)[0]).toMatchObject({
      result: 'rejected',
      code: 'epoch-mismatch',
      statusCode: null,
    });
    expect(simulator.events.filter((e) => e.type === 'job')).toEqual([]);
  }, 150_000);

  it('ends with exactly one accepted job fact per accepted command, none otherwise, within every order', async () => {
    expect(invalid).toEqual([]);
    expect(sent.length).toBe(11);
    for (const c of sent) {
      const results = answers(c).map((a) => a.result);
      const accepted = results.some((r) => r === 'accepted' || r === 'duplicate');
      const restartedRun = results.includes('rejected') && deviceAccepted(c) === 1;
      expect(deviceAccepted(c), c.value.commandId).toBe(accepted || restartedRun ? 1 : 0);
      expect(results.includes('unknown'), c.value.commandId).toBe(false);
    }
    // The UNS carried each fact the gateway saw live exactly once (after dedup), and no other.
    expect(factOnUns).toHaveLength(4);
    const missing = () =>
      factOnUns.filter((c) => unsAccepted(c) !== 1).map((c) => c.value.commandId);
    await until('every live fact on the UNS', () => missing().length === 0).catch(() => undefined);
    expect(missing()).toEqual([]);
    for (const c of sent) expect(unsAccepted(c), c.value.commandId).toBeLessThanOrEqual(1);
    const perOrder = new Map<string, number>();
    for (const e of [...pastRuns, simulator.events].flat()) {
      if (e.type === 'job' && e.transition === 'accepted') {
        const order = String(e.orderId);
        perOrder.set(order, (perOrder.get(order) ?? 0) + Number(e.quantity));
      }
    }
    for (const [order, quantity] of perOrder) {
      expect(quantity, order).toBeLessThanOrEqual(orderQuantity.get(order) ?? 0);
    }
  }, 60_000);
});
