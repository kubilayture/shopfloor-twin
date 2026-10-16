import type { AlarmKpiBucketDto } from '@shopfloor/contracts/mes-api';
import type { EChartsCoreOption } from 'echarts/core';
import { FLOOD_THRESHOLD } from '../domain/alarms.ts';
import { formatClockTime } from '../domain/time.ts';
import { CHART_COLORS } from './oee-options.ts';

const INK = '#334155';
const GRID_LINE = '#e2e8f0';
const THRESHOLD = '#b91c1c';
const axisText = { color: INK, fontSize: 12 };

/**
 * Raises and the peak per 10 minutes of each hour against the flood threshold line (more than
 * `FLOOD_THRESHOLD` raises in one window is a flood). Values are the API's integers; final hours
 * are drawn darker than provisional ones, and the table beside the chart says which is which.
 */
export function alarmHourlyOption(hours: readonly AlarmKpiBucketDto[]): EChartsCoreOption {
  const colour = (hour: AlarmKpiBucketDto) =>
    hour.final ? CHART_COLORS.final : CHART_COLORS.provisional;
  return {
    grid: { left: 40, right: 12, top: 36, bottom: 32 },
    legend: { top: 0, textStyle: axisText, data: ['Raises', 'Peak per 10 min'] },
    tooltip: { trigger: 'item' },
    xAxis: {
      type: 'category',
      data: hours.map((hour) => formatClockTime(hour.from)),
      axisLabel: axisText,
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: (extent: { max: number }) => Math.max(FLOOD_THRESHOLD + 2, extent.max),
      minInterval: 1,
      axisLabel: axisText,
      splitLine: { lineStyle: { color: GRID_LINE } },
    },
    series: [
      {
        type: 'bar',
        name: 'Raises',
        barMaxWidth: 28,
        itemStyle: { color: CHART_COLORS.total },
        data: hours.map((hour) => hour.raises),
      },
      {
        type: 'bar',
        name: 'Peak per 10 min',
        barMaxWidth: 28,
        itemStyle: { color: CHART_COLORS.final },
        data: hours.map((hour) => ({ value: hour.peak10, itemStyle: { color: colour(hour) } })),
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: THRESHOLD, type: 'dashed', width: 2 },
          label: { color: THRESHOLD, formatter: `Flood threshold (${String(FLOOD_THRESHOLD)})` },
          data: [{ yAxis: FLOOD_THRESHOLD }],
        },
      },
    ],
  };
}
