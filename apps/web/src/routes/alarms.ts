import { ALARM_VIEWS } from '@shopfloor/contracts/mes-api';
import { createRoute } from '@tanstack/react-router';
import type { AlarmViewName } from '../api/client.ts';
import { AlarmKpi } from '../screens/alarm-kpi.tsx';
import { AlarmList } from '../screens/alarm-list.tsx';
import { rootRoute } from './root.tsx';
import { RECORD_ID, SHIFT_KEY, matching } from './search.ts';

// Alarms (#145): the alarm list with its occurrence panel, and the alarm KPIs.

const OCCURRENCE_ID = RECORD_ID;
const SCOPE_KEY = /^(plant|(position|equipment):[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

export interface AlarmSearch {
  /** The list shown; `active` when absent. */
  readonly view?: AlarmViewName | undefined;
  /** The occurrence whose panel is open (`{equipment}~{epoch}~{seq}`). */
  readonly alarm?: string | undefined;
}

export const alarmsRoute = createRoute({
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

export const alarmKpiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/alarms/kpi',
  validateSearch: (search: Record<string, unknown>): AlarmKpiSearch => ({
    shift: matching(search.shift, SHIFT_KEY),
    focus: matching(search.focus, SCOPE_KEY),
    bucket: search.bucket === 'hour' || search.bucket === 'shift' ? search.bucket : undefined,
  }),
  component: AlarmKpi,
});

export const alarmRoutes = [alarmsRoute, alarmKpiRoute] as const;
