/**
 * The `alarms` module (#142, ADR-0024 "Occurrences"): alarm occurrences derived from the device's
 * raise and clear facts, anchors and resync snapshots (through `Ingest`'s interface), stored in the
 * `alarms` schema; finality per (equipment, epoch) from "final through" as for equipment intervals
 * (ADR-0018 amendment); revisions of final KPI hours per scope; KPIs computed on read with
 * `alarm-core`, never stored.
 */
import {
  HOUR,
  badActors,
  composeBuckets,
  floodEpisodes,
  kpisOfBucket,
  prepare,
  priorityFromSeverity,
  revisedHours,
  type AlarmKpiConfig,
  type BadActor,
  type BucketKpis,
  type FloodEpisode,
  type LateFact,
  type Millis,
  type Occurrence,
  type PreparedSet,
  type Priority,
} from '@shopfloor/alarm-core';
import { NO_SHIFT, shiftSegments, type ShiftPattern } from '@shopfloor/shift-calendar';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import type { Equipment } from '../equipment/index.ts';
import type {
  AlarmFact,
  GapIncident,
  Ingest,
  IngestNotice,
  SettledState,
} from '../ingest/index.ts';
import type { AlarmDefinition, MasterData } from '../master-data/index.ts';
import {
  alarmHourBuckets,
  alarmShiftBuckets,
  hourEnd,
  hourStart,
  noShiftKey,
  type AlarmBucket,
} from './buckets.ts';
import {
  deriveOccurrences,
  earliestEffect,
  sameDerived,
  type Derived,
  type DeviceTransition,
} from './derive.ts';
import type { AlarmOccurrenceTable, EndReason, UsedAnchor, UsedSnapshot } from './tables.ts';

export type AlarmScope = 'plant' | 'position' | 'equipment';
export type AlarmBucketKind = 'hour' | 'shift';

/** What the module reads from the other modules (their `index.ts` interfaces). */
export interface AlarmSources {
  readonly ingest: Pick<
    Ingest,
    | 'onStored'
    | 'alarmFacts'
    | 'alarmFactCounts'
    | 'alarmAnchors'
    | 'alarmSnapshots'
    | 'settled'
    | 'factSummary'
  >;
  readonly equipment: Pick<Equipment, 'epochEnd' | 'watermark' | 'watermarks'>;
  readonly masterData: Pick<MasterData, 'equipment' | 'alarmDefinitions' | 'alarmPositions'>;
}

export interface AlarmsLog {
  info(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface AlarmsOptions extends AlarmSources {
  /** Writes (occurrences, sources, revisions), on ingest's acknowledgement path. */
  readonly db: Kysely<Database>;
  /** Reads for the API (its own pool with a statement timeout, ADR-0019); default `db`. */
  readonly readDb?: Kysely<Database>;
  readonly shiftPattern: ShiftPattern;
  /** `alarms.yaml` → `kpi`. */
  readonly config: AlarmKpiConfig;
  readonly log?: AlarmsLog;
}

/** One occurrence as the API reads it. */
export interface AlarmOccurrence {
  /** `{equipment}~{epoch}~{seq}`. */
  readonly id: string;
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  readonly code: string;
  readonly severity: number;
  readonly priority: Priority;
  /** False for a code without a definition: its priority comes from its severity. */
  readonly defined: boolean;
  readonly text: string | null;
  readonly source: 'fact' | 'anchor';
  readonly raisedAt: Date;
  readonly endedAt: Date | null;
  readonly endReason: EndReason | null;
  readonly endSeq: number | null;
  /** Its raise and its end (or, open, the absence of one) can no longer change. */
  readonly final: boolean;
}

/** A device or MES event in an occurrence's history. */
export interface AlarmHistoryEntry {
  readonly source: 'fact' | 'anchor' | 'snapshot' | 'mes';
  readonly transition: 'raised' | 'cleared' | 'lost' | 'superseded' | 'epoch-ended';
  readonly at: Date;
  readonly seq: number | null;
  readonly receivedAt: Date | null;
  readonly protocol: string | null;
}

export interface AlarmChange {
  readonly type: 'occurrence';
  readonly event: 'raised' | 'cleared' | 'updated';
  readonly occurrence: AlarmOccurrence;
}

export interface AlarmFinalityChange {
  readonly type: 'finality';
  readonly equipment: string;
  readonly epoch: number;
}

export interface AlarmListQuery {
  /** `active`: not ended; `history`: ended (cleared, lost, superseded or epoch-ended). */
  readonly view: 'active' | 'history';
  readonly position?: string | undefined;
  readonly equipment?: string | undefined;
  readonly priority?: Priority | undefined;
  /** Raise time range [from, to). */
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly limit: number;
  /** Continue after this occurrence (the list is by raise time, newest first). */
  readonly after?: { readonly raisedAt: Date; readonly id: string } | undefined;
}

export interface AlarmKpiQuery {
  readonly scope: AlarmScope;
  /** A position or equipment id; `plant` for the plant. */
  readonly id: string;
  readonly bucket: AlarmBucketKind;
  readonly from: Date;
  readonly to: Date;
  /** Default: the newest epoch of the scope's equipment. */
  readonly epoch?: number | undefined;
}

/** The KPIs of one scope over one hour or shift bucket. */
export interface AlarmKpiBucket {
  readonly scope: AlarmScope;
  readonly id: string;
  readonly bucket: AlarmBucketKind;
  /** The hour start (ISO 8601) or the shift bucket key (`2026-10-12/A`, `no-shift/{start}`). */
  readonly key: string;
  readonly epoch: number;
  readonly kpis: BucketKpis;
  /** Nothing that can still arrive changes it (every member final through its end + fleetingMs). */
  readonly final: boolean;
  /** How often one of its hours changed after it was final (the highest). */
  readonly revision: number;
  /** Distinct sequence-gap incidents of the members over it. */
  readonly incidents: number;
}

export interface AlarmRangeQuery {
  readonly scope: AlarmScope;
  readonly id: string;
  readonly from: Date;
  readonly to: Date;
  readonly epoch?: number | undefined;
}

export interface ScopeInfo {
  readonly scope: AlarmScope;
  readonly id: string;
  readonly name: string;
  readonly equipment: readonly string[];
}

/** A gap incident's time span: the missing facts lie between `from` and `to`. */
interface IncidentSpan {
  readonly id: number;
  readonly from: Millis;
  readonly to: Millis;
}

interface Row extends Derived {
  readonly priority: Priority;
  readonly defined: boolean;
}

/** Per (equipment, epoch): what is known and stored. */
interface Track {
  readonly equipment: string;
  readonly epoch: number;
  /** Highest `seq` of the device stream with no open gap at or below it; null: unknown. */
  settledSeq: number | null;
  /** The latest fact time up to `settledSeq`: alarm facts at or before it are final. */
  finalThrough: Millis;
  /** As last stored in `occurrence_source.final_through` (what a restart will find final). */
  persistedFinal: Millis;
  closed: boolean;
  closedAt: Millis | null;
  incidents: readonly IncidentSpan[];
  /** The alarm facts by seq; undefined until loaded. */
  facts: Map<number, DeviceTransition> | undefined;
  /** The stored occurrences by raise seq; undefined until loaded. */
  rows: Map<number, Row> | undefined;
  anchors: UsedAnchor[];
  snapshot: UsedSnapshot | null;
  /** The snapshot the stored occurrences reflect (null: none applied). */
  appliedSnapshot: number | null;
  sourceStored: boolean;
}

/** How far a track was (or is) final, by which a change is judged late. */
type Bound = (track: Track | undefined) => Millis;

interface Scope {
  readonly kind: AlarmScope;
  readonly id: string;
  /** `plant`, `position:<id>` or `equipment:<id>`: the key of its revisions. */
  readonly key: string;
  readonly name: string;
  readonly members: readonly string[];
}

/** What one consistent read of a scope gives. */
interface ScopeView {
  readonly set: PreparedSet;
  readonly episodes: readonly FloodEpisode[];
  readonly revisions: ReadonlyMap<Millis, number>;
  readonly closed: boolean;
  readonly frontier: Millis;
  readonly incidents: readonly IncidentSpan[];
}

const silent: AlarmsLog = { info: () => undefined, error: () => undefined };

const UNSETTLED = { settledSeq: null, finalThrough: -Infinity, incidents: [] } as const;

export const occurrenceId = (equipment: string, epoch: number, seq: number): string =>
  `${equipment}~${String(epoch)}~${String(seq)}`;

/** `{equipment}~{epoch}~{seq}` → its parts, or undefined. */
export function parseOccurrenceId(
  id: string,
): { equipment: string; epoch: number; seq: number } | undefined {
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})~(\d{1,15})~(\d{1,15})$/.exec(id);
  if (!match) return undefined;
  const epoch = Number(match[2]);
  const seq = Number(match[3]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq)) return undefined;
  return { equipment: match[1] ?? '', epoch, seq };
}

