import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deriveBottlenecks } from './bottleneck.ts';
import { add, formatFraction, fraction } from './fraction.ts';
import { HOUR } from './intervals.ts';
import { lineOee, linePlannedBusyMs } from './line-oee.ts';
import type { OeeConfig } from './oee.ts';
import {
  completionOf,
  firstPassYield,
  headTimes,
  jobWindow,
  jobWindows,
  orderOee,
  windowInputs,
  type TimelineInterval,
} from './order-oee.ts';
import { intersect, measure, normalize, subtract } from './ranges.ts';

const CONFIG: OeeConfig = { microStopThresholdMs: 120_000, scheduledTime: 'orders' };
const MIN = 60_000;

describe('ranges', () => {
  it('normalizes: sorts, merges touching and overlapping ranges, drops empty ones', () => {
    expect(
      normalize([
        { from: 50, to: 60 },
        { from: 0, to: 10 },
        { from: 10, to: 20 },
        { from: 15, to: 18 },
        { from: 30, to: 30 },
      ]),
    ).toEqual([
      { from: 0, to: 20 },
      { from: 50, to: 60 },
    ]);
  });

  it('refuses a reversed or non-integer range', () => {
    expect(() => normalize([{ from: 5, to: 4 }])).toThrow(/ends before/);
    expect(() => normalize([{ from: 0, to: Number.NaN }])).toThrow(/integer/);
  });

  it('intersects, subtracts and measures', () => {
    const a = [
      { from: 0, to: 100 },
      { from: 200, to: 300 },
    ];
    const b = [
      { from: 50, to: 250 },
      { from: 280, to: 290 },
    ];
    expect(intersect(a, b)).toEqual([
      { from: 50, to: 100 },
      { from: 200, to: 250 },
      { from: 280, to: 290 },
    ]);
    expect(subtract(a, b)).toEqual([
      { from: 0, to: 50 },
      { from: 250, to: 280 },
      { from: 290, to: 300 },
    ]);
    expect(subtract([{ from: 0, to: 10 }], [{ from: 0, to: 10 }])).toEqual([]);
    expect(measure([...a, { from: 50, to: 60 }])).toBe(200);
  });

  it('keeps |a| = |a ∩ b| + |a − b|', () => {
    const arb = fc.array(
      fc
        .tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 200 }))
        .map(([from, length]) => ({
          from,
          to: from + length,
        })),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(arb, arb, (a, b) => {
        expect(measure(intersect(a, b)) + measure(subtract(a, b))).toBe(measure(a));
      }),
    );
  });
});

describe('deriveBottlenecks', () => {
  it('refuses an operation without a machine, a missing or invalid ideal time, an empty routing', () => {
    const equipment = [{ id: 'm1', operation: 'OP10' }];
    expect(() => deriveBottlenecks({ operations: [], equipment, idealCycleMs: {} })).toThrow(
      /no operations/,
    );
    expect(() =>
      deriveBottlenecks({ operations: ['OP10', 'OP20'], equipment, idealCycleMs: {} }),
    ).toThrow(/no machine runs OP20/);
    expect(() =>
      deriveBottlenecks({ operations: ['OP10'], equipment, idealCycleMs: { P: {} } }),
    ).toThrow(/no ideal cycle time for P at OP10/);
    expect(() =>
      deriveBottlenecks({ operations: ['OP10'], equipment, idealCycleMs: { P: { OP10: 0 } } }),
    ).toThrow(/positive integer/);
  });

  it('ignores machines of operations outside the routing', () => {
    const result = deriveBottlenecks({
      operations: ['OP10'],
      equipment: [
        { id: 'm1', operation: 'OP10' },
        { id: 'x', operation: 'OP99' },
      ],
      idealCycleMs: { P: { OP10: 1000, OP99: 99_000 } },
    });
    expect(result.P?.operation).toBe('OP10');
    expect(formatFraction(result.P?.effectiveCycleMs ?? fraction(0n))).toBe('1000/1');
  });
});

