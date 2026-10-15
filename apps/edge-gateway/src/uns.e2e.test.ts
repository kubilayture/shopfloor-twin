import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

/** Waits for a condition; the error names what it waited for, so a CI failure says where. */
async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !(await condition());) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    }
    await wait(100);
  }
}

/**
 * A probe of the gateway's HTTP endpoints: '' when the gateway is not there, also when the
 * connection breaks while the body is read, so the polling `until` retries and names the step.
 */
const get = (url: string): Promise<string> =>
  fetch(url, { signal: AbortSignal.timeout(2_000) })
    .then((r) => r.text())
    .catch(() => '');

/** Socket errors of a broker that is starting or stopping, which a reconnect attempt can cure. */
const TRANSIENT_SOCKET_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

const isTransientSocketError = (error: unknown): boolean =>
  error instanceof Error &&
  TRANSIENT_SOCKET_ERRORS.has((error as NodeJS.ErrnoException).code ?? '');

/** A consumer as the MES will be (Phase 4): validates every message and applies ADR-0015's rule. */
class Consumer {
  readonly dedup = new Deduplicator();
  readonly facts = new Map<string, UnsMessage[]>();
  readonly telemetry = new Set<string>();
  readonly invalid: string[] = [];
  /** Client errors other than the socket resets of the outages. */
  readonly errors: string[] = [];
  /** Holes in streams closed by an epoch change (a restarted gateway's own counters). */
  readonly closedGaps: string[] = [];
  duplicates = 0;
  #client: MqttClient | undefined;

