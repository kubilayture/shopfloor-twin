/**
 * The operator measures of alarm management (#143, ADR-0024 "Operator lifecycle"), MES only and
 * never reconciled: shelved and annunciated raises, time to acknowledge, unacknowledged at a
 * bucket's end and shelved time per point. All in plant time and integer ms, within one epoch.
 * They are kept apart from the alarm KPIs (`/alarms/kpi`), which count every raise and never read
 * the operator's tables.
 */
import type { EndReason, TransitionAction } from './tables.ts';

type Millis = number;

export interface OperatorOccurrence {
  readonly equipment: string;
  readonly code: string;
  readonly raisedAt: Millis;
  readonly endedAt: Millis | null;
  readonly endReason: EndReason | null;
  /** The acknowledgement's plant time and epoch; null when not acknowledged (or without a clock). */
  readonly ackPlantAt: Millis | null;
  readonly ackPlantEpoch: number | null;
}

/** A point transition of the audit (shelve, unshelve, expire, epoch-ended), in audit order. */
export interface ShelfTransition {
  readonly equipment: string;
  readonly code: string;
  readonly action: TransitionAction;
  readonly plantAt: Millis | null;
  /** For a shelve: its `until`. */
  readonly until: Millis | null;
}

export interface OperatorBucketDef {
  readonly key: string;
  readonly from: Millis;
  readonly to: Millis;
}

export interface OperatorBucket extends OperatorBucketDef {
  /** Raises in the bucket (as the KPIs count them). */
  readonly raises: number;
  /** Raises while their point was shelved, and the others. */
  readonly shelvedRaises: number;
  readonly annunciatedRaises: number;
  /**
   * Time from raise to acknowledgement (plant time) of the raises in the bucket acknowledged in the
   * same epoch: how many, the sum and the longest (null when none).
   */
  readonly timeToAck: {
    readonly count: number;
    readonly sumMs: number;
    readonly maxMs: number | null;
  };
  /** Occurrences raised before the bucket's end (or the plant clock) not acknowledged by then. */
  readonly unacknowledgedAtEnd: number;
  /** Shelved time per point inside the bucket (up to the plant clock), points with some only. */
  readonly shelvedMs: readonly {
    readonly equipment: string;
    readonly code: string;
    readonly ms: Millis;
  }[];
  /** The bucket is not over at the plant clock. */
  readonly provisional: boolean;
}

interface Interval {
  readonly from: Millis;
  readonly to: Millis;
}

const pointOf = (equipment: string, code: string): string => `${equipment}/${code}`;

/**
 * Shelf intervals per point, [shelve, end), from the audit in its order: a shelve opens one (a
 * shelve of a shelved point ends the old one there), an unshelve, expire or epoch end closes it at
 * its plant time; never past the shelf's `until`, and an open one runs to `until` or the clock.
 */
export function shelfIntervals(
  transitions: readonly ShelfTransition[],
  asOf: Millis,
): Map<string, Interval[]> {
  const result = new Map<string, Interval[]>();
  const open = new Map<string, { from: Millis; until: Millis }>();
  const close = (key: string, at: Millis): void => {
    const current = open.get(key);
    if (!current) return;
    open.delete(key);
    const to = Math.min(at, current.until);
    if (to > current.from) {
      const list = result.get(key) ?? [];
      list.push({ from: current.from, to });
      result.set(key, list);
    }
  };
  for (const transition of transitions) {
    const key = pointOf(transition.equipment, transition.code);
    if (transition.action === 'shelve') {
      if (transition.plantAt === null || transition.until === null) continue;
      close(key, transition.plantAt);
      open.set(key, { from: transition.plantAt, until: transition.until });
    } else if (
      transition.action === 'unshelve' ||
      transition.action === 'expire' ||
      transition.action === 'epoch-ended'
    ) {
      close(key, transition.plantAt ?? Math.min(open.get(key)?.until ?? asOf, asOf));
    }
  }
  for (const key of [...open.keys()]) close(key, asOf);
  return result;
}

const shelvedAt = (intervals: readonly Interval[] | undefined, at: Millis): boolean =>
  (intervals ?? []).some((interval) => interval.from <= at && at < interval.to);

/** The operator measures of one scope and epoch per bucket (pure). */
export function operatorMeasures(
  occurrences: readonly OperatorOccurrence[],
  transitions: readonly ShelfTransition[],
  epoch: number,
  asOf: Millis,
  buckets: readonly OperatorBucketDef[],
): OperatorBucket[] {
  const shelves = shelfIntervals(transitions, asOf);
  const ackAt = (o: OperatorOccurrence): Millis | null =>
    o.ackPlantEpoch === epoch && o.ackPlantAt !== null ? o.ackPlantAt : null;
  return buckets.map((bucket) => {
    const end = Math.min(bucket.to, asOf);
    let raises = 0;
    let shelvedRaises = 0;
    let count = 0;
    let sumMs = 0;
    let maxMs: number | null = null;
    let unacknowledged = 0;
    for (const o of occurrences) {
      const acked = ackAt(o);
      if (o.raisedAt >= bucket.from && o.raisedAt < bucket.to) {
        raises++;
        if (shelvedAt(shelves.get(pointOf(o.equipment, o.code)), o.raisedAt)) shelvedRaises++;
        if (acked !== null) {
          const ms = Math.max(0, acked - o.raisedAt);
          count++;
          sumMs += ms;
          maxMs = maxMs === null ? ms : Math.max(maxMs, ms);
        }
      }
      if (o.raisedAt >= end) continue;
      if (acked !== null && acked <= end) continue;
      // Ended by a newer epoch: closed without an acknowledgement (ADR-0024).
      if (o.endReason === 'epoch-ended' && o.endedAt !== null && o.endedAt <= end) continue;
      unacknowledged++;
    }
    const shelvedMs: { equipment: string; code: string; ms: Millis }[] = [];
    for (const [key, intervals] of shelves) {
      let ms = 0;
      for (const interval of intervals) {
        ms += Math.max(0, Math.min(interval.to, end) - Math.max(interval.from, bucket.from));
      }
      if (ms > 0) {
        const split = key.indexOf('/');
        shelvedMs.push({ equipment: key.slice(0, split), code: key.slice(split + 1), ms });
      }
    }
    shelvedMs.sort((a, b) =>
      a.equipment === b.equipment ? (a.code < b.code ? -1 : 1) : a.equipment < b.equipment ? -1 : 1,
    );
    return {
      key: bucket.key,
      from: bucket.from,
      to: bucket.to,
      raises,
      shelvedRaises,
      annunciatedRaises: raises - shelvedRaises,
      timeToAck: { count, sumMs, maxMs },
      unacknowledgedAtEnd: unacknowledged,
      shelvedMs,
      provisional: bucket.to > asOf,
    };
  });
}
