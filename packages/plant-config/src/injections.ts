/**
 * Failure injections (#140, Phase 6 plan "Fault injection"): a named failure mode on a machine at a
 * simulation time, from the simulator's control API or a golden scenario's `injections` list. The
 * cross-check refuses an injection on an unknown machine or code, a repair time that is not a
 * positive integer, and a time that coincides with a calendar boundary (shift start or end, break
 * start or end): at a boundary the order of the injection and the calendar event would depend on
 * how the two were queued, so a live run and a headless run could differ.
 */
import { shiftBoundaries } from '@shopfloor/shift-calendar';
import type { PlantConfig } from './schema.ts';

export interface FailureInjectionSpec {
  /** Simulation time, integer ms since 1970 UTC. */
  readonly at: number;
  readonly machine: string;
  readonly code: string;
  /** Exact repair time in ms (at least 1); without it the mode's repair stream draws one. */
  readonly repairMs?: number | undefined;
}

export type InjectionIssueCode =
  'invalid-time' | 'unknown-machine' | 'unknown-code' | 'invalid-repair' | 'calendar-boundary';

export interface InjectionIssue {
  readonly code: InjectionIssueCode;
  readonly message: string;
}

/** Whether `at` is a shift start or end, or a break start or end, of the configured calendar. */
export function isCalendarBoundary(config: Pick<PlantConfig, 'shifts'>, at: number): boolean {
  return shiftBoundaries(config.shifts, at, at + 1).length > 0;
}

/** The problems of one injection under a configuration, empty when it is valid. */
export function injectionIssues(
  config: Pick<PlantConfig, 'plant' | 'failures' | 'shifts'>,
  injection: FailureInjectionSpec,
): InjectionIssue[] {
  const issues: InjectionIssue[] = [];
  const { at, machine, code, repairMs } = injection;
  if (!Number.isSafeInteger(at)) {
    issues.push({ code: 'invalid-time', message: `time ${String(at)} is not integer ms` });
  }
  const known = config.plant.areas.some((area) =>
    area.workCenters.some((workCenter) => workCenter.equipment.some((e) => e.id === machine)),
  );
  if (!known) {
    issues.push({ code: 'unknown-machine', message: `unknown machine "${machine}"` });
  } else if (
    !(config.failures.equipment[machine]?.failureModes ?? []).some((mode) => mode.code === code)
  ) {
    issues.push({
      code: 'unknown-code',
      message: `${machine} has no failure mode "${code}"`,
    });
  }
  if (repairMs !== undefined && (!Number.isSafeInteger(repairMs) || repairMs < 1)) {
    issues.push({
      code: 'invalid-repair',
      message: `repairMs must be an integer of at least 1, got ${String(repairMs)}`,
    });
  }
  if (Number.isSafeInteger(at) && isCalendarBoundary(config, at)) {
    issues.push({
      code: 'calendar-boundary',
      message: `${new Date(at).toISOString()} is a calendar boundary (shift or break start or end)`,
    });
  }
  return issues;
}

/** The cross-check of a scenario's `injections`: every issue with its list position. */
export function checkInjections(
  config: Pick<PlantConfig, 'plant' | 'failures' | 'shifts'>,
  injections: readonly FailureInjectionSpec[],
): { path: string; message: string }[] {
  return injections.flatMap((injection, index) =>
    injectionIssues(config, injection).map((issue) => ({
      path: `injections[${String(index)}]`,
      message: issue.message,
    })),
  );
}
