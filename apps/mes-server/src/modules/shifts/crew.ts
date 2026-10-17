import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import { Identity, type Actor, type SessionUser } from '../identity/index.ts';
import type { CrewAssignmentTable, CrewEndReason } from './tables.ts';

// Crews (#177, plan "Identity: Crews", ADR-0027): signing on at a work center's terminal writes
// `shifts.crew_assignment` (user, work center, shift instance, the terminal session, from); signing
// off, the session's end, the shift's end or a sign-on of the same user there from another session
// closes it. Audited in identity.audit_log (`crew.sign-on`, `crew.sign-off`, `crew.end`).

export const CREW_AUDIT_ENTITY = 'crew_assignment';

/** One sign-on of an operator at a work center during a shift instance. */
export interface CrewRecord {
  readonly id: number;
  readonly userId: number;
  readonly username: string;
  readonly workCenter: string;
  readonly epoch: number;
  readonly shiftKey: string;
  /** The terminal session that signed on (the SHA-256 of its token in hex). */
  readonly sessionId: string | null;
  readonly from: Date;
  readonly fromPlant: Date;
  readonly to: Date | null;
  readonly toPlant: Date | null;
  readonly endReason: CrewEndReason | null;
}

type CrewRow = Selectable<CrewAssignmentTable>;

export function toCrew(row: CrewRow): CrewRecord {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    workCenter: row.work_center,
    epoch: row.epoch,
    shiftKey: row.shift_key,
    sessionId: row.session_id,
    from: row.from_at,
    fromPlant: row.from_plant_at,
    to: row.to_at,
    toPlant: row.to_plant_at,
    endReason: row.end_reason,
  };
}

/** Which crew rows a read returns. */
export interface CrewQuery {
  readonly workCenter?: string;
  readonly userId?: number;
  /** Only rows still open. */
  readonly open?: boolean;
  readonly epoch?: number;
  readonly shiftKey?: string;
  readonly sessionId?: string;
  /** Only rows signed on at some point of this plant-time span (#199: a trace's crew). */
  readonly during?: { readonly from: Date; readonly to: Date };
}

export async function readCrew(
  db: Kysely<Database> | Transaction<Database>,
  query: CrewQuery,
): Promise<CrewRecord[]> {
  let select = db.selectFrom('shifts.crew_assignment').selectAll();
  if (query.workCenter !== undefined) select = select.where('work_center', '=', query.workCenter);
  if (query.userId !== undefined) select = select.where('user_id', '=', query.userId);
  if (query.open === true) select = select.where('to_at', 'is', null);
  if (query.epoch !== undefined) select = select.where('epoch', '=', query.epoch);
  if (query.shiftKey !== undefined) select = select.where('shift_key', '=', query.shiftKey);
  if (query.sessionId !== undefined) select = select.where('session_id', '=', query.sessionId);
  if (query.during !== undefined) {
    const { from, to } = query.during;
    select = select
      .where('from_plant_at', '<=', to)
      .where((eb) => eb.or([eb('to_plant_at', 'is', null), eb('to_plant_at', '>=', from)]));
  }
  const rows = await select.orderBy('work_center').orderBy('from_at').orderBy('id').execute();
  return rows.map(toCrew);
}

const audit = async (
  trx: Transaction<Database>,
  actor: Actor,
  action: 'crew.sign-on' | 'crew.sign-off' | 'crew.end',
  row: CrewRow,
  plantAt: Date,
  requestId: string | undefined,
): Promise<void> => {
  await Identity.audit(trx, {
    actor,
    authenticated: 'userId' in actor,
    action,
    entityType: CREW_AUDIT_ENTITY,
    entityId: String(row.id),
    after: {
      user: row.username,
      workCenter: row.work_center,
      epoch: row.epoch,
      shiftKey: row.shift_key,
      ...(row.end_reason === null ? {} : { endReason: row.end_reason }),
    },
    requestId,
    plantAt,
  });
};

/** SQLSTATE 23505: a unique index refused the row (two sign-ons of one user racing). */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';

/**
 * Opens a crew row for the user at the work center in the shift instance, for the session. The
 * same session again changes nothing (the open row is answered); an open row of another session of
 * the same user there is ended first: `replaced` at the plant clock when it belongs to this shift
 * instance, `shift-ended` at that instance's end when it belongs to an earlier one (`endOf`). Two
 * sign-ons racing: the loser's insert hits the open-row index (23505) and is tried once more, and
 * then finds the winner's row. Returns the open row and the rows it ended.
 */
export async function signOn(
  db: Kysely<Database>,
  input: {
    readonly workCenter: string;
    readonly by: SessionUser;
    readonly sessionId: string;
    readonly epoch: number;
    readonly shiftKey: string;
    readonly plantAt: Date;
    readonly requestId?: string | undefined;
    /** The end (plant time) of a shift instance, if known. */
    readonly endOf?: (epoch: number, shiftKey: string) => Date | undefined;
  },
): Promise<{ crew: CrewRecord; ended: CrewRecord[]; created: boolean }> {
  try {
    return await signOnOnce(db, input);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return signOnOnce(db, input);
  }
}

