import type { Clock, Plant } from '@shopfloor/contracts/mes-api';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { isNewerClock } from '../domain/states.ts';
import { liveKeys, type LiveStates } from '../live/live-cache.ts';
import { useLiveStates } from '../live/live-context.tsx';
import { ApiError, getPlant } from './client.ts';
import type { RangeKey } from '../domain/time.ts';

export const queryKeys = {
  equipmentList: ['equipment'] as const,
  equipment: (id: string) => ['equipment', id] as const,
  plant: ['plant'] as const,
  intervals: (id: string, range: RangeKey) => ['intervals', id, range] as const,
  metrics: (id: string) => ['metrics', id] as const,
  series: (id: string, range: RangeKey, metrics: readonly string[]) =>
    ['series', id, range, ...metrics] as const,
  currentShift: ['shifts', 'current'] as const,
  shifts: (to: string) => ['shifts', 'list', to] as const,
  shiftOee: (shiftKey: string) => ['shift-oee', shiftKey] as const,
  hourlyOee: (id: string, shiftKey: string) => ['oee', 'hour', id, shiftKey] as const,
  pareto: (id: string, shiftKey: string) => ['pareto', id, shiftKey] as const,
  paretoAll: ['pareto'] as const,
  reasonCodes: ['reason-codes'] as const,
  downtime: (shiftKey: string) => ['downtime', shiftKey] as const,
  downtimeAll: ['downtime'] as const,
  audit: (id: string) => ['downtime-audit', id] as const,
  // Alarms (#145): the lists, one occurrence, points and scopes.
  alarmsAll: ['alarms'] as const,
  alarms: (view: string, to = '') => ['alarms', view, to] as const,
  alarm: (id: string) => ['alarm', id] as const,
  alarmHistory: (id: string) => ['alarm-history', id] as const,
  alarmPoints: ['alarm-points'] as const,
  alarmScopes: ['alarm-scopes'] as const,
  /** Every read of the alarm KPI page starts with this (one prefix to read again). */
  alarmKpiAll: ['alarm-kpi'] as const,
  alarmKpi: (scope: string, bucket: string, from: number, to: number) =>
    ['alarm-kpi', 'kpi', scope, bucket, from, to] as const,
  alarmFloods: (scope: string, from: number, to: number) =>
    ['alarm-kpi', 'floods', scope, from, to] as const,
  badActors: (scope: string, from: number, to: number) =>
    ['alarm-kpi', 'bad-actors', scope, from, to] as const,
  operatorKpi: (scope: string, from: number, to: number) =>
    ['alarm-kpi', 'operator', scope, from, to] as const,
};

/** Retries network and server errors a few times, never a refused request (4xx). */
export function shouldRetry(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failures < 3;
}

function newerClock(a: Clock | null | undefined, b: Clock | null | undefined): Clock | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return isNewerClock(a, b) ? a : b;
}

/** The plant clock: the newer of the pushed one and the one `GET /plant` returned. */
export function plantClock(queryClient: QueryClient): Clock | null {
  return newerClock(
    queryClient.getQueryData<LiveStates>(liveKeys.states)?.clock,
    queryClient.getQueryData<Plant>(queryKeys.plant)?.clock,
  );
}

export interface PlantClock {
  readonly clock: Clock | null;
  /** False until `GET /plant` answered or a clock was pushed. */
  readonly known: boolean;
  readonly site: Plant['site'] | undefined;
}

export function usePlantClock(): PlantClock {
  const plant = useQuery({ queryKey: queryKeys.plant, queryFn: ({ signal }) => getPlant(signal) });
  const live = useLiveStates();
  return {
    clock: newerClock(live?.clock, plant.data?.clock),
    known: plant.data !== undefined || Boolean(live?.clock),
    site: plant.data?.site,
  };
}
