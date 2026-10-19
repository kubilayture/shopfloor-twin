import { parseUnsMessage, stateTopic, type StateCurrent, type Status } from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import mqtt, { type MqttClient } from 'mqtt';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from './env.ts';
import { equipmentPaths } from './hierarchy.ts';
import { buildGatewayHttp } from './http.ts';
import { TopicSequences } from './identity.ts';
import { MqttLink, NotConnectedError } from './mqtt-link.ts';
import { TEST_PASSWORDS, startBroker, timed } from './testing.ts';

let broker: { url: string; container: StartedTestContainer };
let config: PlantConfig;
const cleanup: (() => Promise<unknown>)[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await wait(20);
  }
}

async function client(user: keyof typeof TEST_PASSWORDS): Promise<MqttClient> {
  const c = await mqtt.connectAsync(broker.url, {
    username: user,
    password: TEST_PASSWORDS[user],
    protocolVersion: 5,
    reconnectPeriod: 0,
  });
  cleanup.push(() => c.endAsync(true));
  return c;
}

function link(clientIdSuffix = ''): MqttLink {
  const l = new MqttLink({
    url: broker.url,
    username: 'gw-01',
    password: TEST_PASSWORDS['gw-01'],
    gatewayId: 'gw-01',
    version: 'test',
    sequences: new TopicSequences(1_791_774_000 + clientIdSuffix.length),
    startedAt: Date.UTC(2026, 9, 15, 12),
    reconnectPeriodMs: 200,
  });
  cleanup.push(() => l.close());
  return l;
}

beforeAll(async () => {
  broker = await startBroker();
  const loaded = await loadPlantConfig(resolve(import.meta.dirname, '../../../config/plant'));
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  config = loaded.config;
}, 120_000);

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
});

afterAll(async () => {
  await broker.container.stop();
});

const OPCUA_PASSWORD = 'o'.repeat(32);

describe('environment configuration (#75)', () => {
  it('applies defaults and requires the broker password without ever echoing it', () => {
    const ok = parseEnv({ MQTT_PASSWORD: 'secret', OPCUA_GATEWAY_PASSWORD: OPCUA_PASSWORD });
    expect(ok.ok && ok.env).toMatchObject({
      GATEWAY_ID: 'gw-01',
      MQTT_URL: 'mqtt://127.0.0.1:1883',
      MQTT_USERNAME: 'gw-01',
      HTTP_PORT: 4900,
      OPCUA_SECURITY: 'sign-and-encrypt',
    });
    // SignAndEncrypt (#239) needs the opcua-gateway password; `none` doesn't.
    const noOpcuaPassword = parseEnv({ MQTT_PASSWORD: 'secret' });
    expect(noOpcuaPassword.ok).toBe(false);
    if (!noOpcuaPassword.ok) {
      expect(noOpcuaPassword.issues.join('\n')).toMatch(
        /^OPCUA_GATEWAY_PASSWORD: .*\(got \(hidden\)\)$/,
      );
    }
    // The simulator's rule (#239 review): 16–512 characters without whitespace, never echoed.
    for (const bad of ['short', 'with a space in the middle']) {
      const refused = parseEnv({ MQTT_PASSWORD: 'secret', OPCUA_GATEWAY_PASSWORD: bad });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.issues.join('\n')).toMatch(/^OPCUA_GATEWAY_PASSWORD: .*\(got \(hidden\)\)$/);
        expect(refused.issues.join('\n')).not.toContain(bad);
      }
    }
    const none = parseEnv({ MQTT_PASSWORD: 'secret', OPCUA_SECURITY: 'none' });
    expect(none.ok && none.env.OPCUA_SECURITY).toBe('none');
    const bad = parseEnv({
      MQTT_PASSWORD: ' kept as is ',
      OPCUA_GATEWAY_PASSWORD: OPCUA_PASSWORD,
      MQTT_URL: 'http://x',
      GATEWAY_ID: 'GW 1',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.map((i) => i.split(':')[0]).sort()).toEqual(['GATEWAY_ID', 'MQTT_URL']);
    }
    const spaced = parseEnv({
      MQTT_PASSWORD: ' kept as is ',
      OPCUA_GATEWAY_PASSWORD: OPCUA_PASSWORD,
    });
    expect(spaced.ok && spaced.env.MQTT_PASSWORD).toBe(' kept as is ');
    const missing = parseEnv({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.join('\n')).toMatch(/^MQTT_PASSWORD: .*\(got \(hidden\)\)$/);
    }
  });
});

