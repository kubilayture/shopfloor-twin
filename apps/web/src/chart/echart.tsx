import type { EChartsCoreOption } from 'echarts/core';
import { lazy, Suspense, type ReactNode } from 'react';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { CHART_SIZES } from './theme.ts';

const EChartsView = lazy(async () => ({
  default: (await import('./echarts-view.tsx')).EChartsView,
}));

/**
 * A chart with its data as a table (design system section 5): ECharts is loaded with the first
 * chart (its own chunk), the canvas is an image to assistive technology whose name states the main
 * reading ("OEE per hour: 0.00 % in all 2 hours"), and the table beside it carries every value as
 * text (also what the tests read; jsdom has no canvas). Without data (`option` null) the figure
 * shows `empty` as an `EmptyState` at the chart's height, when the caller says the data is in and
 * empty (not while it loads or failed).
 */
export function EChart({
  title,
  description,
  option,
  height = CHART_SIZES.default,
  empty,
  testId,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly option: EChartsCoreOption | null;
  readonly height?: number;
  readonly empty?: string | undefined;
  readonly testId: string;
  readonly children?: ReactNode;
}) {
  return (
    <figure data-testid={testId} className="min-w-0 rounded-lg border border-line bg-surface p-3">
      <figcaption className="mb-2 font-semibold text-ink">{title}</figcaption>
      {option ? (
        <div role="img" aria-label={description} style={{ minHeight: height }}>
          <Suspense fallback={<p className="text-sm text-ink-secondary">Loading chart…</p>}>
            <EChartsView option={option} height={height} />
          </Suspense>
        </div>
      ) : empty ? (
        <div className="flex items-center justify-center" style={{ minHeight: height }}>
          <EmptyState title={empty} icon="info" />
        </div>
      ) : null}
      {children}
    </figure>
  );
}
