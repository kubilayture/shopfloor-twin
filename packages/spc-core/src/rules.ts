/**
 * Nelson run rules 1–8 (ADR-0032), evaluated on one run of points: consecutive points of one
 * chart, one segment and one limit version.
 *
 * Zones: σ = (upper − centre) / 3, the same on both sides of the centre. "Beyond kσ" is strictly
 * more than kσ from the centre, "within 1σ" strictly less: a point exactly on a zone line is
 * neither, and a point exactly on the centre line is on neither side. Rule 1 compares with the
 * limits themselves (strictly above the upper, strictly below the lower), so a chart whose lower
 * limit is 0 (MR, R) never signals below it. A rule that looks at L points is judged at a point
 * only when the run holds L points ending there, and fires at the last point of the pattern.
 */
import { compare, multiply, type Fraction } from '@shopfloor/oee-core';
import type { ChartName, Limits } from './limits.ts';
import { integer, subtract } from './rational.ts';

export const RULES = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type Rule = (typeof RULES)[number];

/** How many points each rule looks at. */
export const RULE_LENGTH: Readonly<Record<Rule, number>> = {
  1: 1,
  2: 9,
  3: 6,
  4: 14,
  5: 3,
  6: 5,
  7: 15,
  8: 8,
};

export const RULE_TEXT: Readonly<Record<Rule, string>> = {
  1: 'one point beyond a control limit',
  2: 'nine points in a row on the same side of the centre line',
  3: 'six points in a row steadily rising or falling',
  4: 'fourteen points in a row alternating up and down',
  5: 'two of three points in a row beyond 2σ on the same side',
  6: 'four of five points in a row beyond 1σ on the same side',
  7: 'fifteen points in a row within 1σ of the centre line',
  8: 'eight points in a row beyond 1σ, on both sides',
};

/** The rules enabled per chart. */
export type RuleSet = Readonly<Record<ChartName, readonly Rule[]>>;

/**
 * The defaults (review of PR #207, probe P4b): rules 1, 2 and 5 on I and X̄, rule 1 on MR and R.
 * Their in-control false-alarm run length is recorded in ADR-0032.
 */
export const DEFAULT_RULES: RuleSet = { I: [1, 2, 5], MR: [1], Xbar: [1, 2, 5], R: [1] };

/** A rule set checked: known rules only, each once, in ascending order. */
export function checkRuleSet(rules: RuleSet): RuleSet {
  for (const [chart, list] of Object.entries(rules)) {
    const seen = new Set<number>();
    for (const rule of list) {
      if (!(RULES as readonly number[]).includes(rule) || seen.has(rule)) {
        throw new RangeError(`rule ${String(rule)} on chart ${chart} is unknown or repeated`);
      }
      seen.add(rule);
    }
  }
  const sorted = (list: readonly Rule[]): Rule[] => [...list].sort((a, b) => a - b);
  return { I: sorted(rules.I), MR: sorted(rules.MR), Xbar: sorted(rules.Xbar), R: sorted(rules.R) };
}

interface Zones {
  /** -1 below the centre, 0 on it, 1 above. */
  readonly side: -1 | 0 | 1;
  /** Strictly beyond 1σ, 2σ on its side. */
  readonly beyond1: boolean;
  readonly beyond2: boolean;
  /** Strictly within 1σ. */
  readonly within1: boolean;
  /** Strictly above the upper or below the lower limit. */
  readonly outside: boolean;
}

function zones(value: Fraction, limits: Limits): Zones {
  const deviation = subtract(value, limits.centre);
  const side = compare(deviation, integer(0));
  // 3·|x − centre| against k·(upper − centre) = k·3σ: no division.
  const distance = multiply(integer(3), side < 0 ? multiply(integer(-1), deviation) : deviation);
  const threeSigma = subtract(limits.upper, limits.centre);
  return {
    side,
    beyond1: compare(distance, threeSigma) > 0,
    beyond2: compare(distance, multiply(integer(2), threeSigma)) > 0,
    within1: compare(distance, threeSigma) < 0,
    outside: compare(value, limits.upper) > 0 || compare(value, limits.lower) < 0,
  };
}

const count = <T>(items: readonly T[], test: (item: T) => boolean): number =>
  items.reduce((n, item) => (test(item) ? n + 1 : n), 0);

/** The signs of the successive differences of a window: -1, 0 or 1. */
function steps(values: readonly Fraction[]): number[] {
  return values.slice(1).map((value, i) => {
    const previous = values[i];
    return previous === undefined ? 0 : compare(value, previous);
  });
}

function fires(rule: Rule, z: readonly Zones[], values: readonly Fraction[]): boolean {
  switch (rule) {
    case 1:
      return z[0]?.outside ?? false;
    case 2:
      return z.every((p) => p.side === 1) || z.every((p) => p.side === -1);
    case 3: {
      // Five successive differences all strictly positive or all strictly negative; an equal
      // pair ends the run.
      const s = steps(values);
      return s.every((d) => d > 0) || s.every((d) => d < 0);
    }
    case 4: {
      // Thirteen successive differences, none zero, each of the opposite sign to the one before.
      const s = steps(values);
      return s.every((d, i) => d !== 0 && (i === 0 || d === -(s[i - 1] ?? 0)));
    }
    case 5:
    case 6: {
      const beyond = (p: Zones): boolean => (rule === 5 ? p.beyond2 : p.beyond1);
      const needed = rule === 5 ? 2 : 4;
      return (
        count(z, (p) => beyond(p) && p.side === 1) >= needed ||
        count(z, (p) => beyond(p) && p.side === -1) >= needed
      );
    }
    case 7:
      return z.every((p) => p.within1);
    case 8:
      return (
        z.every((p) => p.beyond1) && z.some((p) => p.side === 1) && z.some((p) => p.side === -1)
      );
  }
}

/**
 * For each point of a run, whether `rule` fires there: its pattern ends at that point and lies
 * wholly inside the run.
 */
export function ruleTriggers(values: readonly Fraction[], limits: Limits, rule: Rule): boolean[] {
  return runTriggers(values, limits, [rule]).get(rule) ?? [];
}

/** {@link ruleTriggers} for several rules, with the zones computed once. */
export function runTriggers(
  values: readonly Fraction[],
  limits: Limits,
  rules: readonly Rule[],
): Map<Rule, boolean[]> {
  const z = values.map((value) => zones(value, limits));
  return new Map(
    rules.map((rule) => {
      const length = RULE_LENGTH[rule];
      const hits = values.map((_, i) => {
        const start = i - length + 1;
        return start >= 0 && fires(rule, z.slice(start, i + 1), values.slice(start, i + 1));
      });
      return [rule, hits];
    }),
  );
}
