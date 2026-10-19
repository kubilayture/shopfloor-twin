/**
 * The incremental derivation (#238, Phase 9 plan "Derived-work costs", ADR-0032 amendment): the
 * same chart as {@link spcChart}, kept up to date as readings arrive instead of derived whole each
 * time.
 *
 * Rules only look back, and moving ranges, subgroups and runs depend only on the readings before
 * them in chart order, so everything before the earliest changed reading stays as it is. A change
 * resumes there: the I points from that reading on, the moving ranges from it, the subgroups from
 * the start of the subgroup it falls in (in the order before and after the change), each new
 * point's rules over its run's earlier points (their zones kept), and per chart and rule the
 * episodes from the first one that reaches the point before the resumed one (its extent and
 * closing point may change). A new reading at the end of the chart re-derives one point per chart
 * and at most one subgroup; a late reading re-derives from its place onwards. A new or ended limit
 * version derives the chart whole again (a version applies from a position that may lie anywhere).
 *
 * `chart()` equals `spcChart` over the same readings and versions exactly, which the property test
 * (`incremental.test.ts`) checks on random sequences with late readings, duplicates, removals,
 * epoch changes and limit-version changes.
 */
import type { Fraction } from '@shopfloor/oee-core';
import type { Episode, LimitVersion, Point, SpcChart } from './chart.ts';
import { versionAt } from './chart.ts';
import { subgroupConstants } from './constants.ts';
import { CHARTS, subgroup, type ChartName, type Limits } from './limits.ts';
import { integer } from './rational.ts';
import { comparePositions, orderReadings, type Position, type Reading } from './readings.ts';
import {
  RULE_LENGTH,
  checkRuleSet,
  firesAt,
  zones,
  type Rule,
  type RuleSet,
  type Zones,
} from './rules.ts';

/** What changed: readings added or replaced (by key), readings removed, or the limit versions. */
export interface SpcChange {
  /** Readings added, or replacing the reading with the same key (every pass). */
  readonly upsert?: readonly Reading[];
  /** Keys of readings removed (unknown keys are ignored). */
  readonly remove?: readonly string[];
  /** The limit versions now, when a version was created or ended: the chart is derived whole. */
  readonly versions?: readonly LimitVersion[];
}

/** What an update derived again. */
export interface SpcUpdate {
  /** First-pass readings before the update. */
  readonly before: number;
  /** First-pass readings after it. */
  readonly after: number;
  /**
   * Index (in chart order) of the first first-pass reading derived again: `before` when the update
   * only appended readings at the end of the chart or changed no first-pass reading.
   */
  readonly from: number;
  /** Derived whole: the limit versions changed. */
  readonly whole: boolean;
  /** `new`: only appended at the end (or nothing charted changed); `late`: resumed inside the chart or derived whole. */
  readonly kind: 'new' | 'late';
}

export interface SpcDerivationConfig {
  readonly rules: RuleSet;
  readonly subgroupSize: number;
  readonly versions?: readonly LimitVersion[];
  readonly readings?: readonly Reading[];
}

interface Span {
  first: number;
  last: number;
}

/** One chart's points with what judging the next ones needs. */
interface ChartState {
  readonly name: ChartName;
  readonly rules: readonly Rule[];
  readonly points: Point[];
  readonly values: Fraction[];
  /** The point's zones under its version; {@link NO_ZONES} where no version judges it. */
  readonly zones: Zones[];
  readonly versions: (LimitVersion | null)[];
  /** Index of the first point of the point's run (one segment, one limit version). */
  readonly runStart: number[];
  /** The first-pass index of the point's reading (I, MR) or of its subgroup's first reading (X̄, R). */
  readonly anchor: number[];
  /** Per rule, the episodes as point index spans, in order. */
  readonly episodes: Map<Rule, Span[]>;
  /** The longest rule window on the chart (0 without rules). */
  readonly window: number;
  /** Points appended in a row that are the same as before the change (while resuming). */
  realigned: number;
}

/** A point as it was before a change, with its zones. */
interface Reuse {
  readonly point: Point;
  readonly zones: Zones;
}

/** Zones of an unjudged point: never read (a rule is judged only inside a version's run). */
const NO_ZONES: Zones = {
  side: 0,
  beyond1: false,
  beyond2: false,
  within1: false,
  outside: false,
};

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareReadings = (a: Reading, b: Reading): number =>
  comparePositions(a, b) || compareKeys(a.key, b.key);
