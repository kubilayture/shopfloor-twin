import type {
  LimitVersionDto,
  SpcChartName,
  SpcMeasurementDto,
  SpcPointDto,
  SpcSignalDto,
} from '@shopfloor/contracts/mes-api';
import type { EChartsCoreOption } from 'echarts/core';
import {
  plainText,
  pointDecimals,
  spcPrecision,
  spcValueText,
  type SpcPrecision,
} from '../domain/numbers.ts';
import { isGrowing } from '../domain/quality.ts';
import { formatPlantTime } from '../domain/time.ts';

// One SPC chart (#203, ADR-0032): the points on plant time, the limits of the version judging each
// point (a new version starts a new step), zones at 1σ and 2σ on I and X̄, signalling points
// marked, provisional points hollow, episodes as shaded spans (provisional and final apart), and
// on I the retests as separate marks (never charted). Every value is also in the table beside the
// chart; the tooltip is text on the canvas (`richText`, the strict CSP).

const INK = '#334155';
const GRID_LINE = '#e2e8f0';
export const SPC_COLORS = {
  point: '#0369a1',
  provisional: '#64748b',
  signal: '#b91c1c',
  limit: '#b91c1c',
  centre: '#047857',
  zone: '#94a3b8',
  retest: '#6d28d9',
  episodeFinal: 'rgba(185, 28, 28, 0.12)',
  /** Final, its extent still growing (the tester not final through its last point). */
  episodeGrowing: 'rgba(190, 24, 93, 0.12)',
  episodeProvisional: 'rgba(180, 83, 9, 0.12)',
} as const;
const axisText = { color: INK, fontSize: 12 };

/** Half the width given to an episode of one point, so its span is visible (plant ms). */
const ONE_POINT_SPAN_MS = 20_000;

type Limits = LimitVersionDto['charts'][SpcChartName];

const limitsOf = (versions: readonly LimitVersionDto[], chart: SpcChartName): Map<number, Limits> =>
  new Map(versions.map((v) => [v.version, v.charts[chart]]));

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** A limit line per point: the value of the version judging it, null (a gap) where none does. */
function line(
  points: readonly SpcPointDto[],
  limits: ReadonlyMap<number, Limits>,
  pick: (l: Limits) => number,
): [number, number | null][] {
  return points.map((p) => {
    const found = p.version === null ? undefined : limits.get(p.version);
    return [Date.parse(p.at), found ? round(pick(found)) : null];
  });
}

/** The point's mark: a signalling point red and a diamond, a provisional one hollow. */
function pointItem(p: SpcPointDto, precision: SpcPrecision, places: number) {
  const signalling = p.rules.length > 0;
  const colour = signalling
    ? SPC_COLORS.signal
    : p.final
      ? SPC_COLORS.point
      : SPC_COLORS.provisional;
  return {
    value: [Date.parse(p.at), p.value.value],
    symbol: signalling ? 'diamond' : p.final ? 'circle' : 'emptyCircle',
    symbolSize: signalling ? 10 : 5,
    itemStyle: { color: colour, borderColor: colour },
    // Read by the tooltip formatter.
    text: spcValueText(p.value, precision, places),
    partId: p.partId,
    rules: p.rules,
    final: p.final,
  };
}

/** The shaded span of each episode of this chart that is not withdrawn. */
export function episodeAreas(signals: readonly SpcSignalDto[], chart: SpcChartName) {
  return signals
    .filter((s) => s.chart === chart && s.status !== 'withdrawn')
    .map((s) => {
      let from = Date.parse(s.first.at);
      let to = Date.parse(s.last.at);
      if (to - from < 2 * ONE_POINT_SPAN_MS) {
        from -= ONE_POINT_SPAN_MS;
        to += ONE_POINT_SPAN_MS;
      }
      const growing = isGrowing(s);
      return [
        {
          name: `Rule ${String(s.rule)}${s.status === 'provisional' ? ' (provisional)' : growing ? ' (extent not final)' : ''}`,
          xAxis: from,
          itemStyle: {
            color:
              s.status === 'provisional'
                ? SPC_COLORS.episodeProvisional
                : growing
                  ? SPC_COLORS.episodeGrowing
                  : SPC_COLORS.episodeFinal,
          },
        },
        { xAxis: to },
      ];
    });
}

interface TooltipParams {
  readonly seriesName?: string;
  readonly value?: unknown;
  readonly data?: unknown;
}

/**
 * The tooltip as plain text (rich text on the canvas): a mark's value as its item's `text` (the
 * characteristic's precision, #295), else the number without binary noise.
 */
