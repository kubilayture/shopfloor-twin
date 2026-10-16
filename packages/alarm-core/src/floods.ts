/**
 * Flood episodes (ADR-0024), sliding: the count at instant t is the number of raises in
 * (t − windowMs, t]. A flood starts at the raise that makes the count exceed `floodThreshold` and
 * ends at the first instant where the count is back at or below it, which is when its oldest
 * counted raise leaves the window. At one instant the raises that leave go first, then the raises
 * of that instant arrive in raise order, so the second of three raises in one millisecond already
 * sees two; the flood state at an instant is the count after all of them.
 */
import type { Millis, PreparedSet } from './occurrences.ts';

export interface FloodRaise {
  readonly at: Millis;
  /** The count in the window right after this raise arrived. */
  readonly count: number;
}

export interface FloodEpisode {
  /** `{startAt}~{equipment}~{seq}` of the starting raise; the caller adds the scope. */
  readonly id: string;
  readonly startAt: Millis;
  readonly equipment: string;
  readonly code: string;
  readonly seq: number;
  /** The first instant out of flood; null while the episode is open at `asOf`. */
  readonly endAt: Millis | null;
  /** The highest count in the window during the episode, so far. */
  readonly peak: number;
  /** The raises from the starting raise until the end, so far. */
  readonly raises: number;
  /** Every raise of the episode with its count, in order. */
  readonly counts: readonly FloodRaise[];
}

export const floodId = (startAt: Millis, equipment: string, seq: number): string =>
  `${String(startAt)}~${equipment}~${String(seq)}`;

interface Building {
  startAt: Millis;
  equipment: string;
  code: string;
  seq: number;
  counts: FloodRaise[];
}

function finish(episode: Building, endAt: Millis | null): FloodEpisode {
  let peak = 0;
  for (const raise of episode.counts) {
    peak = raise.count > peak ? raise.count : peak;
  }
  return {
    id: floodId(episode.startAt, episode.equipment, episode.seq),
    startAt: episode.startAt,
    equipment: episode.equipment,
    code: episode.code,
    seq: episode.seq,
    endAt,
    peak,
    raises: episode.counts.length,
    counts: episode.counts,
  };
}

/**
 * Every flood episode of a scope up to `asOf`, in start order. An episode still in flood at
 * `asOf` is open (`endAt: null`); in a closed epoch it ends at `closedAt`.
 */
export function floodEpisodes(set: PreparedSet): FloodEpisode[] {
  const { occurrences, limit, closedAt, config } = set;
  const { windowMs, floodThreshold } = config;
  const episodes: FloodEpisode[] = [];
  let current: Building | null = null;
  let count = 0;
  let arrived = 0;
  let departed = 0;
  for (;;) {
    const arrival = occurrences[arrived];
    const departure = departed < arrived ? occurrences[departed] : undefined;
    const nextArrival = arrival?.raisedAt;
    const nextDeparture = departure === undefined ? undefined : departure.raisedAt + windowMs;
    const instant =
      nextArrival === undefined
        ? nextDeparture
        : nextDeparture === undefined || nextArrival < nextDeparture
          ? nextArrival
          : nextDeparture;
    if (instant === undefined || instant > limit) {
      break;
    }
    while (departed < arrived && (occurrences[departed]?.raisedAt ?? 0) + windowMs === instant) {
      count -= 1;
      departed += 1;
    }
    for (
      let raise = occurrences[arrived];
      raise?.raisedAt === instant;
      raise = occurrences[arrived]
    ) {
      count += 1;
      arrived += 1;
      if (current === null && count > floodThreshold) {
        current = {
          startAt: instant,
          equipment: raise.equipment,
          code: raise.code,
          seq: raise.seq,
          counts: [],
        };
      }
      current?.counts.push({ at: instant, count });
    }
    if (current !== null && count <= floodThreshold) {
      episodes.push(finish(current, instant));
      current = null;
    }
  }
  if (current !== null) {
    episodes.push(finish(current, closedAt));
  }
  return episodes;
}
