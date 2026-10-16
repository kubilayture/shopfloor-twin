import { describe, expect, it } from 'vitest';
import { ALARM_SNAPSHOT_NAME, equipmentTopic } from './uns-topic.ts';

const cnc01State = {
  area: 'machining',
  workCenter: 'cell-m1',
  equipment: 'cnc-01',
  topicClass: 'state',
  name: 'current',
} as const;

describe('equipmentTopic', () => {
  it('builds the ISA-95 topic path under the site root', () => {
    expect(equipmentTopic(cnc01State)).toBe('orbis/gebze/machining/cell-m1/cnc-01/state/current');
  });

  it.each(['', 'CNC-01', 'cnc 01', 'cnc/01', '#', '+', 'cnc-', '-cnc'])(
    'rejects the segment "%s"',
    (equipment) => {
      expect(() => equipmentTopic({ ...cnc01State, equipment })).toThrow(RangeError);
    },
  );

  it('accepts _snapshot only as the name of an alarms topic (#141)', () => {
    const snapshot = { ...cnc01State, topicClass: 'alarms', name: ALARM_SNAPSHOT_NAME } as const;
    expect(equipmentTopic(snapshot)).toBe('orbis/gebze/machining/cell-m1/cnc-01/alarms/_snapshot');
    expect(() => equipmentTopic({ ...snapshot, topicClass: 'state' })).toThrow(RangeError);
    expect(() => equipmentTopic({ ...snapshot, equipment: '_snapshot' })).toThrow(RangeError);
  });
});
