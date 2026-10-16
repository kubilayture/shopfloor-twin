import type { AlarmKpiBucketDto } from '@shopfloor/contracts/mes-api';
import type { EChartsCoreOption } from 'echarts/core';
import { windowLabel } from '../domain/alarms.ts';
import { formatClockTime } from '../domain/time.ts';
import { CHART_COLORS } from './oee-options.ts';

const INK = '#334155';
const GRID_LINE = '#e2e8f0';
const THRESHOLD = '#b91c1c';
const axisText = { color: INK, fontSize: 12 };

/**
 * Raises and the peak per window of each hour against the flood threshold line (more than
 * `floodThreshold` raises in one window is a flood; served by `GET /alarms/config`, #160, and
 * without a line until it arrived). The peak series is named after the served `windowMs` (#147). Values are the API's integers; final hours are drawn darker
 * than provisional ones, and the table beside the chart says which is which.
 */
export function alarmHourlyOption(
  hours: readonly AlarmKpiBucketDto[],
  floodThreshold: number | undefined,
  windowMs?: number,
): EChartsCoreOption {
  const peak = `Peak per ${windowLabel(windowMs)}`;
  const colour = (hour: AlarmKpiBucketDto) =>
    hour.final ? CHART_COLORS.final : CHART_COLORS.provisional;
  return {
    grid: { left: 40, right: 12, top: 36, bottom: 32 },
    legend: { top: 0, textStyle: axisText, data: ['Raises', peak] },
    tooltip: { trigger: 'item' },
    xAxis: {
      type: 'category',
      data: hours.map((hour) => formatClockTime(hour.from)),
      axisLabel: axisText,
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: (extent: { max: number }) =>
        floodThreshold === undefined ? extent.max : Math.max(floodThreshold + 2, extent.max),
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
        name: peak,
        barMaxWidth: 28,
        itemStyle: { color: CHART_COLORS.final },
        data: hours.map((hour) => ({ value: hour.peak10, itemStyle: { color: colour(hour) } })),
        ...(floodThreshold === undefined
          ? {}
          : {
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: THRESHOLD, type: 'dashed', width: 2 },
                label: {
                  color: THRESHOLD,
                  formatter: `Flood threshold (${String(floodThreshold)})`,
                },
                data: [{ yAxis: floodThreshold }],
              },
            }),
      },
    ],
  };
}
