import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { ChartData } from '../domain/series.ts';
import { plainText } from '../domain/numbers.ts';
import {
  PLANT_TIME_ZONE,
  formatClockTime,
  formatPlantTime,
  plantDayLabel,
  plantDayOf,
} from '../domain/time.ts';
import { readFont, readTokens, uplotTheme, useThemeVersion } from './theme.ts';
import type { TrendChartProps } from './trend-chart.tsx';

/** The compact chart height (design system section 5). */
export const HEIGHT = 240;

/**
 * The time axis' tick budget, the state timeline's rule (#359, `timelineTicks`): at most 8 ticks,
 * 4 on an axis narrower than 640 px (#360).
 */
export const MAX_TICKS = 8;
export const NARROW_TICKS = 4;
export const NARROW_AXIS = 640;
/** The least distance between two dated ticks, in percent of the window (as the timeline's). */
export const MIN_DATE_GAP = 20;
/**
 * And in CSS px: a date (`Mon 12 Oct`) is about 64 px wide, and a trend's plot is narrower than
 * the timeline beside its value axis (about 255 px at 390), where 20 % would run them together.
 */
export const MIN_DATE_GAP_PX = 80;

/**
 * The least space between two time ticks, in CSS px, for an axis `width` px wide: uPlot then
 * takes the first of its round steps (10 min, 1 h, 3 h, ...) that gives at most the budget, as
 * the timeline does. A hair under the even share, so a step that gives exactly the budget (3 h
 * over 24 h) is not lost to rounding.
 */
export function tickSpace(width: number): number {
  const budget = width < NARROW_AXIS ? NARROW_TICKS : MAX_TICKS;
  return (width / budget) * (1 - 1e-6);
}

/**
 * The time axis' labels (#360), the state timeline's date rule: the plant time of day, and
 * under it the plant day (`Tue 13 Oct`) on the first tick and on the first tick of each new day,
 * only when the window spans more than one plant day; a date within `MIN_DATE_GAP` of the one
 * before (or `MIN_DATE_GAP_PX` on a plot `width` px wide) is left out, and when that one is the
 * first tick's, the first gives way to the new day. `splits`, `min` and `max` are in seconds.
 */
export function timeAxisLabels(
  splits: readonly number[],
  min: number,
  max: number,
  width: number,
): string[] {
  const span = max - min;
  const minGap = width > 0 ? Math.max(MIN_DATE_GAP, (MIN_DATE_GAP_PX / width) * 100) : MIN_DATE_GAP;
  const spansDays = span > 0 && plantDayOf(min * 1000) !== plantDayOf(max * 1000);
  const dates: (string | undefined)[] = [];
  let previousDay: string | undefined;
  let lastDated: number | undefined;
  splits.forEach((seconds, index) => {
    const day = plantDayOf(seconds * 1000);
    let date = spansDays && day !== previousDay ? plantDayLabel(day) : undefined;
    previousDay = day;
    if (date !== undefined && lastDated !== undefined) {
      const gap = ((seconds - (splits[lastDated] ?? seconds)) / span) * 100;
      if (gap < minGap) {
        if (lastDated === 0) dates[0] = undefined;
        else date = undefined;
      }
    }
    if (date !== undefined) lastDated = index;
    dates.push(date);
  });
  return splits.map((seconds, index) => {
    const time = formatClockTime(seconds * 1000);
    const date = dates[index];
    return date === undefined ? time : `${time}\n${date}`;
  });
}

type Column = ArrayLike<number | null | undefined>;

const isValue = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

/**
 * The values no line reaches (#360): a sample with a gap (or the end) on both sides, such as the
 * tail of live samples after a gap. uPlot draws a line between neighbours only, so these are
 * drawn as points; without them the trend seems to stop before its latest sample.
 */
export function isolatedIndices(values: Column): number[] {
  const indices: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (isValue(values[index]) && !isValue(values[index - 1]) && !isValue(values[index + 1])) {
      indices.push(index);
    }
  }
  return indices;
}

