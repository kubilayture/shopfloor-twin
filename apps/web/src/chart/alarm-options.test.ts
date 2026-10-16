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
    const hours = [
      hourKpi('2026-10-15T03:00:00.000Z', { raises: 3, peak10: 2, final: true }),
      hourKpi('2026-10-15T04:00:00.000Z', { raises: 14, peak10: 12 }),
    ];
    const option = alarmHourlyOption(hours, 10);
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

    // The line follows the served threshold (#160), and there is none before it arrived.
    const seven = alarmHourlyOption(hours, 7).series as Series[];
    expect(seven[1]?.markLine?.data).toEqual([{ yAxis: 7 }]);
    const none = alarmHourlyOption(hours, undefined);
    expect((none.series as Series[])[1]?.markLine).toBeUndefined();
    expect((none.yAxis as { max: (extent: { max: number }) => number }).max({ max: 3 })).toBe(3);
  });
});
