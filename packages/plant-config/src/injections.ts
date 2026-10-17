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

/** The longest injected repair: 365 days, so `at + repairMs` stays far inside safe integers. */
export const MAX_REPAIR_MS = 365 * 24 * 3_600_000;

export interface FailureInjectionSpec {
  /** Absent for a failure injection (a scenario entry without `kind`, ADR-0033). */
  readonly kind?: undefined;
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
  if (
    repairMs !== undefined &&
    (!Number.isSafeInteger(repairMs) || repairMs < 1 || repairMs > MAX_REPAIR_MS)
  ) {
    issues.push({
      code: 'invalid-repair',
      message: `repairMs must be an integer from 1 to ${String(MAX_REPAIR_MS)}, got ${String(repairMs)}`,
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

/**
 * A leak-test drift injection (Phase 8 plan, "Leak drift injection", ADR-0033): a sensor fault
 * that adds `shift` to the leak tester's reading from `at` until `until` or the tester's next
 * calibration, whichever comes first. `until` may be at or after a run's end (the drift then
 * lasts to the end).
 */
export interface LeakDriftSpec {
  readonly kind: 'leak-drift';
  /** Simulation time, integer ms since 1970 UTC. */
  readonly at: number;
  /** Simulation time after `at`, integer ms since 1970 UTC. */
  readonly until: number;
  readonly machine: string;
  /** In the tester's unit (Pa/min): a non-zero whole multiple of its `resolution`. */
  readonly shift: number;
}

/** A scenario's injection: a failure (no `kind`) or a leak drift. */
export type InjectionSpec = FailureInjectionSpec | LeakDriftSpec;

/** The largest drift in resolution steps (1,000 Pa/min at 0.001 Pa/min). */
export const MAX_DRIFT_STEPS = 1_000_000;

export type DriftIssueCode =
  | 'invalid-time'
  | 'invalid-until'
  | 'unknown-machine'
  | 'not-a-leak-tester'
  | 'invalid-shift'
  | 'calendar-boundary';

export interface DriftIssue {
  readonly code: DriftIssueCode;
  readonly message: string;
}

/**
 * `shift` in whole resolution steps, or `undefined` when it is not a non-zero whole multiple of
 * `resolution` within `MAX_DRIFT_STEPS`. The tolerance only absorbs the binary representation of
 * decimals (0.6 / 0.001 is 599.9999999999999).
 */
export function driftSteps(shift: number, resolution: number): number | undefined {
  if (!Number.isFinite(shift)) return undefined;
  const steps = Math.round(shift / resolution);
  if (steps === 0 || Math.abs(steps) > MAX_DRIFT_STEPS) return undefined;
  return Math.abs(steps * resolution - shift) <= resolution * 1e-6 ? steps : undefined;
}

/**
 * The problems of one drift injection, empty when it is valid. `at` must not be a calendar
 * boundary, nor `until` while it falls inside the run (`runEnd` when known: an `until` at or after
 * the end never takes effect).
 */
export function driftIssues(
  config: Pick<PlantConfig, 'plant' | 'shifts' | 'process'>,
  drift: Omit<LeakDriftSpec, 'kind'>,
  runEnd?: number,
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const { at, until, machine, shift } = drift;
  // The machine first: an unknown machine is the first issue (404 in the control API).
  const equipment = config.plant.areas
    .flatMap((area) => area.workCenters.flatMap((workCenter) => workCenter.equipment))
    .find((e) => e.id === machine);
  if (!equipment) {
    issues.push({ code: 'unknown-machine', message: `unknown machine "${machine}"` });
  } else if (equipment.operation !== config.process.leakTest.operation) {
    issues.push({
      code: 'not-a-leak-tester',
      message: `${machine} is not a leak tester (operation ${config.process.leakTest.operation})`,
    });
  }
  const timeOk = Number.isSafeInteger(at);
  if (!timeOk) {
    issues.push({ code: 'invalid-time', message: `time ${String(at)} is not integer ms` });
  }
  const untilOk = Number.isSafeInteger(until) && (!timeOk || until > at);
  if (!untilOk) {
    issues.push({
      code: 'invalid-until',
      message: `until must be integer ms after at, got ${String(until)}`,
    });
  }
  const { resolution, unit } = config.process.leakTest;
  if (driftSteps(shift, resolution) === undefined) {
    issues.push({
      code: 'invalid-shift',
      message: `shift must be a non-zero whole multiple of ${String(resolution)} ${unit} (at most ${String(MAX_DRIFT_STEPS)} steps), got ${String(shift)}`,
    });
  }
  const boundary = (time: number, name: string): void => {
    if (isCalendarBoundary(config, time)) {
      issues.push({
        code: 'calendar-boundary',
        message: `${name} ${new Date(time).toISOString()} is a calendar boundary (shift or break start or end)`,
      });
    }
  };
  if (timeOk) boundary(at, 'at');
  if (untilOk && (runEnd === undefined || until < runEnd)) boundary(until, 'until');
  return issues;
}

/**
 * The cross-check of a scenario's `injections` (failures and drifts): every issue with its list
 * position. With `runEnd`, a drift's `until` at or after it is not checked for a boundary.
 */
export function checkInjections(
  config: Pick<PlantConfig, 'plant' | 'failures' | 'shifts' | 'process'>,
  injections: readonly InjectionSpec[],
  runEnd?: number,
): { path: string; message: string }[] {
  return injections.flatMap((injection, index) =>
    (injection.kind === 'leak-drift'
      ? driftIssues(config, injection, runEnd)
      : injectionIssues(config, injection)
    ).map((issue) => ({
      path: `injections[${String(index)}]`,
      message: issue.message,
    })),
  );
}
