/**
 * The cause vocabulary of the plant model (#119; docs/simulation-model.md "Causes"): every
 * `cause` a state change can carry, in one place. The simulator emits these strings; the MES's
 * auto-classification rules (`config/plant/reasons.yaml`) and the plant-config cross-check match
 * against them. Failure codes and minor-stop causes come from `failures.yaml`; the fixed causes
 * and the two parameterised forms are defined here. The strings are part of the golden event log:
 * changing one changes `events.sha256`.
 */
import type { MachineState } from './uns/payloads.ts';

/** Fixed causes, by the situation that gives them. */
export const CAUSES = {
  /** Setup: a CNC changes its worn tool. */
  toolChange: 'TOOL-CHANGE',
  /** Maintenance: the leak tester's planned calibration. */
  calibration: 'CALIBRATION',
  /** Idle: a CNC has worked through its schedule. */
  scheduleComplete: 'SCHEDULE-COMPLETE',
  /** Idle: a station that needs an operator has none this shift. */
  noOperator: 'NO-OPERATOR',
  /** PlannedStop: the shift's break. */
  break: 'BREAK',
  /** Off: the end of a shift. */
  shiftEnd: 'SHIFT-END',
} as const;

export type FixedCause = (typeof CAUSES)[keyof typeof CAUSES];

/** Starved for a material: `MATERIAL:<material id>`. */
export const MATERIAL_CAUSE_PREFIX = 'MATERIAL:';
/** Setup for a product change: `CHANGEOVER <from>→<to>`. */
export const CHANGEOVER_CAUSE_PREFIX = 'CHANGEOVER ';
/** Stands for "no product loaded" in a changeover cause (`CHANGEOVER none→VB-100`). */
export const NO_PRODUCT = 'none';

export const materialCause = (material: string): string => `${MATERIAL_CAUSE_PREFIX}${material}`;

export const changeoverCause = (from: string | undefined, to: string): string =>
  `${CHANGEOVER_CAUSE_PREFIX}${from ?? NO_PRODUCT}→${to}`;

/** A (state, cause) pair the plant model can emit; `cause: null` is a state change without one. */
export interface StateCause {
  readonly state: MachineState;
  readonly cause: string | null;
}

/** What the vocabulary needs from the plant configuration. */
export interface CauseInputs {
  readonly failureCodes: readonly string[];
  readonly minorStopCauses: readonly string[];
  readonly products: readonly string[];
  /** Blanks and components: what a station can be starved of. */
  readonly materials: readonly string[];
}

/**
 * Every (state, cause) pair with a cause that the plant model can emit for a configuration,
 * enumerated concretely (each changeover pair, each material). States the model enters without a
 * cause (Running, an empty buffer's Starved, Blocked, and others) are not listed: a rule set covers
 * them with its `state + null` fallbacks.
 */
export function causeVocabulary(inputs: CauseInputs): StateCause[] {
  const unique = (items: readonly string[]): string[] => [...new Set(items)];
  return [
    ...unique(inputs.failureCodes).map((cause) => ({ state: 'Down' as const, cause })),
    ...unique(inputs.minorStopCauses).map((cause) => ({ state: 'Stopped' as const, cause })),
    { state: 'Setup', cause: CAUSES.toolChange },
    ...[undefined, ...unique(inputs.products)].flatMap((from) =>
      unique(inputs.products)
        .filter((to) => to !== from)
        .map((to) => ({ state: 'Setup' as const, cause: changeoverCause(from, to) })),
    ),
    { state: 'Maintenance', cause: CAUSES.calibration },
    { state: 'Idle', cause: CAUSES.scheduleComplete },
    { state: 'Idle', cause: CAUSES.noOperator },
    { state: 'PlannedStop', cause: CAUSES.break },
    { state: 'Off', cause: CAUSES.shiftEnd },
    ...unique(inputs.materials).map((material) => ({
      state: 'Starved' as const,
      cause: materialCause(material),
    })),
  ];
}
