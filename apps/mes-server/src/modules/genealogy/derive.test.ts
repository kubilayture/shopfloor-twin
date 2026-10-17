import { describe, expect, it } from 'vitest';
import {
  finalThrough,
  finality,
  mismatches,
  placeCartons,
  traceUnit,
  type LotLink,
  type PlacedPack,
} from './derive.ts';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 3, minute));

describe('traceUnit (#199)', () => {
  it('keeps absent, [] and reported lots apart, and the operator reported or not', () => {
    const records = [
      {
        operation: 'OP10',
        equipment: 'cnc-01',
        pass: 1,
        at: at(1),
        result: 'good' as const,
        reason: null,
        seq: 5,
      },
      {
        operation: 'OP20',
        equipment: 'wsh-01',
        pass: 1,
        at: at(2),
        result: 'good' as const,
        reason: null,
        seq: 9,
      },
      {
        operation: 'OP30',
        equipment: 'asm-01',
        pass: 1,
        at: at(3),
        result: 'good' as const,
        reason: null,
        seq: 3,
      },
      {
        operation: 'OP40',
        equipment: 'lkt-01',
        pass: 1,
        at: at(4),
        result: 'good' as const,
        reason: null,
        seq: 4,
      },
    ];
    const reading = { characteristic: 'leak-rate', value: 2.1, unit: 'Pa/min', upperLimit: 3.2 };
    const { records: traced, links } = traceUnit(records, [
      {
        equipment: 'cnc-01',
        seq: 5,
        lots: [{ material: 'BLANK-100', lot: 'B1' }],
        operator: null,
        measurement: null,
      },
      // WSH-01: no field at all.
      { equipment: 'wsh-01', seq: 9, measurement: null },
      {
        equipment: 'asm-01',
        seq: 3,
        lots: [
          { material: 'SK-1', lot: 'K1' },
          { material: 'SP-100', lot: 'P1' },
        ],
        operator: 'op-ayse',
        measurement: null,
      },
      { equipment: 'lkt-01', seq: 4, lots: [], measurement: reading },
    ]);
    expect(
      traced.map((r) => [r.equipment, r.lots, r.operator, r.operatorReported, r.measurement]),
    ).toEqual([
      ['cnc-01', [{ material: 'BLANK-100', lot: 'B1' }], null, true, null],
      ['wsh-01', null, null, false, null],
      [
        'asm-01',
        [
          { material: 'SK-1', lot: 'K1' },
          { material: 'SP-100', lot: 'P1' },
        ],
        'op-ayse',
        true,
        null,
      ],
      ['lkt-01', [], null, false, reading],
    ]);
    expect(links.map((l) => [l.lot, l.operation, l.pass, l.equipment, l.seq, l.position])).toEqual([
      ['B1', 'OP10', 1, 'cnc-01', 5, 0],
      ['K1', 'OP30', 1, 'asm-01', 3, 0],
      ['P1', 'OP30', 1, 'asm-01', 3, 1],
    ]);
  });

  it('reports nothing for a record whose fact is missing', () => {
    const { records, links } = traceUnit(
      [
        {
          operation: 'OP10',
          equipment: 'cnc-01',
          pass: 1,
          at: at(1),
          result: 'good',
          reason: null,
          seq: 1,
        },
      ],
      [],
    );
    expect([records[0]?.lots, records[0]?.operatorReported, links]).toEqual([null, false, []]);
  });
});

