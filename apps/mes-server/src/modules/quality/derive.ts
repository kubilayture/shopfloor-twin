/**
 * The quality module's pure part (#200, ADR-0032): passes of a part's readings, limit versions
 * folded from their append-only events, finality of a chart position, and the plan that brings
 * the stored signal episodes in line with the derived ones. Everything SPC itself defines (charts,
 * limits, rules, episodes) is `spc-core`'s, the same code the simulator's ground truth runs.
 */
import { formatFraction, fraction, type Fraction } from '@shopfloor/oee-core';
import {
  CHARTS,
  comparePositions,
  type ChartLimits,
  type ChartName,
  type Episode,
  type LimitVersion,
  type Position,
  type Rule,
} from '@shopfloor/spc-core';
import type { SignalStatus, StoredLimits, StoredPosition } from './tables.ts';

/** A reading's key, as `trace-core`'s `readingKey`: `{epoch}/{partId}/{pass}`. */
export const readingKey = (epoch: number, partId: number, pass: number): string =>
  `${String(epoch)}/${String(partId)}/${String(pass)}`;

/** The parts of a reading key. */
export function keyParts(key: string): { epoch: number; partId: number; pass: number } {
  const [epoch, partId, pass] = key.split('/').map(Number);
  if (epoch === undefined || partId === undefined || pass === undefined || Number.isNaN(pass)) {
    throw new RangeError(`reading key ${key}`);
  }
  return { epoch, partId, pass };
}

/** One cycle of a part at the characteristic's machine. */
export interface PartCycle {
  readonly seq: number;
  readonly at: number;
  readonly result: 'good' | 'scrap' | 'rework';
}

/**
 * The pass of each of a part's cycles at the leak tester (ADR-0031's rule, as the ground truth
 * counts it): 1, plus one for every earlier cycle of the part that sent it back (`rework`), in
 * plant-time order (ties by sequence). Keyed by the cycle's `seq`.
 */
export function passesOf(cycles: readonly PartCycle[]): Map<number, number> {
  const ordered = [...cycles].sort((a, b) => a.at - b.at || a.seq - b.seq);
  const passes = new Map<number, number>();
  let reworks = 0;
  for (const cycle of ordered) {
    passes.set(cycle.seq, reworks + 1);
    if (cycle.result === 'rework') reworks++;
  }
  return passes;
}

/** Steps of a reported value: whole steps of the resolution, as the ground truth rounds them. */
export const stepsOf = (value: number, resolution: number): number =>
  Math.round(value / resolution);

export function parseFraction(text: string): Fraction {
  const [num, den] = text.split('/');
  if (num === undefined || den === undefined) throw new RangeError(`fraction ${text}`);
  return fraction(BigInt(num), BigInt(den));
}

/** A fraction of steps as a double in the unit (for display only). */
export const inUnit = (f: Fraction, resolution: number): number =>
  (Number(f.num) / Number(f.den)) * resolution;

const storedPosition = (p: Position): StoredPosition => ({
  epoch: p.epoch,
  at: new Date(p.at).toISOString(),
  seq: p.seq,
});

const position = (p: StoredPosition): Position => ({
  epoch: p.epoch,
  at: Date.parse(p.at),
  seq: p.seq,
});

/** `spc-core`'s limits as stored (exact fractions as text). */
export function storeLimits(limits: ChartLimits): StoredLimits {
  const charts = {} as Record<ChartName, { lower: string; centre: string; upper: string }>;
  for (const chart of CHARTS) {
    const l = limits.charts[chart];
    charts[chart] = {
      lower: formatFraction(l.lower),
      centre: formatFraction(l.centre),
      upper: formatFraction(l.upper),
    };
  }
  return {
    subgroupSize: limits.subgroupSize,
    window: { from: storedPosition(limits.window.from), to: storedPosition(limits.window.to) },
    counts: { ...limits.counts },
    statistics: {
      mean: formatFraction(limits.statistics.mean),
      movingRange: formatFraction(limits.statistics.movingRange),
      grandMean: formatFraction(limits.statistics.grandMean),
      range: formatFraction(limits.statistics.range),
    },
    charts,
  };
}

/** Stored limits back as `spc-core`'s. */
export function loadLimits(stored: StoredLimits): ChartLimits {
  const charts = {} as Record<ChartName, { lower: Fraction; centre: Fraction; upper: Fraction }>;
  for (const chart of CHARTS) {
    const l = stored.charts[chart];
    charts[chart] = {
      lower: parseFraction(l.lower),
      centre: parseFraction(l.centre),
      upper: parseFraction(l.upper),
    };
  }
  return {
    subgroupSize: stored.subgroupSize,
    window: { from: position(stored.window.from), to: position(stored.window.to) },
    counts: { ...stored.counts },
    statistics: {
      mean: parseFraction(stored.statistics.mean),
      movingRange: parseFraction(stored.statistics.movingRange),
      grandMean: parseFraction(stored.statistics.grandMean),
      range: parseFraction(stored.statistics.range),
    },
    charts,
  };
}

