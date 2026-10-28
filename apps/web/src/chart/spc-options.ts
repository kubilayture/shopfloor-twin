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
import { CHART_SIZES, CHART_TOKENS } from './theme.ts';

// One SPC chart (#203, ADR-0032): the points on plant time, the limits of the version judging each
// point (a new version starts a new step), zones at 1σ and 2σ on I and X̄, signalling points
// marked, provisional points hollow, episodes as shaded spans (provisional and final apart), and
// on I the retests as separate marks (never charted). Every value is also in the table beside the
// chart; the tooltip is text on the canvas (`richText`, the strict CSP).

// Colours by role (design system section 5), as token references (theme.ts): points neutral-700
// circles (provisional hollow) joined by a light `line` (neutral-300), signalling points `alarm`
// diamonds, limits `chart-limit` dashed, the centre neutral-600 long-dashed (never mistaken for
// the line joining the points), the zones neutral-200 dotted, retests `info` triangles. Episodes
// are shaded at `EPISODE_OPACITY` of their state's colour: final `alarm`, provisional `warn`, final
// with its extent still growing `info`.
export const SPC_COLORS = {
  point: CHART_TOKENS.other,
  provisional: CHART_TOKENS.other,
  line: CHART_TOKENS.border,
  signal: CHART_TOKENS.signal,
  limit: CHART_TOKENS.limit,
  centre: CHART_TOKENS.text,
  zone: CHART_TOKENS.grid,
  retest: CHART_TOKENS.info,
  episodeFinal: CHART_TOKENS.signal,
  /** Final, its extent still growing (the tester not final through its last point). */
  episodeGrowing: CHART_TOKENS.info,
  episodeProvisional: CHART_TOKENS.own,
} as const;

/** The centre line's dash: long dashes, unlike the limits' short ones and the solid join. */
export const CENTRE_DASH: readonly number[] = [12, 4];

/** How strongly an episode's span is shaded. */
export const EPISODE_OPACITY = 0.12;
const axisText = { color: CHART_TOKENS.text, fontSize: CHART_SIZES.label };

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

/** The episodes of this chart that are not withdrawn. */
const shownEpisodes = (signals: readonly SpcSignalDto[], chart: SpcChartName) =>
  signals.filter((s) => s.chart === chart && s.status !== 'withdrawn');

/** An episode's label: its rule, and whether it or its extent is still provisional. */
function episodeName(s: SpcSignalDto): string {
  const suffix =
    s.status === 'provisional' ? ' (provisional)' : isGrowing(s) ? ' (extent not final)' : '';
  return `Rule ${String(s.rule)}${suffix}`;
}

/**
 * The shaded span of each episode of this chart that is not withdrawn. The span has no label of
 * its own: adjacent spans' labels ran into each other (C-02); the names are in the label lane.
 */
export function episodeAreas(signals: readonly SpcSignalDto[], chart: SpcChartName) {
  return shownEpisodes(signals, chart).map((s) => {
    let from = Date.parse(s.first.at);
    let to = Date.parse(s.last.at);
    if (to - from < 2 * ONE_POINT_SPAN_MS) {
      from -= ONE_POINT_SPAN_MS;
      to += ONE_POINT_SPAN_MS;
    }
    const growing = isGrowing(s);
    return [
      {
        name: episodeName(s),
        xAxis: from,
        itemStyle: {
          color:
            s.status === 'provisional'
              ? SPC_COLORS.episodeProvisional
              : growing
                ? SPC_COLORS.episodeGrowing
                : SPC_COLORS.episodeFinal,
          opacity: EPISODE_OPACITY,
        },
      },
      { xAxis: to },
    ];
  });
}

/** The plot's top edge (px): room for the legend, the unit's row and the label lane above it. */
export const SPC_GRID_TOP = 60;
/** The unit's distance above the plot (px): over the label lane's 4 px gap and 12 px text. */
export const SPC_UNIT_GAP = 24;
/** The label lane's distance above the plot (px). */
export const SPC_LANE_GAP = 4;

/** The label lane's series: on its own hidden axis (0 to 1), its marks on the top edge (1). */
export const RULE_LANE = 'Rule labels';

/**
 * The label lane (#308, C-02): one label per episode on the plot's top edge, above the span,
 * starting at the span in the left half of the time range and ending at it in the right half (so
 * none runs off the chart). Where two would overlap, ECharts hides one (`hideOverlap`; the
 * newest first in the data, so it is the one kept); the span stays shaded and the episodes table
 * lists every episode.
 */
