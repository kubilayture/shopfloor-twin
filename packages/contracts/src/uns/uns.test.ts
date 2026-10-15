import { readFile } from 'node:fs/promises';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Deduplicator, type Identified } from './dedup.ts';
import { generateJsonSchemas } from './json-schema.ts';
import { UNS_SCHEMAS, parseUnsMessage, type UnsMessage } from './payloads.ts';
import {
  alarmTopic,
  cycleTopic,
  isRetained,
  isSysRetained,
  parseEquipmentTopic,
  stateTopic,
  sysTopic,
  telemetryTopic,
} from './topics.ts';

const CNC01 = { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-01' } as const;
const base = {
  scope: 'device',
  epoch: 1_791_774_000,
  seq: 7,
  sourceTime: '2026-10-12T03:10:00.000Z',
  receivedAt: '2026-10-15T14:00:00.123Z',
  quality: 'good',
  source: { id: 'cnc-01', protocol: 'opcua' },
} as const;

const SAMPLES: Record<keyof typeof UNS_SCHEMAS, UnsMessage> = {
  'uns.state.current/1': {
    ...base,
    schema: 'uns.state.current/1',
    kind: 'event',
    value: { state: 'Down', cause: 'SPINDLE-OVERLOAD' },
  },
  'uns.telemetry/1': {
    ...base,
    scope: 'topic',
    schema: 'uns.telemetry/1',
    unit: '%',
    value: 64.2,
  },
  'uns.events.cycle-complete/1': {
    ...base,
    schema: 'uns.events.cycle-complete/1',
    value: {
      product: 'VB-100',
      partId: 42,
      serial: 'VB100-2610-000042',
      result: 'good',
      reason: null,
      measurement: null,
    },
  },
  'uns.alarms/1': {
    ...base,
    schema: 'uns.alarms/1',
    value: { code: 'SPINDLE-OVERLOAD', transition: 'active', severity: 700 },
  },
  'uns.sys.status/1': {
    ...base,
    scope: 'topic',
    source: { id: 'gw-01', protocol: 'internal' },
    schema: 'uns.sys.status/1',
    value: { status: 'online', startedAt: '2026-10-15T13:59:00.000Z', version: '0.1.0' },
  },
  'uns.sys.incident/1': {
    ...base,
    scope: 'topic',
    source: { id: 'gw-01', protocol: 'internal' },
    schema: 'uns.sys.incident/1',
    value: { type: 'sequence-gap', equipment: 'cnc-01', lost: 2, message: 'expected 8, got 10' },
  },
};

describe('UNS topics (plan section 5)', () => {
  it('builds every equipment topic from the ISA-95 path and parses it back', () => {
    const topics = [
      stateTopic(CNC01),
      telemetryTopic(CNC01, 'spindle-load'),
      cycleTopic(CNC01),
      alarmTopic(CNC01, 'SPINDLE-OVERLOAD'),
    ];
    expect(topics).toEqual([
      'orbis/gebze/machining/cell-m1/cnc-01/state/current',
      'orbis/gebze/machining/cell-m1/cnc-01/telemetry/spindle-load',
      'orbis/gebze/machining/cell-m1/cnc-01/events/cycle-complete',
      'orbis/gebze/machining/cell-m1/cnc-01/alarms/spindle-overload',
    ]);
    expect(topics.map((t) => parseEquipmentTopic(t)?.topicClass)).toEqual([
      'state',
      'telemetry',
      'events',
      'alarms',
    ]);
  });

  it.each([
    'orbis/gebze/_sys/edge-gateway/gw-01/status',
    'orbis/gebze/machining/cell-m1/cnc-01/state',
    'orbis/gebze/machining/cell-m1/cnc-01/bogus/x',
    'other/root/machining/cell-m1/cnc-01/state/current',
  ])('does not parse %s as an equipment topic', (topic) => {
    expect(parseEquipmentTopic(topic)).toBeUndefined();
  });

  it('builds _sys topics, which have no equipment level, and rejects bad segments', () => {
    expect(sysTopic('edge-gateway', 'gw-01', 'status')).toBe(
      'orbis/gebze/_sys/edge-gateway/gw-01/status',
    );
    expect(sysTopic('edge-gateway', 'gw-01', 'incidents')).toBe(
      'orbis/gebze/_sys/edge-gateway/gw-01/incidents',
    );
    expect(() => sysTopic('edge-gateway', 'GW 1', 'status')).toThrow(RangeError);
  });

  it('retains state, telemetry and alarms, but not events or incidents', () => {
    expect(
      ['state', 'telemetry', 'alarms', 'events', 'cmd'].map((c) => isRetained(c as never)),
    ).toEqual([true, true, true, false, false]);
    expect([isSysRetained('status'), isSysRetained('incidents')]).toEqual([true, false]);
  });
});

describe('UNS payloads (envelope, plan section 5; ADR-0015)', () => {
  it.each(Object.keys(UNS_SCHEMAS))('accepts a valid %s', (name) => {
    const result = parseUnsMessage(SAMPLES[name as keyof typeof SAMPLES]);
    expect(result).toEqual({ ok: true, message: SAMPLES[name as keyof typeof SAMPLES] });
  });

  it.each([
    ['an unknown schema', { ...SAMPLES['uns.alarms/1'], schema: 'uns.alarms/2' }, /unknown schema/],
    ['a missing epoch', { ...SAMPLES['uns.alarms/1'], epoch: undefined }, /epoch/],
    ['seq 0', { ...SAMPLES['uns.alarms/1'], seq: 0 }, /seq/],
    ['a fractional seq', { ...SAMPLES['uns.alarms/1'], seq: 1.5 }, /seq/],
    [
      'a local time',
      { ...SAMPLES['uns.alarms/1'], sourceTime: '2026-10-12T06:10:00+03:00' },
      /sourceTime/,
    ],
    ['an unknown quality', { ...SAMPLES['uns.alarms/1'], quality: 'ok' }, /quality/],
    ['an extra field', { ...SAMPLES['uns.alarms/1'], extra: 1 }, /extra/],
    [
      'an unknown machine state',
      { ...SAMPLES['uns.state.current/1'], value: { state: 'Broken', cause: null } },
      /state/,
    ],
    ['a state without kind', { ...SAMPLES['uns.state.current/1'], kind: undefined }, /kind/],
    [
      'a snapshot in the device scope',
      { ...SAMPLES['uns.state.current/1'], kind: 'snapshot' },
      /scope/,
    ],
    [
      'a cycle in the topic scope',
      { ...SAMPLES['uns.events.cycle-complete/1'], scope: 'topic' },
      /scope/,
    ],
    ['telemetry in the device scope', { ...SAMPLES['uns.telemetry/1'], scope: 'device' }, /scope/],
    ['telemetry without a unit', { ...SAMPLES['uns.telemetry/1'], unit: undefined }, /unit/],
    [
      'a severity above 1000',
      { ...SAMPLES['uns.alarms/1'], value: { code: 'X', transition: 'active', severity: 1001 } },
      /severity/,
    ],
    [
      'an upper-case equipment id',
      { ...SAMPLES['uns.alarms/1'], source: { id: 'CNC-01', protocol: 'opcua' } },
      /source/,
    ],
    ['a non-object', 'hello', /unknown schema/],
  ])('rejects %s', (_label, input, pattern) => {
    const result = parseUnsMessage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(pattern);
  });

  it('keeps the committed JSON Schema in step with the Zod schemas', async () => {
    const generated = generateJsonSchemas();
    expect(generated.size).toBe(Object.keys(UNS_SCHEMAS).length);
    for (const [file, content] of generated) {
      expect(await readFile(file, 'utf8'), file).toBe(content);
    }
  });
});

const device = (seq: number, epoch = 100, id = 'cnc-01'): Identified => ({
  scope: 'device',
  epoch,
  seq,
  source: { id },
});

describe('Deduplicator: the consumer rule of ADR-0015', () => {
  it('drops re-deliveries and reports nothing missing for an ordered stream', () => {
    const dedup = new Deduplicator();
    const verdicts = [1, 2, 3, 2, 3, 4].map((seq) => dedup.accept('t', device(seq)).status);
    expect(verdicts).toEqual(['new', 'new', 'new', 'duplicate', 'duplicate', 'new']);
    expect(dedup.gaps()).toEqual([]);
  });

  it('shares one device stream across topics and keeps gateway counters per topic', () => {
    const dedup = new Deduplicator();
    expect(dedup.accept('a/state', device(1)).status).toBe('new');
    expect(dedup.accept('a/alarms', device(1)).status).toBe('duplicate');
    const telemetry: Identified = { ...device(1), scope: 'topic' };
    expect(dedup.accept('a/telemetry/x', telemetry).status).toBe('new');
    expect(dedup.accept('a/telemetry/y', telemetry).status).toBe('new');
    expect(dedup.accept('a/telemetry/x', telemetry).status).toBe('duplicate');
    expect(dedup.accept('b/state', device(1, 100, 'cnc-02')).status).toBe('new');
  });

  it('accepts out-of-order deliveries and reports the numbers still missing', () => {
    const dedup = new Deduplicator();
    for (const seq of [1, 2, 5, 3, 8]) dedup.accept('t', device(seq));
    expect(dedup.gaps()).toEqual([
      { stream: 'device:cnc-01', epoch: 100, from: 4, to: 4 },
      { stream: 'device:cnc-01', epoch: 100, from: 6, to: 7 },
    ]);
    dedup.accept('t', device(4));
    expect(dedup.accept('t', device(5)).status).toBe('duplicate');
    expect(dedup.gaps()).toEqual([{ stream: 'device:cnc-01', epoch: 100, from: 6, to: 7 }]);
  });

  it('accepts numbers below the first one seen: a reordered start loses nothing', () => {
    const dedup = new Deduplicator();
    expect([3, 1, 2, 4].map((seq) => dedup.accept('t', device(seq)).status)).toEqual([
      'new',
      'new',
      'new',
      'new',
    ]);
    expect(dedup.gaps()).toEqual([]);
  });

  it('restores retained messages on join without starting the stream or creating gaps', () => {
    const dedup = new Deduplicator();
    // A fresh consumer subscribes: retained state (50) and two retained alarms (48, 30) arrive.
    const retained = [50, 48, 30].map(
      (seq) => dedup.accept('t', device(seq), { retained: true }).status,
    );
    expect(retained).toEqual(['new', 'new', 'new']);
    expect(dedup.accept('t', device(51)).status).toBe('new');
    expect(dedup.accept('t', device(52)).status).toBe('new');
    expect(dedup.gaps()).toEqual([]);
    // A retained copy of something already seen live is a duplicate.
    expect(dedup.accept('t', device(52), { retained: true }).status).toBe('duplicate');
  });

  it('keeps memory proportional to open gaps, not to messages, and writes gaps off when acknowledged', () => {
    const dedup = new Deduplicator();
    dedup.accept('t', device(1));
    for (let seq = 3; seq <= 100_000; seq++) dedup.accept('t', device(seq));
    const [gap] = dedup.gaps();
    expect(dedup.gaps()).toEqual([{ stream: 'device:cnc-01', epoch: 100, from: 2, to: 2 }]);
    if (gap) dedup.acknowledge(gap);
    expect(dedup.gaps()).toEqual([]);
    expect(dedup.accept('t', device(2)).status).toBe('duplicate');
  });

  it('treats a restarted source (new epoch) as new data, hands over the old open gaps, and ignores old epochs', () => {
    const dedup = new Deduplicator();
    for (const seq of [1, 3]) dedup.accept('t', device(seq, 100));
    expect(dedup.accept('t', device(1, 200))).toEqual({
      status: 'new',
      epochChanged: true,
      closedGaps: [{ stream: 'device:cnc-01', epoch: 100, from: 2, to: 2 }],
    });
    expect(dedup.accept('t', device(2, 200)).status).toBe('new');
    expect(dedup.accept('t', device(3, 100)).status).toBe('duplicate');
    expect(dedup.gaps()).toEqual([]);
  });

  it('property: any at-least-once delivery of 1..n in any order yields each number once and no gaps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }).chain((n) =>
          fc.array(fc.integer({ min: 1, max: n }), { maxLength: 60 }).chain((extra) => {
            const deliveries = [...Array.from({ length: n }, (_, i) => i + 1), ...extra];
            return fc.tuple(
              fc.constant(n),
              fc.shuffledSubarray(deliveries, {
                minLength: deliveries.length,
                maxLength: deliveries.length,
              }),
            );
          }),
        ),
        ([n, deliveries]) => {
          const dedup = new Deduplicator();
          const accepted = deliveries.filter(
            (seq) => dedup.accept('t', device(seq)).status === 'new',
          );
          expect(accepted.sort((a, b) => a - b)).toEqual(
            Array.from({ length: n }, (_, i) => i + 1),
          );
          expect(dedup.gaps()).toEqual([]);
        },
      ),
    );
  });

  it('property: removing numbers from an ordered delivery reports exactly the removed inner numbers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 80 }),
        fc.array(fc.integer({ min: 2, max: 79 })),
        (n, lost) => {
          const missing = new Set(lost.filter((l) => l < n));
          const dedup = new Deduplicator();
          for (let seq = 1; seq <= n; seq++) {
            if (!missing.has(seq)) dedup.accept('t', device(seq));
          }
          const reported = dedup
            .gaps()
            .flatMap((g) => Array.from({ length: g.to - g.from + 1 }, (_, i) => g.from + i));
          expect(reported).toEqual([...missing].sort((a, b) => a - b));
        },
      ),
    );
  });
});
