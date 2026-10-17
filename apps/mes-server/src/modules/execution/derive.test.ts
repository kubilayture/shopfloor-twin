import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildUnit,
  completion,
  holdsBlank,
  orderTotals,
  type CompletionUnit,
  type JobStart,
  type RoutingModel,
  type UnitFact,
} from './derive.ts';

const MODEL: RoutingModel = {
  operations: ['OP10', 'OP20', 'OP30', 'OP40', 'OP50'],
  test: 'OP40',
  back: 'OP30',
};
const OPERATION: Record<string, string> = {
  'cnc-01': 'OP10',
  'cnc-02': 'OP10',
  'wsh-01': 'OP20',
  'asm-01': 'OP30',
  'lkt-01': 'OP40',
  'pck-01': 'OP50',
};
const operationOf = (equipment: string) => OPERATION[equipment];

let seqs: Record<string, number> = {};
const fact = (
  equipment: string,
  at: number,
  result: 'good' | 'scrap' | 'rework' = 'good',
  extra: Partial<UnitFact> = {},
): UnitFact => {
  seqs[equipment] = (seqs[equipment] ?? 0) + 10;
  return {
    equipment,
    epoch: 1,
    seq: seqs[equipment] ?? 0,
    at,
    product: 'VB-100',
    partId: 7,
    serial: equipment.startsWith('cnc') ? 'VB-100-000007' : '',
    result,
    reason:
      result === 'scrap'
        ? equipment === 'lkt-01'
          ? 'LEAK'
          : 'DIMENSIONAL'
        : result === 'rework'
          ? 'LEAK'
          : null,
    ...extra,
  };
};

const starts = (list: JobStart[]) => (equipment: string) => (equipment === 'cnc-01' ? list : []);

describe('buildUnit (#175, ADR-0031)', () => {
  it('numbers passes after a leak-test rework, attributes the order by the latest started fact below the OP10 cycle and reads status and position', () => {
    seqs = {};
    const facts = [
      fact('cnc-01', 100),
      fact('wsh-01', 200),
      fact('asm-01', 300),
      fact('lkt-01', 400, 'rework'),
      fact('asm-01', 500),
      fact('lkt-01', 600),
      fact('pck-01', 700),
    ];
    const jobs: JobStart[] = [
      { seq: 1, commandId: 'A~OP10~1', orderId: 'A' },
      { seq: 5, commandId: 'B~OP10~1', orderId: 'B' },
      { seq: 15, commandId: 'C~OP10~1', orderId: 'C' },
    ];
    // Delivered in any order, the unit is the same.
    fc.assert(
      fc.property(fc.shuffledSubarray(facts, { minLength: facts.length }), (shuffled) => {
        const unit = buildUnit(shuffled, operationOf, starts(jobs), MODEL);
        expect(unit.records.map((r) => [r.operation, r.pass, r.result])).toEqual([
          ['OP10', 1, 'good'],
          ['OP20', 1, 'good'],
          ['OP30', 1, 'good'],
          ['OP40', 1, 'rework'],
          ['OP30', 2, 'good'],
          ['OP40', 2, 'good'],
          ['OP50', 1, 'good'],
        ]);
        expect([unit.orderId, unit.commandId, unit.serial]).toEqual([
          'B',
          'B~OP10~1',
          'VB-100-000007',
        ]);
        expect([unit.status, unit.position, unit.terminalAt, unit.suspect, unit.violation]).toEqual(
          ['packed', 'done', 700, null, null],
        );
      }),
    );
  });

  it('places a unit in WIP after its last good operation, or back at OP30 after a rework', () => {
    seqs = {};
    const a = buildUnit([fact('cnc-01', 1), fact('wsh-01', 2)], operationOf, starts([]), MODEL);
    expect([a.status, a.position, a.orderId]).toEqual(['wip', 'after:OP20', null]);
    const b = buildUnit(
      [fact('cnc-01', 1), fact('wsh-01', 2), fact('asm-01', 3), fact('lkt-01', 4, 'rework')],
      operationOf,
      starts([]),
      MODEL,
    );
    expect(b.position).toBe('rework:OP30');
    const scrapped = buildUnit([fact('cnc-01', 1, 'scrap')], operationOf, starts([]), MODEL);
    expect([scrapped.status, scrapped.terminalAt, scrapped.position]).toEqual([
      'scrapped',
      1,
      'done',
    ]);
  });

  it('suspects a missing predecessor or a repeat (judged later) and proves a record after the terminal one at once', () => {
    seqs = {};
    const gap = buildUnit([fact('cnc-01', 1), fact('asm-01', 3)], operationOf, starts([]), MODEL);
    expect(gap.suspect).toEqual({ kind: 'missing-predecessor', operation: 'OP20', before: 3 });
    // A second OP30 pass without the leak test's rework (still on its way, or never).
    const repeat = buildUnit(
      [fact('cnc-01', 1), fact('wsh-01', 2), fact('asm-01', 3), fact('asm-01', 5)],
      operationOf,
      starts([]),
      MODEL,
    );
    expect(repeat.suspect).toEqual({ kind: 'repeated', operation: 'OP40', before: 5 });
    const after = buildUnit(
      [fact('cnc-01', 1, 'scrap'), fact('wsh-01', 2)],
      operationOf,
      starts([]),
      MODEL,
    );
    expect([after.violation, after.status]).toEqual(['after-terminal', 'scrapped']);
  });
});

