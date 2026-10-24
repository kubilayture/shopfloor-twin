import { createRoute } from '@tanstack/react-router';
import { isRangeKey, type RangeKey } from '../domain/time.ts';
import { MachineDetail } from '../screens/machine-detail.tsx';
import { Overview } from '../screens/overview.tsx';
import { rootRoute } from './root.tsx';

// The plant (#98): the overview and a machine's detail.

export const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  staticData: { title: 'Plant overview' },
  component: Overview,
});

export interface DetailSearch {
  readonly range: RangeKey;
}

export const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/equipment/$id',
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    range: isRangeKey(search.range) ? search.range : '8h',
  }),
  staticData: { title: ({ id }) => `Machine ${id ?? ''}` },
  component: MachineDetail,
});

export const plantRoutes = [overviewRoute, detailRoute] as const;
