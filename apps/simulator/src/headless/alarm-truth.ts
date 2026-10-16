/**
 * The alarm part of the ground truth (#140, ADR-0024): every alarm occurrence the plant raised,
 * and the alarm KPIs per operator position and for the plant, per UTC hour and per shift bucket,
 * with flood episodes and bad actors. It uses `alarm-core` exactly as the MES does (#142):
 *
 * - one occurrence per device raise, paired with the next clear of the same (equipment, code);
 * - `seq` is the occurrence's index in its machine's alarm events: it rises with the machine's
 *   emission order, which is all `alarm-core` needs of the device sequence (ADR-0024). It is not
 *   the device's number, so the summary never shows it;
 * - priorities from `alarms.yaml`, or from the severity for a code without a definition;
 * - positions from `alarms.yaml`; the plant scope is every occurrence;
 * - the horizon is the run's time so far (`asOf`); the run's epoch is never closed here.
 *
 * Hours are listed only when something happened in them (a raise, active time or a flood), and
 * the hour in progress always (provisional); any other hour is the empty bucket. Shift buckets are every shift instance and `no-shift`
 * stretch the run covers, composed from their hours with `composeBuckets`.
 */
import {
  HOUR,
  badActors,
  composeBuckets,
  floodEpisodes,
  kpisOfBucket,
  prepare,
  priorityFromSeverity,
  scopeOccurrences,
  type AlarmKpiConfig,
  type BadActor,
  type BucketKpis,
  type Occurrence,
  type Position,
  type Priority,
} from '@shopfloor/alarm-core';
import { formatFraction, toDecimal, type Fraction } from '@shopfloor/oee-core';
import type { PlantConfig } from '@shopfloor/plant-config';
import { NO_SHIFT, shiftBoundaries, shiftSegments } from '@shopfloor/shift-calendar';
import type { SimTime } from '@shopfloor/sim-core';
import type { PlantEvent } from '../plant/line.ts';
import { isoTime } from './serialize.ts';

const DAY = 24 * HOUR;

const floorHour = (time: SimTime): SimTime => time - (((time % HOUR) + HOUR) % HOUR);
const ceilHour = (time: SimTime): SimTime => {
  const floor = floorHour(time);
  return floor === time ? time : floor + HOUR;
};

export interface RatioJson {
  readonly fraction: string;
  readonly decimal: string;
}

const ratio = (value: Fraction): RatioJson => ({
  fraction: formatFraction(value),
  decimal: toDecimal(value),
});

export interface AlarmOccurrenceJson {
  readonly equipment: string;
  readonly code: string;
  readonly priority: Priority;
  readonly severity: number;
  readonly raisedAt: string;
  readonly clearedAt: string | null;
  /** `cleared`, or null while active at the end of the run. */
  readonly endReason: string | null;
}

export interface BucketFloodJson {
  readonly id: string;
  readonly startAt: string;
  readonly floodMs: number;
  readonly peak: number;
  readonly open: boolean;
  readonly ended: { readonly endAt: string; readonly peak: number; readonly raises: number } | null;
}

export interface AlarmKpisJson {
  readonly from: string;
  readonly to: string;
  readonly raises: number;
  readonly byPriority: Readonly<Record<Priority, number>>;
  readonly averageRate: RatioJson;
  readonly windows: number;
  readonly peak10: number;
  readonly floodWindows: number;
  readonly floods: readonly BucketFloodJson[];
  readonly floodMs: number;
  readonly activeAtEnd: number;
  readonly standing: readonly {
    readonly equipment: string;
    readonly code: string;
    readonly raisedAt: string;
  }[];
  readonly chatteringRaises: number;
  readonly chatteringPoints: readonly string[];
  readonly fleeting: number;
  readonly fleetingUndecided: number;
  readonly activeMs: number;
  readonly provisional: boolean;
}

export interface FloodEpisodeJson {
  readonly id: string;
  readonly startAt: string;
  readonly equipment: string;
  readonly code: string;
  readonly endAt: string | null;
  readonly peak: number;
  readonly raises: number;
}

export interface BadActorJson {
  readonly equipment: string;
  readonly code: string;
  readonly raises: number;
  readonly share: RatioJson;
  readonly activeMs: number;
  readonly chatteringRaises: number;
}

