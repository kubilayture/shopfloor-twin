import { lazy, Suspense } from 'react';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { plainText } from '../domain/numbers.ts';
import type { ChartData } from '../domain/series.ts';
import { CHART_SIZES } from './theme.ts';

export interface TrendChartProps {
  readonly data: ChartData;
  readonly unit: string;
  readonly window: { readonly from: number; readonly to: number };
}

const UplotChart = lazy(async () => ({
  default: (await import('./uplot-chart.tsx')).UplotChart,
}));

const finite = (values: readonly (number | null)[]): number[] =>
  values.filter((value): value is number => value !== null && Number.isFinite(value));

/**
 * The trend's main reading, for its `aria-label` (design system section 5): the range of the
 * band and the latest average, "Coolant temperature in °C: 18.2 to 24.9, latest average 21.3".
 */
export function trendReading(label: string, data: ChartData, unit: string): string {
  const lows = finite(data[1]);
  const highs = finite(data[2]);
  const averages = finite(data[3]);
  const latest = averages.at(-1);
  if (lows.length === 0 || highs.length === 0 || latest === undefined) {
    return `${label} trend in ${unit}: no values`;
  }
  return `${label} trend in ${unit}: ${plainText(Math.min(...lows))} to ${plainText(Math.max(...highs))}, latest average ${plainText(latest)}`;
}

/**
 * A metric's trend: a min/max band with the average line. uPlot is loaded with the first chart,
 * so the overview doesn't download it. The latest values are in the metrics table as text.
 */
export function TrendChart({ label, ...props }: TrendChartProps & { readonly label: string }) {
  const points = props.data[0].length;
  return (
    <figure className="min-w-0 rounded-lg border border-line bg-surface p-3">
      <figcaption className="mb-2 font-semibold text-ink">
        {label} <span className="font-normal text-ink-secondary">({props.unit})</span>
        <span className="sr-only">
          : chart of the minimum to maximum band and the average, {String(points)} points
        </span>
      </figcaption>
      {points === 0 ? (
        <div
          className="flex items-center justify-center"
          style={{ minHeight: CHART_SIZES.compact }}
        >
          <EmptyState title="No samples in this range." />
        </div>
      ) : (
        <div
          role="img"
          aria-label={trendReading(label, props.data, props.unit)}
          style={{ minHeight: CHART_SIZES.compact }}
        >
          <Suspense fallback={<p className="text-sm text-ink-secondary">Loading chart…</p>}>
            <UplotChart {...props} />
          </Suspense>
        </div>
      )}
    </figure>
  );
}
