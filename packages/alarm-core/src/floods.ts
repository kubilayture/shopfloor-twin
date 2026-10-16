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
  /**
   * `{startAt}~{equipment}~{code}` of the starting raise; the caller adds the scope. Episodes of a
   * scope never overlap, so the start alone is unique; the point makes the id readable. It needs
   * no device `seq`, so the ground truth and the MES agree on it by construction.
   */
  readonly id: string;
  readonly startAt: Millis;
  /** The starting raise's point. */
  readonly equipment: string;
  readonly code: string;
  /** The first instant out of flood; null while the episode is open at `asOf`. */
  readonly endAt: Millis | null;
  /** The highest count in the window during the episode, so far. */
  readonly peak: number;
  /** The raises from the starting raise until the end, so far. */
  readonly raises: number;
  /** Every raise of the episode with its count, in order. */
  readonly counts: readonly FloodRaise[];
}

export const floodId = (startAt: Millis, equipment: string, code: string): string =>
  `${String(startAt)}~${equipment}~${code}`;

interface Building {
  startAt: Millis;
  equipment: string;
  code: string;
  counts: FloodRaise[];
}

function finish(episode: Building, endAt: Millis | null): FloodEpisode {
  let peak = 0;
  for (const raise of episode.counts) {
    peak = raise.count > peak ? raise.count : peak;
  }
  return {
    id: floodId(episode.startAt, episode.equipment, episode.code),
    startAt: episode.startAt,
    equipment: episode.equipment,
    code: episode.code,
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
    // The raises of this instant, with their counts. They join a running episode only if it is
    // still in flood after them: an episode that ends at this instant covers [start, end), so a
    // raise at its end instant was never in flood.
    const arrivals: FloodRaise[] = [];
    let started: Building | null = null;
    for (
      let raise = occurrences[arrived];
      raise?.raisedAt === instant;
      raise = occurrences[arrived]
    ) {
      count += 1;
      arrived += 1;
      if (current === null && started === null && count > floodThreshold) {
        started = { startAt: instant, equipment: raise.equipment, code: raise.code, counts: [] };
      }
      if (current !== null || started !== null) {
        arrivals.push({ at: instant, count });
      }
    }
    if (current !== null && count <= floodThreshold) {
      episodes.push(finish(current, instant));
      current = null;
    } else if (current !== null) {
      current.counts.push(...arrivals);
    } else if (started !== null) {
      started.counts.push(...arrivals);
      current = started;
    }
  }
  if (current !== null) {
    episodes.push(finish(current, closedAt));
  }
  return episodes;
}
