/**
 * Operator coding of downtime (#121, ADR-0021, ADR-0023): time ranges inside a record's loss time
 * with a reason, stored by time in `equipment.downtime_coding`, so they survive a late fact that
 * re-cuts the intervals and rebuilds the records. Every write and every clip is audited in the
 * append-only `equipment.downtime_audit`.
 */
import { PROBLEM_TYPES, type ProblemType } from '@shopfloor/contracts/mes-api';
import type { Millis } from '@shopfloor/oee-core';
import { UNCODED } from '@shopfloor/plant-config';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';

const DAY = 24 * 3_600_000;
/** 0001-01-01 and 9999-12-31: bounds of an open-ended range that PostgreSQL takes. */
const EARLIEST = -62_135_596_800_000;
const LATEST = 253_402_214_400_000;
/** The longest wait before a failed clip is tried again. */
const MAX_RETRY_MS = 30_000;

/** One stored coding (not orphaned), as the records and the API show it. */
export interface Coding {
  readonly from: Date;
  readonly to: Date;
  readonly reason: string;
  readonly comment: string;
  /** Free text, unauthenticated until identity (Phase 7). */
  readonly codedBy: string;
  /** Wall time of the write. */
  readonly codedAt: Date;
  /** The coding set's version it was written at. */
  readonly version: number;
}

/** A coding as the audit records it (`before`, `after`). */
export interface AuditCoding {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly comment: string;
  readonly codedBy: string;
  readonly codedAt: string;
  /** Set on the parts a clip left outside every loss interval. */
  readonly orphaned?: boolean;
}

export type AuditAction = 'coded' | 'cleared' | 'orphaned';

export interface AuditEntry {
  readonly id: number;
  readonly equipment: string;
  readonly epoch: number;
  readonly recordId: string | null;
  readonly from: Date;
  readonly to: Date | null;
  readonly action: AuditAction;
  readonly before: readonly AuditCoding[];
  readonly after: readonly AuditCoding[];
  readonly actor: string;
  readonly authenticated: boolean;
  readonly at: Date;
  readonly requestId: string | null;
  readonly version: number;
}

/** The record a write names: `{equipment}~{epoch}~{startMs}`. */
export interface RecordKey {
  readonly equipment: string;
  readonly epoch: number;
  readonly start: Date;
}

export interface CodeRequest {
  /** Non-overlapping ranges inside the record; empty clears the record's codings. */
  readonly segments: readonly {
    readonly from: Date;
    readonly to: Date;
    readonly reason: string;
    readonly comment?: string | undefined;
  }[];
  readonly codedBy: string;
  /** The coding set's version the client saw (409 when it moved on). */
  readonly version: number;
  /** The HTTP request's id, for the audit. */
  readonly requestId?: string;
}

export type CodingErrorKind = 'not-found' | 'conflict' | 'invalid';

/** A refused write: the API answers 404, 409 or 422. */
export class CodingError extends Error {
  readonly kind: CodingErrorKind;
  /** The problem type a client tells apart (#163); `about:blank` without one. */
  readonly type: ProblemType | undefined;

  constructor(kind: CodingErrorKind, message: string, type?: ProblemType) {
    super(message);
    this.kind = kind;
    this.type = type;
  }
}

/** After codings of one (equipment, epoch) changed in [from, to): written or clipped. */
export interface CodingChange {
  readonly equipment: string;
  readonly epoch: number;
  readonly from: Date;
  readonly to: Date;
  /** An operator's write (`coded`), or a clip after a re-cut (`clipped`, #144). */
  readonly kind?: 'coded' | 'clipped';
}

export interface Range {
  readonly from: Millis;
  readonly to: Millis;
}

/** A record's span for clipping: an open record ([start, ∞)) can only grow. */
export interface RecordSpan {
  readonly start: Millis;
  readonly end: Millis | null;
}

export const recordId = (key: RecordKey): string =>
  `${key.equipment}~${String(key.epoch)}~${String(key.start.getTime())}`;

