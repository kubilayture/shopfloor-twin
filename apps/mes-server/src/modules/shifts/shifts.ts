/**
 * The `shifts` module (#144, ADR-0025): shift instances as records per (plant epoch, shift key),
 * the shift report composed on read from the `oee`, `equipment` and `alarms` modules' interfaces,
 * the report's finality and composite revision `{ inputs, content }`, and handover notes
 * (versioned, never deleted) with an append-only audit.
 */
import type { BadActor } from '@shopfloor/alarm-core';
import type { CycleCount, Millis } from '@shopfloor/oee-core';
import { UNCODED } from '@shopfloor/plant-config';
import { nextShift, shiftInstances, type ShiftPattern } from '@shopfloor/shift-calendar';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import type {
  AlarmEvent,
  AlarmKpiBucket,
  Alarms,
  OperatorBucket,
  ScopeInfo,
} from '../alarms/index.ts';
import {
  effectiveSegments,
  type CodingChange,
  type DowntimeCoding,
  type DowntimeRecord,
  type Equipment,
} from '../equipment/index.ts';
import {
  pareto,
  recordEnd,
  type Oee,
  type OeeBucket,
  type OeeChange,
  type Pareto,
} from '../oee/index.ts';
import type { HandoverNoteTable, InputRevisions, NoteContent, ShiftStatus } from './tables.ts';

export const NOTE_CATEGORIES = ['safety', 'quality', 'equipment', 'material', 'general'] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

/** Most notes one shift instance holds (a create beyond it is refused). */
export const MAX_NOTES = 200;
/** Records in the report's list of the longest downtime records; bad actors per scope. */
export const LONGEST_RECORDS = 10;
export const REPORT_BAD_ACTORS = 5;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far back the first fact of an epoch is looked for at start-up. */
const EPOCH_LOOKBACK_MS = 31 * DAY;

/** What the module reads from the other modules (their `index.ts` interfaces). */
export interface ShiftsSources {
  readonly equipment: Pick<
    Equipment,
    'watermark' | 'watermarks' | 'downtimeRecords' | 'stateHourly' | 'intervals'
  >;
  readonly oee: Pick<
    Oee,
    'shift' | 'paretoInputs' | 'reasonCodes' | 'config' | 'workCenters' | 'onChange'
  >;
  readonly alarms: Pick<Alarms, 'kpis' | 'badActors' | 'scopes' | 'operatorMeasures' | 'onChange'>;
  /** Operator recodes raise `content` of a final report (optional in tests). */
  readonly coding?: Pick<DowntimeCoding, 'onChange'>;
}

