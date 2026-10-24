import { useEffect, useState } from 'react';
import { colorValue, FONTS, type Theme } from '../components/ui/tokens.ts';

/**
 * The chart theme (UX-1f, #320; design system section 5), shared by ECharts and uPlot.
 *
 * The option builders (`oee-options.ts`, `alarm-options.ts`, `spc-options.ts`) stay plain data:
 * they name colours as token references (`var(--color-chart-1)`), never as values. The views
 * resolve every reference against the stylesheet when they draw (`getComputedStyle` on `<html>`),
 * so the canvases follow the tokens, and repaint when the theme on `<html>` changes (`data-theme`,
 * UX-12; also the light re-theme UX-12 does on `beforeprint`). Before the stylesheet is in, or in
 * jsdom, a token reads its value from `components/ui/tokens.ts`.
 */

/** A colour token as the options name it: `var(--color-<name>)`, resolved when drawn. */
export type TokenRef = `var(--color-${string})`;

export const tokenRef = (name: string): TokenRef => `var(--color-${name})`;

/** The theme's colours by role (section 5): what every chart draws with. */
export const CHART_TOKENS = {
  /** The categorical series palette, in order. */
  series: [
    tokenRef('chart-1'),
    tokenRef('chart-2'),
    tokenRef('chart-3'),
    tokenRef('chart-4'),
    tokenRef('chart-5'),
  ],
  /** "Total" or "other" (neutral-700). */
  other: tokenRef('chart-other'),
  /** Control limits and thresholds. */
  limit: tokenRef('chart-limit'),
  /** Provisional marks, the axis line and ticks (neutral-500). */
  muted: tokenRef('line-strong'),
  /** Text on the chart: axis labels, legend, value labels. */
  text: tokenRef('ink-secondary'),
  ink: tokenRef('ink'),
  /** Split lines on the value axis and the SPC zones (neutral-200). */
  grid: tokenRef('line-subtle'),
  surface: tokenRef('surface'),
  border: tokenRef('line'),
  /** Own availability loss (`LossBadge`'s `warn`) and external (its `neutral`). */
  own: tokenRef('warn-border'),
  external: tokenRef('neutral-border'),
  /** SPC: a signalling point (`alarm`) and a retest (`info`). */
  signal: tokenRef('alarm-border'),
  info: tokenRef('info-border'),
  /** The shadow of the tooltip (elevation 2 is ink at 12 %). */
  shadow: tokenRef('neutral-900'),
} as const;

/** Sizes (section 5): font sizes, the tick length and the chart heights. */
export const CHART_SIZES = {
  label: 12,
  tick: 11,
  tickLength: 4,
  compact: 240,
  default: 320,
} as const;

/** Category labels wrap to two lines at this width, then end in "…" (E-07). */
export const CATEGORY_LABEL_WIDTH = 180;

/** At most this many bars carry a value label (E-05). */
export const MAX_VALUE_LABELS = 12;

/** Reads a token's current value by name (`chart-1`, `ink-secondary`). */
export type TokenReader = (name: string) => string;

const themeOf = (root: HTMLElement): Theme => (root.dataset.theme === 'dark' ? 'dark' : 'light');

/** The tokens as the stylesheet has them now, falling back to the token data. */
export function readTokens(root: HTMLElement = document.documentElement): TokenReader {
  const style = getComputedStyle(root);
  const theme = themeOf(root);
  const cache = new Map<string, string>();
  return (name) => {
    let value = cache.get(name);
    if (value === undefined) {
      value = style.getPropertyValue(`--color-${name}`).trim() || colorValue(name, theme);
      cache.set(name, value);
    }
    return value;
  };
}

/** The sans font stack from the stylesheet (`--font-sans`), else the token data. */
export function readFont(root: HTMLElement = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue('--font-sans').trim() || (FONTS.sans ?? '');
}

const REF = /^var\(--color-([a-z0-9-]+)\)$/;

/**
 * `value` with every token reference replaced by its current colour, deeply through plain objects
 * and arrays (functions, numbers and other strings as they are). The option is not changed.
 */
export function resolveTokens<T>(value: T, read: TokenReader): T {
  if (typeof value === 'string') {
    const match = REF.exec(value);
    return (match?.[1] ? read(match[1]) : value) as T;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => resolveTokens(item, read)) as T;
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveTokens(item, read);
    return out as T;
  }
  return value;
}

