/**
 * Console actions (#234, Phase 9 plan "Console actions", ADR-0037): the physical world's levers a
 * test engineer pulls besides failures and drifts. A lot blocked or released, operators marked
 * absent for a shift, a CNC's tool broken. Each comes from the simulator's control API or a
 * headless run's `actions` list; this module holds the checks that need only the configuration
 * (unknown lot, machine, shift or operator; a time on a calendar boundary). The checks against the
 * running simulation (a time in the past, a shift already started) are the line's.
 */
import { shiftInstance } from '@shopfloor/shift-calendar';
import { isCalendarBoundary } from './injections.ts';
import type { PlantConfig } from './schema.ts';

/** Block a material lot (skipped as if empty) or release it, at a simulation time. */
export interface LotActionSpec {
  readonly kind: 'lot-block' | 'lot-release';
  /** Simulation time, integer ms since 1970 UTC. */
  readonly at: number;
  readonly lot: string;
}

/**
 * Mark operators absent for one shift, whatever their roster draw says. `shift` is the shift
 * bucket key `YYYY-MM-DD/<shift id>` (the shift's date and id, as the ground truth keys buckets).
 */
export interface OperatorsAbsentSpec {
  readonly kind: 'operators-absent';
  readonly shift: string;
  readonly operators: readonly string[];
}

/** Break a CNC's tool at a simulation time: its wear goes to end of life (1.0). */
export interface ToolBreakageSpec {
  readonly kind: 'tool-breakage';
  /** Simulation time, integer ms since 1970 UTC. */
  readonly at: number;
  readonly machine: string;
}

export type ActionSpec = LotActionSpec | OperatorsAbsentSpec | ToolBreakageSpec;

export const ACTION_KINDS = [
  'lot-block',
  'lot-release',
  'operators-absent',
  'tool-breakage',
] as const satisfies readonly ActionSpec['kind'][];

export type ActionIssueCode =
  | 'invalid-time'
  | 'calendar-boundary'
  | 'unknown-lot'
  | 'unknown-machine'
  | 'not-a-cnc'
  | 'invalid-shift'
  | 'unknown-shift'
  | 'no-operators'
  | 'duplicate-operator'
  | 'unknown-operator'
  | 'not-on-shift';

export interface ActionIssue {
  readonly code: ActionIssueCode;
  readonly message: string;
}

const SHIFT_KEY = /^(\d{4}-\d{2}-\d{2})\/([^/\s]+)$/;

/** A shift bucket key's date and shift id, or undefined when it is not `YYYY-MM-DD/<id>`. */
export function parseShiftKey(key: string): { date: string; shift: string } | undefined {
  const match = SHIFT_KEY.exec(key);
  if (!match?.[1] || !match[2]) return undefined;
  return { date: match[1], shift: match[2] };
}

/** The start of the scheduled shift `YYYY-MM-DD/<id>`, or undefined when there is none. */
export function shiftStart(config: Pick<PlantConfig, 'shifts'>, key: string): number | undefined {
  const parsed = parseShiftKey(key);
  return parsed && shiftInstance(config.shifts, parsed.date, parsed.shift)?.start;
}

type ActionConfig = Pick<PlantConfig, 'plant' | 'products' | 'shifts' | 'stock' | 'operators'>;

function timeIssues(config: ActionConfig, at: number): ActionIssue[] {
  if (!Number.isSafeInteger(at)) {
    return [{ code: 'invalid-time', message: `time ${String(at)} is not integer ms` }];
  }
  return isCalendarBoundary(config, at)
    ? [
        {
          code: 'calendar-boundary',
          message: `${new Date(at).toISOString()} is a calendar boundary (shift or break start or end)`,
        },
      ]
    : [];
}

/**
 * The problems of one action under a configuration, empty when it is valid. The first issue is
 * the one the control API answers with, so a missing resource comes first (404).
 */
export function actionIssues(config: ActionConfig, action: ActionSpec): ActionIssue[] {
  switch (action.kind) {
    case 'lot-block':
    case 'lot-release': {
      const issues: ActionIssue[] = [];
      if (!config.stock.lots.some((lot) => lot.id === action.lot)) {
        issues.push({ code: 'unknown-lot', message: `unknown lot "${action.lot}"` });
      }
      return [...issues, ...timeIssues(config, action.at)];
    }
    case 'tool-breakage': {
      const issues: ActionIssue[] = [];
      const equipment = config.plant.areas
        .flatMap((area) => area.workCenters.flatMap((workCenter) => workCenter.equipment))
        .find((e) => e.id === action.machine);
      const firstOperation = config.products.operations[0];
      if (!equipment) {
        issues.push({ code: 'unknown-machine', message: `unknown machine "${action.machine}"` });
      } else if (equipment.operation !== firstOperation) {
        issues.push({
          code: 'not-a-cnc',
          message: `${action.machine} has no tool (only the ${String(firstOperation)} CNCs do)`,
        });
      }
      return [...issues, ...timeIssues(config, action.at)];
    }
    case 'operators-absent': {
      const issues: ActionIssue[] = [];
      const roster = new Map(config.operators.operators.map((op) => [op.id, op]));
      const parsed = parseShiftKey(action.shift);
      // Unknown operators first (404), then the shift and the roster.
      for (const id of action.operators) {
        if (!roster.has(id)) {
          issues.push({ code: 'unknown-operator', message: `unknown operator "${id}"` });
        }
      }
      if (!parsed) {
        issues.push({
          code: 'invalid-shift',
          message: `shift must be YYYY-MM-DD/<shift id>, got "${action.shift}"`,
        });
      } else if (shiftInstance(config.shifts, parsed.date, parsed.shift) === undefined) {
        issues.push({
          code: 'unknown-shift',
          message: `no shift ${action.shift} in the calendar`,
        });
      }
      if (action.operators.length === 0) {
        issues.push({ code: 'no-operators', message: 'operators must list at least one id' });
      }
      const seen = new Set<string>();
      for (const id of action.operators) {
        if (seen.has(id)) {
          issues.push({ code: 'duplicate-operator', message: `operator "${id}" is listed twice` });
        }
        seen.add(id);
        const operator = roster.get(id);
        if (parsed && operator && operator.shift !== parsed.shift) {
          issues.push({
            code: 'not-on-shift',
            message: `operator "${id}" is rostered on shift ${operator.shift}, not ${parsed.shift}`,
          });
        }
      }
      return issues;
    }
  }
}

/** The cross-check of a headless run's `actions`: every issue with its list position. */
export function checkActions(
  config: ActionConfig,
  actions: readonly ActionSpec[],
): { path: string; message: string }[] {
  return actions.flatMap((action, index) => {
    const kind: unknown = action.kind;
    if (!(ACTION_KINDS as readonly unknown[]).includes(kind)) {
      return [
        { path: `actions[${String(index)}]`, message: `unknown kind ${JSON.stringify(kind)}` },
      ];
    }
    return actionIssues(config, action).map((issue) => ({
      path: `actions[${String(index)}]`,
      message: issue.message,
    }));
  });
}
