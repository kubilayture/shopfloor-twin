import type { EChartsCoreOption } from 'echarts/core';
import { lazy, Suspense, type ReactNode } from 'react';

const EChartsView = lazy(async () => ({
  default: (await import('./echarts-view.tsx')).EChartsView,
}));

/**
 * A chart with its data as a table: ECharts is loaded with the first chart (its own chunk), the
 * canvas is an image to assistive technology, and the table beside it carries every value as
 * text (also what the tests read; jsdom has no canvas).
 */
export function EChart({
  title,
  description,
  option,
  height = 260,
  testId,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly option: EChartsCoreOption | null;
  readonly height?: number;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <figure
      data-testid={testId}
      className="min-w-0 rounded-lg border border-slate-300 bg-white p-3"
    >
      <figcaption className="mb-2 font-medium">{title}</figcaption>
      {option ? (
        <div role="img" aria-label={description} style={{ minHeight: height }}>
          <Suspense fallback={<p className="text-sm">Loading chart…</p>}>
            <EChartsView option={option} height={height} />
          </Suspense>
        </div>
      ) : null}
      {children}
    </figure>
  );
}
