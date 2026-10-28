import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EChart } from './echart.tsx';
import { TrendChart, trendReading } from './trend-chart.tsx';

vi.mock('./echarts-view.tsx', () => ({
  EChartsView: ({ height }: { height: number }) => <canvas data-testid="canvas" height={height} />,
}));
vi.mock('./uplot-chart.tsx', () => ({ UplotChart: () => <canvas data-testid="trend" /> }));

const WINDOW = { from: 0, to: 60_000 };

describe('EChart (UX-1f)', () => {
  it('names the canvas image after its main reading, at the default height of 320 px', async () => {
    render(
      <EChart
        testId="c"
        title="OEE per hour"
        description="OEE per hour: 0.00 % in all 2 hours"
        option={{}}
      >
        <table />
      </EChart>,
    );
    const image = screen.getByRole('img', { name: 'OEE per hour: 0.00 % in all 2 hours' });
    expect(image.style.minHeight).toBe('320px');
    expect(await screen.findByTestId('canvas')).toBeTruthy();
    expect(screen.getByTestId('c').querySelector('figcaption')?.textContent).toBe('OEE per hour');
  });

  it('shows the empty state at the chart height when the data is in and empty', () => {
    render(
      <EChart
        testId="c"
        title="Pareto"
        description="d"
        option={null}
        height={160}
        empty="No availability loss in this shift."
      />,
    );
    const empty = screen.getByText('No availability loss in this shift.');
    expect(empty.closest('[data-empty]')?.parentElement?.style.minHeight).toBe('160px');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows nothing in the plot while the data loads (no empty state)', () => {
    render(<EChart testId="c" title="Pareto" description="d" option={null} />);
    expect(screen.getByTestId('c').querySelector('[data-empty]')).toBeNull();
  });
});

describe('TrendChart (UX-1f)', () => {
  it('names the image after the range and the latest average', async () => {
    render(
      <TrendChart
        label="Coolant temperature"
        unit="°C"
        window={WINDOW}
        data={[
          [1, 2],
          [18.25, null],
          [24.9, 22],
          [21.3, 20.5],
        ]}
      />,
    );
    expect(
      screen.getByRole('img', {
        name: 'Coolant temperature trend in °C: 18.25 to 24.9, latest average 20.5',
      }),
    ).toBeTruthy();
    expect(await screen.findByTestId('trend')).toBeTruthy();
  });

  it('is not printed: the metrics table carries the values on paper (UX-12)', async () => {
    render(
      <TrendChart
        label="Coolant temperature"
        unit="°C"
        window={WINDOW}
        data={[[1], [18], [24], [21]]}
      />,
    );
    const figure = (await screen.findByTestId('trend')).closest('figure');
    expect(figure?.className.split(' ')).toContain('print:hidden');
    expect(figure?.dataset.print).toBe('hidden');
  });

  it('counts its samples for a screen reader, one in the singular (#393 re-review)', () => {
    render(
      <TrendChart label="Spindle load" unit="%" window={WINDOW} data={[[1], [18], [24], [21]]} />,
    );
    expect(document.querySelector('figcaption .sr-only')?.textContent).toBe(
      ': chart of the minimum to maximum band and the average, 1 point',
    );
  });

  it('shows an empty state at the compact height without samples', () => {
    render(<TrendChart label="Spindle load" unit="%" window={WINDOW} data={[[], [], [], []]} />);
    const empty = screen.getByText('No samples in this range');
    expect(empty.closest('[data-empty]')?.parentElement?.style.minHeight).toBe('240px');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('says so when no value is finite', () => {
    expect(trendReading('Load', [[1], [null], [null], [null]], '%')).toBe(
      'Load trend in %: no values',
    );
  });
});
