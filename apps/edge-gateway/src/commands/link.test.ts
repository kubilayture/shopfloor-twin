/**
 * The command session and the broker ACL for commands (#173, ADR-0029, plan M2): PUBACK only
 * after the delivery is recorded, a persistent session under its own client id, and the refusals
 * (0x87) of `cmd` for `gw-01` and `dev` and of `cmd-res` for `mes`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt, { type MqttClient } from 'mqtt';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSWORDS, startBroker } from '../testing.ts';
import { CommandLink, commandSubscriptions } from './link.ts';
import { CommandStore, type InboxEntry } from './store.ts';

const CMD = 'orbis/gebze/machining/cell-m1/cnc-01/cmd/load-order';
const CMD_RES = 'orbis/gebze/machining/cell-m1/cnc-01/cmd-res/load-order';
const AREAS = ['machining', 'assembly'];

let broker: { url: string; container: StartedTestContainer };
const cleanup: (() => Promise<unknown> | undefined)[] = [];
const dir = mkdtempSync(join(tmpdir(), 'gateway-command-link-'));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await wait(20);
  }
}

async function client(user: keyof typeof TEST_PASSWORDS, clientId?: string): Promise<MqttClient> {
  const c = await mqtt.connectAsync(broker.url, {
    username: user,
    password: TEST_PASSWORDS[user],
    protocolVersion: 5,
    reconnectPeriod: 0,
    ...(clientId ? { clientId } : {}),
  });
  cleanup.push(() => c.endAsync(true));
  return c;
}

/** The outcome of a QoS 1 publish: the broker's PUBACK, or its refusal. */
const publish = (c: MqttClient, topic: string, payload = '{}'): Promise<string> =>
  c
    .publishAsync(topic, payload, { qos: 1 })
    .then(() => 'acknowledged')
    .catch((error: unknown) => String(error));

function link(
  store: Pick<CommandStore, 'record'>,
  received: InboxEntry[],
  clientId = 'gw-01-cmd',
): CommandLink {
  const l = new CommandLink({
    url: broker.url,
    username: 'gw-01',
    password: TEST_PASSWORDS['gw-01'],
    clientId,
    areas: AREAS,
    sessionExpirySeconds: 600,
    store,
    onCommand: (entry) => received.push(entry),
    retryMs: 300,
    reconnectPeriodMs: 200,
  });
  cleanup.push(() => l.close());
  return l;
}

beforeAll(async () => {
  broker = await startBroker();
}, 120_000);

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()?.catch(() => undefined);
});

