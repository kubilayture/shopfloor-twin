import { describe, expect, it } from 'vitest';
import { hourKpi } from '../test/alarm-fixtures.ts';
import { alarmHourlyOption } from './alarm-options.ts';
import { CHART_COLORS } from './oee-options.ts';

interface Series {
  name: string;
  data: unknown[];
  markLine?: { data: { yAxis: number }[] };
}

describe('alarm chart options', () => {
  it('draws raises and peaks per hour from the API integers with the flood threshold', () => {
    const option = alarmHourlyOption([
      hourKpi('2026-10-15T03:00:00.000Z', { raises: 3, peak10: 2, final: true }),
      hourKpi('2026-10-15T04:00:00.000Z', { raises: 14, peak10: 12 }),
    ]);
    const [raises, peaks] = option.series as Series[];
    expect(raises?.data).toEqual([3, 14]);
    expect(peaks?.data).toEqual([
      { value: 2, itemStyle: { color: CHART_COLORS.final } },
      { value: 12, itemStyle: { color: CHART_COLORS.provisional } },
    ]);
    expect(peaks?.markLine?.data).toEqual([{ yAxis: 10 }]);
    expect((option.xAxis as { data: string[] }).data).toEqual(['06:00', '07:00']);
    const max = (option.yAxis as { max: (extent: { max: number }) => number }).max;
    expect(max({ max: 3 })).toBe(12);
    expect(max({ max: 40 })).toBe(40);
  });
});
