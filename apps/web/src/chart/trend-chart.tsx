import { lazy, Suspense } from 'react';
import type { ChartData } from '../domain/series.ts';

export interface TrendChartProps {
  readonly data: ChartData;
  readonly unit: string;
  readonly window: { readonly from: number; readonly to: number };
}

const UplotChart = lazy(async () => ({
  default: (await import('./uplot-chart.tsx')).UplotChart,
}));

/**
 * A metric's trend: a min/max band with the average line. uPlot is loaded with the first chart,
 * so the overview doesn't download it. The latest values are in the metrics table as text.
 */
export function TrendChart({ label, ...props }: TrendChartProps & { readonly label: string }) {
  const points = props.data[0].length;
  return (
    <figure className="rounded-lg border border-slate-300 bg-white p-3">
      <figcaption className="mb-2 font-medium">
        {label} <span className="text-slate-600">({props.unit})</span>
        <span className="sr-only">
          : chart of the minimum to maximum band and the average, {String(points)} points
        </span>
      </figcaption>
      {points === 0 ? (
        <p className="text-sm text-slate-700">No samples in this range.</p>
      ) : (
        <div role="img" aria-label={`${label} trend in ${props.unit}`}>
          <Suspense fallback={<p className="text-sm">Loading chart…</p>}>
            <UplotChart {...props} />
          </Suspense>
        </div>
      )}
    </figure>
  );
}