afterAll(async () => {
  await broker.container.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('broker ACL for commands (#173, plan M2)', () => {
  it('refuses cmd to gw-01 and dev and cmd-res to mes with 0x87, and delivers the allowed directions', async () => {
    const gateway = await client('gw-01');
    const dev = await client('dev');
    const mes = await client('mes');
    const got: string[] = [];
    for (const c of [gateway, mes]) c.on('message', (topic) => got.push(topic));
    await gateway.subscribeAsync(CMD, { qos: 1 });
    await mes.subscribeAsync(CMD_RES, { qos: 1 });
    await mes.subscribeAsync(CMD, { qos: 1 }); // mes reads everything; it must see no forged cmd

    expect(await publish(gateway, CMD)).toMatch(/Not authorized/);
    expect(await publish(dev, CMD)).toMatch(/Not authorized/);
    expect(await publish(dev, CMD_RES)).toMatch(/Not authorized/);
    expect(await publish(mes, CMD_RES)).toMatch(/Not authorized/);
    await wait(300);
    expect(got).toEqual([]);

    // The MES commands, the gateway answers, the MES reads the answer.
    expect(await publish(mes, CMD)).toBe('acknowledged');
    expect(await publish(gateway, CMD_RES)).toBe('acknowledged');
    await until('both deliveries', () => got.length === 3);
    expect(got.sort()).toEqual([CMD_RES, CMD, CMD]);
  });

  it('grants the command subscriptions per area to gw-01 (none to _sys)', async () => {
    const gateway = await client('gw-01');
    expect(commandSubscriptions(AREAS)).toEqual([
      'orbis/gebze/machining/+/+/cmd/#',
      'orbis/gebze/assembly/+/+/cmd/#',
    ]);
    const grants = await gateway.subscribeAsync(
      Object.fromEntries(commandSubscriptions(AREAS).map((t) => [t, { qos: 1 as const }])),
    );
    expect(grants.map((g) => g.qos)).toEqual([1, 1]);
  });
});

describe('command session (#173, ADR-0029)', () => {
  it('records a delivery before its PUBACK and keeps its session while the gateway is away', async () => {
    const store = new CommandStore(join(dir, 'a.db'));
    cleanup.push(() => {
      store.close();
      return undefined;
    });
    const received: InboxEntry[] = [];
    const first = link(store, received);
    first.start();
    await until('subscribed', () => first.subscribed);
    const mes = await client('mes');
    expect(await publish(mes, CMD, '{"n":1}')).toBe('acknowledged');
    await until('recorded', () => received.length === 1);
    expect(first.received).toBe(1);
    expect(store.pending()).toEqual([
      expect.objectContaining({ equipment: 'cnc-01', topic: CMD, payload: '{"n":1}' }),
    ]);
    // Away: the broker queues for the persistent session.
    await first.close();
    expect(await publish(mes, CMD, '{"n":2}')).toBe('acknowledged');
    const second = link(store, received);
    second.start();
    await until('the queued command', () => received.length === 2);
    expect(received[1]?.payload).toBe('{"n":2}');
    expect(store.pending().map((e) => e.payload)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('never acknowledges a delivery it could not record: the broker delivers it again', async () => {
    const real = new CommandStore(join(dir, 'b.db'));
    cleanup.push(() => {
      real.close();
      return undefined;
    });
    let failures = 2;
    const flaky: Pick<CommandStore, 'record'> = {
      record: (equipment, topic, payload) => {
        if (failures > 0) {
          failures--;
          throw new Error('database is locked');
        }
        return real.record(equipment, topic, payload);
      },
    };
    const received: InboxEntry[] = [];
    const l = link(flaky, received, 'gw-01-cmd-flaky');
    l.start();
    await until('subscribed', () => l.subscribed);
    const mes = await client('mes');
    expect(await publish(mes, CMD, '{"n":3}')).toBe('acknowledged');
    await until('recorded after two refusals', () => received.length === 1, 30_000);
    expect(failures).toBe(0);
    expect(real.pending().map((e) => e.payload)).toEqual(['{"n":3}']);
    await wait(500);
    expect(received).toHaveLength(1); // acknowledged once recorded: not delivered again
  });

  it('acknowledges and ignores a delivery outside an equipment command topic', async () => {
    const store = new CommandStore(join(dir, 'c.db'));
    cleanup.push(() => {
      store.close();
      return undefined;
    });
    const ignored: string[] = [];
    const received: InboxEntry[] = [];
    const l = new CommandLink({
      url: broker.url,
      username: 'gw-01',
      password: TEST_PASSWORDS['gw-01'],
      clientId: 'gw-01-cmd-ignore',
      areas: AREAS,
      sessionExpirySeconds: 600,
      store,
      onCommand: (entry) => received.push(entry),
      onIgnored: (topic) => ignored.push(topic),
    });
    cleanup.push(() => l.close());
    l.start();
    await until('subscribed', () => l.subscribed);
    const mes = await client('mes');
    const odd = 'orbis/gebze/machining/cell-m1/cnc-01/cmd/load-order/extra';
    expect(await publish(mes, odd)).toBe('acknowledged');
    await until('ignored', () => ignored.length === 1);
    expect(ignored).toEqual([odd]);
    expect(received).toEqual([]);
    expect(store.pending()).toEqual([]);
  });
});