export interface AlarmScopeJson {
  /** Keyed by the hour's start, ISO 8601 UTC; only hours where something happened. */
  readonly hours: Record<string, AlarmKpisJson>;
  /** Every shift instance (`2026-10-12/A`) and `no-shift` stretch (`no-shift/{start}`). */
  readonly shifts: Record<string, AlarmKpisJson>;
  readonly floods: readonly FloodEpisodeJson[];
  readonly badActors: {
    /** The top 10 of the run so far. */
    readonly run: readonly BadActorJson[];
    readonly shifts: Record<string, readonly BadActorJson[]>;
  };
}

export interface AlarmSummary {
  readonly config: AlarmKpiConfig;
  readonly positions: Record<string, { readonly workCenters: readonly string[] }>;
  /** Every occurrence in raise order (time, equipment, machine order, code). */
  readonly occurrences: readonly AlarmOccurrenceJson[];
  /** `plant` and each position. */
  readonly scopes: Record<string, AlarmScopeJson>;
}

interface Recorded extends Occurrence {
  readonly severity: number;
  clearedAt: SimTime | null;
}

const BAD_ACTORS = 10;

function kpisJson(kpis: BucketKpis): AlarmKpisJson {
  return {
    from: isoTime(kpis.from),
    to: isoTime(kpis.to),
    raises: kpis.raises,
    byPriority: { ...kpis.byPriority },
    averageRate: ratio(kpis.averageRate),
    windows: kpis.windows,
    peak10: kpis.peak10,
    floodWindows: kpis.floodWindows,
    floods: kpis.floods.map((flood) => ({
      id: flood.id,
      startAt: isoTime(flood.startAt),
      floodMs: flood.floodMs,
      peak: flood.peak,
      open: flood.open,
      ended:
        flood.ended === null
          ? null
          : {
              endAt: isoTime(flood.ended.endAt),
              peak: flood.ended.peak,
              raises: flood.ended.raises,
            },
    })),
    floodMs: kpis.floodMs,
    activeAtEnd: kpis.activeAtEnd,
    standing: kpis.standing.map(({ equipment, code, raisedAt }) => ({
      equipment,
      code,
      raisedAt: isoTime(raisedAt),
    })),
    chatteringRaises: kpis.chatteringRaises,
    chatteringPoints: [...kpis.chatteringPoints],
    fleeting: kpis.fleeting,
    fleetingUndecided: kpis.fleetingUndecided,
    activeMs: kpis.activeMs,
    provisional: kpis.provisional,
  };
}

const badActorJson = (actor: BadActor): BadActorJson => ({
  equipment: actor.equipment,
  code: actor.code,
  raises: actor.raises,
  share: ratio(actor.share),
  activeMs: actor.activeMs,
  chatteringRaises: actor.chatteringRaises,
});

const isEmpty = (kpis: BucketKpis): boolean =>
  kpis.raises === 0 && kpis.activeMs === 0 && kpis.floods.length === 0 && kpis.activeAtEnd === 0;

export class AlarmTruth {
  readonly #config: AlarmKpiConfig;
  readonly #shifts: PlantConfig['shifts'];
  readonly #start: SimTime;
  readonly #positions: Position[];
  readonly #positionWorkCenters: Record<string, { workCenters: string[] }>;
  readonly #priorities = new Map<string, Priority>();
  readonly #occurrences: Recorded[] = [];
  readonly #open = new Map<string, Recorded>();
  readonly #events = new Map<string, number>();

