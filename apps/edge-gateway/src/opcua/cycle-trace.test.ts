import { describe, expect, it } from 'vitest';
import { cycleTrace } from './collector.ts';

/** The OPC UA lot and operator fields of a cycle on the UNS (contract 1.4, #197, ADR-0033). */
describe('cycleTrace (#197)', () => {
  it('pairs LotMaterials and LotIds in consumption order, with the operator', () => {
    expect(cycleTrace(['SK-1', 'SK-2'], ['SK1-2610-01', 'SK2-2610-01'], 'OP-07')).toEqual({
      lots: [
        { material: 'SK-1', lot: 'SK1-2610-01' },
        { material: 'SK-2', lot: 'SK2-2610-01' },
      ],
      operator: 'OP-07',
      problems: [],
    });
  });

  it('keeps "none" ([] and null) apart from "not reported" (absent)', () => {
    // Empty arrays and an empty Operator: a cycle that consumed nothing, a machine with no operator.
    expect(cycleTrace([], [], '')).toEqual({ lots: [], operator: null, problems: [] });
    // Fields the event lacks arrive as Null (probe P1): an address space before 1.2.
    expect(cycleTrace(null, null, null)).toEqual({ problems: [] });
    expect(cycleTrace(undefined, undefined, undefined)).toEqual({ problems: [] });
    expect(cycleTrace(['BLANK-100'], ['BL100-2610-01'], null)).toEqual({
      lots: [{ material: 'BLANK-100', lot: 'BL100-2610-01' }],
      problems: [],
    });
  });

  it.each([
    ['one array missing', ['SK-1'], null, /both be String arrays/],
    ['a scalar instead of an array', 'SK-1', ['L-1'], /both be String arrays/],
    ['unequal lengths', ['SK-1', 'SK-2'], ['L-1'], /differ in length/],
    ['an empty lot id', ['SK-1'], [''], /empty, not a string/],
    ['a non-string entry', ['SK-1'], [7], /empty, not a string/],
    ['an id longer than 128', ['SK-1'], ['x'.repeat(129)], /longer than 128/],
    [
      'more than 64 lots',
      Array.from({ length: 65 }, () => 'SK-1'),
      Array.from({ length: 65 }, () => 'L-1'),
      /more than 64/,
    ],
  ])('leaves out lots the contract cannot carry: %s', (_label, materials, ids, problem) => {
    const trace = cycleTrace(materials, ids, 'OP-07');
    expect(trace.lots).toBeUndefined();
    expect(trace.operator).toBe('OP-07');
    expect(trace.problems).toHaveLength(1);
    expect(trace.problems[0]).toMatch(problem);
  });

  it('leaves out an operator the contract cannot carry', () => {
    for (const operator of [7, 'x'.repeat(129), ['OP-07']]) {
      const trace = cycleTrace([], [], operator);
      expect(trace.lots).toEqual([]);
      expect('operator' in trace).toBe(false);
      expect(trace.problems).toEqual(['Operator is not a string of at most 128 characters']);
    }
  });
});
