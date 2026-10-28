import {
  init,
  use as registerModules,
  type EChartsCoreOption,
  type EChartsType,
} from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ECHARTS_MODULES } from './echarts-modules.ts';
import {
  LIVE_UPDATE,
  MEDIA_UPDATE,
  applyOption,
  categoryCount,
  optionShape,
} from './echarts-view.tsx';
import { paretoOption } from './oee-options.ts';

// Live charts keep their hover tooltip across live updates (#356): a real ECharts instance on the
// SVG renderer in jsdom (as spc-render.test.ts), given each option as EChartsView gives it.
registerModules([...ECHARTS_MODULES, SVGRenderer]);

let chart: EChartsType | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  vi.useRealTimers();
  chart?.dispose();
  chart = undefined;
  host?.remove();
  host = undefined;
});

function draw(): EChartsType {
  // ECharts' own timers (the tooltip's `_keepShow`, its `hideDelay`) run when `settle` says (#386).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  host = document.createElement('div');
  document.body.append(host);
  chart = init(host, null, { renderer: 'svg', width: 400, height: 300 });
  return chart;
}

/** The OEE page's hourly chart in small: an axis tooltip drawn on the chart (`richText`). */
function hourly(
  current: number,
  { second = true, mark = false, hours = 3, formatter }: HourlyCase = {},
): EChartsCoreOption {
  const earlier = [1.5, 2.5].slice(0, hours - 1);
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      renderMode: 'richText',
      ...(formatter === undefined ? {} : { formatter }),
    },
    xAxis: { type: 'category', data: ['06:00', '07:00', '08:00'].slice(0, hours) },
    yAxis: { type: 'value', max: 10 },
    series: [
      {
        type: 'bar',
        name: 'Good',
        data: [...earlier, current],
        ...(mark ? { markLine: { data: [{ yAxis: 6.5 }] } } : {}),
      },
      ...(second ? [{ type: 'bar', name: 'Scrap', data: earlier.map(() => 0.5).concat(0.5) }] : []),
    ],
  };
}

interface HourlyCase {
  readonly second?: boolean;
  readonly mark?: boolean;
  readonly hours?: number;
  readonly formatter?: string;
}

/** What the chart draws, tooltip included, as text. */
const drawn = () => host?.textContent ?? '';

/**
 * Runs ECharts' pending timers (or those due within `ms`), then draws what they changed. The tooltip comes back a task after
 * an update (`_keepShow`, a 0 ms timeout) and is hidden after `hideDelay`; zrender draws it on its
 * next animation frame, which jsdom runs every 16.7 ms on a real interval. A fixed sleep raced that
 * frame and lost under load (#386): ECharts' timers are fake here and the frame is drawn now.
 */
function settle(instance: EChartsType, ms?: number) {
  if (ms === undefined) vi.runAllTimers();
  else vi.advanceTimersByTime(ms);
  instance.getZr().flush();
}

function hoverCurrentHour(instance: EChartsType) {
  // The pointer over the current hour's bar (the third category of three).
  instance.dispatchAction({ type: 'showTip', x: 330, y: 150 });
  settle(instance);
  expect(drawn()).toContain('Good');
  expect(drawn()).toContain('3.25');
}

