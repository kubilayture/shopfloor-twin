/**
 * Drives the tests from `docs/spc-reference-cases.md` (Phase 8 plan, exit criterion 3): the
 * hand-calculated tables are parsed and every case is checked exactly, as fractions and
 * four-decimal strings: constants, limits, capability, the points each rule fires on, and the
 * episodes of whole charts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatFraction, toDecimal, type Fraction } from '@shopfloor/oee-core';
import { describe, expect, it } from 'vitest';
import { firstVersion, spcChart, type LimitVersion } from './chart.ts';
import { E2, MR_D4, SUBGROUP_SIZES, subgroupConstants } from './constants.ts';
import { CHARTS, capability, estimateLimits, type ChartLimits, type ChartName } from './limits.ts';
import { decimal, integer } from './rational.ts';
import { firstPass, type Reading } from './readings.ts';
import { DEFAULT_RULES, RULES, type Rule } from './rules.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const DOC = readFileSync(resolve(ROOT, 'docs/spc-reference-cases.md'), 'utf8');
const NULL = '–';

/** The rows of the Markdown table under `## <heading>`, as cells keyed by column title. */
function table(heading: string): Record<string, string>[] {
  const section = DOC.split(/^## /m).find((part) => part.startsWith(`${heading}\n`));
  if (section === undefined) {
    throw new Error(`no section "${heading}" in the reference cases`);
  }
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  const [titles = [], , ...body] = rows;
  if (body.length === 0) {
    throw new Error(`section "${heading}" has no rows`);
  }
  return body.map((cells) => Object.fromEntries(titles.map((title, i) => [title, cells[i] ?? ''])));
}

const cell = (row: Record<string, string>, column: string): string => {
  const value = row[column];
  if (value === undefined) {
    throw new Error(`no column "${column}"`);
  }
  return value;
};

const int = (text: string): number => {
  const value = Number(text.replace('−', '-'));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`not an integer: "${text}"`);
  }
  return value;
};

/** "5×10 0 −1" → [5, …, 5, 0, -1]. */
const values = (text: string): number[] =>
  text.split(' ').flatMap((token) => {
    const [value = '', times] = token.split('×');
    return Array.from({ length: times === undefined ? 1 : int(times) }, () => int(value));
  });

/** Chart-case notation: `p` readings, `rNN` retests, `/` for a new epoch. */
function readings(text: string): Reading[] {
  let epoch = 1;
  let first = 0;
  let retest = 0;
  const result: Reading[] = [];
  text.split(' ').forEach((token, index) => {
    if (token === '/') {
      epoch += 1;
      return;
    }
    const isRetest = token.startsWith('r');
    const key = isRetest ? `r${String((retest += 1))}` : `p${String((first += 1))}`;
    result.push({
      key,
      epoch,
      at: index * 60_000,
      seq: index,
      pass: isRetest ? 2 : 1,
      value: int(isRetest ? token.slice(1) : token),
    });
  });
  return result;
}

const show = (f: Fraction): string => formatFraction(f);

describe('constants (docs/spc-reference-cases.md)', () => {
  const rows = table('Constants');

  it('lists every subgroup size the code has, with the same constants', () => {
    expect(rows.map((row) => int(cell(row, 'n')))).toEqual(SUBGROUP_SIZES);
    for (const row of rows) {
      const c = subgroupConstants(int(cell(row, 'n')));
      expect([c.a2, c.d3, c.d4, c.d2].map(show)).toEqual(
        ['A2', 'D3', 'D4', 'd2'].map((column) => show(decimal(cell(row, column)))),
      );
    }
  });

  it('states the individuals constants', () => {
    const match = /\*\*E2 ([\d.]+), MR D4 ([\d.]+)\.\*\*/.exec(DOC);
    expect(match).not.toBeNull();
    expect(show(E2)).toBe(show(decimal(match?.[1] ?? '')));
    expect(show(MR_D4)).toBe(show(decimal(match?.[2] ?? '')));
  });
});

