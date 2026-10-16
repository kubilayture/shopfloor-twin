/**
 * The operator's side of an alarm (#143, ADR-0023, ADR-0024 "Operator lifecycle"): acknowledgement
 * per occurrence (insert-only, monotonic), the shelf per alarm point (versioned, with a limit in
 * plant time), comments, and the append-only audit `alarms.alarm_transition`. Nothing here touches
 * `alarm_occurrence` or any KPI: every raise counts, shelved or acknowledged or not.
 */
import type { Priority } from '@shopfloor/alarm-core';
import { PROBLEM_TYPES, type ProblemType } from '@shopfloor/contracts/mes-api';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import { Identity, auditActor, isAuthenticated, nameOf, type WriteBy } from '../identity/index.ts';
import type { EndReason, TransitionAction } from './tables.ts';

type Db = Kysely<Database> | Transaction<Database>;
type Millis = number;

/** The plant clock: the newest epoch's watermark (`Equipment.watermarks()[0]`). */
export interface PlantClock {
  readonly epoch: number;
  readonly watermark: Date;
}

export type AlarmWriteErrorKind = 'not-found' | 'conflict' | 'invalid';

/** A refused alarm write: the API answers 404, 409 or 422. */
export class AlarmWriteError extends Error {
  readonly kind: AlarmWriteErrorKind;
  /** The problem type a client tells apart (#163); `about:blank` without one. */
  readonly type: ProblemType | undefined;

  constructor(kind: AlarmWriteErrorKind, message: string, type?: ProblemType) {
    super(message);
    this.kind = kind;
    this.type = type;
  }
}

/** ISA-18.2 state of an occurrence (the device owns active, the operator acknowledged). */
export type AlarmState = 'unacked-active' | 'acked-active' | 'unacked-cleared' | 'closed';

export interface Acknowledgement {
  /** As typed: unauthenticated. */
  readonly by: string;
  /** Wall time. */
  readonly at: Date;
  /** The plant clock at that moment, or null without one. */
  readonly plantAt: Date | null;
  readonly comment: string;
}

/** The operator's view of one occurrence. */
export interface OperatorView {
  readonly acknowledged: Acknowledgement | null;
  /** Its point is shelved now. */
  readonly shelved: boolean;
  readonly comments: number;
}

export const NO_OPERATOR: OperatorView = { acknowledged: null, shelved: false, comments: 0 };

/**
 * The state of an occurrence: a clear does not acknowledge (`unacked-cleared` stays in the active
 * list until acknowledged); `closed` once ended and acknowledged, or ended by a newer epoch (the run
 * it belonged to is gone, so nobody has to acknowledge it).
 */
export function alarmState(
  endedAt: Date | Millis | null,
  endReason: EndReason | null,
  acknowledged: boolean,
): AlarmState {
  if (endedAt === null) return acknowledged ? 'acked-active' : 'unacked-active';
  return acknowledged || endReason === 'epoch-ended' ? 'closed' : 'unacked-cleared';
}

export interface AlarmShelf {
  readonly shelved: boolean;
  readonly version: number;
  readonly by: string | null;
  readonly reason: string | null;
  /** Wall time of the shelve. */
  readonly shelvedAt: Date | null;
  /** The plant clock's epoch and time at the shelve, and the plant time it ends at. */
  readonly epoch: number | null;
  readonly plantAt: Date | null;
  readonly until: Date | null;
  readonly durationMs: number | null;
}

export const UNSHELVED: AlarmShelf = {
  shelved: false,
  version: 0,
  by: null,
  reason: null,
  shelvedAt: null,
  epoch: null,
  plantAt: null,
  until: null,
  durationMs: null,
};

export interface AlarmComment {
  readonly id: number;
  readonly text: string;
  readonly actor: string;
  readonly authenticated: boolean;
  readonly at: Date;
  readonly plantAt: Date | null;
  readonly requestId: string | null;
}

/** One entry of `alarms.alarm_transition`. */
export interface AlarmTransition {
  readonly id: number;
  readonly equipment: string;
  readonly code: string;
  readonly epoch: number | null;
  readonly seq: number | null;
  readonly action: TransitionAction;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly actor: string;
  readonly authenticated: boolean;
  /** Wall time. */
  readonly at: Date;
  readonly plantAt: Date | null;
  readonly plantEpoch: number | null;
  readonly requestId: string | null;
  readonly version: number | null;
}