describe('headTimes and jobWindow', () => {
  it('prefers the accepted fact over acceptedAt, and the acceptance on a tie with the previous end', () => {
    const heads = headTimes([
      { id: 'a', accepted: 100, acceptedAt: 90, completed: 500 },
      { id: 'b', accepted: 500, completed: 900 },
    ]);
    expect(heads).toEqual([
      { kind: 'head', at: 100, source: 'accepted' },
      { kind: 'head', at: 500, source: 'accepted' },
    ]);
  });

  it('is unknown when a later job completed while the previous completion is missing', () => {
    expect(
      headTimes([
        { id: 'a', accepted: 0 },
        { id: 'b', accepted: 5, completed: 50 },
      ])[1],
    ).toEqual({
      kind: 'unknown',
      reason: 'previous-completed-missing',
    });
  });

  it('has no window before the head time, for a waiting job, or unknown without a start', () => {
    const job = { id: 'a', accepted: 100 };
    expect(jobWindow(job, { kind: 'head', at: 100, source: 'accepted' }, 99)).toBeUndefined();
    expect(jobWindow(job, { kind: 'waiting' }, 1000)).toBeUndefined();
    expect(jobWindow(job, { kind: 'unknown', reason: 'accepted-unknown' }, 1000)).toBeUndefined();
  });

  it('cuts a window at the cut-off when the job completes after it', () => {
    expect(
      jobWindow({ id: 'a', completed: 500 }, { kind: 'head', at: 100, source: 'accepted' }, 300),
    ).toEqual({
      from: 100,
      to: 300,
      open: true,
      headTimeUnknown: false,
      endLost: false,
      lost: false,
    });
  });

  it('closes a window whose completion is exactly the cut-off, and opens an empty one at it', () => {
    const head = { kind: 'head', at: 100, source: 'accepted' } as const;
    expect(jobWindow({ id: 'a', completed: 300 }, head, 300)).toMatchObject({
      to: 300,
      open: false,
    });
    expect(jobWindow({ id: 'a' }, head, 100)).toMatchObject({ from: 100, to: 100, open: true });
  });

  it('refuses a completion before the window starts, with the job named', () => {
    expect(() =>
      jobWindow({ id: 'J7', completed: 50 }, { kind: 'head', at: 100, source: 'accepted' }, 300),
    ).toThrow(/job J7: its completion \(50\) is before its window starts \(100\)/);
  });

  it('takes no completion from cycles unless the end is lost, the boundary closed and the count exact', () => {
    const closed = { id: 'b', started: 400 };
    expect(completionOf({ id: 'a', completedLost: true, quantity: 0 }, closed)).toBeUndefined();
    expect(completionOf({ id: 'a', quantity: 2, cycleEnds: [1, 2] }, closed)).toBeUndefined();
    expect(
      completionOf({ id: 'a', completedLost: true, quantity: 2, cycleEnds: [1, 2] }, { id: 'b' }),
    ).toBeUndefined();
    expect(completionOf({ id: 'a', completedLost: true, quantity: 2, cycleEnds: [1, 2] })).toBe(2);
    // More cycles than the quantity: someone else's are among them, so no completion (no throw).
    expect(
      completionOf({ id: 'a', completedLost: true, quantity: 2, cycleEnds: [1, 2, 3] }),
    ).toBeUndefined();
    // Unsorted cycle ends: the latest is the completion, not the last listed.
    expect(
      completionOf(
        { id: 'a', completedLost: true, quantity: 3, cycleEnds: [300, 100, 200] },
        closed,
      ),
    ).toBe(300);
  });

  it("(i) does not throw when the next job's cycles sit in this job's ends under reordering", () => {
    // J1's completed fact not received yet, J2's started not either: J2's cycle lands in J1's ends.
    const queue = [
      { id: 'J1', accepted: 0, started: 10, quantity: 2, cycleEnds: [100, 200, 300] },
      { id: 'J2', accepted: 5 },
    ];
    expect(
      jobWindows(queue, 1000, 'cnc-01').map(({ head, window }) => [head.kind, window?.open]),
    ).toEqual([
      ['head', true],
      ['waiting', undefined],
    ]);
  });

  it("(ii) does not throw forever when one gap took J1's last cycle, completed and J2's started", () => {
    const queue = [
      {
        id: 'J1',
        accepted: 0,
        started: 10,
        completedLost: true,
        quantity: 2,
        cycleEnds: [100, 200, 300],
      },
      { id: 'J2', accepted: 5, completed: 500 },
    ];
    const [first, second] = jobWindows(queue, 1000, 'cnc-01');
    expect(first?.window).toMatchObject({
      from: 0,
      to: 1000,
      open: true,
      endLost: true,
      lost: true,
    });
    expect(second?.head).toEqual({ kind: 'unknown', reason: 'previous-completed-lost' });
    expect(second?.window).toBeUndefined();
  });

  it('(iii) flags a window lost instead of closing it on a cycle of the next job', () => {
    // J1 quantity 2: one of its cycles (100) and one of J2's (350), J2's started missing.
    const queue = [
      {
        id: 'J1',
        accepted: 0,
        started: 10,
        completedLost: true,
        quantity: 2,
        cycleEnds: [100, 350],
      },
      { id: 'J2', accepted: 5 },
    ];
    expect(jobWindows(queue, 1000, 'cnc-01')[0]?.window).toMatchObject({
      to: 1000,
      endLost: true,
      lost: true,
    });
  });

  it("recovers the end from the cycles once the next job's started fact closes the boundary", () => {
    const queue = [
      {
        id: 'J1',
        accepted: 0,
        started: 10,
        completedLost: true,
        quantity: 2,
        cycleEnds: [200, 100],
      },
      { id: 'J2', accepted: 5, started: 260, completed: 500 },
    ];
    const [first, second] = jobWindows(queue, 1000, 'cnc-01');
    expect(first?.window).toMatchObject({
      from: 0,
      to: 200,
      open: false,
      endLost: false,
      lost: false,
    });
    expect(second?.head).toEqual({ kind: 'head', at: 200, source: 'previous-last-cycle' });
  });

  it('refuses a queue job on another CNC, and accepts jobs without a machine', () => {
    const queue = [
      { id: 'J1', machine: 'cnc-01', accepted: 0, completed: 10 },
      { id: 'J2', accepted: 5 },
    ];
    expect(jobWindows(queue, 100, 'cnc-01')).toHaveLength(2);
    expect(() => jobWindows(queue, 100, 'cnc-02')).toThrow(
      /job J1 is on cnc-01, not in the queue of cnc-02/,
    );
  });

  it('refuses a next job on another CNC', () => {
    expect(() =>
      jobWindow(
        { id: 'J1', machine: 'cnc-01', completedLost: true },
        { kind: 'head', at: 0, source: 'accepted' },
        100,
        { id: 'J9', machine: 'cnc-02', started: 50 },
      ),
    ).toThrow(/J9 is on cnc-02, not the same CNC/);
  });

  it('does not cap a lost end at a next start before the window', () => {
    expect(
      jobWindow(
        { id: 'J1', completedLost: true },
        { kind: 'head', at: 500, source: 'accepted' },
        1000,
        { id: 'J2', started: 400 },
      ),
    ).toMatchObject({ from: 500, to: 1000, open: true, endLost: true });
  });

  it('caps a lost end at the next start only when it lies in the window and the cut-off', () => {
    const head = { kind: 'head', at: 100, source: 'accepted' } as const;
    const job = { id: 'a', completedLost: true };
    expect(jobWindow(job, head, 300, { id: 'b', started: 400 })).toMatchObject({
      to: 300,
      open: true,
      endLost: true,
      lost: true,
    });
    expect(jobWindow(job, head, 300, { id: 'b', started: 200 })).toMatchObject({
      to: 200,
      open: false,
      lost: true,
    });
  });

  it('keeps a transient unknown head time apart from a lost one', () => {
    const job = { id: 'a', started: 10, completed: 20 };
    expect(
      jobWindow(job, { kind: 'unknown', reason: 'previous-completed-missing' }, 30),
    ).toMatchObject({
      headTimeUnknown: true,
      headUnknownReason: 'previous-completed-missing',
      lost: false,
    });
    expect(jobWindow(job, { kind: 'unknown', reason: 'accepted-lost' }, 30)).toMatchObject({
      lost: true,
    });
  });
});

