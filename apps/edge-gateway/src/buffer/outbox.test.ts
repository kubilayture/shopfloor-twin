import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Telemetry } from '@shopfloor/contracts';
import mqtt from 'mqtt';
import { GenericContainer, Wait } from 'testcontainers';
import { afterEach, describe, expect, it } from 'vitest';
import { TopicSequences } from '../identity.ts';
import { MqttLink, NotConnectedError } from '../mqtt-link.ts';
import type { UnsPublication } from '../publisher.ts';
import { TEST_PASSWORDS } from '../testing.ts';
import { Outbox, type Transport } from './outbox.ts';

const dirs: string[] = [];
const outboxes: Outbox[] = [];

afterEach(() => {
  for (const outbox of outboxes.splice(0)) outbox.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-test-'));
  dirs.push(dir);
  return join(dir, 'gateway.db');
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await wait(10);
  }
}

function message(seq: number): UnsPublication {
  const telemetry: Telemetry = {
    schema: 'uns.telemetry/1',
    scope: 'topic',
    epoch: 1,
    seq,
    sourceTime: '2026-10-12T03:00:00.000Z',
    receivedAt: '2026-10-15T12:00:00.000Z',
    quality: 'good',
    source: { id: 'cnc-01', protocol: 'opcua' },
    unit: '%',
    value: seq,
  };
  return {
    topic: 'orbis/gebze/machining/cell-m1/cnc-01/telemetry/spindle-load',
    message: telemetry,
    retain: true,
  };
}

/** A broker connection that can go down and come back, and refuse chosen messages. */
class FakeTransport implements Transport {
  connected = false;
  readonly sent: number[] = [];
  refuse = new Set<number>();
  #listeners: (() => void)[] = [];

  onConnect(listener: () => void): void {
    this.#listeners.push(listener);
  }

