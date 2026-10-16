import { EventEmitter } from 'node:events';
import { Registry } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentState, EquipmentChange } from '../equipment/index.ts';
import type { IngestNotice, TelemetryMetric } from '../ingest/index.ts';
import { PushHub, type PushOptions, type PushSources } from './push.ts';
import { serverMessageSchema, type ServerMessage } from './schemas.ts';

/** A socket that records what is sent; `bufferedAmount` is set by the test. */
class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  readonly sent: ServerMessage[] = [];
  pings = 0;
  terminated = false;
  closed: [number | undefined, string | undefined] | undefined;

  send(data: string): void {
    this.sent.push(serverMessageSchema.parse(JSON.parse(data)));
  }

  ping(): void {
    this.pings++;
  }

  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
    this.emit('close');
  }

  terminate(): void {
    this.terminated = true;
    this.emit('close');
  }

  request(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }

  types(): string[] {
    return this.sent.map((m) => m.type);
  }
}

const T0 = Date.parse('2026-10-12T03:00:00.000Z');

const current = (equipment: string, seq: number, state: string): CurrentState => ({
  equipment,
  epoch: 1,
  state,
  cause: null,
  since: new Date(T0 + seq * 1_000),
  seq,
  until: new Date(T0 + seq * 1_000),
});

function fakeSources() {
  const changes = new Set<(change: EquipmentChange) => void>();
  const stored = new Set<(notice: IngestNotice) => void | Promise<void>>();
  const states = new Map<string, CurrentState>();
  let watermark = T0;
  let metrics: TelemetryMetric[] = [];
  let gate: Promise<void> | undefined;
  let metricsCalls = 0;
  const sources: PushSources = {
    equipment: {
      currentStates: () => [...states.values()],
      watermark: () => new Date(watermark),
      watermarks: () => [{ epoch: 1, watermark: new Date(watermark) }],
      onChange: (listener) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
    },
    ingest: {
      onStored: (listener) => {
        stored.add(listener);
        return () => stored.delete(listener);
      },
      telemetryMetrics: async () => {
        metricsCalls++;
        await gate;
        return metrics;
      },
    },
    catalog: new Set(['cnc-01', 'wsh-01']),
  };
  return {
    sources,
    setMetrics(next: TelemetryMetric[]) {
      metrics = next;
    },
    /** Holds telemetry snapshots until the returned function is called. */
    holdSnapshots(): () => void {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        open();
        gate = undefined;
      };
    },
    metricsCalls: () => metricsCalls,
    /** A new state of one equipment, as the equipment module announces it. */
    state(equipment: string, seq: number, state: string) {
      const value = current(equipment, seq, state);
      states.set(equipment, value);
      watermark = Math.max(watermark, value.since.getTime());
      for (const listener of changes) {
        listener({ equipment, epoch: 1, from: null, to: null, current: value });
      }
    },
    /** A stored telemetry sample; returns what each listener returned (ingest awaits it). */
    sample(equipment: string, metric: string, value: number, seq: number): unknown[] {
      const notice: IngestNotice = {
        type: 'sample',
        sample: {
          equipment,
          kind: 'telemetry',
          scope: 'topic',
          epoch: 9,
          seq,
          sourceTime: new Date(T0 + seq * 1_000),
          deviceEpoch: 1,
          telemetry: { metric, value, unit: '°C' },
        },
      };
      return [...stored].map((listener) => listener(notice));
    },
    listeners: () => changes.size + stored.size,
  };
}

/** One turn of the event loop (setImmediate stays real: the hub flushes on it). */
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Moves the fake clock (intervals, timeouts, Date) and lets the flushes run. */
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await tick();
};

const hubs: PushHub[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
});

function setup(options: PushOptions = {}) {
  const fake = fakeSources();
  const hub = new PushHub({ clockMs: 60_000, heartbeatMs: 60_000, ...options });
  hubs.push(hub);
  hub.attach(fake.sources);
  const connect = () => {
    const socket = new FakeSocket();
    hub.connect(socket);
    return socket;
  };
  return { hub, fake, connect };
}

