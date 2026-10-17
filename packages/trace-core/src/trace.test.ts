import { describe, expect, it } from 'vitest';
import { CONFIG, at, unit } from './fixtures.test-support.ts';
import { cartonId, packCartons, type OrderPacking } from './packing.ts';
import {
  backwardTrace,
  buildTrace,
  forwardTrace,
  traceAsOf,
  unitStatus,
  type Trace,
  type TraceInput,
} from './trace.ts';

describe('carton ids', () => {
  it('has at least two digits and grows past 99', () => {
    expect(cartonId('ORD-7', 1)).toBe('ORD-7-C01');
    expect(cartonId('ORD-7', 7)).toBe('ORD-7-C07');
    expect(cartonId('ORD-7', 99)).toBe('ORD-7-C99');
    expect(cartonId('ORD-7', 100)).toBe('ORD-7-C100');
    expect(() => cartonId('ORD-7', 0)).toThrow(RangeError);
  });
});

describe('packing rule', () => {
  const order: OrderPacking = { orderId: 'O', product: 'P', completedAt: null };
  const pack = (partId: number, atMs: number, seq = partId, epoch = 1) => ({
    unit: { epoch, partId },
    orderId: 'O',
    at: atMs,
    seq,
  });

  it('fills in plant-time order, ties by epoch then sequence, and closes full cartons', () => {
    const cartons = packCartons(
      [order],
      [pack(4, 30), pack(1, 10), pack(3, 20, 9), pack(2, 20, 5), pack(5, 30, 1, 2)],
      { P: 2 },
    );
    expect(
      cartons.map((c) => [c.id, c.members.map((m) => m.partId), c.status, c.closedAt]),
    ).toEqual([
      ['O-C01', [1, 2], 'closed', 20],
      ['O-C02', [3, 4], 'closed', 30],
      ['O-C03', [5], 'open', null],
    ]);
  });

  it("closes the last, partial carton when the order's packing is complete", () => {
    const [, last] = packCartons(
      [{ ...order, completedAt: 99 }],
      [1, 2, 3].map((n) => pack(n, n)),
      {
        P: 2,
      },
    );
    expect(last).toMatchObject({ id: 'O-C02', status: 'closed', closedAt: 99, capacity: 2 });
  });

  it('numbers past 99 cartons', () => {
    const packs = Array.from({ length: 101 }, (_, i) => pack(i + 1, i + 1));
    expect(packCartons([order], packs, { P: 1 }).at(-1)?.id).toBe('O-C101');
  });

  it('refuses a pack for an unknown order and a product without a capacity', () => {
    expect(() => packCartons([], [pack(1, 1)], { P: 1 })).toThrow(/unknown order/);
    expect(() => packCartons([order], [], {})).toThrow(/capacity/);
    expect(() => packCartons([order], [], { P: 0 })).toThrow(/capacity/);
  });
});

/**
 * ORD-1 (VB-100, cartons of 3): units 1–7, blank lot BL-1 for 1–4 and BL-2 after, unit 3 reworked
 * with a second seal-kit lot, unit 6 scrapped at the leak test, unit 8 still in WIP. ORD-2
 * (VB-200, cartons of 2): units 9–11, a short order with a partial last carton. Unit 12 has no
 * order (schedule mode).
 */
const INPUT: TraceInput = {
  config: CONFIG,
  units: [
    unit({ partId: 1, start: 10, reading: 2000 }),
    unit({ partId: 2, start: 20, reading: 2010 }),
    unit({ partId: 3, start: 30, reading: 2020, rework: { kit: 'SK-1B', retest: 2300 } }),
    unit({ partId: 4, start: 40, reading: 1990 }),
    unit({ partId: 5, start: 50, blank: 'BL-2', reading: 2000 }),
    unit({ partId: 6, start: 60, blank: 'BL-2', reading: 2005, scrap: true }),
    unit({ partId: 7, start: 70, blank: 'BL-2', kit: 'SK-1B', reading: 2600 }),
    unit({ partId: 8, start: 80, blank: 'BL-2', upTo: 3 }),
    unit({ partId: 9, start: 90, orderId: 'ORD-2', product: 'VB-200', reading: 2001 }),
    unit({ partId: 10, start: 100, orderId: 'ORD-2', product: 'VB-200', reading: 1999 }),
    unit({ partId: 11, start: 110, orderId: 'ORD-2', product: 'VB-200', reading: 2002 }),
    unit({ partId: 12, start: 120, orderId: null, blank: 'BL-3', reading: 2003 }),
  ],
  orders: [
    { orderId: 'ORD-1', product: 'VB-100', completedAt: null },
    { orderId: 'ORD-2', product: 'VB-200', completedAt: at(116) },
  ],
};