const spans = (incidents: readonly GapIncident[]): IncidentSpan[] =>
  incidents.map((incident) => ({
    id: incident.id,
    from: incident.after?.getTime() ?? -Infinity,
    to: incident.before?.getTime() ?? Infinity,
  }));

const transition = (fact: AlarmFact): DeviceTransition => ({
  seq: fact.seq,
  code: fact.code,
  transition: fact.transition,
  severity: fact.severity,
  at: fact.sourceTime.getTime(),
});

const isEmpty = (kpis: BucketKpis): boolean =>
  kpis.raises === 0 && kpis.activeMs === 0 && kpis.floods.length === 0 && kpis.activeAtEnd === 0;

const sameRow = (a: Row, b: Row): boolean =>
  sameDerived(a, b) && a.priority === b.priority && a.defined === b.defined;

/** How far before a range occurrences are read for its windows and floods, at least. */
const LOOKBACK_MS = 2 * HOUR;

/**
 * Alarm occurrences, finality, revisions and KPIs on read (#142). Follows ingest's notices after
 * the equipment module (it must be started after it, so that a newer epoch is closed there first).
 */
export class Alarms {
  readonly #db: Kysely<Database>;
  readonly #readDb: Kysely<Database>;
  readonly #sources: AlarmSources;
  readonly #pattern: ShiftPattern;
  readonly #config: AlarmKpiConfig;
  readonly #log: AlarmsLog;
  readonly #tracks = new Map<string, Map<number, Track>>();
  readonly #dirty = new Set<Track>();
  readonly #listeners = new Set<(change: AlarmChange | AlarmFinalityChange) => void>();
  #definitions = new Map<string, AlarmDefinition>();
  #scopes = new Map<string, Scope>();
  #order: string[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #unsubscribe: (() => void) | undefined;

  constructor(options: AlarmsOptions) {
    this.#db = options.db;
    this.#readDb = options.readDb ?? options.db;
    this.#sources = options;
    this.#pattern = options.shiftPattern;
    this.#config = options.config;
    this.#log = options.log ?? silent;
  }

  get config(): AlarmKpiConfig {
    return this.#config;
  }

  get shiftPattern(): ShiftPattern {
    return this.#pattern;
  }

