import { render } from '@testing-library/react';
import type uPlot from 'uplot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartData } from '../domain/series.ts';
import { readFont, readTokens, uplotTheme } from './theme.ts';
import {
  UplotChart,
  isolatedIndices,
  latestIndex,
  options,
  tickSpace,
  timeAxisLabels,
} from './uplot-chart.tsx';

// The machine trend charts (#360): the tails no line reaches, the legend off the chart and the
// dates on the time axis. jsdom has no canvas, so the options' functions are called as uPlot
// calls them, and the component runs over a uPlot stand-in.

const plot = vi.hoisted(() => ({
  instances: [] as { setData: unknown; setScale: unknown; setLegend: unknown; calls: string[] }[],
}));

vi.mock('uplot', () => {
  class FakePlot {
    calls: string[] = [];
    setData = vi.fn(() => this.calls.push('setData'));
    setScale = vi.fn(() => this.calls.push('setScale'));
    setLegend = vi.fn(() => this.calls.push('setLegend'));
    setSize = vi.fn();
    destroy = vi.fn();
    constructor() {
      plot.instances.push(this);
    }
    static tzDate = (date: Date) => date;
  }
  return { default: FakePlot };
});

afterEach(() => {
  plot.instances.length = 0;
  vi.unstubAllGlobals();
});

const s = (iso: string) => Date.parse(iso) / 1000;

describe('the time axis (#360): the state timeline’s ticks and dates', () => {
  it('asks for at most 8 ticks, 4 on an axis narrower than 640 px', () => {
    expect(1000 / tickSpace(1000)).toBeCloseTo(8, 4);
    expect(1000 / tickSpace(1000)).toBeGreaterThan(8);
    expect(640 / tickSpace(640)).toBeCloseTo(8, 4);
    expect(639 / tickSpace(639)).toBeCloseTo(4, 4);
    expect(330 / tickSpace(330)).toBeGreaterThan(4);
  });

  it('writes the time of day only when the window is one plant day', () => {
    // 13:00 to 14:00 in the plant zone (UTC+3).
    const labels = timeAxisLabels(
      [s('2026-10-13T10:10:00Z'), s('2026-10-13T10:20:00Z')],
      s('2026-10-13T10:00:00Z'),
      s('2026-10-13T11:00:00Z'),
      800,
    );
    expect(labels).toEqual(['13:10', '13:20']);
  });

  it('dates the first tick and the first of each new day over 24 h', () => {
    // 14:00 on Tue 13 Oct to 14:00 on Wed 14 Oct in the plant zone, a tick every 3 h.
    const splits = [12, 15, 18, 21, 24, 27, 30, 33].map(
      (hours) => s('2026-10-13T00:00:00Z') + hours * 3600,
    );
    expect(
      timeAxisLabels(splits, s('2026-10-13T11:00:00Z'), s('2026-10-14T11:00:00Z'), 800),
    ).toEqual([
      '15:00\nTue 13 Oct',
      '18:00',
      '21:00',
      '00:00\nWed 14 Oct',
      '03:00',
      '06:00',
      '09:00',
      '12:00',
    ]);
  });

  it('never runs two dates into each other: the leading one gives way, a later one goes', () => {
    // Ten days, a tick at three plant midnights in a row: each 10 % of the window from the last.
    const midnights = [12, 13, 14].map((day) => s(`2026-10-${String(day)}T21:00:00Z`));
    expect(
      timeAxisLabels(midnights, s('2026-10-12T00:00:00Z'), s('2026-10-22T00:00:00Z'), 800),
    ).toEqual(['00:00', '00:00\nWed 14 Oct', '00:00']);
    // Midnight 3 h after the first tick of a 24 h window: the first tick's date gives way.
    const late = [18, 21, 24].map((hours) => s('2026-10-13T00:00:00Z') + hours * 3600);
    expect(timeAxisLabels(late, s('2026-10-13T17:00:00Z'), s('2026-10-14T17:00:00Z'), 800)).toEqual(
      ['21:00', '00:00\nWed 14 Oct', '03:00'],
    );
    // A phone's plot (255 px): 6 h apart, 25 % of the window, is 64 px, too close for two dates.
    const phone = [15, 21, 27, 33].map((hours) => s('2026-10-12T00:00:00Z') + hours * 3600);
    const [from, to] = [s('2026-10-12T14:30:00Z'), s('2026-10-13T11:30:00Z')];
    expect(timeAxisLabels(phone, from, to, 255)).toEqual([
      '18:00',
      '00:00\nTue 13 Oct',
      '06:00',
      '12:00',
    ]);
    expect(timeAxisLabels(phone, from, to, 800)[0]).toBe('18:00\nMon 12 Oct');
    // No width known (not laid out): the percentage alone.
    expect(timeAxisLabels(phone, from, to, 0)[0]).toBe('18:00\nMon 12 Oct');
  });
});

describe('a trend’s data (#360)', () => {
  it('finds the values no line reaches: between gaps, at either end', () => {
    expect(isolatedIndices([1, null, 2, null, null, 3, 4, null, 5])).toEqual([0, 2, 8]);
    expect(isolatedIndices([1, 2, 3])).toEqual([]);
    expect(isolatedIndices([null, Number.NaN, 7])).toEqual([2]);
    expect(isolatedIndices([])).toEqual([]);
  });

  it('finds the latest value of a column', () => {
    expect(latestIndex([1, 2, null])).toBe(1);
    expect(latestIndex([null, null])).toBeUndefined();
  });
});