describe('mismatches (#199)', () => {
  const link = (material: string, operation: string, pass: number, lot = 'L'): LotLink => ({
    lot,
    material,
    operation,
    pass,
    equipment: 'asm-01',
    seq: 1,
    position: 0,
    at: at(0),
  });
  const bom = [
    { material: 'BLANK-100', operation: 'OP10', usage: 'standard' as const },
    { material: 'SK-1', operation: 'OP30', usage: 'standard' as const },
    { material: 'SK-1', operation: 'OP30', usage: 'rework' as const },
    { material: 'SP-100', operation: 'OP30', usage: 'standard' as const },
  ];
  it('checks standard lines on a first pass and rework lines on a later one', () => {
    const found = mismatches(
      [
        link('SK-1', 'OP30', 1),
        link('SP-100', 'OP30', 2),
        link('SK-1', 'OP30', 2),
        link('SK-2', 'OP10', 1),
      ],
      bom,
      () => undefined,
    );
    expect(found.map((m) => [m.link.material, m.link.pass, m.message])).toEqual([
      ['SP-100', 2, 'SP-100 (lot L) is not a rework material of OP30 (BOM: SK-1)'],
      ['SK-2', 1, 'SK-2 (lot L) is not a standard material of OP10 (BOM: BLANK-100)'],
    ]);
  });
  it('flags a lot the ERP lists with another material', () => {
    const found = mismatches([link('SK-1', 'OP30', 1, 'K9')], bom, (lot) =>
      lot === 'K9' ? 'SK-2' : undefined,
    );
    expect(found.map((m) => m.message)).toEqual([
      'lot K9 was reported as SK-1 but the ERP lists it as SK-2',
    ]);
  });
});

describe('placeCartons (#199): the packing rule on final data', () => {
  const pack = (partId: number, minute: number, final = true): PlacedPack => ({
    unit: { epoch: 7, partId },
    orderId: 'A-1',
    at: at(minute).getTime(),
    seq: minute,
    final,
  });
  const order = { orderId: 'A-1', product: 'VB-200', completedAt: at(30).getTime() };
  const capacity = { 'VB-200': 2 };

  it('places packs in plant-time order up to the first that is not final', () => {
    const placed = placeCartons(
      { ...order, completedAt: null },
      [pack(3, 3), pack(1, 1), pack(4, 4, false), pack(2, 2), pack(5, 5)],
      capacity,
    );
    expect(placed.complete).toBe(false);
    expect(placed.placed).toBe(3);
    expect(placed.cartons.map((c) => [c.id, c.members.map((m) => m.partId), c.status])).toEqual([
      ['A-1-C01', [1, 2], 'closed'],
      ['A-1-C02', [3], 'open'],
    ]);
  });

  it('closes the last partial carton at the order’s completion only once every pack is placed', () => {
    const pending = placeCartons(order, [pack(1, 1), pack(2, 2), pack(3, 3, false)], capacity);
    expect(pending.cartons.map((c) => [c.status, c.closedAt])).toEqual([
      ['closed', at(2).getTime()],
    ]);
    const done = placeCartons(order, [pack(1, 1), pack(2, 2), pack(3, 3)], capacity);
    expect(done.cartons.map((c) => [c.id, c.status, c.closedAt])).toEqual([
      ['A-1-C01', 'closed', at(2).getTime()],
      ['A-1-C02', 'closed', at(30).getTime()],
    ]);
  });
});

describe('finality (#199)', () => {
  const machines = ['a', 'b'];
  it('is final when every machine is in a newer epoch or final through the latest record', () => {
    const progress = {
      a: { epoch: 2, settledSeq: 10, settledTime: at(10) },
      b: { epoch: 3, settledSeq: 1, settledTime: at(0) },
    };
    const of = (m: string) => progress[m as 'a' | 'b'];
    expect(finality([{ epoch: 2, at: at(5) }], machines, of)).toEqual({
      final: true,
      notFinal: [],
    });
    expect(finality([{ epoch: 2, at: at(11) }], machines, of)).toEqual({
      final: false,
      notFinal: ['a'],
    });
    expect(finality([{ epoch: 3, at: at(1) }], machines, of)).toEqual({
      final: false,
      notFinal: ['a', 'b'],
    });
    expect(finality([], machines, of)).toEqual({ final: true, notFinal: [] });
  });
  it('judges a fact against a machine’s final-through', () => {
    const device = { epoch: 2, settledSeq: 10, settledTime: at(10) };
    expect(finalThrough(device, { epoch: 2, seq: 10 })).toBe(true);
    expect(finalThrough(device, { epoch: 2, seq: 11 })).toBe(false);
    expect(finalThrough(device, { epoch: 1, seq: 99 })).toBe(true);
    expect(finalThrough(device, { epoch: 3, seq: 1 })).toBe(false);
    expect(finalThrough(undefined, { epoch: 1, seq: 1 })).toBe(false);
  });
});