/** An alarm point (equipment, code) with its definition, shelf and active occurrence. */
export interface AlarmPoint {
  readonly equipment: string;
  readonly code: string;
  readonly defined: boolean;
  readonly priority: Priority | null;
  readonly text: string | null;
  readonly shelf: AlarmShelf;
  /** The id of its occurrence still active (device), or null. */
  readonly activeOccurrence: string | null;
}

export interface OccurrenceKey {
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
}

interface ShelfRow {
  equipment: string;
  code: string;
  version: number;
  shelved: boolean;
  shelved_by: string | null;
  reason: string | null;
  shelved_at: Date | null;
  plant_epoch: number | null;
  plant_at: Date | null;
  until: Date | null;
  duration_ms: number | null;
}

export const toShelf = (row: ShelfRow | undefined): AlarmShelf =>
  row === undefined
    ? UNSHELVED
    : {
        shelved: row.shelved,
        version: row.version,
        by: row.shelved_by,
        reason: row.reason,
        shelvedAt: row.shelved_at,
        epoch: row.plant_epoch,
        plantAt: row.plant_at,
        until: row.until,
        durationMs: row.duration_ms,
      };

/** A shelf as the audit records it (`before`, `after`). */
export const shelfJson = (shelf: AlarmShelf): Record<string, unknown> => ({
  shelved: shelf.shelved,
  version: shelf.version,
  by: shelf.by,
  reason: shelf.reason,
  shelvedAt: shelf.shelvedAt?.toISOString() ?? null,
  epoch: shelf.epoch,
  plantAt: shelf.plantAt?.toISOString() ?? null,
  until: shelf.until?.toISOString() ?? null,
  durationMs: shelf.durationMs,
});

export const pointKey = (equipment: string, code: string): string => `${equipment}/${code}`;
const occurrenceKey = (key: OccurrenceKey): string =>
  `${key.equipment}~${String(key.epoch)}~${String(key.seq)}`;

/** Sorted, so concurrent writes lock and insert keys in one order (no deadlock). */
const byKey = (a: OccurrenceKey, b: OccurrenceKey): number =>
  a.equipment < b.equipment
    ? -1
    : a.equipment > b.equipment
      ? 1
      : a.epoch - b.epoch || a.seq - b.seq;

const columns = (keys: readonly OccurrenceKey[]) => ({
  equipment: keys.map((k) => k.equipment),
  epochs: keys.map((k) => k.epoch),
  seqs: keys.map((k) => k.seq),
});

/** The operator views of some occurrences (acknowledgement, shelf of the point, comment count). */
export async function operatorViews(
  db: Db,
  keys: readonly (OccurrenceKey & { readonly code: string })[],
): Promise<Map<string, OperatorView>> {
  const result = new Map<string, OperatorView>();
  if (keys.length === 0) return result;
  const { equipment, epochs, seqs } = columns(keys);
  const codes = keys.map((k) => k.code);
  const rows = await sql<{
    equipment: string;
    epoch: number;
    seq: number;
    acknowledged_by: string | null;
    acknowledged_at: Date | null;
    plant_at: Date | null;
    comment: string | null;
    shelved: boolean | null;
    comments: number;
  }>`
    SELECT k.equipment, k.epoch, k.seq, s.acknowledged_by, s.acknowledged_at, s.plant_at,
      s.comment, sh.shelved,
      (SELECT count(*) FROM alarms.alarm_transition t
        WHERE t.equipment = k.equipment AND t.epoch = k.epoch AND t.seq = k.seq
          AND t.action = 'comment') AS comments
    FROM unnest(${equipment}::text[], ${epochs}::bigint[], ${seqs}::bigint[], ${codes}::text[])
      AS k(equipment, epoch, seq, code)
    LEFT JOIN alarms.occurrence_state s
      ON s.equipment = k.equipment AND s.epoch = k.epoch AND s.seq = k.seq
    LEFT JOIN alarms.alarm_shelf sh ON sh.equipment = k.equipment AND sh.code = k.code`.execute(db);
  for (const row of rows.rows) {
    result.set(occurrenceKey(row), {
      acknowledged:
        row.acknowledged_by !== null && row.acknowledged_at !== null
          ? {
              by: row.acknowledged_by,
              at: row.acknowledged_at,
              plantAt: row.plant_at,
              comment: row.comment ?? '',
            }
          : null,
      shelved: row.shelved === true,
      comments: row.comments,
    });
  }
  return result;
}