/** Parses `{equipment}~{epoch}~{startMs}`; undefined when it is not one. */
export function parseRecordId(id: string): RecordKey | undefined {
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})~(\d{1,15})~(\d{1,15})$/.exec(id);
  if (!match) return undefined;
  const epoch = Number(match[2]);
  const start = Number(match[3]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(start)) return undefined;
  return { equipment: match[1] ?? '', epoch, start: new Date(start) };
}

/**
 * Splits `range` by the records' spans: the parts inside a record (one per record, so every kept
 * coding lies in exactly one record) and the parts outside every record.
 */
export function clipToRecords(
  range: Range,
  records: readonly RecordSpan[],
): { kept: Range[]; orphaned: Range[] } {
  const kept: Range[] = [];
  for (const record of [...records].sort((a, b) => a.start - b.start)) {
    const from = Math.max(range.from, record.start);
    const to = Math.min(range.to, record.end ?? Infinity);
    if (to > from) kept.push({ from, to });
  }
  const orphaned: Range[] = [];
  let at = range.from;
  for (const part of kept) {
    if (part.from > at) orphaned.push({ from: at, to: part.from });
    at = Math.max(at, part.to);
  }
  if (at < range.to) orphaned.push({ from: at, to: range.to });
  return { kept, orphaned };
}

/** One stretch of a record with the reason in effect there. */
export interface EffectiveSegment {
  readonly from: Millis;
  readonly to: Millis;
  readonly reason: string;
  /** Coded by an operator; otherwise the auto reason. */
  readonly coded: boolean;
}

/**
 * The reasons in effect over a record's [start, end): a coding's reason where one lies, the auto
 * reason elsewhere (ADR-0021). Codings are clipped to the record.
 */
export function effectiveSegments(
  start: Millis,
  end: Millis,
  autoReason: string,
  codings: readonly { readonly from: Date; readonly to: Date; readonly reason: string }[],
): EffectiveSegment[] {
  const segments: EffectiveSegment[] = [];
  let at = start;
  const sorted = [...codings].sort((a, b) => a.from.getTime() - b.from.getTime());
  for (const coding of sorted) {
    const from = Math.max(coding.from.getTime(), at);
    const to = Math.min(coding.to.getTime(), end);
    if (to <= from) continue;
    if (from > at) segments.push({ from: at, to: from, reason: autoReason, coded: false });
    segments.push({ from, to, reason: coding.reason, coded: true });
    at = to;
  }
  if (at < end || segments.length === 0) {
    segments.push({ from: at, to: Math.max(at, end), reason: autoReason, coded: false });
  }
  return segments;
}

/** The reason covering most of a record (the earliest on a tie): the record's reason. */
export function dominantReason(segments: readonly EffectiveSegment[]): string {
  const time = new Map<string, number>();
  for (const segment of segments) {
    time.set(segment.reason, (time.get(segment.reason) ?? 0) + segment.to - segment.from);
  }
  let best: string | undefined;
  for (const segment of segments) {
    if (best === undefined || (time.get(segment.reason) ?? 0) > (time.get(best) ?? 0)) {
      best = segment.reason;
    }
  }
  return best ?? UNCODED;
}

interface CodingRow {
  readonly id: number;
  readonly from_time: Date;
  readonly to_time: Date;
  readonly reason: string;
  readonly comment: string;
  readonly coded_by: string;
  readonly coded_at: Date;
  readonly version: number;
}

const toCoding = (row: CodingRow): Coding => ({
  from: row.from_time,
  to: row.to_time,
  reason: row.reason,
  comment: row.comment,
  codedBy: row.coded_by,
  codedAt: row.coded_at,
  version: row.version,
});

const auditCoding = (
  coding: Pick<Coding, 'reason' | 'comment' | 'codedBy' | 'codedAt'>,
  range: Range,
  orphaned?: boolean,
): AuditCoding => ({
  from: new Date(range.from).toISOString(),
  to: new Date(range.to).toISOString(),
  reason: coding.reason,
  comment: coding.comment,
  codedBy: coding.codedBy,
  codedAt: coding.codedAt.toISOString(),
  ...(orphaned === undefined ? {} : { orphaned }),
});

