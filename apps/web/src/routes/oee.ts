import { createRoute } from '@tanstack/react-router';
import { DowntimeCoding } from '../screens/downtime-coding.tsx';
import { OeeDashboard } from '../screens/oee-dashboard.tsx';
import { rootRoute } from './root.tsx';
import { ID, RECORD_ID, SHIFT_KEY, matching } from './search.ts';

// OEE and downtime (#122): the dashboard and the downtime coding.

export interface OeeSearch {
  /** A shift key (`2026-10-12/A`); the current shift when absent. */
  readonly shift?: string | undefined;
  /** The work center or machine the hourly chart, waterfall and Pareto show. */
  readonly focus?: string | undefined;
}

export const oeeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oee',
  validateSearch: (search: Record<string, unknown>): OeeSearch => ({
    shift: matching(search.shift, SHIFT_KEY),
    focus: matching(search.focus, ID),
  }),
  component: OeeDashboard,
});

export interface DowntimeSearch {
  readonly shift?: string | undefined;
  readonly record?: string | undefined;
  readonly uncoded?: true | undefined;
}

export const downtimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/downtime',
  validateSearch: (search: Record<string, unknown>): DowntimeSearch => ({
    shift: matching(search.shift, SHIFT_KEY),
    record: matching(search.record, RECORD_ID),
    uncoded: search.uncoded === true || search.uncoded === 'true' ? true : undefined,
  }),
  component: DowntimeCoding,
});

export const oeeRoutes = [oeeRoute, downtimeRoute] as const;
