/**
 * Alarm occurrences from the device's facts (#142, ADR-0024 "Occurrences"), pure: one occurrence
 * per raise, keyed by the raise's device `seq`, paired per (equipment, epoch, code) in `seq` order.
 *
 * - A raise while an occurrence of the same code is open means a clear was lost: the open one ends
 *   at the new raise (`superseded`).
 * - A clear closes the open occurrence of its code, which in `seq` order is the one with the
 *   highest raise `seq` below the clear's; a clear with nothing open is ignored (its raise is in a
 *   gap). A clear that arrives before its raise is paired once the raise is known.
 * - A retained alarm delivery (anchor) is the device's own fact: one whose `seq` has no stored fact
 *   takes part like a fact (`source: anchor`); the fact, if it arrives, replaces it.
 * - A resync snapshot (applied by the caller only once the stream is settled up to its `asOfSeq`)
 *   closes an occurrence raised below `asOfSeq` that is still open (or only superseded later) and
 *   whose code it shows inactive: at the snapshot's time, `lost`. A device clear wins over it.
 * - A closed epoch ends what is still open at its closing time (`epoch-ended`).
 */
import type { Millis } from '@shopfloor/oee-core';
import type { EndReason, UsedAnchor, UsedSnapshot } from './tables.ts';

/** A device alarm transition of one (equipment, epoch), as derivation reads it. */
export interface DeviceTransition {
  readonly seq: number;
  readonly code: string;
  readonly transition: 'active' | 'cleared';
  readonly severity: number;
  readonly at: Millis;
}

/** One derived occurrence of an (equipment, epoch). */
export interface Derived {
  readonly seq: number;
  readonly code: string;
  readonly severity: number;
  readonly source: 'fact' | 'anchor';
  readonly raisedAt: Millis;
  readonly endedAt: Millis | null;
  readonly endReason: EndReason | null;
  readonly endSeq: number | null;
}

interface Building {
  seq: number;
  code: string;
  severity: number;
  source: 'fact' | 'anchor';
  raisedAt: Millis;
  endedAt: Millis | null;
  endReason: EndReason | null;
  endSeq: number | null;
}

/**
 * The occurrences of one code (or of all codes: they are paired per code) of one (equipment,
 * epoch), by raise `seq`. `snapshot` only when the caller applies it; `closedAt` once a newer epoch
 * closed this one (null: closed without a known time, then open ones end at their raise).
 */
export function deriveOccurrences(
  facts: readonly DeviceTransition[],
  anchors: readonly UsedAnchor[],
  snapshot: UsedSnapshot | null,
  closed: { readonly closedAt: Millis | null } | null,
): Derived[] {
  const seqs = new Set(facts.map((fact) => fact.seq));
  const events: (DeviceTransition & { source: 'fact' | 'anchor' })[] = [
    ...facts.map((fact) => ({ ...fact, source: 'fact' as const })),
    ...anchors
      .filter((anchor) => !seqs.has(anchor.seq))
      .map((anchor) => ({ ...anchor, source: 'anchor' as const })),
  ].sort((a, b) => a.seq - b.seq);

  const open = new Map<string, Building>();
  const all: Building[] = [];
  const later = (a: Millis, b: Millis): Millis => (a > b ? a : b);
  for (const event of events) {
    const current = open.get(event.code);
    if (event.transition === 'active') {
      if (current) {
        current.endedAt = later(event.at, current.raisedAt);
        current.endReason = 'superseded';
        current.endSeq = event.seq;
      }
      const occurrence: Building = {
        seq: event.seq,
        code: event.code,
        severity: event.severity,
        source: event.source,
        raisedAt: event.at,
        endedAt: null,
        endReason: null,
        endSeq: null,
      };
      all.push(occurrence);
      open.set(event.code, occurrence);
    } else if (current) {
      current.endedAt = later(event.at, current.raisedAt);
      current.endReason = 'cleared';
      current.endSeq = event.seq;
      open.delete(event.code);
    }
  }

  if (snapshot) {
    const active = new Set(snapshot.active);
    for (const occurrence of all) {
      const stillOpen =
        occurrence.endReason === null ||
        (occurrence.endReason === 'superseded' && (occurrence.endSeq ?? 0) > snapshot.asOfSeq);
      if (occurrence.seq < snapshot.asOfSeq && stillOpen && !active.has(occurrence.code)) {
        occurrence.endedAt = later(snapshot.at, occurrence.raisedAt);
        occurrence.endReason = 'lost';
        occurrence.endSeq = snapshot.asOfSeq;
      }
    }
  }

  if (closed) {
    for (const occurrence of all) {
      if (occurrence.endReason !== null) continue;
      occurrence.endedAt = later(closed.closedAt ?? occurrence.raisedAt, occurrence.raisedAt);
      occurrence.endReason = 'epoch-ended';
      occurrence.endSeq = null;
    }
  }
  return all.sort((a, b) => a.seq - b.seq);
}

/** Whether two derived occurrences are the same in everything stored. */
export const sameDerived = (a: Derived, b: Derived): boolean =>
  a.seq === b.seq &&
  a.code === b.code &&
  a.severity === b.severity &&
  a.source === b.source &&
  a.raisedAt === b.raisedAt &&
  a.endedAt === b.endedAt &&
  a.endReason === b.endReason &&
  a.endSeq === b.endSeq;

/**
 * The earliest instant whose KPIs a change from `before` to `after` (either may be absent) can
 * affect, or null when it affects none. A raise changes nothing before it; a moved end nothing
 * before the earlier of the two ends, except fleeting, which belongs to the raise's bucket.
 */
export function earliestEffect(
  before: Derived | undefined,
  after: Derived | undefined,
  fleetingMs: Millis,
): Millis | null {
  if (!before || !after) return (before ?? after)?.raisedAt ?? null;
  if (before.raisedAt !== after.raisedAt || before.code !== after.code) {
    return Math.min(before.raisedAt, after.raisedAt);
  }
  const fleeting = (d: Derived): boolean =>
    d.endReason === 'cleared' && d.endedAt !== null && d.endedAt - d.raisedAt < fleetingMs;
  if (fleeting(before) !== fleeting(after)) return after.raisedAt;
  if (before.endedAt === after.endedAt) return null;
  return Math.min(before.endedAt ?? Infinity, after.endedAt ?? Infinity);
}