/** Whether two limit estimates are the same: window, counts and every exact value. */
export const sameLimits = (a: ChartLimits, b: ChartLimits): boolean =>
  JSON.stringify(storeLimits(a)) === JSON.stringify(storeLimits(b));

/** One append-only limit event (`quality.control_limit`). */
export interface LimitEvent {
  readonly n: number;
  readonly kind: 'created' | 'ended';
  readonly version: number;
  readonly plantAt: number;
  readonly position: Position | null;
  readonly limits: StoredLimits | null;
  readonly comment: string | null;
  readonly actor: string;
}

/** A limit version with who created and ended it. */
export interface VersionRecord extends LimitVersion {
  readonly createdBy: string;
  readonly comment: string | null;
  readonly endedBy: string | null;
}

/** The limit versions of a characteristic, folded from its events in order. */
export function versionsOf(events: readonly LimitEvent[]): VersionRecord[] {
  const versions = new Map<number, VersionRecord>();
  for (const event of [...events].sort((a, b) => a.n - b.n)) {
    if (event.kind === 'created') {
      if (event.limits === null) throw new RangeError(`limit event ${String(event.n)}: no limits`);
      versions.set(event.version, {
        version: event.version,
        createdAt: event.plantAt,
        from: event.position,
        until: null,
        endedAt: null,
        limits: loadLimits(event.limits),
        createdBy: event.actor,
        comment: event.comment,
        endedBy: null,
      });
      continue;
    }
    const version = versions.get(event.version);
    if (!version) throw new RangeError(`limit version ${String(event.version)} ended unknown`);
    versions.set(event.version, {
      ...version,
      until: event.position,
      endedAt: event.plantAt,
      endedBy: event.actor,
    });
  }
  return [...versions.values()].sort((a, b) => a.version - b.version);
}

/** The tester's progress: its newest epoch and final-through there (ADR-0018). */
export interface Progress {
  readonly epoch: number | null;
  readonly settledSeq: number | null;
  /** Plant time of the last device fact up to `settledSeq`, when known. */
  readonly settledTime?: Date | null;
}

/**
 * Whether a chart position is final: in an older epoch than the tester's newest (that run is
 * over), or at or below its final-through in the newest. Every reading below a final position
 * has arrived (or its gap was written off), so whatever a point and its run's rules depend on is
 * known.
 */
export const isFinal = (p: Position, progress: Progress): boolean =>
  progress.epoch !== null &&
  (p.epoch < progress.epoch ||
    (p.epoch === progress.epoch && progress.settledSeq !== null && p.seq <= progress.settledSeq));

/** A reading's place on the chart, for episode extents. */
export interface PointRef {
  readonly epoch: number;
  readonly partId: number;
  readonly pass: number;
  readonly at: number;
  readonly seq: number;
}

/** A signal episode as stored (the fields the plan compares and writes). */
export interface StoredSignal {
  readonly id: number;
  readonly version: number;
  readonly chart: ChartName;
  readonly rule: number;
  readonly first: PointRef;
  readonly last: PointRef;
  readonly points: number;
  readonly closedBy: PointRef | null;
  readonly baseline: boolean;
  readonly extentFinal: boolean;
  readonly status: SignalStatus;
  readonly acknowledged: boolean;
}

/** What a derived episode looks like stored. */
export interface DerivedSignal {
  readonly version: number;
  readonly chart: ChartName;
  readonly rule: Rule;
  readonly first: PointRef;
  readonly last: PointRef;
  readonly points: number;
  readonly closedBy: PointRef | null;
  readonly baseline: boolean;
  /** The tester is final through the triggering point: the episode exists for good. */
  readonly final: boolean;
  /**
   * The tester is final through the closing point (while open, the last point): the extent (last
   * point, count, closing point) won't change but by a fact from a written-off gap.
   */
  readonly extentFinal: boolean;
}

/** An episode's identity: (limit version, chart, rule, first triggering point). */
export const signalKey = (s: {
  readonly version: number;
  readonly chart: string;
  readonly rule: number;
  readonly first: { readonly epoch: number; readonly partId: number; readonly pass: number };
}): string =>
  `${String(s.version)}~${s.chart}~${String(s.rule)}~${readingKey(s.first.epoch, s.first.partId, s.first.pass)}`;

