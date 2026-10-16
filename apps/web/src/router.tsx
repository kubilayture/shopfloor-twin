import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { isRangeKey, type RangeKey } from './domain/time.ts';
import { DowntimeCoding } from './screens/downtime-coding.tsx';
import { MachineDetail } from './screens/machine-detail.tsx';
import { OeeDashboard } from './screens/oee-dashboard.tsx';
import { Overview } from './screens/overview.tsx';
import { NotFound, RootLayout } from './screens/root-layout.tsx';

// Code-based routes (ADR-0020): four screens don't need a generated route tree.
const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: NotFound });

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Overview,
});

export interface DetailSearch {
  readonly range: RangeKey;
}

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/equipment/$id',
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    range: isRangeKey(search.range) ? search.range : '8h',
  }),
  component: MachineDetail,
});

const SHIFT_KEY = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]{1,16}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}~\d{1,15}~\d{1,15}$/;

const matching = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

export interface OeeSearch {
  /** A shift key (`2026-10-12/A`); the current shift when absent. */
  readonly shift?: string | undefined;
  /** The work center or machine the hourly chart, waterfall and Pareto show. */
  readonly focus?: string | undefined;
}

const oeeRoute = createRoute({
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

const downtimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/downtime',
  validateSearch: (search: Record<string, unknown>): DowntimeSearch => ({
    shift: matching(search.shift, SHIFT_KEY),
    record: matching(search.record, RECORD_ID),
    uncoded: search.uncoded === true || search.uncoded === 'true' ? true : undefined,
  }),
  component: DowntimeCoding,
});

const routeTree = rootRoute.addChildren([overviewRoute, detailRoute, oeeRoute, downtimeRoute]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}), defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
