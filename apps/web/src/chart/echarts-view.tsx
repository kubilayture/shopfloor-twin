import {
  init,
  use as registerModules,
  type EChartsCoreOption,
  type EChartsType,
} from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { ECHARTS_MODULES } from './echarts-modules.ts';

// The charts' modules (echarts-modules.ts) on a canvas, with a canvas-drawn tooltip.
registerModules([...ECHARTS_MODULES, CanvasRenderer]);

/** The print image's pixels per CSS pixel of the chart on screen. */
const PRINT_PIXEL_RATIO = 3;

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
  const snapshot = useRef<HTMLImageElement>(null);
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
    // Print (#146): the live canvas is resized and redrawn while the page is laid out for paper,
    // so it is hidden there and a still image of the chart as it is now is printed instead (a
    // `data:` URL, which the CSP's img-src allows). Taken on `beforeprint` (Print button, Ctrl+P),
    // after drawing once more without animation, so a chart still animating prints its end state.
    const takeSnapshot = () => {
      const image = snapshot.current;
      if (!image) return;
      instance.setOption({ animation: false });
      // `pixelRatio` multiplies the chart's on-screen CSS width (a 462 px chart gives 924 px),
      // not the paper's: the chart is laid out at the width it has on screen. Three times keeps
      // a chart from a narrow window sharp when the image is stretched to the A4 text width.
      image.src = instance.getDataURL({
        type: 'png',
        pixelRatio: PRINT_PIXEL_RATIO,
        backgroundColor: '#ffffff',
      });
      instance.setOption({ animation: !reducedMotion() });
    };
    window.addEventListener('beforeprint', takeSnapshot);
    return () => {
      window.removeEventListener('beforeprint', takeSnapshot);
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

  return (
    <>
      <div ref={container} className="w-full print:hidden" data-print="hidden" />
      <img ref={snapshot} alt="" data-print-snapshot="" className="hidden w-full print:block" />
    </>
  );
}
