import { describe, expect, it } from 'vitest';
import { hourKpi } from '../test/alarm-fixtures.ts';
import { alarmHourlyOption, DASHED_LINE_ICON } from './alarm-options.ts';
import { CHART_COLORS } from './oee-options.ts';

interface Series {
  name: string;
  data: unknown[];
  markLine?: { data: { yAxis: number }[]; label?: { show?: boolean } };
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

    // The peak series names the served window (#147), and just `window` before it arrived.
    expect(peaks?.name).toBe('Peak per window');
    const fiveMinutes = alarmHourlyOption(hours, 10, 300_000);
    expect((fiveMinutes.series as Series[])[1]?.name).toBe('Peak per 5 min');
    expect((fiveMinutes.legend as { data: unknown[] }).data).toEqual([
      'Raises',
      'Peak per 5 min',
      { name: 'Flood threshold (10)', icon: DASHED_LINE_ICON },
    ]);
  });

  it('names the flood threshold in the legend, not on the plot over the bars (#339)', () => {
    const hours = [hourKpi('2026-10-15T04:00:00.000Z', { raises: 14, peak10: 12 })];
    const series = alarmHourlyOption(hours, 10).series as (Series & {
      type: string;
      lineStyle?: { type: string };
    })[];
    expect(series[1]?.markLine?.label?.show).toBe(false);
    // The legend's entry: a dataless dashed line named after the served threshold.
    expect(series[2]).toMatchObject({ type: 'line', name: 'Flood threshold (10)', data: [] });
    expect(series[2]?.lineStyle?.type).toBe('dashed');
    // No threshold served yet: no line, no entry.
    const none = alarmHourlyOption(hours, undefined);
    expect(none.series as Series[]).toHaveLength(2);
    expect((none.legend as { data: unknown[] }).data).toEqual(['Raises', 'Peak per window']);
  });

  it('draws an hour without alarm activity as a zero bar with no finality (UX-4b)', () => {
    const option = alarmHourlyOption(
      [
        { from: '2026-10-15T03:00:00.000Z', raises: 0, peak10: 0, final: undefined },
        hourKpi('2026-10-15T04:00:00.000Z', { raises: 3, peak10: 2, final: true }),
      ],
      10,
    );
    const [raises] = option.series as Series[];
    expect(raises?.data).toEqual([0, 3]);
    const tooltip = option.tooltip as {
      formatter: (params: { seriesName: string; dataIndex: number }) => string;
    };
    expect(tooltip.formatter({ seriesName: 'Raises', dataIndex: 0 })).toContain(
      '(no alarm activity)',
    );
    expect(tooltip.formatter({ seriesName: 'Raises', dataIndex: 1 })).toContain('(final)');
  });
});
