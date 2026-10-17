/**
 * Property tests (ADR-0032). fast-check prints the seed and path of a failure; rerun one with
 * `fc.assert(…, { seed, path })`.
 *
 * - the chart depends on the readings, not on the order they arrive in (a late fact is a rebuild);
 * - rules only look back: the chart of a prefix of the readings judges every point as the full
 *   chart does, which is what `traceAsOf` and provisional points rely on;
 * - episode invariants: every point of an episode fires, the run's points just before and after
 *   it don't, episodes of one chart and rule never overlap, `closedBy` is the chart's next point.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { firstVersion, spcChart, type Point } from './chart.ts';
import { CHARTS } from './limits.ts';
import { comparePositions, firstPass, type Reading } from './readings.ts';
import { RULES, type RuleSet } from './rules.ts';

const readingsArb = fc
  .array(
    fc.record({
      // Mostly tight around 2000 with steps and outliers, so every rule fires now and then.
      value: fc.oneof(
        { weight: 6, arbitrary: fc.integer({ min: 1990, max: 2010 }) },
        { weight: 2, arbitrary: fc.integer({ min: 2010, max: 2030 }) },
        { weight: 1, arbitrary: fc.integer({ min: 1500, max: 2600 }) },
      ),
      gap: fc.integer({ min: 0, max: 3 }),
      epochBreak: fc.integer({ min: 0, max: 30 }),
      retest: fc.integer({ min: 0, max: 12 }),
    }),
    { minLength: 0, maxLength: 140, size: 'max' },
  )
  .map((items) => {
    let epoch = 1;
    let at = 0;
    return items.map((item, i): Reading => {
      if (item.epochBreak === 0) epoch += 1;
      at += item.gap * 1000;
      return {
        key: `r${String(i)}`,
        epoch,
        at,
        seq: i,
        pass: item.retest === 0 ? 2 : 1,
        value: item.value,
      };
    });
  });

const rulesArb: fc.Arbitrary<RuleSet> = fc.record({
  I: fc.subarray([...RULES]),
  MR: fc.subarray([1] as const),
  Xbar: fc.subarray([...RULES]),
  R: fc.subarray([1] as const),
});

const chartOf = (readings: readonly Reading[], rules: RuleSet, full = readings) => {
  const version = firstVersion(full, { subgroupSize: 3, baselineSubgroups: 4 });
  return spcChart({ readings, versions: version ? [version] : [], rules, subgroupSize: 3 });
};

const judged = (p: Point): string => `${p.chart}:${p.key}:${String(p.version)}:${p.rules.join('')}`;

describe('spc-core properties', () => {
  it('does not depend on the order the readings arrive in', () => {
    fc.assert(
      fc.property(readingsArb, rulesArb, fc.integer(), (readings, rules, salt) => {
        const shuffled = [...readings].sort(
          (a, b) => ((a.seq * 7919 + salt) % 101) - ((b.seq * 7919 + salt) % 101),
        );
        expect(chartOf(shuffled, rules)).toEqual(chartOf(readings, rules));
      }),
    );
  });

  it('judges a prefix of the readings as the full chart does', () => {
    fc.assert(
      fc.property(readingsArb, rulesArb, fc.nat(), (readings, rules, cutAt) => {
        const cut = readings.slice(0, readings.length === 0 ? 0 : cutAt % (readings.length + 1));
        // The same limit version (frozen), only fewer readings.
        const prefix = chartOf(cut, rules, readings);
        const full = chartOf(readings, rules);
        for (const chart of CHARTS) {
          const head = full.points[chart].slice(0, prefix.points[chart].length);
          expect(prefix.points[chart].map(judged)).toEqual(head.map(judged));
        }
      }),
    );
  });

  it('keeps the episode invariants', () => {
    fc.assert(
      fc.property(readingsArb, rulesArb, (readings, rules) => {
        const chart = chartOf(readings, rules);
        for (const name of CHARTS) {
          const points = chart.points[name];
          const index = new Map(points.map((p, i) => [p.key, i]));
          const sameRun = (a: Point | undefined, b: Point | undefined): boolean =>
            b !== undefined && a?.segment === b.segment && a.version === b.version;
          for (const rule of rules[name]) {
            const episodes = chart.episodes.filter((e) => e.chart === name && e.rule === rule);
            const covered = new Set<number>();
            let previousLast = -1;
            for (const e of episodes) {
              const first = index.get(e.key) ?? -1;
              const last = index.get(e.lastKey) ?? -1;
              // Every point of an episode fires, in one run, and no two episodes overlap.
              expect(first).toBeGreaterThan(previousLast);
              expect(last - first + 1).toBe(e.points);
              for (let i = first; i <= last; i += 1) {
                expect(points[i]?.rules).toContain(rule);
                expect(sameRun(points[i], points[first])).toBe(true);
                covered.add(i);
              }
              // The run's points just before and just after it don't fire.
              const before = points[first - 1];
              if (sameRun(before, points[first])) expect(before?.rules).not.toContain(rule);
              const after = points[last + 1];
              if (sameRun(after, points[last])) expect(after?.rules).not.toContain(rule);
              // It is closed by the chart's next point, or open at the end.
              expect(e.closedBy).toBe(after?.key ?? null);
              previousLast = last;
            }
            // Every firing point belongs to an episode.
            points.forEach((p, i) => {
              if (p.rules.includes(rule)) expect(covered.has(i)).toBe(true);
            });
          }
        }
        const sorted = [...chart.episodes].sort((a, b) => comparePositions(a.position, b.position));
        expect(chart.episodes.map((e) => e.position)).toEqual(sorted.map((e) => e.position));
        expect(chart.firstPass).toEqual(firstPass(readings));
      }),
    );
  });
});
