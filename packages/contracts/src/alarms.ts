/**
 * The alarm vocabulary of the plant model (ADR-0010, ADR-0024): every (equipment, code) a plant
 * configuration can raise, with its wire severity. Every breakdown failure mode raises its code
 * when the machine goes Down; a leak tester raises `CALIBRATION-DUE` when calibration falls due.
 * The simulator raises these codes, and the plant-config cross-check requires an alarm definition
 * (`config/plant/alarms.yaml`) for each, as `causeVocabulary` does for causes.
 */
import { FAILURE_ALARM_SEVERITY } from './modbus.ts';

/** The leak tester's alarm when calibration falls due. */
export const CALIBRATION_ALARM_CODE = 'CALIBRATION-DUE';
export const CALIBRATION_ALARM_SEVERITY = 300;

export interface AlarmPoint {
  readonly equipment: string;
  readonly code: string;
  /** The severity on the wire, 1–1000. */
  readonly severity: number;
}

/** What the vocabulary needs from the plant configuration. */
export interface AlarmInputs {
  /** Failure-mode codes per equipment (`failures.yaml`). */
  readonly failureCodes: Readonly<Record<string, readonly string[]>>;
  /** The equipment that runs the leak test (`process.yaml`'s `leakTest.operation`). */
  readonly leakTesters: readonly string[];
}

/** Every alarm point a configuration can raise, failure codes first, without duplicates. */
export function alarmVocabulary(inputs: AlarmInputs): AlarmPoint[] {
  const points = new Map<string, AlarmPoint>();
  const add = (equipment: string, code: string, severity: number): void => {
    points.set(`${equipment}/${code}`, { equipment, code, severity });
  };
  for (const [equipment, codes] of Object.entries(inputs.failureCodes)) {
    for (const code of codes) {
      add(equipment, code, FAILURE_ALARM_SEVERITY);
    }
  }
  for (const equipment of inputs.leakTesters) {
    add(equipment, CALIBRATION_ALARM_CODE, CALIBRATION_ALARM_SEVERITY);
  }
  return [...points.values()];
}
