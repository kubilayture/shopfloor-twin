import type { AlarmKpiBucketDto } from '@shopfloor/contracts/mes-api';
import type { EChartsCoreOption } from 'echarts/core';
import { windowLabel } from '../domain/alarms.ts';
import { formatClockTime, formatPlantTimeMinutes } from '../domain/time.ts';
import { barLegend, CHART_COLORS } from './oee-options.ts';
import { CHART_TOKENS } from './theme.ts';

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
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: barLegend(['Raises', peak]),
    tooltip: {
      trigger: 'item',
      formatter: (params: { seriesName?: string; dataIndex: number; value?: unknown }) => {
        const hour = hours[params.dataIndex];
        if (!hour) return '';
        const value = params.seriesName === 'Raises' ? hour.raises : hour.peak10;
        return `${formatPlantTimeMinutes(hour.from)} (${hour.final ? 'final' : 'provisional'})\n${params.seriesName ?? ''}: ${String(value)}`;
      },
    },
    xAxis: {
      type: 'category',
      data: hours.map((hour) => formatClockTime(hour.from)),
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: (extent: { max: number }) =>
        floodThreshold === undefined ? extent.max : Math.max(floodThreshold + 2, extent.max),
      minInterval: 1,
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
                lineStyle: { color: CHART_TOKENS.limit, type: 'dashed', width: 1.5 },
                // K-03: at the line's right end, above it, not mid-plot.
                label: {
                  position: 'insideEndTop',
                  color: CHART_TOKENS.limit,
                  formatter: `Flood threshold (${String(floodThreshold)})`,
                },
                data: [{ yAxis: floodThreshold }],
              },
            }),
      },
    ],
  };
}

/** The hourly chart's main reading, for its `aria-label`: raises in all, the busiest hour, floods. */
export function alarmHourlyReading(
  hours: readonly AlarmKpiBucketDto[],
  floodThreshold: number | undefined,
  windowMs?: number,
): string {
  const total = hours.reduce((sum, hour) => sum + hour.raises, 0);
  const n = hours.length;
  const span = `${String(n)} hour${n === 1 ? '' : 's'}`;
  let busiest: AlarmKpiBucketDto | undefined;
  for (const hour of hours) if (!busiest || hour.raises > busiest.raises) busiest = hour;
  const most =
    busiest && busiest.raises > 0
      ? `, most at ${formatClockTime(busiest.from)} (${String(busiest.raises)})`
      : '';
  const peak = Math.max(0, ...hours.map((hour) => hour.peak10));
  const flood =
    floodThreshold === undefined
      ? ''
      : `; peak per ${windowLabel(windowMs)} ${String(peak)}, ${
          peak > floodThreshold ? 'above' : 'within'
        } the flood threshold of ${String(floodThreshold)}`;
  return `Alarm raises: ${String(total)} in ${span}${most}${flood}`;
}
