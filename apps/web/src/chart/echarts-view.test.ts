import {
  init,
  use as registerModules,
  type EChartsCoreOption,
  type EChartsType,
} from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ECHARTS_MODULES } from './echarts-modules.ts';
import { LIVE_UPDATE, applyOption, optionShape } from './echarts-view.tsx';

// Live charts keep their hover tooltip across live updates (#356): a real ECharts instance on the
// SVG renderer in jsdom (as spc-render.test.ts), given each option as EChartsView gives it.
registerModules([...ECHARTS_MODULES, SVGRenderer]);

let chart: EChartsType | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  chart?.dispose();
  chart = undefined;
  host?.remove();
  host = undefined;
});

function draw(): EChartsType {
  host = document.createElement('div');
  document.body.append(host);
  chart = init(host, null, { renderer: 'svg', width: 400, height: 300 });
  return chart;
}

/** The OEE page's hourly chart in small: an axis tooltip drawn on the chart (`richText`). */
function hourly(current: number, { second = true, mark = false } = {}): EChartsCoreOption {
  return {
    animation: false,
    tooltip: { trigger: 'axis', renderMode: 'richText' },
    xAxis: { type: 'category', data: ['06:00', '07:00', '08:00'] },
    yAxis: { type: 'value', max: 10 },
    series: [
      {
        type: 'bar',
        name: 'Good',
        data: [1.5, 2.5, current],
        ...(mark ? { markLine: { data: [{ yAxis: 6.5 }] } } : {}),
      },
      ...(second ? [{ type: 'bar', name: 'Scrap', data: [0.5, 0.5, 0.5] }] : []),
    ],
  };
}

/** What the chart draws, tooltip included, as text. */
const drawn = () => host?.textContent ?? '';

/** The tooltip comes back a task after an update (ECharts' `_keepShow`). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function hoverCurrentHour(instance: EChartsType) {
  // The pointer over the current hour's bar (the third category of three).
  instance.dispatchAction({ type: 'showTip', x: 330, y: 150 });
  await settle();
  expect(drawn()).toContain('Good');
  expect(drawn()).toContain('3.25');
}

describe('EChartsView updates (#356)', () => {
  it("says an option's shape: its components and how many of each", () => {
    expect(optionShape(hourly(1))).toBe('animation|series:2|tooltip|xAxis|yAxis');
    expect(optionShape({ series: [], xAxis: [{}, {}] })).toBe('series:0|xAxis:2');
  });

  it('keeps the hover tooltip across a live update, with the new value', async () => {
    const instance = draw();
    const shape = applyOption(instance, hourly(3.25), undefined);
    await hoverCurrentHour(instance);
    applyOption(instance, hourly(4.75), shape);
    await settle();
    expect(drawn()).toContain('4.75');
    expect(drawn()).not.toContain('3.25');
    expect(drawn()).toContain('Good');
  });

  it('merges an update of the same shape, and draws a new shape from scratch', () => {
    const setOption = vi.fn();
    const shape = applyOption({ setOption }, hourly(1), undefined);
    expect(setOption).toHaveBeenLastCalledWith(hourly(1), { notMerge: true });
    expect(applyOption({ setOption }, hourly(2), shape)).toBe(shape);
    expect(setOption).toHaveBeenLastCalledWith(hourly(2), LIVE_UPDATE);
    expect(LIVE_UPDATE).toEqual({ notMerge: false, replaceMerge: ['series', 'xAxis', 'yAxis'] });
    applyOption({ setOption }, hourly(2, { second: false }), shape);
    expect(setOption).toHaveBeenLastCalledWith(hourly(2, { second: false }), { notMerge: true });
  });

  it('clears a series left out, and its tooltip, without failing', async () => {
    const instance = draw();
    const shape = applyOption(instance, hourly(3.25), undefined);
    await hoverCurrentHour(instance);
    expect(drawn()).toContain('Scrap');
    applyOption(instance, hourly(4.75, { second: false }), shape);
    await settle();
    const option = instance.getOption() as { series: { name: string }[] };
    expect(option.series.map((series) => series.name)).toEqual(['Good']);
    expect(drawn()).not.toContain('Scrap');
  });

  it('clears what a merged update leaves out of a series (a mark line)', () => {
    const instance = draw();
    const shape = applyOption(instance, hourly(1, { mark: true }), undefined);
    expect(drawn()).toContain('6.5');
    applyOption(instance, hourly(2), shape);
    const option = instance.getOption() as { series: { markLine?: unknown }[] };
    expect(option.series[0]?.markLine).toBeUndefined();
    expect(drawn()).not.toContain('6.5');
  });
});
