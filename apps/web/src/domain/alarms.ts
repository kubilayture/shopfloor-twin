import type {
  AlarmConfig,
  AlarmKpiBucketDto,
  AlarmOccurrenceDto,
  AlarmPointDto,
  AlarmShelfDto,
  OperatorBucketDto,
  Ratio,
} from '@shopfloor/contracts/mes-api';
import { fraction } from '@shopfloor/oee-core';
import type { AlarmScopeRef, AlarmViewName } from '../api/client.ts';
import type { LiveAlarms } from '../live/live-cache.ts';
import { minutesText, NOT_APPLICABLE, parseFraction, type BucketFlag } from './oee.ts';
import { writeFailure, type WriteFailure } from './writes.ts';
import { countOf } from './words.ts';

/**
 * Alarm lists and KPIs (#145, ADR-0024). The MES owns every value: the screen partitions the
 * occurrences by the API's `state` and the point's shelf, and shows the KPIs' integers, fractions
 * and four-decimal strings as sent. Anything derived (a mean, a benchmark comparison) is exact
 * BigInt arithmetic.
 */

export type AlarmView = AlarmViewName;
export type Priority = AlarmOccurrenceDto['priority'];

export const ALARM_VIEW_LABELS: Readonly<Record<AlarmView, string>> = {
  active: 'Active',
  acknowledged: 'Acknowledged',
  shelved: 'Shelved',
  history: 'History',
};

export const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** An alarm point's key: `equipment/code`, as the KPIs name chattering points. */
export const pointKey = (equipment: string, code: string): string => `${equipment}/${code}`;

// ---- The live merge (monotonic upserts by id) ----

const STATE_RANK: Readonly<Record<AlarmOccurrenceDto['state'], number>> = {
  'unacked-active': 0,
  'acked-active': 1,
  'unacked-cleared': 1,
  closed: 2,
};

/**
 * Whether copy `a` of an occurrence is behind copy `b`: `b` has taken a step that never goes
 * back and `a` has not. The steps are acknowledged (ISA-18.2: monotonic, #143), ended, final, more
 * comments (append-only) and a later state (closed after anything else).
 */
export function isBehind(a: AlarmOccurrenceDto, b: AlarmOccurrenceDto): boolean {
  return (
    (b.acknowledged !== null && a.acknowledged === null) ||
    (b.endedAt !== null && a.endedAt === null) ||
    (b.final && !a.final) ||
    b.comments > a.comments ||
    STATE_RANK[b.state] > STATE_RANK[a.state]
  );
}

/**
 * The copy to keep of one occurrence id: `incoming` (a push, or the later read), unless `known` is
 * strictly ahead of it (ahead in a step and behind in none). The MES pushes an occurrence's
 * messages in commit order, each with its whole state, so a later push is never older; the rule
 * guards a REST answer read before a push but arriving after it, and a write's answer arriving
 * after the push of a later change. Two copies each ahead in a different step (a stale answer
 * racing a push) can't be ordered: the incoming one is kept, and the next push or read settles it.
 */
export function newerOccurrence(
  known: AlarmOccurrenceDto,
  incoming: AlarmOccurrenceDto,
): AlarmOccurrenceDto {
  return isBehind(incoming, known) && !isBehind(known, incoming) ? known : incoming;
}

/** The copy to keep of one point: the higher shelf `version` (ties: `incoming`). */
export function newerPoint(known: AlarmPointDto, incoming: AlarmPointDto): AlarmPointDto {
  return incoming.shelf.version >= known.shelf.version ? incoming : known;
}

/** The newer of two shelves of one point, by version. */
export function newerShelf(
  a: AlarmShelfDto | undefined,
  b: AlarmShelfDto | undefined,
): AlarmShelfDto | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.version > a.version ? b : a;
}

/** Shown occurrences and points: the REST reads with the pushed upserts applied. */
export interface AlarmSet {
  readonly occurrences: readonly AlarmOccurrenceDto[];
  readonly points: ReadonlyMap<string, AlarmPointDto>;
}

