import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compare, fraction, multiply, type Fraction } from './fraction.ts';
import { HOUR, hourCuts, splitAt, type StateInterval } from './intervals.ts';
import {
  CYCLE_RESULTS,
  OEE_STATES,
  bucketOee,
  bucketTotals,
  oeeFromTotals,
  sumTotals,
  type BucketInput,
  type CycleCount,
  type OeeConfig,
  type OeeState,
} from './oee.ts';

const CONFIG: OeeConfig = { microStopThresholdMs: 120_000, scheduledTime: 'shift-calendar' };
const IDEAL = { 'VB-100': { OP10: 240_000 }, 'VB-200': { OP10: 330_000 } };

const input = (overrides: Partial<BucketInput>): BucketInput => ({
  scheduled: true,
  stateMs: {},
  stops: [],
  cycles: [],
  operation: 'OP10',
  idealCycleMs: IDEAL,
  ...overrides,
});

describe('bucket inputs', () => {
  it.each<[string, Partial<BucketInput>, RegExp]>([
    ['a fractional state time', { stateMs: { Running: 0.5 } }, /Running time must be/],
    ['a negative state time', { stateMs: { Idle: -1 } }, /Idle time must be/],
    [
      'an unknown state',
      { stateMs: { Sleeping: 1 } as Partial<Record<OeeState, number>> },
      /unknown state/,
    ],
    [
      'stops that do not sum to Stopped time',
      { stateMs: { Stopped: 10 }, stops: [{ ms: 9, wholeMs: 9 }] },
      /stop pieces sum to 9 ms but Stopped time is 10 ms/,
    ],
    [
      'a piece longer than its interval',
      { stateMs: { Stopped: 10 }, stops: [{ ms: 10, wholeMs: 9 }] },
      /longer than its interval/,
    ],
    [
      'a product without an ideal cycle time',
      { cycles: [{ product: 'VB-300', result: 'good', count: 1 }] },
      /no ideal cycle time for VB-300 at OP10/,
    ],
    [
      'an unknown cycle result',
      { cycles: [{ product: 'VB-100', result: 'fine' } as unknown as CycleCount] },
      /unknown cycle result "fine"/,
    ],
    [
      'a fractional count',
      { cycles: [{ product: 'VB-100', result: 'good', count: 1.5 }] },
      /VB-100 good count/,
    ],
  ])('refuses %s', (_case, overrides, message) => {
    expect(() => bucketTotals(input(overrides), CONFIG)).toThrow(message);
  });

  it('refuses a threshold that is not a positive integer', () => {
    expect(() => bucketTotals(input({}), { ...CONFIG, microStopThresholdMs: 0.5 })).toThrow(
      /microStopThresholdMs/,
    );
  });

  it('keeps a long open stop final: it can only grow', () => {
    const totals = bucketTotals(
      input({
        stateMs: { Stopped: 130_000 },
        stops: [{ ms: 130_000, wholeMs: 130_000, open: true }],
      }),
      CONFIG,
    );
    expect(totals.provisional).toBe(false);
    expect(totals.longStopMs).toBe(130_000n);
  });

  it('never counts Down as a micro-stop, however short', () => {
    const result = bucketOee(input({ stateMs: { Running: 3_599_000, Down: 1_000 } }), CONFIG);
    expect(result.losses?.availability.own.down).toBe(1_000n);
    expect(result.losses?.performance.microStops).toBe(0n);
  });

  it('reports every own and external loss and the quality loss in ideal time', () => {
    const result = bucketOee(
      input({
        stateMs: {
          Running: 1_000_000,
          Stopped: 600_000,
          Down: 400_000,
          Setup: 300_000,
          Idle: 200_000,
          Starved: 100_000,
          Blocked: 50_000,
          PlannedStop: 950_000,
        },
        stops: [
          { ms: 500_000, wholeMs: 500_000 },
          { ms: 100_000, wholeMs: 100_000 },
        ],
        cycles: [
          { product: 'VB-100', result: 'good', count: 2 },
          { product: 'VB-100', result: 'scrap', count: 1 },
        ],
      }),
      CONFIG,
    );
    expect(result.losses?.availability).toEqual({
      own: {
        stopped: 500_000n,
        down: 400_000n,
        setup: 300_000n,
        idle: 200_000n,
        total: 1_400_000n,
      },
      external: { starved: 100_000n, blocked: 50_000n, total: 150_000n },
    });
    expect(result.totals.excludedMs).toBe(950_000n);
    expect(result.losses?.quality).toEqual(fraction(240_000n)); // one scrap part of 240 s
  });
});