/** SQLSTATE of a deadlock and of a serialization failure: the transaction may simply be retried. */
const RETRYABLE = new Set(['40P01', '40001']);
const TRIES = 3;

/**
 * Runs a write transaction, again (up to 3 tries, after a short random pause) when PostgreSQL
 * aborted it as a deadlock victim or for a serialization failure: an acknowledgement racing a
 * rebuild of the occurrences it locks (#143 review). Every try is a whole transaction, so a retry
 * sees the rebuild's result (an occurrence it deleted is then `not-found`).
 */
export async function retrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (attempt >= TRIES || typeof code !== 'string' || !RETRYABLE.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
    }
  }
}

export interface WriteContext {
  /** The session's user, or (`MES_AUTH=off`, until #170) the name as typed. */
  readonly actor: WriteBy;
  readonly requestId?: string | undefined;
  readonly clock: PlantClock | undefined;
}

/** Entity of an operator transition in `identity.audit_log` (#169, as migration 0018 maps). */
export const auditEntity = (entry: {
  readonly equipment: string;
  readonly code: string;
  readonly epoch?: number | null;
  readonly seq?: number | null;
}): { entityType: string; entityId: string } =>
  entry.seq === undefined || entry.seq === null || entry.epoch === undefined || entry.epoch === null
    ? { entityType: 'alarm-point', entityId: pointKey(entry.equipment, entry.code) }
    : {
        entityType: 'alarm-occurrence',
        entityId: `${entry.equipment}~${String(entry.epoch)}~${String(entry.seq)}`,
      };

/**
 * Records transitions in `alarms.alarm_transition` (the module's transition log) and, for an
 * operator's (every one but `system`'s expiry and epoch end), in `identity.audit_log` as well
 * (#169): both in the caller's transaction.
 */
async function audit(
  trx: Transaction<Database>,
  entries: readonly {
    equipment: string;
    code: string;
    epoch?: number | null;
    seq?: number | null;
    action: TransitionAction;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    actor: WriteBy;
    plantAt: Date | null;
    plantEpoch: number | null;
    requestId?: string | null | undefined;
    version?: number | null;
  }[],
): Promise<void> {
  if (entries.length === 0) return;
  await trx
    .insertInto('alarms.alarm_transition')
    .values(
      entries.map((entry) => ({
        equipment: entry.equipment,
        code: entry.code,
        epoch: entry.epoch ?? null,
        seq: entry.seq ?? null,
        action: entry.action,
        before:
          entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
        after:
          entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
        actor: nameOf(entry.actor),
        authenticated: isAuthenticated(entry.actor),
        plant_at: entry.plantAt,
        plant_epoch: entry.plantEpoch,
        request_id: entry.requestId ?? null,
        version: entry.version ?? null,
      })),
    )
    .execute();
  await Identity.audit(
    trx,
    ...entries.flatMap((entry) =>
      SYSTEM_ACTIONS.has(entry.action)
        ? []
        : [
            {
              actor: auditActor(entry.actor),
              authenticated: isAuthenticated(entry.actor),
              action: `alarm.${entry.action}`,
              ...auditEntity(entry),
              before: entry.before ?? undefined,
              after:
                entry.version === undefined || entry.version === null
                  ? (entry.after ?? undefined)
                  : { ...entry.after, version: entry.version },
              requestId: entry.requestId ?? undefined,
              plantAt: entry.plantAt ?? undefined,
            },
          ],
    ),
  );
}

/** Transitions the module makes itself: only in its transition log, not in the audit log. */
const SYSTEM_ACTIONS: ReadonlySet<TransitionAction> = new Set(['expire', 'epoch-ended']);

/**
 * Locks the occurrences (FOR SHARE: a rebuild that rewrites or deletes one waits for this write)
 * and returns their codes; an unknown one is `not-found` and nothing changes.
 */