describe('the trace tree', () => {
  const trace = buildTrace(INPUT);

  it('gives every unit its status and carton', () => {
    expect(trace.units.map((u) => [u.partId, u.status, u.carton])).toEqual([
      [1, 'packed', 'ORD-1-C01'],
      [2, 'packed', 'ORD-1-C01'],
      [3, 'packed', 'ORD-1-C01'],
      [4, 'packed', 'ORD-1-C02'],
      [5, 'packed', 'ORD-1-C02'],
      [6, 'scrapped', null],
      [7, 'packed', 'ORD-1-C02'],
      [8, 'wip', null],
      [9, 'packed', 'ORD-2-C01'],
      [10, 'packed', 'ORD-2-C01'],
      [11, 'packed', 'ORD-2-C02'],
      [12, 'packed', null],
    ]);
  });

  it('forms cartons: one of two blank lots, a partial one closed with its order', () => {
    expect(trace.cartons.map((c) => [c.id, c.members.map((m) => m.partId), c.closedAt])).toEqual([
      ['ORD-1-C01', [1, 2, 3], at(37)],
      ['ORD-1-C02', [4, 5, 7], at(75)],
      ['ORD-2-C01', [9, 10], at(105)],
      ['ORD-2-C02', [11], at(116)],
    ]);
  });

  it('traces lots forward with their units, orders and cartons', () => {
    const summary = trace.lots.map((l) => [
      l.lot,
      l.material,
      l.consumed,
      l.units.map((u) => u.partId),
      l.orders,
      l.cartons,
    ]);
    expect(summary).toEqual([
      [
        'BL-1',
        'BLANK-100',
        7,
        [1, 2, 3, 4, 9, 10, 11],
        ['ORD-1', 'ORD-2'],
        ['ORD-1-C01', 'ORD-1-C02', 'ORD-2-C01', 'ORD-2-C02'],
      ],
      ['BL-2', 'BLANK-100', 4, [5, 6, 7, 8], ['ORD-1'], ['ORD-1-C02']],
      ['BL-3', 'BLANK-100', 1, [12], [], []],
      [
        'SK-1A',
        'SK-1',
        11,
        [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12],
        ['ORD-1', 'ORD-2'],
        ['ORD-1-C01', 'ORD-1-C02', 'ORD-2-C01', 'ORD-2-C02'],
      ],
      ['SK-1B', 'SK-1', 2, [3, 7], ['ORD-1'], ['ORD-1-C01', 'ORD-1-C02']],
    ]);
  });

  it('traces a lot forward with the lots used with it', () => {
    expect(forwardTrace(trace, 'SK-1B')?.withLots).toEqual([
      { material: 'BLANK-100', lot: 'BL-1' },
      { material: 'BLANK-100', lot: 'BL-2' },
      { material: 'SK-1', lot: 'SK-1A' },
    ]);
    expect(forwardTrace(trace, 'NOPE')).toBeNull();
  });

  it('traces a serial back to every unit with it, newest epoch first', () => {
    const repeat = buildTrace({
      ...INPUT,
      units: [...INPUT.units, { ...unit({ partId: 1, start: 200, orderId: null }), epoch: 2 }],
    });
    const units = backwardTrace(repeat, 'VB-100-000001');
    expect(units.map((u) => u.epoch)).toEqual([2, 1]);
    const [, first] = units;
    expect(
      first?.records.map((r) => [r.operation, r.pass, r.lots.map((l) => l.lot), r.operator]),
    ).toEqual([
      ['OP10', 1, ['BL-1'], null],
      ['OP20', 1, [], null],
      ['OP30', 1, ['SK-1A'], 'OP-A'],
      ['OP40', 1, [], null],
      ['OP50', 1, [], null],
    ]);
  });

  it('charts first-pass leak readings with version 1 from the baseline, retests apart', () => {
    const { spc } = trace;
    expect(spc.chart.firstPass.map((r) => r.value)).toEqual([
      2000, 2010, 2020, 1990, 2000, 2005, 2600, 2001, 1999, 2002, 2003,
    ]);
    expect(spc.chart.retests.map((r) => [r.key, r.value])).toEqual([['1/3/2', 2300]]);
    expect(spc.limits.map((v) => [v.version, v.createdAt])).toEqual([[1, at(44)]]);
    // Unit 7's 2600 lies far above the I limit.
    expect(spc.chart.episodes.find((e) => e.chart === 'I' && e.rule === 1)?.key).toBe('1/7/1');
  });

  it('refuses a unit given twice and a lot named with two materials', () => {
    expect(() =>
      buildTrace({ ...INPUT, units: [...INPUT.units, unit({ partId: 1, start: 0 })] }),
    ).toThrow(/given twice/);
    const odd = unit({ partId: 13, start: 130, orderId: null, blank: 'SK-1A' });
    expect(() => buildTrace({ ...INPUT, units: [...INPUT.units, odd] })).toThrow(
      /two materials|named as/,
    );
  });

  it('derives a unit status from its records', () => {
    expect(unitStatus([], 'OP50')).toBe('wip');
  });
});

