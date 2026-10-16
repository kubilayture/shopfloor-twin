/**
 * Alarm KPIs per bucket (ADR-0024). A bucket is a half-open range [from, to) on whole UTC hours:
 * an hour, a shift or a `no-shift` stretch. A raise belongs to the bucket that contains its
 * `raisedAt`; time measures are clipped to the bucket and, while it is not over, to `asOf`.
 */
import { fraction, type Fraction } from '@shopfloor/oee-core';
import { floodEpisodes, type FloodEpisode } from './floods.ts';
import {
  HOUR,
  PRIORITIES,
  prepare,
  type AlarmKpiConfig,
  type Horizon,
  type Millis,
  type Occurrence,
  type Prepared,
  type PreparedSet,
  type Priority,
} from './occurrences.ts';

export interface Bucket {
  readonly from: Millis;
  readonly to: Millis;
}

/** A flood episode as one bucket sees it at its end. */
export interface BucketFlood {
  readonly id: string;
  readonly startAt: Millis;
  /** Flood time inside the bucket. */
  readonly floodMs: Millis;
  /** The highest count from the episode's start to the bucket's end. */
  readonly peak: number;
  /** Still in flood at the bucket's end. */
  readonly open: boolean;
  /** The final attributes, in the bucket where the episode ends. */
  readonly ended: { readonly endAt: Millis; readonly peak: number; readonly raises: number } | null;
}

export interface StandingAlarm {
  readonly equipment: string;
  readonly code: string;
  readonly seq: number;
  readonly raisedAt: Millis;
}

export interface BucketKpis extends Bucket {
  readonly raises: number;
  readonly byPriority: Readonly<Record<Priority, number>>;
  /** Raises per `windowMs`, averaged over the whole bucket: raises × windowMs / length. */
  readonly averageRate: Fraction;
  /** Fixed windows aligned on the hour (:00, :10, …). */
  readonly windows: number;
  readonly peak10: number;
  readonly floodWindows: number;
  readonly floods: readonly BucketFlood[];
  readonly floodMs: Millis;
  readonly activeAtEnd: number;
  readonly standing: readonly StandingAlarm[];
  readonly chatteringRaises: number;
  /** `equipment/code` of the points that chattered in the bucket, sorted. */
  readonly chatteringPoints: readonly string[];
  readonly fleeting: number;
  /** Open, younger than `fleetingMs` at `asOf`: might still turn out fleeting. */
  readonly fleetingUndecided: number;
  readonly activeMs: Millis;
  /** The bucket may still change: it is not over at `asOf`, or a fleeting raise is undecided. */
  readonly provisional: boolean;
}

const isWholeHour = (at: Millis): boolean => Number.isSafeInteger(at) && at % HOUR === 0;

function checkBucket(bucket: Bucket): void {
  if (!isWholeHour(bucket.from) || !isWholeHour(bucket.to) || bucket.to <= bucket.from) {
    throw new RangeError(
      `a bucket is a non-empty range on whole UTC hours, got [${String(bucket.from)}, ${String(bucket.to)})`,
    );
  }
}

const clip = (from: Millis, to: Millis, lower: Millis, upper: Millis): Millis => {
  const start = from > lower ? from : lower;
  const end = to < upper ? to : upper;
  return end > start ? end - start : 0;
};

/** Whether an occurrence is active at `instant` (raised at or before it, not ended by it). */
const activeAt = (occurrence: Prepared, instant: Millis): boolean =>
  occurrence.raisedAt <= instant && (occurrence.endAt === null || occurrence.endAt > instant);

function bucketFloods(
  episodes: readonly FloodEpisode[],
  bucket: Bucket,
  end: Millis,
): BucketFlood[] {
  return (
    episodes
      // An episode is listed when it is in flood at some known instant of the bucket: an open one
      // only while the bucket has begun by `asOf` (a bucket after `asOf` lists nothing).
      .filter(
        (episode) =>
          episode.startAt < bucket.to &&
          (episode.endAt === null ? end >= bucket.from : episode.endAt > bucket.from),
      )
      .map((episode) => {
        const endsHere = episode.endAt !== null && episode.endAt <= end;
        let peak = 0;
        for (const raise of episode.counts) {
          if (raise.at < bucket.to && raise.count > peak) {
            peak = raise.count;
          }
        }
        return {
          id: episode.id,
          startAt: episode.startAt,
          floodMs: clip(episode.startAt, episode.endAt ?? end, bucket.from, end),
          peak,
          open: !endsHere,
          ended: endsHere
            ? { endAt: episode.endAt, peak: episode.peak, raises: episode.raises }
            : null,
        };
      })
  );
}

