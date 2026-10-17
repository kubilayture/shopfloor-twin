import {
  alarmSnapshotTopic,
  alarmTopic,
  commandResultTopic,
  jobTopic,
  stateTopic,
  sysTopic,
  telemetryTopic,
} from '@shopfloor/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classify } from './classify.ts';
import { failureKind } from './ingest.ts';
import { add, contains, holes, missing, settledThrough, union, type Range } from './ranges.ts';

const AT = { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-01' } as const;
const base = {
  epoch: 1_760_000_000,
  seq: 4,
  sourceTime: '2026-10-12T03:00:00.000Z',
  receivedAt: '2026-10-15T10:00:00.000Z',
  quality: 'good',
  source: { id: 'cnc-01', protocol: 'opcua' },
} as const;
const stateEvent = {
  ...base,
  schema: 'uns.state.current/1',
  kind: 'event',
  scope: 'device',
  value: { state: 'Running', cause: null },
} as const;

describe('classify (#95)', () => {
  it('turns state events into device facts and snapshots or retained copies into anchors', () => {
    const topic = stateTopic(AT);
    expect(classify(topic, JSON.stringify(stateEvent), false)).toMatchObject({
      kind: 'event',
      stream: 'device:cnc-01',
      eventType: 'state',
    });
    expect(classify(topic, JSON.stringify(stateEvent), true)).toMatchObject({ kind: 'anchor' });
    const snapshot = { ...stateEvent, kind: 'snapshot', scope: 'topic' };
    expect(classify(topic, JSON.stringify(snapshot), false)).toMatchObject({ kind: 'anchor' });
  });

  it('keeps telemetry per topic and treats retained copies of facts as current values only', () => {
    const topic = telemetryTopic(AT, 'spindle-load');
    const sample = { ...base, schema: 'uns.telemetry/1', scope: 'topic', unit: '%', value: 41.5 };
    expect(classify(topic, JSON.stringify(sample), false)).toMatchObject({
      kind: 'telemetry',
      stream: `topic:${topic}`,
      name: 'spindle-load',
    });
    expect(classify(topic, JSON.stringify(sample), true)).toMatchObject({ kind: 'retained' });
  });

  it('rejects with a reason: topic, JSON, schema and topic/payload mismatches', () => {
    const reason = (topic: string, text: string): unknown => {
      const result = classify(topic, text, false);
      return result.kind === 'rejected' ? result.reason : result.kind;
    };
    expect(reason('orbis/gebze/machining/cell-m1/cnc-01/cmd/start', '{}')).toBe('unexpected-topic');
    expect(reason('elsewhere/x', '{}')).toBe('unexpected-topic');
    expect(reason('orbis/gebze/machining/cell-m1/cnc-01/events/other', '{}')).toBe(
      'unexpected-topic',
    );
    expect(reason('orbis/gebze/machining/cell-m1/cnc-01/cmd-res/other', '{}')).toBe(
      'unexpected-topic',
    );
    expect(reason('orbis/gebze/machining/cell-m1/cnc-01/cmd/load-order', '{}')).toBe(
      'unexpected-topic',
    );
    expect(reason('orbis/gebze/machining/cell-m1/cnc-01/state/other', '{}')).toBe(
      'unexpected-topic',
    );
    expect(reason(stateTopic(AT), '{not json')).toBe('invalid-json');
    expect(reason(stateTopic(AT), JSON.stringify({ ...stateEvent, seq: 0 }))).toBe(
      'invalid-payload',
    );
    const otherSource = { ...stateEvent, source: { id: 'cnc-02', protocol: 'opcua' } };
    expect(reason(stateTopic(AT), JSON.stringify(otherSource))).toBe('topic-mismatch');
    expect(reason(telemetryTopic(AT, 'x'), JSON.stringify(stateEvent))).toBe('topic-mismatch');
    const alarm = {
      ...base,
      schema: 'uns.alarms/1',
      scope: 'device',
      value: { code: 'SPINDLE-OVERLOAD', transition: 'active', severity: 800 },
    };
    expect(reason(alarmTopic(AT, 'SPINDLE-OVERLOAD'), JSON.stringify(alarm))).toBe('event');
    expect(reason(alarmTopic(AT, 'OTHER'), JSON.stringify(alarm))).toBe('topic-mismatch');
    // Retained alarm deliveries are anchors (#141); the snapshot topic takes only snapshots.
    expect(classify(alarmTopic(AT, 'SPINDLE-OVERLOAD'), JSON.stringify(alarm), true)).toMatchObject(
      { kind: 'alarm-anchor', equipment: 'cnc-01' },
    );
    expect(reason(alarmSnapshotTopic(AT), JSON.stringify(alarm))).toBe('topic-mismatch');
    const alarmSnapshot = {
      ...base,
      schema: 'uns.alarm-snapshot/1',
      kind: 'snapshot',
      scope: 'topic',
      deviceEpoch: 1_760_000_000,
      asOfSeq: 9,
      value: { active: ['SPINDLE-OVERLOAD'] },
    };
    for (const retained of [false, true]) {
      expect(
        classify(alarmSnapshotTopic(AT), JSON.stringify(alarmSnapshot), retained),
      ).toMatchObject({ kind: 'alarm-snapshot', equipment: 'cnc-01' });
    }
    expect(reason(alarmTopic(AT, 'SPINDLE-OVERLOAD'), JSON.stringify(alarmSnapshot))).toBe(
      'topic-mismatch',
    );
    const incident = {
      ...base,
      schema: 'uns.sys.incident/1',
      scope: 'topic',
      source: { id: 'gw-01', protocol: 'internal' },
      value: { type: 'disconnected', equipment: 'cnc-01', lost: null, message: 'lost' },
    };
    expect(reason(sysTopic('edge-gateway', 'gw-01', 'incidents'), JSON.stringify(incident))).toBe(
      'incident',
    );
    expect(reason(sysTopic('edge-gateway', 'gw-02', 'incidents'), JSON.stringify(incident))).toBe(
      'topic-mismatch',
    );
    expect(reason(sysTopic('edge-gateway', 'gw-01', 'status'), JSON.stringify(incident))).toBe(
      'topic-mismatch',
    );
  });
});

describe('classify: the command path (#174, UNS contract 1.3)', () => {
  const job = {
    ...base,
    schema: 'uns.events.job/1',
    scope: 'device',
    value: {
      transition: 'accepted',
      commandId: 'PO-1~OP10~1',
      orderId: 'PO-1',
      product: 'VB-100',
      quantity: 3,
    },
  } as const;
  const result = {
    schema: 'uns.cmd-res/1',
    scope: 'topic',
    epoch: 1_760_000_100,
    seq: 7,
    source: { id: 'cnc-01', protocol: 'opcua' },
    respondedAt: '2026-10-15T10:00:01.000Z',
    value: {
      result: 'accepted',
      commandId: 'PO-1~OP10~1',
      orderId: 'PO-1',
      deviceEpoch: 1_760_000_000,
      expiresAt: '2026-10-15T10:01:00.000Z',
      statusCode: 'Good',
      position: 1,
      acceptedSeq: 12,
      acceptedAt: '2026-10-12T03:00:00.000Z',
    },
  } as const;

  it('takes job facts as device facts in the machine sequence; a retained copy is no fact', () => {
    expect(classify(jobTopic(AT), JSON.stringify(job), false)).toMatchObject({
      kind: 'event',
      stream: 'device:cnc-01',
      eventType: 'job',
    });
    expect(classify(jobTopic(AT), JSON.stringify(job), true)).toMatchObject({ kind: 'retained' });
    expect(classify(jobTopic(AT), JSON.stringify(stateEvent), false)).toMatchObject({
      kind: 'rejected',
      reason: 'topic-mismatch',
    });
  });

  it('takes cmd-res as a topic stream of the gateway, validated by the command registry', () => {
    const topic = commandResultTopic(AT, 'load-order');
    expect(classify(topic, JSON.stringify(result), false)).toMatchObject({
      kind: 'command-result',
      stream: `topic:${topic}`,
      equipment: 'cnc-01',
    });
    expect(classify(topic, JSON.stringify(result), true)).toMatchObject({ kind: 'retained' });
    const reason = (payload: unknown): unknown => {
      const classified = classify(topic, JSON.stringify(payload), false);
      return classified.kind === 'rejected' ? classified.reason : classified.kind;
    };
    expect(reason({ ...result, source: { id: 'cnc-02', protocol: 'opcua' } })).toBe(
      'topic-mismatch',
    );
    expect(reason(job)).toBe('invalid-payload');
    expect(reason({ ...result, value: { ...result.value, result: 'maybe' } })).toBe(
      'invalid-payload',
    );
    const command = {
      schema: 'uns.cmd.load-order/1',
      scope: 'topic',
      epoch: 1,
      seq: 1,
      source: { id: 'mes-server', protocol: 'internal' },
      issuedAt: '2026-10-15T10:00:00.000Z',
      expiresAt: '2026-10-15T10:01:00.000Z',
      value: {
        commandId: 'PO-1~OP10~1',
        orderId: 'PO-1',
        operation: 'OP10',
        product: 'VB-100',
        quantity: 3,
        notBefore: '2026-10-12T03:00:00.000Z',
        deviceEpoch: 1,
      },
    };
    expect(reason(command)).toBe('topic-mismatch');
    expect(reason({ ...result, respondedAt: '2300-01-01T00:00:00.000Z' })).toBe('invalid-payload');
    expect(
      reason({ ...result, value: { ...result.value, acceptedAt: '1960-01-01T00:00:00.000Z' } }),
    ).toBe('invalid-payload');
    expect(reason({ ...result, value: { ...result.value, commandId: 'PO-1~OP10~1\u0000' } })).toBe(
      'invalid-payload',
    );
  });
});

describe('sequence ranges', () => {
  const model = (numbers: readonly number[]): Range[] =>
    numbers.reduce<Range[]>((acc, n) => add(acc, n), []);

  it('match a plain set of numbers, in any arrival order', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 60 }), { maxLength: 40 }), (numbers) => {
        const ranges = model(numbers);
        const set = new Set(numbers);
        for (let n = 0; n <= 61; n++) expect(contains(ranges, n)).toBe(set.has(n));
        // Sorted, non-overlapping and non-adjacent.
        for (let i = 1; i < ranges.length; i++) {
          expect((ranges[i]?.[0] ?? 0) - (ranges[i - 1]?.[1] ?? 0)).toBeGreaterThan(1);
        }
        const between = holes(ranges).flatMap(([from, to]) =>
          Array.from({ length: to - from + 1 }, (_, i) => from + i),
        );
        const lo = Math.min(...numbers);
        const hi = Math.max(...numbers);
        const expected = numbers.length
          ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).filter((n) => !set.has(n))
          : [];
        expect(between).toEqual(expected);
        if (numbers.length) expect(missing(ranges, lo, hi)).toBe(expected.length);
      }),
    );
  });

  it('unite range lists', () => {
    expect(
      union(
        [
          [1, 2],
          [8, 9],
        ],
        [
          [3, 4],
          [6, 6],
        ],
      ),
    ).toEqual([
      [1, 4],
      [6, 6],
      [8, 9],
    ]);
  });

  it('settle up to the first open hole; a reported hole holds nothing back (#113)', () => {
    expect(settledThrough([], [])).toBeNull();
    expect(settledThrough([[1, 4]], [])).toBe(4);
    // A stream first seen at 3: 1 and 2 may still come, until written off as history.
    expect(settledThrough([[3, 4]], [])).toBeNull();
    expect(settledThrough([[3, 4]], [[1, 2]])).toBe(4);
    // A new epoch's sentinel 0: nothing settled until 1 arrives or the hole is reported.
    expect(settledThrough(add([[0, 0]], 3), [])).toBe(0);
    const seen = model([1, 2, 6, 7, 10]);
    expect(settledThrough(seen, [])).toBe(2);
    expect(settledThrough(seen, [[3, 5]])).toBe(7);
    expect(
      settledThrough(seen, [
        [3, 5],
        [8, 9],
      ]),
    ).toBe(10);
  });
});

describe('failure kinds (ADR-0017)', () => {
  const pg = (code: string): Error => Object.assign(new Error(code), { code });

  it('records only data, integrity and limit errors as unstorable; everything else is retried', () => {
    expect(['22003', '22P02', '23505', '54000'].map((c) => failureKind(pg(c)))).toEqual([
      'data',
      'data',
      'data',
      'data',
    ]);
    // Connection, shutdown, lock timeout, permissions, a deploy's missing table or column,
    // read-only transaction, internal errors, socket and plain errors: never unstorable.
    const retried = [
      '08006',
      '57P01',
      '40001',
      '53300',
      '55P03',
      '55000',
      '42501',
      '42P01',
      '42703',
      '25006',
      'XX000',
      'ECONNREFUSED',
    ];
    expect(retried.map((c) => failureKind(pg(c)))).toEqual(retried.map(() => 'transient'));
    expect(failureKind(new TypeError('bug'))).toBe('transient');
    expect(failureKind('a string')).toBe('transient');
  });
});