const DATA: ChartData = [
  [100, 160, 161, 220],
  [18, 19, null, 21.5],
  [24, 25, null, 23],
  [21, 22, null, 22.25],
];

function opts() {
  return options(800, '°C', uplotTheme(readTokens(), readFont()));
}

const chartOf = (data: ChartData = DATA, min = 0, max = 300, width = 800) =>
  ({ data, scales: { x: { min, max } }, over: { clientWidth: width } }) as unknown as uPlot;

describe('the trend’s options (#360)', () => {
  it('shows the latest values in the legend off the chart, the hovered ones on it', () => {
    const series = opts().series;
    type Cell = (u: uPlot, v: number | null, s: number, i: number | null) => string;
    const legend = (index: number, value: number | null, idx: number | null, data = DATA) =>
      (series[index]?.value as Cell)(chartOf(data), value, index, idx);
    // Off the chart: the latest sample's time and values, never `--`.
    expect(legend(0, null, null)).toBe('Thu 01 Jan, 02:03:40');
    expect([1, 2, 3].map((index) => legend(index, null, null))).toEqual(['21.5', '23', '22.25']);
    // On the chart: the hovered sample's; a gap is an em dash.
    expect(legend(0, 160, 1)).toBe('Thu 01 Jan, 02:02:40');
    expect(legend(3, 22, 1)).toBe('22');
    expect(legend(3, null, 2)).toBe('—');
    // No values at all: dashes.
    const none: ChartData = [[1], [null], [null], [null]];
    expect(legend(3, null, null, none)).toBe('—');
    expect(legend(0, null, null, none)).toBe('—');
  });

  it('draws the values no line reaches as points, in the line’s colour', () => {
    const series = opts().series;
    const data: ChartData = [
      [1, 2, 3, 4],
      [1, null, 2, 3],
      [1, null, 2, 3],
      [5, null, null, 6],
    ];
    const filter = (index: number, show: boolean) =>
      (
        series[index]?.points?.filter as (
          u: uPlot,
          s: number,
          show: boolean,
          gaps: null,
        ) => number[] | null
      )(chartOf(data), index, show, null);
    expect(filter(3, false)).toEqual([0, 3]);
    expect(filter(1, false)).toEqual([0]);
    // uPlot draws every point anyway (dense enough): nothing to add.
    expect(filter(3, true)).toBeNull();
    expect(filter(1, false)).not.toBeNull();
    expect(
      (series[1]?.points?.filter as (u: uPlot, s: number, show: boolean) => number[] | null)(
        chartOf([
          [1, 2],
          [1, 2],
          [1, 2],
          [1, 2],
        ]),
        1,
        false,
      ),
    ).toBeNull();
    expect(series[3]?.points?.fill).toBe(series[3]?.stroke);
    expect(series[1]?.points?.stroke).toBe(series[1]?.stroke);
  });

  it('gives the time axis the tick budget and the dated labels of its window', () => {
    const [x] = opts().axes ?? [];
    const space = x?.space as (
      u: uPlot,
      a: number,
      min: number,
      max: number,
      dim: number,
    ) => number;
    expect(space(chartOf(), 0, 0, 1, 1000)).toBe(tickSpace(1000));
    const values = x?.values as (u: uPlot, splits: number[]) => string[];
    const chart = chartOf(DATA, s('2026-10-13T11:00:00Z'), s('2026-10-14T11:00:00Z'));
    expect(values(chart, [s('2026-10-13T12:00:00Z'), s('2026-10-13T21:00:00Z')])).toEqual([
      '15:00\nTue 13 Oct',
      '00:00\nWed 14 Oct',
    ]);
    // 9 h apart on a 255 px plot: about 96 px, room for both dates.
    const phone = chartOf(DATA, s('2026-10-13T11:00:00Z'), s('2026-10-14T11:00:00Z'), 255);
    expect(values(phone, [s('2026-10-13T12:00:00Z'), s('2026-10-13T21:00:00Z')])).toEqual([
      '15:00\nTue 13 Oct',
      '00:00\nWed 14 Oct',
    ]);
    const narrow = chartOf(DATA, s('2026-10-13T11:00:00Z'), s('2026-10-14T11:00:00Z'), 120);
    expect(values(narrow, [s('2026-10-13T12:00:00Z'), s('2026-10-13T21:00:00Z')])).toEqual([
      '15:00',
      '00:00\nWed 14 Oct',
    ]);
  });
});

describe('UplotChart (#360)', () => {
  it('refreshes the legend with each new data, after the data and the scale', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const window = { from: 0, to: 300_000 };
    const { rerender } = render(<UplotChart data={DATA} unit="°C" window={window} />);
    const [chart] = plot.instances;
    expect(chart?.calls).toEqual(['setData', 'setScale', 'setLegend']);
    rerender(<UplotChart data={[[1], [2], [3], [4]]} unit="°C" window={window} />);
    expect(chart?.calls).toEqual([
      'setData',
      'setScale',
      'setLegend',
      'setData',
      'setScale',
      'setLegend',
    ]);
  });
});