describe('holdsBlank (ADR-0031)', () => {
  it('reads the last decisive state after the last OP10 cycle', () => {
    expect(holdsBlank([])).toBe(true);
    expect(holdsBlank([{ state: 'Running', cause: null }])).toBe(true);
    expect(holdsBlank([{ state: 'Starved', cause: 'MATERIAL-BLANK-100' }])).toBe(false);
    expect(holdsBlank([{ state: 'Blocked', cause: null }])).toBe(false);
    expect(holdsBlank([{ state: 'Idle', cause: 'NO-ORDER' }])).toBe(false);
    expect(holdsBlank([{ state: 'Setup', cause: 'CHANGEOVER VB-100→VB-200' }])).toBe(false);
    // Breaks, shift ends, failures and a missing operator keep what the machine held.
    expect(
      holdsBlank([
        { state: 'Running', cause: null },
        { state: 'PlannedStop', cause: 'BREAK' },
        { state: 'Off', cause: null },
        { state: 'Down', cause: 'SPINDLE-OVERLOAD' },
        { state: 'Idle', cause: 'NO-OPERATOR' },
      ]),
    ).toBe(true);
    expect(
      holdsBlank([
        { state: 'Starved', cause: null },
        { state: 'PlannedStop', cause: 'BREAK' },
      ]),
    ).toBe(false);
  });
});

describe('orderTotals (H2)', () => {
  it('counts every pass and backflushes standard lines on a first pass, rework lines on a later one', () => {
    const bom = [
      { material: 'BLANK-100', operation: 'OP10', quantityPerUnit: 1, usage: 'standard' as const },
      { material: 'SK-1', operation: 'OP30', quantityPerUnit: 1, usage: 'standard' as const },
      { material: 'SP-100', operation: 'OP30', quantityPerUnit: 1, usage: 'standard' as const },
      { material: 'SK-1', operation: 'OP30', quantityPerUnit: 1, usage: 'rework' as const },
    ];
    const totals = orderTotals(
      [
        { operation: 'OP10', pass: 1, result: 'good', reason: null },
        { operation: 'OP10', pass: 1, result: 'scrap', reason: 'DIMENSIONAL' },
        { operation: 'OP30', pass: 1, result: 'good', reason: null },
        { operation: 'OP40', pass: 1, result: 'rework', reason: 'LEAK' },
        { operation: 'OP30', pass: 2, result: 'good', reason: null },
        { operation: 'OP40', pass: 2, result: 'scrap', reason: 'LEAK' },
      ],
      bom,
      MODEL.operations,
    );
    expect(totals.find((t) => t.operation === 'OP10')).toEqual({
      operation: 'OP10',
      in: 2,
      good: 1,
      scrap: { DIMENSIONAL: 1 },
      rework: 0,
      material: { 'BLANK-100': 2 },
    });
    expect(totals.find((t) => t.operation === 'OP30')?.material).toEqual({
      'SK-1': 2,
      'SP-100': 1,
    });
    expect(totals.find((t) => t.operation === 'OP40')).toMatchObject({
      in: 2,
      good: 0,
      rework: 1,
      scrap: { LEAK: 1 },
    });
  });
});

