import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { ChartData } from '../domain/series.ts';
import { PLANT_TIME_ZONE, formatClockTime, formatPlantTime } from '../domain/time.ts';
import type { TrendChartProps } from './trend-chart.tsx';

const HEIGHT = 220;

function options(width: number, unit: string): uPlot.Options {
  return {
    width,
    height: HEIGHT,
    tzDate: (seconds) => uPlot.tzDate(new Date(seconds * 1000), PLANT_TIME_ZONE),
    scales: { x: { time: true } },
    series: [
      {
        label: 'Time',
        value: (_chart, seconds) =>
          Number.isFinite(seconds) ? formatPlantTime(seconds * 1000) : '–',
      },
      { label: `Min (${unit})`, stroke: '#64748b', width: 1 },
      { label: `Max (${unit})`, stroke: '#64748b', width: 1 },
      { label: `Average (${unit})`, stroke: '#0f766e', width: 2 },
    ],
    bands: [{ series: [2, 1], fill: 'rgba(15, 118, 110, 0.15)' }],
    axes: [
      { values: (_chart, splits) => splits.map((seconds) => formatClockTime(seconds * 1000)) },
      { label: unit },
    ],
    legend: { live: true },
  };
}

const EMPTY: ChartData = [[], [], [], []];

/** uPlot on a canvas: created once per metric, fed new columns as they change. */
export function UplotChart({ data, unit, window }: TrendChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const chart = new uPlot(options(element.clientWidth, unit), EMPTY, element);
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
  }, [unit]);

  useEffect(() => {
    const chart = plot.current;
    if (!chart) return;
    chart.setData(data, false);
    chart.setScale('x', { min: window.from / 1000, max: window.to / 1000 });
  }, [data, window.from, window.to, unit]);

  return <div ref={container} className="w-full" />;
}
