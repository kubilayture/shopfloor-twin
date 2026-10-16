import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { ALARM_VIEWS } from '@shopfloor/contracts/mes-api';
import type { AlarmViewName } from './api/client.ts';
import { isRangeKey, type RangeKey } from './domain/time.ts';
import { AlarmKpi } from './screens/alarm-kpi.tsx';
import { AlarmList } from './screens/alarm-list.tsx';
import { DowntimeCoding } from './screens/downtime-coding.tsx';
import { MachineDetail } from './screens/machine-detail.tsx';
import { OeeDashboard } from './screens/oee-dashboard.tsx';
import { Overview } from './screens/overview.tsx';
import { NotFound, RootLayout } from './screens/root-layout.tsx';
import { ShiftList } from './screens/shift-list.tsx';
import { ShiftReport } from './screens/shift-report.tsx';

// Code-based routes (ADR-0020): eight screens don't need a generated route tree.
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

const OCCURRENCE_ID = RECORD_ID;
const SCOPE_KEY = /^(plant|(position|equipment):[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

export interface AlarmSearch {
  /** The list shown; `active` when absent. */
  readonly view?: AlarmViewName | undefined;
  /** The occurrence whose panel is open (`{equipment}~{epoch}~{seq}`). */
  readonly alarm?: string | undefined;
}

const alarmsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/alarms',
  validateSearch: (search: Record<string, unknown>): AlarmSearch => ({
    view: (ALARM_VIEWS as readonly unknown[]).includes(search.view)
      ? (search.view as AlarmViewName)
      : undefined,
    alarm: matching(search.alarm, OCCURRENCE_ID),
  }),
  component: AlarmList,
});

export interface AlarmKpiSearch {
  readonly shift?: string | undefined;
  /** `plant`, `position:<id>` or `equipment:<id>`: the scope of the details. */
  readonly focus?: string | undefined;
  readonly bucket?: 'hour' | 'shift' | undefined;
}

const alarmKpiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/alarms/kpi',
  validateSearch: (search: Record<string, unknown>): AlarmKpiSearch => ({
    shift: matching(search.shift, SHIFT_KEY),
    focus: matching(search.focus, SCOPE_KEY),
    bucket: search.bucket === 'hour' || search.bucket === 'shift' ? search.bucket : undefined,
  }),
  component: AlarmKpi,
});

const shiftListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shifts',
  component: ShiftList,
});

export interface ShiftReportSearch {
  /** The plant epoch of the instance; the newest that has the shift when absent. */
  readonly epoch?: number | undefined;
}

const shiftReportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shifts/$date/$shift',
  validateSearch: (search: Record<string, unknown>): ShiftReportSearch => {
    const epoch = typeof search.epoch === 'string' ? Number(search.epoch) : search.epoch;
    return {
      epoch:
        typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : undefined,
    };
  },
  component: ShiftReport,
});

// Eight routes still fit one file (ADR-0020's revisit threshold is a dozen).
const routeTree = rootRoute.addChildren([
  overviewRoute,
  detailRoute,
  oeeRoute,
  downtimeRoute,
  alarmsRoute,
  alarmKpiRoute,
  shiftListRoute,
  shiftReportRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}), defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