describe('WebSocket push (#97)', () => {
  it('sends a states snapshot, then only real state changes', async () => {
    const { fake, connect } = setup();
    fake.state('cnc-01', 1, 'Running');
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'states' });
    expect(socket.types()).toEqual(['subscribed', 'snapshot']);
    expect(socket.sent[1]).toMatchObject({
      topic: 'states',
      clock: { epoch: 1 },
      states: [{ equipment: 'cnc-01', current: { state: 'Running', seq: 1 } }],
    });
    fake.state('cnc-01', 2, 'Stopped');
    // The same state again (an open interval rewritten as the watermark moves): no delta.
    fake.state('cnc-01', 2, 'Stopped');
    await tick();
    expect(socket.sent.slice(2)).toMatchObject([
      { type: 'state', equipment: 'cnc-01', current: { state: 'Stopped', seq: 2 } },
    ]);
  });

  it('pushes telemetry of subscribed metrics only, after the snapshot', async () => {
    const { fake, connect } = setup();
    fake.setMetrics([
      {
        metric: 'bath-temperature',
        unit: '°C',
        latest: { sourceTime: new Date(T0), value: 59 },
      },
      { metric: 'conveyor-speed', unit: 'm/min', latest: { sourceTime: new Date(T0), value: 2 } },
    ]);
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01', metric: 'bath-temperature' });
    // A sample stored while the snapshot is being read waits behind it.
    fake.sample('wsh-01', 'bath-temperature', 60, 1);
    fake.sample('wsh-01', 'conveyor-speed', 3, 2);
    fake.sample('cnc-01', 'bath-temperature', 1, 3);
    await tick();
    await tick();
    expect(socket.sent).toMatchObject([
      { type: 'subscribed', topic: 'telemetry:wsh-01', metric: 'bath-temperature' },
      { type: 'snapshot', samples: [{ metric: 'bath-temperature', value: 59 }] },
      { type: 'telemetry', equipment: 'wsh-01', metric: 'bath-temperature', value: 60 },
    ]);
    socket.request({ type: 'unsubscribe', topic: 'telemetry:wsh-01', metric: 'bath-temperature' });
    fake.sample('wsh-01', 'bath-temperature', 61, 4);
    await tick();
    expect(socket.types().slice(3)).toEqual(['unsubscribed']);
  });

  it('never makes ingest wait: listeners return at once and send on a later turn', async () => {
    const { fake, connect } = setup();
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01' });
    await tick();
    const before = socket.sent.length;
    expect(fake.sample('wsh-01', 'bath-temperature', 60, 1)).toEqual([undefined]);
    expect(socket.sent.length).toBe(before);
    await tick();
    expect(socket.sent.length).toBe(before + 1);
  });

  it('coalesces deltas for a slow client and catches it up with the latest values', async () => {
    const registry = new Registry();
    const { fake, connect } = setup({ softLimitBytes: 1_000, retryMs: 10, registry });
    const slow = connect();
    const fast = connect();
    for (const socket of [slow, fast]) {
      socket.request({ type: 'subscribe', topic: 'states' });
      socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01' });
    }
    await tick();
    slow.bufferedAmount = 5_000;
    const sentBefore = slow.sent.length;
    for (let seq = 1; seq <= 50; seq++) {
      fake.sample('wsh-01', 'bath-temperature', seq, seq);
      fake.state('cnc-01', seq, seq % 2 === 0 ? 'Running' : 'Stopped');
      await tick();
    }
    expect(fast.sent.filter((m) => m.type === 'telemetry')).toHaveLength(50);
    expect(fast.sent.filter((m) => m.type === 'state')).toHaveLength(50);
    expect(slow.sent.length).toBe(sentBefore);
    slow.bufferedAmount = 0;
    await advance(10);
    expect(slow.sent.slice(sentBefore)).toMatchObject([
      { type: 'telemetry', value: 50 },
      { type: 'state', current: { seq: 50, state: 'Running' } },
    ]);
    expect(await registry.getSingleMetricAsString('mes_push_coalesced_total')).toMatch(/ 98$/m);
  });

  it('disconnects a client whose buffer passes the hard limit', async () => {
    const { hub, fake, connect } = setup({ softLimitBytes: 10, hardLimitBytes: 100 });
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'states' });
    socket.bufferedAmount = 1_000;
    fake.state('cnc-01', 1, 'Running');
    await tick();
    expect(socket.terminated).toBe(true);
    expect(hub.clients).toBe(0);
  });

  it('answers invalid requests with an error and keeps the connection', () => {
    const { connect } = setup({ maxSubscriptions: 1 });
    const socket = connect();
    socket.emit('message', Buffer.from('not json'), false);
    socket.emit('message', Buffer.from('{}'), true);
    // A hub without the alarms module (#142) knows the topic but can't serve it.
    socket.request({ type: 'subscribe', topic: 'alarms' });
    socket.request({ type: 'subscribe', topic: 'alarm-kpi:somewhere' });
    socket.request({ type: 'subscribe', topic: 'states', metric: 'x' });
    socket.request({ type: 'subscribe', topic: 'telemetry:nope' });
    socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01' });
    socket.request({ type: 'subscribe', topic: 'telemetry:cnc-01' });
    expect(socket.sent.filter((m) => m.type === 'error').map((m) => 'code' in m && m.code)).toEqual(
      [
        'invalid-message',
        'invalid-message',
        'unknown-topic',
        'invalid-message',
        'invalid-message',
        'unknown-equipment',
        'too-many-subscriptions',
      ],
    );
    expect(socket.terminated).toBe(false);
  });

  it('pings clients and drops one that missed a pong', async () => {
    const { hub, connect } = setup({ heartbeatMs: 20 });
    const answering = connect();
    const silent = connect();
    // A ping every 20 ms: one client answers each, the other never does.
    for (let i = 0; i < 4; i++) {
      await advance(20);
      answering.emit('pong');
    }
    expect(answering.pings).toBeGreaterThan(1);
    expect(answering.terminated).toBe(false);
    expect(silent.terminated).toBe(true);
    expect(hub.clients).toBe(1);
  });

  it('pushes the plant clock to states subscribers when it moved', async () => {
    const { fake, connect } = setup({ clockMs: 10 });
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'states' });
    await advance(30);
    fake.state('cnc-01', 5, 'Running');
    await advance(30);
    const clocks = socket.sent.filter((m) => m.type === 'clock');
    expect(clocks.at(-1)).toMatchObject({ epoch: 1, watermark: '2026-10-12T03:00:05.000Z' });
    expect(new Set(clocks.map((m) => 'watermark' in m && m.watermark)).size).toBe(clocks.length);
  });

  it('refuses clients over the limit, before attach answers unavailable, and detaches on close', () => {
    const hub = new PushHub({ maxClients: 1 });
    hubs.push(hub);
    const first = new FakeSocket();
    hub.connect(first);
    first.request({ type: 'subscribe', topic: 'states' });
    expect(first.sent).toMatchObject([{ type: 'error', code: 'unavailable' }]);
    const second = new FakeSocket();
    hub.connect(second);
    expect(second.closed).toEqual([1013, 'too many clients']);
    const fake = fakeSources();
    hub.attach(fake.sources);
    expect(fake.listeners()).toBe(2);
    hub.close();
    expect(fake.listeners()).toBe(0);
    expect(first.terminated).toBe(true);
  });

  it('counts every new metric against the subscription limit, not only new equipment', async () => {
    const { fake, connect } = setup({ maxSubscriptions: 4, requestBurst: 2_000 });
    const socket = connect();
    for (let i = 0; i < 1_000; i++) {
      socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01', metric: `m-${String(i)}` });
      await tick();
    }
    expect(socket.sent.filter((m) => m.type === 'subscribed')).toHaveLength(4);
    expect(socket.sent.filter((m) => m.type === 'error')).toHaveLength(996);
    expect(fake.metricsCalls()).toBe(4);
    // Subscribing again to a metric already held, or a whole equipment instead, adds nothing.
    socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01', metric: 'm-0' });
    socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01' });
    await tick();
    expect(socket.sent.filter((m) => m.type === 'subscribed')).toHaveLength(6);
  });

  it('limits the rate of client messages and refills over time', async () => {
    const { connect } = setup({ requestsPerSecond: 10, requestBurst: 20 });
    const socket = connect();
    for (let i = 0; i < 25; i++) socket.request({ type: 'subscribe', topic: 'states' });
    const limited = () =>
      socket.sent.filter((m) => m.type === 'error' && m.code === 'rate-limited').length;
    expect(limited()).toBe(5);
    await advance(1_000);
    for (let i = 0; i < 10; i++) socket.request({ type: 'subscribe', topic: 'states' });
    expect(limited()).toBe(5);
    socket.request({ type: 'subscribe', topic: 'states' });
    expect(limited()).toBe(6);
  });

  it('refuses to unsubscribe one metric of an equipment subscribed whole', async () => {
    const { fake, connect } = setup();
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01' });
    await tick();
    socket.request({ type: 'unsubscribe', topic: 'telemetry:wsh-01', metric: 'bath-temperature' });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'error', code: 'invalid-message' });
    fake.sample('wsh-01', 'bath-temperature', 60, 1);
    await tick();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'telemetry', value: 60 });
  });

  it('sends no telemetry snapshot after the client unsubscribed while it was read', async () => {
    const { fake, connect } = setup();
    const open = fake.holdSnapshots();
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01' });
    socket.request({ type: 'unsubscribe', topic: 'telemetry:wsh-01' });
    open();
    await tick();
    await tick();
    expect(socket.types()).toEqual(['subscribed', 'unsubscribed']);
  });

  it('keeps state deltas flowing while a telemetry snapshot is read', async () => {
    const { fake, connect } = setup();
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'states' });
    const open = fake.holdSnapshots();
    socket.request({ type: 'subscribe', topic: 'telemetry:wsh-01' });
    fake.sample('wsh-01', 'bath-temperature', 60, 1);
    fake.state('cnc-01', 1, 'Running');
    await tick();
    expect(socket.types()).toEqual(['subscribed', 'snapshot', 'subscribed', 'state']);
    open();
    await tick();
    await tick();
    expect(socket.types().slice(4)).toEqual(['snapshot', 'telemetry']);
  });
});