export function ruleLane(
  signals: readonly SpcSignalDto[],
  chart: SpcChartName,
  range: readonly [number, number] | undefined,
) {
  const middle = range ? (range[0] + range[1]) / 2 : Number.POSITIVE_INFINITY;
  const data = shownEpisodes(signals, chart)
    .map((s) => ({ s, from: Date.parse(s.first.at), to: Date.parse(s.last.at) }))
    .sort((a, b) => b.from - a.from || b.s.id - a.s.id)
    .map(({ s, from, to }) => {
      const right = (from + to) / 2 > middle;
      return {
        name: episodeName(s),
        value: [right ? to : from, 1],
        label: { align: right ? 'right' : 'left' },
      };
    });
  return {
    type: 'scatter',
    name: RULE_LANE,
    yAxisIndex: 1,
    silent: true,
    symbol: 'rect',
    symbolSize: 1,
    itemStyle: { color: 'transparent' },
    tooltip: { show: false },
    label: {
      show: true,
      position: 'top',
      distance: SPC_LANE_GAP,
      formatter: '{b}',
      ...axisText,
    },
    // "Newest kept" relies on every lane marker having the same size: hideOverlap ranks labels by
    // their marker's area, and equal areas keep the data order (newest first).
    labelLayout: { hideOverlap: true },
    data,
  };
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
  const dotted = (name: string, data: [number, number | null][], colour: string) => ({
    type: 'line',
    name,
    data,
    step: 'end',
    symbol: 'none',
    silent: true,
    lineStyle: { color: colour, type: 'dotted', width: 1 },
    itemStyle: { color: colour },
  });
  const series: Record<string, unknown>[] = [
    {
      type: 'line',
      name: 'Points',
      data: points.map((p) => pointItem(p, precision, places)),
      lineStyle: { color: SPC_COLORS.line, width: 1 },
      itemStyle: { color: SPC_COLORS.point },
      markArea: { silent: true, label: { show: false }, data: episodeAreas(input.signals, chart) },
    },
    {
      type: 'line',
      name: 'UCL',
      data: line(points, limits, (l) => l.upper.value),
      step: 'end',
      symbol: 'none',
      silent: true,
      lineStyle: { color: SPC_COLORS.limit, type: 'dashed', width: 1.5 },
      itemStyle: { color: SPC_COLORS.limit },
    },
    {
      type: 'line',
      name: 'Centre',
      data: line(points, limits, (l) => l.centre.value),
      step: 'end',
      symbol: 'none',
      silent: true,
      lineStyle: { color: SPC_COLORS.centre, type: [...CENTRE_DASH], width: 1.5 },
      itemStyle: { color: SPC_COLORS.centre },
    },
    {
      type: 'line',
      name: 'LCL',
      data: line(points, limits, (l) => l.lower.value),
      step: 'end',
      symbol: 'none',
      silent: true,
      lineStyle: { color: SPC_COLORS.limit, type: 'dashed', width: 1.5 },
      itemStyle: { color: SPC_COLORS.limit },
    },
  ];
  if (zones) {
    series.push(
      dotted(
        '+2σ',
        line(points, limits, (l) => l.centre.value + 2 * sigma(l)),
        SPC_COLORS.zone,
      ),
      dotted(
        '+1σ',
        line(points, limits, (l) => l.centre.value + sigma(l)),
        SPC_COLORS.zone,
      ),
      dotted(
        '−1σ',
        line(points, limits, (l) => l.centre.value - sigma(l)),
        SPC_COLORS.zone,
      ),
      dotted(
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
  // The points' time range (a loop: "Every reading" may be more points than a spread allows).
  let range: [number, number] | undefined;
  for (const p of points) {
    const t = Date.parse(p.at);
    range = range ? [Math.min(range[0], t), Math.max(range[1], t)] : [t, t];
  }
  series.push(ruleLane(input.signals, chart, range));
  return {
    // No intro animation (#308, C-03; design system: no chart animation). ECharts drew the points'
    // markers from scale 0, each delayed by its place on the time axis, for about 1.5 s after
    // every load, window switch or new view; a look, print or screenshot then saw the later
    // points (signals included) as a bare line. EChartsView lets the option's own value win.
    animation: false,
    // Top: the legend (0–16), the unit (24–36), then the label lane over the plot’s edge (44–56).
    grid: { left: 56, right: 16, top: SPC_GRID_TOP, bottom: 32 },
    // One row (scrolling when narrow): a wrapped second row ran into the label lane and the unit.
    // Line samples 16 px wide (section 5).
    legend: {
      type: 'scroll',
      top: 0,
      left: 0,
      itemWidth: 16,
      data: series.map((s) => s.name as string).filter((n) => !n.endsWith('σ') && n !== RULE_LANE),
    },
    tooltip: { trigger: 'item', formatter: spcTooltip },
    xAxis: {
      type: 'time',
      axisLabel: { hideOverlap: true },
    },
    yAxis: [
      {
        type: 'value',
        name: unit,
        // A row of its own above the label lane: beside it, an episode starting at the first point
        // read as one word with the unit ("Pa/minRule 1", #393 review F5); under the legend.
        nameGap: SPC_UNIT_GAP,
        nameTextStyle: { ...axisText, align: 'right' },
        scale: zones,
        ...(zones ? {} : { min: 0 }),
      },
      // The label lane's axis: hidden, 0 to 1, so its marks sit on the plot's top edge.
      { type: 'value', show: false, min: 0, max: 1 },
    ],
    series,
  };
}