/** The index of the latest value in a column, if any. */
export function latestIndex(values: Column): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (isValue(values[index])) return index;
  }
  return undefined;
}

/** The average column: the time of its latest value is the latest sample's. */
const AVERAGE = 3;

/**
 * A legend cell (#360): the value under the cursor while it is on the chart, the latest value
 * when it is not (`idx` null), never uPlot's `--` placeholders; a gap is an em dash.
 */
function legendValue(format: (value: number) => string) {
  return (chart: uPlot, value: number | null, series: number, idx: number | null): string => {
    const column = chart.data[series] ?? [];
    let shown: number | null | undefined = value;
    if (idx === null) {
      const at = latestIndex(series === 0 ? (chart.data[AVERAGE] ?? []) : column);
      shown = at === undefined ? undefined : column[at];
    }
    return isValue(shown) ? format(shown) : '—';
  };
}

/**
 * The trend's uPlot options in the theme (theme.ts, design system section 5): the tokens' current
 * values, the axes' font and ticks, dashed split lines on the value axis only. uPlot draws without
 * animation; its legend is its own stylesheet. The time axis has the state timeline's ticks and
 * dates; a value no line reaches is drawn as a point; the legend shows the latest values until the
 * cursor is on the chart (#360).
 */
export function options(
  width: number,
  unit: string,
  theme: ReturnType<typeof uplotTheme>,
): uPlot.Options {
  const line = (label: string, stroke: string, strokeWidth: number): uPlot.Series => ({
    label,
    stroke,
    width: strokeWidth,
    value: legendValue(plainText),
    points: {
      stroke,
      fill: stroke,
      filter: (chart, series, show) => {
        if (show) return null;
        const indices = isolatedIndices(chart.data[series] ?? []);
        return indices.length === 0 ? null : indices;
      },
    },
  });
  return {
    width,
    height: HEIGHT,
    tzDate: (seconds) => uPlot.tzDate(new Date(seconds * 1000), PLANT_TIME_ZONE),
    scales: { x: { time: true } },
    series: [
      {
        label: 'Time',
        value: legendValue((seconds) => formatPlantTime(seconds * 1000)),
      },
      line(`Min (${unit})`, theme.range, 1),
      line(`Max (${unit})`, theme.range, 1),
      line(`Average (${unit})`, theme.average, 2),
    ],
    bands: [{ series: [2, 1], fill: theme.band }],
    axes: [
      {
        ...theme.x,
        space: (_chart, _axis, _min, _max, dim) => tickSpace(dim),
        values: (chart, splits) =>
          timeAxisLabels(
            splits,
            chart.scales.x?.min ?? 0,
            chart.scales.x?.max ?? 0,
            chart.over.clientWidth,
          ),
      },
      { ...theme.y, label: unit },
    ],
    legend: { live: true },
  };
}

const EMPTY: ChartData = [[], [], [], []];

/** uPlot on a canvas: created once per metric, fed new columns as they change. */
export function UplotChart({ data, unit, window }: TrendChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // A new theme on `<html>` (UX-12) draws the chart again with the tokens' new values.
  const themeVersion = useThemeVersion();

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const theme = uplotTheme(readTokens(), readFont());
    const chart = new uPlot(options(element.clientWidth, unit, theme), EMPTY, element);
    plot.current = chart;
    const resize = new ResizeObserver(() => {
      chart.setSize({ width: element.clientWidth, height: HEIGHT });
    });
    resize.observe(element);
    return () => {
      resize.disconnect();
      chart.destroy();
      plot.current = null;
    };
  }, [unit, themeVersion]);

  useEffect(() => {
    const chart = plot.current;
    if (!chart) return;
    chart.setData(data, false);
    chart.setScale('x', { min: window.from / 1000, max: window.to / 1000 });
    // uPlot refreshes its legend on new data only under the cursor: off the chart it would keep
    // the values of the data before (or its `--`) instead of the latest (#360).
    chart.setLegend({});
  }, [data, window.from, window.to, unit, themeVersion]);

  return <div ref={container} className="w-full" />;
}