describe('completion (H1)', () => {
  const record = (operation: string, at: number, result: 'good' | 'scrap' | 'rework' = 'good') => ({
    equipment: operation,
    epoch: 1,
    seq: at,
    operation,
    at,
    result,
  });
  const packed: CompletionUnit = {
    status: 'packed',
    suspect: null,
    violation: false,
    records: [
      record('OP10', 1),
      record('OP20', 2),
      record('OP30', 3),
      record('OP40', 4),
      record('OP50', 5),
    ],
  };
  const reworked: CompletionUnit = {
    status: 'wip',
    suspect: null,
    violation: false,
    records: [record('OP10', 2), record('OP20', 3), record('OP30', 4), record('OP40', 6, 'rework')],
  };
  const all = () => true;

  it('keeps OP30 and OP40 open while a unit with one leak failure can come back, OP20 complete', () => {
    const done = completion([packed, reworked], true, all, MODEL);
    expect(Object.fromEntries(done)).toEqual({
      OP10: 2,
      OP20: 3,
      OP30: null,
      OP40: null,
      OP50: null,
    });
  });

  it('completes every operation once every unit is packed or scrapped, at the latest record', () => {
    const scrappedAgain: CompletionUnit = {
      status: 'scrapped',
      suspect: null,
      violation: false,
      records: [...reworked.records, record('OP30', 8), record('OP40', 9, 'scrap')],
    };
    const done = completion([packed, scrappedAgain], true, all, MODEL);
    expect(Object.fromEntries(done)).toEqual({ OP10: 2, OP20: 3, OP30: 9, OP40: 9, OP50: 9 });
  });

  it('keeps OP30 to OP50 open while a unit has an open suspect: its second OP30 pass may still be in a gap (#175 review)', () => {
    // Leak failure, then the test passed, then packed; the second OP30 pass is in an open gap of
    // asm-01, so buildUnit suspects a missing OP30 before the second test.
    seqs = {};
    const unit = buildUnit(
      [
        fact('cnc-01', 1),
        fact('wsh-01', 2),
        fact('asm-01', 3),
        fact('lkt-01', 4, 'rework'),
        fact('lkt-01', 6),
        fact('pck-01', 7),
      ],
      operationOf,
      starts([]),
      MODEL,
    );
    expect(unit.suspect).toMatchObject({ kind: 'missing-predecessor', operation: 'OP30' });
    const asUnit = (violation: boolean): CompletionUnit => ({
      status: unit.status,
      suspect: violation ? null : 'OP30',
      violation,
      records: unit.records.map((r) => ({ ...r })),
    });
    // Open: nothing after OP20 completes, so no short confirmation goes out early.
    expect(Object.fromEntries(completion([packed, asUnit(false)], true, all, MODEL))).toEqual({
      OP10: 1,
      OP20: 2,
      OP30: null,
      OP40: null,
      OP50: null,
    });
    // Proven (asm-01 final through it, the gap written off): the packed unit is past them all.
    expect(Object.fromEntries(completion([packed, asUnit(true)], true, all, MODEL))).toEqual({
      OP10: 1,
      OP20: 2,
      OP30: 6,
      OP40: 6,
      OP50: 7,
    });
  });

  it('completes once a fact lost in a written-off gap is proven missing: a packed unit without its OP20 record (#175 review)', () => {
    const noWasher: CompletionUnit = {
      status: 'packed',
      suspect: null,
      violation: true,
      records: [record('OP10', 1), record('OP30', 3), record('OP40', 4), record('OP50', 5)],
    };
    expect(Object.fromEntries(completion([noWasher], true, all, MODEL))).toEqual({
      OP10: 1,
      OP20: 1,
      OP30: 4,
      OP40: 4,
      OP50: 5,
    });
    // A unit in WIP with a proven violation counts as past the operations before its latest
    // record only: OP20 (missing) yes, OP30 and later not yet.
    const stuck: CompletionUnit = {
      ...noWasher,
      status: 'wip',
      records: noWasher.records.slice(0, 2),
    };
    expect(Object.fromEntries(completion([stuck], true, all, MODEL))).toMatchObject({
      OP20: 1,
      OP30: null,
    });
  });

  it('does not read a second break still in an open gap as missing once the first is proven (#175 review, LOW-5)', () => {
    // OP20 missing (proven: wsh-01 final through) and OP40's good test missing in a gap lkt-01
    // has not closed: only the proven one counts as passed.
    const twoBreaks: CompletionUnit = {
      status: 'packed',
      suspect: null,
      violation: true,
      records: [record('OP10', 1), record('OP30', 3), record('OP50', 5)],
    };
    const lktOpen = (operation: string) => operation !== 'OP40';
    expect(Object.fromEntries(completion([twoBreaks], true, all, MODEL, lktOpen))).toEqual({
      OP10: 1,
      OP20: 1,
      OP30: null,
      OP40: null,
      OP50: null,
    });
    // lkt-01 final through it too: the missing test is proven missing as well.
    expect(Object.fromEntries(completion([twoBreaks], true, all, MODEL, all))).toEqual({
      OP10: 1,
      OP20: 1,
      OP30: 3,
      OP40: 3,
      OP50: 5,
    });
  });

  it('waits for the jobs and for every record to be at or below its machine’s final-through', () => {
    expect(completion([packed], false, all, MODEL).get('OP50')).toBeNull();
    const notOp50 = (r: { equipment: string }) => r.equipment !== 'OP50';
    const done = completion([packed], true, notOp50, MODEL);
    expect([done.get('OP40'), done.get('OP50')]).toEqual([4, null]);
  });
});
