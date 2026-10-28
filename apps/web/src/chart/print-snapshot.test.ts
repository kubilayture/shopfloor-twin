import { use as registerModules } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { afterEach, describe, expect, it } from 'vitest';
import { colorValue } from '../components/ui/tokens.ts';
import { ECHARTS_MODULES } from './echarts-modules.ts';
import { lightChart, lightTokens, themedOption } from './echarts-view.tsx';
import { CHART_TOKENS, readTokens } from './theme.ts';

/**
 * UX-12 (#336): the chart's print image is light whatever theme the screen shows. `EChartsView`
 * draws it on `beforeprint` with `lightChart` (a throwaway chart in the light values) and takes
 * its `getDataURL`; here the same chart is drawn to SVG (jsdom has no canvas) with the page dark.
 */

registerModules([...ECHARTS_MODULES, SVGRenderer]);

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute('data-theme');
});

const option = {
  grid: { left: 40, right: 8, top: 24, bottom: 24 },
  xAxis: { type: 'category', data: ['A', 'B', 'C'] },
  yAxis: { type: 'value' },
  series: [
    {
      type: 'bar',
      data: [3, 5, 2],
      itemStyle: { color: CHART_TOKENS.series[0] },
      markLine: { data: [{ yAxis: 4 }], lineStyle: { color: CHART_TOKENS.limit } },
    },
  ],
};

describe('the print image', () => {
  it('reads the light value of every token, in either theme', () => {
    root.setAttribute('data-theme', 'dark');
    // The page reads the dark values (jsdom: from the token data, by `data-theme`) …
    expect(readTokens()('chart-1')).toBe(colorValue('chart-1', 'dark'));
    // … the print image the light ones.
    for (const name of ['chart-1', 'chart-limit', 'surface', 'ink-secondary', 'line-strong']) {
      expect(lightTokens(name), name).toBe(colorValue(name, 'light'));
    }
  });

  it('is drawn in the light values from a dark page', () => {
    root.setAttribute('data-theme', 'dark');
    const chart = lightChart(option, { width: 400, height: 240 }, { renderer: 'svg', ssr: true });
    try {
      expect(chart.getWidth()).toBe(400);
      expect(chart.getHeight()).toBe(240);
      const svg = chart.renderToSVGString().toLowerCase();
      for (const name of ['chart-1', 'chart-limit', 'ink-secondary', 'line-strong']) {
        expect(svg, `${name} light`).toContain(colorValue(name, 'light'));
      }
      for (const name of ['chart-1', 'chart-limit', 'ink-secondary']) {
        expect(svg, `${name} dark`).not.toContain(colorValue(name, 'dark'));
      }
    } finally {
      chart.dispose();
    }
  });

  it('draws the option as the live chart does (themedOption), with no token left unresolved', () => {
    root.setAttribute('data-theme', 'dark');
    const chart = lightChart(option, { width: 320, height: 200 }, { renderer: 'svg', ssr: true });
    try {
      expect(chart.renderToSVGString()).not.toContain('var(--color-');
      const set = chart.getOption() as { animation?: boolean };
      expect(set.animation).toBe(themedOption(option, lightTokens).animation);
    } finally {
      chart.dispose();
    }
  });
});