export function spcTooltip(params: TooltipParams): string {
  const value = Array.isArray(params.value) ? (params.value as unknown[]) : [];
  const [t, v] = value as [number | undefined, number | null | undefined];
  const data = params.data as
    { text?: string; partId?: number; rules?: number[]; final?: boolean } | undefined;
  const text =
    data && typeof data === 'object' && typeof data.text === 'string'
      ? data.text
      : v === null || v === undefined
        ? '–'
        : plainText(v);
  const lines = [`${params.seriesName ?? ''}: ${text}`];
  if (typeof t === 'number') lines.push(formatPlantTime(t));
  if (data && typeof data === 'object' && typeof data.partId === 'number') {
    lines.push(`Part ${String(data.partId)}${data.final ? '' : ' (provisional)'}`);
    if (data.rules && data.rules.length > 0) lines.push(`Rules: ${data.rules.join(', ')}`);
  }
  return lines.join('\n');
}

export interface SpcChartInput {
  readonly chart: SpcChartName;
  readonly points: readonly SpcPointDto[];
  readonly limits: readonly LimitVersionDto[];
  readonly signals: readonly SpcSignalDto[];
  /** Shown on I only. */
  readonly retests?: readonly SpcMeasurementDto[];
  readonly unit: string;
  /** The characteristic's resolution: the decimals values are shown with (#295). */
  readonly resolution: number;
}

export function spcChartOption(input: SpcChartInput): EChartsCoreOption {
  const { chart, points, unit } = input;
  const limits = limitsOf(input.limits, chart);
  const precision = spcPrecision(input.resolution);
  const places = pointDecimals(precision, chart);
  const zones = chart === 'I' || chart === 'Xbar';
  const sigma = (l: Limits) => (l.upper.value - l.centre.value) / 3;
  const dashed = (name: string, data: [number, number | null][], colour: string) => ({
    type: 'line',
    name,
    data,
    step: 'end',
    symbol: 'none',
    silent: true,
    lineStyle: { color: colour, type: 'dashed', width: 1 },
    itemStyle: { color: colour },
  });
  const series: Record<string, unknown>[] = [
    {
      type: 'line',
      name: 'Points',
      data: points.map((p) => pointItem(p, precision, places)),
      lineStyle: { color: SPC_COLORS.provisional, width: 1 },
      itemStyle: { color: SPC_COLORS.point },
      markArea: { silent: true, data: episodeAreas(input.signals, chart) },
    },
    {
      type: 'line',
      name: 'UCL',
      data: line(points, limits, (l) => l.upper.value),
      step: 'end',
      symbol: 'none',
      silent: true,
      lineStyle: { color: SPC_COLORS.limit, width: 2 },
      itemStyle: { color: SPC_COLORS.limit },
    },
    {
      type: 'line',
      name: 'Centre',
      data: line(points, limits, (l) => l.centre.value),
      step: 'end',
      symbol: 'none',
      silent: true,
      lineStyle: { color: SPC_COLORS.centre, width: 1.5 },
      itemStyle: { color: SPC_COLORS.centre },
    },
    {
      type: 'line',
      name: 'LCL',
      data: line(points, limits, (l) => l.lower.value),
      step: 'end',
      symbol: 'none',
      silent: true,
      lineStyle: { color: SPC_COLORS.limit, width: 2 },
      itemStyle: { color: SPC_COLORS.limit },
    },
  ];
  if (zones) {
    series.push(
      dashed(
        '+2σ',
        line(points, limits, (l) => l.centre.value + 2 * sigma(l)),
        SPC_COLORS.zone,
      ),
      dashed(
        '+1σ',
        line(points, limits, (l) => l.centre.value + sigma(l)),
        SPC_COLORS.zone,
      ),
      dashed(
        '−1σ',
        line(points, limits, (l) => l.centre.value - sigma(l)),
        SPC_COLORS.zone,
      ),
      dashed(
        '−2σ',
        line(points, limits, (l) => l.centre.value - 2 * sigma(l)),
        SPC_COLORS.zone,
      ),
    );
  }
  if (chart === 'I' && input.retests && input.retests.length > 0) {
    series.push({
      type: 'scatter',
      name: 'Retests',
      symbol: 'triangle',
      symbolSize: 8,
      itemStyle: { color: SPC_COLORS.retest },
      data: input.retests.map((m) => ({
        value: [Date.parse(m.at), m.value],
        text: spcValueText(m, precision, precision.reading),
        partId: m.partId,
        final: m.final,
      })),
    });
  }
  return {
    grid: { left: 56, right: 16, top: 40, bottom: 32 },
    legend: {
      top: 0,
      textStyle: axisText,
      data: series.map((s) => s.name as string).filter((n) => !n.endsWith('σ')),
    },
    tooltip: { trigger: 'item', formatter: spcTooltip },
    xAxis: {
      type: 'time',
      axisLabel: { ...axisText, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: unit,
      nameTextStyle: axisText,
      scale: zones,
      ...(zones ? {} : { min: 0 }),
      axisLabel: axisText,
      splitLine: { lineStyle: { color: GRID_LINE } },
    },
    series,
  };
}