const positionOf = (r: Position): Position => ({ epoch: r.epoch, at: r.at, seq: r.seq });
const sameReading = (a: Reading, b: Reading): boolean =>
  a.epoch === b.epoch &&
  a.at === b.at &&
  a.seq === b.seq &&
  a.pass === b.pass &&
  a.value === b.value;
const distance = (a: number, b: number): number => (a > b ? a - b : b - a);

/** `items[i]`, which the caller knows exists. */
function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new RangeError(`no item ${String(i)} of ${String(items.length)}`);
  return item;
}

/** Index of the first element of `ordered` not before `target`. */
function lowerBound(ordered: readonly Reading[], target: Reading): number {
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = ordered[middle];
    if (item !== undefined && compareReadings(item, target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function checkReading(reading: Reading): void {
  if (!Number.isSafeInteger(reading.value)) {
    throw new RangeError(`reading ${reading.key} is not a whole number of steps`);
  }
  if (!Number.isSafeInteger(reading.pass) || reading.pass < 1) {
    throw new RangeError(`reading ${reading.key} has pass ${String(reading.pass)}`);
  }
}

/**
 * A characteristic's chart kept up to date incrementally; `chart()` equals {@link spcChart} over
 * the readings and versions it holds.
 */
export class SpcDerivation {
  readonly #rules: RuleSet;
  readonly #size: number;
  #versions: readonly LimitVersion[] = [];
  /** Every reading by key, retests included. */
  readonly #all = new Map<string, Reading>();
  /** The first-pass readings in chart order. */
  #ordered: Reading[] = [];
  /** Per first-pass reading: its segment's index and the index of the segment's first reading. */
  readonly #segment: number[] = [];
  readonly #segmentStart: number[] = [];
  #retests: Reading[] | null = [];
  readonly #charts: Record<ChartName, ChartState>;
  /** Zones by limits and value: a value's zones under one version never change. */
  readonly #zones = new WeakMap<Limits, Map<string, Zones>>();
  #view: SpcChart | null = null;

  constructor(config: SpcDerivationConfig) {
    this.#rules = checkRuleSet(config.rules);
    this.#size = config.subgroupSize;
    // Refuses a size without constants (2–10), as the whole derivation does.
    subgroupConstants(config.subgroupSize);
    this.#charts = {} as Record<ChartName, ChartState>;
    for (const name of CHARTS) this.#charts[name] = this.#emptyChart(name);
    this.update({ versions: config.versions ?? [], upsert: config.readings ?? [] });
  }

  /** The readings held, every pass, in no particular order. */
  readings(): IterableIterator<Reading> {
    return this.#all.values();
  }

  /** A reading by key. */
  get(key: string): Reading | undefined {
    return this.#all.get(key);
  }

  /** The limit versions the chart is judged by. */
  get versions(): readonly LimitVersion[] {
    return this.#versions;
  }

  /** Applies a change and derives again what it affects. */
  update(change: SpcChange): SpcUpdate {
    const before = this.#ordered.length;
    const whole = change.versions !== undefined;
    if (change.versions !== undefined) {
      for (const v of change.versions) {
        if (v.limits.subgroupSize !== this.#size) {
          throw new RangeError(
            `limit version ${String(v.version)} has subgroups of ${String(v.limits.subgroupSize)}, the chart ${String(this.#size)}`,
          );
        }
      }
      this.#versions = [...change.versions];
    }
    for (const reading of change.upsert ?? []) checkReading(reading);

    // The first-pass readings that leave and enter the chart, and the earliest of them.
    const removed = new Set<string>();
    const inserted = new Map<string, Reading>();
    const earliest: { reading: Reading | null } = { reading: null };
    const touch = (r: Reading): void => {
      if (earliest.reading === null || compareReadings(r, earliest.reading) < 0) {
        earliest.reading = r;
      }
    };
    const leave = (old: Reading | undefined): void => {
      if (old === undefined) return;
      if (old.pass === 1) {
        removed.add(old.key);
        inserted.delete(old.key);
        touch(old);
      } else this.#retests = null;
    };
    for (const key of change.remove ?? []) {
      const old = this.#all.get(key);
      leave(old);
      this.#all.delete(key);
    }
    for (const reading of change.upsert ?? []) {
      const old = this.#all.get(reading.key);
      if (old !== undefined && sameReading(old, reading)) continue;
      leave(old);
      this.#all.set(reading.key, reading);
      if (reading.pass === 1) {
        inserted.set(reading.key, reading);
        touch(reading);
      } else this.#retests = null;
    }

    let from = before;
    if (whole) from = 0;
    else if (earliest.reading !== null) from = lowerBound(this.#ordered, earliest.reading);
    if (from < before || inserted.size > 0 || removed.size > 0 || whole) {
      const old = this.#ordered;
      const tail = old.slice(from).filter((r) => !removed.has(r.key));
      tail.push(...inserted.values());
      tail.sort(compareReadings);
      // The subgroup the first changed reading fell in before the change: dropped with it.
      const alignedBefore = from < old.length ? this.#aligned(from) : from;
      const ordered = from === 0 ? tail : old.slice(0, from).concat(tail);
      this.#ordered = ordered;
      // The readings that end the chart as before (the same objects, in the same order): their
      // points are kept where their rule windows lie among them. None after a version change.
      let o = old.length - 1;
      let k = ordered.length - 1;
      while (!whole && o >= from && k >= from && old[o] === ordered[k]) {
        o -= 1;
        k -= 1;
      }
      this.#resume(
        from,
        alignedBefore,
        whole ? ordered.length : k + 1,
        ordered.length - old.length,
      );
      this.#view = null;
    } else if (this.#retests === null) {
      this.#view = null;
    }
    const after = this.#ordered.length;
    return {
      before,
      after,
      from,
      whole,
      kind: whole || from < before ? 'late' : 'new',
    };
  }

  /** The chart: equal to `spcChart` over the readings and versions held. */
  chart(): SpcChart {
    if (this.#view !== null) return this.#view;
    this.#retests ??= orderReadings([...this.#all.values()].filter((r) => r.pass > 1));
    const pending: Reading[] = [];
    const dropped: Reading[] = [];
    const ordered = this.#ordered;
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && this.#segmentStart[end] === start) end += 1;
      const tail = (end - start) % this.#size;
      if (end < ordered.length) dropped.push(...ordered.slice(end - tail, end));
      else pending.push(...ordered.slice(end - tail, end));
      start = end;
    }
    const points = {} as Record<ChartName, Point[]>;
    const episodes: Episode[] = [];
    for (const name of CHARTS) {
      const chart = this.#charts[name];
      points[name] = chart.points.slice();
      for (const [rule, spans] of chart.episodes) {
        for (const span of spans) episodes.push(episodeOf(chart, rule, span));
      }
    }
    episodes.sort(
      (a, b) =>
        comparePositions(a.position, b.position) ||
        CHARTS.indexOf(a.chart) - CHARTS.indexOf(b.chart) ||
        a.rule - b.rule,
    );
    this.#view = {
      firstPass: ordered.slice(),
      retests: this.#retests.slice(),
      points,
      pending,
      dropped,
      episodes,
    };
    return this.#view;
  }

  // ---- internals ----

  #emptyChart(name: ChartName): ChartState {
    const rules = this.#rules[name];
    return {
      name,
      rules,
      points: [],
      values: [],
      zones: [],
      versions: [],
      runStart: [],
      anchor: [],
      episodes: new Map(rules.map((rule) => [rule, []])),
      window: rules.reduce(
        (longest, rule) => (RULE_LENGTH[rule] > longest ? RULE_LENGTH[rule] : longest),
        0,
      ),
      realigned: 0,
    };
  }

  /** The first reading of the subgroup reading `i` falls in (by the segmentation held now). */
  #aligned(i: number): number {
    const start = this.#segmentStart[i] ?? i;
    return i - ((i - start) % this.#size);
  }

  /**
   * Derives everything from first-pass reading `from` on. `alignedBefore` is {@link #aligned} of
   * `from` before the change. The readings from `suffix` on (new indices) are the very readings
   * that ended the chart before, `shift` places later: a point made of them keeps its value and
   * zones, and its rules when every point its rule windows look at is such a point too (only its
   * segment index may move, when the change added or removed a segment before it).
   */
  #resume(from: number, alignedBefore: number, suffix: number, shift: number): void {
    const ordered = this.#ordered;
    const n = ordered.length;
    // Segments from `from` on.
    this.#segment.length = n;
    this.#segmentStart.length = n;
    for (let i = from; i < n; i += 1) {
      const reading = at(ordered, i);
      const previous = i > 0 ? ordered[i - 1] : undefined;
      if (previous?.epoch === reading.epoch) {
        this.#segment[i] = this.#segment[i - 1] ?? 0;
        this.#segmentStart[i] = this.#segmentStart[i - 1] ?? 0;
      } else {
        this.#segment[i] = previous === undefined ? 0 : (this.#segment[i - 1] ?? 0) + 1;
        this.#segmentStart[i] = i;
      }
    }
    const segmentOf = (i: number): number => this.#segment[i] ?? 0;

    // I and MR: from the first changed reading.
    const iChart = this.#charts.I;
    const mrChart = this.#charts.MR;
    const iOld = this.#cut(iChart, from, shift);
    const mrOld = this.#cut(mrChart, from, shift);
    for (let i = from; i < n; i += 1) {
      const reading = at(ordered, i);
      this.#add(
        iChart,
        {
          key: reading.key,
          position: positionOf(reading),
          segment: segmentOf(i),
          value: integer(reading.value),
          anchor: i,
        },
        i >= suffix ? iOld.match(i) : null,
      );
      const previous = ordered[i - 1];
      if (previous !== undefined && this.#segmentStart[i] !== i) {
        const reuse = i - 1 >= suffix ? mrOld.match(i) : null;
        this.#add(
          mrChart,
          {
            key: reading.key,
            position: positionOf(reading),
            segment: segmentOf(i),
            value: reuse?.point.value ?? integer(distance(reading.value, previous.value)),
            anchor: i,
          },
          reuse,
        );
      }
    }
    this.#episodes(iChart, iOld.keep);
    this.#episodes(mrChart, mrOld.keep);

    // X̄ and R: from the start of the subgroup the first changed reading falls in, before or after.
    const alignedAfter = from < n ? this.#aligned(from) : from;
    const aligned = alignedBefore < alignedAfter ? alignedBefore : alignedAfter;
    const xChart = this.#charts.Xbar;
    const rChart = this.#charts.R;
    const xOld = this.#cut(xChart, aligned, shift);
    const rOld = this.#cut(rChart, aligned, shift);
    let start = aligned;
    while (start < n) {
      const end = start + this.#size;
      let complete = end <= n;
      for (let i = start + 1; complete && i < end; i += 1) {
        if (this.#segmentStart[i] === i) complete = false;
      }
      if (!complete) {
        // The rest of this segment never fills a subgroup: skip to the next segment.
        let next = start + 1;
        while (next < n && this.#segmentStart[next] !== next) next += 1;
        start = next;
        continue;
      }
      // A subgroup of the same readings as before keeps its points' values.
      const xReuse = start >= suffix ? xOld.match(start) : null;
      const rReuse = start >= suffix ? rOld.match(start) : null;
      const last = at(ordered, end - 1);
      const segment = segmentOf(start);
      if (xReuse !== null && rReuse !== null) {
        const raw = { key: last.key, position: xReuse.point.position, segment, anchor: start };
        this.#add(xChart, { ...raw, value: xReuse.point.value }, xReuse);
        this.#add(rChart, { ...raw, value: rReuse.point.value }, rReuse);
      } else {
        const group = subgroup(ordered.slice(start, end));
        const raw = { key: group.key, position: group.position, segment, anchor: start };
        this.#add(xChart, { ...raw, value: group.mean }, null);
        this.#add(rChart, { ...raw, value: integer(group.range) }, null);
      }
      start = end;
    }
    this.#episodes(xChart, xOld.keep);
    this.#episodes(rChart, rOld.keep);
  }

  /**
   * Drops a chart's points anchored at or after first-pass reading `at`. Returns how many stay,
   * and a lookup of the dropped points by their anchor after the change (`shift` places later).
   */
  #cut(
    chart: ChartState,
    at: number,
    shift: number,
  ): { keep: number; match: (anchor: number) => Reuse | null } {
    let keep = chart.anchor.length;
    while (keep > 0 && (chart.anchor[keep - 1] ?? 0) >= at) keep -= 1;
    const points = chart.points.splice(keep);
    const zonesOf = chart.zones.splice(keep);
    const anchors = chart.anchor.splice(keep);
    chart.values.length = keep;
    chart.versions.length = keep;
    chart.runStart.length = keep;
    chart.realigned = 0;
    let next = 0;
    const match = (anchor: number): Reuse | null => {
      const target = anchor - shift;
      while (next < anchors.length && (anchors[next] ?? 0) < target) next += 1;
      const point = points[next];
      const z = zonesOf[next];
      return anchors[next] === target && point !== undefined && z !== undefined
        ? { point, zones: z }
        : null;
    };
    return { keep, match };
  }

  /**
   * Appends a point, judged by its version over its run's earlier points; `reuse` is the same
   * point before the change, when it is made of the same readings.
   */
  #add(
    chart: ChartState,
    raw: {
      readonly key: string;
      readonly position: Position;
      readonly segment: number;
      readonly value: Fraction;
      readonly anchor: number;
    },
    reuse: Reuse | null,
  ): void {
    const j = chart.points.length;
    const version = versionAt(this.#versions, raw.position);
    const previous = chart.points[j - 1];
    const runStart =
      previous?.segment === raw.segment && chart.versions[j - 1] === version
        ? (chart.runStart[j - 1] ?? j)
        : j;
    chart.values.push(raw.value);
    chart.versions.push(version);
    chart.runStart.push(runStart);
    chart.anchor.push(raw.anchor);
    chart.realigned = reuse === null ? 0 : chart.realigned + 1;
    const z =
      reuse?.zones ??
      (version === null ? NO_ZONES : this.#zonesOf(version.limits.charts[chart.name], raw.value));
    chart.zones.push(z);
    // Its rules look at most `window` points back within its run: unchanged when those points are
    // the same as before, and so is where its run starts when the window reaches that start (a run
    // starting at the first point that is the same may have started earlier before the change).
    const run = j - runStart + 1;
    const judged = reuse !== null && (chart.realigned >= chart.window || run < chart.realigned);
    if (judged && reuse.point.segment === raw.segment) {
      chart.points.push(reuse.point);
      return;
    }
    const rules = judged
      ? reuse.point.rules
      : version === null
        ? []
        : chart.rules.filter((rule) => firesAt(rule, chart.zones, chart.values, runStart, j));
    chart.points.push({
      chart: chart.name,
      key: raw.key,
      position: raw.position,
      segment: raw.segment,
      value: raw.value,
      version: version?.version ?? null,
      baseline: version !== null && comparePositions(raw.position, version.limits.window.to) <= 0,
      rules,
    });
  }

  #zonesOf(limits: Limits, value: Fraction): Zones {
    let memo = this.#zones.get(limits);
    if (memo === undefined) {
      memo = new Map();
      this.#zones.set(limits, memo);
    }
    const key = `${String(value.num)}/${String(value.den)}`;
    let z = memo.get(key);
    if (z === undefined) {
      z = zones(value, limits);
      memo.set(key, z);
    }
    return z;
  }

  /**
   * Per rule, the episodes again from the first one that reaches point `from − 1` (whose extent or
   * closing point may change), or from `from`; the earlier ones are kept.
   */
  #episodes(chart: ChartState, from: number): void {
    const points = chart.points;
    for (const rule of chart.rules) {
      const spans = chart.episodes.get(rule) ?? [];
      let keep = spans.length;
      while (keep > 0 && (spans[keep - 1]?.last ?? 0) >= from - 1) keep -= 1;
      const firstDropped = spans[keep]?.first ?? from;
      const scan = firstDropped < from ? firstDropped : from;
      spans.length = keep;
      let open: Span | null = null;
      for (let j = scan; j < points.length; j += 1) {
        const point = at(points, j);
        const fires = point.rules.includes(rule);
        const previous = points[j - 1];
        const sameRun = previous?.segment === point.segment && previous.version === point.version;
        if (open !== null && fires && sameRun) {
          open.last = j;
          continue;
        }
        if (open !== null) {
          spans.push(open);
          open = null;
        }
        if (fires) open = { first: j, last: j };
      }
      if (open !== null) spans.push(open);
      chart.episodes.set(rule, spans);
    }
  }
}

function episodeOf(chart: ChartState, rule: Rule, span: Span): Episode {
  const first = at(chart.points, span.first);
  const last = at(chart.points, span.last);
  return {
    chart: chart.name,
    rule,
    version: first.version ?? 0,
    key: first.key,
    position: first.position,
    lastKey: last.key,
    points: span.last - span.first + 1,
    closedBy: chart.points[span.last + 1]?.key ?? null,
    baseline: first.baseline,
  };
}
