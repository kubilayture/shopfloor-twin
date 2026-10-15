import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { isRangeKey, type RangeKey } from './domain/time.ts';
import { MachineDetail } from './screens/machine-detail.tsx';
import { Overview } from './screens/overview.tsx';
import { NotFound, RootLayout } from './screens/root-layout.tsx';

// Code-based routes (ADR-0020): two screens don't need a generated route tree.
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

const routeTree = rootRoute.addChildren([overviewRoute, detailRoute]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}), defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
