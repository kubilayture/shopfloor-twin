import { describe, expect, it } from 'vitest';
import { emptyResult, hourBucket, PARETO, result } from '../test/oee-fixtures.ts';
import { waterfall } from '../domain/oee.ts';
import { CHART_COLORS, hourlyOption, paretoOption, waterfallOption } from './oee-options.ts';

interface Series {
  data: unknown[];
  label?: { formatter: (params: { dataIndex: number }) => string };
}

const series = (option: Record<string, unknown>) => option.series as Series[];

describe('chart options', () => {
  it('draws hourly OEE from the API decimals and leaves n/a hours without a bar', () => {
    const option = hourlyOption([
      hourBucket('cell-m1', '2026-10-15T03:00:00.000Z', { final: true }),
      hourBucket('cell-m1', '2026-10-15T04:00:00.000Z', { result: emptyResult() }),
    ]);
    const [bars] = series(option);
    expect(bars?.data).toEqual([
      { value: 0.63, itemStyle: { color: CHART_COLORS.final } },
      { value: null, itemStyle: { color: CHART_COLORS.provisional } },
    ]);
    expect(bars?.label?.formatter({ dataIndex: 1 })).toBe('n/a');
    expect((option.xAxis as { data: string[] }).data).toEqual(['06:00', '07:00']);
  });

  it('stacks the waterfall on an invisible base so each bar spans its step', () => {
    const steps = waterfall(result());
    if (!steps) throw new Error('fixture has losses');
    const [base, visible] = series(waterfallOption(steps));
    const minutes = (ms: number) => ms / 60_000;
    expect(base?.data).toEqual([0, 850_000, 800_000, 0, 760_000, 700_000, 630_000, 0].map(minutes));
    expect((visible?.data as { value: number }[]).map((bar) => bar.value)).toEqual(
      [1_000_000, 150_000, 50_000, 800_000, 40_000, 60_000, 70_000, 630_000].map(minutes),
    );
    expect(visible?.label?.formatter({ dataIndex: 1 })).toBe('−2.5');
    expect(visible?.label?.formatter({ dataIndex: 7 })).toBe('10.5');
  });

  it('splits the Pareto bars into own and external, largest at the top', () => {
    const { option, height } = paretoOption(PARETO);
    const [own, external] = series(option);
    expect((option.yAxis as { data: string[] }).data).toEqual([
      'Idle, cause not reported',
      'Starved by the upstream station',
      'Spindle overload',
    ]);
    expect(own?.data).toEqual([50_000 / 60_000, null, 100_000 / 60_000]);
    expect(external?.data).toEqual([null, 50_000 / 60_000, null]);
    expect(height).toBeGreaterThanOrEqual(140);
  });
});