async function lockOccurrences(
  trx: Transaction<Database>,
  keys: readonly OccurrenceKey[],
): Promise<Map<string, string>> {
  const { equipment, epochs, seqs } = columns(keys);
  const rows = await sql<OccurrenceKey & { code: string }>`
    SELECT o.equipment, o.epoch, o.seq, o.code
    FROM alarms.alarm_occurrence o
    JOIN unnest(${equipment}::text[], ${epochs}::bigint[], ${seqs}::bigint[])
      AS k(equipment, epoch, seq)
      ON k.equipment = o.equipment AND k.epoch = o.epoch AND k.seq = o.seq
    ORDER BY o.equipment, o.epoch, o.seq
    FOR SHARE OF o`.execute(trx);
  const codes = new Map(rows.rows.map((row) => [occurrenceKey(row), row.code]));
  const missing = keys.find((key) => !codes.has(occurrenceKey(key)));
  if (missing) throw new AlarmWriteError('not-found', `no alarm ${occurrenceKey(missing)}`);
  return codes;
}

/**
 * Acknowledges occurrences in one transaction (ADR-0024, review fix 13): one
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`, and audit rows only for the rows it inserted. An
 * occurrence acknowledged already, or concurrently by another request, is skipped without an audit
 * row. Returns the keys this call acknowledged.
 */
export async function acknowledge(
  db: Kysely<Database>,
  keys: readonly OccurrenceKey[],
  context: WriteContext & { readonly comment: string },
): Promise<Set<string>> {
  const sorted = [...new Map(keys.map((k) => [occurrenceKey(k), k])).values()].sort(byKey);
  if (sorted.length === 0) return new Set();
  const now = new Date();
  const plantAt = context.clock?.watermark ?? null;
  const plantEpoch = context.clock?.epoch ?? null;
  return retrying(() =>
    db.transaction().execute(async (trx) => {
      const codes = await lockOccurrences(trx, sorted);
      const { equipment, epochs, seqs } = columns(sorted);
      const inserted = await sql<OccurrenceKey>`
      INSERT INTO alarms.occurrence_state AS s
        (equipment, epoch, seq, acknowledged_by, acknowledged_at, plant_at, plant_epoch, comment,
         request_id)
      SELECT k.equipment, k.epoch, k.seq, ${nameOf(context.actor)}, ${now}, ${plantAt}::timestamptz,
        ${plantEpoch}::bigint, ${context.comment}, ${context.requestId ?? null}::text
      FROM unnest(${equipment}::text[], ${epochs}::bigint[], ${seqs}::bigint[])
        WITH ORDINALITY AS k(equipment, epoch, seq, ord)
      ORDER BY k.ord
      ON CONFLICT (equipment, epoch, seq) DO NOTHING
      RETURNING s.equipment, s.epoch, s.seq`.execute(trx);
      const changed = inserted.rows.sort(byKey);
      await audit(
        trx,
        changed.map((key) => ({
          equipment: key.equipment,
          code: codes.get(occurrenceKey(key)) ?? '',
          epoch: key.epoch,
          seq: key.seq,
          action: 'ack' as const,
          before: { acknowledged: false },
          after: { acknowledged: true, by: nameOf(context.actor), comment: context.comment },
          actor: context.actor,
          plantAt,
          plantEpoch,
          requestId: context.requestId,
        })),
      );
      return new Set(changed.map(occurrenceKey));
    }),
  );
}

/** Adds a comment to an occurrence (append-only, in the audit). */
export async function addComment(
  db: Kysely<Database>,
  key: OccurrenceKey,
  context: WriteContext & { readonly text: string },
): Promise<AlarmComment> {
  const plantAt = context.clock?.watermark ?? null;
  const plantEpoch = context.clock?.epoch ?? null;
  return retrying(() =>
    db.transaction().execute(async (trx) => {
      const codes = await lockOccurrences(trx, [key]);
      const row = await trx
        .insertInto('alarms.alarm_transition')
        .values({
          equipment: key.equipment,
          code: codes.get(occurrenceKey(key)) ?? '',
          epoch: key.epoch,
          seq: key.seq,
          action: 'comment',
          before: null,
          after: JSON.stringify({ text: context.text }),
          actor: nameOf(context.actor),
          authenticated: isAuthenticated(context.actor),
          plant_at: plantAt,
          plant_epoch: plantEpoch,
          request_id: context.requestId ?? null,
          version: null,
        })
        .returning(['id', 'at', 'authenticated'])
        .executeTakeFirstOrThrow();
      await Identity.audit(trx, {
        actor: auditActor(context.actor),
        authenticated: isAuthenticated(context.actor),
        action: 'alarm.comment',
        ...auditEntity({ ...key, code: codes.get(occurrenceKey(key)) ?? '' }),
        after: { text: context.text },
        requestId: context.requestId,
        plantAt: plantAt ?? undefined,
      });
      return {
        id: row.id,
        text: context.text,
        actor: nameOf(context.actor),
        authenticated: row.authenticated,
        at: row.at,
        plantAt,
        requestId: context.requestId ?? null,
      };
    }),
  );
}