  constructor(config: PlantConfig, start: SimTime) {
    this.#config = { ...config.alarms.kpi };
    this.#shifts = config.shifts;
    this.#start = start;
    const workCenters = new Map(
      config.plant.areas.flatMap((area) =>
        area.workCenters.map((wc) => [wc.id, wc.equipment.map((e) => e.id)] as const),
      ),
    );
    this.#positions = config.alarms.positions.map((position) => ({
      id: position.id,
      equipment: position.workCenters.flatMap((id) => workCenters.get(id) ?? []),
    }));
    this.#positionWorkCenters = Object.fromEntries(
      config.alarms.positions.map((position) => [
        position.id,
        { workCenters: [...position.workCenters] },
      ]),
    );
    for (const definition of config.alarms.definitions) {
      this.#priorities.set(`${definition.equipment}/${definition.code}`, definition.priority);
    }
  }

  record(event: PlantEvent): void {
    if (event.type !== 'alarm') {
      return;
    }
    const seq = (this.#events.get(event.machineId) ?? 0) + 1;
    this.#events.set(event.machineId, seq);
    const key = `${event.machineId}/${event.code}`;
    if (event.transition === 'active') {
      const occurrence: Recorded = {
        equipment: event.machineId,
        code: event.code,
        priority: this.#priorities.get(key) ?? priorityFromSeverity(event.severity),
        severity: event.severity,
        seq,
        raisedAt: event.at,
        clearedAt: null,
      };
      this.#occurrences.push(occurrence);
      this.#open.set(key, occurrence);
    } else {
      const open = this.#open.get(key);
      if (open) {
        open.clearedAt = event.at;
        this.#open.delete(key);
      }
    }
  }

  /** The alarm section at `now`, without changing anything. */
  summary(now: SimTime): AlarmSummary {
    const occurrences: Occurrence[] = this.#occurrences.map((o) => ({ ...o }));
    const severity = new Map(this.#occurrences.map((o) => [`${o.equipment}/${String(o.seq)}`, o]));
    const horizon = { asOf: now };
    const from = floorHour(this.#start);
    const to = ceilHour(now);
    const hours: { from: SimTime; to: SimTime }[] = [];
    for (let hour = from; hour < to; hour += HOUR) {
      hours.push({ from: hour, to: hour + HOUR });
    }
    const segments = shiftSegments(this.#shifts, from, to).map((segment) => ({
      ...segment,
      key: segment.key === NO_SHIFT ? this.#noShiftKey(segment.from) : segment.key,
    }));

    const scopes: Record<string, AlarmScopeJson> = {};
    let plantOrder: AlarmOccurrenceJson[] = [];
    for (const [scope, members] of scopeOccurrences(occurrences, this.#positions)) {
      const set = prepare(members, horizon, this.#config);
      const episodes = floodEpisodes(set);
      const hourKpis = new Map(
        hours.map((bucket) => [bucket.from, kpisOfBucket(set, episodes, bucket)]),
      );
      const hoursJson: Record<string, AlarmKpisJson> = {};
      for (const [hour, kpis] of hourKpis) {
        // The hour in progress is always listed (provisional), even when nothing happened yet.
        if (!isEmpty(kpis) || (hour < now && now < hour + HOUR)) {
          hoursJson[isoTime(hour)] = kpisJson(kpis);
        }
      }
      const shifts: Record<string, AlarmKpisJson> = {};
      const shiftActors: Record<string, BadActorJson[]> = {};
      for (const segment of segments) {
        const parts = hours
          .filter((hour) => hour.from >= segment.from && hour.from < segment.to)
          .map((hour) => hourKpis.get(hour.from))
          .filter((kpis): kpis is BucketKpis => kpis !== undefined);
        shifts[segment.key] = kpisJson(composeBuckets(parts, this.#config));
        shiftActors[segment.key] = badActors(set, segment, BAD_ACTORS).map(badActorJson);
      }
      scopes[scope] = {
        hours: hoursJson,
        shifts,
        floods: episodes.map((episode) => ({
          id: episode.id,
          startAt: isoTime(episode.startAt),
          equipment: episode.equipment,
          code: episode.code,
          endAt: episode.endAt === null ? null : isoTime(episode.endAt),
          peak: episode.peak,
          raises: episode.raises,
        })),
        badActors: {
          run: badActors(set, { from, to }, BAD_ACTORS).map(badActorJson),
          shifts: shiftActors,
        },
      };
      if (scope === 'plant') {
        plantOrder = set.occurrences.map((o) => ({
          equipment: o.equipment,
          code: o.code,
          priority: o.priority,
          severity: severity.get(`${o.equipment}/${String(o.seq)}`)?.severity ?? 0,
          raisedAt: isoTime(o.raisedAt),
          clearedAt: o.clearedAt === null ? null : isoTime(o.clearedAt),
          endReason: o.endReason,
        }));
      }
    }
    return {
      config: { ...this.#config },
      positions: this.#positionWorkCenters,
      occurrences: plantOrder,
      scopes,
    };
  }

  /**
   * A `no-shift` stretch is keyed by where the calendar starts it: the last shift end at or
   * before `from` (within a week), so the key doesn't depend on when the run started. When no
   * shift ended in the 7 days before `from` (a calendar without workdays nearby), the key falls
   * back to `from` itself, the stretch's start in this run.
   */
  #noShiftKey(from: SimTime): string {
    const ends = shiftBoundaries(this.#shifts, from - 7 * DAY, from + 1).filter(
      (boundary) => boundary.action === 'shift-end',
    );
    return `${NO_SHIFT}/${isoTime(ends.at(-1)?.at ?? from)}`;
  }
}
