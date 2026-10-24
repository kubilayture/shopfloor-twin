import type { OeeBucketDto, Pareto } from '@shopfloor/contracts/mes-api';
import type { EChartsCoreOption } from 'echarts/core';
import { formatClockTime, formatPlantTimeMinutes } from '../domain/time.ts';
import {
  minutesText,
  percentText,
  ratioText,
  stepSign,
  type Waterfall,
  type WaterfallStep,
} from '../domain/oee.ts';
import { CATEGORY_LABEL_WIDTH, CHART_SIZES, CHART_TOKENS, MAX_VALUE_LABELS } from './theme.ts';

/**
 * ECharts options for the OEE dashboard, built as plain data (tested without a canvas). Values
 * drawn are the API's: bar heights parse the four-decimal strings or the exact ms, labels show
 * the API's text. Every colour has a text label beside it (axis category or legend); colours are
 * token references (theme.ts), the axes, fonts and tooltip come from the theme `shopfloor`.
 */

export const CHART_COLORS = {
  final: CHART_TOKENS.series[0],
  provisional: CHART_TOKENS.muted,
  total: CHART_TOKENS.other,
  own: CHART_TOKENS.own,
  external: CHART_TOKENS.external,
  performance: CHART_TOKENS.series[2],
  quality: CHART_TOKENS.series[4],
  gain: CHART_TOKENS.series[3],
} as const;

/** A bar chart's legend (section 5): top-left, square 10 px markers. */
export const barLegend = (data: readonly string[]) => ({
  top: 0,
  left: 0,
  icon: 'rect',
  data,
});

/**
 * A category label (E-07): wrapped to two lines at 180 px, a longer one ends in "…" (the full
 * text is in the tooltip and the table).
 */
export const wrappedLabel = {
  width: CATEGORY_LABEL_WIDTH,
  overflow: 'break',
  lineHeight: 14,
  height: 28,
  lineOverflow: 'truncate',
  ellipsis: '…',
} as const;

/** The ratio axis (0 to 1 as the API sends it) in per cent, the unit as its name. */
const percentAxisLabel = { formatter: (value: number) => String(Math.round(value * 100)) };

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
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'item',
      formatter: (params: { dataIndex: number }) => {
        const hour = hours[params.dataIndex];
        if (!hour) return '';
        return `${formatPlantTimeMinutes(hour.start)}\nOEE: ${percentText(hour.result.oee)} (${hour.final ? 'final' : 'provisional'})`;
      },
    },
    xAxis: {
      type: 'category',
      data: hours.map((hour) => formatClockTime(hour.start)),
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: (extent: { max: number }) => Math.max(1, extent.max),
      name: '%',
      axisLabel: percentAxisLabel,
    },
    series: [
      {
        type: 'bar',
        name: 'OEE',
        barMaxWidth: 36,
        data,
        // E-05: a value label only with few bars, and none on a zero or an n/a hour.
        label: {
          show: hours.length <= MAX_VALUE_LABELS,
          position: 'top',
          formatter: (params: { dataIndex: number }) => {
            const oee = hours[params.dataIndex]?.result.oee;
            return oee && Number(oee.decimal) === 0 ? '' : percentText(oee);
          },
        },
        labelLayout: { hideOverlap: true },
      },
    ],
  };
}

/**
 * The main reading of the hourly chart, for its `aria-label`: "OEE per hour: 0.00 % in all 2
 * hours", or the range and where it is lowest and highest.
 */