/** The KPIs of one bucket from a prepared scope and its flood episodes. */
export function kpisOfBucket(
  set: PreparedSet,
  episodes: readonly FloodEpisode[],
  bucket: Bucket,
): BucketKpis {
  checkBucket(bucket);
  const { occurrences, config, asOf, closedAt } = set;
  // The bucket's end as far as it is known: its end, or `asOf` while it is not over.
  const end = closedAt === null && asOf < bucket.to ? asOf : bucket.to;
  const inBucket = occurrences.filter(
    (occurrence) => occurrence.raisedAt >= bucket.from && occurrence.raisedAt < bucket.to,
  );

  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<Priority, number>;
  for (const occurrence of inBucket) {
    byPriority[occurrence.priority] += 1;
  }

  let windows = 0;
  let peak10 = 0;
  let floodWindows = 0;
  for (let start = bucket.from; start < bucket.to; start += config.windowMs) {
    const count = inBucket.filter(
      (occurrence) => occurrence.raisedAt >= start && occurrence.raisedAt < start + config.windowMs,
    ).length;
    windows += 1;
    peak10 = count > peak10 ? count : peak10;
    floodWindows += count > config.floodThreshold ? 1 : 0;
  }

  const floods = bucketFloods(episodes, bucket, end);
  const atEnd = occurrences.filter(
    (occurrence) => occurrence.raisedAt < bucket.to && activeAt(occurrence, end),
  );
  const standing = atEnd
    .filter((occurrence) => end - occurrence.raisedAt >= config.standingMs)
    .map(({ equipment, code, seq, raisedAt }) => ({ equipment, code, seq, raisedAt }));
  const chattering = inBucket.filter((occurrence) => occurrence.chattering);
  const fleeting = inBucket.filter(
    (occurrence) =>
      occurrence.endReason === 'cleared' &&
      occurrence.endAt !== null &&
      occurrence.endAt - occurrence.raisedAt < config.fleetingMs,
  ).length;
  // A clear after `asOf` can still make an open raise fleeting while asOf < raisedAt + fleeting − 1.
  const fleetingUndecided = inBucket.filter(
    (occurrence) => occurrence.endAt === null && occurrence.raisedAt + config.fleetingMs - 1 > asOf,
  ).length;
  let activeMs = 0;
  for (const occurrence of occurrences) {
    activeMs += clip(occurrence.raisedAt, occurrence.endAt ?? end, bucket.from, end);
  }

  return {
    from: bucket.from,
    to: bucket.to,
    raises: inBucket.length,
    byPriority,
    averageRate: fraction(
      BigInt(inBucket.length) * BigInt(config.windowMs),
      BigInt(bucket.to - bucket.from),
    ),
    windows,
    peak10,
    floodWindows,
    floods,
    floodMs: floods.reduce((sum, flood) => sum + flood.floodMs, 0),
    activeAtEnd: atEnd.length,
    standing,
    chatteringRaises: chattering.length,
    chatteringPoints: [...new Set(chattering.map((occurrence) => occurrence.point))].sort(),
    fleeting,
    fleetingUndecided,
    activeMs,
    provisional: (closedAt === null && asOf < bucket.to) || fleetingUndecided > 0,
  };
}

/** The KPIs of a scope for each bucket, all from one horizon. */
export function bucketKpis(
  occurrences: readonly Occurrence[],
  buckets: readonly Bucket[],
  horizon: Horizon,
  config: AlarmKpiConfig,
): BucketKpis[] {
  const set = prepare(occurrences, horizon, config);
  const episodes = floodEpisodes(set);
  return buckets.map((bucket) => kpisOfBucket(set, episodes, bucket));
}

/** The UTC hours of [from, to), both on whole hours. */
export function hoursOf(bucket: Bucket): Bucket[] {
  checkBucket(bucket);
  const hours: Bucket[] = [];
  for (let from = bucket.from; from < bucket.to; from += HOUR) {
    hours.push({ from, to: from + HOUR });
  }
  return hours;
}

/**
 * A bucket composed of hours (a shift, or the hours of a `no-shift` stretch), exactly: counts,
 * flood time, active time and windows add up; `peak10` and each episode's peak are maxima; the
 * state at the end (open floods, active, standing) is the last hour's. Hours must be in order.
 */
export function composeBuckets(hours: readonly BucketKpis[], config: AlarmKpiConfig): BucketKpis {
  const first = hours[0];
  const last = hours.at(-1);
  if (first === undefined || last === undefined) {
    throw new RangeError('compose at least one bucket');
  }
  const sum = (value: (kpis: BucketKpis) => number): number =>
    hours.reduce((total, kpis) => total + value(kpis), 0);
  const max = (value: (kpis: BucketKpis) => number): number =>
    hours.reduce((top, kpis) => (value(kpis) > top ? value(kpis) : top), 0);

  const floods = new Map<string, BucketFlood>();
  for (const kpis of hours) {
    for (const flood of kpis.floods) {
      const before = floods.get(flood.id);
      floods.set(flood.id, {
        id: flood.id,
        startAt: flood.startAt,
        floodMs: (before?.floodMs ?? 0) + flood.floodMs,
        peak: before !== undefined && before.peak > flood.peak ? before.peak : flood.peak,
        open: flood.open,
        ended: flood.ended ?? before?.ended ?? null,
      });
    }
  }
  const raises = sum((kpis) => kpis.raises);
  const length = sum((kpis) => kpis.to - kpis.from);
  return {
    from: first.from,
    to: last.to,
    raises,
    byPriority: Object.fromEntries(
      PRIORITIES.map((p) => [p, sum((kpis) => kpis.byPriority[p])]),
    ) as Record<Priority, number>,
    averageRate: fraction(BigInt(raises) * BigInt(config.windowMs), BigInt(length)),
    windows: sum((kpis) => kpis.windows),
    peak10: max((kpis) => kpis.peak10),
    floodWindows: sum((kpis) => kpis.floodWindows),
    floods: [...floods.values()],
    floodMs: sum((kpis) => kpis.floodMs),
    activeAtEnd: last.activeAtEnd,
    standing: last.standing,
    chatteringRaises: sum((kpis) => kpis.chatteringRaises),
    chatteringPoints: [...new Set(hours.flatMap((kpis) => kpis.chatteringPoints))].sort(),
    fleeting: sum((kpis) => kpis.fleeting),
    fleetingUndecided: sum((kpis) => kpis.fleetingUndecided),
    activeMs: sum((kpis) => kpis.activeMs),
    provisional: hours.some((kpis) => kpis.provisional),
  };
}
