import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_ALARM_CODE,
  CALIBRATION_ALARM_SEVERITY,
  FAILURE_ALARM_SEVERITY,
  alarmVocabulary,
} from './index.ts';

describe('alarm vocabulary (#139)', () => {
  it('spells the calibration alarm as the golden event log has it', () => {
    expect(CALIBRATION_ALARM_CODE).toBe('CALIBRATION-DUE');
    expect(CALIBRATION_ALARM_SEVERITY).toBe(300);
    expect(FAILURE_ALARM_SEVERITY).toBe(700);
  });

  it('lists every failure code per equipment and the leak testers calibration, once each', () => {
    expect(
      alarmVocabulary({
        failureCodes: { 'cnc-01': ['A', 'B', 'A'], 'lkt-01': ['SEAL'] },
        leakTesters: ['lkt-01'],
      }),
    ).toEqual([
      { equipment: 'cnc-01', code: 'A', severity: 700 },
      { equipment: 'cnc-01', code: 'B', severity: 700 },
      { equipment: 'lkt-01', code: 'SEAL', severity: 700 },
      { equipment: 'lkt-01', code: 'CALIBRATION-DUE', severity: 300 },
    ]);
  });
});