describe('windowInputs', () => {
  const intervals: TimelineInterval[] = [
    { from: 0, to: 2 * HOUR, state: 'Running', cause: null },
    // A 3-minute stop the window cuts to 1 minute: still availability loss (whole length).
    { from: 2 * HOUR, to: 2 * HOUR + 3 * MIN, state: 'Stopped', cause: 'JAM' },
    { from: 2 * HOUR + 3 * MIN, to: 3 * HOUR, state: 'Idle', cause: 'NO-ORDER', open: true },
  ];

  it('splits a window into its scheduled and unscheduled parts, cycles by their time', () => {
    const parts = windowInputs({
      window: { from: HOUR, to: 2 * HOUR + MIN },
      intervals,
      scheduled: [{ from: 0, to: 90 * MIN }],
      cycles: [
        { product: 'P', result: 'good', count: 5, at: 80 * MIN },
        { product: 'P', result: 'good', count: 3, at: 2 * HOUR },
      ],
      operation: 'OP10',
      idealCycleMs: { P: { OP10: 6 * MIN } },
    });
    expect(parts).toEqual([
      {
        scheduled: true,
        stateMs: { Running: 30 * MIN },
        stops: [],
        cycles: [{ product: 'P', result: 'good', count: 5 }],
        operation: 'OP10',
        idealCycleMs: { P: { OP10: 6 * MIN } },
      },
      {
        scheduled: false,
        stateMs: { Running: 30 * MIN, Stopped: MIN },
        stops: [{ ms: MIN, wholeMs: 3 * MIN, open: false }],
        cycles: [{ product: 'P', result: 'good', count: 3 }],
        operation: 'OP10',
        idealCycleMs: { P: { OP10: 6 * MIN } },
      },
    ]);
  });

  it('keeps an open Stopped interval open inside a window, a provisional micro-stop', () => {
    const parts = windowInputs({
      window: { from: 0, to: HOUR },
      intervals: [
        { from: 0, to: HOUR - MIN, state: 'Running', cause: null },
        { from: HOUR - MIN, to: HOUR, state: 'Stopped', cause: 'JAM', open: true },
      ],
      scheduled: [{ from: 0, to: HOUR }],
      cycles: [],
      operation: 'OP10',
      idealCycleMs: {},
    });
    expect(parts[0]?.stops).toEqual([{ ms: MIN, wholeMs: MIN, open: true }]);
    const totals = orderOee(
      {
        jobs: [
          {
            id: 'a',
            window: {
              from: 0,
              to: HOUR,
              open: false,
              headTimeUnknown: false,
              endLost: false,
              lost: false,
            },
            intervals: [
              { from: 0, to: HOUR - MIN, state: 'Running', cause: null },
              { from: HOUR - MIN, to: HOUR, state: 'Stopped', cause: 'JAM', open: true },
            ],
            cycles: [],
            operation: 'OP10',
          },
        ],
        scheduled: [{ from: 0, to: HOUR }],
        idealCycleMs: {},
      },
      CONFIG,
    );
    expect(totals.order.provisional).toBe(true);
    expect(totals.order.totals.microStopMs).toBe(BigInt(MIN));
  });

  it("puts a cycle exactly at a scheduled range's start in the scheduled part", () => {
    const parts = windowInputs({
      window: { from: 0, to: 2 * HOUR },
      intervals: [{ from: 0, to: 2 * HOUR, state: 'Running', cause: null }],
      scheduled: [{ from: HOUR, to: 2 * HOUR }],
      cycles: [{ product: 'P', result: 'good', count: 4, at: HOUR }],
      operation: 'OP10',
      idealCycleMs: { P: { OP10: MIN } },
    });
    expect(parts.find((part) => part.scheduled)?.cycles).toEqual([
      { product: 'P', result: 'good', count: 4 },
    ]);
  });

  it('puts a cycle exactly at the shift end in the unscheduled part', () => {
    const parts = windowInputs({
      window: { from: 0, to: 2 * HOUR },
      intervals: [{ from: 0, to: 2 * HOUR, state: 'Running', cause: null }],
      scheduled: [{ from: 0, to: HOUR }],
      cycles: [
        { product: 'P', result: 'good', count: 1, at: HOUR - 1 },
        { product: 'P', result: 'good', count: 2, at: HOUR },
      ],
      operation: 'OP10',
      idealCycleMs: { P: { OP10: MIN } },
    });
    expect(parts.map((part) => [part.scheduled, part.cycles[0]?.count])).toEqual([
      [true, 1],
      [false, 2],
    ]);
  });

  it('counts Idle NO-ORDER inside a window and leaves out an empty part', () => {
    const parts = windowInputs({
      window: { from: 2 * HOUR + 3 * MIN, to: 3 * HOUR },
      intervals,
      scheduled: [{ from: 0, to: 24 * HOUR }],
      cycles: [],
      operation: 'OP10',
      idealCycleMs: {},
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]?.noOrderIdleMs).toBe(57 * MIN);
  });
});

