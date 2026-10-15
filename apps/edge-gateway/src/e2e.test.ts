import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Deduplicator,
  UNS_TELEMETRY,
  parseEquipmentTopic,
  parseUnsMessage,
  type UnsMessage,
} from '@shopfloor/contracts';
import mqtt, { type MqttClient } from 'mqtt';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORDS,
  startBroker,
  startGateway,
  startSimulator,
  type RunningGateway,
  type RunningSimulator,
  type SimEvent,
} from './testing.ts';

// Ports clear of the Compose stack and of the other test files.
const SIM = { opcuaOffset: 3300, modbusPort: 8320, controlPort: 8100 };
const BROKER_PORT = 18_841;
const GATEWAY_HTTP = 4_990;
const MACHINES = ['cnc-01', 'cnc-02', 'wsh-01', 'asm-01', 'lkt-01', 'pck-01'] as const;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !(await condition());) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await wait(100);
  }
}

/** A consumer as the MES will be (Phase 4): validates every message and applies ADR-0015's rule. */
class Consumer {
  readonly dedup = new Deduplicator();
  readonly facts = new Map<string, UnsMessage[]>();
  readonly telemetry = new Set<string>();
  readonly invalid: string[] = [];
  duplicates = 0;
  #client: MqttClient | undefined;

  async connect(): Promise<void> {
    const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${String(BROKER_PORT)}`, {
      username: 'mes',
      password: TEST_PASSWORDS.mes,
      protocolVersion: 5,
      reconnectPeriod: 0,
    });
    client.on('message', (topic, payload, packet) => {
      const parsed = parseUnsMessage(JSON.parse(payload.toString()));
      if (!parsed.ok) {
        this.invalid.push(`${topic}: ${parsed.error}`);
        return;
      }
      const message = parsed.message;
      const verdict = this.dedup.accept(topic, message, { retained: packet.retain });
      if (verdict.status === 'duplicate') {
        this.duplicates++;
        return;
      }
      const parsedTopic = parseEquipmentTopic(topic);
      if (parsedTopic?.topicClass === 'telemetry')
        this.telemetry.add(`${parsedTopic.equipment}/${parsedTopic.name}`);
      if (message.scope === 'device' && !packet.retain) {
        const list = this.facts.get(message.source.id) ?? [];
        list.push(message);
        this.facts.set(message.source.id, list);
      }
    });
    await client.subscribeAsync('orbis/#', { qos: 1 });
    this.#client = client;
  }

  async close(): Promise<void> {
    await this.#client?.endAsync(true);
  }
}

let simulator: RunningSimulator;
let broker: StartedTestContainer;
let gateway: RunningGateway;
const consumer = new Consumer();
const bufferDir = mkdtempSync(join(tmpdir(), 'gateway-e2e-'));
const gatewayEnv = {
  MQTT_URL: `mqtt://127.0.0.1:${String(BROKER_PORT)}`,
  MQTT_PASSWORD: TEST_PASSWORDS['gw-01'],
  OPCUA_HOST: 'localhost',
  OPCUA_PORT_OFFSET: String(SIM.opcuaOffset),
  OPCUA_PKI_DIR: join(bufferDir, 'pki'),
  MODBUS_PORT: String(SIM.modbusPort),
  BUFFER_PATH: join(bufferDir, 'buffer', 'gateway.db'),
  HTTP_PORT: String(GATEWAY_HTTP),
  TELEMETRY_SAMPLING_MS: '500',
};

const metric = async (name: string): Promise<number> => {
  const text = await fetch(`http://127.0.0.1:${String(GATEWAY_HTTP)}/metrics`).then(
    (r) => r.text(),
    () => '',
  );
  const match = new RegExp(`^${name} (\\S+)$`, 'm').exec(text);
  return match ? Number(match[1]) : Number.NaN;
};

const allConnected = async (): Promise<boolean> => {
  const text = await fetch(`http://127.0.0.1:${String(GATEWAY_HTTP)}/metrics`).then(
    (r) => r.text(),
    () => '',
  );
  return MACHINES.every((m) => text.includes(`gateway_device_connected{machine="${m}"} 1`));
};

beforeAll(async () => {
  simulator = await startSimulator(SIM);
  broker = (await startBroker({ hostPort: BROKER_PORT })).container;
  await consumer.connect();
  gateway = await startGateway(gatewayEnv);
  await until(allConnected, 60_000);
}, 180_000);

afterAll(async () => {
  await gateway.stop('SIGKILL').catch(() => undefined);
  await consumer.close();
  await broker.stop().catch(() => undefined);
  await simulator.stop();
  rmSync(bufferDir, { recursive: true, force: true });
});

describe('UNS end to end at 60× (#79, Phase 3 exit criteria 1 and 2)', () => {
  it('delivers every fact of every machine exactly once after dedup, through a broker outage and a gateway crash', async () => {
    await simulator.post('/api/v1/resume');
    await wait(10_000);

    // Broker outage: the gateway keeps collecting into its buffer.
    await broker.stop();
    await consumer.close();
    await wait(6_000);
    await until(async () => (await metric('gateway_buffer_messages')) > 0, 10_000);

    // Gateway crash with messages still buffered, and the plant paused so nothing happens while
    // no gateway is listening (OPC UA keeps no history for a gateway that isn't there).
    await simulator.post('/api/v1/pause');
    await wait(1_000);
    await gateway.stop('SIGKILL');

    broker = (await startBroker({ hostPort: BROKER_PORT })).container;
    await consumer.connect();
    gateway = await startGateway(gatewayEnv);
    await until(allConnected, 60_000);
    await until(async () => (await metric('gateway_buffer_messages')) === 0, 30_000);

    await simulator.post('/api/v1/resume');
    await wait(10_000);
    await simulator.post('/api/v1/pause');
    await wait(3_000);
    await until(async () => (await metric('gateway_buffer_messages')) === 0, 30_000);

    expect(consumer.invalid).toEqual([]);
    const facts = (machine: string): SimEvent[] =>
      simulator.events.filter(
        (e) =>
          e.machineId === machine &&
          (e.type === 'state' || e.type === 'cycle-complete' || e.type === 'alarm'),
      );
    let total = 0;
    for (const machine of MACHINES) {
      const expected = facts(machine);
      const received = [...(consumer.facts.get(machine) ?? [])].sort((a, b) => a.seq - b.seq);
      // Exactly once each, with the device's own consecutive numbers and simulation times.
      expect(
        received.map((m) => m.sourceTime),
        machine,
      ).toEqual(expected.map((e) => e.at));
      const first = received[0]?.seq ?? 0;
      expect(
        received.map((m) => m.seq),
        machine,
      ).toEqual(received.map((_, i) => first + i));
      total += expected.length;
    }
    expect(total).toBeGreaterThan(80);
    expect(consumer.dedup.gaps()).toEqual([]);

    // Every telemetry topic of every machine was seen.
    const expectedTelemetry = Object.entries(UNS_TELEMETRY).flatMap(([name, t]) =>
      t.equipment.map((equipment) => `${equipment}/${name}`),
    );
    expect([...consumer.telemetry].sort()).toEqual(expectedTelemetry.sort());
  }, 300_000);
});
