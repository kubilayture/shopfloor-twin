import { alarmTopic, stateTopic, sysTopic, telemetryTopic } from '@shopfloor/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classify } from './classify.ts';
import { add, contains, holes, missing, union, type Range } from './ranges.ts';

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
});