/**
 * Codings (not orphaned) and coding-set versions of the given (equipment, epoch) pairs over
 * [from, to): for the records' reason view.
 */
export async function readCodings(
  db: Kysely<Database>,
  pairs: readonly { readonly equipment: string; readonly epoch: number }[],
  from: Date,
  to: Date,
): Promise<{ codings: Map<string, Coding[]>; versions: Map<string, number> }> {
  const codings = new Map<string, Coding[]>();
  const versions = new Map<string, number>();
  const unique = [...new Map(pairs.map((p) => [pairKey(p.equipment, p.epoch), p])).values()];
  if (unique.length === 0) return { codings, versions };
  const equipment = unique.map((p) => p.equipment);
  const epochs = unique.map((p) => p.epoch);
  const [rows, sets] = await Promise.all([
    sql<CodingRow & { equipment: string; epoch: number }>`
      SELECT c.id, c.equipment, c.epoch, c.from_time, c.to_time, c.reason, c.comment, c.coded_by,
        c.coded_at, c.version
      FROM equipment.downtime_coding c
      JOIN unnest(${equipment}::text[], ${epochs}::bigint[]) AS p(equipment, epoch)
        ON p.equipment = c.equipment AND p.epoch = c.epoch
      WHERE NOT c.orphaned AND c.from_time < ${to} AND c.to_time > ${from}
      ORDER BY c.equipment, c.epoch, c.from_time`.execute(db),
    sql<{ equipment: string; epoch: number; version: number }>`
      SELECT s.equipment, s.epoch, s.version
      FROM equipment.downtime_coding_set s
      JOIN unnest(${equipment}::text[], ${epochs}::bigint[]) AS p(equipment, epoch)
        ON p.equipment = s.equipment AND p.epoch = s.epoch`.execute(db),
  ]);
  for (const row of rows.rows) {
    const key = pairKey(row.equipment, row.epoch);
    const list = codings.get(key);
    if (list) list.push(toCoding(row));
    else codings.set(key, [toCoding(row)]);
  }
  for (const row of sets.rows) versions.set(pairKey(row.equipment, row.epoch), row.version);
  return { codings, versions };
}

export const pairKey = (equipment: string, epoch: number): string =>
  `${equipment}\u0000${String(epoch)}`;

export interface DowntimeCodingOptions {
  readonly db: Kysely<Database>;
  /** Pieces changes (re-cuts) and the plant watermark (the end so far of an open record). */
  readonly equipment: {
    onPiecesChanged(listener: (change: CodingChange) => void): () => void;
    watermark(epoch: number): Date | undefined;
  };
  /** Whether a reason may be coded: an active master-data reason other than UNCODED. */
  readonly codable: (reason: string) => Promise<boolean>;
  /** How long piece changes gather before codings are clipped (wall ms, default 100). */
  readonly debounceMs?: number;
  readonly log?: {
    info(object: object, message: string): void;
    error(object: object, message: string): void;
  };
}

/** Most segments in one write. */
export const MAX_SEGMENTS = 32;

/**
 * Writes codings with optimistic concurrency per (equipment, epoch), and keeps them inside the
 * records' loss time: after a re-cut (`onPiecesChanged`) a coding is clipped to the loss time it
 * still covers, and the rest is flagged orphaned and audited.
 */
export class DowntimeCoding {
  readonly #db: Kysely<Database>;
  readonly #options: DowntimeCodingOptions;
  readonly #listeners = new Set<(change: CodingChange) => void>();
  readonly #pending = new Map<string, { equipment: string; epoch: number } & Range>();
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  /** Clip passes failed in a row: the backoff of the next one. */
  #failures = 0;
  #detach: (() => void) | undefined;

  constructor(options: DowntimeCodingOptions) {
    this.#db = options.db;
    this.#options = options;
  }