  up(): void {
    this.connected = true;
    for (const listener of this.#listeners) listener();
  }

  publish(publication: UnsPublication): Promise<void> {
    if (!this.connected) return Promise.reject(new NotConnectedError());
    const seq = publication.message.seq;
    if (this.refuse.has(seq)) {
      return Promise.reject(
        Object.assign(new Error('Publish error: Not authorized'), { code: 0x87 }),
      );
    }
    this.sent.push(seq);
    return Promise.resolve();
  }
}

function open(path: string, transport: Transport, options: { maxMessages?: number } = {}) {
  const drops: [number, string][] = [];
  const outbox = new Outbox({
    path,
    transport,
    flushMs: 5,
    ...options,
    onDrop: (count, reason) => drops.push([count, reason]),
  });
  outboxes.push(outbox);
  return { outbox, drops };
}

describe('store-and-forward outbox (#78, ADR-0014)', () => {
  it('stores while the broker is down and sends everything in order once it is up', async () => {
    const transport = new FakeTransport();
    const { outbox } = open(file(), transport);
    await Promise.all(Array.from({ length: 250 }, (_, i) => outbox.publish(message(i + 1))));
    expect(outbox.depth).toBe(250);
    expect(transport.sent).toEqual([]);
    transport.up();
    await until(() => outbox.depth === 0);
    expect(transport.sent).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    expect(outbox.delivered).toBe(250);
  });

  it('keeps unsent messages across a gateway restart, and sends them first, in order', async () => {
    const path = file();
    const down = new FakeTransport();
    const first = open(path, down);
    for (let i = 1; i <= 40; i++) void first.outbox.publish(message(i));
    first.outbox.close(); // commits what waited
    outboxes.splice(outboxes.indexOf(first.outbox), 1);
    const transport = new FakeTransport();
    const second = open(path, transport);
    expect(second.outbox.depth).toBe(40);
    await second.outbox.publish(message(41));
    transport.up();
    await until(() => second.outbox.depth === 0);
    expect(transport.sent).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
  });

  it('resumes from the first refused message when the connection drops during sending', async () => {
    const transport = new FakeTransport();
    const { outbox } = open(file(), transport);
    transport.up();
    let calls = 0;
    const original = transport.publish.bind(transport);
    transport.publish = (publication) => {
      calls++;
      if (calls === 30) transport.connected = false; // the link drops mid-stream
      return original(publication);
    };
    await Promise.all(Array.from({ length: 60 }, (_, i) => outbox.publish(message(i + 1))));
    await until(() => outbox.depth === 31);
    transport.up();
    await until(() => outbox.depth === 0);
    expect([...new Set(transport.sent)]).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it('drops a message the broker refuses for good, reports it, and does not block the rest', async () => {
    const transport = new FakeTransport();
    transport.refuse.add(3);
    const { outbox, drops } = open(file(), transport);
    transport.up();
    await Promise.all([1, 2, 3, 4, 5].map((seq) => outbox.publish(message(seq))));
    await until(() => outbox.depth === 0);
    expect(transport.sent).toEqual([1, 2, 4, 5]);
    expect(drops).toEqual([[1, 'refused']]);
    expect(outbox.dropped).toBe(1);
  });

  it('is bounded: beyond the limit the oldest messages are dropped and reported', async () => {
    const transport = new FakeTransport();
    const { outbox, drops } = open(file(), transport, { maxMessages: 100 });
    await Promise.all(Array.from({ length: 130 }, (_, i) => outbox.publish(message(i + 1))));
    expect(outbox.depth).toBe(100);
    expect(drops.reduce((sum, [n]) => sum + n, 0)).toBe(30);
    transport.up();
    await until(() => outbox.depth === 0);
    expect(transport.sent[0]).toBe(31);
    expect(transport.sent).toHaveLength(100);
  });

  it('persists the Modbus cursor with the messages of the same commit', async () => {
    const path = file();
    const transport = new FakeTransport();
    const first = open(path, transport);
    first.outbox.set('wsh-01', { epoch: 100, seq: 7 });
    await first.outbox.publish(message(1));
    first.outbox.set('wsh-01', { epoch: 100, seq: 8 }); // not committed yet
    expect(first.outbox.get('wsh-01')).toEqual({ epoch: 100, seq: 8 });
    // A crash now (no close): only the committed cursor survives.
    const second = open(path, new FakeTransport());
    expect(second.outbox.get('wsh-01')).toEqual({ epoch: 100, seq: 7 });
    expect(second.outbox.depth).toBe(1);
  });
});

describe('store-and-forward with the real broker (#78)', () => {
  it('delivers everything stored during a broker outage after the broker comes back', async () => {
    const PORT = 18_831;
    const brokerAt = async () =>
      new GenericContainer('eclipse-mosquitto:2.1.2-alpine')
        .withCopyDirectoriesToContainer([
          {
            source: join(import.meta.dirname, '../../../../config/mosquitto'),
            target: '/mosquitto/config',
          },
        ])
        .withEntrypoint(['/bin/sh', '/mosquitto/config/entrypoint.sh'])
        .withEnvironment({
          MQTT_USERS: Object.entries(TEST_PASSWORDS)
            .map(([user, password]) => `${user}:${password}`)
            .join(' '),
          MQTT_HEALTHCHECK_PASSWORD: TEST_PASSWORDS.healthcheck,
        })
        .withExposedPorts({ container: 1883, host: PORT })
        .withWaitStrategy(Wait.forLogMessage(/running/))
        .start();
    const url = `mqtt://127.0.0.1:${String(PORT)}`;
    let broker = await brokerAt();
    const link = new MqttLink({
      url,
      username: 'gw-01',
      password: TEST_PASSWORDS['gw-01'],
      gatewayId: 'gw-01',
      version: 'test',
      sequences: new TopicSequences(1),
      startedAt: 0,
      reconnectPeriodMs: 300,
    });
    const { outbox } = open(file(), link);
    link.start();
    await until(() => link.connected);
    const received: number[] = [];
    const subscribe = async () => {
      const mes = await mqtt.connectAsync(url, {
        username: 'mes',
        password: TEST_PASSWORDS.mes,
        protocolVersion: 5,
        reconnectPeriod: 0,
      });
      mes.on('message', (_topic, payload) => {
        received.push((JSON.parse(payload.toString()) as { seq: number }).seq);
      });
      await mes.subscribeAsync(message(1).topic, { qos: 1 });
      return mes;
    };
    let mes = await subscribe();
    for (let i = 1; i <= 50; i++) await outbox.publish(message(i));
    await until(() => received.length >= 50);
    await mes.endAsync(true);

    await broker.stop(); // outage
    await until(() => !link.connected);
    for (let i = 51; i <= 300; i++) void outbox.publish(message(i));
    await until(() => outbox.depth === 250);

    broker = await brokerAt();
    mes = await subscribe();
    await until(() => outbox.depth === 0, 30_000);
    await until(() => received.includes(300), 10_000);
    await mes.endAsync(true);
    await link.close();
    await broker.stop();

    const unique = [...new Set(received)];
    expect(unique).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  }, 180_000);
});
