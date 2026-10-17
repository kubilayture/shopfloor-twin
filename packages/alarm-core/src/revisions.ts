/**
 * Revision spans (ADR-0024, plan "Revisions"): which hours a late fact can change. The windowed
 * KPIs reach past the hour of the fact, so a late fact revises every final hour it can change, not
 * only its own. The caller intersects the hours with its final hours.
 */
import { floodEpisodes } from './floods.ts';
import { HOUR, pointKey, type Millis, type PreparedSet } from './occurrences.ts';

/**
 * A late fact:
 * - `raise`: a raise that arrived after hours it can change were final, with its clear if known;
 * - `end`: the end of an occurrence moved: a late clear (`before: null`, it was open), a lost clear
 *   closed by a resync snapshot, or a real clear replacing the snapshot's end. `null` is open.
 */
export type LateFact =
  | {
      readonly kind: 'raise';
      readonly equipment: string;
      readonly code: string;
      readonly raisedAt: Millis;
      readonly clearedAt: Millis | null;
    }
  | {
      readonly kind: 'end';
      readonly raisedAt: Millis;
      readonly before: Millis | null;
      readonly after: Millis | null;
    };

/** A closed span [from, to]: every hour with an instant in it is revised. */
export interface Span {
  readonly from: Millis;
  readonly to: Millis;
}

const later = (a: Millis, b: Millis): Millis => (a > b ? a : b);

/**
 * The spans a late fact can change, given the scope after the fact (`set`, prepared with it).
 * Pass the plant scope: every position's flood is inside one of the plant's episodes.
 *
 * - **Late raise at t:** [t, t + max(windowMs, chatterWindowMs)] (windows, floods and the
 *   chattering of later raises); its active span to its clear, or to the limit while open; the
 *   span of an earlier occurrence of the same point that it now supersedes, from that
 *   occurrence's raise to its clear (fleeting is decided in its raise's hour); and every flood
 *   episode in flood during [t, t + windowMs], to its end or the limit, since one raise can join
 *   two episodes and change the id and peak of every later hour of the joined one.
 * - **Moved end:** from the raise to the later of the two ends (open is the limit): active time,
 *   standing and active-at-end change between the ends, fleeting in the raise's hour, and the
 *   plan's raise→clear span is included.
 */
export function revisionSpans(fact: LateFact, set: PreparedSet): Span[] {
  const { limit, config } = set;
  if (fact.kind === 'end') {
    return [{ from: fact.raisedAt, to: later(fact.before ?? limit, fact.after ?? limit) }];
  }
  const t = fact.raisedAt;
  const reach = later(config.windowMs, config.chatterWindowMs);
  const spans: Span[] = [
    { from: t, to: t + reach },
    { from: t, to: fact.clearedAt ?? limit },
  ];
  const point = pointKey(fact.equipment, fact.code);
  for (const occurrence of set.occurrences) {
    if (
      occurrence.point === point &&
      occurrence.raisedAt <= t &&
      (occurrence.clearedAt ?? limit) > t
    ) {
      // From its own raise: its end moves to t, which changes fleeting in its raise's hour and
      // active at end of the hour that ends at t (#192).
      spans.push({ from: occurrence.raisedAt, to: occurrence.clearedAt ?? limit });
    }
  }
  for (const episode of floodEpisodes(set)) {
    const end = episode.endAt ?? limit;
    if (episode.startAt <= t + config.windowMs && end >= t) {
      spans.push({ from: episode.startAt, to: end });
    }
  }
  return spans;
}

/** The start of every UTC hour with an instant in one of the spans, at or before `limit`. */
export function revisedHours(fact: LateFact, set: PreparedSet): Millis[] {
  const hours = new Set<Millis>();
  for (const span of revisionSpans(fact, set)) {
    const to = span.to < set.limit ? span.to : set.limit;
    const first = span.from - (((span.from % HOUR) + HOUR) % HOUR);
    for (let hour = first; hour <= to; hour += HOUR) {
      hours.add(hour);
    }
  }
  return [...hours].sort((a, b) => a - b);
}
