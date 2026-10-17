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

/**
 * Opens a crew row for the user at the work center in the shift instance, for the session. The
 * same session again changes nothing (the open row is answered); an open row of another session of
 * the same user there is ended with `replaced` first. Returns the open row and the rows it ended.
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
  },
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
      const closed = await close(trx, [open.id], 'replaced', input.plantAt);
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

/** Ends the user's open row at the work center (`sign-off`); undefined when none is open. */
export async function signOff(
  db: Kysely<Database>,
  input: {
    readonly workCenter: string;
    readonly by: SessionUser;
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
