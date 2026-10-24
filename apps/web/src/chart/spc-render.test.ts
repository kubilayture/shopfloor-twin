import { init, use as registerModules, type EChartsType } from 'echarts/core';
import { LabelLayout } from 'echarts/features';
import { SVGRenderer } from 'echarts/renderers';
import { afterEach, describe, expect, it } from 'vitest';
import { ECHARTS_MODULES } from './echarts-modules.ts';
import { limitVersion, point, signal } from '../test/quality-fixtures.ts';
import { themedOption } from './echarts-view.tsx';
import { RULE_LANE, spcChartOption, type SpcChartInput } from './spc-options.ts';
import { echartsTheme, readTokens } from './theme.ts';

// The SPC chart as ECharts draws it (#308, C-03): a real instance (not SSR, which never animates)
// on the SVG renderer in jsdom, given the option as EChartsView gives it (animation on, as without
// `prefers-reduced-motion`, then `notMerge` on every live update). Every point's marker must be
// drawn at once and after each update: the line's intro animation used to draw the markers from
// scale 0, each delayed by its place on the time axis, so a screenshot, a print or a look taken in
// the first ~1.5 s after a load, a window switch or a resize showed the later points as a bare line.
// Most cases keep the stricter set-up (animation on, no theme: the builder's option alone must draw
// every marker); the last one draws the chart as it ships (UX-1f, #320): in the theme `shopfloor`
// with the option `EChartsView` sets (`themedOption`: tokens resolved, no animation, rich text).

// The app's own modules (echarts-view.tsx registers the same list on a canvas).
registerModules([...ECHARTS_MODULES, SVGRenderer]);

let chart: EChartsType | undefined;
afterEach(() => {
  chart?.dispose();
  chart = undefined;
});

/** The option as EChartsView sets it: animation on unless reduced motion, then the chart's own. */
const asSet = (input: SpcChartInput) => ({ animation: true, ...spcChartOption(input) });

function input(chartName: SpcChartInput['chart'], count: number): SpcChartInput {
  const points = Array.from({ length: count }, (_, i) =>
    point(i * 3, 2 + ((i * 7) % 11) / 10, {
      rules: i % 50 === 25 ? [1] : [],
      final: i < count - 5,
    }),
  );
  return {
    chart: chartName,
    points,
    limits: [limitVersion(1)],
    signals: [signal(1, { chart: chartName, status: 'final', extentFinal: true })],
    unit: chartName === 'I' || chartName === 'Xbar' ? 'Pa/min' : 'range',
    resolution: 0.001,
  };
}

interface EChartsModel {
  getSeriesByName(name: string): {
    getData(): {
      count(): number;
      get(dimension: string, i: number): number;
      getItemGraphicEl(
        i: number,
      ): { scaleX: number; scaleY: number; getSymbolType(): string } | undefined;
    };
  }[];
}

interface Rect {
  clone(): Rect;
  applyTransform(m: unknown): void;
  intersect(other: Rect): boolean;
}
interface TextEl {
  ignore: boolean;
  getBoundingRect(): Rect;
  getComputedTransform(): unknown;
}

/** The rule-label lane's labels as drawn: whether each is hidden, and its box on the chart. */
function laneLabels(instance: EChartsType) {
  const model = (instance as unknown as { getModel(): EChartsModel }).getModel();
  const lane = model.getSeriesByName(RULE_LANE)[0];
  if (!lane) throw new Error('no label lane');
  const data = lane.getData();
  const labels: { hidden: boolean; rect: Rect; at: number }[] = [];
  for (let i = 0; i < data.count(); i++) {
    const el = data.getItemGraphicEl(i) as unknown as
      { childAt(i: number): { getTextContent(): TextEl | undefined } } | undefined;
    const text = el?.childAt(0).getTextContent();
    if (!text) continue;
    const rect = text.getBoundingRect().clone();
    rect.applyTransform(text.getComputedTransform());
    labels.push({ hidden: text.ignore, rect, at: data.get('x', i) });
  }
  return labels;
}

/** The Points series' markers: how many there are and how many are drawn at full size. */
function markers(instance: EChartsType) {
  // ECharts' model is internal (`getModel` is private in its types); read the drawn elements.
  const model = (instance as unknown as { getModel(): EChartsModel }).getModel();
  const series = model.getSeriesByName('Points')[0];
  if (!series) throw new Error('no Points series');
  const data = series.getData();
  let shown = 0;
  for (let i = 0; i < data.count(); i++) {
    const el = data.getItemGraphicEl(i);
    if (el?.scaleX === 1 && el.scaleY === 1) shown += 1;
  }
  return { count: data.count(), shown };
}

