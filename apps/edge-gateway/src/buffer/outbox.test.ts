import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Telemetry } from '@shopfloor/contracts';
import mqtt from 'mqtt';
import { afterEach, describe, expect, it } from 'vitest';
import { TopicSequences } from '../identity.ts';
import { MqttLink, NotConnectedError } from '../mqtt-link.ts';
import type { UnsPublication } from '../publisher.ts';
import { TEST_PASSWORDS, TcpProxy, startBroker } from '../testing.ts';
import { Outbox, type Transport } from './outbox.ts';

const dirs: string[] = [];
const outboxes: Outbox[] = [];

afterEach(async () => {
  for (const outbox of outboxes.splice(0)) await outbox.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-test-'));
  dirs.push(dir);
  return join(dir, 'gateway.db');
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a condition; the error names what it waited for, so a failure says which step hung. */
async function until(
  condition: () => boolean,
  timeoutMs = 30_000,
  what = 'the condition',
): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    }
    await wait(10);
  }
}

/** Awaits one step with its own time limit; the error names the step that hung. */
async function within<T>(what: string, timeoutMs: number, step: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(timeoutMs)} ms: ${what}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([step, timeout]);
  } finally {
    clearTimeout(timer);
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

function open(
  path: string,
  transport: Transport,
  options: { maxMessages?: number; retryMs?: number } = {},
) {
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
    await first.outbox.close(); // commits what waited
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
    // Exactly once each, in order: nothing re-sent, nothing overtaken.
    expect(transport.sent).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
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

  it('never evicts command results when it is full (#173)', async () => {
    const transport = new FakeTransport();
    const { outbox, drops } = open(file(), transport, { maxMessages: 100 });
    const result = (seq: number) => ({
      ...message(seq),
      topic: 'orbis/gebze/machining/cell-m1/cnc-01/cmd-res/load-order',
    });
    await Promise.all(Array.from({ length: 5 }, (_, i) => outbox.publish(result(1_001 + i))));
    await Promise.all(Array.from({ length: 130 }, (_, i) => outbox.publish(message(i + 1))));
    expect(outbox.depth).toBe(100);
    expect(drops.reduce((sum, [n]) => sum + n, 0)).toBe(35);
    transport.up();
    await until(() => outbox.depth === 0);
    expect(transport.sent.slice(0, 6)).toEqual([1_001, 1_002, 1_003, 1_004, 1_005, 36]);
  });

  it('pauses after a transient error while connected instead of spinning, and loses nothing', async () => {
    const transport = new FakeTransport();
    const { outbox } = open(file(), transport, { retryMs: 50 });
    transport.up();
    let failures = 0;
    let calls = 0;
    const original = transport.publish.bind(transport);
    transport.publish = (publication) => {
      calls++;
      if (publication.message.seq === 3 && failures < 2) {
        failures++;
        return Promise.reject(new Error('Connection closed')); // no reason code: not a refusal
      }
      return original(publication);
    };
    await Promise.all([1, 2, 3, 4, 5, 6].map((seq) => outbox.publish(message(seq))));
    await until(() => outbox.depth === 0);
    expect(calls).toBeLessThan(15);
    expect([...transport.sent].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(transport.sent).size).toBe(transport.sent.length); // none twice
  });

  it('never trims messages that are already with the broker', async () => {
    const transport = new FakeTransport();
    const pending: (() => void)[] = [];
    transport.publish = () => new Promise<void>((resolve) => pending.push(resolve));
    const { outbox, drops } = open(file(), transport, { maxMessages: 1_000 });
    transport.up();
    await Promise.all(Array.from({ length: 1_030 }, (_, i) => outbox.publish(message(i + 1))));
    expect(pending).toHaveLength(100); // in flight
    expect(drops.reduce((sum, [n]) => sum + n, 0)).toBe(30);
    for (const resolve of pending.splice(0)) resolve();
    await until(() => outbox.delivered === 100);
    expect(outbox.depth).toBeGreaterThanOrEqual(0);
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
    // Each broker on a port Docker picks (no clash with a parallel run, #212). The gateway reaches
    // it through a proxy on a port the OS picks, which stays where the gateway left it across the
    // restart, and keeps the gateway off the restarted broker until the subscriber is back: a
    // fresh broker has no session to catch a late subscriber up, so a message the gateway sent
    // (or MQTT.js re-sent) before the subscription would be lost to the test, not by the gateway.
    const brokerAt = (what: string) => within(what, 90_000, startBroker());
    const target = (brokerUrl: string) => {
      const parsed = new URL(brokerUrl);
      return { host: parsed.hostname, port: Number(parsed.port) };
    };
    let started = await brokerAt('starting the broker');
    let broker = started.container;
    const proxy = await TcpProxy.start(0, target(started.url));
    const link = new MqttLink({
      url: `mqtt://127.0.0.1:${String(proxy.port)}`,
      username: 'gw-01',
      password: TEST_PASSWORDS['gw-01'],
      gatewayId: 'gw-01',
      version: 'test',
      sequences: new TopicSequences(1),
      startedAt: 0,
      reconnectPeriodMs: 300,
    });
    // Records which messages the first broker acknowledged: those are its responsibility.
    const ackedByFirstBroker = new Set<number>();
    let firstBroker = true;
    const transport: Transport = {
      get connected() {
        return link.connected;
      },
      onConnect: (listener) => {
        link.onConnect(listener);
      },
      publish: async (publication) => {
        const onFirst = firstBroker;
        await link.publish(publication);
        if (onFirst && firstBroker) ackedByFirstBroker.add(publication.message.seq);
      },
    };
    const { outbox } = open(file(), transport);
    link.start();
    await until(() => link.connected, 30_000, 'the gateway link to connect to the first broker');
    const received: number[] = [];
    // A just-started broker can accept a TCP connection (Docker's port forward) and never answer
    // it, and a client without reconnects then waits forever (#212): each attempt gets 10 s, and
    // a failed one is closed and tried again.
    const subscribe = async () => {
      for (let attempt = 1; ; attempt++) {
        const mes = mqtt.connect(started.url, {
          username: 'mes',
          password: TEST_PASSWORDS.mes,
          protocolVersion: 5,
          reconnectPeriod: 0,
          connectTimeout: 5_000,
        });
        try {
          await within(
            `subscriber connection, attempt ${String(attempt)}`,
            10_000,
            new Promise((resolve, reject) => {
              mes.once('connect', resolve);
              mes.once('error', reject);
              mes.once('close', () => {
                reject(new Error('connection closed'));
              });
            }),
          );
          mes.on('message', (_topic, payload) => {
            received.push((JSON.parse(payload.toString()) as { seq: number }).seq);
          });
          await within(
            'the subscription',
            10_000,
            mes.subscribeAsync(message(1).topic, { qos: 1 }),
          );
          return mes;
        } catch (error) {
          mes.end(true);
          if (attempt >= 5) throw error;
          await wait(500);
        }
      }
    };
    let mes = await within('subscribing to the first broker', 60_000, subscribe());
    await within(
      'publishing messages 1–50',
      30_000,
      (async () => {
        for (let i = 1; i <= 50; i++) await outbox.publish(message(i));
      })(),
    );
    await until(() => received.length >= 50, 30_000, 'messages 1–50 at the subscriber');

    // Messages 51–100 are on their way when the broker dies: in flight across the outage.
    for (let i = 51; i <= 100; i++) void outbox.publish(message(i));
    // A graceful stop: a broker killed outright also loses what it had acknowledged but not yet
    // passed on, which is the broker's durability, not the gateway's.
    await within('stopping the first broker', 30_000, broker.stop()); // outage
    firstBroker = false;
    proxy.setDown(true); // the gateway finds no broker until the restarted one is ready
    await within('closing the first subscriber', 15_000, mes.endAsync(true));
    await until(() => !link.connected, 30_000, 'the gateway link to notice the outage');
    for (let i = 101; i <= 300; i++) void outbox.publish(message(i));
    await until(() => outbox.depth >= 200, 30_000, 'messages 101–300 stored in the outbox');

    started = await brokerAt('restarting the broker');
    broker = started.container;
    proxy.retarget(target(started.url));
    mes = await within('subscribing to the restarted broker', 60_000, subscribe());
    proxy.setDown(false); // the broker is back for the gateway
    await until(() => outbox.depth === 0, 60_000, 'the outbox to drain after the restart');
    await until(() => received.includes(300), 30_000, 'message 300 at the subscriber');
    await within('closing the second subscriber', 15_000, mes.endAsync(true));
    await within('closing the gateway link', 15_000, link.close());
    await proxy.close();
    await within('stopping the restarted broker', 30_000, broker.stop());

    // The gateway's contract: every message reached a subscriber, or the broker acknowledged it
    // before its outage (what a stopped broker had not passed on yet is the broker's durability).
    const got = new Set(received);
    const unaccounted = Array.from({ length: 300 }, (_, i) => i + 1).filter(
      (seq) => !got.has(seq) && !ackedByFirstBroker.has(seq),
    );
    expect(unaccounted).toEqual([]);
    // Everything published during the outage was delivered after it, in order.
    const afterOutage = received.filter((seq) => seq > 100);
    expect([...new Set(afterOutage)]).toEqual(Array.from({ length: 200 }, (_, i) => 101 + i));
    // Above the sum of the step limits (625 s), so a hang fails with the name of its step.
  }, 700_000);
});