/** The episodes of a chart as stored rows want them, with their finality. */
export function derivedSignals(
  episodes: readonly Episode[],
  positions: { get(key: string): Position | undefined },
  progress: Progress,
): DerivedSignal[] {
  const ref = (key: string): PointRef => {
    const p = positions.get(key);
    if (!p) throw new RangeError(`episode point ${key} is not a reading`);
    const { partId, pass } = keyParts(key);
    return { epoch: p.epoch, partId, pass, at: p.at, seq: p.seq };
  };
  return episodes.map((e) => {
    const last = ref(e.lastKey);
    const closedBy = e.closedBy === null ? null : ref(e.closedBy);
    return {
      version: e.version,
      chart: e.chart,
      rule: e.rule,
      first: ref(e.key),
      last,
      points: e.points,
      closedBy,
      baseline: e.baseline,
      final: isFinal(e.position, progress),
      extentFinal: isFinal(closedBy ?? last, progress),
    };
  });
}

const sameRef = (a: PointRef | null, b: PointRef | null): boolean =>
  a === null || b === null
    ? a === b
    : a.epoch === b.epoch &&
      a.partId === b.partId &&
      a.pass === b.pass &&
      a.at === b.at &&
      a.seq === b.seq;

/** What to write so the stored episodes equal the derived ones. */
export interface SignalPlan {
  readonly inserts: readonly DerivedSignal[];
  /** Stored rows whose extent or status changes; `event` says what a push reports. */
  readonly updates: readonly {
    readonly id: number;
    readonly signal: DerivedSignal;
    readonly status: Exclude<SignalStatus, 'withdrawn'>;
    /** Status changed (became final, or came back after a withdrawal): the row version rises. */
    readonly statusChanged: boolean;
    readonly event: 'updated' | 'final';
  }[];
  /** Rows kept as `withdrawn`: final ones, and acknowledged provisional ones. */
  readonly withdrawals: readonly { readonly id: number; readonly reason: string }[];
  /** Provisional, unacknowledged rows that are simply gone. */
  readonly deletes: readonly number[];
}

/** Why an episode was withdrawn (shown with it). */
export const WITHDRAWN_FINAL =
  'A late reading from a written-off gap changed the chart; this signal no longer occurs';
export const WITHDRAWN_PROVISIONAL =
  'A late reading changed the chart before this signal was final; it no longer occurs';
export const WITHDRAWN_VERSION =
  'A limit version was created or ended; judged by the limits now in force, this signal no longer occurs';

/** The reasons a plan gives its withdrawals: late readings, or a limit version change. */
export type WithdrawalCause = 'reading' | 'version';

/**
 * The plan from the stored episodes to the derived ones (plan "Finality and late facts"): a new
 * episode is inserted; one that changed extent or became final is updated (a final one never
 * goes back to provisional); a stored one no longer derived is deleted while provisional and
 * unacknowledged, and kept `withdrawn` otherwise, with its acknowledgement.
 */
export function planSignals(
  derived: readonly DerivedSignal[],
  stored: readonly StoredSignal[],
  cause: WithdrawalCause = 'reading',
): SignalPlan {
  const byKey = new Map(stored.map((s) => [signalKey(s), s]));
  const seen = new Set<string>();
  const inserts: DerivedSignal[] = [];
  const updates: SignalPlan['updates'][number][] = [];
  for (const signal of derived) {
    const key = signalKey(signal);
    seen.add(key);
    const row = byKey.get(key);
    if (!row) {
      inserts.push(signal);
      continue;
    }
    const status = signal.final || row.status === 'final' ? 'final' : 'provisional';
    const statusChanged = status !== row.status;
    const extentChanged =
      !sameRef(row.last, signal.last) ||
      row.points !== signal.points ||
      !sameRef(row.closedBy, signal.closedBy) ||
      row.baseline !== signal.baseline ||
      row.extentFinal !== signal.extentFinal ||
      !sameRef(row.first, signal.first);
    if (statusChanged || extentChanged) {
      updates.push({
        id: row.id,
        signal,
        status,
        statusChanged,
        event:
          statusChanged && status === 'final' && row.status === 'provisional' ? 'final' : 'updated',
      });
    }
  }
  const withdrawals: { id: number; reason: string }[] = [];
  const deletes: number[] = [];
  for (const row of stored) {
    if (seen.has(signalKey(row)) || row.status === 'withdrawn') continue;
    if (row.status === 'final' || row.acknowledged) {
      const reason =
        cause === 'version'
          ? WITHDRAWN_VERSION
          : row.status === 'final'
            ? WITHDRAWN_FINAL
            : WITHDRAWN_PROVISIONAL;
      withdrawals.push({ id: row.id, reason });
    } else deletes.push(row.id);
  }
  return { inserts, updates, withdrawals, deletes };
}

/** Whether a position lies at or before another. */
export const atOrBefore = (a: Position, b: Position): boolean => comparePositions(a, b) <= 0;
