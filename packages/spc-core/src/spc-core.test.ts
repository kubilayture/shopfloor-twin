import { formatFraction } from '@shopfloor/oee-core';
import { describe, expect, it } from 'vitest';
import { firstVersion, spcChart, versionAt, type LimitVersion } from './chart.ts';
import { subgroupConstants } from './constants.ts';
import { baselineWindow, capability, estimateLimits, subgroupsOf } from './limits.ts';
import { decimal, divide, integer, mean } from './rational.ts';
import { firstPass, orderReadings, retests, segments, type Reading } from './readings.ts';
import { DEFAULT_RULES, checkRuleSet, ruleTriggers, type RuleSet } from './rules.ts';

const reading = (n: number, value: number, extra: Partial<Reading> = {}): Reading => ({
  key: `k${String(n)}`,
  epoch: 1,
  at: n * 1000,
  seq: n,
  pass: 1,
  value,
  ...extra,
});

const series = (values: readonly number[], epoch = 1, offset = 0): Reading[] =>
  values.map((value, i) => reading(offset + i + 1, value, { epoch }));

function nth(list: readonly Reading[], i: number): Reading {
  const found = list[i];
  if (found === undefined) throw new Error(`no reading ${String(i)}`);
  return found;
}

const NONE: RuleSet = { I: [], MR: [], Xbar: [], R: [] };

describe('rational helpers', () => {
  it('reads decimal constants exactly and refuses anything else', () => {
    expect(formatFraction(decimal('2.66'))).toBe('133/50');
    expect(formatFraction(decimal('7'))).toBe('7/1');
    expect(() => decimal('-1.5')).toThrow(RangeError);
    expect(() => decimal('1e3')).toThrow(RangeError);
  });

  it('refuses a division by zero and the mean of nothing', () => {
    expect(() => divide(integer(1), integer(0))).toThrow(RangeError);
    expect(() => mean([])).toThrow(RangeError);
  });
});

describe('constants', () => {
  it('refuses subgroup sizes outside 2–10', () => {
    expect(() => subgroupConstants(1)).toThrow(/2–10/);
    expect(() => subgroupConstants(11)).toThrow(RangeError);
  });
});

describe('readings', () => {
  it('orders by epoch, time, sequence, then key', () => {
    const list = [
      reading(1, 5, { key: 'b', epoch: 2, at: 0, seq: 0 }),
      reading(2, 5, { key: 'z', at: 10, seq: 2 }),
      reading(3, 5, { key: 'y', at: 10, seq: 1 }),
      reading(4, 5, { key: 'x', at: 10, seq: 1 }),
      reading(5, 5, { key: 'a', epoch: 2, at: 0, seq: 0 }),
    ];
    expect(orderReadings(list).map((r) => r.key)).toEqual(['x', 'y', 'z', 'a', 'b']);
  });

  it('refuses a value that is not whole steps and a pass below 1', () => {
    expect(() => orderReadings([reading(1, 0.5)])).toThrow(/whole number/);
    expect(() => orderReadings([reading(1, 5, { pass: 0 })])).toThrow(/pass 0/);
  });

  it('separates first passes from retests and cuts segments by epoch', () => {
    const list = [
      ...series([1, 2], 1),
      reading(9, 7, { pass: 2, key: 'retest' }),
      ...series([3], 2, 5),
    ];
    expect(firstPass(list).map((r) => r.value)).toEqual([1, 2, 3]);
    expect(retests(list).map((r) => r.key)).toEqual(['retest']);
    expect(segments(firstPass(list)).map((s) => s.map((r) => r.value))).toEqual([[1, 2], [3]]);
    expect(segments([])).toEqual([]);
  });
});

describe('limits', () => {
  it('needs a moving range and a complete subgroup in the window', () => {
    const one = series([5]);
    const r = nth(one, 0);
    expect(() => estimateLimits(one, { from: r, to: r }, 2)).toThrow(/at least one of each/);
    const three = series([5, 6, 7]);
    const [a, c] = [nth(three, 0), nth(three, 2)];
    expect(() => estimateLimits(three, { from: a, to: c }, 5)).toThrow(RangeError);
  });

  it('uses only the subgroups wholly inside the window', () => {
    const list = series([10, 20, 30, 40, 50, 60]);
    const [b, e] = [nth(list, 1), nth(list, 4)];
    const limits = estimateLimits(list, { from: b, to: e }, 2);
    // Subgroups (10 20) (30 40) (50 60): only (30 40) lies inside 20…50.
    expect(limits.counts).toEqual({ readings: 4, movingRanges: 3, subgroups: 1 });
    expect(formatFraction(limits.statistics.grandMean)).toBe('35/1');
  });

  it('finds the baseline window, or none while it is incomplete', () => {
    const list = [...series([1, 2, 3], 1), ...series([4, 5, 6, 7], 2, 3)];
    // Epoch 1: (1 2), 3 dropped; epoch 2: (4 5) (6 7).
    expect(subgroupsOf(firstPass(list), 2).dropped.map((r) => r.value)).toEqual([3]);
    expect(baselineWindow(firstPass(list), 2, 3)).toEqual({
      from: { epoch: 1, at: 1000, seq: 1 },
      to: { epoch: 2, at: 7000, seq: 7 },
    });
    expect(baselineWindow(firstPass(list), 2, 4)).toBeNull();
    expect(() => baselineWindow(list, 2, 0)).toThrow(RangeError);
  });

  it('gives capability against the subgroup sigma', () => {
    const list = series([10, 12, 10, 12]);
    const limits = estimateLimits(list, { from: nth(list, 0), to: nth(list, 3) }, 2);
    const cap = capability(limits, integer(20));
    // σ̂ = 2 / 1.128 = 250/141; Cpu = 9 / (3 · 250/141) = 423/250.
    expect(cap && [formatFraction(cap.sigma), formatFraction(cap.cpu)]).toEqual([
      '250/141',
      '423/250',
    ]);
    expect(cap?.cpk).toEqual(cap?.cpu);
  });
});

