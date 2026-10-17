/**
 * Points, limit versions and signal episodes (ADR-0032).
 *
 * Everything here is derived from the readings and the limit versions alone, so a late reading
 * that moves every later moving range, subgroup and run is handled by deriving again.
 */
import type { Fraction } from '@shopfloor/oee-core';
import {
  CHARTS,
  baselineWindow,
  estimateLimits,
  movingRanges,
  subgroupsOf,
  type ChartLimits,
  type ChartName,
  type Subgroup,
} from './limits.ts';
import { integer } from './rational.ts';
import {
  comparePositions,
  firstPass,
  retests,
  segments,
  type Millis,
  type Position,
  type Reading,
} from './readings.ts';
import { checkRuleSet, runTriggers, type Rule, type RuleSet } from './rules.ts';

/**
 * A frozen set of control limits. Version 1 is estimated from the baseline and applies from the
 * first reading (`from: null`), so the baseline's own points are judged against it
 * retroactively. A version never changes once created; a new one is a new version.
 */
export interface LimitVersion {
  readonly version: number;
  /**
   * Plant time at which it was created. Version 1 from {@link firstVersion}: its window's last
   * reading (`window.to.at`); the MES (#200) must use the same instant for its own version 1.
   */
  readonly createdAt: Millis;
  /** The first position it applies to; `null` from the first reading. */
  readonly from: Position | null;
  /** The first position it no longer applies to (the version was ended); `null` while open. */
  readonly until: Position | null;
  /** Plant time at which it was ended (`until` set); `null` while open. */
  readonly endedAt: Millis | null;
  readonly limits: ChartLimits;
}

export interface BaselineConfig {
  readonly subgroupSize: number;
  /** Complete subgroups in the baseline (20 in `quality.yaml`). */
  readonly baselineSubgroups: number;
}

/**
 * Limit version 1, estimated from the first `baselineSubgroups` complete subgroups of the
 * first-pass readings, created at its window's last reading and applying from the first reading;
 * `null` while the baseline is incomplete. Never re-derived once created (plan "SPC").
 */
export function firstVersion(
  readings: readonly Reading[],
  config: BaselineConfig,
): LimitVersion | null {
  const ordered = firstPass(readings);
  const window = baselineWindow(ordered, config.subgroupSize, config.baselineSubgroups);
  if (window === null) return null;
  return {
    version: 1,
    createdAt: window.to.at,
    from: null,
    until: null,
    endedAt: null,
    limits: estimateLimits(ordered, window, config.subgroupSize),
  };
}

/** The version a point at `position` is judged by: the highest whose range contains it. */
export function versionAt(
  versions: readonly LimitVersion[],
  position: Position,
): LimitVersion | null {
  let found: LimitVersion | null = null;
  for (const v of versions) {
    const started = v.from === null || comparePositions(position, v.from) >= 0;
    const open = v.until === null || comparePositions(position, v.until) < 0;
    if (started && open && (found === null || v.version > found.version)) found = v;
  }
  return found;
}

export interface Point {
  readonly chart: ChartName;
  /** The reading's key (I), the later reading's (MR), the subgroup's last reading's (X̄, R). */
  readonly key: string;
  readonly position: Position;
  /** Index of the segment (epoch) in chart order, from 0. */
  readonly segment: number;
  readonly value: Fraction;
  /** The limit version judging it; `null` where no version applies (not judged). */
  readonly version: number | null;
  /**
   * A baseline point: at or before the end of its version's window, so it existed when the
   * version was created and was judged retroactively (review of PR #210: a point of an earlier
   * epoch before the window counts too).
   */
  readonly baseline: boolean;
  /** The enabled rules that fire at it. */
  readonly rules: readonly Rule[];
}

/**
 * A signal: consecutive points of one chart and one run (segment and limit version) on which the
 * same rule fires. It opens at the first and closes at the first later point of the chart that
 * doesn't continue it; `closedBy` is that point's key, `null` while open.
 */
export interface Episode {
  readonly chart: ChartName;
  readonly rule: Rule;
  readonly version: number;
  /** Key and position of the first triggering point: with the characteristic, chart, rule and version, the episode's identity. */
  readonly key: string;
  readonly position: Position;
  readonly lastKey: string;
  /** Triggering points in it. */
  readonly points: number;
  readonly closedBy: string | null;
  /** Its first point is a baseline point (at or before the window's end): created with the version, not latency-judged. */
  readonly baseline: boolean;
}

export interface SpcInput {
  /** Every reading of the characteristic, retests included (they are separated here). */
  readonly readings: readonly Reading[];
  readonly versions: readonly LimitVersion[];
  readonly rules: RuleSet;
  readonly subgroupSize: number;
}

export interface SpcChart {
  readonly firstPass: readonly Reading[];
  readonly retests: readonly Reading[];
  readonly points: Readonly<Record<ChartName, readonly Point[]>>;
  /** The last segment's readings waiting for their subgroup to fill. */
  readonly pending: readonly Reading[];
  /** Earlier segments' trailing readings that never fill a subgroup. */
  readonly dropped: readonly Reading[];
  /** In order of their first point, then chart (I, MR, X̄, R), then rule. */
  readonly episodes: readonly Episode[];
}

interface RawPoint {
  readonly key: string;
  readonly position: Position;
  readonly segment: number;
  readonly value: Fraction;
  readonly readings: readonly Position[];
}

const positionOf = (r: Position): Position => ({ epoch: r.epoch, at: r.at, seq: r.seq });

