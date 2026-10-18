import { createRoute } from '@tanstack/react-router';
import { UNIT_KEY, validQuery } from '../domain/trace.ts';
import { TraceCartonRoute } from '../screens/trace-carton.tsx';
import { TraceLotRoute } from '../screens/trace-lot.tsx';
import { TraceSearch } from '../screens/trace-search.tsx';
import { TraceSerialRoute } from '../screens/trace-serial.tsx';
import { matching } from './search.ts';
import { rootRoute } from './root.tsx';

// Traceability (#202): the search and the serial (backward), lot (forward) and carton pages.

export interface TraceSearchParams {
  /** The start of a serial, lot, carton or order id. */
  readonly q?: string | undefined;
}

export interface SerialSearch {
  /** The unit shown when the serial names several (`{epoch}-{partId}`): serials repeat. */
  readonly unit?: string | undefined;
}

export const traceSearchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trace',
  validateSearch: (search: Record<string, unknown>): TraceSearchParams => ({
    q: validQuery(search.q),
  }),
  component: TraceSearch,
});

export const traceSerialRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trace/serials/$serial',
  validateSearch: (search: Record<string, unknown>): SerialSearch => ({
    unit: matching(search.unit, UNIT_KEY),
  }),
  component: TraceSerialRoute,
});

export const traceLotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trace/lots/$lot',
  component: TraceLotRoute,
});

export const traceCartonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trace/cartons/$carton',
  component: TraceCartonRoute,
});

export const traceRoutes = [
  traceSearchRoute,
  traceSerialRoute,
  traceLotRoute,
  traceCartonRoute,
] as const;