describe('rules', () => {
  it('checks a rule set and sorts it', () => {
    expect(checkRuleSet({ I: [5, 1, 2], MR: [1], Xbar: [], R: [] }).I).toEqual([1, 2, 5]);
    expect(() => checkRuleSet({ ...NONE, I: [1, 1] })).toThrow(/repeated/);
    expect(() => checkRuleSet({ ...NONE, MR: [9 as 1] })).toThrow(/unknown/);
  });

  it('never judges a pattern longer than the run', () => {
    const limits = { lower: integer(-30), centre: integer(0), upper: integer(30) };
    expect(ruleTriggers([integer(5), integer(5)], limits, 2)).toEqual([false, false]);
  });

  it('treats an equal pair as the end of an alternation at any place', () => {
    const limits = { lower: integer(-30), centre: integer(0), upper: integer(30) };
    const values = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0].map(integer);
    expect(ruleTriggers(values, limits, 4).some(Boolean)).toBe(false);
  });
});

describe('limit versions', () => {
  const list = series([10, 12, 10, 12, 30, 31, 10, 12, 10, 12, 30, 31]);
  const v1 = firstVersion(list, { subgroupSize: 2, baselineSubgroups: 2 });
  if (v1 === null) throw new Error('no version 1');

  it('creates version 1 at its last baseline reading, applying from the first reading', () => {
    expect(v1.createdAt).toBe(4000);
    expect(v1.from).toBeNull();
    expect(firstVersion(list.slice(0, 3), { subgroupSize: 2, baselineSubgroups: 2 })).toBeNull();
  });

  it('judges a point by the highest version whose range holds it', () => {
    const v2: LimitVersion = {
      ...v1,
      version: 2,
      from: { epoch: 1, at: 7000, seq: 7 },
      until: { epoch: 1, at: 11_000, seq: 11 },
    };
    const versions = [v1, v2];
    expect(versionAt(versions, { epoch: 1, at: 6000, seq: 6 })?.version).toBe(1);
    expect(versionAt(versions, { epoch: 1, at: 7000, seq: 7 })?.version).toBe(2);
    expect(versionAt(versions, { epoch: 1, at: 11_000, seq: 11 })?.version).toBe(1);
    expect(versionAt([{ ...v1, until: { epoch: 1, at: 5000, seq: 5 } }], nth(list, 5))).toBeNull();
  });

  it('starts a new run at a version change, and leaves points without a version unjudged', () => {
    const v2: LimitVersion = { ...v1, version: 2, from: { epoch: 1, at: 6000, seq: 6 } };
    const ended: LimitVersion = { ...v1, until: { epoch: 1, at: 6000, seq: 6 } };
    const chart = spcChart({
      readings: list,
      versions: [ended, v2],
      rules: DEFAULT_RULES,
      subgroupSize: 2,
    });
    // p5 = 30 fires rule 1 under version 1, p6 = 31 under version 2: two episodes.
    const iRule1 = chart.episodes.filter((e) => e.chart === 'I' && e.rule === 1);
    expect(iRule1.slice(0, 2).map((e) => [e.key, e.version, e.closedBy])).toEqual([
      ['k5', 1, 'k6'],
      ['k6', 2, 'k7'],
    ]);
    expect(chart.points.I[5]?.version).toBe(2);
    expect(chart.points.I[5]?.baseline).toBe(false);

    const unjudged = spcChart({
      readings: list,
      versions: [ended],
      rules: DEFAULT_RULES,
      subgroupSize: 2,
    });
    expect(
      unjudged.points.I.slice(5).every((p) => p.version === null && p.rules.length === 0),
    ).toBe(true);
    expect(unjudged.episodes.every((e) => e.version === 1)).toBe(true);
  });

  it('refuses versions of another subgroup size and readings sharing a key', () => {
    expect(() =>
      spcChart({ readings: list, versions: [v1], rules: DEFAULT_RULES, subgroupSize: 3 }),
    ).toThrow(/subgroups of 2/);
    expect(() =>
      spcChart({
        readings: [...list, reading(99, 1, { key: 'k1', pass: 2 })],
        versions: [v1],
        rules: DEFAULT_RULES,
        subgroupSize: 2,
      }),
    ).toThrow(/share a key/);
  });

  it('charts nothing from no readings', () => {
    const chart = spcChart({ readings: [], versions: [], rules: DEFAULT_RULES, subgroupSize: 5 });
    expect(chart.episodes).toEqual([]);
    expect(chart.points.I).toEqual([]);
  });
});
