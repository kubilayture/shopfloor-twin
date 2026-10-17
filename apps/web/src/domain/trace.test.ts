import { describe, expect, it } from 'vitest';
import { holdRef, record, unit } from '../test/trace-fixtures.ts';
import {
  TRACE_ID,
  TRACE_POLL_MOVING_MS,
  TRACE_POLL_SETTLED_MS,
  LOT_FAST_POLL_UNITS,
  UNIT_KEY,
  blankLots,
  blocking,
  componentPasses,
  distinctLots,
  operationText,
  operatorText,
  overLimit,
  serialMoving,
  lotMoving,
  tracePoll,
  unitKey,
  validQuery,
} from './trace.ts';

describe('trace helpers (#202)', () => {
  it('takes a search the API takes, and digits the router parsed as a number', () => {
    expect(validQuery(' VB-100 ')).toBe('VB-100');
    expect(validQuery(42)).toBe('42');
    expect(validQuery('')).toBeUndefined();
    expect(validQuery('   ')).toBeUndefined();
    expect(validQuery('a\u0000b')).toBeUndefined();
    expect(validQuery('x'.repeat(129))).toBeUndefined();
    expect(validQuery(Number.NaN)).toBeUndefined();
    expect(validQuery({ q: 'x' })).toBeUndefined();
  });

  it('checks ids as the trace paths take them', () => {
    expect(TRACE_ID.test('PO-1001-C01')).toBe(true);
    expect(TRACE_ID.test('a b')).toBe(false);
    expect(TRACE_ID.test('a/b')).toBe(false);
    expect(TRACE_ID.test('x'.repeat(129))).toBe(false);
    expect(unitKey({ epoch: 3, partId: 42 })).toBe('3-42');
    expect(UNIT_KEY.test('3-42')).toBe(true);
    expect(UNIT_KEY.test('3/42')).toBe(false);
  });

  it('polls a moving answer faster than a settled one, and never after a failed read', () => {
    expect(tracePoll(false, true)).toBe(TRACE_POLL_MOVING_MS);
    expect(tracePoll(false, false)).toBe(TRACE_POLL_SETTLED_MS);
    expect(tracePoll(true, true)).toBe(false);
    expect(tracePoll(true, false)).toBe(false);
    expect(serialMoving({ final: true, units: [unit()] })).toBe(false);
    expect(serialMoving({ final: false, units: [unit()] })).toBe(true);
    expect(serialMoving({ final: true, units: [unit({ status: 'wip' })] })).toBe(true);
    // A forward trace: fast only while not final and small.
    expect(lotMoving({ final: false, units: [] })).toBe(true);
    expect(lotMoving({ final: true, units: [] })).toBe(false);
    expect(lotMoving({ final: false, units: new Array(LOT_FAST_POLL_UNITS).fill(0) })).toBe(false);
  });

  it('reads the blank lot from the OP10 record only, never from another first record', () => {
    expect(blankLots(unit())).toEqual([{ material: 'BLANK-100', lot: 'BL100-2610-01' }]);
    expect(blankLots(unit({ records: [] }))).toBe('no-record');
    expect(blankLots(unit({ records: [record({ lots: null })] }))).toBeNull();
    expect(blankLots(unit({ records: [record({ lots: [] })] }))).toEqual([]);
    // No OP10 record: OP30's seal-kit lots, the earliest record here, are not the blank.
    const assembly = record({
      operation: 'OP30',
      equipment: 'ASM-01',
      lots: [{ material: 'SK-1', lot: 'SK1-2610-01' }],
    });
    expect(blankLots(unit({ records: [assembly] }))).toBe('no-record');
    // Out of order in the answer: the OP10 record still gives the blank.
    const later = record({ operation: 'OP30', at: '2026-10-15T04:00:00.000Z', lots: [] });
    expect(blankLots(unit({ records: [later, record()] }))).toHaveLength(1);
  });

  it('keeps components not reported and leaves out records that reported none', () => {
    const passes = componentPasses(unit());
    // OP20 (WSH-01) reported no lot field; the OP40 records reported none.
    expect(passes.map(({ record: r }) => operationText(r))).toEqual([
      'OP20',
      'OP30',
      'OP30 (pass 2)',
    ]);
    expect(passes[0]?.lots).toBeNull();
    expect(passes[1]?.lots).toHaveLength(2);
    const none = unit({ records: [record(), record({ operation: 'OP20', lots: [] })] });
    expect(componentPasses(none)).toEqual([]);
  });

  it('tells operators apart: an id, none, or not reported', () => {
    expect(operatorText(record({ operator: 'op-ali', operatorReported: true }))).toBe('op-ali');
    expect(operatorText(record({ operator: null, operatorReported: true }))).toBe('None');
    expect(operatorText(record({ operator: null, operatorReported: false }))).toBe('Not reported');
  });

  it('keeps distinct lots, judges readings and holds', () => {
    expect(
      distinctLots([
        { material: 'A', lot: '1' },
        { material: 'A', lot: '1' },
        { material: 'B', lot: '2' },
      ]),
    ).toHaveLength(2);
    expect(overLimit({ characteristic: 'c', value: 2.1, unit: 'u', upperLimit: 2 })).toBe(true);
    expect(overLimit({ characteristic: 'c', value: 2, unit: 'u', upperLimit: 2 })).toBe(false);
    expect(blocking([])).toBe(false);
    expect(blocking([holdRef({ state: 'released' })])).toBe(false);
    expect(blocking([holdRef({ state: 'rejected' })])).toBe(true);
  });
});
