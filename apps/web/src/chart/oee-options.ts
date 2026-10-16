import type { OeeBucketDto, Pareto } from '@shopfloor/contracts/mes-api';
import type { EChartsCoreOption } from 'echarts/core';
import { formatClockTime } from '../domain/time.ts';
import {
  minutesText,
  ratioText,
  stepSign,
  type Waterfall,
  type WaterfallStep,
} from '../domain/oee.ts';

/**
 * ECharts options for the OEE dashboard, built as plain data (tested without a canvas). Values
 * drawn are the API's: bar heights parse the four-decimal strings or the exact ms, labels show
 * the API's text. Every colour has a text label beside it (axis category or legend).
 */

const INK = '#334155';
const GRID_LINE = '#e2e8f0';

export const CHART_COLORS = {
  final: '#0369a1',
  provisional: '#64748b',
  total: '#334155',
  own: '#b91c1c',
  external: '#b45309',
  performance: '#6d28d9',
  quality: '#be185d',
  gain: '#047857',
} as const;

const axisText = { color: INK, fontSize: 12 };

/** Hourly OEE bars of one shift: n/a hours get no bar (and say so in the table), never 0. */
export function hourlyOption(hours: readonly OeeBucketDto[]): EChartsCoreOption {
  const data = hours.map((hour) => {
    const oee = hour.result.oee;
    return {
      value: oee ? Number(oee.decimal) : null,
      itemStyle: { color: hour.final ? CHART_COLORS.final : CHART_COLORS.provisional },
      label: ratioText(oee),
    };
  });
  return {
    grid: { left: 48, right: 12, top: 28, bottom: 32 },
    legend: { show: false },
    tooltip: { trigger: 'item' },
    xAxis: {
      type: 'category',
      data: hours.map((hour) => formatClockTime(hour.start)),
      axisLabel: axisText,
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: (extent: { max: number }) => Math.max(1, extent.max),
      name: 'OEE',
      nameTextStyle: axisText,
      axisLabel: axisText,
      splitLine: { lineStyle: { color: GRID_LINE } },
    },
    series: [
      {
        type: 'bar',
        name: 'OEE',
        barMaxWidth: 36,
        data,
        label: {
          show: true,
          position: 'top',
          color: INK,
          formatter: (params: { dataIndex: number }) => data[params.dataIndex]?.label ?? '',
        },
      },
    ],
  };
}

const STEP_COLOR: Readonly<Record<string, string>> = {
  pbt: CHART_COLORS.total,
  own: CHART_COLORS.own,
  external: CHART_COLORS.external,
  apt: CHART_COLORS.total,
  micro: CHART_COLORS.performance,
  speed: CHART_COLORS.performance,
  quality: CHART_COLORS.quality,
  productive: CHART_COLORS.total,
};

const stepColor = (step: WaterfallStep): string =>
  step.kind === 'gain' ? CHART_COLORS.gain : (STEP_COLOR[step.key] ?? CHART_COLORS.total);

const SHORT_LABEL: Readonly<Record<string, string>> = {
  pbt: 'PBT',
  own: 'Own',
  external: 'External',
  apt: 'APT',
  micro: 'Micro-stops',
  speed: 'Speed',
  quality: 'Quality',
  productive: 'Productive',
};

/**
 * The loss waterfall as two stacked bar series: an invisible base and the visible step, both in
 * minutes. Labels are the exact minutes from the API's ms.
 */
export function waterfallOption(waterfall: Waterfall): EChartsCoreOption {
  const minutes = (ms: number) => ms / 60_000;
  const steps = waterfall.steps;
  return {
    grid: { left: 56, right: 12, top: 28, bottom: 48 },
    tooltip: { trigger: 'item' },
    xAxis: {
      type: 'category',
      data: steps.map((step) => SHORT_LABEL[step.key] ?? step.label),
      axisLabel: { ...axisText, interval: 0, rotate: 30 },
    },
    yAxis: {
      type: 'value',
      name: 'min',
      nameTextStyle: axisText,
      axisLabel: axisText,
      splitLine: { lineStyle: { color: GRID_LINE } },
    },
    series: [
      {
        type: 'bar',
        name: 'base',
        stack: 'waterfall',
        silent: true,
        itemStyle: { color: 'transparent' },
        data: steps.map((step) => minutes(step.from)),
      },
      {
        type: 'bar',
        name: 'Time',
        stack: 'waterfall',
        barMaxWidth: 48,
        data: steps.map((step) => ({
          value: minutes(step.to - step.from),
          itemStyle: { color: stepColor(step) },
        })),
        label: {
          show: true,
          position: 'top',
          color: INK,
          formatter: (params: { dataIndex: number }) => {
            const step = steps[params.dataIndex];
            if (!step) return '';
            return `${stepSign(step)}${minutesText(step.ms).replace(' min', '')}`;
          },
        },
      },
    ],
  };
}

/** Availability loss by reason, largest first, as horizontal bars coloured by own / external. */
export function paretoOption(
  pareto: Pareto,
  limit = 10,
): { option: EChartsCoreOption; height: number } {
  const rows = pareto.reasons.slice(0, limit).reverse();
  const own = rows.map((row) => (row.loss === 'own' ? row.ms / 60_000 : null));
  const external = rows.map((row) => (row.loss === 'external' ? row.ms / 60_000 : null));
  return {
    height: Math.max(140, 48 + rows.length * 28),
    option: {
      grid: { left: 8, right: 40, top: 28, bottom: 24, containLabel: true },
      legend: { top: 0, textStyle: axisText, data: ['Own', 'External'] },
      tooltip: { trigger: 'item' },
      xAxis: {
        type: 'value',
        name: 'min',
        nameTextStyle: axisText,
        axisLabel: axisText,
        splitLine: { lineStyle: { color: GRID_LINE } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((row) => row.name),
        axisLabel: { ...axisText, width: 160, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          name: 'Own',
          stack: 'loss',
          itemStyle: { color: CHART_COLORS.own },
          data: own,
        },
        {
          type: 'bar',
          name: 'External',
          stack: 'loss',
          itemStyle: { color: CHART_COLORS.external },
          data: external,
        },
      ],
    },
  };
}