describe('orderOee', () => {
  it('gives a job without a window null and an order without any window no OEE', () => {
    const result = orderOee(
      {
        jobs: [{ id: 'a', window: undefined, intervals: [], cycles: [], operation: 'OP10' }],
        scheduled: [],
        idealCycleMs: {},
      },
      CONFIG,
    );
    expect(result.jobs).toEqual({ a: null });
    expect(result.order.oee).toBeNull();
    // A job without a window leaves the order pending, so it is provisional, not complete.
    expect(result.pending).toBe(true);
    expect(result.order.provisional).toBe(true);
  });

  it("marks a job and its order provisional when the job's end is lost", () => {
    const result = orderOee(
      {
        jobs: [
          {
            id: 'a',
            window: {
              from: 0,
              to: HOUR,
              open: false,
              headTimeUnknown: false,
              endLost: true,
              lost: true,
            },
            intervals: [{ from: 0, to: HOUR, state: 'Running', cause: null }],
            cycles: [],
            operation: 'OP10',
          },
        ],
        scheduled: [{ from: 0, to: HOUR }],
        idealCycleMs: {},
      },
      CONFIG,
    );
    expect(result.jobs.a?.provisional).toBe(true);
    expect(result.order.provisional).toBe(true);
    expect([result.endLost, result.lost]).toEqual([true, true]);
  });

  it('marks a job provisional with its own open window or unknown head time', () => {
    const result = orderOee(
      {
        jobs: [
          {
            id: 'a',
            window: {
              from: 0,
              to: HOUR,
              open: false,
              headTimeUnknown: true,
              endLost: false,
              lost: false,
            },
            intervals: [{ from: 0, to: HOUR, state: 'Running', cause: null }],
            cycles: [{ product: 'P', result: 'good', count: 10, at: HOUR - 1 }],
            operation: 'OP10',
          },
          {
            id: 'b',
            window: {
              from: 0,
              to: HOUR,
              open: false,
              headTimeUnknown: false,
              endLost: false,
              lost: false,
            },
            intervals: [{ from: 0, to: HOUR, state: 'Running', cause: null }],
            cycles: [],
            operation: 'OP10',
          },
        ],
        scheduled: [{ from: 0, to: HOUR }],
        idealCycleMs: { P: { OP10: 6 * MIN } },
      },
      CONFIG,
    );
    expect(result.jobs.a?.provisional).toBe(true);
    expect(result.jobs.b?.provisional).toBe(false);
    expect(result.order.provisional).toBe(true);
    expect(result.lost).toBe(false);
    expect(formatFraction(result.order.oee ?? fraction(9n))).toBe('1/2');
  });
});