/** I-MR, X̄-R and the episodes of the enabled rules, from the readings and the limit versions. */
export function spcChart(input: SpcInput): SpcChart {
  const rules = checkRuleSet(input.rules);
  for (const v of input.versions) {
    if (v.limits.subgroupSize !== input.subgroupSize) {
      throw new RangeError(
        `limit version ${String(v.version)} has subgroups of ${String(v.limits.subgroupSize)}, the chart ${String(input.subgroupSize)}`,
      );
    }
  }
  const ordered = firstPass(input.readings);
  const segmentOf = new Map<string, number>();
  segments(ordered).forEach((segment, index) => {
    for (const reading of segment) segmentOf.set(reading.key, index);
  });
  const seg = (key: string): number => segmentOf.get(key) ?? 0;
  const indexOf = new Map(ordered.map((r, i) => [r.key, i]));
  if (new Set(input.readings.map((r) => r.key)).size !== input.readings.length) {
    throw new RangeError('two readings share a key');
  }
  const groups = subgroupsOf(ordered, input.subgroupSize);
  const groupPoint = (g: Subgroup, value: Fraction): RawPoint => ({
    key: g.key,
    position: g.position,
    segment: seg(g.key),
    value,
    readings: g.readings.map(positionOf),
  });
  const raw: Record<ChartName, RawPoint[]> = {
    I: ordered.map((r) => ({
      key: r.key,
      position: positionOf(r),
      segment: seg(r.key),
      value: integer(r.value),
      readings: [positionOf(r)],
    })),
    MR: movingRanges(ordered).map((mr) => {
      const index = indexOf.get(mr.key) ?? -1;
      const reading = ordered[index];
      const previous = ordered[index - 1];
      if (reading === undefined || previous === undefined) {
        throw new RangeError(`moving range ${mr.key} without its readings`);
      }
      return {
        key: mr.key,
        position: positionOf(reading),
        segment: seg(mr.key),
        value: integer(mr.value),
        readings: [positionOf(previous), positionOf(reading)],
      };
    }),
    Xbar: groups.complete.map((g) => groupPoint(g, g.mean)),
    R: groups.complete.map((g) => groupPoint(g, integer(g.range))),
  };

  const points = {} as Record<ChartName, Point[]>;
  const episodes: Episode[] = [];
  for (const chart of CHARTS) {
    points[chart] = judge(chart, raw[chart], input.versions, rules[chart]);
    episodes.push(...episodesOf(chart, points[chart], rules[chart]));
  }
  episodes.sort(
    (a, b) =>
      comparePositions(a.position, b.position) ||
      CHARTS.indexOf(a.chart) - CHARTS.indexOf(b.chart) ||
      a.rule - b.rule,
  );
  return {
    firstPass: ordered,
    retests: retests(input.readings),
    points,
    pending: groups.pending,
    dropped: groups.dropped,
    episodes,
  };
}

/** Assigns each point its version and the rules that fire on it, run by run. */
function judge(
  chart: ChartName,
  raw: readonly RawPoint[],
  versions: readonly LimitVersion[],
  enabled: readonly Rule[],
): Point[] {
  const assigned = raw.map((p) => ({ p, v: versionAt(versions, p.position) }));
  const result: Point[] = [];
  let start = 0;
  while (start < assigned.length) {
    const first = assigned[start];
    let end = start + 1;
    while (
      end < assigned.length &&
      assigned[end]?.p.segment === first?.p.segment &&
      assigned[end]?.v === first?.v
    ) {
      end += 1;
    }
    const run = assigned.slice(start, end);
    const version = first?.v ?? null;
    const fired = version
      ? runTriggers(
          run.map(({ p }) => p.value),
          version.limits.charts[chart],
          enabled,
        )
      : new Map<Rule, boolean[]>();
    run.forEach(({ p }, i) => {
      result.push({
        chart,
        key: p.key,
        position: p.position,
        segment: p.segment,
        value: p.value,
        version: version?.version ?? null,
        baseline: version !== null && comparePositions(p.position, version.limits.window.to) <= 0,
        rules: enabled.filter((rule) => fired.get(rule)?.[i] === true),
      });
    });
    start = end;
  }
  return result;
}

interface Open {
  first: Point;
  last: Point;
  points: number;
}

function episodesOf(
  chart: ChartName,
  points: readonly Point[],
  enabled: readonly Rule[],
): Episode[] {
  const result: Episode[] = [];
  const open = new Map<Rule, Open>();
  const close = (rule: Rule, episode: Open, closedBy: string | null): void => {
    result.push({
      chart,
      rule,
      version: episode.first.version ?? 0,
      key: episode.first.key,
      position: episode.first.position,
      lastKey: episode.last.key,
      points: episode.points,
      closedBy,
      baseline: episode.first.baseline,
    });
  };
  points.forEach((point, i) => {
    const previous = points[i - 1];
    const sameRun = previous?.segment === point.segment && previous.version === point.version;
    for (const rule of enabled) {
      const fires = point.rules.includes(rule);
      const current = open.get(rule);
      if (current && fires && sameRun) {
        current.last = point;
        current.points += 1;
        continue;
      }
      if (current) {
        close(rule, current, point.key);
        open.delete(rule);
      }
      if (fires) open.set(rule, { first: point, last: point, points: 1 });
    }
  });
  for (const [rule, episode] of open) close(rule, episode, null);
  return result;
}
