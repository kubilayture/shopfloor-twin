/**
 * Property tests (ADR-0032). fast-check prints the seed and path of a failure; rerun one with
 * `fc.assert(…, { seed, path })`.
 *
 * - the chart depends on the readings, not on the order they arrive in (a late fact is a rebuild);
 * - rules only look back: the chart of a prefix of the readings judges every point as the full
 *   chart does, which is what `traceAsOf` and provisional points rely on;
 * - episodes are exactly the maximal stretches of consecutive firing points of a run.
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
  MR: fc.subarray([...RULES]),
  Xbar: fc.subarray([...RULES]),
  R: fc.subarray([...RULES]),
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

  it('builds episodes from maximal stretches of firing points', () => {
    fc.assert(
      fc.property(readingsArb, rulesArb, (readings, rules) => {
        const chart = chartOf(readings, rules);
        for (const name of CHARTS) {
          const points = chart.points[name];
          for (const rule of rules[name]) {
            const expected: [string, string, number, string | null][] = [];
            let open: [string, string, number] | null = null;
            let prev: (typeof points)[number] | undefined;
            for (const p of points) {
              const same = prev?.segment === p.segment && prev.version === p.version;
              const fires = p.rules.includes(rule);
              prev = p;
              if (open && fires && same) {
                open = [open[0], p.key, open[2] + 1];
                continue;
              }
              if (open) expected.push([...open, p.key]);
              open = fires ? [p.key, p.key, 1] : null;
            }
            if (open) expected.push([...open, null]);
            const got = chart.episodes
              .filter((e) => e.chart === name && e.rule === rule)
              .map((e) => [e.key, e.lastKey, e.points, e.closedBy]);
            expect(got).toEqual(expected);
          }
        }
        const sorted = [...chart.episodes].sort((a, b) => comparePositions(a.position, b.position));
        expect(chart.episodes.map((e) => e.position)).toEqual(sorted.map((e) => e.position));
        expect(chart.firstPass).toEqual(firstPass(readings));
      }),
    );
  });
});