/** The REST lists and points merged with the live upserts (`newerOccurrence`, `newerPoint`). */
export function mergeAlarms(
  rest: readonly (readonly AlarmOccurrenceDto[])[],
  restPoints: readonly AlarmPointDto[],
  live: LiveAlarms | undefined,
): AlarmSet {
  const byId = new Map<string, AlarmOccurrenceDto>();
  for (const list of rest) {
    for (const occurrence of list) {
      const known = byId.get(occurrence.id);
      byId.set(occurrence.id, known ? newerOccurrence(known, occurrence) : occurrence);
    }
  }
  for (const occurrence of Object.values(live?.occurrences ?? {})) {
    const known = byId.get(occurrence.id);
    byId.set(occurrence.id, known ? newerOccurrence(known, occurrence) : occurrence);
  }
  const points = new Map<string, AlarmPointDto>();
  for (const point of restPoints) points.set(pointKey(point.equipment, point.code), point);
  for (const [key, point] of Object.entries(live?.points ?? {})) {
    const known = points.get(key);
    points.set(key, known ? newerPoint(known, point) : point);
  }
  return { occurrences: [...byId.values()], points };
}

/** Whether the occurrence's point is shelved: the point's shelf (versioned) when known. */
export function isShelved(
  occurrence: AlarmOccurrenceDto,
  points: ReadonlyMap<string, AlarmPointDto>,
): boolean {
  const point = points.get(pointKey(occurrence.equipment, occurrence.code));
  return point ? point.shelf.shelved : occurrence.shelved;
}

/**
 * The view an occurrence belongs to, as `GET /alarms?view=` partitions them (ADR-0024): closed in
 * history; else shelved when its point is; else acknowledged while active; else active (not
 * acknowledged, also once cleared: a clear does not acknowledge).
 */
export function viewOf(occurrence: AlarmOccurrenceDto, shelved: boolean): AlarmView {
  if (occurrence.state === 'closed') return 'history';
  if (shelved) return 'shelved';
  if (occurrence.state === 'acked-active') return 'acknowledged';
  return 'active';
}

/** Newest raise first (as the API lists them), then by id for a stable order. */
export function compareOccurrences(a: AlarmOccurrenceDto, b: AlarmOccurrenceDto): number {
  return Date.parse(b.raisedAt) - Date.parse(a.raisedAt) || (a.id < b.id ? 1 : -1);
}

/**
 * The alarm list's orders (#371, ISA-18.2): `priority` puts the highest priority first, within
 * one the still-active alarms before the cleared ones, then the newest raise first; `raised` is
 * the newest raise first alone. Which one a view shows by default: `defaultSort`.
 */
export const ALARM_SORTS = ['priority', 'raised'] as const;
export type AlarmSort = (typeof ALARM_SORTS)[number];

/** History is a record of closed alarms, read by time; the live views by priority. */
export const defaultSort = (view: AlarmView): AlarmSort =>
  view === 'history' ? 'raised' : 'priority';

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { high: 0, medium: 1, low: 2 };

/** 0 while the condition is still active, 1 once it cleared (or closed). */
const clearedRank = (occurrence: AlarmOccurrenceDto): number =>
  occurrence.state === 'unacked-active' || occurrence.state === 'acked-active' ? 0 : 1;

/**
 * Highest priority first; within one, active before cleared; then newest raise first, then by id
 * (`compareOccurrences`).
 */
export function comparePriority(a: AlarmOccurrenceDto, b: AlarmOccurrenceDto): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    clearedRank(a) - clearedRank(b) ||
    compareOccurrences(a, b)
  );
}

/** A view's occurrences in the chosen order, as a new list. */
export function sortAlarms(
  occurrences: readonly AlarmOccurrenceDto[],
  sort: AlarmSort,
): AlarmOccurrenceDto[] {
  return [...occurrences].sort(sort === 'raised' ? compareOccurrences : comparePriority);
}