/** A `#rrggbb` colour at `alpha` as `rgba(…)`; any other colour as it is. */
export function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match?.[1]) return color;
  const n = Number.parseInt(match[1], 16);
  return `rgba(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)}, ${String(alpha)})`;
}

/** The ECharts theme's name: registered and passed to `init` by `EChartsView`. */
export const ECHARTS_THEME = 'shopfloor';

/**
 * The ECharts theme `shopfloor` (section 5) with the tokens' current values: font, axes (line
 * `neutral-500`, ticks outside 4 px, dashed split lines on the value axis only), legend top-left,
 * the tooltip white with a `line` border and elevation 2, drawn on the canvas; no animation.
 */
export function echartsTheme(read: TokenReader, font: string) {
  const text = read('ink-secondary');
  const axisLine = { show: true, lineStyle: { color: read('line-strong'), width: 1 } };
  const axisTick = {
    show: true,
    inside: false,
    length: CHART_SIZES.tickLength,
    lineStyle: { color: read('line-strong') },
  };
  const axisLabel = { color: text, fontSize: CHART_SIZES.tick, fontFamily: font };
  const nameTextStyle = { color: text, fontSize: CHART_SIZES.label, fontFamily: font };
  const noSplit = { show: false };
  const dashedSplit = { show: true, lineStyle: { color: read('line-subtle'), type: 'dashed' } };
  return {
    color: CHART_TOKENS.series.map((ref) => resolveTokens(ref, read)),
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: font, color: text, fontSize: CHART_SIZES.label },
    legend: {
      left: 0,
      top: 0,
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      textStyle: { color: text, fontSize: CHART_SIZES.label, fontFamily: font },
      pageTextStyle: { color: text },
      pageIconColor: read('ink'),
      pageIconInactiveColor: read('line'),
    },
    tooltip: {
      renderMode: 'richText',
      backgroundColor: read('surface'),
      borderColor: read('line'),
      borderWidth: 1,
      padding: [6, 8],
      shadowBlur: 12,
      shadowOffsetY: 4,
      shadowColor: withAlpha(read('neutral-900'), 0.12),
      textStyle: { color: read('ink'), fontSize: CHART_SIZES.label, fontFamily: font },
    },
    categoryAxis: { axisLine, axisTick, axisLabel, nameTextStyle, splitLine: noSplit },
    timeAxis: {
      axisLine,
      axisTick,
      axisLabel: { ...axisLabel, hideOverlap: true },
      nameTextStyle,
      splitLine: noSplit,
    },
    valueAxis: {
      axisLine,
      axisTick,
      axisLabel: { ...axisLabel, hideOverlap: true },
      nameTextStyle,
      nameLocation: 'end',
      splitLine: dashedSplit,
    },
    markLine: { label: { color: text, fontFamily: font } },
    bar: { label: { color: read('ink'), fontSize: CHART_SIZES.tick, fontFamily: font } },
  };
}

/** The look of a uPlot trend (section 5), with the tokens' current values. */
export function uplotTheme(read: TokenReader, font: string) {
  const text = read('ink-secondary');
  const axis = {
    stroke: text,
    font: `${String(CHART_SIZES.tick)}px ${font}`,
    labelFont: `${String(CHART_SIZES.label)}px ${font}`,
    ticks: { stroke: read('line-strong'), width: 1, size: CHART_SIZES.tickLength },
    border: { show: true, stroke: read('line-strong'), width: 1 },
  };
  return {
    /** The time axis: no split lines (they are on the value axis only). */
    x: { ...axis, grid: { show: false } },
    /** The value axis: dashed split lines. */
    y: { ...axis, grid: { stroke: read('line-subtle'), width: 1, dash: [4, 4] } },
    /** Min and max: the muted line; the average: the first series colour and its band. */
    range: read('line-strong'),
    average: read('chart-1'),
    band: withAlpha(read('chart-1'), 0.15),
  };
}

/**
 * A number that changes whenever the theme on `<html>` changes (`data-theme`, `class`),
 * so a chart redraws with the tokens' new values.
 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setVersion((v) => v + 1);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    return () => {
      observer.disconnect();
    };
  }, []);
  return version;
}