describe('limit cases (docs/spc-reference-cases.md)', () => {
  const cases = new Map(
    table('Limit cases').map((row) => {
      const ordered = firstPass(readings(cell(row, 'Readings')));
      const first = ordered[0];
      const last = ordered.at(-1);
      if (first === undefined || last === undefined) throw new Error('empty case');
      const limits = estimateLimits(ordered, { from: first, to: last }, int(cell(row, 'n')));
      return [cell(row, 'Case'), { limits, usl: integer(int(cell(row, 'USL'))) }] as const;
    }),
  );
  const get = (id: string): { limits: ChartLimits; usl: Fraction } => {
    const found = cases.get(id);
    if (!found) throw new Error(`no limit case ${id}`);
    return found;
  };

  it.each(table('Expected statistics').map((row) => [cell(row, 'Case'), row] as const))(
    'statistics and capability of %s',
    (id, row) => {
      const { limits, usl } = get(id);
      expect({
        readings: limits.counts.readings,
        movingRanges: limits.counts.movingRanges,
        subgroups: limits.counts.subgroups,
        mean: show(limits.statistics.mean),
        movingRange: show(limits.statistics.movingRange),
        grandMean: show(limits.statistics.grandMean),
        range: show(limits.statistics.range),
      }).toEqual({
        readings: int(cell(row, 'Readings used')),
        movingRanges: int(cell(row, 'Moving ranges')),
        subgroups: int(cell(row, 'Subgroups')),
        mean: cell(row, 'X̄'),
        movingRange: cell(row, 'M̄R'),
        grandMean: cell(row, 'X̿'),
        range: cell(row, 'R̄'),
      });
      const cap = capability(limits, usl);
      expect(
        cap === null
          ? { sigma: NULL, cpu: NULL, dp: NULL, cpk: NULL }
          : {
              sigma: show(cap.sigma),
              cpu: show(cap.cpu),
              dp: toDecimal(cap.cpu),
              cpk: show(cap.cpk),
            },
      ).toEqual({
        sigma: cell(row, 'σ̂'),
        cpu: cell(row, 'Cpu'),
        dp: cell(row, 'Cpu (4 dp)'),
        cpk: cell(row, 'Cpu'),
      });
    },
  );

  it.each(
    table('Expected limits').map((row) => [cell(row, 'Case'), cell(row, 'Chart'), row] as const),
  )('limits of %s, chart %s', (id, chart, row) => {
    const limits = get(id).limits.charts[chart as ChartName];
    expect({
      lower: show(limits.lower),
      centre: show(limits.centre),
      upper: show(limits.upper),
      lowerDp: toDecimal(limits.lower),
      upperDp: toDecimal(limits.upper),
    }).toEqual({
      lower: cell(row, 'Lower'),
      centre: cell(row, 'Centre'),
      upper: cell(row, 'Upper'),
      lowerDp: cell(row, 'Lower (4 dp)'),
      upperDp: cell(row, 'Upper (4 dp)'),
    });
  });

  it('covers every chart of every case', () => {
    const rows = table('Expected limits');
    expect(rows).toHaveLength(cases.size * CHARTS.length);
  });
});

/** A version with the given I limits, its window before every point (so nothing is baseline). */
function ruleVersion(lower: number, centre: number, upper: number): LimitVersion {
  const limits = { lower: integer(lower), centre: integer(centre), upper: integer(upper) };
  const before = { epoch: 0, at: 0, seq: 0 };
  return {
    version: 1,
    createdAt: 0,
    from: null,
    until: null,
    limits: {
      subgroupSize: 2,
      window: { from: before, to: before },
      counts: { readings: 0, movingRanges: 0, subgroups: 0 },
      statistics: {
        mean: limits.centre,
        movingRange: integer(0),
        grandMean: limits.centre,
        range: integer(0),
      },
      charts: { I: limits, MR: limits, Xbar: limits, R: limits },
    },
  };
}

const showEpisode = (first: string, last: string, closedBy: string | null): string =>
  `${first}–${last} (${closedBy ?? 'open'})`;

describe('rule cases (docs/spc-reference-cases.md)', () => {
  const rows = table('Rule cases');

  it('covers every rule', () => {
    expect(new Set(rows.map((row) => int(cell(row, 'Rule'))))).toEqual(new Set(RULES));
  });

  it.each(rows.map((row) => [cell(row, 'Case'), row] as const))('%s', (_id, row) => {
    const rule = int(cell(row, 'Rule')) as Rule;
    const list = values(cell(row, 'Values'));
    const chart = spcChart({
      readings: list.map((value, i) => ({
        key: String(i + 1),
        epoch: 1,
        at: (i + 1) * 1000,
        seq: i + 1,
        pass: 1,
        value,
      })),
      versions: [ruleVersion(-30, 0, 30)],
      rules: { I: [rule], MR: [], Xbar: [], R: [] },
      subgroupSize: 2,
    });
    expect(
      chart.points.I.filter((p) => p.rules.includes(rule))
        .map((p) => p.key)
        .join(', '),
    ).toBe(cell(row, 'Fires at'));
    expect(chart.episodes.map((e) => showEpisode(e.key, e.lastKey, e.closedBy)).join(', ')).toBe(
      cell(row, 'Episodes'),
    );
  });
});