/** The merged occurrences per view, each newest first. */
export function partition(set: AlarmSet): Record<AlarmView, AlarmOccurrenceDto[]> {
  const views: Record<AlarmView, AlarmOccurrenceDto[]> = {
    active: [],
    acknowledged: [],
    shelved: [],
    history: [],
  };
  for (const occurrence of set.occurrences) {
    views[viewOf(occurrence, isShelved(occurrence, set.points))].push(occurrence);
  }
  for (const list of Object.values(views)) list.sort(compareOccurrences);
  return views;
}

/** Not acknowledged and not closed: an acknowledgement would change it. */
export const acknowledgeable = (occurrence: AlarmOccurrenceDto): boolean =>
  occurrence.acknowledged === null && occurrence.state !== 'closed';

export function stateText(occurrence: AlarmOccurrenceDto): string {
  switch (occurrence.state) {
    case 'unacked-active':
      return 'Active, unacknowledged';
    case 'acked-active':
      return 'Active, acknowledged';
    case 'unacked-cleared':
      return 'Cleared, unacknowledged';
    case 'closed':
      return 'Closed';
  }
}

export function endReasonText(reason: AlarmOccurrenceDto['endReason']): string {
  switch (reason) {
    case 'cleared':
      return 'cleared by the device';
    case 'lost':
      return 'clear lost, closed by a resync';
    case 'superseded':
      return 'superseded by the next raise';
    case 'epoch-ended':
      return 'ended with its simulator run';
    case null:
      return 'still active';
  }
}

// ---- Writes ----

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Whole hours, else whole minutes, else seconds: `8 h`, `90 min`, `45 s`. */
export function durationLabel(ms: number): string {
  if (ms % HOUR === 0) return `${String(ms / HOUR)} h`;
  if (ms % MINUTE === 0) return `${String(ms / MINUTE)} min`;
  return `${String(ms / 1000)} s`;
}

/**
 * The KPI window as a label (#147, from the PR #164 review): `10 min` for the served `windowMs` of
 * `GET /alarms/config` (#160), and `window` until it arrived, so no label claims a length the MES
 * did not serve.
 */
export function windowLabel(windowMs: number | undefined): string {
  return windowMs === undefined ? 'window' : durationLabel(windowMs);
}

/** The shelving presets of the plan ("API, push and web") before the limit is applied. */
const PRESET_MS = [15 * MINUTE, HOUR, 4 * HOUR, 8 * HOUR] as const;

export interface ShelvePreset {
  readonly ms: number;
  readonly label: string;
}

/**
 * Shelving presets capped at the MES's real limit (`GET /alarms/config`, alarms.yaml's
 * `maxShelveMs`, #160): the plan's presets from `minShelveMs` up to the limit, and the limit itself
 * when it is not one of them, so the longest allowed shelf can always be picked and none is
 * refused with 422.
 */
export function shelvePresets(
  config: Pick<AlarmConfig, 'maxShelveMs' | 'minShelveMs'>,
): ShelvePreset[] {
  const ms: number[] = PRESET_MS.filter((p) => p >= config.minShelveMs && p <= config.maxShelveMs);
  if (!ms.includes(config.maxShelveMs)) ms.push(config.maxShelveMs);
  return ms.map((value) => ({ ms: value, label: durationLabel(value) }));
}

export function ackFailure(error: unknown): WriteFailure {
  return writeFailure(error, {
    not: 'Not acknowledged',
    what: 'this acknowledgement',
    conflict: 'the alarm changed meanwhile; it was read again.',
  });
}

export function commentFailure(error: unknown): WriteFailure {
  return writeFailure(error, {
    not: 'Comment not saved',
    what: 'this comment',
    conflict: 'the alarm changed meanwhile; it was read again.',
  });
}

