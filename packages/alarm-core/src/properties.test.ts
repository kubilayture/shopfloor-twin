/**
 * Property tests (Phase 6 plan): Σ hours = shift for every additive measure and the composed
 * ones, `peak10` ≥ any window, flood time ≤ bucket length, and the flood episodes agree with a
 * brute-force count of the window at every instant.
 */
import { compare } from '@shopfloor/oee-core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { composeBuckets, hoursOf, kpisOfBucket } from './buckets.ts';
import { floodEpisodes } from './floods.ts';
import { HOUR, PRIORITIES, prepare, type AlarmKpiConfig, type Occurrence } from './occurrences.ts';

const CONFIG: AlarmKpiConfig = {
  floodThreshold: 10,
  windowMs: 600_000,
  chatterCount: 3,
  chatterWindowMs: 60_000,
  fleetingMs: 1_000,
  standingMs: 86_400_000,
};

const START = Date.UTC(2026, 9, 12, 3);
const SPAN = 4 * HOUR;
const POINTS = ['cnc-01/A', 'cnc-01/B', 'cnc-02/A', 'wsh-01/C'];

/** Bursty raises: many within minutes, so floods, chattering and same-ms ties are common. */
const occurrencesArb = fc
  .array(
    fc.record({
      point: fc.constantFrom(...POINTS),
      priority: fc.constantFrom(...PRIORITIES),
      burst: fc.integer({ min: 0, max: 4 }),
      offset: fc.integer({ min: 0, max: 400_000 }),
      sameMs: fc.boolean(),
      clearAfter: fc.option(fc.integer({ min: 0, max: 2 * HOUR }), { nil: null }),
    }),
    { minLength: 10, maxLength: 120, size: 'max' },
  )
  .map((items) =>
    items.map((item, seq): Occurrence => {
      const [equipment = '', code = ''] = item.point.split('/');
      const raisedAt = START + item.burst * 3_000_000 + (item.sameMs ? 0 : item.offset);
      return {
        equipment,
        code,
        priority: item.priority,
        seq,
        raisedAt,
        clearedAt: item.clearAfter === null ? null : raisedAt + item.clearAfter,
      };
    }),
  );

const horizonArb = fc.record({
  asOf: fc.integer({ min: START, max: START + SPAN + HOUR }),
  closed: fc.boolean(),
});

describe('alarm-core properties', () => {
  it('composes a multi-hour bucket exactly from its hours', () => {
    fc.assert(
      fc.property(occurrencesArb, horizonArb, (occurrences, { asOf, closed }) => {
        const lastRaise = occurrences.reduce(
          (max, o) => Math.max(max, o.raisedAt, o.clearedAt ?? 0),
          0,
        );
        const horizon = closed ? { asOf, closedAt: Math.max(asOf, lastRaise) } : { asOf };
        const set = prepare(occurrences, horizon, CONFIG);
        const episodes = floodEpisodes(set);
        const shift = { from: START, to: START + SPAN };
        const direct = kpisOfBucket(set, episodes, shift);
        const hours = hoursOf(shift).map((hour) => kpisOfBucket(set, episodes, hour));
        const composed = composeBuckets(hours, CONFIG);
        expect(compare(composed.averageRate, direct.averageRate)).toBe(0);
        expect({ ...composed, averageRate: null }).toEqual({ ...direct, averageRate: null });
      }),
      { numRuns: 300 },
    );
  });

  it('keeps peak10 at or above every window and flood time within the bucket', () => {
    fc.assert(
      fc.property(occurrencesArb, horizonArb, (occurrences, { asOf }) => {
        const set = prepare(occurrences, { asOf }, CONFIG);
        const episodes = floodEpisodes(set);
        for (const hour of hoursOf({ from: START, to: START + SPAN })) {
          const kpis = kpisOfBucket(set, episodes, hour);
          for (let w = hour.from; w < hour.to; w += CONFIG.windowMs) {
            const count = set.occurrences.filter(
              (o) => o.raisedAt >= w && o.raisedAt < w + CONFIG.windowMs,
            ).length;
            expect(kpis.peak10).toBeGreaterThanOrEqual(count);
          }
          expect(kpis.floodMs).toBeLessThanOrEqual(HOUR);
          expect(kpis.floodWindows).toBeLessThanOrEqual(kpis.windows);
          expect(kpis.raises).toBe(PRIORITIES.reduce((sum, p) => sum + kpis.byPriority[p], 0));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('finds flood episodes exactly where a brute-force window count is over the threshold', () => {
    let withFloods = 0;
    fc.assert(
      fc.property(occurrencesArb, (occurrences) => {
        const asOf = START + SPAN + HOUR;
        const set = prepare(occurrences, { asOf }, CONFIG);
        const times = set.occurrences.map((o) => o.raisedAt);
        const countAt = (t: number): number =>
          times.filter((at) => at > t - CONFIG.windowMs && at <= t).length;
        const instants = [...new Set(times.flatMap((t) => [t, t + CONFIG.windowMs]))].sort(
          (a, b) => a - b,
        );
        const episodes = floodEpisodes(set);
        withFloods += episodes.length > 0 ? 1 : 0;
        const inFlood = (t: number): boolean =>
          episodes.some((e) => e.startAt <= t && (e.endAt === null || t < e.endAt));
        for (const t of instants) {
          expect(inFlood(t)).toBe(countAt(t) > CONFIG.floodThreshold);
        }
        for (const episode of episodes) {
          expect(episode.peak).toBe(
            Math.max(
              ...instants
                .filter((t) => t >= episode.startAt && t < (episode.endAt ?? Infinity))
                .map(countAt),
            ),
          );
        }
      }),
      { numRuns: 300 },
    );
    // The generator must actually produce floods, or the property says little.
    expect(withFloods).toBeGreaterThan(30);
  });
});
