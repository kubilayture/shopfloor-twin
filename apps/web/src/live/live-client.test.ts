import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { socketFactory } from '../test/fake-socket.ts';
import { LiveClient, sameOriginWsUrl, type LiveClientOptions } from './live-client.ts';

function setup(options: Partial<LiveClientOptions> = {}) {
  const factory = socketFactory();
  const client = new LiveClient({
    url: 'ws://localhost/api/v1/ws',
    createSocket: factory.create,
    random: () => 0.5,
    ...options,
  });
  return { client, factory };
}

describe('LiveClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes once the socket opens and shares repeated subscriptions', () => {
    const { client, factory } = setup();
    const offA = client.subscribe('states');
    const offB = client.subscribe('states');
    client.start();
    expect(client.status).toBe('connecting');
    factory.last.open();
    expect(client.status).toBe('open');
    expect(factory.last.sent).toEqual([{ type: 'subscribe', topic: 'states' }]);

    offA();
    offA();
    expect(factory.last.sent).toHaveLength(1);
    offB();
    expect(factory.last.sent.at(-1)).toEqual({ type: 'unsubscribe', topic: 'states' });
  });

  it('sends a subscription made while open, with its metric', () => {
    const { client, factory } = setup();
    client.start();
    factory.last.open();
    const off = client.subscribe('telemetry:wsh-01', 'bath-temperature');
    expect(factory.last.sent).toEqual([
      { type: 'subscribe', topic: 'telemetry:wsh-01', metric: 'bath-temperature' },
    ]);
    off();
    expect(factory.last.sent.at(-1)).toEqual({
      type: 'unsubscribe',
      topic: 'telemetry:wsh-01',
      metric: 'bath-temperature',
    });
  });

  it('reconnects with exponential backoff and resubscribes every topic', () => {
    const { client, factory } = setup({ initialDelayMs: 500, maxDelayMs: 2_000 });
    client.subscribe('states');
    client.subscribe('telemetry:cnc-01');
    const statuses: string[] = [];
    client.onStatus(() => statuses.push(`${client.status}:${String(client.attempt)}`));
    client.start();
    factory.last.open();

    factory.last.drop();
    expect(client.status).toBe('reconnecting');
    expect(factory.sockets).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(factory.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(factory.sockets).toHaveLength(2);

    factory.last.drop();
    vi.advanceTimersByTime(999);
    expect(factory.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(factory.sockets).toHaveLength(3);

    factory.last.drop();
    vi.advanceTimersByTime(2_000);
    expect(factory.sockets).toHaveLength(4);
    factory.last.drop();
    vi.advanceTimersByTime(2_000);
    expect(factory.sockets).toHaveLength(5);

    factory.last.open();
    expect(client.status).toBe('open');
    expect(client.attempt).toBe(0);
    expect(factory.last.sent).toEqual([
      { type: 'subscribe', topic: 'states' },
      { type: 'subscribe', topic: 'telemetry:cnc-01' },
    ]);
    expect(statuses).toContain('reconnecting:4');
    expect(statuses.at(-1)).toBe('open:0');
  });

  it('spreads reconnects with jitter', () => {
    const { client, factory } = setup({ initialDelayMs: 1_000, random: () => 0 });
    client.start();
    factory.last.drop();
    vi.advanceTimersByTime(749);
    expect(factory.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(factory.sockets).toHaveLength(2);
  });

  it('retries a socket that cannot be created', () => {
    let fail = true;
    const factory = socketFactory();
    const client = new LiveClient({
      url: 'ws://x',
      random: () => 0.5,
      createSocket: (url) => {
        if (fail) throw new Error('bad url');
        return factory.create(url);
      },
    });
    client.start();
    expect(client.status).toBe('reconnecting');
    fail = false;
    vi.advanceTimersByTime(500);
    expect(factory.sockets).toHaveLength(1);
  });

  it('paces its messages below the MES rate limit', () => {
    const { client, factory } = setup({ messagesPerSecond: 5, burst: 2 });
    client.start();
    factory.last.open();
    for (const id of ['a', 'b', 'c', 'd']) client.subscribe(`telemetry:${id}`);
    expect(factory.last.sent).toHaveLength(2);
    vi.advanceTimersByTime(200);
    expect(factory.last.sent).toHaveLength(3);
    vi.advanceTimersByTime(200);
    expect(factory.last.sent.map((message) => message.topic)).toEqual([
      'telemetry:a',
      'telemetry:b',
      'telemetry:c',
      'telemetry:d',
    ]);
  });

  it('drops a queued subscription that is released before it was sent', () => {
    const { client, factory } = setup({ messagesPerSecond: 5, burst: 1 });
    client.start();
    factory.last.open();
    client.subscribe('telemetry:a');
    const off = client.subscribe('telemetry:b');
    off();
    vi.advanceTimersByTime(1_000);
    expect(factory.last.sent).toEqual([{ type: 'subscribe', topic: 'telemetry:a' }]);
  });

  it('asks again for unconfirmed subscriptions after busy or rate-limited errors', () => {
    const { client, factory } = setup();
    client.subscribe('states');
    client.subscribe('telemetry:cnc-01');
    client.start();
    const socket = factory.last;
    socket.open();
    socket.receive({ type: 'subscribed', topic: 'states', metric: null });
    socket.receive({ type: 'error', code: 'busy', detail: 'too many snapshots at a time' });
    socket.receive({ type: 'error', code: 'rate-limited', detail: 'slow down' });
    expect(socket.sent).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(socket.sent.slice(2)).toEqual([{ type: 'subscribe', topic: 'telemetry:cnc-01' }]);

    socket.receive({ type: 'error', code: 'unavailable', detail: 'starting' });
    vi.advanceTimersByTime(1_999);
    expect(socket.sent).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(socket.sent).toHaveLength(4);
    expect(client.lastError).toBeUndefined();
  });

  it('keeps errors that a retry would not fix', () => {
    const { client, factory } = setup();
    client.subscribe('telemetry:nope');
    client.start();
    factory.last.open();
    factory.last.receive({ type: 'error', code: 'unknown-equipment', detail: 'nope' });
    vi.advanceTimersByTime(10_000);
    expect(factory.last.sent).toHaveLength(1);
    expect(client.lastError).toMatchObject({ code: 'unknown-equipment' });
  });

  it('passes valid messages on and ignores frames it cannot parse', () => {
    const { client, factory } = setup();
    const received: string[] = [];
    client.onMessage((message) => received.push(message.type));
    client.start();
    factory.last.open();
    factory.last.receive('not json');
    factory.last.receive(JSON.stringify({ type: 'state', equipment: 'x' }));
    factory.last.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(2) }));
    factory.last.receive({ type: 'clock', epoch: 1, watermark: '2026-10-15T06:00:00.000Z' });
    expect(received).toEqual(['clock']);
  });

  it('stops for good: no reconnect, the socket closed', () => {
    const { client, factory } = setup();
    client.start();
    const socket = factory.last;
    socket.open();
    client.stop();
    expect(client.status).toBe('stopped');
    expect(socket.closedByClient).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(factory.sockets).toHaveLength(1);

    client.start();
    expect(factory.sockets).toHaveLength(2);
    client.start();
    expect(factory.sockets).toHaveLength(2);
  });

  it('ignores a close from a socket it already replaced', () => {
    const { client, factory } = setup();
    client.start();
    const first = factory.last;
    first.drop();
    vi.advanceTimersByTime(1_000);
    factory.last.open();
    first.drop();
    expect(client.status).toBe('open');
  });
});

describe('sameOriginWsUrl', () => {
  it('uses ws for http pages and wss for https pages', () => {
    expect(
      sameOriginWsUrl('/api/v1/ws', { protocol: 'http:', host: 'localhost:5173' } as Location),
    ).toBe('ws://localhost:5173/api/v1/ws');
    expect(
      sameOriginWsUrl('/api/v1/ws', { protocol: 'https:', host: 'mes.example' } as Location),
    ).toBe('wss://mes.example/api/v1/ws');
  });
});
