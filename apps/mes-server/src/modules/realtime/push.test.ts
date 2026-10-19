import { EventEmitter } from 'node:events';
import { Registry } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentState, EquipmentChange } from '../equipment/index.ts';
import type { IngestNotice, TelemetryMetric } from '../ingest/index.ts';
import { fraction } from '@shopfloor/oee-core';
import { lineValue, type LineBucket, type LineChange } from '../oee/index.ts';
import type {
  CharacteristicRecord,
  HoldChange,
  HoldRecord,
  QualityChange,
  SignalRecord,
} from '../quality/index.ts';
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

describe('the quality topic (#200)', () => {
  const characteristic: CharacteristicRecord = {
    id: 'leak-rate',
    name: 'Leak rate',
    equipment: 'lkt-01',
    operation: 'OP40',
    unit: 'Pa/min',
    resolution: 0.001,
    upperSpec: 3.2,
    subgroupSize: 5,
    baselineSubgroups: 20,
    rules: { I: [1, 2, 5], MR: [], Xbar: [1, 2, 5], R: [1] },
    version: 2,
    currentLimits: 1,
    baseline: { needed: 100, final: 100 },
    notice: null,
    signals: { open: 1, unacknowledged: 1 },
  };
  const point = { epoch: 1, partId: 7, pass: 1, at: T0, seq: 7 };
  const signal = (status: SignalRecord['status']): SignalRecord => ({
    id: 3,
    characteristic: 'leak-rate',
    version: 1,
    chart: 'I',
    rule: 1,
    first: point,
    last: point,
    points: 1,
    closedBy: null,
    baseline: false,
    extentFinal: true,
    status,
    detectedAt: new Date(T0),
    detectedPlantAt: null,
    finalAt: null,
    withdrawnAt: null,
    withdrawnReason: null,
    acknowledged: null,
    rowVersion: 1,
  });

  it('pushes signal upserts by id and characteristic summaries, coalesced, to subscribers only', async () => {
    const fake = fakeSources();
    const listeners = new Set<(change: QualityChange) => void>();
    const hub = new PushHub({ clockMs: 60_000, heartbeatMs: 60_000 });
    hubs.push(hub);
    hub.attach({
      ...fake.sources,
      quality: {
        onChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    const emit = (change: QualityChange) => {
      for (const listener of listeners) listener(change);
    };
    const socket = new FakeSocket();
    const other = new FakeSocket();
    hub.connect(socket);
    hub.connect(other);
    socket.request({ type: 'subscribe', topic: 'quality' });
    emit({ type: 'signal', event: 'opened', signal: signal('provisional') });
    emit({ type: 'signal', event: 'final', signal: signal('final') });
    emit({ type: 'characteristic', event: 'readings', characteristic });
    await tick();
    expect(socket.sent).toMatchObject([
      { type: 'subscribed', topic: 'quality' },
      {
        type: 'spc-signal',
        event: 'final',
        signal: { id: 3, status: 'final', ruleText: 'one point beyond a control limit' },
      },
      { type: 'spc-characteristic', event: 'readings', characteristic: { id: 'leak-rate' } },
    ]);
    expect(other.sent).toEqual([]);
    socket.request({ type: 'unsubscribe', topic: 'quality' });
    emit({ type: 'signal', event: 'updated', signal: signal('final') });
    await tick();
    expect(socket.types().slice(3)).toEqual(['unsubscribed']);
  });

  it('pushes a hold’s transitions and scope changes by hold id on the quality topic (#201)', async () => {
    const fake = fakeSources();
    const listeners = new Set<(change: HoldChange) => void>();
    const hub = new PushHub({ clockMs: 60_000, heartbeatMs: 60_000 });
    hubs.push(hub);
    hub.attach({
      ...fake.sources,
      quality: { onChange: () => () => undefined },
      holds: {
        onChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    const hold: HoldRecord = {
      id: '00000000-0000-4000-8000-000000000001',
      subject: { kind: 'lot', id: 'K1' },
      state: 'open',
      reason: 'SUSPECT-LOT',
      openedBy: 'quinn',
      openedAt: new Date(T0),
      openedPlantAt: new Date(T0),
      decidedBy: null,
      decidedAt: null,
      decidedPlantAt: null,
      decisionReason: null,
      transitions: 1,
      version: 1,
      scope: { units: 1, cartons: 1, orders: 1 },
      heldMaterialConsumed: 0,
    };
    const socket = new FakeSocket();
    hub.connect(socket);
    socket.request({ type: 'subscribe', topic: 'quality' });
    for (const listener of listeners) listener({ type: 'hold', event: 'opened', hold });
    for (const listener of listeners) {
      listener({
        type: 'hold',
        event: 'scope',
        hold: { ...hold, scope: { units: 2, cartons: 1, orders: 1 } },
      });
    }
    await tick();
    expect(socket.sent).toMatchObject([
      { type: 'subscribed', topic: 'quality' },
      { type: 'quality-hold', event: 'scope', hold: { id: hold.id, scope: { units: 2 } } },
    ]);
  });

  it('computes the terminal views again on a signal, a hold or a genealogy change (#203)', async () => {
    const fake = fakeSources();
    const quality = new Set<(change: QualityChange) => void>();
    const holds = new Set<(change: HoldChange) => void>();
    const genealogy = new Set<(change: { type: 'units' }) => void>();
    let views = 0;
    const hub = new PushHub({ clockMs: 60_000, heartbeatMs: 60_000, terminalMs: 100 });
    hubs.push(hub);
    const on =
      <T>(set: Set<(change: T) => void>) =>
      (listener: (change: T) => void) => {
        set.add(listener);
        return () => set.delete(listener);
      };
    hub.attach({
      ...fake.sources,
      quality: { onChange: on(quality) },
      holds: { onChange: on(holds) },
      genealogy: { onChange: on(genealogy) },
      terminal: {
        topics: new Map([['line-a1', { members: ['lkt-01'] }]]),
        view: () => {
          views += 1;
          return Promise.resolve({
            workCenter: { id: 'line-a1', name: 'Line A1' },
            shift: null,
            machines: [],
            crew: [],
            orders: [],
            queue: [],
            scrapRecords: [],
            truncated: false,
            quality: { holds: [], signals: [], lots: [], truncated: views % 2 === 0 },
          });
        },
      },
    });
    const socket = new FakeSocket();
    hub.connect(socket);
    socket.request({ type: 'subscribe', topic: 'terminal:line-a1' });
    await advance(200);
    expect(views).toBe(1);
    const point = { epoch: 1, partId: 7, pass: 1, at: T0, seq: 7 };
    const changes: (() => void)[] = [
      () => {
        for (const l of quality) {
          l({
            type: 'signal',
            event: 'opened',
            signal: {
              id: 3,
              characteristic: 'leak-rate',
              version: 1,
              chart: 'I',
              rule: 1,
              first: point,
              last: point,
              points: 1,
              closedBy: null,
              baseline: false,
              extentFinal: false,
              status: 'provisional',
              detectedAt: new Date(T0),
              detectedPlantAt: null,
              finalAt: null,
              withdrawnAt: null,
              withdrawnReason: null,
              acknowledged: null,
              rowVersion: 1,
            },
          });
        }
      },
      () => {
        for (const l of genealogy) l({ type: 'units' });
      },
      () => {
        for (const l of holds) {
          l({
            type: 'hold',
            event: 'scope',
            hold: {
              id: '00000000-0000-4000-8000-000000000001',
              subject: { kind: 'lot', id: 'K1' },
              state: 'open',
              reason: 'SUSPECT-LOT',
              openedBy: 'quinn',
              openedAt: new Date(T0),
              openedPlantAt: null,
              decidedBy: null,
              decidedAt: null,
              decidedPlantAt: null,
              decisionReason: null,
              transitions: 1,
              version: 1,
              scope: { units: 1, cartons: 0, orders: 1 },
              heldMaterialConsumed: 0,
            },
          });
        }
      },
    ];
    for (const [i, change] of changes.entries()) {
      change();
      await advance(200);
      expect(views).toBe(i + 2);
    }
    expect(socket.types().filter((t) => t === 'terminal').length).toBe(3);
  });

  it('answers unknown-topic without a quality source', () => {
    const { connect } = setup();
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'quality' });
    expect(socket.sent).toMatchObject([{ type: 'error', code: 'unknown-topic' }]);
  });
});

describe('the OEE topics’ budgets and the line topic (#232)', () => {
  const HOUR = 3_600_000;
  const bucket = (from: number, kind: 'hour' | 'shift'): LineBucket => ({
    bucket: kind,
    key: kind === 'hour' ? new Date(from).toISOString() : '2026-10-12/A',
    value: lineValue({
      bucket: { from, to: from + (kind === 'hour' ? HOUR : 8 * HOUR) },
      cut: from + HOUR / 2,
      scheduled: [{ from: T0, to: T0 + 8 * HOUR }],
      plannedStops: [],
      packs: [],
      effectiveCycleMs: { 'VB-100': fraction(150_000n) },
    }),
    final: false,
    incidents: [],
    mayRevise: false,
    revision: 0,
  });

  function lineSetup() {
    const fake = fakeSources();
    const lineListeners = new Set<(change: LineChange) => void>();
    let currentCalls = 0;
    let hourStart = T0 + 2 * HOUR;
    const sources: PushSources = {
      ...fake.sources,
      oee: {
        current: () => Promise.resolve({ hour: null, shift: null }),
        onChange: () => () => undefined,
      },
      oeeTopics: new Map([
        ['cnc-01', { scope: 'equipment', members: ['cnc-01'] }],
        ['wsh-01', { scope: 'equipment', members: ['wsh-01'] }],
      ]),
      orderOee: {
        order: () => Promise.resolve(undefined),
        onChange: () => () => undefined,
      },
      lineOee: {
        productionMode: 'orders',
        model: () =>
          Promise.resolve({
            bottlenecks: {},
            effectiveCycleMs: {},
            bottleneckMachines: ['asm-01'],
            packing: ['pck-01'],
            first: ['cnc-01', 'cnc-02'],
            machines: [],
          }),
        current: () => {
          currentCalls++;
          return Promise.resolve({ hour: bucket(hourStart, 'hour'), shift: bucket(T0, 'shift') });
        },
        onChange: (listener) => {
          lineListeners.add(listener);
          return () => lineListeners.delete(listener);
        },
      },
    };
    const hub = new PushHub({
      clockMs: 60_000,
      heartbeatMs: 60_000,
      oeeMs: 10,
      maxOeeTopics: 2,
      maxOrderOeeTopics: 2,
    });
    hubs.push(hub);
    hub.attach(sources);
    const socket = new FakeSocket();
    hub.connect(socket);
    const emit = (change: LineChange) => {
      for (const listener of lineListeners) listener(change);
    };
    return {
      socket,
      emit,
      calls: () => currentCalls,
      moveHour: (to: number) => (hourStart = to),
    };
  }

  it('counts order topics against their own budget, and the line topic against neither', async () => {
    const { socket } = lineSetup();
    for (const topic of [
      'oee:cnc-01',
      'oee:wsh-01',
      'oee:order:PO-1',
      'oee:order:PO-2',
      'oee:order:PO-3',
      'oee:line',
    ]) {
      socket.request({ type: 'subscribe', topic });
    }
    await advance(20);
    const errors = socket.sent.filter((m) => m.type === 'error');
    expect(errors).toMatchObject([
      { code: 'too-many-subscriptions', detail: 'at most 2 order OEE topics' },
    ]);
    expect(
      socket.sent.filter((m) => m.type === 'subscribed').map((m) => ('topic' in m ? m.topic : '')),
    ).toEqual(['oee:cnc-01', 'oee:wsh-01', 'oee:order:PO-1', 'oee:order:PO-2', 'oee:line']);
  });

  it('pushes the line topic’s snapshot, then a delta only for changes it reads', async () => {
    const { socket, emit, calls, moveHour } = lineSetup();
    socket.request({ type: 'subscribe', topic: 'oee:line' });
    await advance(20);
    const snapshot = socket.sent.find((m) => m.type === 'snapshot');
    expect(snapshot).toMatchObject({
      topic: 'oee:line',
      productionMode: 'orders',
      hour: { key: '2026-10-12T05:00:00.000Z', through: '2026-10-12T05:30:00.000Z' },
      shift: { key: '2026-10-12/A' },
    });
    expect(calls()).toBe(1);
    // A late fact of an hour before the topic's shift: not read again.
    emit({ equipment: 'pck-01', from: new Date(T0 - 2 * HOUR), to: new Date(T0 - HOUR) });
    await advance(20);
    expect(calls()).toBe(1);
    // An hour inside its shift, or the orders: computed again (no delta while the body is equal).
    emit({ equipment: 'pck-01', from: new Date(T0 + HOUR), to: new Date(T0 + 2 * HOUR) });
    await advance(20);
    expect(calls()).toBe(2);
    emit({ orders: true });
    await advance(20);
    expect(calls()).toBe(3);
    expect(socket.types().filter((t) => t === 'oee-line')).toEqual([]);
    // The clock moved on: a later hour's change brings the new hour as a delta.
    moveHour(T0 + 3 * HOUR);
    emit({ equipment: 'asm-01', from: new Date(T0 + 3 * HOUR), to: new Date(T0 + 4 * HOUR) });
    await advance(20);
    expect(socket.sent.filter((m) => m.type === 'oee-line')).toMatchObject([
      { hour: { key: '2026-10-12T06:00:00.000Z' } },
    ]);
    socket.request({ type: 'unsubscribe', topic: 'oee:line' });
    expect(socket.types().at(-1)).toBe('unsubscribed');
  });

  it('refuses the line topic without the module', () => {
    const { connect } = setup();
    const socket = connect();
    socket.request({ type: 'subscribe', topic: 'oee:line' });
    expect(socket.sent).toMatchObject([{ type: 'error', code: 'unknown-topic' }]);
  });
});

// The order OEE body is built by the test as JSON (`orderOeeDto` returns what `order()` gives).
vi.mock('./order-oee-dto.ts', () => ({ orderOeeDto: (view: unknown) => view }));

describe('order OEE topics refresh while a part is not final (#233 review)', () => {
  const ratio = { fraction: '1/2', decimal: '0.5000' };
  const body = (lineFinal: boolean) => ({
    orderId: 'PO-1',
    product: 'VB-100',
    status: 'completed',
    oee: {
      availability: ratio,
      performance: ratio,
      quality: ratio,
      oee: ratio,
      anomaly: false,
      provisional: false,
      totals: {
        plannedBusyMs: 1_000,
        actualProductionMs: 500,
        excludedMs: 0,
        longStopMs: 0,
        microStopMs: 0,
        idealMs: 250,
        good: 1,
        scrap: 0,
        rework: 0,
        produced: 1,
      },
      unplanned: { good: 0, produced: 0, idealMs: 0 },
      losses: null,
    },
    open: false,
    pending: false,
    headTimeUnknown: false,
    endLost: false,
    lost: false,
    final: true,
    jobs: [],
    firstPassYield: { firstPassGood: 1, started: 1, yield: ratio, final: true },
    completedAt: new Date(T0).toISOString(),
    cutoffs: [],
    incidents: [],
    mayRevise: false,
    revision: 0,
    line: {
      from: new Date(T0).toISOString(),
      to: new Date(T0 + 60_000).toISOString(),
      through: new Date(T0 + 60_000).toISOString(),
      plannedBusyMs: 60_000,
      good: { 'VB-100': 1 },
      idealMs: '150000/1',
      oee: { fraction: '5/2', decimal: '2.5000' },
      aboveOne: true,
      open: false,
      final: lineFinal,
    },
  });

  function orderSetup() {
    const fake = fakeSources();
    const listeners = new Set<(change: { orderId?: string; machine?: string }) => void>();
    let calls = 0;
    let lineFinal = false;
    const sources: PushSources = {
      ...fake.sources,
      orderOee: {
        order: () => {
          calls++;
          return Promise.resolve(body(lineFinal) as never);
        },
        onChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
    const hub = new PushHub({ clockMs: 60_000, heartbeatMs: 60_000, oeeMs: 10 });
    hubs.push(hub);
    hub.attach(sources);
    const socket = new FakeSocket();
    hub.connect(socket);
    return {
      socket,
      fake,
      calls: () => calls,
      emit: (change: { orderId?: string; machine?: string }) => {
        for (const listener of listeners) listener(change);
      },
      finish: () => {
        lineFinal = true;
      },
    };
  }

  it('reads an order whose line OEE is open again on ASM-01 and PCK-01 changes and the clock, and stops once all is final', async () => {
    const { socket, fake, calls, emit, finish } = orderSetup();
    socket.request({ type: 'subscribe', topic: 'oee:order:PO-1' });
    await advance(20);
    expect(socket.sent.find((m) => m.type === 'snapshot')).toMatchObject({
      topic: 'oee:order:PO-1',
      order: { final: true, line: { final: false } },
    });
    expect(calls()).toBe(1);
    // The bottleneck's pieces (the order has no job on ASM-01): read again.
    emit({ machine: 'asm-01' });
    await advance(20);
    expect(calls()).toBe(2);
    emit({ machine: 'pck-01' });
    await advance(20);
    expect(calls()).toBe(3);
    // The plant clock moving: read again (the open line value runs to it).
    fake.state('cnc-01', 30, 'Running');
    await advance(20);
    expect(calls()).toBe(4);
    // Now every part is final: a delta, then ASM-01 and the clock no longer read it again.
    finish();
    emit({ machine: 'asm-01' });
    await advance(20);
    expect(calls()).toBe(5);
    expect(socket.sent.filter((m) => m.type === 'oee-order').at(-1)).toMatchObject({
      order: { line: { final: true } },
    });
    emit({ machine: 'asm-01' });
    fake.state('cnc-01', 60, 'Idle');
    await advance(20);
    expect(calls()).toBe(5);
    // Its own order's change still does.
    emit({ orderId: 'PO-1' });
    await advance(20);
    expect(calls()).toBe(6);
  });
});
