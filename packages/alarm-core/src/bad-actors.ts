/**
 * Bad actors (ADR-0024): the alarm points of a scope with the most raises in a range, ranked by
 * raises descending, then active time descending, then equipment and code ascending.
 */
import { fraction, type Fraction } from '@shopfloor/oee-core';
import type { Bucket } from './buckets.ts';
import type { Millis, PreparedSet } from './occurrences.ts';

export interface BadActor {
  readonly equipment: string;
  readonly code: string;
  readonly raises: number;
  /** Raises of this point over the scope's raises in the range. */
  readonly share: Fraction;
  readonly activeMs: Millis;
  readonly chatteringRaises: number;
}

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The top `limit` points with at least one raise in [from, to). */
export function badActors(set: PreparedSet, range: Bucket, limit = 10): BadActor[] {
  const { occurrences, closedAt, asOf } = set;
  const end = closedAt === null && asOf < range.to ? asOf : range.to;
  const points = new Map<
    string,
    { equipment: string; code: string; raises: number; activeMs: number; chattering: number }
  >();
  let total = 0;
  for (const occurrence of occurrences) {
    const raised = occurrence.raisedAt >= range.from && occurrence.raisedAt < range.to;
    const from = occurrence.raisedAt > range.from ? occurrence.raisedAt : range.from;
    const to = occurrence.endAt === null || occurrence.endAt > end ? end : occurrence.endAt;
    const activeMs = to > from ? to - from : 0;
    if (!raised && activeMs === 0) {
      continue;
    }
    const entry = points.get(occurrence.point) ?? {
      equipment: occurrence.equipment,
      code: occurrence.code,
      raises: 0,
      activeMs: 0,
      chattering: 0,
    };
    entry.activeMs += activeMs;
    if (raised) {
      entry.raises += 1;
      entry.chattering += occurrence.chattering ? 1 : 0;
      total += 1;
    }
    points.set(occurrence.point, entry);
  }
  return [...points.values()]
    .filter((entry) => entry.raises > 0)
    .sort(
      (a, b) =>
        b.raises - a.raises ||
        b.activeMs - a.activeMs ||
        ascending(a.equipment, b.equipment) ||
        ascending(a.code, b.code),
    )
    .slice(0, limit)
    .map((entry) => ({
      equipment: entry.equipment,
      code: entry.code,
      raises: entry.raises,
      share: fraction(BigInt(entry.raises), BigInt(total)),
      activeMs: entry.activeMs,
      chatteringRaises: entry.chattering,
    }));
}
