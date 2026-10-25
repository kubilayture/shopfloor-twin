import { describe, expect, it } from 'vitest';
import { EQUIPMENT } from '../test/fixtures.ts';
import { causeWords, codeWords, groupEquipment, metricName } from './plant.ts';

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

describe('words for the plant model codes', () => {
  it('turns codes into sentence-case words', () => {
    expect(codeWords('NO-ORDER')).toBe('No order');
    expect(codeWords('SPINDLE-OVERLOAD')).toBe('Spindle overload');
    expect(codeWords('coolant-temperature')).toBe('Coolant temperature');
    expect(codeWords(' bath_temperature ')).toBe('Bath temperature');
    expect(metricName('leak-rate')).toBe('Leak rate');
  });

  it('says a cause in words, keeping material and product ids', () => {
    expect(causeWords('TOOL-CHANGE')).toBe('Tool change');
    expect(causeWords('MATERIAL:BLANK-VB')).toBe('Material missing: BLANK-VB');
    expect(causeWords('CHANGEOVER none→VB-100')).toBe('Changeover to VB-100');
    expect(causeWords('CHANGEOVER VB-100→VB-200')).toBe('Changeover from VB-100 to VB-200');
    expect(causeWords('CHANGEOVER VB-100')).toBe('Changeover VB-100');
  });
});