describe('UNS hierarchy', () => {
  it('maps every piece of equipment to its ISA-95 path', () => {
    const paths = equipmentPaths(config);
    expect(paths.size).toBe(6);
    const wsh = paths.get('wsh-01');
    expect(wsh && stateTopic(wsh)).toBe('orbis/gebze/machining/cell-m1/wsh-01/state/current');
    const lkt = paths.get('lkt-01');
    expect(lkt && stateTopic(lkt)).toBe('orbis/gebze/assembly/line-a1/lkt-01/state/current');
  });
});

describe('broker session and _sys status (#75)', () => {
  it('announces itself online with a retained, valid status message', async () => {
    const l = link();
    l.start();
    await until(() => l.connected);
    const dev = await client('dev');
    const received: Status[] = [];
    dev.on('message', (_topic, payload) => {
      const parsed = parseUnsMessage(JSON.parse(payload.toString()));
      if (parsed.ok && parsed.message.schema === 'uns.sys.status/1') received.push(parsed.message);
    });
    await dev.subscribeAsync(l.statusTopic, { qos: 1 });
    await until(() => received.length > 0);
    expect(l.statusTopic).toBe('orbis/gebze/_sys/edge-gateway/gw-01/status');
    expect(received[0]?.value).toMatchObject({ status: 'online', version: 'test' });
    expect(received[0]?.source).toEqual({ id: 'gw-01', protocol: 'internal' });
  });

  it('publishes machine data with QoS 1 and resolves on the broker acknowledgement', async () => {
    const l = link();
    l.start();
    await until(() => l.connected);
    const mes = await client('mes');
    const got: string[] = [];
    mes.on('message', (_topic, payload) => got.push(payload.toString()));
    const path = equipmentPaths(config).get('cnc-01');
    if (!path) throw new Error('no cnc-01');
    await mes.subscribeAsync(stateTopic(path), { qos: 1 });
    const message: StateCurrent = {
      schema: 'uns.state.current/1',
      kind: 'event',
      scope: 'device',
      epoch: 1,
      seq: 1,
      sourceTime: '2026-10-12T03:00:00.000Z',
      receivedAt: '2026-10-15T12:00:00.000Z',
      quality: 'good',
      source: { id: 'cnc-01', protocol: 'opcua' },
      value: { state: 'Running', cause: null },
    };
    await l.publish({ topic: stateTopic(path), message, retain: true });
    expect(l.published).toBe(1);
    await until(() => got.length === 1);
    expect(JSON.parse(got[0] ?? '{}')).toEqual(message);
  });

  it('is refused by the broker ACL outside its topics (MQTT 5 reason code)', async () => {
    const l = link();
    l.start();
    await until(() => l.connected);
    const path = equipmentPaths(config).get('asm-01');
    if (!path) throw new Error('no asm-01');
    const topic = `orbis/gebze/${path.area}/${path.workCenter}/${path.equipment}/mes/active-order`;
    const mes = await client('mes');
    const got: string[] = [];
    mes.on('message', (t) => got.push(t));
    await mes.subscribeAsync(topic, { qos: 1 });
    const outcome = await l
      .publish({ topic, message: {} as never, retain: false })
      .then(() => 'acknowledged')
      .catch((error: unknown) => String(error));
    await wait(300);
    expect(got).toEqual([]);
    // Mosquitto answers a denied QoS 1 publish with PUBACK reason 0x87 (not authorized), and
    // MQTT.js rejects: a permanent error the store-and-forward buffer must not retry forever (#78).
    expect(outcome).toMatch(/Not authorized/);
  });

  it('leaves its last will "offline" when the connection dies, and says "offline" itself on a clean close', async () => {
    const dev = await client('dev');
    const statuses: string[] = [];
    const seqs: number[] = [];
    dev.on('message', (_topic, payload) => {
      const parsed = parseUnsMessage(JSON.parse(payload.toString()));
      if (parsed.ok && parsed.message.schema === 'uns.sys.status/1') {
        statuses.push(parsed.message.value.status);
        seqs.push(parsed.message.seq);
      }
    });
    const crashing = link('crash');
    crashing.start();
    await until(() => crashing.connected);
    await dev.subscribeAsync('orbis/gebze/_sys/edge-gateway/gw-01/status', { qos: 1 });
    await until(() => statuses.includes('online'));
    const onlineSeq = seqs.at(-1) ?? 0;
    statuses.length = 0;
    crashing.client.stream.destroy(); // no DISCONNECT packet: the broker sends the will
    await until(() => statuses.includes('offline'));
    expect(seqs.at(-1)).toBeGreaterThan(0);
    expect(seqs.at(-1)).not.toBe(onlineSeq);
    await until(() => statuses.includes('online')); // and it reconnects by itself
    statuses.length = 0;
    await crashing.close();
    await until(() => statuses.includes('offline'));
  });

  it('refuses to publish while disconnected, and closes promptly even then', async () => {
    const never = new MqttLink({
      url: 'mqtt://127.0.0.1:1', // nothing listens there
      username: 'gw-01',
      password: 'x',
      gatewayId: 'gw-01',
      version: 'test',
      sequences: new TopicSequences(1),
      startedAt: 0,
      reconnectPeriodMs: 100,
    });
    await never.close(); // never started: a no-op
    const errors: Error[] = [];
    const refused = new MqttLink({
      url: 'mqtt://127.0.0.1:1',
      username: 'gw-01',
      password: 'x',
      gatewayId: 'gw-01',
      version: 'test',
      sequences: new TopicSequences(1),
      startedAt: 0,
      reconnectPeriodMs: 100,
      onError: (error) => errors.push(error),
    });
    refused.start();
    await until(() => errors.length > 0);
    await expect(
      refused.publish({ topic: 't', message: {} as never, retain: false }),
    ).rejects.toBeInstanceOf(NotConnectedError);
    // Promptly: within 2 s plus whatever the scheduler lagged meanwhile on a loaded machine (#212).
    const { elapsedMs, maxLagMs } = await timed(() => refused.close());
    expect(elapsedMs).toBeLessThan(2_000 + maxLagMs);
  });

  it('lists in the ACL exactly the areas of the plant, so `+` never has to match `_sys`', async () => {
    const acl = await readFile(
      resolve(import.meta.dirname, '../../../config/mosquitto/acl'),
      'utf8',
    );
    const areas = new Set(
      [...acl.matchAll(/^topic \w+ orbis\/gebze\/([a-z0-9-]+)\/\+/gm)].map((m) => m[1]),
    );
    expect([...areas].sort()).toEqual(config.plant.areas.map((a) => a.id).sort());
    expect(acl).not.toMatch(/orbis\/gebze\/\+/);
  });

  it('serves liveness, readiness from the broker session, and metrics', async () => {
    const l = link();
    const http = buildGatewayHttp({ ready: () => l.connected, published: () => l.published });
    cleanup.push(() => http.close());
    expect((await http.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect((await http.inject({ url: '/health/ready' })).statusCode).toBe(503);
    l.start();
    await until(() => l.connected);
    expect((await http.inject({ url: '/health/ready' })).json()).toEqual({ status: 'ok' });
    const metrics = (await http.inject({ url: '/metrics' })).body;
    expect(metrics).toMatch(/^gateway_mqtt_connected 1$/m);
    expect(metrics).toMatch(/^gateway_published_messages 0$/m);
  });

  it('serves the command path metrics (#173)', async () => {
    const http = buildGatewayHttp({
      ready: () => true,
      published: () => 0,
      commands: () => ({
        received: 5,
        calls: 4,
        results: new Map([
          ['accepted', 2],
          ['unknown', 1],
        ]),
        queued: 1,
        settling: 1,
      }),
    });
    cleanup.push(() => http.close());
    const metrics = (await http.inject({ url: '/metrics' })).body;
    expect(metrics).toMatch(/^gateway_command_deliveries 5$/m);
    expect(metrics).toMatch(/^gateway_command_calls 4$/m);
    expect(metrics).toMatch(/^gateway_command_results\{result="accepted"\} 2$/m);
    expect(metrics).toMatch(/^gateway_command_results\{result="expired"\} 0$/m);
    expect(metrics).toMatch(/^gateway_command_pending\{stage="settling"\} 1$/m);
  });
});