  /** Loads the catalog, catches up from the tables, then follows ingest's notices. */
  async start(): Promise<void> {
    await this.#loadCatalog();
    const caughtUp = this.#enqueue(() => this.#catchUp());
    this.#unsubscribe = this.#sources.ingest.onStored((notice) =>
      this.#enqueue(() => this.#handle(notice)),
    );
    await caughtUp;
  }

  /** Stops following notices and waits for the work in hand. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#queue;
  }

  /** Waits until every notice received so far is handled (tests, replays). */
  async flush(): Promise<void> {
    await this.#enqueue(() => Promise.resolve());
  }

  /**
   * Listens for stored occurrence changes and finality moves (synchronously, after the commit:
   * the listener must only record what changed, never read). Returns an unsubscribe.
   */
  onChange(listener: (change: AlarmChange | AlarmFinalityChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The plant, the operator positions and the equipment, as KPI scopes. */
  scopes(): ScopeInfo[] {
    return [...this.#scopes.values()].map((scope) => ({
      scope: scope.kind,
      id: scope.id,
      name: scope.name,
      equipment: scope.members,
    }));
  }

  /** One scope, or undefined when it doesn't exist. */
  scope(kind: AlarmScope, id: string): ScopeInfo | undefined {
    const scope = this.#scopes.get(this.#scopeKey(kind, id));
    return scope && { scope: scope.kind, id: scope.id, name: scope.name, equipment: scope.members };
  }

  /** The definition of an alarm point, if it has one. */
  definition(equipment: string, code: string): AlarmDefinition | undefined {
    return this.#definitions.get(`${equipment}/${code}`);
  }

  // ---- reads (the API's pool) ----

  /** Occurrences by raise time, newest first, up to `limit`. */
  async list(query: AlarmListQuery): Promise<AlarmOccurrence[]> {
    let select = this.#readDb.selectFrom('alarms.alarm_occurrence').selectAll();
    select =
      query.view === 'active'
        ? select.where('ended_at', 'is', null)
        : select.where('ended_at', 'is not', null);
    if (query.position !== undefined) {
      const members = this.#scopes.get(this.#scopeKey('position', query.position))?.members ?? [];
      if (members.length === 0) return [];
      select = select.where('equipment', 'in', members);
    }
    if (query.equipment !== undefined) select = select.where('equipment', '=', query.equipment);
    if (query.priority !== undefined) select = select.where('priority', '=', query.priority);
    if (query.from !== undefined) select = select.where('raised_at', '>=', query.from);
    if (query.to !== undefined) select = select.where('raised_at', '<', query.to);
    const after = query.after && parseOccurrenceId(query.after.id);
    if (query.after && after) {
      select = select.where(
        sql<boolean>`(raised_at, equipment, epoch, seq) < (${query.after.raisedAt}, ${after.equipment}, ${after.epoch}, ${after.seq})`,
      );
    }
    const rows = await select
      .orderBy('raised_at', 'desc')
      .orderBy('equipment', 'desc')
      .orderBy('epoch', 'desc')
      .orderBy('seq', 'desc')
      .limit(query.limit)
      .execute();
    return rows.map((row) => this.#view(row));
  }

  /** One occurrence by its id. */
  async occurrence(id: string): Promise<AlarmOccurrence | undefined> {
    const key = parseOccurrenceId(id);
    if (!key) return undefined;
    const row = await this.#readDb
      .selectFrom('alarms.alarm_occurrence')
      .selectAll()
      .where('equipment', '=', key.equipment)
      .where('epoch', '=', key.epoch)
      .where('seq', '=', key.seq)
      .executeTakeFirst();
    return row && this.#view(row);
  }

  /**
   * The device's raise and end of an occurrence (from ingest's facts: seq, sourceTime, receivedAt,
   * protocol; or the anchor or snapshot they came from), by time. MES transitions (acknowledge,
   * shelve, comment) join them with #143.
   */
  async history(id: string): Promise<AlarmHistoryEntry[] | undefined> {
    const occurrence = await this.occurrence(id);
    if (!occurrence) return undefined;
    const { equipment, epoch, seq, code } = occurrence;
    const facts = await this.#sources.ingest.alarmFacts(equipment, epoch, {
      code,
      fromSeq: seq,
      toSeq: occurrence.endSeq ?? seq,
    });
    const anchors = this.#tracks.get(equipment)?.get(epoch)?.anchors ?? [];
    const entry = (
      wanted: number,
      kind: 'raised' | 'cleared',
      fallbackAt: Date,
    ): AlarmHistoryEntry => {
      const fact = facts.find((f) => f.seq === wanted);
      if (fact) {
        return {
          source: 'fact',
          transition: kind,
          at: fact.sourceTime,
          seq: fact.seq,
          receivedAt: fact.receivedAt,
          protocol: fact.protocol,
        };
      }
      const anchor = anchors.find((a) => a.seq === wanted && a.code === code);
      return {
        source: 'anchor',
        transition: kind,
        at: anchor ? new Date(anchor.at) : fallbackAt,
        seq: wanted,
        receivedAt: null,
        protocol: null,
      };
    };
    const entries: AlarmHistoryEntry[] = [entry(seq, 'raised', occurrence.raisedAt)];
    const endedAt = occurrence.endedAt;
    if (endedAt) {
      switch (occurrence.endReason) {
        case 'cleared':
          entries.push(entry(occurrence.endSeq ?? seq, 'cleared', endedAt));
          break;
        case 'lost':
          entries.push({
            source: 'snapshot',
            transition: 'lost',
            at: endedAt,
            seq: occurrence.endSeq,
            receivedAt: null,
            protocol: null,
          });
          break;
        case 'superseded':
        case 'epoch-ended':
        case null:
          entries.push({
            source: 'mes',
            transition: occurrence.endReason ?? 'epoch-ended',
            at: endedAt,
            seq: occurrence.endSeq,
            receivedAt: null,
            protocol: null,
          });
          break;
      }
    }
    return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  /**
   * The KPIs of a scope per hour or shift bucket over [from, to) (ADR-0024): hours where
   * something happened and the hour in progress; every shift instance and `no-shift` stretch
   * (clipped to the range) that has begun by the plant clock. Read in one REPEATABLE READ
   * snapshot.
   */
  async kpis(query: AlarmKpiQuery): Promise<AlarmKpiBucket[]> {
    const scope = this.#scopeOf(query.scope, query.id);
    const epoch = query.epoch ?? this.#newestEpoch(scope.members);
    if (epoch === undefined) return [];
    const from = query.from.getTime();
    const to = query.to.getTime();
    const defs =
      query.bucket === 'hour'
        ? alarmHourBuckets(from, to)
        : alarmShiftBuckets(this.#pattern, from, to);
    const first = defs[0];
    const last = defs.at(-1);
    if (!first || !last) return [];
    const view = await this.#scopeView(scope, epoch, first.from, last.to);
    return this.#buckets(scope, epoch, query.bucket, defs, view);
  }

  /** Flood episodes of a scope in flood at some instant of [from, to), by start. */
  async floods(
    query: AlarmRangeQuery,
  ): Promise<{ epoch: number | null; episodes: FloodEpisode[] }> {
    const scope = this.#scopeOf(query.scope, query.id);
    const epoch = query.epoch ?? this.#newestEpoch(scope.members);
    if (epoch === undefined) return { epoch: null, episodes: [] };
    const from = query.from.getTime();
    const to = query.to.getTime();
    const view = await this.#scopeView(scope, epoch, hourStart(from), hourEnd(to));
    return {
      epoch,
      episodes: view.episodes.filter(
        (episode) => episode.startAt < to && (episode.endAt ?? view.set.limit + 1) > from,
      ),
    };
  }

  /** The top `limit` alarm points of a scope by raises in [from, to). */
  async badActors(
    query: AlarmRangeQuery & { readonly limit: number },
  ): Promise<{ epoch: number | null; actors: BadActor[] }> {
    const scope = this.#scopeOf(query.scope, query.id);
    const epoch = query.epoch ?? this.#newestEpoch(scope.members);
    if (epoch === undefined) return { epoch: null, actors: [] };
    const from = query.from.getTime();
    const to = query.to.getTime();
    const view = await this.#scopeView(scope, epoch, hourStart(from), hourEnd(to));
    return { epoch, actors: badActors(view.set, { from, to }, query.limit) };
  }

  /**
   * The hour and the shift bucket the plant clock is in, for one scope, and its flood episodes
   * still open (push, `alarm-kpi:<scope>`). Null where there is no clock.
   */
  async current(
    kind: AlarmScope,
    id: string,
  ): Promise<{
    hour: AlarmKpiBucket | null;
    shift: AlarmKpiBucket | null;
    floods: FloodEpisode[];
  }> {
    const scope = this.#scopeOf(kind, id);
    const clock = this.#sources.equipment.watermarks()[0];
    if (!clock) return { hour: null, shift: null, floods: [] };
    // The instant just before the watermark: at 07:00:00.000 the hour in progress is 06:00.
    const at = clock.watermark.getTime() - 1;
    const hour: AlarmBucket = {
      key: new Date(hourStart(at)).toISOString(),
      from: hourStart(at),
      to: hourStart(at) + HOUR,
    };
    const segment = shiftSegments(this.#pattern, at - 8 * 24 * HOUR, at + 1).at(-1);
    const shift: AlarmBucket =
      segment === undefined || segment.key === NO_SHIFT
        ? {
            key: noShiftKey(this.#pattern, segment?.from ?? hour.from),
            from: hourStart(segment?.from ?? hour.from),
            to: hour.to,
          }
        : { key: segment.key, from: segment.from, to: segment.to };
    const view = await this.#scopeView(
      scope,
      clock.epoch,
      Math.min(hour.from, shift.from),
      Math.max(hour.to, shift.to),
    );
    const [hourBucket] = this.#buckets(scope, clock.epoch, 'hour', [hour], view, true);
    const [shiftBucket] = this.#buckets(scope, clock.epoch, 'shift', [shift], view, true);
    return {
      hour: hourBucket ?? null,
      shift: shiftBucket ?? null,
      floods: view.episodes.filter((episode) => episode.endAt === null),
    };
  }

  // ---- reading helpers ----

  #scopeKey(kind: AlarmScope, id: string): string {
    return kind === 'plant' ? 'plant' : `${kind}:${id}`;
  }

  #scopeOf(kind: AlarmScope, id: string): Scope {
    const scope = this.#scopes.get(this.#scopeKey(kind, id));
    if (!scope) throw new RangeError(`no ${kind} ${id}`);
    return scope;
  }

  /** The newest epoch any of the members has. */
  #newestEpoch(members: readonly string[]): number | undefined {
    let newest: number | undefined;
    for (const equipment of members) {
      for (const epoch of this.#tracks.get(equipment)?.keys() ?? []) {
        if (newest === undefined || epoch > newest) newest = epoch;
      }
    }
    return newest;
  }

  /** How far a track's alarm facts are final now: everything once its epoch is closed. */
  readonly #live: Bound = (track) => {
    if (!track) return -Infinity;
    return track.closed ? Infinity : track.finalThrough;
  };

  #bound(track: Track | undefined): Millis {
    return this.#live(track);
  }

  /** The time every member is final through (the lowest), in one epoch, by `bound`. */
  #frontier(members: readonly string[], epoch: number, bound: Bound = this.#live): Millis {
    let frontier = Infinity;
    for (const equipment of members) {
      const at = bound(this.#tracks.get(equipment)?.get(epoch));
      if (at < frontier) frontier = at;
    }
    return members.length === 0 ? -Infinity : frontier;
  }

  /** Whether a bucket ending at `to` is final for a frontier (ADR-0024: end + fleetingMs). */
  #finalAt(to: Millis, frontier: Millis): boolean {
    return to + this.#config.fleetingMs <= frontier;
  }

  #view(row: {
    equipment: string;
    epoch: number;
    seq: number;
    code: string;
    severity: number;
    priority: Priority;
    defined: boolean;
    source: 'fact' | 'anchor';
    raised_at: Date;
    ended_at: Date | null;
    end_reason: EndReason | null;
    end_seq: number | null;
  }): AlarmOccurrence {
    const bound = this.#bound(this.#tracks.get(row.equipment)?.get(row.epoch));
    const raisedAt = row.raised_at.getTime();
    const endedAt = row.ended_at?.getTime() ?? null;
    return {
      id: occurrenceId(row.equipment, row.epoch, row.seq),
      equipment: row.equipment,
      epoch: row.epoch,
      seq: row.seq,
      code: row.code,
      severity: row.severity,
      priority: row.priority,
      defined: row.defined,
      text: this.definition(row.equipment, row.code)?.text ?? null,
      source: row.source,
      raisedAt: row.raised_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
      endSeq: row.end_seq,
      final: raisedAt <= bound && (endedAt === null ? bound === Infinity : endedAt <= bound),
    };
  }

  /**
   * One consistent read of a scope's occurrences for buckets in [from, to): every occurrence of
   * the epoch raised before `to` and raised, or still active, after a cut before `from`. The cut
   * is moved back until no flood episode is in flood one window after it: the flood state at an
   * instant depends only on the raises in the window before it, so from there on every episode,
   * window and chattering flag equals what all of the epoch's raises give.
   */
  async #scopeView(scope: Scope, epoch: number, from: Millis, to: Millis): Promise<ScopeView> {
    // Read before the rows: a later row is then newer than what these say, never older.
    const frontier = this.#frontier(scope.members, epoch);
    const watermark = this.#sources.equipment.watermark(epoch)?.getTime();
    const tracks = scope.members
      .map((equipment) => this.#tracks.get(equipment)?.get(epoch))
      .filter((track): track is Track => track !== undefined);
    const closed = tracks.length > 0 && tracks.every((track) => track.closed);
    const incidents = tracks.flatMap((track) => track.incidents);
    const { windowMs } = this.#config;
    return this.#readDb
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        let lookback = Math.max(LOOKBACK_MS, 2 * windowMs, 2 * this.#config.chatterWindowMs);
        for (;;) {
          const cut = from - lookback;
          const rows = await this.#occurrenceRows(trx, scope.members, epoch, cut, to);
          const set = this.#prepared(rows, watermark, closed, tracks);
          const episodes = floodEpisodes(set);
          const probe = cut + windowMs;
          const inFlood = episodes.some(
            (episode) => episode.startAt <= probe && (episode.endAt ?? Infinity) > probe,
          );
          if (!inFlood || !(await this.#raisedBefore(trx, scope.members, epoch, cut))) {
            const revisions = await trx
              .selectFrom('alarms.kpi_revision')
              .select(['hour', 'revision'])
              .where('scope', '=', scope.key)
              .where('epoch', '=', epoch)
              .where('hour', '>=', new Date(from))
              .where('hour', '<', new Date(to))
              .execute();
            return {
              set,
              episodes,
              revisions: new Map(revisions.map((r) => [r.hour.getTime(), r.revision])),
              closed,
              frontier,
              incidents,
            };
          }
          lookback *= 4;
        }
      });
  }

  async #occurrenceRows(
    db: Kysely<Database> | Transaction<Database>,
    members: readonly string[],
    epoch: number,
    cut: Millis,
    to: Millis,
  ): Promise<Occurrence[]> {
    if (members.length === 0) return [];
    const rows = await db
      .selectFrom('alarms.alarm_occurrence')
      .select(['equipment', 'code', 'priority', 'seq', 'raised_at', 'ended_at', 'end_reason'])
      .where('epoch', '=', epoch)
      .where('equipment', 'in', members)
      .where('raised_at', '<', new Date(to))
      .where((eb) =>
        eb.or([
          eb('raised_at', '>=', new Date(cut)),
          eb('ended_at', 'is', null),
          eb('ended_at', '>', new Date(cut)),
        ]),
      )
      .execute();
    return rows.map((row) => ({
      equipment: row.equipment,
      code: row.code,
      priority: row.priority,
      seq: row.seq,
      raisedAt: row.raised_at.getTime(),
      clearedAt: row.ended_at?.getTime() ?? null,
      // Only a device clear can be fleeting; a lost, superseded or epoch-ended end is no clear.
      clearKind: row.end_reason === 'cleared' ? ('device' as const) : ('lost' as const),
    }));
  }

  async #raisedBefore(
    db: Transaction<Database>,
    members: readonly string[],
    epoch: number,
    cut: Millis,
  ): Promise<boolean> {
    const row = await db
      .selectFrom('alarms.alarm_occurrence')
      .select('seq')
      .where('epoch', '=', epoch)
      .where('equipment', 'in', members)
      .where('raised_at', '<', new Date(cut))
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * `alarm-core`'s view of the rows: known up to the epoch's watermark (or the latest time read);
   * in a closed epoch up to its close, which is at or after everything stored.
   */
  #prepared(
    rows: readonly Occurrence[],
    watermark: Millis | undefined,
    closed: boolean,
    tracks: readonly Track[],
  ): PreparedSet {
    let latest = -Infinity;
    for (const row of rows) {
      latest = Math.max(latest, row.raisedAt, row.clearedAt ?? -Infinity);
    }
    let asOf = Math.max(watermark ?? -Infinity, latest);
    if (!Number.isFinite(asOf)) asOf = 0;
    let closedAt: Millis | null = null;
    if (closed) {
      closedAt = asOf;
      for (const track of tracks) closedAt = Math.max(closedAt, track.closedAt ?? -Infinity);
    }
    return prepare(rows, { asOf, closedAt }, this.#config);
  }

  /** The buckets of a scope from one view: hours with something in them (and in progress). */
  #buckets(
    scope: Scope,
    epoch: number,
    kind: AlarmBucketKind,
    defs: readonly AlarmBucket[],
    view: ScopeView,
    always = false,
  ): AlarmKpiBucket[] {
    const { set } = view;
    const cache = new Map<Millis, BucketKpis>();
    const hourKpis = (hour: Millis): BucketKpis => {
      let found = cache.get(hour);
      if (!found) {
        found = kpisOfBucket(set, view.episodes, { from: hour, to: hour + HOUR });
        cache.set(hour, found);
      }
      return found;
    };
    const inProgress = (from: Millis): boolean =>
      !view.closed && from < set.asOf && set.asOf < from + HOUR;
    // Buckets that have begun by the plant clock (the whole range in a closed epoch).
    const started = (from: Millis): boolean => view.closed || from < hourEnd(set.asOf);
    const result: AlarmKpiBucket[] = [];
    for (const def of defs) {
      if (!always && !started(def.from)) continue;
      const hours: BucketKpis[] = [];
      for (let hour = def.from; hour < def.to; hour += HOUR) hours.push(hourKpis(hour));
      const kpis = kind === 'hour' ? hours[0] : composeBuckets(hours, this.#config);
      if (!kpis) continue;
      if (kind === 'hour' && !always && isEmpty(kpis) && !inProgress(def.from)) continue;
      let revision = 0;
      for (let hour = def.from; hour < def.to; hour += HOUR) {
        revision = Math.max(revision, view.revisions.get(hour) ?? 0);
      }
      const incidents = new Set(
        view.incidents.filter((s) => s.from < def.to && s.to >= def.from).map((s) => s.id),
      );
      result.push({
        scope: scope.kind,
        id: scope.id,
        bucket: kind,
        key: def.key,
        epoch,
        kpis,
        final: this.#finalAt(def.to, view.frontier) && !kpis.provisional,
        revision,
        incidents: incidents.size,
      });
    }
    return result;
  }

  // ---- following ingest ----

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #emit(change: AlarmChange | AlarmFinalityChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure must not reach ingest's acknowledgement path.
      }
    }
  }

  async #loadCatalog(): Promise<void> {
    const { masterData } = this.#sources;
    const [equipment, positions, definitions] = await Promise.all([
      masterData.equipment(),
      masterData.alarmPositions(),
      masterData.alarmDefinitions(),
    ]);
    this.#order = equipment.map((info) => info.id);
    this.#definitions = new Map(definitions.map((d) => [`${d.equipment}/${d.code}`, d]));
    const scopes: Scope[] = [
      { kind: 'plant', id: 'plant', key: 'plant', name: 'Plant', members: this.#order },
      ...positions.map((position) => ({
        kind: 'position' as const,
        id: position.id,
        key: `position:${position.id}`,
        name: position.name,
        members: position.equipment,
      })),
      ...equipment.map((info) => ({
        kind: 'equipment' as const,
        id: info.id,
        key: `equipment:${info.id}`,
        name: info.name,
        members: [info.id],
      })),
    ];
    this.#scopes = new Map(scopes.map((scope) => [scope.key, scope]));
  }

  /** The scopes an equipment's occurrences belong to: the plant, its positions and itself. */
  #scopesOf(equipment: string): Scope[] {
    return [...this.#scopes.values()].filter((scope) => scope.members.includes(equipment));
  }

  async #handle(notice: IngestNotice): Promise<void> {
    await this.#retryDirty();
    let track: Track | undefined;
    try {
      switch (notice.type) {
        case 'cycle':
        case 'alarm-stale':
          // Anchors and snapshots once used stay part of their epoch's history.
          return;
        case 'epoch':
          await this.#track(notice.equipment, notice.epoch);
          return;
        case 'anchor':
          if (notice.anchor.deviceEpoch !== null) {
            await this.#track(notice.anchor.equipment, notice.anchor.deviceEpoch);
          }
          return;
        case 'state':
          track = await this.#track(notice.fact.equipment, notice.fact.epoch);
          await this.#learn(track, notice.settledSeq, {
            seq: notice.fact.seq,
            at: notice.fact.sourceTime.getTime(),
          });
          return;
        case 'sample': {
          const { sample } = notice;
          if (sample.scope === 'topic') {
            // Telemetry naming a newer run of its equipment ends the older ones (as in equipment).
            const epoch = sample.deviceEpoch;
            const newest = this.#newestEpoch([sample.equipment]);
            if (epoch !== null && (newest === undefined || epoch > newest)) {
              await this.#track(sample.equipment, epoch);
            }
            return;
          }
          // An alarm's own notice follows; its finality moves only once it is applied.
          if (sample.kind === 'alarm') return;
          track = await this.#track(sample.equipment, sample.epoch);
          await this.#learn(track, notice.settledSeq, {
            seq: sample.seq,
            at: sample.sourceTime.getTime(),
          });
          return;
        }
        case 'alarm': {
          track = await this.#track(notice.fact.equipment, notice.fact.epoch);
          await this.#load(track);
          track.facts?.set(notice.fact.seq, transition(notice.fact));
          // Before its finality moves: a fact above "final through" changes no final hour.
          await this.#rederive(track, true);
          await this.#learn(track, notice.settledSeq, {
            seq: notice.fact.seq,
            at: notice.fact.sourceTime.getTime(),
          });
          return;
        }
        case 'alarm-anchor': {
          const { anchor } = notice;
          if (anchor.stale) return;
          track = await this.#track(anchor.equipment, anchor.epoch);
          if (track.anchors.some((a) => a.seq === anchor.seq && a.code === anchor.code)) return;
          track.anchors = [
            ...track.anchors,
            {
              code: anchor.code,
              seq: anchor.seq,
              transition: anchor.transition,
              severity: anchor.severity,
              at: anchor.sourceTime.getTime(),
            },
          ].sort((a, b) => a.seq - b.seq);
          await this.#rederive(track, true);
          return;
        }
        case 'alarm-snapshot': {
          const { snapshot } = notice;
          if (snapshot.stale) return;
          track = await this.#track(snapshot.equipment, snapshot.deviceEpoch);
          if (track.snapshot && track.snapshot.asOfSeq >= snapshot.asOfSeq) return;
          track.snapshot = {
            asOfSeq: snapshot.asOfSeq,
            at: snapshot.sourceTime.getTime(),
            active: [...snapshot.active],
          };
          await this.#rederive(track, true);
          return;
        }
        case 'gaps':
          track = this.#tracks.get(notice.equipment)?.get(notice.epoch);
          if (!track) return;
          if (track.closed) {
            track.incidents = spans(
              (await this.#sources.ingest.settled(track.equipment, track.epoch)).incidents,
            );
            return;
          }
          await this.#learn(track, notice.settledSeq);
          return;
      }
    } catch (error) {
      // Recomputed from the tables before the next notice (or at the next start-up).
      if (track) this.#dirty.add(track);
      this.#log.error({ err: error, notice: notice.type }, 'alarm occurrences not updated');
    }
  }

  async #retryDirty(): Promise<void> {
    for (const track of [...this.#dirty]) {
      try {
        await this.#reload(track);
        this.#dirty.delete(track);
      } catch (error) {
        this.#log.error({ err: error, equipment: track.equipment }, 'alarm rebuild failed');
        return;
      }
    }
  }

  /** The track of (equipment, epoch); a newer epoch closes the equipment's older ones. */
  async #track(equipment: string, epoch: number): Promise<Track> {
    let byEpoch = this.#tracks.get(equipment);
    if (!byEpoch) {
      byEpoch = new Map();
      this.#tracks.set(equipment, byEpoch);
    }
    const existing = byEpoch.get(epoch);
    if (existing) return existing;
    const track = this.#newTrack(equipment, epoch);
    byEpoch.set(epoch, track);
    // A new track has no facts or rows stored yet (catch-up created every track with some).
    track.facts = new Map();
    track.rows = new Map();
    const newest = Math.max(...byEpoch.keys());
    if (epoch < newest) await this.#close(track);
    for (const older of byEpoch.values()) {
      if (older.epoch < epoch && !older.closed) await this.#close(older);
    }
    return track;
  }

  #newTrack(equipment: string, epoch: number): Track {
    return {
      equipment,
      epoch,
      ...UNSETTLED,
      persistedFinal: -Infinity,
      closed: false,
      closedAt: null,
      facts: undefined,
      rows: undefined,
      anchors: [],
      snapshot: null,
      appliedSnapshot: null,
      sourceStored: false,
    };
  }

  /**
   * A newer epoch of the equipment exists: what is still open ends at the old epoch's close, the
   * time the equipment module recorded (`interval_source.closed_at`), else the epoch's watermark,
   * else the latest time known in it.
   */
  async #close(track: Track): Promise<void> {
    track.closed = true;
    const end = this.#sources.equipment.epochEnd(track.equipment, track.epoch);
    const known = end.closedAt ?? this.#sources.equipment.watermark(track.epoch);
    track.closedAt = known?.getTime() ?? this.#latest(track);
    track.incidents = spans(
      (await this.#sources.ingest.settled(track.equipment, track.epoch)).incidents,
    );
    // Closing changes nothing before the close, which is at or after what was final: no revision.
    await this.#rederive(track, true, null);
    this.#emit({ type: 'finality', equipment: track.equipment, epoch: track.epoch });
  }

  /** The latest time the track knows of (facts and anchors), or null. */
  #latest(track: Track): Millis | null {
    let latest: Millis | null = null;
    for (const fact of track.facts?.values() ?? []) {
      latest = latest === null || fact.at > latest ? fact.at : latest;
    }
    for (const anchor of track.anchors) {
      latest = latest === null || anchor.at > latest ? anchor.at : latest;
    }
    return latest;
  }

  /** Loads the track's facts and stored rows when not in memory yet. */
  async #load(track: Track): Promise<void> {
    if (!track.facts) {
      const facts = await this.#sources.ingest.alarmFacts(track.equipment, track.epoch);
      track.facts = new Map(facts.map((fact) => [fact.seq, transition(fact)]));
    }
    if (!track.rows) {
      const rows = await this.#db
        .selectFrom('alarms.alarm_occurrence')
        .selectAll()
        .where('equipment', '=', track.equipment)
        .where('epoch', '=', track.epoch)
        .execute();
      track.rows = new Map(rows.map((row) => [row.seq, this.#fromTable(row)]));
    }
  }

  /** Reloads the facts from ingest and derives again (a missed notice, a failed write). */
  async #reload(track: Track): Promise<void> {
    track.facts = undefined;
    track.rows = undefined;
    await this.#rederive(track, true, this.#live);
  }

  #fromTable(row: {
    seq: number;
    code: string;
    severity: number;
    source: 'fact' | 'anchor';
    raised_at: Date;
    ended_at: Date | null;
    end_reason: EndReason | null;
    end_seq: number | null;
    priority: Priority;
    defined: boolean;
  }): Row {
    return {
      seq: row.seq,
      code: row.code,
      severity: row.severity,
      source: row.source,
      raisedAt: row.raised_at.getTime(),
      endedAt: row.ended_at?.getTime() ?? null,
      endReason: row.end_reason,
      endSeq: row.end_seq,
      priority: row.priority,
      defined: row.defined,
    };
  }

  #row(track: Track, derived: Derived): Row {
    const definition = this.definition(track.equipment, derived.code);
    return {
      ...derived,
      priority: definition?.priority ?? priorityFromSeverity(derived.severity),
      defined: definition !== undefined,
    };
  }

  /** The snapshot to apply: only once the stream is settled up to its `asOfSeq` (ADR-0017). */
  #applicable(track: Track): UsedSnapshot | null {
    const { snapshot } = track;
    return snapshot && track.settledSeq !== null && track.settledSeq >= snapshot.asOfSeq
      ? snapshot
      : null;
  }

  /**
   * Derives the track's occurrences from what it knows and stores the difference (one
   * transaction with its source row). A change that can affect an hour already final raises that
   * hour's revision in every scope of the equipment (`#revise`), in the same transaction, judged
   * by `revise`: what was final before the change (the live bounds, the bounds from before "final
   * through" moved, or what was stored before a restart); null: no revision (an epoch's close).
   */
  async #rederive(
    track: Track,
    saveSource: boolean,
    revise: Bound | null = this.#live,
  ): Promise<void> {
    await this.#load(track);
    const facts = track.facts ?? new Map<number, DeviceTransition>();
    const rows = track.rows ?? new Map<number, Row>();
    const snapshot = this.#applicable(track);
    const derived = deriveOccurrences(
      [...facts.values()],
      track.anchors,
      snapshot,
      track.closed ? { closedAt: track.closedAt } : null,
    ).map((d) => this.#row(track, d));
    const next = new Map(derived.map((row) => [row.seq, row]));
    const changes: { before: Row | undefined; after: Row | undefined }[] = [];
    for (const row of derived) {
      const before = rows.get(row.seq);
      if (!before || !sameRow(before, row)) changes.push({ before, after: row });
    }
    for (const [seq, before] of rows) {
      if (!next.has(seq)) changes.push({ before, after: undefined });
    }
    track.appliedSnapshot = snapshot?.asOfSeq ?? null;
    if (changes.length === 0 && !saveSource && track.sourceStored) return;
    const upserts = changes.flatMap((c) => (c.after ? [c.after] : []));
    const deletes = changes.flatMap((c) => (c.after ? [] : c.before ? [c.before.seq] : []));
    await this.#db.transaction().execute(async (trx) => {
      if (upserts.length > 0) {
        await trx
          .insertInto('alarms.alarm_occurrence')
          .values(upserts.map((row) => this.#tableRow(track, row)))
          .onConflict((oc) =>
            oc.columns(['equipment', 'epoch', 'seq']).doUpdateSet((eb) => ({
              code: eb.ref('excluded.code'),
              severity: eb.ref('excluded.severity'),
              priority: eb.ref('excluded.priority'),
              defined: eb.ref('excluded.defined'),
              source: eb.ref('excluded.source'),
              raised_at: eb.ref('excluded.raised_at'),
              ended_at: eb.ref('excluded.ended_at'),
              end_reason: eb.ref('excluded.end_reason'),
              end_seq: eb.ref('excluded.end_seq'),
              updated_at: sql<Date>`now()`,
            })),
          )
          .execute();
      }
      if (deletes.length > 0) {
        await trx
          .deleteFrom('alarms.alarm_occurrence')
          .where('equipment', '=', track.equipment)
          .where('epoch', '=', track.epoch)
          .where('seq', 'in', deletes)
          .execute();
      }
      // Revisions commit with the rows they follow from: a crash loses neither or both.
      if (revise && changes.length > 0) await this.#revise(trx, track, changes, revise);
      await this.#saveSource(trx, track);
    });
    track.rows = next;
    track.persistedFinal = Math.max(track.persistedFinal, track.finalThrough);
    if (changes.length === 0) return;
    for (const change of changes) {
      if (!change.after) continue;
      this.#emit({
        type: 'occurrence',
        event:
          change.before === undefined
            ? 'raised'
            : change.before.endedAt === null && change.after.endedAt !== null
              ? 'cleared'
              : 'updated',
        occurrence: this.#view(this.#tableRow(track, change.after)),
      });
    }
  }

  #tableRow(
    track: Track,
    row: Row,
  ): Omit<
    { [K in keyof AlarmOccurrenceTable]: AlarmOccurrenceTable[K] },
    'updated_at' | 'raised_at' | 'ended_at'
  > & {
    raised_at: Date;
    ended_at: Date | null;
  } {
    return {
      equipment: track.equipment,
      epoch: track.epoch,
      seq: row.seq,
      code: row.code,
      severity: row.severity,
      priority: row.priority,
      defined: row.defined,
      source: row.source,
      raised_at: new Date(row.raisedAt),
      ended_at: row.endedAt === null ? null : new Date(row.endedAt),
      end_reason: row.endReason,
      end_seq: row.endSeq,
    };
  }

  async #saveSource(trx: Transaction<Database>, track: Track): Promise<void> {
    const row = {
      equipment: track.equipment,
      epoch: track.epoch,
      facts: track.facts?.size ?? 0,
      anchors: JSON.stringify(track.anchors),
      snapshot: track.snapshot === null ? null : JSON.stringify(track.snapshot),
      closed: track.closed,
      closed_at: track.closedAt === null ? null : new Date(track.closedAt),
      final_through: Number.isFinite(track.finalThrough) ? new Date(track.finalThrough) : null,
    };
    await trx
      .insertInto('alarms.occurrence_source')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['equipment', 'epoch']).doUpdateSet({
          facts: row.facts,
          anchors: row.anchors,
          snapshot: row.snapshot,
          closed: row.closed,
          closed_at: row.closed_at,
          final_through: row.final_through,
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();
    track.sourceStored = true;
  }

  /**
   * Raises the revision of every final hour a change can affect (ADR-0024 "Revisions"), in every
   * scope of the equipment (floods are scope-wide). Only a change that reaches into an hour final
   * before it is late: a fact above "final through" changes nothing before its own time, so the
   * in-order path never reads here.
   */
  async #revise(
    trx: Transaction<Database>,
    track: Track,
    changes: readonly { before: Row | undefined; after: Row | undefined }[],
    bound: Bound,
  ): Promise<void> {
    let earliest = Infinity;
    for (const change of changes) {
      const at = earliestEffect(change.before, change.after, this.#config.fleetingMs);
      if (at !== null && at < earliest) earliest = at;
    }
    if (!Number.isFinite(earliest)) return;
    // The end of each scope's last final hour, as it was before this change.
    const finalEnds = new Map<Scope, Millis>();
    for (const scope of this.#scopesOf(track.equipment)) {
      const frontier = this.#frontier(scope.members, track.epoch, bound);
      const end = hourStart(frontier - this.#config.fleetingMs);
      if (Number.isFinite(frontier) ? end > earliest : frontier === Infinity) {
        finalEnds.set(scope, frontier === Infinity ? Infinity : end);
      }
    }
    if (finalEnds.size === 0) return;
    const plant = this.#scopes.get('plant');
    if (!plant) return;
    const watermark = this.#sources.equipment.watermark(track.epoch)?.getTime();
    const tracks = plant.members
      .map((equipment) => this.#tracks.get(equipment)?.get(track.epoch))
      .filter((t): t is Track => t !== undefined);
    // Read in the transaction: the scope after the change, as `revisionSpans` wants it.
    const occurrences = await this.#occurrenceRows(
      trx,
      plant.members,
      track.epoch,
      earliest - LOOKBACK_MS,
      8_640_000_000_000_000,
    );
    const set = this.#prepared(
      occurrences,
      watermark,
      tracks.length > 0 && tracks.every((t) => t.closed),
      tracks,
    );
    const hours = new Set<Millis>();
    for (const change of changes) {
      for (const fact of lateFacts(track.equipment, change.before, change.after)) {
        for (const hour of revisedHours(fact, set)) hours.add(hour);
      }
    }
    const rows: { scope: string; epoch: number; hour: Date; revision: number }[] = [];
    for (const [scope, end] of finalEnds) {
      for (const hour of hours) {
        if (hour + HOUR <= end) {
          rows.push({ scope: scope.key, epoch: track.epoch, hour: new Date(hour), revision: 1 });
        }
      }
    }
    if (rows.length === 0) return;
    await trx
      .insertInto('alarms.kpi_revision')
      .values(rows)
      .onConflict((oc) =>
        oc.columns(['scope', 'epoch', 'hour']).doUpdateSet({
          revision: sql<number>`alarms.kpi_revision.revision + 1`,
          revised_at: sql<Date>`now()`,
        }),
      )
      .execute();
    this.#log.info(
      { equipment: track.equipment, epoch: track.epoch, revised: rows.length },
      'late alarm facts: final KPI hours revised',
    );
  }

  /**
   * Learns how far the device stream is settled (ADR-0018 amendment). In order, the fact itself
   * moves it by one; otherwise (a gap filled or reported, the first fact known) ingest is asked,
   * and before anything counts as final, its alarm facts are compared with the ones applied, so
   * that no fact that reached the table without a notice is passed (ADR-0017).
   */
  async #learn(
    track: Track,
    settledSeq: number | null | undefined,
    fact?: { readonly seq: number; readonly at: Millis },
  ): Promise<void> {
    if (settledSeq === undefined || settledSeq === null || track.closed) return;
    const known = track.settledSeq;
    if (known !== null && settledSeq <= known) return;
    const before = this.#live(track);
    if (fact && known !== null && fact.seq === settledSeq && known === fact.seq - 1) {
      track.settledSeq = settledSeq;
      track.finalThrough = Math.max(track.finalThrough, fact.at);
      await this.#advanced(track, before);
      return;
    }
    const state = await this.#sources.ingest.settled(
      track.equipment,
      track.epoch,
      known ?? undefined,
    );
    await this.#verify(track);
    this.#apply(track, state);
    await this.#advanced(track, before);
  }

  #apply(track: Track, state: SettledState): void {
    track.incidents = spans(state.incidents);
    if (state.settledSeq === null) return;
    track.settledSeq = Math.max(track.settledSeq ?? state.settledSeq, state.settledSeq);
    if (state.settledTime) {
      track.finalThrough = Math.max(track.finalThrough, state.settledTime.getTime());
    }
  }

  /** Reloads the track's facts when ingest has others than the ones applied. */
  async #verify(track: Track): Promise<void> {
    if (!track.facts) return;
    const facts = await this.#sources.ingest.alarmFacts(track.equipment, track.epoch);
    const applied = track.facts;
    if (facts.length === applied.size && facts.every((f) => applied.has(f.seq))) return;
    this.#log.info(
      {
        equipment: track.equipment,
        epoch: track.epoch,
        counted: facts.length,
        known: applied.size,
      },
      'alarm facts missed by notices: deriving again before finality',
    );
    track.facts = new Map(facts.map((f) => [f.seq, transition(f)]));
    await this.#rederive(track, true);
  }

  /**
   * After "final through" moved from `before`: a snapshot that became applicable (judged by what was
   * final before the move: hours it made final were never reported final without it), the stored
   * bound, push.
   */
  async #advanced(track: Track, before: Millis): Promise<void> {
    const snapshot = this.#applicable(track);
    const { fleetingMs } = this.#config;
    if (snapshot && track.appliedSnapshot !== snapshot.asOfSeq) {
      await this.#rederive(track, true, (t) => (t === track ? before : this.#live(t)));
    } else if (
      Number.isFinite(track.finalThrough) &&
      // An hour is final at its end plus fleetingMs: store the bound once it passes one.
      (!Number.isFinite(track.persistedFinal) ||
        hourStart(track.finalThrough - fleetingMs) > hourStart(track.persistedFinal - fleetingMs))
    ) {
      // About once an hour per equipment: what was final, for a late fact found at start-up.
      await this.#db.transaction().execute((trx) => this.#saveSource(trx, track));
      track.persistedFinal = Math.max(track.persistedFinal, track.finalThrough);
      this.#emit({ type: 'finality', equipment: track.equipment, epoch: track.epoch });
    }
  }

  /**
   * Start-up: tracks from the stored sources and ingest's tables; every (equipment, epoch) whose
   * alarm facts, anchors, snapshot or closing differ from what its occurrences reflect is derived
   * again (a late fact found here raises revisions by what was final before the restart).
   */
  async #catchUp(): Promise<void> {
    const { ingest } = this.#sources;
    const stored = await this.#db.selectFrom('alarms.occurrence_source').selectAll().execute();
    const reflected = new Map<Track, number>();
    const ensure = (equipment: string, epoch: number): Track => {
      let byEpoch = this.#tracks.get(equipment);
      if (!byEpoch) {
        byEpoch = new Map();
        this.#tracks.set(equipment, byEpoch);
      }
      let track = byEpoch.get(epoch);
      if (!track) {
        track = this.#newTrack(equipment, epoch);
        byEpoch.set(epoch, track);
      }
      return track;
    };
    const before = new Map<Track, string>();
    // What was final before the restart, captured before anything is written (a track without a
    // stored source had nothing final; a stored closed epoch was final everywhere).
    const persisted = new Map<Track, Millis>();
    const wasFinal: Bound = (t) => (t ? (persisted.get(t) ?? -Infinity) : -Infinity);
    for (const row of stored) {
      const track = ensure(row.equipment, row.epoch);
      track.anchors = [...row.anchors];
      track.snapshot = row.snapshot;
      track.closed = row.closed;
      track.closedAt = row.closed_at?.getTime() ?? null;
      track.persistedFinal = row.final_through?.getTime() ?? -Infinity;
      persisted.set(track, row.closed ? Infinity : track.persistedFinal);
      track.sourceStored = true;
      reflected.set(track, row.facts);
      before.set(track, JSON.stringify([row.anchors, row.snapshot, row.closed]));
    }
    for (const summary of await ingest.factSummary()) ensure(summary.equipment, summary.epoch);
    const counts = new Map<Track, number>();
    for (const count of await ingest.alarmFactCounts()) {
      counts.set(ensure(count.equipment, count.epoch), count.facts);
    }
    for (const anchor of await ingest.alarmAnchors()) {
      const track = ensure(anchor.equipment, anchor.epoch);
      if (!track.anchors.some((a) => a.seq === anchor.seq && a.code === anchor.code)) {
        track.anchors = [
          ...track.anchors,
          {
            code: anchor.code,
            seq: anchor.seq,
            transition: anchor.transition,
            severity: anchor.severity,
            at: anchor.sourceTime.getTime(),
          },
        ].sort((a, b) => a.seq - b.seq);
      }
    }
    for (const snapshot of await ingest.alarmSnapshots()) {
      const track = ensure(snapshot.equipment, snapshot.deviceEpoch);
      if (!track.snapshot || track.snapshot.asOfSeq < snapshot.asOfSeq) {
        track.snapshot = {
          asOfSeq: snapshot.asOfSeq,
          at: snapshot.sourceTime.getTime(),
          active: [...snapshot.active],
        };
      }
    }
    for (const [equipment, byEpoch] of this.#tracks) {
      const newest = Math.max(...byEpoch.keys());
      for (const track of byEpoch.values()) {
        if (track.epoch < newest && !track.closed) {
          track.closed = true;
          const end = this.#sources.equipment.epochEnd(equipment, track.epoch);
          track.closedAt =
            (end.closedAt ?? this.#sources.equipment.watermark(track.epoch))?.getTime() ?? null;
          if (track.closedAt === null) {
            // As `#close`: else the latest time the epoch knows of.
            await this.#load(track);
            track.closedAt = this.#latest(track);
          }
        }
      }
    }
    let derived = 0;
    for (const byEpoch of this.#tracks.values()) {
      for (const track of byEpoch.values()) {
        this.#apply(track, await ingest.settled(track.equipment, track.epoch));
        const changed =
          !track.sourceStored ||
          (counts.get(track) ?? 0) !== reflected.get(track) ||
          before.get(track) !== JSON.stringify([track.anchors, track.snapshot, track.closed]);
        if (track.closed && !changed) continue;
        // Open epochs keep their facts in memory; a closed one is derived only when it changed.
        await this.#rederive(track, changed, wasFinal);
        derived++;
      }
    }
    this.#log.info({ derived }, 'alarm occurrences caught up');
  }
}

/** The late facts (alarm-core `LateFact`) one stored change stands for. */
function lateFacts(equipment: string, before: Row | undefined, after: Row | undefined): LateFact[] {
  const raise = (row: Row): LateFact => ({
    kind: 'raise',
    equipment,
    code: row.code,
    raisedAt: row.raisedAt,
    clearedAt: row.endedAt,
  });
  if (!before || !after) {
    const only = before ?? after;
    return only ? [raise(only)] : [];
  }
  if (before.raisedAt !== after.raisedAt || before.code !== after.code) {
    return [raise(before), raise(after)];
  }
  return [{ kind: 'end', raisedAt: after.raisedAt, before: before.endedAt, after: after.endedAt }];
}