async function signOnOnce(
  db: Kysely<Database>,
  input: Parameters<typeof signOn>[1],
): Promise<{ crew: CrewRecord; ended: CrewRecord[]; created: boolean }> {
  return db.transaction().execute(async (trx) => {
    const open = await trx
      .selectFrom('shifts.crew_assignment')
      .selectAll()
      .where('user_id', '=', input.by.userId)
      .where('work_center', '=', input.workCenter)
      .where('to_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    const ended: CrewRecord[] = [];
    if (open) {
      if (
        open.session_id === input.sessionId &&
        open.epoch === input.epoch &&
        open.shift_key === input.shiftKey
      ) {
        return { crew: toCrew(open), ended, created: false };
      }
      const sameInstance = open.epoch === input.epoch && open.shift_key === input.shiftKey;
      const end = sameInstance ? undefined : input.endOf?.(open.epoch, open.shift_key);
      const closed = await close(
        trx,
        [open.id],
        sameInstance ? 'replaced' : 'shift-ended',
        end === undefined
          ? input.plantAt
          : new Date(Math.min(end.getTime(), input.plantAt.getTime())),
      );
      for (const row of closed) {
        await audit(trx, { system: 'shifts' }, 'crew.end', row, input.plantAt, input.requestId);
        ended.push(toCrew(row));
      }
    }
    const row = await trx
      .insertInto('shifts.crew_assignment')
      .values({
        user_id: input.by.userId,
        username: input.by.username,
        work_center: input.workCenter,
        epoch: input.epoch,
        shift_key: input.shiftKey,
        session_id: input.sessionId,
        from_at: sql<Date>`clock_timestamp()`,
        from_plant_at: input.plantAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, input.by, 'crew.sign-on', row, input.plantAt, input.requestId);
    return { crew: toCrew(row), ended, created: true };
  });
}

/**
 * Ends the user's open row at the work center held by this session (`sign-off`); undefined when
 * none is open for it (another session's row is that session's to end).
 */
export async function signOff(
  db: Kysely<Database>,
  input: {
    readonly workCenter: string;
    readonly by: SessionUser;
    readonly sessionId: string;
    readonly plantAt: Date;
    readonly requestId?: string | undefined;
  },
): Promise<CrewRecord | undefined> {
  return db.transaction().execute(async (trx) => {
    const open = await trx
      .selectFrom('shifts.crew_assignment')
      .select('id')
      .where('user_id', '=', input.by.userId)
      .where('work_center', '=', input.workCenter)
      .where('session_id', '=', input.sessionId)
      .where('to_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!open) return undefined;
    const [row] = await close(trx, [open.id], 'sign-off', input.plantAt);
    if (!row) return undefined;
    await audit(trx, input.by, 'crew.sign-off', row, input.plantAt, input.requestId);
    return toCrew(row);
  });
}

/**
 * Ends open rows for a reason that is not the operator's own action (a session's end, the shift's
 * end), each at its own plant time (`plantAt(row)`), audited as the system's.
 */
export async function endCrew(
  db: Kysely<Database>,
  ids: readonly number[],
  reason: Exclude<CrewEndReason, 'sign-off' | 'replaced'>,
  plantAt: (row: CrewRecord) => Date,
): Promise<CrewRecord[]> {
  if (ids.length === 0) return [];
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('shifts.crew_assignment')
      .selectAll()
      .where('id', 'in', [...ids])
      .where('to_at', 'is', null)
      .forUpdate()
      .execute();
    const ended: CrewRecord[] = [];
    for (const row of rows) {
      const at = plantAt(toCrew(row));
      const [closed] = await close(trx, [row.id], reason, at);
      if (!closed) continue;
      await audit(trx, { system: 'shifts' }, 'crew.end', closed, at, undefined);
      ended.push(toCrew(closed));
    }
    return ended;
  });
}

/**
 * Inside a caller's transaction (#177 review, MEDIUM-1): the open crew row of the user at the work
 * center held by the session, locked `FOR SHARE` until that transaction ends, so no sign-off, session
 * end or shift end can close it while a terminal write that relies on it commits (they lock it `FOR
 * UPDATE` and wait). False when there is none.
 */
export async function lockCrew(
  trx: Transaction<Database>,
  who: { readonly userId: number; readonly workCenter: string; readonly sessionId: string },
): Promise<boolean> {
  const row = await trx
    .selectFrom('shifts.crew_assignment')
    .select('id')
    .where('user_id', '=', who.userId)
    .where('work_center', '=', who.workCenter)
    .where('session_id', '=', who.sessionId)
    .where('to_at', 'is', null)
    .forShare()
    .executeTakeFirst();
  return row !== undefined;
}

async function close(
  trx: Transaction<Database>,
  ids: readonly number[],
  reason: CrewEndReason,
  plantAt: Date,
): Promise<CrewRow[]> {
  return trx
    .updateTable('shifts.crew_assignment')
    .set({
      to_at: sql<Date>`greatest(clock_timestamp(), from_at)`,
      // Never before the sign-on (a plant clock read from another epoch's watermark).
      to_plant_at: sql<Date>`greatest(${plantAt}::timestamptz, from_plant_at)`,
      end_reason: reason,
    })
    .where('id', 'in', [...ids])
    .where('to_at', 'is', null)
    .returningAll()
    .execute();
}