const toTransition = (row: {
  id: number;
  equipment: string;
  code: string;
  epoch: number | null;
  seq: number | null;
  action: TransitionAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor: string;
  authenticated: boolean;
  at: Date;
  plant_at: Date | null;
  plant_epoch: number | null;
  request_id: string | null;
  version: number | null;
}): AlarmTransition => ({
  id: row.id,
  equipment: row.equipment,
  code: row.code,
  epoch: row.epoch,
  seq: row.seq,
  action: row.action,
  before: row.before,
  after: row.after,
  actor: row.actor,
  authenticated: row.authenticated,
  at: row.at,
  plantAt: row.plant_at,
  plantEpoch: row.plant_epoch,
  requestId: row.request_id,
  version: row.version,
});

/** The comments of an occurrence, oldest first. */
export async function comments(db: Db, key: OccurrenceKey): Promise<AlarmComment[]> {
  const rows = await db
    .selectFrom('alarms.alarm_transition')
    .selectAll()
    .where('equipment', '=', key.equipment)
    .where('epoch', '=', key.epoch)
    .where('seq', '=', key.seq)
    .where('action', '=', 'comment')
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    text: typeof row.after?.text === 'string' ? row.after.text : '',
    actor: row.actor,
    authenticated: row.authenticated,
    at: row.at,
    plantAt: row.plant_at,
    requestId: row.request_id,
  }));
}

/**
 * The audit entries of an occurrence for its history: its acknowledgement and comments, and its
 * point's shelf transitions in the same plant epoch from its raise to its end, and the shelve in
 * effect at its raise (the point's newest transition before the raise, when that is a shelve).
 */
export async function occurrenceTransitions(
  db: Db,
  key: OccurrenceKey & {
    readonly code: string;
    readonly raisedAt: Date;
    readonly endedAt: Date | null;
  },
): Promise<AlarmTransition[]> {
  const rows = await db
    .selectFrom('alarms.alarm_transition')
    .selectAll()
    .where('equipment', '=', key.equipment)
    .where((eb) =>
      eb.or([
        eb.and([eb('epoch', '=', key.epoch), eb('seq', '=', key.seq)]),
        eb.and([
          eb('seq', 'is', null),
          eb('code', '=', key.code),
          eb('plant_epoch', '=', key.epoch),
          eb('plant_at', '>=', key.raisedAt),
          ...(key.endedAt === null ? [] : [eb('plant_at', '<=', key.endedAt)]),
        ]),
      ]),
    )
    .orderBy('id')
    .limit(1_000)
    .execute();
  const before = await db
    .selectFrom('alarms.alarm_transition')
    .selectAll()
    .where('equipment', '=', key.equipment)
    .where('code', '=', key.code)
    .where('seq', 'is', null)
    .where('plant_epoch', '=', key.epoch)
    .where('plant_at', '<', key.raisedAt)
    .orderBy('plant_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const shelvedAtRaise = before?.action === 'shelve' ? [before] : [];
  return [...shelvedAtRaise, ...rows].map(toTransition);
}

/** A point's audit, newest first: shelf transitions and its occurrences' acks and comments. */
export async function pointTransitions(
  db: Db,
  equipment: string,
  code: string,
  limit: number,
): Promise<AlarmTransition[]> {
  const rows = await db
    .selectFrom('alarms.alarm_transition')
    .selectAll()
    .where('equipment', '=', equipment)
    .where('code', '=', code)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toTransition);
}

