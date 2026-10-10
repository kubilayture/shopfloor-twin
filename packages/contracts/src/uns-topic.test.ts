import { describe, expect, it } from 'vitest';
import { equipmentTopic } from './uns-topic.ts';

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
});