describe('chart cases (docs/spc-reference-cases.md)', () => {
  const cases = new Map(
    table('Chart cases').map((row) => {
      const list = readings(cell(row, 'Readings'));
      const subgroupSize = int(cell(row, 'n'));
      const version = firstVersion(list, {
        subgroupSize,
        baselineSubgroups: int(cell(row, 'Baseline subgroups')),
      });
      if (version === null) throw new Error('no baseline');
      const chart = spcChart({
        readings: list,
        versions: [version],
        rules: DEFAULT_RULES,
        subgroupSize,
      });
      return [cell(row, 'Case'), { version, chart, list }] as const;
    }),
  );
  const get = (id: string): NonNullable<ReturnType<typeof cases.get>> => {
    const found = cases.get(id);
    if (!found) throw new Error(`no chart case ${id}`);
    return found;
  };
  const keyAt = (list: readonly Reading[], at: number): string =>
    list.find((r) => r.at === at)?.key ?? '?';

  it.each(table('Expected chart limits').map((row) => [cell(row, 'Case'), row] as const))(
    'limit version 1 of %s',
    (id, row) => {
      const { version, list } = get(id);
      const { charts, window } = version.limits;
      expect({
        window: `${keyAt(list, window.from.at)}–${keyAt(list, window.to.at)}`,
        iLower: show(charts.I.lower),
        iCentre: show(charts.I.centre),
        iUpper: show(charts.I.upper),
        mrUpper: show(charts.MR.upper),
        xLower: show(charts.Xbar.lower),
        xCentre: show(charts.Xbar.centre),
        xUpper: show(charts.Xbar.upper),
        rUpper: show(charts.R.upper),
        createdAt: version.createdAt,
      }).toEqual({
        window: cell(row, 'Window'),
        iLower: cell(row, 'I lower'),
        iCentre: cell(row, 'I centre'),
        iUpper: cell(row, 'I upper'),
        mrUpper: cell(row, 'MR upper'),
        xLower: cell(row, 'Xbar lower'),
        xCentre: cell(row, 'Xbar centre'),
        xUpper: cell(row, 'Xbar upper'),
        rUpper: cell(row, 'R upper'),
        createdAt: window.to.at,
      });
    },
  );

  const keys = (list: readonly Reading[]): string =>
    list.length === 0 ? NULL : list.map((r) => r.key).join(', ');
  const plain = (f: Fraction): string => (f.den === 1n ? String(f.num) : show(f));

  it.each(table('Expected chart points').map((row) => [cell(row, 'Case'), row] as const))(
    'points of %s',
    (id, row) => {
      const { chart } = get(id);
      expect({
        retests: keys(chart.retests),
        pending: keys(chart.pending),
        dropped: keys(chart.dropped),
        mr: chart.points.MR.map((p) => plain(p.value)).join(' '),
        xbar: chart.points.Xbar.map((p) => plain(p.value)).join(' '),
        r: chart.points.R.map((p) => plain(p.value)).join(' '),
      }).toEqual({
        retests: cell(row, 'Retests'),
        pending: cell(row, 'Pending'),
        dropped: cell(row, 'Dropped'),
        mr: cell(row, 'MR values'),
        xbar: cell(row, 'Xbar values'),
        r: cell(row, 'R values'),
      });
    },
  );

  it.each([...cases.keys()])('episodes of %s', (id) => {
    const expected = table('Expected episodes')
      .filter((row) => cell(row, 'Case') === id)
      .map((row) => ({
        chart: cell(row, 'Chart'),
        rule: int(cell(row, 'Rule')),
        version: int(cell(row, 'Version')),
        key: cell(row, 'First'),
        lastKey: cell(row, 'Last'),
        points: int(cell(row, 'Points')),
        closedBy: cell(row, 'Closed by') === 'open' ? null : cell(row, 'Closed by'),
        baseline: cell(row, 'Baseline') === 'yes',
      }));
    expect(
      get(id).chart.episodes.map(
        ({ chart, rule, version, key, lastKey, points, closedBy, baseline }) => ({
          chart,
          rule,
          version,
          key,
          lastKey,
          points,
          closedBy,
          baseline,
        }),
      ),
    ).toEqual(expected);
  });
});
