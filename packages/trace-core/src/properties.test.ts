/**
 * Property tests of the time cut (Phase 8 plan, exit criterion 5). fast-check prints the seed and
 * path of a failure; rerun one with `fc.assert(…, { seed, path })`.
 *
 * - cutting twice is cutting at the earlier time, and a cut after the last record changes nothing;
 * - a carton as of T holds a prefix of its final members, and one closed by T is final;
 * - an SPC episode closed by T is final, and one open at T is the start of a final episode.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONFIG, at, unit, type UnitPlan } from './fixtures.test-support.ts';
import { unitId } from './packing.ts';
import { buildTrace, traceAsOf, type Trace, type TraceInput } from './trace.ts';

const ORDERS = [
  { orderId: 'ORD-A', product: 'VB-100' },
  { orderId: 'ORD-B', product: 'VB-200' },
  { orderId: 'ORD-C', product: 'VB-100' },
] as const;

const planArb = fc.record({
  gap: fc.integer({ min: 0, max: 6 }),
  order: fc.integer({ min: 0, max: 3 }),
  blank: fc.constantFrom('BL-1', 'BL-2', 'BL-3'),
  kit: fc.constantFrom('SK-1A', 'SK-1B'),
  reading: fc.oneof(
    { weight: 5, arbitrary: fc.integer({ min: 1990, max: 2010 }) },
    { weight: 1, arbitrary: fc.integer({ min: 1900, max: 2400 }) },
  ),
  rework: fc.option(fc.integer({ min: 1900, max: 2100 }), { freq: 6, nil: undefined }),
  scrap: fc.boolean(),
  upTo: fc.option(fc.integer({ min: 1, max: 4 }), { freq: 5, nil: undefined }),
  epochBreak: fc.integer({ min: 0, max: 25 }),
});

const inputArb: fc.Arbitrary<TraceInput> = fc
  .tuple(
    fc.array(planArb, { maxLength: 40, size: 'max' }),
    fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  )
  .map(([plans, completes]) => {
    let start = 0;
    let epoch = 1;
    const units = plans.map((p, i) => {
      start += p.gap;
      if (p.epochBreak === 0) epoch += 1;
      const order = ORDERS[p.order];
      const plan: UnitPlan = {
        partId: i + 1,
        epoch,
        start,
        orderId: order?.orderId ?? null,
        product: order?.product ?? 'VB-100',
        blank: p.blank,
        kit: p.kit,
        reading: p.reading,
        scrap: p.scrap && p.rework === undefined,
        ...(p.rework === undefined ? {} : { rework: { kit: 'SK-1C', retest: p.rework } }),
        ...(p.upTo === undefined ? {} : { upTo: p.upTo }),
      };
      return unit(plan);
    });
    const lastRecord = (orderId: string): number =>
      units
        .filter((u) => u.orderId === orderId)
        .flatMap((u) => u.records.map((r) => r.at))
        .reduce((a, b) => (b > a ? b : a), 0);
    return {
      config: CONFIG,
      units,
      orders: ORDERS.map((o, i) => ({
        ...o,
        completedAt: completes[i] === true ? lastRecord(o.orderId) + at(1) : null,
      })),
    };
  });

const cutArb = fc.integer({ min: 0, max: 300 }).map(at);

const end = (trace: Trace): number =>
  trace.units.flatMap((u) => u.records.map((r) => r.at)).reduce((a, b) => (b > a ? b : a), 0);

const episodeId = (e: Trace['spc']['chart']['episodes'][number]): string =>
  `${e.chart}/${String(e.rule)}/${String(e.version)}/${e.key}`;

describe('traceAsOf properties', () => {
  it('cuts twice as once, at the earlier time', () => {
    fc.assert(
      fc.property(inputArb, cutArb, cutArb, (input, t1, t2) => {
        const trace = buildTrace(input);
        expect(traceAsOf(traceAsOf(trace, t1), t2)).toEqual(traceAsOf(trace, Math.min(t1, t2)));
      }),
    );
  });

  it('changes nothing after the last record and its orders', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const trace = buildTrace(input);
        expect(traceAsOf(trace, end(trace) + at(10))).toEqual(trace);
      }),
    );
  });

  it('keeps cartons and episodes consistent with the final trace', () => {
    fc.assert(
      fc.property(inputArb, cutArb, (input, t) => {
        const trace = buildTrace(input);
        const cut = traceAsOf(trace, t);
        const finalCartons = new Map(trace.cartons.map((c) => [c.id, c]));
        for (const carton of cut.cartons) {
          const final = finalCartons.get(carton.id);
          expect(final?.members.slice(0, carton.members.length).map(unitId)).toEqual(
            carton.members.map(unitId),
          );
          if (carton.status === 'closed') expect(final).toEqual(carton);
        }
        const finalEpisodes = new Map(trace.spc.chart.episodes.map((e) => [episodeId(e), e]));
        for (const episode of cut.spc.chart.episodes) {
          const final = finalEpisodes.get(episodeId(episode));
          if (episode.closedBy === null) {
            expect(final?.points).toBeGreaterThanOrEqual(episode.points);
          } else {
            expect(final).toEqual(episode);
          }
        }
      }),
    );
  });
});