/** The shelves of some points (or every point with a shelf row). */
export async function shelves(
  db: Db,
  points?: readonly { readonly equipment: string; readonly code: string }[],
): Promise<Map<string, AlarmShelf>> {
  let select = db.selectFrom('alarms.alarm_shelf').selectAll();
  if (points !== undefined) {
    if (points.length === 0) return new Map();
    const equipment = points.map((p) => p.equipment);
    const codes = points.map((p) => p.code);
    select = select.where(
      sql<boolean>`(equipment, code) IN (SELECT * FROM unnest(${equipment}::text[], ${codes}::text[]))`,
    );
  }
  const rows = await select.execute();
  return new Map(rows.map((row) => [pointKey(row.equipment, row.code), toShelf(row)]));
}

/** The row of a point's shelf, created at version 0 if missing, locked for the transaction. */
async function lockShelf(
  trx: Transaction<Database>,
  equipment: string,
  code: string,
): Promise<ShelfRow> {
  await trx
    .insertInto('alarms.alarm_shelf')
    .values({ equipment, code })
    .onConflict((oc) => oc.columns(['equipment', 'code']).doNothing())
    .execute();
  return trx
    .selectFrom('alarms.alarm_shelf')
    .selectAll()
    .where('equipment', '=', equipment)
    .where('code', '=', code)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

const conflict = (equipment: string, code: string, version: number, sent: number) =>
  new AlarmWriteError(
    'conflict',
    `the shelf of ${equipment}/${code} changed: version is ${String(version)}, not ${String(sent)}`,
    PROBLEM_TYPES.shelfStale,
  );

/**
 * Shelves a point (or replaces its shelf) for `durationMs` of plant time, if its shelf is still at
 * `version`: `until` = the plant clock now + the duration. Returns the new shelf.
 */
export async function shelve(
  db: Kysely<Database>,
  equipment: string,
  code: string,
  request: WriteContext & {
    readonly reason: string;
    readonly durationMs: number;
    readonly version: number;
  },
): Promise<AlarmShelf> {
  const clock = request.clock;
  if (!clock) throw new AlarmWriteError('invalid', 'no plant clock yet: nothing to shelve against');
  return db.transaction().execute(async (trx) => {
    const row = await lockShelf(trx, equipment, code);
    if (row.version !== request.version) {
      throw conflict(equipment, code, row.version, request.version);
    }
    const before = toShelf(row);
    const now = new Date();
    const plantAt = clock.watermark;
    const after: AlarmShelf = {
      shelved: true,
      version: row.version + 1,
      by: nameOf(request.actor),
      reason: request.reason,
      shelvedAt: now,
      epoch: clock.epoch,
      plantAt,
      until: new Date(plantAt.getTime() + request.durationMs),
      durationMs: request.durationMs,
    };
    await writeShelf(trx, equipment, code, after);
    await audit(trx, [
      {
        equipment,
        code,
        action: 'shelve',
        before: shelfJson(before),
        after: shelfJson(after),
        actor: request.actor,
        plantAt,
        plantEpoch: clock.epoch,
        requestId: request.requestId,
        version: after.version,
      },
    ]);
    return after;
  });
}

/**
 * Unshelves a point, if its shelf is still at `version` and it is shelved. Audited in the shelf's
 * own epoch (#156): when a newer epoch has begun but `endShelves` has not ended the shelf yet, the
 * unshelve is recorded at the old epoch's last plant time (`watermarkOf`, never past `until`), so
 * the old epoch's shelved time is not overstated and the new epoch gets no transition.
 */
export async function unshelve(
  db: Kysely<Database>,
  equipment: string,
  code: string,
  request: WriteContext & {
    readonly version: number;
    readonly watermarkOf?: ((epoch: number) => Date | undefined) | undefined;
  },
): Promise<AlarmShelf> {
  return db.transaction().execute(async (trx) => {
    const row = await lockShelf(trx, equipment, code);
    if (row.version !== request.version) {
      throw conflict(equipment, code, row.version, request.version);
    }
    if (!row.shelved) {
      throw new AlarmWriteError('invalid', `${equipment}/${code} is not shelved`);
    }
    const after: AlarmShelf = { ...UNSHELVED, version: row.version + 1 };
    await writeShelf(trx, equipment, code, after);
    const plant = unshelvePlantTime(row, request.clock, request.watermarkOf);
    await audit(trx, [
      {
        equipment,
        code,
        action: 'unshelve',
        before: shelfJson(toShelf(row)),
        after: shelfJson(after),
        actor: request.actor,
        plantAt: plant.at,
        plantEpoch: plant.epoch,
        requestId: request.requestId,
        version: after.version,
      },
    ]);
    return after;
  });
}

/**
 * Where an unshelve lands in plant time (#156): the plant clock when the shelf is of the clock's
 * epoch (or has none); else the shelf's own epoch, at that epoch's last plant time but never past
 * the shelf's `until` (null when the old epoch's clock is unknown).
 */
export function unshelvePlantTime(
  shelf: { readonly plant_epoch: number | null; readonly until: Date | null },
  clock: PlantClock | undefined,
  watermarkOf: ((epoch: number) => Date | undefined) | undefined,
): { readonly epoch: number | null; readonly at: Date | null } {
  const own = shelf.plant_epoch;
  if (own === null || own === clock?.epoch) {
    return { epoch: clock?.epoch ?? own, at: clock?.watermark ?? null };
  }
  const old = watermarkOf?.(own);
  if (old === undefined) return { epoch: own, at: null };
  return { epoch: own, at: new Date(Math.min(old.getTime(), shelf.until?.getTime() ?? Infinity)) };
}

async function writeShelf(
  trx: Transaction<Database>,
  equipment: string,
  code: string,
  shelf: AlarmShelf,
): Promise<void> {
  await trx
    .updateTable('alarms.alarm_shelf')
    .set({
      version: shelf.version,
      shelved: shelf.shelved,
      shelved_by: shelf.by,
      reason: shelf.reason,
      shelved_at: shelf.shelvedAt,
      plant_epoch: shelf.epoch,
      plant_at: shelf.plantAt,
      until: shelf.until,
      duration_ms: shelf.durationMs,
      updated_at: new Date(),
    })
    .where('equipment', '=', equipment)
    .where('code', '=', code)
    .execute();
}

export interface ShelfEnd {
  readonly equipment: string;
  readonly code: string;
  readonly action: 'expire' | 'epoch-ended';
  readonly shelf: AlarmShelf;
}

/**
 * Ends the shelves the plant clock has passed (ADR-0024, #143), audited with actor `system`:
 *
 * - `expire`: the clock of the shelf's epoch reached its `until` (recorded at plant time `until`);
 * - `epoch-ended`: the plant clock is in a newer epoch and the old epoch's clock (`watermarkOf`)
 *   never reached `until` (recorded at the old epoch's last plant time). Plant time starts over in
 *   a new epoch, so a shelf can't run on into it.
 */
export async function endShelves(
  db: Kysely<Database>,
  clock: PlantClock,
  watermarkOf: (epoch: number) => Date | undefined,
): Promise<ShelfEnd[]> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('alarms.alarm_shelf')
      .selectAll()
      .where('shelved', '=', true)
      .where((eb) =>
        eb.or([
          eb('plant_epoch', '<', clock.epoch),
          eb.and([eb('plant_epoch', '=', clock.epoch), eb('until', '<=', clock.watermark)]),
        ]),
      )
      .orderBy('equipment')
      .orderBy('code')
      .forUpdate()
      .execute();
    const ended: ShelfEnd[] = [];
    for (const row of rows) {
      const epoch = row.plant_epoch ?? clock.epoch;
      const until = row.until ?? clock.watermark;
      const old = epoch === clock.epoch ? clock.watermark : watermarkOf(epoch);
      const expired = old !== undefined && old.getTime() >= until.getTime();
      const action = expired ? 'expire' : 'epoch-ended';
      const after: AlarmShelf = { ...UNSHELVED, version: row.version + 1 };
      await writeShelf(trx, row.equipment, row.code, after);
      await audit(trx, [
        {
          equipment: row.equipment,
          code: row.code,
          action,
          before: shelfJson(toShelf(row)),
          after: shelfJson(after),
          actor: 'system',
          plantAt: expired ? until : (old ?? null),
          // Always the shelf's own epoch (#156), also when its last plant time is unknown: the
          // operator measures of that epoch then close the shelf at `until` or their own clock.
          plantEpoch: epoch,
          requestId: null,
          version: after.version,
        },
      ]);
      ended.push({ equipment: row.equipment, code: row.code, action, shelf: after });
    }
    return ended;
  });
}
