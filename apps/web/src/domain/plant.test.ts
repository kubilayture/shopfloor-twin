import { describe, expect, it } from 'vitest';
import { EQUIPMENT } from '../test/fixtures.ts';
import { groupEquipment } from './plant.ts';

describe('groupEquipment', () => {
  it('groups by area and work center in line order', () => {
    const areas = groupEquipment(EQUIPMENT);
    expect(areas.map((area) => area.name)).toEqual(['Machining', 'Assembly']);
    expect(areas[0]?.workCenters[0]?.equipment.map((item) => item.id)).toEqual([
      'cnc-01',
      'wsh-01',
    ]);
    expect(areas[1]?.workCenters.map((center) => center.name)).toEqual(['Line A1']);
  });
});
