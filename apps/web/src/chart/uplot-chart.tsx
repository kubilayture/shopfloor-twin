import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { ChartData } from '../domain/series.ts';
import { PLANT_TIME_ZONE, formatClockTime, formatPlantTime } from '../domain/time.ts';
import { readFont, readTokens, uplotTheme, useThemeVersion } from './theme.ts';
import type { TrendChartProps } from './trend-chart.tsx';

/** The compact chart height (design system section 5). */
export const HEIGHT = 240;

/**
 * The trend's uPlot options in the theme (theme.ts, design system section 5): the tokens' current
 * values, the axes' font and ticks, dashed split lines on the value axis only. uPlot draws without
 * animation; its legend is its own stylesheet.
 */
export function options(
  width: number,
  unit: string,
  theme: ReturnType<typeof uplotTheme>,
): uPlot.Options {
  return {
    width,
    height: HEIGHT,
    tzDate: (seconds) => uPlot.tzDate(new Date(seconds * 1000), PLANT_TIME_ZONE),
    scales: { x: { time: true } },
    series: [
      {
        label: 'Time',
        value: (_chart, seconds) =>
          Number.isFinite(seconds) ? formatPlantTime(seconds * 1000) : '—',
      },
      { label: `Min (${unit})`, stroke: theme.range, width: 1 },
      { label: `Max (${unit})`, stroke: theme.range, width: 1 },
      { label: `Average (${unit})`, stroke: theme.average, width: 2 },
    ],
    bands: [{ series: [2, 1], fill: theme.band }],
    axes: [
      {
        ...theme.x,
        values: (_chart, splits) => splits.map((seconds) => formatClockTime(seconds * 1000)),
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
  }, [data, window.from, window.to, unit, themeVersion]);

  return <div ref={container} className="w-full" />;
}
