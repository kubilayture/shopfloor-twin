import { HOLD_STATES, type HoldState } from '@shopfloor/contracts/mes-api';
import { createRoute } from '@tanstack/react-router';
import { HoldDetailRoute, HoldList, HoldOpen } from '../screens/holds.tsx';
import { SpcChartRoute, SpcList } from '../screens/spc.tsx';
import { rootRoute } from './root.tsx';

// Quality (#203): the SPC characteristics and one characteristic's charts, the quality holds
// with one hold's detail, and the form that opens a hold (from a subject or a signal).

export interface SpcChartSearch {
  /** Every point instead of the default recent window. */
  readonly all?: boolean | undefined;
  /** A plant-time range (ISO), either end optional. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

const isoOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && /^\d{4}-/.test(value)
    ? new Date(value).toISOString()
    : undefined;

export const spcListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quality/spc',
  component: SpcList,
});

export const spcChartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quality/spc/$characteristic',
  validateSearch: (search: Record<string, unknown>): SpcChartSearch => ({
    all: search.all === true || search.all === 'true' ? true : undefined,
    from: isoOrUndefined(search.from),
    to: isoOrUndefined(search.to),
  }),
  component: SpcChartRoute,
});

export interface HoldListSearch {
  /** The states shown; all when absent. */
  readonly state?: HoldState | undefined;
  /** One subject (with `id`). */
  readonly kind?: string | undefined;
  readonly id?: string | undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= 128 ? value : undefined;

export const holdListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quality/holds',
  validateSearch: (search: Record<string, unknown>): HoldListSearch => ({
    state: (HOLD_STATES as readonly unknown[]).includes(search.state)
      ? (search.state as HoldState)
      : undefined,
    kind: text(search.kind),
    id: text(search.id),
  }),
  component: HoldList,
});

export interface HoldOpenSearch {
  /** The subject to hold (`lot`, `serial`, `carton`, `order`) and its id. */
  readonly kind?: string | undefined;
  readonly id?: string | undefined;
  /** An SPC signal whose suggested scope to hold from. */
  readonly signal?: number | undefined;
}

export const holdOpenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quality/holds/new',
  validateSearch: (search: Record<string, unknown>): HoldOpenSearch => {
    const signal = Number(search.signal);
    return {
      kind: text(search.kind),
      id: text(search.id),
      signal: Number.isSafeInteger(signal) && signal > 0 ? signal : undefined,
    };
  },
  component: HoldOpen,
});

export const holdDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quality/holds/$id',
  component: HoldDetailRoute,
});

export const qualityRoutes = [
  spcListRoute,
  spcChartRoute,
  holdListRoute,
  holdOpenRoute,
  holdDetailRoute,
] as const;