describe('firstPassYield', () => {
  it('is null with nothing started, and refuses bad counts and results', () => {
    expect(firstPassYield({ started: 0, units: [], lastOperation: 'OP50' }).yield).toBeNull();
    expect(() => firstPassYield({ started: -1, units: [], lastOperation: 'OP50' })).toThrow(
      /non-negative/,
    );
    const packed = { records: [{ operation: 'OP50', result: 'good' as const }] };
    expect(() => firstPassYield({ started: 0, units: [packed], lastOperation: 'OP50' })).toThrow(
      /1 units packed good/,
    );
    expect(() =>
      firstPassYield({
        started: 1,
        units: [{ records: [{ operation: 'OP50', result: 'bad' as never }] }],
        lastOperation: 'OP50',
      }),
    ).toThrow(/unknown cycle result/);
  });

  it('does not count a unit still on its way', () => {
    const unit = { records: [{ operation: 'OP10', result: 'good' as const }] };
    expect(firstPassYield({ started: 1, units: [unit], lastOperation: 'OP50' }).firstPassGood).toBe(
      0n,
    );
  });
});

describe('lineOee', () => {
  const cycles = { A: fraction(150_000n), B: fraction(500_000n, 3n) };

  it('refuses a product without a bottleneck cycle and bad counts', () => {
    expect(() =>
      lineOee({ plannedBusyMs: 1, good: [{ product: 'X', count: 1 }], effectiveCycleMs: cycles }),
    ).toThrow(/no bottleneck cycle for X/);
    expect(() => lineOee({ plannedBusyMs: -1, good: [], effectiveCycleMs: cycles })).toThrow(
      /non-negative/,
    );
  });

  it('adds fractions with non-unit denominators exactly', () => {
    expect(formatFraction(add(fraction(1n, 2n), fraction(1n, 3n)))).toBe('5/6');
  });

  it('sums two products whose effective cycles are both fractional', () => {
    const result = lineOee({
      plannedBusyMs: 1_000_000,
      good: [
        { product: 'B', count: 1 },
        { product: 'C', count: 1 },
      ],
      effectiveCycleMs: { B: fraction(500_000n, 3n), C: fraction(250_000n, 2n * 3n + 1n) },
    });
    // 500000/3 + 250000/7 = (3 500 000 + 750 000) / 21 = 4250000/21
    expect(formatFraction(result.idealMs)).toBe('4250000/21');
    expect(formatFraction(result.oee ?? fraction(0n))).toBe('17/84');
  });

  it('keeps a fractional effective cycle exact', () => {
    const result = lineOee({
      plannedBusyMs: 1_000_000,
      good: [{ product: 'B', count: 2 }],
      effectiveCycleMs: cycles,
    });
    expect(formatFraction(result.idealMs)).toBe('1000000/3');
    expect(formatFraction(result.oee ?? fraction(0n))).toBe('1/3');
    expect(result.aboveOne).toBe(false);
  });

  it('hours of a shift sum to the shift: planned busy time and ideal time are additive', () => {
    const shift = { from: 6 * HOUR, to: 14 * HOUR };
    const arbRanges = fc.array(
      fc
        .tuple(fc.integer({ min: 5 * 60, max: 15 * 60 }), fc.integer({ min: 0, max: 120 }))
        .map(([from, length]) => ({ from: from * MIN, to: (from + length) * MIN })),
      { maxLength: 5 },
    );
    fc.assert(
      fc.property(
        arbRanges,
        arbRanges,
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 8, maxLength: 8 }),
        (plannedStops, inProgress, packed) => {
          const common = { scheduled: [shift], plannedStops, inProgress };
          const hours = packed.map((count, i) => {
            const bucket = { from: shift.from + i * HOUR, to: shift.from + (i + 1) * HOUR };
            return lineOee({
              plannedBusyMs: linePlannedBusyMs({ ...common, bucket }),
              good: [{ product: 'A', count }],
              effectiveCycleMs: cycles,
            });
          });
          const whole = lineOee({
            plannedBusyMs: linePlannedBusyMs({ ...common, bucket: shift }),
            good: [{ product: 'A', count: packed.reduce((sum, n) => sum + n, 0) }],
            effectiveCycleMs: cycles,
          });
          expect(hours.reduce((sum, h) => sum + h.plannedBusyMs, 0n)).toBe(whole.plannedBusyMs);
          expect(hours.reduce((sum, h) => add(sum, h.idealMs), fraction(0n))).toEqual(
            whole.idealMs,
          );
        },
      ),
    );
  });
});