  /**
   * Connects to a broker that may have just been (re)started. Its port can accept a connection
   * and reset it before Mosquitto serves it (a port proxy without a backend yet), which
   * `connectAsync` rejects with a bare `read ECONNRESET` (#107). Such resets are retried until
   * the deadline; any other error (a refused login, for example) fails at once.
   */
  async connect(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let client: MqttClient;
    for (;;) {
      try {
        client = await mqtt.connectAsync(`mqtt://127.0.0.1:${String(BROKER_PORT)}`, {
          username: 'mes',
          password: TEST_PASSWORDS.mes,
          protocolVersion: 5,
          reconnectPeriod: 0,
        });
        break;
      } catch (error) {
        if (!isTransientSocketError(error) || Date.now() > deadline) throw error;
        await wait(200);
      }
    }
    // The broker outages reset this socket on purpose; the client is closed right after them, and
    // a lost message still fails the delivery assertions. Socket errors are therefore expected
    // here, never a reason to fail, while protocol errors (no `code`) still are.
    client.on('error', (error) => {
      if (!isTransientSocketError(error)) this.errors.push(String(error));
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
      for (const gap of verdict.closedGaps)
        this.closedGaps.push(`${gap.stream} ${String(gap.from)}–${String(gap.to)}`);
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

/** The key content of a fact, in the same words for a UNS message and a simulator event. */
function describeFact(message: UnsMessage): string {
  switch (message.schema) {
    case 'uns.state.current/1':
      return `state ${message.value.state} ${String(message.value.cause)}`;
    case 'uns.events.cycle-complete/1':
      return `cycle ${message.value.product} ${String(message.value.partId)} ${message.value.result}`;
    case 'uns.alarms/1':
      return `alarm ${message.value.code} ${message.value.transition}`;
    case 'uns.telemetry/1':
    case 'uns.sys.status/1':
    case 'uns.sys.incident/1':
      return message.schema;
  }
}

function describeEvent(event: SimEvent): string {
  switch (event.type) {
    case 'state':
      return `state ${String(event.to)} ${typeof event.cause === 'string' ? event.cause : 'null'}`;
    case 'cycle-complete':
      return `cycle ${String(event.product)} ${String(event.partId)} ${String(event.result)}`;
    default:
      return `alarm ${String(event.code)} ${String(event.transition)}`;
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
  const text = await get(`http://127.0.0.1:${String(GATEWAY_HTTP)}/metrics`);
  const match = new RegExp(`^${name} (\\S+)$`, 'm').exec(text);
  return match ? Number(match[1]) : Number.NaN;
};

const allConnected = async (): Promise<boolean> => {
  const text = await get(`http://127.0.0.1:${String(GATEWAY_HTTP)}/metrics`);
  return MACHINES.every((m) => text.includes(`gateway_device_connected{machine="${m}"} 1`));
};

beforeAll(async () => {
  simulator = await startSimulator(SIM);
  broker = (await startBroker({ hostPort: BROKER_PORT })).container;
  await consumer.connect();
  gateway = await startGateway(gatewayEnv);
  await until('every machine connected to the gateway', allConnected, 60_000);
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
    await until(
      'messages in the buffer',
      async () => (await metric('gateway_buffer_messages')) > 0,
      10_000,
    );

    // Gateway crash with messages still buffered, and the plant paused so nothing happens while
    // no gateway is listening (OPC UA keeps no history for a gateway that isn't there).
    await simulator.post('/api/v1/pause');
    await wait(1_000);
    await gateway.stop('SIGKILL');
    // The crash happened with machine facts still in the buffer, not only telemetry.
    const buffer = new DatabaseSync(gatewayEnv.BUFFER_PATH, { readOnly: true });
    const bufferedFacts = Number(
      buffer
        .prepare(
          "SELECT count(*) AS n FROM outbox WHERE topic LIKE '%/state/current' OR topic LIKE '%/events/%' OR topic LIKE '%/alarms/%'",
        )
        .get()?.n ?? 0,
    );
    buffer.close();
    expect(bufferedFacts).toBeGreaterThan(0);

    broker = (await startBroker({ hostPort: BROKER_PORT })).container;
    await consumer.connect();
    gateway = await startGateway(gatewayEnv);
    await until('every machine connected to the gateway', allConnected, 60_000);
    await until(
      'an empty buffer',
      async () => (await metric('gateway_buffer_messages')) === 0,
      30_000,
    );

    await simulator.post('/api/v1/resume');
    await wait(6_000);
    // A second outage, with the gateway alive: it buffers and replays on its own after reconnecting.
    await broker.stop();
    await consumer.close();
    await wait(5_000);
    broker = (await startBroker({ hostPort: BROKER_PORT })).container;
    await consumer.connect();
    await wait(6_000);
    await simulator.post('/api/v1/pause');
    await wait(3_000);
    await until(
      'an empty buffer',
      async () => (await metric('gateway_buffer_messages')) === 0,
      30_000,
    );

    expect(consumer.errors).toEqual([]);
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
      const arrived = consumer.facts.get(machine) ?? [];
      // Ordered sending (ADR-0014): new facts arrive in device order, even across replays.
      expect(
        arrived.map((m) => m.seq),
        `${machine} arrival order`,
      ).toEqual(arrived.map((m) => m.seq).sort((a, b) => a - b));
      const received = [...arrived].sort((a, b) => a.seq - b.seq);
      // Exactly once each, with the device's own consecutive numbers, times and content.
      expect(
        received.map((m) => m.sourceTime),
        machine,
      ).toEqual(expected.map((e) => e.at));
      expect(received.map(describeFact), machine).toEqual(expected.map(describeEvent));
      const first = received[0]?.seq ?? 0;
      expect(
        received.map((m) => m.seq),
        machine,
      ).toEqual(received.map((_, i) => first + i));
      total += expected.length;
    }
    expect(total).toBeGreaterThan(80);
    // `_sys/…/status` is excluded from gap checks (docs/contracts/uns.md): reserved will numbers.
    expect(consumer.dedup.gaps().filter((gap) => !gap.stream.endsWith('/status'))).toEqual([]);
    // A restarted gateway starts new counters for its own streams; only telemetry (sampled, plan
    // section 5) and status (reserved will numbers) may have holes there, never incidents.
    expect(
      consumer.closedGaps.filter((gap) => !gap.includes('/telemetry/') && !gap.includes('/status')),
    ).toEqual([]);

    // Every telemetry topic of every machine was seen.
    const expectedTelemetry = Object.entries(UNS_TELEMETRY).flatMap(([name, t]) =>
      t.equipment.map((equipment) => `${equipment}/${name}`),
    );
    expect([...consumer.telemetry].sort()).toEqual(expectedTelemetry.sort());
  }, 420_000);
});