/** The rendered SVG's elements scaled to nothing (a marker waiting for its intro animation). */
function svgMarkers(instance: EChartsType) {
  const svg = instance.renderToSVGString();
  return { collapsed: (svg.match(/matrix\(0,0,0,0,/g) ?? []).length };
}

describe('SPC chart rendering (#308)', () => {
  it.each(['I', 'MR', 'Xbar', 'R'] as const)(
    'draws every marker of %s at once, over 500 readings, and after a live update',
    (name) => {
      const element = document.createElement('div');
      chart = init(element, undefined, { renderer: 'svg', width: 1200, height: 240 });
      chart.setOption(asSet(input(name, 500)), { notMerge: true });
      expect(markers(chart)).toEqual({ count: 500, shown: 500 });
      expect(svgMarkers(chart).collapsed).toBe(0);
      // A live push: one more reading, a new option, notMerge (echarts-view.tsx).
      chart.setOption(asSet(input(name, 501)), { notMerge: true });
      expect(markers(chart)).toEqual({ count: 501, shown: 501 });
      expect(svgMarkers(chart).collapsed).toBe(0);
    },
  );

  it.each([1440, 1024, 390])(
    'keeps the rule labels apart at %i px: overlapping ones are hidden (C-02)',
    (width) => {
      const element = document.createElement('div');
      chart = init(element, undefined, { renderer: 'svg', width, height: 240 });
      const base = input('I', 500);
      // Twelve episodes a few points apart: their labels would run into each other.
      const signals = Array.from({ length: 12 }, (_, k) => {
        const minutes = 3 * (10 + 4 * k);
        const ref = { epoch: 1, partId: minutes, pass: 1, at: point(minutes, 0).at, seq: minutes };
        return signal(k + 1, {
          rule: (k % 3) + 1,
          status: 'final',
          extentFinal: true,
          first: ref,
          last: ref,
        });
      });
      chart.setOption(asSet({ ...base, signals }), { notMerge: true });
      const shown = laneLabels(chart).filter((l) => !l.hidden);
      expect(laneLabels(chart)).toHaveLength(12);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.length).toBeLessThan(12);
      for (const [i, a] of shown.entries()) {
        for (const b of shown.slice(i + 1)) expect(a.rect.intersect(b.rect)).toBe(false);
      }
      // The newest episode's label is the one kept (all twelve sit in the left half, so each
      // label's place is its episode's start).
      const newest = laneLabels(chart).reduce((a, b) => (b.at > a.at ? b : a));
      expect(newest.at).toBe(Date.parse(signals[11]?.first.at ?? ''));
      expect(newest.hidden).toBe(false);
    },
  );

  it('draws provisional points hollow and signalling points as diamonds', () => {
    const element = document.createElement('div');
    chart = init(element, undefined, { renderer: 'svg', width: 1200, height: 240 });
    const drawn = input('I', 100);
    chart.setOption(asSet(drawn), { notMerge: true });
    const model = (chart as unknown as { getModel(): EChartsModel }).getModel();
    const data = model.getSeriesByName('Points')[0]?.getData();
    const symbols = drawn.points.map((_, i) => data?.getItemGraphicEl(i)?.getSymbolType());
    drawn.points.forEach((p, i) => {
      const expected = p.rules.length > 0 ? 'diamond' : p.final ? 'circle' : 'emptyCircle';
      expect(symbols[i], `point ${String(i)}`).toBe(expected);
    });
    // The fixture has both kinds: points 25 and 75 fire a rule, the last five are provisional.
    expect(symbols.filter((s) => s === 'diamond')).toHaveLength(2);
    expect(symbols.filter((s) => s === 'emptyCircle')).toHaveLength(5);
  });

  it('registers the label layout itself: the bundle drops the one echarts/core installs', () => {
    expect(ECHARTS_MODULES).toContain(LabelLayout);
  });

  it('draws every marker of a range of 2000 readings, also once the chart is resized', () => {
    const element = document.createElement('div');
    chart = init(element, undefined, { renderer: 'svg', width: 1200, height: 240 });
    chart.setOption(asSet(input('I', 2000)), { notMerge: true });
    chart.resize({ width: 900, height: 240 });
    expect(markers(chart)).toEqual({ count: 2000, shown: 2000 });
  });

  it.each([1440, 390])(
    'draws the shipped, themed chart at %i px: every marker, hollow and diamond, labels apart',
    (width) => {
      const read = readTokens();
      chart = init(document.createElement('div'), echartsTheme(read, 'system-ui'), {
        renderer: 'svg',
        width,
        height: 240,
      });
      const drawn = input('I', 500);
      chart.setOption(themedOption(spcChartOption(drawn), read), { notMerge: true });
      expect(markers(chart)).toEqual({ count: 500, shown: 500 });
      const model = (chart as unknown as { getModel(): EChartsModel }).getModel();
      const data = model.getSeriesByName('Points')[0]?.getData();
      const symbols = drawn.points.map((_, i) => data?.getItemGraphicEl(i)?.getSymbolType());
      expect(symbols.filter((s) => s === 'emptyCircle')).toHaveLength(5);
      expect(symbols.filter((s) => s === 'diamond')).toHaveLength(10);
      const shown = laneLabels(chart).filter((l) => !l.hidden);
      for (const [i, a] of shown.entries()) {
        for (const b of shown.slice(i + 1)) expect(a.rect.intersect(b.rect)).toBe(false);
      }
      const svg = chart.renderToSVGString();
      expect(svg).not.toContain('var(');
      expect(svg).toContain('#b91c1c');
      // A live update, as EChartsView applies it, still draws every marker.
      chart.setOption(themedOption(spcChartOption(input('I', 501)), read), { notMerge: true });
      expect(markers(chart)).toEqual({ count: 501, shown: 501 });
    },
  );
});