describe('unscheduled buckets', () => {
  it('have no planned busy time and no losses; their cycles are reported as unplanned', () => {
    const result = bucketOee(
      input({
        scheduled: false,
        stateMs: { Running: 3_000_000, Idle: 600_000 },
        cycles: [
          { product: 'VB-100', result: 'good', count: 2 },
          { product: 'VB-200', result: 'rework', count: 1 },
        ],
      }),
      CONFIG,
    );
    expect(result.totals.plannedBusyMs).toBe(0n);
    expect(result.totals.excludedMs).toBe(3_600_000n);
    expect([result.availability, result.performance, result.quality, result.oee]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(result.anomaly).toBe(false);
    expect(result.losses).toBeNull();
    expect([result.totals.idealMs, result.totals.good, result.totals.produced]).toEqual([
      0n,
      0n,
      0n,
    ]);
    expect(result.totals.unplanned).toEqual({ good: 2n, produced: 3n, idealMs: 810_000n });
  });

  it('keep a day sum over shift and no-shift buckets equal to the shift alone, but for unplanned cycles', () => {
    const shift = bucketTotals(
      input({
        stateMs: { Running: 3_600_000 },
        cycles: [{ product: 'VB-100', result: 'good', count: 14 }],
      }),
      CONFIG,
    );
    const offShift = bucketTotals(
      input({
        scheduled: false,
        stateMs: { Running: 3_600_000 },
        cycles: [{ product: 'VB-100', result: 'good', count: 15 }],
      }),
      CONFIG,
    );
    const day = oeeFromTotals(sumTotals([shift, offShift]));
    const alone = oeeFromTotals(shift);
    expect([day.availability, day.performance, day.quality, day.oee]).toEqual([
      alone.availability,
      alone.performance,
      alone.quality,
      alone.oee,
    ]);
    expect(day.losses).toEqual(alone.losses);
    expect(day.totals.unplanned).toEqual({ good: 15n, produced: 15n, idealMs: 3_600_000n });
  });

  it('a scheduled bucket with no planned busy time has no losses either', () => {
    const result = bucketOee(input({ stateMs: { PlannedStop: 3_600_000 } }), CONFIG);
    expect(result.losses).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Properties (plan section 9, ADR-0021)

const ms = fc.integer({ min: 0, max: HOUR });

const stopsArb = fc.array(
  fc
    .tuple(fc.integer({ min: 1, max: 400_000 }), fc.integer({ min: 0, max: 400_000 }), fc.boolean())
    .map(([piece, extra, open]) => ({ ms: piece, wholeMs: piece + extra, open })),
  { maxLength: 5 },
);

const cyclesArb = fc.array(
  fc.record({
    product: fc.constantFrom('VB-100', 'VB-200'),
    result: fc.constantFrom(...CYCLE_RESULTS),
    count: fc.integer({ min: 0, max: 40 }),
  }),
  { maxLength: 4 },
);

const inputArb: fc.Arbitrary<BucketInput> = fc
  .record({
    scheduled: fc.boolean(),
    states: fc.dictionary(fc.constantFrom(...OEE_STATES.filter((s) => s !== 'Stopped')), ms),
    stops: stopsArb,
    cycles: cyclesArb,
  })
  .map(({ scheduled, states, stops, cycles }) =>
    input({
      scheduled,
      stateMs: { ...states, Stopped: stops.reduce((sum, stop) => sum + stop.ms, 0) },
      stops,
      cycles,
    }),
  );

const between = (value: Fraction, low: Fraction, high: Fraction): boolean =>
  compare(value, low) >= 0 && compare(value, high) <= 0;

describe('properties', () => {
  it('A and Q lie in [0, 1], P ≥ 0, and OEE = A·P·Q wherever all three are defined', () => {
    fc.assert(
      fc.property(fc.array(inputArb, { minLength: 1, maxLength: 3 }), (inputs) => {
        const result = oeeFromTotals(sumTotals(inputs.map((i) => bucketTotals(i, CONFIG))));
        const { availability: a, performance: p, quality: q, oee } = result;
        if (a !== null) expect(between(a, fraction(0n), fraction(1n))).toBe(true);
        if (q !== null) expect(between(q, fraction(0n), fraction(1n))).toBe(true);
        if (p !== null) expect(compare(p, fraction(0n))).toBeGreaterThanOrEqual(0);
        if (oee !== null) expect(compare(oee, fraction(0n))).toBeGreaterThanOrEqual(0);
        if (a !== null && p !== null && q !== null) {
          expect(oee).toEqual(multiply(multiply(a, p), q));
        }
        if (result.totals.plannedBusyMs === 0n) {
          expect([a, p, q, oee]).toEqual([null, null, null, null]);
        }
        expect(result.anomaly).toBe(
          result.totals.plannedBusyMs > 0n &&
            result.totals.actualProductionMs === 0n &&
            result.totals.produced > 0n,
        );
      }),
    );
  });

  it('losses account for every millisecond: PBT = APT + own + external, APT = micro + speed + ideal', () => {
    fc.assert(
      fc.property(inputArb, (bucket) => {
        const { totals, losses, oee } = bucketOee(bucket, CONFIG);
        if (losses === null) {
          expect(totals.plannedBusyMs).toBe(0n);
          return;
        }
        const elapsed = OEE_STATES.reduce((sum, s) => sum + totals.stateMs[s], 0n);
        expect(totals.plannedBusyMs + totals.excludedMs).toBe(elapsed);
        expect(
          totals.actualProductionMs +
            losses.availability.own.total +
            losses.availability.external.total,
        ).toBe(totals.plannedBusyMs);
        expect(losses.performance.microStops + losses.performance.speed + totals.idealMs).toBe(
          totals.actualProductionMs,
        );
        if (oee !== null && totals.produced > 0n) {
          // The waterfall closes: ideal time − quality loss = OEE × PBT.
          expect(
            fraction(totals.idealMs * losses.quality.den - losses.quality.num, losses.quality.den),
          ).toEqual(multiply(oee, fraction(totals.plannedBusyMs)));
        }
      }),
    );
  });

  // A shift of eight hours from a whole hour, as states and stops on a timeline.
  const SHIFT_START = Date.UTC(2026, 9, 12, 3);
  const SHIFT_END = SHIFT_START + 8 * HOUR;

  const timelineArb = fc
    .array(
      fc.tuple(fc.constantFrom(...OEE_STATES), fc.integer({ min: 1, max: 2 * HOUR }), fc.boolean()),
      { minLength: 1, maxLength: 40 },
    )
    .map((segments) => {
      const intervals: (StateInterval<OeeState> & { open: boolean })[] = [];
      let from = SHIFT_START;
      for (const [state, length, open] of segments) {
        const to = Math.min(from + length, SHIFT_END);
        if (to > from) intervals.push({ from, to, state, cause: null, open });
        from = to;
      }
      const last = intervals.at(-1);
      if (last && from < SHIFT_END) intervals[intervals.length - 1] = { ...last, to: SHIFT_END };
      return intervals;
    });

  const cycleTimesArb = fc.array(
    fc.record({
      at: fc.integer({ min: SHIFT_START, max: SHIFT_END - 1 }),
      product: fc.constantFrom('VB-100', 'VB-200'),
      result: fc.constantFrom(...CYCLE_RESULTS),
    }),
    { maxLength: 60 },
  );

  function bucketOf(
    intervals: readonly (StateInterval<OeeState> & { open: boolean })[],
    cycles: readonly { at: number; product: string; result: CycleCount['result'] }[],
    from: number,
    to: number,
  ): BucketInput {
    const stateMs: Partial<Record<OeeState, number>> = {};
    const stops = [];
    for (const interval of intervals) {
      const lastInterval = interval === intervals.at(-1);
      for (const piece of splitAt(interval, [from, to])) {
        if (piece.from < from || piece.to > to) continue;
        stateMs[piece.state] = (stateMs[piece.state] ?? 0) + piece.to - piece.from;
        if (piece.state === 'Stopped') {
          stops.push({
            ms: piece.to - piece.from,
            wholeMs: interval.to - interval.from,
            open: lastInterval && interval.open,
          });
        }
      }
    }
    const counts = new Map<string, CycleCount>();
    for (const cycle of cycles.filter((c) => c.at >= from && c.at < to)) {
      const key = `${cycle.product} ${cycle.result}`;
      const count = (counts.get(key)?.count ?? 0) + 1;
      counts.set(key, { product: cycle.product, result: cycle.result, count });
    }
    return input({ stateMs, stops, cycles: [...counts.values()] });
  }

  it('hour buckets sum to the shift bucket, pieces credited to their own hour', () => {
    fc.assert(
      fc.property(timelineArb, cycleTimesArb, (intervals, cycles) => {
        const hours = [SHIFT_START, ...hourCuts(SHIFT_START, SHIFT_END), SHIFT_END];
        const hourly = hours
          .slice(0, -1)
          .map((from, i) =>
            bucketTotals(bucketOf(intervals, cycles, from, hours[i + 1] ?? SHIFT_END), CONFIG),
          );
        const shift = bucketTotals(bucketOf(intervals, cycles, SHIFT_START, SHIFT_END), CONFIG);
        expect(sumTotals(hourly)).toEqual(shift);
        const elapsed = OEE_STATES.reduce((sum, s) => sum + shift.stateMs[s], 0n);
        expect(elapsed).toBe(BigInt(SHIFT_END - SHIFT_START));
      }),
    );
  });
});
