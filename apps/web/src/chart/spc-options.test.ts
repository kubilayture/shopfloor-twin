import { describe, expect, it } from 'vitest';
import { formatPlantTime } from '../domain/time.ts';
import { chart, limitVersion, point, signal } from '../test/quality-fixtures.ts';
import { SPC_COLORS, episodeAreas, spcChartOption, spcTooltip } from './spc-options.ts';

interface Series {
  name: string;
  type: string;
  data: unknown[];
  markArea?: { data: unknown[] };
}

const seriesOf = (option: ReturnType<typeof spcChartOption>) => option.series as Series[];
const named = (option: ReturnType<typeof spcChartOption>, name: string) =>
  seriesOf(option).find((s) => s.name === name);

describe('SPC chart options (#203)', () => {
  const view = chart();

  it('draws the points with signalling and provisional marks, limits per version and zones on I', () => {
    const v2 = limitVersion(2, {
      charts: {
        ...limitVersion(1).charts,
        I: { ...limitVersion(1).charts.I, upper: { value: 4, steps: '4000/1' } },
      },
    });
    const points = [
      point(101, 2.1),
      point(102, 3.5, { rules: [1], final: false }),
      point(103, 2.0, { version: 2 }),
      point(104, 2.0, { version: null }),
    ];
    const option = spcChartOption({
      chart: 'I',
      points,
      limits: [limitVersion(1), v2],
      signals: view.signals,
      retests: view.retests,
      unit: 'Pa/min',
    });
    const [first, second] = named(option, 'Points')?.data as {
      symbol: string;
      itemStyle: { color: string };
      value: [number, number];
    }[];
    expect(first?.symbol).toBe('circle');
    expect(second?.symbol).toBe('diamond');
    expect(second?.itemStyle.color).toBe(SPC_COLORS.signal);
    expect(second?.value[1]).toBe(3.5);
    // The upper limit follows each point's version; a point no version judges has none.
    expect((named(option, 'UCL')?.data as [number, number | null][]).map((d) => d[1])).toEqual([
      3.33,
      3.33,
      4,
      null,
    ]);
    expect((named(option, 'Centre')?.data as [number, number | null][])[0]?.[1]).toBe(2);
    // Zones at 1σ and 2σ on I, left out of the legend.
    expect((named(option, '+2σ')?.data as [number, number][])[0]?.[1]).toBeCloseTo(2.886667, 5);
    expect((named(option, '−1σ')?.data as [number, number][])[0]?.[1]).toBeCloseTo(1.556667, 5);
    expect((option.legend as { data: string[] }).data).toEqual([
      'Points',
      'UCL',
      'Centre',
      'LCL',
      'Retests',
    ]);
    expect(named(option, 'Retests')?.type).toBe('scatter');
    expect((option.yAxis as { scale: boolean }).scale).toBe(true);
  });

  it('draws ranges from zero without zones or retests', () => {
    const option = spcChartOption({
      chart: 'MR',
      points: view.points.MR,
      limits: view.limits,
      signals: view.signals,
      retests: view.retests,
      unit: 'range',
    });
    expect(named(option, '+1σ')).toBeUndefined();
    expect(named(option, 'Retests')).toBeUndefined();
    expect((option.yAxis as { min: number }).min).toBe(0);
    const provisional = (named(option, 'Points')?.data as { symbol: string }[])[0];
    expect(provisional?.symbol).toBe('emptyCircle');
  });

  it('shades each episode of its chart that is not withdrawn; one point gets a visible span', () => {
    const areas = episodeAreas(
      [
        signal(1, {
          status: 'final',
          extentFinal: true,
          last: { ...signal(1).last, at: '2026-10-15T06:00:00.000Z' },
        }),
        signal(2),
        signal(3, { status: 'withdrawn' }),
        signal(4, { chart: 'R' }),
        signal(5, { status: 'final' }),
      ],
      'I',
    ) as [{ name: string; xAxis: number; itemStyle: { color: string } }, { xAxis: number }][];
    expect(areas.map(([a]) => a.name)).toEqual([
      'Rule 1',
      'Rule 1 (provisional)',
      'Rule 1 (extent not final)',
    ]);
    expect(areas[0]?.[0].itemStyle.color).toBe(SPC_COLORS.episodeFinal);
    expect(areas[1]?.[0].itemStyle.color).toBe(SPC_COLORS.episodeProvisional);
    expect(areas[2]?.[0].itemStyle.color).toBe(SPC_COLORS.episodeGrowing);
    const one = areas[1];
    expect((one?.[1].xAxis ?? 0) - (one?.[0].xAxis ?? 0)).toBe(40_000);
    expect(areas[0]?.[0].xAxis).toBe(Date.parse(signal(1).first.at));
  });

  it('writes the tooltip as text', () => {
    const text = spcTooltip({
      seriesName: 'Points',
      value: [Date.parse('2026-10-15T05:41:00.000Z'), 3.5],
      data: { partId: 102, rules: [1, 5], final: false },
    });
    expect(text.split('\n')).toEqual([
      'Points: 3.5',
      formatPlantTime('2026-10-15T05:41:00.000Z'),
      'Part 102 (provisional)',
      'Rules: 1, 5',
    ]);
    expect(spcTooltip({ seriesName: 'UCL', value: [0, null] }).split('\n')[0]).toBe('UCL: –');
    expect(spcTooltip({})).toBe(': –');
  });
});