export interface ShiftsLog {
  info(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface ShiftsOptions extends ShiftsSources {
  /** Writes (instances, notes, audit, counters). */
  readonly db: Kysely<Database>;
  /** Reads for the API; default `db`. */
  readonly readDb?: Kysely<Database>;
  readonly shiftPattern: ShiftPattern;
  /** How often (wall ms) the plant clock is checked for new and ended shifts (default 1 s). */
  readonly tickMs?: number;
  /** How often (wall ms) an ended report not yet final is checked again without a change (10 s). */
  readonly recheckMs?: number;
  readonly log?: ShiftsLog;
}

/** The composite revision of a report (ADR-0025). */
export interface ReportRevision {
  /** 0 when the report became final; +1 per revision of an input after that. */
  readonly inputs: number;
  /** +1 per handover note create or edit, and per operator recode inside a final shift. */
  readonly content: number;
}

/** One stored shift instance. */
export interface ShiftRecord {
  readonly epoch: number;
  readonly key: string;
  readonly date: string;
  readonly shift: string;
  readonly start: Date;
  readonly end: Date;
  readonly breaks: readonly { readonly start: Date; readonly end: Date }[];
  readonly status: ShiftStatus;
  /** Wall time the report became final. */
  readonly finalAt: Date | null;
  readonly revision: ReportRevision;
}

export interface HandoverNote {
  readonly id: number;
  readonly epoch: number;
  readonly shiftKey: string;
  readonly category: NoteCategory;
  readonly text: string;
  readonly retracted: boolean;
  /** Who wrote it first, and who wrote the current version (free text, unauthenticated). */
  readonly createdBy: string;
  readonly author: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdPlantAt: Date;
  readonly updatedAt: Date;
  readonly updatedPlantAt: Date;
}

export interface HandoverAuditEntry {
  readonly id: number;
  readonly noteId: number;
  readonly action: 'created' | 'edited';
  readonly before: NoteContent | null;
  readonly after: NoteContent;
  readonly actor: string;
  readonly authenticated: boolean;
  readonly at: Date;
  readonly plantAt: Date;
  readonly requestId: string | null;
  readonly version: number;
}

export interface NoteRequest {
  readonly author: string;
  readonly text: string;
  readonly category: NoteCategory;
  readonly requestId?: string;
}

export interface NoteEdit extends NoteRequest {
  readonly retracted: boolean;
  /** The note's version as read (409 when it moved on). */
  readonly version: number;
}

export type ShiftErrorKind = 'not-found' | 'conflict' | 'invalid';

/** A refused request: the API answers 404, 409 or 422. */
export class ShiftError extends Error {
  readonly kind: ShiftErrorKind;

  constructor(kind: ShiftErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Per machine: cycles of the shift from its OEE inputs. */
export interface MachineProduction {
  readonly equipment: string;
  readonly produced: number;
  readonly good: number;
  readonly scrap: number;
  readonly rework: number;
  readonly cycles: readonly CycleCount[];
}

export interface ReportAlarmScope {
  readonly scope: ScopeInfo;
  /** The scope's KPIs over the shift bucket; null before the bucket has begun. */
  readonly kpis: AlarmKpiBucket | null;
  readonly badActors: readonly BadActor[];
  /**
   * The MES-only operator figures of the shift bucket (#143: shelved and annunciated raises, time to
   * acknowledge, unacknowledged at the end, shelved time per point); not reconciled, and no input
   * of the report's finality. Null before the bucket has begun.
   */
  readonly operator: OperatorBucket | null;
}

/** The shift report, computed on read (ADR-0025). */
export interface ShiftReport {
  readonly instance: ShiftRecord;
  /** The plant clock of the instance's epoch at the read; null when unknown. */
  readonly asOf: Date | null;
  /** The most sequence-gap incidents of one of its OEE or alarm KPI buckets. */
  readonly incidents: number;
  readonly oee: { readonly equipment: OeeBucket[]; readonly workCenters: OeeBucket[] };
  readonly downtime: {
    readonly pareto: Pareto;
    /** The longest records of the shift (to the watermark while open), longest first. */
    readonly longest: readonly DowntimeRecord[];
    readonly records: number;
    /** Time of the shift's records still UNCODED (no coding, auto reason UNCODED). */
    readonly uncodedMs: number;
  };
  readonly production: {
    readonly machines: readonly MachineProduction[];
    /** Good cycles of the line's last machine: finished parts. */
    readonly finished: { readonly equipment: string | null; readonly good: number };
    readonly scrap: number;
  };
  readonly alarms: readonly ReportAlarmScope[];
  readonly notes: readonly { note: HandoverNote; history: HandoverAuditEntry[] }[];
}

export type ShiftChange =
  | {
      readonly type: 'instance';
      readonly event: 'created' | 'status' | 'revised';
      readonly instance: ShiftRecord;
    }
  | { readonly type: 'note'; readonly event: 'created' | 'edited'; readonly note: HandoverNote };

const silent: ShiftsLog = { info: () => undefined, error: () => undefined };

type NoteRow = Selectable<HandoverNoteTable>;

const instanceKey = (epoch: number, key: string): string => `${String(epoch)}|${key}`;

const toRecord = (row: {
  epoch: number;
  shift_key: string;
  shift_date: string;
  shift_id: string;
  start_time: Date;
  end_time: Date;
  breaks: readonly { start: string; end: string }[];
  status: ShiftStatus;
  final_at: Date | null;
  inputs_revision: number;
  content_revision: number;
}): ShiftRecord => ({
  epoch: row.epoch,
  key: row.shift_key,
  date: row.shift_date,
  shift: row.shift_id,
  start: row.start_time,
  end: row.end_time,
  breaks: row.breaks.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
  status: row.status,
  finalAt: row.final_at,
  revision: { inputs: row.inputs_revision, content: row.content_revision },
});

const toNote = (row: NoteRow): HandoverNote => ({
  id: row.id,
  epoch: row.epoch,
  shiftKey: row.shift_key,
  category: row.category as NoteCategory,
  text: row.text,
  retracted: row.retracted,
  createdBy: row.created_by,
  author: row.author,
  version: row.version,
  createdAt: row.created_at,
  createdPlantAt: row.created_plant_at,
  updatedAt: row.updated_at,
  updatedPlantAt: row.updated_plant_at,
});

const content = (note: Pick<HandoverNote, 'category' | 'text' | 'retracted'>): NoteContent => ({
  category: note.category,
  text: note.text,
  retracted: note.retracted,
});

/**
 * How much the inputs moved since `seen`: every revision step of every input counts once, so two
 * changes in different inputs never collapse into one (ADR-0025).
 */
export function revisionSteps(seen: InputRevisions, now: InputRevisions): number {
  let steps = 0;
  for (const [input, revision] of Object.entries(now)) {
    steps += Math.max(0, revision - (seen[input] ?? 0));
  }
  return steps;
}

const STATUS_RANK: Record<ShiftStatus, number> = { running: 0, ended: 1, final: 2 };

/** Whether `next` is a later state of the instance than `kept`: nothing lower, something higher. */
export function isNewer(next: ShiftRecord, kept: ShiftRecord): boolean {
  const steps = [
    STATUS_RANK[next.status] - STATUS_RANK[kept.status],
    next.revision.inputs - kept.revision.inputs,
    next.revision.content - kept.revision.content,
  ];
  return steps.every((step) => step >= 0) && steps.some((step) => step > 0);
}

/** `seen` with every input at least at `now`'s revision. */
function merged(seen: InputRevisions, now: InputRevisions): InputRevisions {
  const result: InputRevisions = { ...seen };
  for (const [input, revision] of Object.entries(now)) {
    result[input] = Math.max(result[input] ?? 0, revision);
  }
  return result;
}

/** Per machine: produced, good, scrap and rework cycles of an OEE bucket. */
export function production(bucket: Pick<OeeBucket, 'id' | 'cycles'>): MachineProduction {
  const count = (result: string): number =>
    bucket.cycles.filter((c) => c.result === result).reduce((sum, c) => sum + c.count, 0);
  const good = count('good');
  const scrap = count('scrap');
  const rework = count('rework');
  return {
    equipment: bucket.id,
    produced: good + scrap + rework,
    good,
    scrap,
    rework,
    cycles: bucket.cycles,
  };
}

interface Tracked {
  record: ShiftRecord;
  /** Its inputs may have changed since the last evaluation. */
  dirty: boolean;
  /** Wall time of the last evaluation. */
  checkedAt: number;
}

/** The computed inputs of one report: what finality and `inputs` are judged on. */
interface Inputs {
  readonly final: boolean;
  readonly revisions: InputRevisions;
}

/**
 * Shift instances, the shift report and handover notes (#144). Start it after the modules it
 * reads (`equipment`, `oee`, `alarms`).
 */
export class Shifts {
  readonly #db: Kysely<Database>;
  readonly #readDb: Kysely<Database>;
  readonly #sources: ShiftsSources;
  readonly #pattern: ShiftPattern;
  readonly #log: ShiftsLog;
  readonly #tickMs: number;
  readonly #recheckMs: number;
  readonly #tracked = new Map<string, Tracked>();
  /** Per epoch: shifts starting before this were created (or found) already. */
  readonly #ensured = new Map<number, Millis>();
  readonly #listeners = new Set<(change: ShiftChange) => void>();
  #detach: (() => void)[] = [];
  #timer: NodeJS.Timeout | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #ticking = false;

  constructor(options: ShiftsOptions) {
    this.#db = options.db;
    this.#readDb = options.readDb ?? options.db;
    this.#sources = options;
    this.#pattern = options.shiftPattern;
    this.#log = options.log ?? silent;
    this.#tickMs = options.tickMs ?? 1_000;
    this.#recheckMs = options.recheckMs ?? 10_000;
  }

  get shiftPattern(): ShiftPattern {
    return this.#pattern;
  }

  /**
   * Loads the stored instances, creates the missing ones up to the plant clock (idempotent), then
   * follows the plant clock and the inputs' changes.
   */
  async start(): Promise<void> {
    const rows = await this.#db.selectFrom('shifts.shift_instance').selectAll().execute();
    for (const row of rows) {
      const record = toRecord(row);
      // Only reports not final yet are evaluated at start-up: a final one is evaluated again when
      // one of its inputs changes, and every read of it brings its `inputs` up to date.
      this.#tracked.set(instanceKey(record.epoch, record.key), {
        record,
        dirty: record.status !== 'final',
        checkedAt: 0,
      });
    }
    this.#detach.push(
      this.#sources.oee.onChange((change) => {
        this.#onInputs(change);
      }),
      this.#sources.alarms.onChange((change) => {
        this.#onAlarm(change);
      }),
    );
    if (this.#sources.coding) {
      this.#detach.push(
        this.#sources.coding.onChange((change) => {
          this.#onCoding(change);
        }),
      );
    }
    await this.tick();
    this.#timer = setInterval(() => {
      if (this.#ticking) return;
      this.tick().catch((error: unknown) => {
        this.#log.error({ err: error }, 'shifts: checking the plant clock failed; retrying');
      });
    }, this.#tickMs).unref();
  }

  /** Stops following and waits for the work in hand. */
  async stop(): Promise<void> {
    for (const detach of this.#detach.splice(0)) detach();
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#queue.catch(() => undefined);
  }

  /** Listens for instance and note changes (push). Returns an unsubscribe. */
  onChange(listener: (change: ShiftChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * One pass: creates the instances the plant clock has entered, moves statuses, evaluates the
   * reports of ended instances whose inputs may have changed (finality, `inputs`).
   */
  async tick(): Promise<void> {
    this.#ticking = true;
    try {
      await this.#enqueue(async () => {
        const clocks = this.#sources.equipment.watermarks();
        const newest = clocks[0]?.epoch;
        for (const clock of clocks) await this.#ensure(clock.epoch, clock.watermark.getTime());
        const now = Date.now();
        for (const tracked of this.#tracked.values()) {
          const { record } = tracked;
          const ended = this.#ended(record, newest);
          if (record.status === 'running' && ended) {
            await this.#setStatus(record, 'ended');
          }
          const current = this.#tracked.get(instanceKey(record.epoch, record.key))?.record;
          if (!current || current.status === 'running') continue;
          const due =
            tracked.dirty ||
            (current.status === 'ended' && now - tracked.checkedAt >= this.#recheckMs);
          if (!due) continue;
          tracked.dirty = false;
          tracked.checkedAt = now;
          try {
            await this.#observe(current, await this.#inputs(current));
          } catch (error) {
            // Tried again on the next pass (a busy read pool, a database restart).
            tracked.dirty = true;
            this.#log.error(
              { err: error, shift: current.key },
              'shifts: evaluating a report failed',
            );
          }
        }
      });
    } finally {
      this.#ticking = false;
    }
  }

  // ---- reads ----

  /** The instance `date/shift` of `epoch`, or of the newest epoch that has it. */
  async instance(date: string, shift: string, epoch?: number): Promise<ShiftRecord | undefined> {
    let select = this.#readDb
      .selectFrom('shifts.shift_instance')
      .selectAll()
      .where('shift_key', '=', `${date}/${shift}`);
    if (epoch !== undefined) select = select.where('epoch', '=', epoch);
    const row = await select.orderBy('epoch', 'desc').limit(1).executeTakeFirst();
    return row && toRecord(row);
  }

  /**
   * The shift report (ADR-0025), computed on read. If the stored finality or `inputs` is behind
   * what this read found, it is brought up to date (idempotent, under the row lock).
   *
   * A revision may lag the content it is served with, never lead it. So the instance row (its
   * `content` counter) and then the input revisions are read before the content: a note written
   * meanwhile commits its counter with the note, so the notes read later include it; a recode is
   * committed before its counter moves; an input revised after its revision was read shows in
   * the content now and is counted as a step of `inputs` later. The revision served is the one of
   * these early reads, even when a concurrent read has stored a higher one.
   */
  async report(date: string, shift: string, epoch?: number): Promise<ShiftReport | undefined> {
    const found = await this.instance(date, shift, epoch);
    if (!found) return undefined;
    const record = found;
    const revisions = await this.#revisions(record);
    const { equipment, oee, alarms } = this.#sources;
    const start = record.start;
    const end = record.end;
    const bucket = { key: record.key, start: start.getTime(), end: end.getTime() };
    const scopes = alarms.scopes().filter((s) => s.scope !== 'equipment');
    const [shiftOee, records, workCenters, reasons, alarmScopes, notes] = await Promise.all([
      oee.shift(bucket, record.epoch),
      equipment.downtimeRecords({ from: start, to: end, epoch: record.epoch }),
      oee.workCenters(),
      oee.reasonCodes(),
      Promise.all(
        scopes.map(async (scope): Promise<ReportAlarmScope> => {
          const query = { scope: scope.scope, id: scope.id, from: start, to: end };
          const [kpis, actors, operator] = await Promise.all([
            alarms.kpis({ ...query, bucket: 'shift', epoch: record.epoch }),
            alarms.badActors({ ...query, epoch: record.epoch, limit: REPORT_BAD_ACTORS }),
            alarms.operatorMeasures({ ...query, bucket: 'shift', epoch: record.epoch }),
          ]);
          return {
            scope,
            kpis: kpis.find((b) => b.key === record.key) ?? null,
            badActors: actors.actors,
            operator: operator.buckets.find((b) => b.key === record.key) ?? null,
          };
        }),
      ),
      this.notes(record.epoch, record.key, true),
    ]);
    const inShift = records.filter((r) => r.shiftKey === record.key);
    const losses = await Promise.all(
      workCenters.map((wc) => oee.paretoInputs('work-center', wc.id, start, end, record.epoch)),
    );
    const loss = pareto({
      losses: losses.flatMap((l) => l.losses),
      stops: losses.flatMap((l) => l.stops),
      from: start,
      to: end,
      thresholdMs: oee.config.microStopThresholdMs,
      reasons,
    });
    const watermark = equipment.watermark(record.epoch);
    const length = (r: DowntimeRecord): Millis => recordEnd(r, watermark) - r.start.getTime();
    const uncodedMs = inShift.reduce(
      (sum, r) =>
        sum +
        effectiveSegments(r.start.getTime(), r.start.getTime() + length(r), r.autoReason, r.codings)
          .filter((s) => s.reason === UNCODED)
          .reduce((ms, s) => ms + s.to - s.from, 0),
      0,
    );
    const longest = [...inShift]
      .sort(
        (a, b) =>
          length(b) - length(a) ||
          a.start.getTime() - b.start.getTime() ||
          (a.equipment < b.equipment ? -1 : a.equipment > b.equipment ? 1 : 0),
      )
      .slice(0, LONGEST_RECORDS);
    const machines = shiftOee.equipment.map(production);
    const last = workCenters.at(-1)?.equipment.at(-1) ?? null;
    const final = await this.#finality(record, {
      oee: shiftOee,
      records: inShift,
      alarms: alarmScopes,
    });
    const { stored, seen } = await this.#observe(record, { final, revisions });
    // `inputs` as of the revisions read above: the stored count less the steps counted beyond
    // them (by this read's own catch-up nothing, by a concurrent read or the tick perhaps some).
    const instance: ShiftRecord = {
      ...stored,
      revision: {
        inputs: Math.max(0, stored.revision.inputs - revisionSteps(revisions, seen)),
        content: Math.min(stored.revision.content, record.revision.content),
      },
    };
    return {
      instance,
      asOf: watermark ?? null,
      incidents: Math.max(
        0,
        ...shiftOee.equipment.map((b) => b.incidents),
        ...shiftOee.workCenters.map((b) => b.incidents),
        ...alarmScopes.map((s) => s.kpis?.incidents ?? 0),
      ),
      oee: shiftOee,
      downtime: { pareto: loss, longest, records: inShift.length, uncodedMs },
      production: {
        machines,
        finished: {
          equipment: last,
          good: machines.find((m) => m.equipment === last)?.good ?? 0,
        },
        scrap: machines.reduce((sum, m) => sum + m.scrap, 0),
      },
      alarms: alarmScopes,
      notes,
    };
  }

  /** The notes of an instance, by creation, each with its history (newest first) if asked. */
  async notes(
    epoch: number,
    key: string,
    withHistory: boolean,
  ): Promise<{ note: HandoverNote; history: HandoverAuditEntry[] }[]> {
    const rows = await this.#readDb
      .selectFrom('shifts.handover_note')
      .selectAll()
      .where('epoch', '=', epoch)
      .where('shift_key', '=', key)
      .orderBy('id')
      .execute();
    const history = new Map<number, HandoverAuditEntry[]>();
    if (withHistory && rows.length > 0) {
      for (const entry of await this.#audit(rows.map((r) => r.id))) {
        history.set(entry.noteId, [...(history.get(entry.noteId) ?? []), entry]);
      }
    }
    return rows.map((row) => ({ note: toNote(row), history: history.get(row.id) ?? [] }));
  }

  /** One note, or undefined. */
  async note(id: number): Promise<HandoverNote | undefined> {
    const row = await this.#readDb
      .selectFrom('shifts.handover_note')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toNote(row);
  }

  /** The audit of one note, newest first. */
  async noteAudit(id: number): Promise<HandoverAuditEntry[]> {
    return this.#audit([id]);
  }

  // ---- writes (ADR-0023: guarded in the API, audited here) ----

  /** Creates a note on the instance; it raises the report's `content`. */
  async createNote(epoch: number, key: string, request: NoteRequest): Promise<HandoverNote> {
    const note = await this.#db.transaction().execute(async (trx) => {
      const { record, plantAt } = await this.#openForNotes(trx, epoch, key);
      const count = await trx
        .selectFrom('shifts.handover_note')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('epoch', '=', epoch)
        .where('shift_key', '=', key)
        .executeTakeFirstOrThrow();
      if (Number(count.n) >= MAX_NOTES) {
        throw new ShiftError('invalid', `at most ${String(MAX_NOTES)} notes per shift`);
      }
      const row = await trx
        .insertInto('shifts.handover_note')
        .values({
          epoch,
          shift_key: key,
          category: request.category,
          text: request.text,
          created_by: request.author,
          author: request.author,
          created_plant_at: plantAt,
          updated_plant_at: plantAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const created = toNote(row);
      await this.#writeAudit(trx, created, 'created', null, request.requestId, plantAt);
      await this.#raiseContent(trx, record);
      return created;
    });
    this.#emit({ type: 'note', event: 'created', note });
    await this.#emitInstance(epoch, key, 'revised');
    return note;
  }

  /**
   * Edits a note (text, category, retracted) if it is still at `version`; it raises the report's
   * `content`. A note is never deleted: retracting it keeps it in the history.
   */
  async editNote(epoch: number, key: string, id: number, edit: NoteEdit): Promise<HandoverNote> {
    const note = await this.#db.transaction().execute(async (trx) => {
      const { record, plantAt } = await this.#openForNotes(trx, epoch, key);
      const row = await trx
        .selectFrom('shifts.handover_note')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (row?.epoch !== epoch || row.shift_key !== key) {
        throw new ShiftError('not-found', `no note ${String(id)} in shift ${key}`);
      }
      if (row.version !== edit.version) {
        throw new ShiftError(
          'conflict',
          `note ${String(id)} changed: version is ${String(row.version)}, not ${String(edit.version)}`,
        );
      }
      const before = toNote(row);
      const updated = await trx
        .updateTable('shifts.handover_note')
        .set({
          category: edit.category,
          text: edit.text,
          retracted: edit.retracted,
          author: edit.author,
          version: row.version + 1,
          updated_at: sql<Date>`clock_timestamp()`,
          updated_plant_at: plantAt,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const after = toNote(updated);
      await this.#writeAudit(trx, after, 'edited', content(before), edit.requestId, plantAt);
      await this.#raiseContent(trx, record);
      return after;
    });
    this.#emit({ type: 'note', event: 'edited', note });
    await this.#emitInstance(epoch, key, 'revised');
    return note;
  }

  // ---- internals ----

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #ended(record: ShiftRecord, newest: number | undefined): boolean {
    const clock = this.#sources.equipment.watermark(record.epoch)?.getTime();
    return (
      (clock !== undefined && clock >= record.end.getTime()) ||
      (newest !== undefined && newest > record.epoch)
    );
  }

  /** The first stored interval of an epoch, of any machine (its first fact or anchor). */
  async #epochStart(epoch: number, clock: Millis): Promise<Millis> {
    const machines = (await this.#sources.oee.workCenters()).flatMap((wc) => wc.equipment);
    let first = clock;
    for (const machine of machines) {
      const [piece] = await this.#sources.equipment.intervals(
        machine,
        new Date(clock - EPOCH_LOOKBACK_MS),
        new Date(clock),
        { epoch, limit: 1 },
      );
      if (piece) first = Math.min(first, piece.start.getTime());
    }
    return first;
  }

  /**
   * Creates the instances of an epoch the plant clock has entered (start before the clock), from
   * the epoch's first fact on. Idempotent: an existing row is kept as it is.
   */
  async #ensure(epoch: number, clock: Millis): Promise<void> {
    // The instant just before the watermark: at 06:00:00.000 the 06:00 shift has not begun.
    const at = clock - 1;
    const ensured = this.#ensured.get(epoch);
    if (ensured !== undefined && at <= ensured) return;
    const from = ensured ?? (await this.#epochStart(epoch, clock));
    if (at < from) {
      this.#ensured.set(epoch, at);
      return;
    }
    const due = shiftInstances(this.#pattern, from, at + 1).filter(
      (s) => s.start <= at && !this.#tracked.has(instanceKey(epoch, s.key)),
    );
    for (const scheduled of due) {
      const status: ShiftStatus = clock >= scheduled.end ? 'ended' : 'running';
      const row = await this.#db
        .insertInto('shifts.shift_instance')
        .values({
          epoch,
          shift_key: scheduled.key,
          shift_date: scheduled.date,
          shift_id: scheduled.shift,
          start_time: new Date(scheduled.start),
          end_time: new Date(scheduled.end),
          breaks: JSON.stringify(
            scheduled.breaks.map((b) => ({
              start: new Date(b.start).toISOString(),
              end: new Date(b.end).toISOString(),
            })),
          ),
          status,
        })
        .onConflict((oc) => oc.columns(['epoch', 'shift_key']).doNothing())
        .returningAll()
        .executeTakeFirst();
      const stored =
        row ??
        (await this.#db
          .selectFrom('shifts.shift_instance')
          .selectAll()
          .where('epoch', '=', epoch)
          .where('shift_key', '=', scheduled.key)
          .executeTakeFirstOrThrow());
      const record = toRecord(stored);
      this.#tracked.set(instanceKey(epoch, record.key), { record, dirty: true, checkedAt: 0 });
      if (row) this.#emit({ type: 'instance', event: 'created', instance: record });
    }
    this.#ensured.set(epoch, Math.max(from, at));
  }

  async #setStatus(record: ShiftRecord, status: ShiftStatus): Promise<void> {
    const row = await this.#db
      .updateTable('shifts.shift_instance')
      .set({ status, updated_at: new Date() })
      .where('epoch', '=', record.epoch)
      .where('shift_key', '=', record.key)
      .where('status', '=', 'running')
      .returningAll()
      .executeTakeFirst();
    if (row) this.#store(toRecord(row), 'status');
  }

  /**
   * The report's inputs: the revisions (read first) and then whether all are final. Read in this
   * order, the revisions can only lag what the finality was judged on, never lead it: a change
   * between the two reads is counted later, as a step of `inputs`, rather than lost in the
   * baseline.
   */
  async #inputs(record: ShiftRecord): Promise<Inputs> {
    const revisions = await this.#revisions(record);
    return { revisions, final: await this.#finality(record) };
  }

  /**
   * Whether every input of the report is final: the shift ended, every OEE bucket, every downtime
   * record and every alarm KPI shift bucket of it final. `read`: what the report read already.
   */
  async #finality(
    record: ShiftRecord,
    read?: {
      readonly oee: { equipment: readonly OeeBucket[]; workCenters: readonly OeeBucket[] };
      readonly records: readonly DowntimeRecord[];
      readonly alarms: readonly ReportAlarmScope[];
    },
  ): Promise<boolean> {
    const { equipment, oee, alarms } = this.#sources;
    const scopes = alarms.scopes().filter((s) => s.scope !== 'equipment');
    const range = { from: record.start, to: record.end };
    const [shiftOee, records, alarmFinal] = read
      ? [read.oee, read.records, read.alarms.map((s) => s.kpis?.final === true)]
      : await Promise.all([
          oee.shift(
            { key: record.key, start: record.start.getTime(), end: record.end.getTime() },
            record.epoch,
          ),
          equipment
            .downtimeRecords({ ...range, epoch: record.epoch })
            .then((list) => list.filter((r) => r.shiftKey === record.key)),
          Promise.all(
            scopes.map(async (scope) => {
              const kpis = await alarms.kpis({
                scope: scope.scope,
                id: scope.id,
                bucket: 'shift',
                ...range,
                epoch: record.epoch,
              });
              return kpis.find((b) => b.key === record.key)?.final === true;
            }),
          ),
        ]);
    return (
      this.#ended(record, equipment.watermarks()[0]?.epoch) &&
      [...shiftOee.equipment, ...shiftOee.workCenters].every((b) => b.final) &&
      records.every((r) => !r.provisional) &&
      alarmFinal.every(Boolean)
    );
  }

  /**
   * The revision of every OEE hour of every machine and of every alarm KPI hour of every scope of
   * the shift: the inputs `inputs` counts.
   */
  async #revisions(record: ShiftRecord): Promise<InputRevisions> {
    const { equipment, alarms } = this.#sources;
    const scopes = alarms.scopes().filter((s) => s.scope !== 'equipment');
    const range = { from: record.start, to: record.end };
    const map: InputRevisions = {};
    const [hours, alarmHours] = await Promise.all([
      equipment.stateHourly(range.from, range.to, { epoch: record.epoch }),
      Promise.all(
        scopes.map(async (scope) => ({
          scope,
          buckets: await alarms.kpis({
            scope: scope.scope,
            id: scope.id,
            bucket: 'hour',
            ...range,
            epoch: record.epoch,
          }),
        })),
      ),
    ]);
    for (const hour of hours) {
      const input = `oee:${hour.equipment}:${hour.hour.toISOString()}`;
      map[input] = Math.max(map[input] ?? 0, hour.revision);
    }
    for (const { scope, buckets } of alarmHours) {
      for (const bucket of buckets) {
        const id = scope.scope === 'plant' ? 'plant' : `${scope.scope}:${scope.id}`;
        map[`alarm:${id}:${bucket.key}`] = bucket.revision;
      }
    }
    return map;
  }

  /**
   * Brings the stored finality and `inputs` up to what `inputs` found, under the instance's row
   * lock: final once (with the revisions at that moment), then `inputs` + the revision steps
   * since the last count. Returns the instance as stored.
   */
  async #observe(
    record: ShiftRecord,
    inputs: Inputs,
  ): Promise<{ stored: ShiftRecord; seen: InputRevisions }> {
    const result = await this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('shifts.shift_instance')
        .selectAll()
        .where('epoch', '=', record.epoch)
        .where('shift_key', '=', record.key)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.status !== 'final') {
        if (!inputs.final) {
          const status: ShiftStatus = this.#ended(
            record,
            this.#sources.equipment.watermarks()[0]?.epoch,
          )
            ? 'ended'
            : row.status;
          if (status === row.status) return { row, event: undefined };
          const updated = await trx
            .updateTable('shifts.shift_instance')
            .set({ status, updated_at: new Date() })
            .where('epoch', '=', record.epoch)
            .where('shift_key', '=', record.key)
            .returningAll()
            .executeTakeFirstOrThrow();
          return { row: updated, event: 'status' as const };
        }
        const json = JSON.stringify(inputs.revisions);
        const updated = await trx
          .updateTable('shifts.shift_instance')
          .set({
            status: 'final',
            final_at: new Date(),
            final_inputs: json,
            seen_inputs: json,
            inputs_revision: 0,
            updated_at: new Date(),
          })
          .where('epoch', '=', record.epoch)
          .where('shift_key', '=', record.key)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { row: updated, event: 'status' as const };
      }
      const seen = row.seen_inputs ?? {};
      const steps = revisionSteps(seen, inputs.revisions);
      if (steps === 0) return { row, event: undefined };
      const updated = await trx
        .updateTable('shifts.shift_instance')
        .set({
          inputs_revision: row.inputs_revision + steps,
          seen_inputs: JSON.stringify(merged(seen, inputs.revisions)),
          updated_at: new Date(),
        })
        .where('epoch', '=', record.epoch)
        .where('shift_key', '=', record.key)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { row: updated, event: 'revised' as const };
    });
    const stored = toRecord(result.row);
    if (result.event) this.#store(stored, result.event);
    return { stored, seen: result.row.seen_inputs ?? {} };
  }

  /** The instance locked for a note write, open for notes at the epoch's plant clock. */
  async #openForNotes(
    trx: Transaction<Database>,
    epoch: number,
    key: string,
  ): Promise<{ record: ShiftRecord; plantAt: Date }> {
    const row = await trx
      .selectFrom('shifts.shift_instance')
      .selectAll()
      .where('epoch', '=', epoch)
      .where('shift_key', '=', key)
      .forUpdate()
      .executeTakeFirst();
    if (!row)
      throw new ShiftError('not-found', `no shift instance ${key} in epoch ${String(epoch)}`);
    const record = toRecord(row);
    // A newer epoch ends the old one's plant time: its clock stands still (or is unknown after a
    // restart), so its handover is closed, the same before and after a restart.
    const newest = this.#sources.equipment.watermarks()[0]?.epoch;
    if (newest !== undefined && newest > epoch) {
      throw new ShiftError(
        'conflict',
        `handover closed: epoch ${String(epoch)} ended (epoch ${String(newest)} is newer)`,
      );
    }
    const plantAt = this.#sources.equipment.watermark(epoch);
    if (plantAt === undefined) {
      throw new ShiftError(
        'conflict',
        `handover closed: no plant clock for epoch ${String(epoch)}`,
      );
    }
    const window = handoverWindow(this.#pattern, record);
    if (plantAt.getTime() < window.from) {
      throw new ShiftError('conflict', `handover not open: shift ${key} has not begun`);
    }
    if (plantAt.getTime() >= window.to) {
      throw new ShiftError(
        'conflict',
        `handover closed: notes of ${key} can be written until ${new Date(window.to).toISOString()} (plant time)`,
      );
    }
    return { record, plantAt };
  }

  async #raiseContent(trx: Transaction<Database>, record: ShiftRecord): Promise<void> {
    await trx
      .updateTable('shifts.shift_instance')
      .set((eb) => ({
        content_revision: eb('content_revision', '+', 1),
        updated_at: new Date(),
      }))
      .where('epoch', '=', record.epoch)
      .where('shift_key', '=', record.key)
      .execute();
  }

  async #writeAudit(
    trx: Transaction<Database>,
    note: HandoverNote,
    action: 'created' | 'edited',
    before: NoteContent | null,
    requestId: string | undefined,
    plantAt: Date,
  ): Promise<void> {
    await trx
      .insertInto('shifts.handover_audit')
      .values({
        note_id: note.id,
        epoch: note.epoch,
        shift_key: note.shiftKey,
        action,
        before: before === null ? null : JSON.stringify(before),
        after: JSON.stringify(content(note)),
        actor: note.author,
        plant_at: plantAt,
        request_id: requestId ?? null,
        version: note.version,
      })
      .execute();
  }

  async #audit(ids: readonly number[]): Promise<HandoverAuditEntry[]> {
    const rows = await this.#readDb
      .selectFrom('shifts.handover_audit')
      .selectAll()
      .where('note_id', 'in', ids)
      .orderBy('id', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      noteId: row.note_id,
      action: row.action,
      before: row.before,
      after: row.after,
      actor: row.actor,
      authenticated: row.authenticated,
      at: row.at,
      plantAt: row.plant_at,
      requestId: row.request_id,
      version: row.version,
    }));
  }

  async #emitInstance(epoch: number, key: string, event: 'revised'): Promise<void> {
    const row = await this.#db
      .selectFrom('shifts.shift_instance')
      .selectAll()
      .where('epoch', '=', epoch)
      .where('shift_key', '=', key)
      .executeTakeFirst();
    if (row) this.#store(toRecord(row), event);
  }

  /**
   * Keeps the instance as stored and tells the listeners, but only when it is newer than the one
   * kept (status, `inputs` and `content` each at least as high, one higher): interleaved writers
   * (a report read, the tick, a note write) may finish out of order, and a client must never be
   * left on an older revision.
   */
  #store(record: ShiftRecord, event: 'created' | 'status' | 'revised'): void {
    const tracked = this.#tracked.get(instanceKey(record.epoch, record.key));
    if (!tracked) {
      this.#tracked.set(instanceKey(record.epoch, record.key), {
        record,
        dirty: record.status !== 'final',
        checkedAt: 0,
      });
      this.#emit({ type: 'instance', event, instance: record });
      return;
    }
    if (!isNewer(record, tracked.record)) return;
    tracked.record = record;
    this.#emit({ type: 'instance', event, instance: record });
  }

  /**
   * Marks the instances of an epoch overlapping [from, to) for evaluation: ended ones, and final
   * ones too unless `finalToo` is false. A final report only needs evaluating when one of its
   * inputs' values may have changed (a range is known); a finality move concerns only reports not
   * final yet.
   */
  #mark(epoch: number, from: Millis, to: Millis, finalToo: boolean): void {
    for (const tracked of this.#tracked.values()) {
      const { record } = tracked;
      if (record.epoch !== epoch || record.status === 'running') continue;
      if (record.status === 'final' && !finalToo) continue;
      if (record.start.getTime() < to && record.end.getTime() > from) tracked.dirty = true;
    }
  }

  #onInputs(change: OeeChange): void {
    this.#mark(change.epoch, change.from.getTime(), change.to.getTime(), true);
  }

  #onAlarm(change: AlarmEvent): void {
    // A shelf (or its end) happens at the plant clock, after every ended shift: it can't change
    // a final report's operator figures.
    if (change.type === 'point') return;
    if (change.type === 'occurrence' && change.event === 'acknowledged') {
      this.#onAcknowledged(change.occurrence);
      return;
    }
    // Comments and shelf flags change no KPI and no figure of the report.
    if (
      change.type === 'occurrence' &&
      (change.event === 'commented' || change.event === 'shelf')
    ) {
      return;
    }
    if (change.type === 'finality') {
      this.#mark(change.epoch, -Infinity, Infinity, false);
      return;
    }
    // Windowed KPIs reach past the occurrence itself (floods, chattering): from an hour before
    // its raise to an hour after its end (an open one: after the epoch's plant clock).
    const { epoch, raisedAt, endedAt } = change.occurrence;
    const until =
      endedAt?.getTime() ?? this.#sources.equipment.watermark(epoch)?.getTime() ?? Infinity;
    this.#mark(epoch, raisedAt.getTime() - HOUR, until + HOUR, true);
  }

  /** An operator recode inside a final shift raises its `content` (a clip after a re-cut doesn't). */
  #onCoding(change: CodingChange): void {
    if (change.kind !== 'coded') return;
    const from = change.from.getTime();
    const to = change.to.getTime();
    const hit = [...this.#tracked.values()]
      .map((t) => t.record)
      .filter(
        (r) =>
          r.epoch === change.epoch &&
          r.status === 'final' &&
          r.start.getTime() < to &&
          r.end.getTime() > from,
      );
    for (const record of hit) this.#contentStep(record, 'a recode');
  }

  /**
   * An acknowledgement after a report is final changes its operator figures (the time to
   * acknowledge of a raise in the shift; ADR-0025): one `content` step per occurrence raised in
   * the shift. Unacknowledged-at-end can't change (it is taken at the shift's end).
   */
  #onAcknowledged(occurrence: { epoch: number; raisedAt: Date }): void {
    const at = occurrence.raisedAt.getTime();
    for (const { record } of this.#tracked.values()) {
      if (
        record.epoch === occurrence.epoch &&
        record.status === 'final' &&
        record.start.getTime() <= at &&
        at < record.end.getTime()
      ) {
        this.#contentStep(record, 'an acknowledgement');
      }
    }
  }

  /** Raises `content` of an instance by one, off the caller's path (after its commit). */
  #contentStep(record: ShiftRecord, what: string): void {
    this.#enqueue(async () => {
      const row = await this.#db
        .updateTable('shifts.shift_instance')
        .set((eb) => ({
          content_revision: eb('content_revision', '+', 1),
          updated_at: new Date(),
        }))
        .where('epoch', '=', record.epoch)
        .where('shift_key', '=', record.key)
        .returningAll()
        .executeTakeFirst();
      if (row) this.#store(toRecord(row), 'revised');
    }).catch((error: unknown) => {
      this.#log.error({ err: error }, `shifts: counting ${what} failed`);
    });
  }

  #emit(change: ShiftChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error({ err: error }, 'shifts listener failed');
      }
    }
  }
}

/**
 * When notes of a shift can be written (plant time): from its start until the end of the
 * following shift (ADR-0025); a shift without a following one within 8 days: until its own end
 * plus a day.
 */
export function handoverWindow(
  pattern: ShiftPattern,
  record: { readonly start: Date; readonly end: Date },
): { from: Millis; to: Millis } {
  const next = nextShift(pattern, { end: record.end.getTime() });
  return { from: record.start.getTime(), to: next?.end ?? record.end.getTime() + DAY };
}