export function shelfFailure(error: unknown, action: 'shelve' | 'unshelve'): WriteFailure {
  return writeFailure(error, {
    not: action === 'shelve' ? 'Not shelved' : 'Not unshelved',
    what: action === 'shelve' ? 'this shelf' : 'this unshelve',
    conflict:
      "the point's shelf changed since it was read (someone else shelved or unshelved it, or its time ran out). It was read again; check it and try again.",
  });
}

// ---- KPIs ----

/** A scope's key in topics and search parameters: `plant`, `position:<id>`, `equipment:<id>`. */
export const scopeKey = (ref: AlarmScopeRef): string =>
  ref.scope === 'plant' ? 'plant' : `${ref.scope}:${ref.id}`;

/** `scopeKey` back to a scope, or undefined for anything else. */
export function parseScopeKey(key: string | undefined): AlarmScopeRef | undefined {
  if (key === 'plant') return { scope: 'plant', id: 'plant' };
  const match = /^(position|equipment):([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(key ?? '');
  if (!match) return undefined;
  return { scope: match[1] as 'position' | 'equipment', id: match[2] ?? '' };
}

/**
 * The flood banner's explanation, from the served `floodThreshold` and `windowMs` (#160): `Up to 14
 * raises in 10 min (more than 10 is a flood)`.
 */
export function floodText(
  peak: number,
  kpi: Pick<AlarmConfig['kpi'], 'floodThreshold' | 'windowMs'>,
): string {
  return `Up to ${String(peak)} raises in ${durationLabel(kpi.windowMs)} (more than ${String(kpi.floodThreshold)} is a flood)`;
}

export type RateBand = 'acceptable' | 'manageable' | 'over';

const TEN_MINUTES = 10n * BigInt(MINUTE);

/**
 * The average rate against the ISA-18.2 / EEMUA 191 benchmarks served by the MES (alarms.yaml's
 * `benchmarks`, per 10 minutes, #160). `averageRate` is per KPI window (`windowMs`), so it is
 * scaled to 10 minutes first; compared exactly on the API's fraction.
 */
export function rateBand(
  rate: Ratio,
  config: Pick<AlarmConfig, 'benchmarks'> & { readonly kpi: Pick<AlarmConfig['kpi'], 'windowMs'> },
): RateBand {
  const value = parseFraction(rate.fraction);
  // rate per window × 10 min / window ≤ benchmark  ⇔  num × 10 min ≤ benchmark × den × window
  const scaled = value.num * TEN_MINUTES;
  const per = value.den * BigInt(config.kpi.windowMs);
  if (scaled <= BigInt(config.benchmarks.acceptablePer10Min) * per) return 'acceptable';
  if (scaled <= BigInt(config.benchmarks.manageablePer10Min) * per) return 'manageable';
  return 'over';
}

/**
 * The EEMUA 191 verdict of a rate band (UX-4b, #325; design system 2.3): its tone and its word.
 * Colour only for abnormal: a benchmark met is normal, so Acceptable is `neutral`; Manageable is a
 * `warn`, Over the benchmark an `alarm`. One mapping for every screen that shows the verdict (the
 * alarm KPIs, the shift report).
 */
export const RATE_VERDICT: Readonly<
  Record<RateBand, { readonly tone: 'neutral' | 'warn' | 'alarm'; readonly label: string }>
> = {
  acceptable: { tone: 'neutral', label: 'Acceptable' },
  manageable: { tone: 'warn', label: 'Manageable' },
  over: { tone: 'alarm', label: 'Over the benchmark' },
};

/** A rate band as text, with the served benchmarks (#160). */
export function rateBandText(band: RateBand, config: Pick<AlarmConfig, 'benchmarks'>): string {
  const { acceptablePer10Min: acceptable, manageablePer10Min: manageable } = config.benchmarks;
  switch (band) {
    case 'acceptable':
      return `${RATE_VERDICT.acceptable.label} (≤ ${String(acceptable)} per 10 min)`;
    case 'manageable':
      return `${RATE_VERDICT.manageable.label} (≤ ${String(manageable)} per 10 min)`;
    case 'over':
      return `${RATE_VERDICT.over.label} (> ${String(manageable)} per 10 min)`;
  }
}

/** Final, provisional, revision and incidents of an alarm KPI bucket, as text. */
export function alarmBucketFlags(bucket: AlarmKpiBucketDto): BucketFlag[] {
  const flags: BucketFlag[] = [];
  if (bucket.final) {
    flags.push({ key: 'final', text: 'Final', title: 'Nothing that can still arrive changes it' });
  } else {
    flags.push({
      key: 'provisional',
      text:
        bucket.fleetingUndecided > 0
          ? `Provisional (${String(bucket.fleetingUndecided)} fleeting undecided)`
          : 'Provisional',
      title: bucket.provisional
        ? 'Not over at the plant clock, or a raise may still turn out fleeting'
        : 'Over, but its equipment is not yet final through its end',
    });
  }
  if (bucket.revision > 0) {
    flags.push({
      key: 'revision',
      text: `Revision ${String(bucket.revision)}`,
      title: 'Changed after it was final (late data)',
    });
  }
  if (bucket.incidents > 0) {
    flags.push({
      key: 'incidents',
      text: countOf(bucket.incidents, 'incident'),
      title: 'Sequence gaps reported over its hours',
    });
  }
  return flags;
}

/** Exact milliseconds as minutes (`12.5 min`); null is `n/a`. */
export const msText = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? NOT_APPLICABLE : minutesText(ms);

/** The mean time to acknowledge, `sumMs / count` exactly, as minutes; `n/a` without any. */
export function meanTimeToAck(timeToAck: OperatorBucketDto['timeToAck']): string {
  if (timeToAck.count === 0) return NOT_APPLICABLE;
  return minutesText(fraction(BigInt(timeToAck.sumMs), BigInt(timeToAck.count)));
}

/**
 * One hour of a shift on the alarm KPI screen (UX-4b, #325): the MES's hour bucket, or none when
 * the MES did not list the hour. It lists only the hours where something happened and the hour in
 * progress (ADR-0024); any other hour is the empty bucket, so it is shown as "No alarm activity",
 * without an invented finality.
 */
export interface AlarmHourRow {
  /** The hour start (ISO 8601 UTC), the MES's hour bucket key. */
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly bucket: AlarmKpiBucketDto | undefined;
}

/**
 * Every hour of `range` that ended by the plant clock's hour (`clock`), aligned on the hour as the
 * MES's buckets are, each with the bucket of the same start from `buckets` (REST with the pushed
 * one over it). The hour the clock is in is left to the MES, which always lists the hour in
 * progress (ADR-0024), so a fresh hour never shows as "No alarm activity" before its bucket
 * arrives. Without a clock nothing is filled. A bucket outside those hours is kept in its place:
 * the MES's list is never shortened.
 */
export function alarmShiftHours(
  buckets: readonly AlarmKpiBucketDto[],
  range: { readonly from: number; readonly to: number },
  clock: number | undefined,
): AlarmHourRow[] {
  const byFrom = new Map<number, AlarmKpiBucketDto | undefined>(
    buckets.map((bucket) => [Date.parse(bucket.from), bucket]),
  );
  const end = clock === undefined ? range.from : Math.min(range.to, hourStart(clock));
  for (let hour = hourStart(range.from); hour < end; hour += HOUR) {
    if (!byFrom.has(hour)) byFrom.set(hour, undefined);
  }
  return [...byFrom.entries()]
    .sort(([a], [b]) => a - b)
    .map(([from, bucket]): AlarmHourRow => {
      const start = new Date(from).toISOString();
      return bucket
        ? { key: bucket.key, from: bucket.from, to: bucket.to, bucket }
        : { key: start, from: start, to: new Date(from + HOUR).toISOString(), bucket: undefined };
    });
}

const hourStart = (ms: number): number => Math.floor(ms / HOUR) * HOUR;