describe('traceAsOf', () => {
  const trace = buildTrace(INPUT);

  it('keeps what was complete before the cut', () => {
    const cut = traceAsOf(trace, at(74));
    // Unit 7 has OP10–OP30 (71–73), unit 8 not yet started.
    expect(cut.units.map((u) => [u.partId, u.records.length, u.status])).toEqual([
      [1, 5, 'packed'],
      [2, 5, 'packed'],
      [3, 7, 'packed'],
      [4, 5, 'packed'],
      [5, 5, 'packed'],
      [6, 4, 'scrapped'],
      [7, 3, 'wip'],
    ]);
    expect(cut.cartons.map((c) => [c.id, c.members.map((m) => m.partId), c.status])).toEqual([
      ['ORD-1-C01', [1, 2, 3], 'closed'],
      ['ORD-1-C02', [4, 5], 'open'],
    ]);
    expect(cut.orders.find((o) => o.orderId === 'ORD-2')?.completedAt).toBeNull();
  });

  it('keeps an order complete and its partial carton closed only after the completion', () => {
    expect(traceAsOf(trace, at(116)).cartons.at(-1)?.status).toBe('open');
    expect(traceAsOf(trace, at(116) + 1).cartons.at(-1)?.status).toBe('closed');
  });

  it('drops a limit version created at or after the cut, and keeps an episode open at it', () => {
    expect(traceAsOf(trace, at(44)).spc.limits).toEqual([]);
    expect(traceAsOf(trace, at(44)).spc.chart.episodes).toEqual([]);
    const cut = traceAsOf(trace, at(75));
    expect(cut.spc.limits).toEqual(trace.spc.limits);
    const open = cut.spc.chart.episodes.find((e) => e.chart === 'I' && e.rule === 1);
    expect(open).toMatchObject({ key: '1/7/1', closedBy: null });
    expect(trace.spc.chart.episodes.find((e) => e.chart === 'I' && e.rule === 1)?.closedBy).toBe(
      '1/9/1',
    );
  });

  it('keeps a version ended at or after the cut open', () => {
    const [v1] = trace.spc.limits;
    if (!v1) throw new Error('no version 1');
    const ended = buildTrace({
      ...INPUT,
      limits: [{ ...v1, until: { epoch: 1, at: at(94), seq: 0 }, endedAt: at(90) }],
    });
    expect(traceAsOf(ended, at(90)).spc.limits[0]).toMatchObject({ until: null, endedAt: null });
    expect(traceAsOf(ended, at(91)).spc.limits[0]).toMatchObject({ endedAt: at(90) });
    // Unit 9's reading (at 94) is past `until`: judged by no version once the end is known.
    const point = (t: Trace) => t.spc.chart.points.I.find((p) => p.key === '1/9/1')?.version;
    expect(point(ended)).toBeNull();
    expect(point(traceAsOf(ended, at(95)))).toBeNull();
  });

  it('is the whole trace after the last record', () => {
    expect(traceAsOf(trace, at(10_000))).toEqual(trace);
  });
});
