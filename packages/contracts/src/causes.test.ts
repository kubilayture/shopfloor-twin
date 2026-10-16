import { describe, expect, it } from 'vitest';
import {
  CAUSES,
  NO_PRODUCT,
  causeVocabulary,
  changeoverCause,
  materialCause,
  UNAVAILABLE_CAUSES,
} from './index.ts';

describe('cause vocabulary (#119)', () => {
  it('spells the causes exactly as the golden event log has them', () => {
    // These strings are in apps/simulator/golden/week-01's event log: changing one changes
    // events.sha256.
    expect(Object.values(CAUSES)).toEqual([
      'TOOL-CHANGE',
      'CALIBRATION',
      'SCHEDULE-COMPLETE',
      'NO-OPERATOR',
      'BREAK',
      'SHIFT-END',
      'NO-ORDER',
    ]);
    expect(materialCause('BLANK-100')).toBe('MATERIAL:BLANK-100');
    expect(changeoverCause('VB-100', 'VB-200')).toBe('CHANGEOVER VB-100→VB-200');
    expect(changeoverCause(undefined, 'VB-100')).toBe(`CHANGEOVER ${NO_PRODUCT}→VB-100`);
    // The Modbus cause table keeps its order (register map version 1).
    expect(UNAVAILABLE_CAUSES).toEqual(['BREAK', 'SHIFT-END', 'NO-OPERATOR']);
  });

  it('enumerates every (state, cause) pair a configuration can emit', () => {
    const pairs = causeVocabulary({
      failureCodes: ['F-1', 'F-1'],
      minorStopCauses: ['JAM'],
      products: ['P-1', 'P-2'],
      materials: ['M-1'],
    });
    expect(pairs).toEqual([
      { state: 'Down', cause: 'F-1' },
      { state: 'Stopped', cause: 'JAM' },
      { state: 'Setup', cause: 'TOOL-CHANGE' },
      { state: 'Setup', cause: 'CHANGEOVER none→P-1' },
      { state: 'Setup', cause: 'CHANGEOVER none→P-2' },
      { state: 'Setup', cause: 'CHANGEOVER P-1→P-2' },
      { state: 'Setup', cause: 'CHANGEOVER P-2→P-1' },
      { state: 'Maintenance', cause: 'CALIBRATION' },
      { state: 'Idle', cause: 'SCHEDULE-COMPLETE' },
      { state: 'Idle', cause: 'NO-OPERATOR' },
      { state: 'Idle', cause: 'NO-ORDER' },
      { state: 'PlannedStop', cause: 'BREAK' },
      { state: 'Off', cause: 'SHIFT-END' },
      { state: 'Starved', cause: 'MATERIAL:M-1' },
    ]);
  });
});
