import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { LabelLayout } from 'echarts/features';

// Tree-shaken (plan "API, push and web"): bar charts with a grid, a legend, a mark line (the alarm
// flood threshold, #145) and a tooltip; since #203 line and scatter charts with mark areas (the
// SPC charts: points, limits, zones, episodes, retests); since #308 the label layout (the SPC
// rule-label lane's `hideOverlap`). `echarts/core` installs it itself, but only as a side effect
// of a module its package.json does not list in `sideEffects`, so the bundle (Vite's dependency
// optimiser and the build) drops it and every `labelLayout` is ignored in the app; Vitest does not
// bundle, so only this list keeps it. The renderer is the user's choice: EChartsView draws on a
// canvas, the rendering tests on SVG.
export const ECHARTS_MODULES = [
  BarChart,
  LineChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  LabelLayout,
];