export function hourlyReading(hours: readonly OeeBucketDto[]): string {
  const known = hours.flatMap((hour) =>
    hour.result.oee ? [{ hour, value: Number(hour.result.oee.decimal) }] : [],
  );
  const missing = hours.length - known.length;
  const without = missing > 0 ? `; ${String(missing)} without planned time` : '';
  const count = (n: number) => `${String(n)} hour${n === 1 ? '' : 's'}`;
  if (known.length === 0) {
    return `OEE per hour: no hour with planned time in ${count(hours.length)}`;
  }
  let low = known[0];
  let high = known[0];
  for (const item of known) {
    if (low && item.value < low.value) low = item;
    if (high && item.value > high.value) high = item;
  }
  if (!low || !high) return 'OEE per hour';
  if (low.value === high.value) {
    return `OEE per hour: ${percentText(low.hour.result.oee)} in all ${count(known.length)}${without}`;
  }
  return `OEE per hour over ${count(hours.length)}: lowest ${percentText(low.hour.result.oee)} at ${formatClockTime(low.hour.start)}, highest ${percentText(high.hour.result.oee)} at ${formatClockTime(high.hour.start)}${without}`;
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

/** A step's minutes with its sign, as the label and the table write it: "−93.1 min". */
const stepText = (step: WaterfallStep): string => `${stepSign(step)}${minutesText(step.ms)}`;

/**
 * The loss waterfall as two stacked bar series: an invisible base and the visible step, both in
 * minutes. Labels are the exact minutes from the API's ms; a step of zero has none (E-05).
 */
export function waterfallOption(waterfall: Waterfall): EChartsCoreOption {
  const minutes = (ms: number) => ms / 60_000;
  const steps = waterfall.steps;
  return {
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (params: { dataIndex: number }) => {
        const step = steps[params.dataIndex];
        return step ? `${step.label}: ${stepText(step)}` : '';
      },
    },
    xAxis: {
      type: 'category',
      data: steps.map((step) => SHORT_LABEL[step.key] ?? step.label),
      axisLabel: { interval: 0, rotate: 30 },
    },
    yAxis: { type: 'value', min: 0, name: 'min' },
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
          show: steps.length <= MAX_VALUE_LABELS,
          position: 'top',
          formatter: (params: { dataIndex: number }) => {
            const step = steps[params.dataIndex];
            if (!step || step.ms.num === 0n) return '';
            return stepText(step).replace(' min', '');
          },
        },
      },
    ],
  };
}

/** The waterfall's main reading: where it starts and ends, and its largest loss. */
export function waterfallReading(waterfall: Waterfall): string {
  const steps = waterfall.steps;
  const first = steps[0];
  const last = steps.at(-1);
  if (!first || !last) return 'Loss waterfall';
  let largest: WaterfallStep | undefined;
  for (const step of steps) {
    if (step.kind !== 'loss' || step.ms.num === 0n) continue;
    if (!largest || step.to - step.from > largest.to - largest.from) largest = step;
  }
  const loss = largest
    ? `largest loss ${largest.label.toLowerCase()}, ${minutesText(largest.ms)}`
    : 'no loss';
  return `Loss waterfall: ${minutesText(first.ms)} planned busy time to ${minutesText(last.ms)} fully productive; ${loss}`;
}

/** Availability loss by reason, largest first, as horizontal bars coloured by own / external. */
export function paretoOption(
  pareto: Pick<Pareto, 'reasons'>,
  limit = 10,
): { option: EChartsCoreOption; height: number } {
  const rows = pareto.reasons.slice(0, limit).reverse();
  const own = rows.map((row) => (row.loss === 'own' ? row.ms / 60_000 : null));
  const external = rows.map((row) => (row.loss === 'external' ? row.ms / 60_000 : null));
  return {
    height: Math.max(160, 64 + rows.length * 36),
    option: {
      // Right: room for the axis name ("min") after the last tick.
      grid: { left: 8, right: 32, top: 32, bottom: 8, containLabel: true },
      legend: barLegend(['Own', 'External']),
      tooltip: {
        trigger: 'item',
        formatter: (params: { dataIndex: number }) => {
          const row = rows[params.dataIndex];
          if (!row) return '';
          return `${row.name}\n${row.loss === 'own' ? 'Own' : 'External'}: ${minutesText(row.ms)}`;
        },
      },
      xAxis: { type: 'value', min: 0, name: 'min' },
      yAxis: {
        type: 'category',
        data: rows.map((row) => row.name),
        // E-07: the reason wraps instead of being cut ("Starved by the upstream st…").
        axisLabel: { ...wrappedLabel, fontSize: CHART_SIZES.tick },
      },
      series: [
        {
          type: 'bar',
          name: 'Own',
          stack: 'loss',
          barMaxWidth: 24,
          itemStyle: { color: CHART_COLORS.own },
          data: own,
        },
        {
          type: 'bar',
          name: 'External',
          stack: 'loss',
          barMaxWidth: 24,
          itemStyle: { color: CHART_COLORS.external },
          data: external,
        },
      ],
    },
  };
}

/** The Pareto's main reading: the largest reason and how many there are. */
export function paretoReading(pareto: Pick<Pareto, 'reasons'>): string {
  const top = pareto.reasons[0];
  if (!top) return 'Availability loss by reason: none';
  const n = pareto.reasons.length;
  return `Availability loss by reason: largest ${top.name} (${top.loss}), ${minutesText(top.ms)}, of ${String(n)} reason${n === 1 ? '' : 's'}`;
}
