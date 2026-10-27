import {
  init,
  registerTheme,
  use as registerModules,
  type EChartsCoreOption,
  type EChartsType,
  type SetOptionOpts,
} from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { ECHARTS_MODULES } from './echarts-modules.ts';
import {
  ECHARTS_THEME,
  echartsTheme,
  readFont,
  readTokens,
  resolveTokens,
  useThemeVersion,
  type TokenReader,
} from './theme.ts';

// The charts' modules (echarts-modules.ts) on a canvas, with a canvas-drawn tooltip.
registerModules([...ECHARTS_MODULES, CanvasRenderer]);

/** The print image's pixels per CSS pixel of the chart on screen. */
const PRINT_PIXEL_RATIO = 3;

/**
 * The option as the chart draws it (design system section 5): the builder's option with its token
 * references resolved, no animation (no intro, no update transitions: #308, C-03, and reduced
 * motion is then nothing to honour), and the tooltip drawn on the canvas (`renderMode:
 * 'richText'`): ECharts' HTML tooltip writes markup with `style` attributes, which the strict CSP
 * (`style-src 'self'`) refuses.
 */
export function themedOption(option: EChartsCoreOption, read: TokenReader): EChartsCoreOption {
  const tooltip = option.tooltip as Record<string, unknown> | undefined;
  return resolveTokens(
    {
      ...option,
      animation: false,
      tooltip: { ...tooltip, renderMode: 'richText' },
    },
    read,
  );
}

/**
 * An option's shape (#356): each component it has and how many, `series:2|xAxis:1|yAxis:1|...`.
 * Two options of the same shape differ only in their values.
 */
export function optionShape(option: EChartsCoreOption): string {
  return Object.keys(option)
    .sort()
    .map((key) => {
      const value = option[key];
      return Array.isArray(value) ? `${key}:${String(value.length)}` : key;
    })
    .join('|');
}

/**
 * A live update (#356): merged into the chart, with the series and axes replaced (so a series or
 * a mark left out goes), keeps the hover tooltip and highlight, which a redraw from scratch
 * (`notMerge`) drops on every push, so the OEE page's tooltip never stayed. A new shape (a series
 * or component added or gone) is drawn from scratch: ECharts would show the kept tooltip again
 * for a series or axis that is no longer there, and fail.
 */
export const LIVE_UPDATE: SetOptionOpts = {
  notMerge: false,
  replaceMerge: ['series', 'xAxis', 'yAxis'],
};

/** Gives the chart its option (#356); returns the option's shape for the next update. */
export function applyOption(
  instance: Pick<EChartsType, 'setOption'>,
  option: EChartsCoreOption,
  previousShape: string | undefined,
): string {
  const shape = optionShape(option);
  if (shape === previousShape) instance.setOption(option, LIVE_UPDATE);
  else instance.setOption(option, { notMerge: true });
  return shape;
}

/**
 * Apache ECharts on a canvas, created once and given new options as they change, in the theme
 * `shopfloor` (theme.ts) with the tokens' current values; a change of the theme on `<html>`
 * registers the theme again and redraws. Under the strict CSP ECharts styles its own elements
 * through the DOM (allowed) and draws the tooltip on the canvas.
 */
export function EChartsView({
  option,
  height,
}: {
  readonly option: EChartsCoreOption;
  readonly height: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const snapshot = useRef<HTMLImageElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const read = useRef<TokenReader | null>(null);
  /** The shape of the option the chart has, so a live update is merged (#356). */
  const shape = useRef<string | undefined>(undefined);
  const themeVersion = useThemeVersion();

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    read.current = readTokens();
    registerTheme(ECHARTS_THEME, echartsTheme(read.current, readFont()));
    const instance = init(element, ECHARTS_THEME, { renderer: 'canvas', height });
    chart.current = instance;
    const resize = new ResizeObserver(() => {
      instance.resize({ height });
    });
    resize.observe(element);
    // Print (#146): the live canvas is resized and redrawn while the page is laid out for paper,
    // so it is hidden there and a still image of the chart as it is now is printed instead (a
    // `data:` URL, which the CSP's img-src allows). Taken on `beforeprint` (Print button, Ctrl+P).
    const takeSnapshot = () => {
      const image = snapshot.current;
      if (!image) return;
      // `pixelRatio` multiplies the chart's on-screen CSS width (a 462 px chart gives 924 px),
      // not the paper's: the chart is laid out at the width it has on screen. Three times keeps
      // a chart from a narrow window sharp when the image is stretched to the A4 text width.
      image.src = instance.getDataURL({
        type: 'png',
        pixelRatio: PRINT_PIXEL_RATIO,
        backgroundColor: readTokens()('surface'),
      });
    };
    window.addEventListener('beforeprint', takeSnapshot);
    return () => {
      window.removeEventListener('beforeprint', takeSnapshot);
      resize.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [height]);

  // The theme on `<html>` changed (UX-12): the tokens' new values into the theme and the option.
  useEffect(() => {
    if (themeVersion === 0 || !chart.current) return;
    read.current = readTokens();
    registerTheme(ECHARTS_THEME, echartsTheme(read.current, readFont()));
    chart.current.setTheme(ECHARTS_THEME);
  }, [themeVersion]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    shape.current = applyOption(
      instance,
      themedOption(option, read.current ?? readTokens()),
      shape.current,
    );
  }, [option, height, themeVersion]);

  return (
    <>
      <div ref={container} className="w-full print:hidden" data-print="hidden" />
      <img ref={snapshot} alt="" data-print-snapshot="" className="hidden w-full print:block" />
    </>
  );
}