  /** Follows re-cuts, and clips every coding once (the records may have changed while away). */
  async start(): Promise<void> {
    this.#detach = this.#options.equipment.onPiecesChanged((change) => {
      this.#note(change.equipment, change.epoch, change.from.getTime(), change.to.getTime());
    });
    const sets = await this.#db
      .selectFrom('equipment.downtime_coding_set')
      .select(['equipment', 'epoch'])
      .execute();
    for (const set of sets) {
      await this.#clip(set.equipment, set.epoch, { from: EARLIEST, to: LATEST });
    }
  }

  stop(): void {
    this.#detach?.();
    this.#detach = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Waits until pending clips ran (tests). */
  async settle(): Promise<void> {
    while (this.#timer !== undefined || this.#running !== undefined) {
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#running ??= this.#pass();
      }
      await this.#running;
    }
  }

  /** Listens for written or clipped codings. Returns an unsubscribe. */
  onChange(listener: (change: CodingChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Replaces the codings of one record by `segments` (none: clears them), if the coding set of
   * its (equipment, epoch) is still at `version`. Returns the new version.
   */
  async code(key: RecordKey, request: CodeRequest): Promise<{ version: number }> {
    const segments = [...request.segments]
      .map((s) => ({ ...s, comment: s.comment ?? '' }))
      .sort((a, b) => a.from.getTime() - b.from.getTime());
    if (segments.length > MAX_SEGMENTS) {
      throw new CodingError('invalid', `at most ${String(MAX_SEGMENTS)} segments`);
    }
    for (const [i, segment] of segments.entries()) {
      if (segment.to.getTime() <= segment.from.getTime()) {
        throw new CodingError('invalid', 'a segment must end after it starts');
      }
      const previous = segments[i - 1];
      if (previous && previous.to.getTime() > segment.from.getTime()) {
        throw new CodingError('invalid', 'segments overlap');
      }
    }
    for (const reason of new Set(segments.map((s) => s.reason))) {
      if (reason === UNCODED || !(await this.#options.codable(reason))) {
        throw new CodingError('invalid', `reason ${reason} is not an active reason code`);
      }
    }
    const id = recordId(key);
    const result = await this.#db.transaction().execute(async (trx) => {
      // FOR SHARE: a rebuild that re-cuts this record (it deletes or rewrites the row) waits for
      // this write, so its `onPiecesChanged`, and the clip that follows, see the new codings. A
      // plain read would let a re-cut commit in between and leave the coding outside its record.
      const record = await trx
        .selectFrom('equipment.downtime_record')
        .select(['start_time', 'end_time'])
        .where('equipment', '=', key.equipment)
        .where('epoch', '=', key.epoch)
        .where('start_time', '=', key.start)
        .forShare()
        .executeTakeFirst();
      if (!record) throw new CodingError('not-found', `no downtime record ${id}`);
      const start = record.start_time.getTime();
      // An open record ends so far at its epoch's watermark.
      const end =
        record.end_time?.getTime() ??
        Math.max(start, this.#options.equipment.watermark(key.epoch)?.getTime() ?? start);
      for (const segment of segments) {
        if (segment.from.getTime() < start || segment.to.getTime() > end) {
          throw new CodingError(
            'invalid',
            `segments must lie in the record [${record.start_time.toISOString()}, ${new Date(end).toISOString()})`,
          );
        }
      }
      const version = await this.#lockSet(trx, key.equipment, key.epoch, true);
      if (version !== request.version) {
        throw new CodingError(
          'conflict',
          `the codings of ${key.equipment} (epoch ${String(key.epoch)}) changed: version is ${String(version ?? 0)}, not ${String(request.version)}`,
          PROBLEM_TYPES.codingStale,
        );
      }
      const next = version + 1;
      const span: RecordSpan = { start, end: record.end_time?.getTime() ?? null };
      const existing = await this.#codingsIn(trx, key.equipment, key.epoch, {
        from: start,
        to: span.end ?? LATEST,
      });
      const now = new Date();
      for (const row of existing) {
        await trx.deleteFrom('equipment.downtime_coding').where('id', '=', row.id).execute();
        // A coding reaching outside the record (only between a re-cut and its clip) keeps that part.
        const { orphaned: outside } = clipToRecords(
          { from: row.from_time.getTime(), to: row.to_time.getTime() },
          [span],
        );
        for (const part of outside) {
          await this.#insert(trx, key, row, part, row.version, false);
        }
      }
      for (const segment of segments) {
        await trx
          .insertInto('equipment.downtime_coding')
          .values({
            equipment: key.equipment,
            epoch: key.epoch,
            from_time: segment.from,
            to_time: segment.to,
            reason: segment.reason,
            comment: segment.comment,
            coded_by: request.codedBy,
            coded_at: now,
            version: next,
          })
          .execute();
      }
      await this.#setVersion(trx, key.equipment, key.epoch, next);
      const clippedBefore = existing.flatMap((row) => {
        const from = Math.max(row.from_time.getTime(), start);
        const to = Math.min(row.to_time.getTime(), span.end ?? Infinity);
        return to > from ? [auditCoding(toCoding(row), { from, to })] : [];
      });
      await this.#audit(trx, {
        equipment: key.equipment,
        epoch: key.epoch,
        recordId: id,
        from: record.start_time,
        to: record.end_time,
        action: segments.length === 0 ? 'cleared' : 'coded',
        before: clippedBefore,
        after: segments.map((s) =>
          auditCoding(
            { reason: s.reason, comment: s.comment, codedBy: request.codedBy, codedAt: now },
            { from: s.from.getTime(), to: s.to.getTime() },
          ),
        ),
        actor: request.codedBy,
        requestId: request.requestId ?? null,
        version: next,
      });
      return { version: next, from: start, to: end };
    });
    this.#emit({
      equipment: key.equipment,
      epoch: key.epoch,
      from: new Date(result.from),
      to: new Date(Math.max(result.to, result.from + 1)),
      kind: 'coded',
    });
    return { version: result.version };
  }

  /**
   * The audit of one record, newest first: the writes to it, and every entry of its (equipment,
   * epoch) over its time or over the codings written to it (a clip after a re-cut may concern
   * time the record no longer covers). A record that no longer exists is `not-found` (404).
   */
  async audit(key: RecordKey, db: Kysely<Database> = this.#db): Promise<AuditEntry[]> {
    const record = await db
      .selectFrom('equipment.downtime_record')
      .select(['start_time', 'end_time'])
      .where('equipment', '=', key.equipment)
      .where('epoch', '=', key.epoch)
      .where('start_time', '=', key.start)
      .executeTakeFirst();
    if (!record) throw new CodingError('not-found', `no downtime record ${recordId(key)}`);
    const id = recordId(key);
    const writes = await db
      .selectFrom('equipment.downtime_audit')
      .select(['before', 'after'])
      .where('equipment', '=', key.equipment)
      .where('epoch', '=', key.epoch)
      .where('record_id', '=', id)
      .execute();
    let from = record.start_time.getTime();
    let to = record.end_time?.getTime() ?? LATEST;
    for (const write of writes) {
      for (const coding of [
        ...(write.before as AuditCoding[]),
        ...(write.after as AuditCoding[]),
      ]) {
        from = Math.min(from, Date.parse(coding.from));
        to = Math.max(to, Date.parse(coding.to));
      }
    }
    const rows = await db
      .selectFrom('equipment.downtime_audit')
      .selectAll()
      .where('equipment', '=', key.equipment)
      .where('epoch', '=', key.epoch)
      .where((eb) =>
        eb.or([
          eb('record_id', '=', id),
          eb.and([
            eb('from_time', '<', new Date(to)),
            eb.or([eb('to_time', 'is', null), eb('to_time', '>', new Date(from))]),
          ]),
        ]),
      )
      .orderBy('id', 'desc')
      .limit(500)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      equipment: row.equipment,
      epoch: row.epoch,
      recordId: row.record_id,
      from: row.from_time,
      to: row.to_time,
      action: row.action as AuditAction,
      before: row.before as AuditCoding[],
      after: row.after as AuditCoding[],
      actor: row.actor,
      authenticated: row.authenticated,
      at: row.at,
      requestId: row.request_id,
      version: row.version,
    }));
  }

  #note(equipment: string, epoch: number, from: Millis, to: Millis): void {
    const key = pairKey(equipment, epoch);
    const pending = this.#pending.get(key);
    this.#pending.set(key, {
      equipment,
      epoch,
      from: Math.min(pending?.from ?? from, from),
      to: Math.max(pending?.to ?? to, to),
    });
    // While clips fail, the next pass waits for the backoff instead.
    if (this.#failures === 0) this.#schedule(this.#options.debounceMs ?? 100);
  }

  #schedule(delayMs: number): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#running ??= this.#pass();
    }, delayMs).unref();
  }

  async #pass(): Promise<void> {
    let failed = false;
    try {
      const work = [...this.#pending.values()];
      this.#pending.clear();
      for (const item of work) {
        try {
          // A record lies in one shift bucket (at most a day): codings of records that the
          // changed hours re-cut start at most that much before them.
          await this.#clip(item.equipment, item.epoch, {
            from: item.from - DAY,
            to: item.to + DAY,
          });
        } catch (error) {
          failed = true;
          this.#options.log?.error({ err: error }, 'clipping downtime codings failed; retrying');
          const key = pairKey(item.equipment, item.epoch);
          const pending = this.#pending.get(key);
          this.#pending.set(key, {
            ...item,
            from: Math.min(pending?.from ?? item.from, item.from),
            to: Math.max(pending?.to ?? item.to, item.to),
          });
        }
      }
    } finally {
      this.#running = undefined;
      const debounce = this.#options.debounceMs ?? 100;
      // Failures back off exponentially (0.2 s, 0.4 s, … at most 30 s); a success resets it.
      this.#failures = failed ? this.#failures + 1 : 0;
      if (this.#pending.size > 0) {
        this.#schedule(failed ? Math.min(MAX_RETRY_MS, debounce * 2 ** this.#failures) : debounce);
      }
    }
  }

  /** Clips the codings of (equipment, epoch) overlapping `window` to the records' loss time. */
  async #clip(equipment: string, epoch: number, window: Range): Promise<void> {
    const changed = await this.#db.transaction().execute(async (trx) => {
      const version = await this.#lockSet(trx, equipment, epoch, false);
      if (version === undefined) return undefined;
      const codings = await this.#codingsIn(trx, equipment, epoch, window);
      if (codings.length === 0) return undefined;
      const from = Math.min(...codings.map((c) => c.from_time.getTime()));
      const to = Math.max(...codings.map((c) => c.to_time.getTime()));
      const records = await trx
        .selectFrom('equipment.downtime_record')
        .select(['start_time', 'end_time'])
        .where('equipment', '=', equipment)
        .where('epoch', '=', epoch)
        .where('start_time', '<', new Date(to))
        .where((eb) => eb.or([eb('end_time', 'is', null), eb('end_time', '>', new Date(from))]))
        .execute();
      const spans = records.map((r) => ({
        start: r.start_time.getTime(),
        end: r.end_time?.getTime() ?? null,
      }));
      const clips = codings.flatMap((row) => {
        const range = { from: row.from_time.getTime(), to: row.to_time.getTime() };
        const parts = clipToRecords(range, spans);
        const same =
          parts.orphaned.length === 0 &&
          parts.kept.length === 1 &&
          parts.kept[0]?.from === range.from &&
          parts.kept[0].to === range.to;
        return same ? [] : [{ row, range, ...parts }];
      });
      if (clips.length === 0) return undefined;
      const next = version + 1;
      const now = new Date();
      for (const clip of clips) {
        const { row } = clip;
        await trx.deleteFrom('equipment.downtime_coding').where('id', '=', row.id).execute();
        const key = { equipment, epoch, start: row.from_time };
        for (const part of clip.kept) await this.#insert(trx, key, row, part, next, false);
        for (const part of clip.orphaned) await this.#insert(trx, key, row, part, next, now);
        const coding = toCoding(row);
        await this.#audit(trx, {
          equipment,
          epoch,
          recordId: null,
          from: row.from_time,
          to: row.to_time,
          action: 'orphaned',
          before: [auditCoding(coding, clip.range)],
          after: [
            ...clip.kept.map((part) => auditCoding(coding, part, false)),
            ...clip.orphaned.map((part) => auditCoding(coding, part, true)),
          ].sort((a, b) => a.from.localeCompare(b.from)),
          actor: 'system',
          requestId: null,
          version: next,
        });
      }
      await this.#setVersion(trx, equipment, epoch, next);
      this.#options.log?.info(
        {
          equipment,
          epoch,
          clipped: clips.length,
          orphanedMs: clips.reduce(
            (sum, c) => sum + c.orphaned.reduce((s, p) => s + p.to - p.from, 0),
            0,
          ),
        },
        'downtime codings clipped after a re-cut',
      );
      return { from, to };
    });
    if (changed) {
      this.#emit({
        equipment,
        epoch,
        from: new Date(changed.from),
        to: new Date(changed.to),
        kind: 'clipped',
      });
    }
  }

  async #lockSet(
    trx: Transaction<Database>,
    equipment: string,
    epoch: number,
    create: boolean,
  ): Promise<number | undefined> {
    if (create) {
      await trx
        .insertInto('equipment.downtime_coding_set')
        .values({ equipment, epoch })
        .onConflict((oc) => oc.columns(['equipment', 'epoch']).doNothing())
        .execute();
    }
    const row = await trx
      .selectFrom('equipment.downtime_coding_set')
      .select('version')
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .forUpdate()
      .executeTakeFirst();
    return row?.version;
  }

  async #setVersion(
    trx: Transaction<Database>,
    equipment: string,
    epoch: number,
    version: number,
  ): Promise<void> {
    await trx
      .updateTable('equipment.downtime_coding_set')
      .set({ version, updated_at: new Date() })
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .execute();
  }

  async #codingsIn(
    trx: Transaction<Database>,
    equipment: string,
    epoch: number,
    range: Range,
  ): Promise<CodingRow[]> {
    return trx
      .selectFrom('equipment.downtime_coding')
      .select([
        'id',
        'from_time',
        'to_time',
        'reason',
        'comment',
        'coded_by',
        'coded_at',
        'version',
      ])
      .where('equipment', '=', equipment)
      .where('epoch', '=', epoch)
      .where('orphaned', '=', false)
      .where('from_time', '<', new Date(Math.min(range.to, LATEST)))
      .where('to_time', '>', new Date(Math.max(range.from, EARLIEST)))
      .orderBy('from_time')
      .execute();
  }

  async #insert(
    trx: Transaction<Database>,
    key: RecordKey,
    row: CodingRow,
    part: Range,
    version: number,
    orphanedAt: Date | false,
  ): Promise<void> {
    await trx
      .insertInto('equipment.downtime_coding')
      .values({
        equipment: key.equipment,
        epoch: key.epoch,
        from_time: new Date(part.from),
        to_time: new Date(part.to),
        reason: row.reason,
        comment: row.comment,
        coded_by: row.coded_by,
        coded_at: row.coded_at,
        version,
        orphaned: orphanedAt !== false,
        orphaned_at: orphanedAt === false ? null : orphanedAt,
      })
      .execute();
  }

  async #audit(
    trx: Transaction<Database>,
    entry: Omit<AuditEntry, 'id' | 'at' | 'authenticated'>,
  ): Promise<void> {
    await trx
      .insertInto('equipment.downtime_audit')
      .values({
        equipment: entry.equipment,
        epoch: entry.epoch,
        record_id: entry.recordId,
        from_time: entry.from,
        to_time: entry.to,
        action: entry.action,
        before: JSON.stringify(entry.before),
        after: JSON.stringify(entry.after),
        actor: entry.actor,
        request_id: entry.requestId,
        version: entry.version,
      })
      .execute();
  }

  #emit(change: CodingChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#options.log?.error({ err: error }, 'coding listener failed');
      }
    }
  }
}
