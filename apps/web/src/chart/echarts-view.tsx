import { BarChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import {
  init,
  use as registerModules,
  type EChartsCoreOption,
  type EChartsType,
} from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

// Tree-shaken (plan "API, push and web"): bar charts on a canvas with a grid, a legend, a mark
// line (the alarm flood threshold, #145) and a canvas-drawn tooltip only.
registerModules([
  BarChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Apache ECharts on a canvas, created once and given new options as they change. Under the
 * strict CSP (no 'unsafe-inline'): ECharts styles its own elements through the DOM (allowed), and
 * the tooltip is drawn on the canvas (`renderMode: 'richText'`), because the HTML tooltip writes
 * markup with `style` attributes, which the policy refuses.
 */
export function EChartsView({
  option,
  height,
}: {
  readonly option: EChartsCoreOption;
  readonly height: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const instance = init(element, undefined, { renderer: 'canvas', height });
    chart.current = instance;
    const resize = new ResizeObserver(() => {
      instance.resize({ height });
    });
    resize.observe(element);
    return () => {
      resize.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [height]);

  useEffect(() => {
    chart.current?.setOption(
      {
        animation: !reducedMotion(),
        ...option,
        tooltip: { renderMode: 'richText', ...(option.tooltip as object | undefined) },
      },
      { notMerge: true },
    );
  }, [option, height]);

  return <div ref={container} className="w-full" />;
}