describe('EChartsView updates (#356)', () => {
  it("says an option's shape: its replaced components counted, its merged ones' keys", () => {
    expect(optionShape(hourly(1))).toBe(
      'animation|series:2|tooltip{renderMode,trigger}|xAxis|yAxis',
    );
    expect(optionShape(hourly(1, { formatter: 'X{c}' }))).toBe(
      'animation|series:2|tooltip{formatter,renderMode,trigger}|xAxis|yAxis',
    );
    expect(
      optionShape({
        series: [],
        xAxis: [{}, {}],
        grid: [{ left: 1 }, { top: 2 }],
        legend: { data: ['a'], textStyle: { color: 'x' } },
      }),
    ).toBe('grid[{left},{top}]|legend{data[],textStyle{color}}|series:0|xAxis:2');
    // Values and the items of a list do not change the shape.
    expect(optionShape({ legend: { data: ['a', 'b'] }, title: { text: 'B' } })).toBe(
      optionShape({ legend: { data: [] }, title: { text: 'A' } }),
    );
  });

  it('counts the categories of the category axes', () => {
    expect(categoryCount(hourly(1))).toBe(3);
    expect(categoryCount(hourly(1, { hours: 1 }))).toBe(1);
    expect(categoryCount({ xAxis: [{ data: ['a', 'b'] }, { data: ['c'] }], yAxis: {} })).toBe(3);
    expect(categoryCount({ xAxis: { type: 'value' }, yAxis: { data: ['a'] } })).toBe(1);
    expect(categoryCount({ series: [] })).toBe(0);
  });

  it('keeps the hover tooltip across a live update, with the new value', () => {
    const instance = draw();
    const applied = applyOption(instance, hourly(3.25), undefined);
    hoverCurrentHour(instance);
    applyOption(instance, hourly(4.75), applied);
    settle(instance);
    expect(drawn()).toContain('4.75');
    expect(drawn()).not.toContain('3.25');
    expect(drawn()).toContain('Good');
  });

  it('merges an update of the same shape, and draws a new shape from scratch', () => {
    const setOption = vi.fn();
    const dispatchAction = vi.fn();
    const chart = { setOption, dispatchAction };
    const applied = applyOption(chart, hourly(1), undefined);
    expect(applied).toEqual({ shape: optionShape(hourly(1)), categories: 3 });
    expect(setOption).toHaveBeenLastCalledWith(hourly(1), { notMerge: true });
    expect(applyOption(chart, hourly(2), applied)).toEqual(applied);
    expect(setOption).toHaveBeenLastCalledWith(hourly(2), LIVE_UPDATE);
    expect(LIVE_UPDATE).toEqual({ notMerge: false, replaceMerge: ['series', 'xAxis', 'yAxis'] });
    applyOption(chart, hourly(2, { second: false }), applied);
    expect(setOption).toHaveBeenLastCalledWith(hourly(2, { second: false }), { notMerge: true });
    // More categories (the next hour): merged, nothing hidden.
    const one = applyOption(chart, hourly(2, { hours: 1 }), undefined);
    applyOption(chart, hourly(2, { hours: 2 }), one);
    expect(setOption).toHaveBeenLastCalledWith(hourly(2, { hours: 2 }), LIVE_UPDATE);
    expect(dispatchAction).not.toHaveBeenCalled();
    // Fewer (a new shift): the tooltip is hidden before the merge.
    applyOption(chart, hourly(2, { hours: 1 }), applied);
    expect(dispatchAction).toHaveBeenCalledExactlyOnceWith({ type: 'hideTip' });
    expect(setOption).toHaveBeenLastCalledWith(hourly(2, { hours: 1 }), LIVE_UPDATE);
    expect(dispatchAction.mock.invocationCallOrder[0]).toBeLessThan(
      setOption.mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  it('keeps a narrow Pareto drawn across live updates (#339)', () => {
    // At 480 px or less the Pareto's `media` option applies; ECharts drops replace-merged series
    // and axes then, so the chart went blank on its first push. Rendered, not just the call.
    const pareto = (minutes: number) =>
      paretoOption({
        reasons: [
          {
            code: 'STARVED',
            name: 'Starved by the upstream station',
            loss: 'external',
            ms: minutes * 60_000,
          },
          { code: 'TOOL', name: 'Tool change', loss: 'own', ms: 6 * 60_000 },
        ],
      } as never).option;
    for (const width of [300, 800]) {
      host = document.createElement('div');
      document.body.append(host);
      const instance = init(host, null, { renderer: 'svg', width, height: 200 });
      let applied = applyOption(instance, pareto(117), undefined);
      applied = applyOption(instance, pareto(124), applied);
      applyOption(instance, pareto(131), applied);
      const svg = host.innerHTML;
      expect(svg, `${String(width)} px`).toContain('Tool change');
      expect(svg, `${String(width)} px`).toContain('External');
      instance.dispose();
      host.remove();
    }
    host = undefined;
    const setOption = vi.fn();
    const chart = { setOption, dispatchAction: vi.fn() };
    const first = applyOption(chart, pareto(1), undefined);
    applyOption(chart, pareto(2), first);
    expect(setOption.mock.lastCall?.[1]).toBe(MEDIA_UPDATE);
    expect(MEDIA_UPDATE).toEqual({ notMerge: false });
  });

  it('hides the tooltip when the categories shrink, rather than show it with dashes', () => {
    const instance = draw();
    const applied = applyOption(instance, hourly(3.25), undefined);
    hoverCurrentHour(instance);
    applyOption(instance, hourly(4.75, { hours: 1 }), applied);
    // ECharts hides a tooltip after its `hideDelay` (100 ms): gone within 200 ms.
    settle(instance, 200);
    expect(drawn()).not.toContain('Good');
    expect(drawn()).not.toContain('Scrap');
    expect((instance.getOption() as { xAxis: { data: string[] }[] }).xAxis[0]?.data).toEqual([
      '06:00',
    ]);
  });

  it('clears a series left out, and its tooltip, without failing', () => {
    const instance = draw();
    const applied = applyOption(instance, hourly(3.25), undefined);
    hoverCurrentHour(instance);
    expect(drawn()).toContain('Scrap');
    applyOption(instance, hourly(4.75, { second: false }), applied);
    settle(instance);
    const option = instance.getOption() as { series: { name: string }[] };
    expect(option.series.map((series) => series.name)).toEqual(['Good']);
    expect(drawn()).not.toContain('Scrap');
  });

  it('clears what a merged update leaves out of a series (a mark line)', () => {
    const instance = draw();
    const applied = applyOption(instance, hourly(1, { mark: true }), undefined);
    expect(drawn()).toContain('6.5');
    applyOption(instance, hourly(2), applied);
    const option = instance.getOption() as { series: { markLine?: unknown }[] };
    expect(option.series[0]?.markLine).toBeUndefined();
    expect(drawn()).not.toContain('6.5');
  });

  it('clears a key a push leaves out of a merged component (a tooltip formatter)', () => {
    const instance = draw();
    const applied = applyOption(instance, hourly(1, { formatter: 'X{c}' }), undefined);
    applyOption(instance, hourly(2), applied);
    const option = instance.getOption() as { tooltip: { formatter?: unknown }[] };
    expect(option.tooltip[0]?.formatter).toBeUndefined();
  });

  it('keeps a legend toggle across a live update', () => {
    const instance = draw();
    const withLegend = (value: number) => ({ ...hourly(value), legend: { show: true } });
    const applied = applyOption(instance, withLegend(1), undefined);
    instance.dispatchAction({ type: 'legendUnSelect', name: 'Scrap' });
    applyOption(instance, withLegend(2), applied);
    const option = instance.getOption() as { legend: { selected?: Record<string, boolean> }[] };
    expect(option.legend[0]?.selected?.Scrap).toBe(false);
  });
});
