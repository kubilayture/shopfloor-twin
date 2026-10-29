import { PROBLEM_TYPES, type PauseReason } from '@shopfloor/contracts/mes-api';
import { sql, type Kysely, type RawBuilder, type Selectable, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import { Identity, type SessionUser } from '../identity/index.ts';
import type { ActivityEndReason, OperationActivityTable, OrderOperationTable } from './tables.ts';

// The operator terminal's records on an order operation (#177, plan "Operator terminal"): an
// operator's start, pause and resume kept as activity intervals (the operator's time, never the
// machine's: the CNC runs its queue whatever the terminal says), and the operation's sign-off,
// allowed once the MES has it complete (its final confirmation is written, #175), which a close
// needs for every operation of the order. Used by `Orders`; the API checks the crew (a terminal
// write needs its operator signed on at the operation's work center with that session).

/** An interval of an operator's work or pause on an order operation. */
export interface ActivityRecord {
  readonly id: number;
  readonly orderId: string;
  readonly operation: string;
  readonly workCenter: string;
  readonly userId: number;
  readonly username: string;
  readonly kind: 'work' | 'pause';
  readonly reason: PauseReason | null;
  readonly comment: string | null;
  readonly from: Date;
  readonly fromPlant: Date;
  readonly to: Date | null;
  readonly toPlant: Date | null;
  readonly endReason: ActivityEndReason | null;
}

/** An order operation as the terminal sees it. */
export interface OperationRecord {
  readonly orderId: string;
  readonly operation: string;
  readonly position: number;
  readonly workCenter: string;
  readonly version: number;
  /** Plant time of its final confirmation (complete by its facts); null until then. */
  readonly completedAt: Date | null;
  readonly signedOff: {
    readonly userId: number;
    readonly username: string;
    readonly at: Date;
    readonly plantAt: Date;
  } | null;
  /** The open intervals, one per operator working or pausing on it. */
  readonly activities: readonly ActivityRecord[];
}

/** A terminal write: who (a session's user: the activity is theirs) and which request. */
export interface TerminalWriteContext {
  readonly by: SessionUser;
  readonly requestId?: string | undefined;
  /**
   * Locks the operator's crew row at the operation's work center for this transaction and returns
   * its id, undefined when there is none (#177 review, MEDIUM-1): the API passes the shifts
   * module's `lockCrew`, so the check and the write commit together and no crew end can slip in
   * between. The interval opened carries the id, so that row's end closes it (#366). Absent only in
   * module tests that write without the API.
   */
  readonly lockCrew?: (
    trx: Transaction<Database>,
    workCenter: string,
  ) => Promise<number | undefined>;
}

/**
 * What a terminal write names as read: an activity write the operator's own open interval (its
 * id, null when none: start), so other operators' writes on the operation never make it stale; a
 * sign-off the operation's version, as it decides for everyone.
 */
export type TerminalRequest =
  | {
      readonly activity: number | null;
      readonly reason?: PauseReason | undefined;
      readonly comment?: string | undefined;
    }
  | { readonly version: number };

export type TerminalAction = 'start' | 'pause' | 'resume' | 'sign-off';

/** What a refused terminal write says; `Orders` turns it into an `OrderError`. */
export interface TerminalRefusal {
  readonly kind: 'not-found' | 'conflict';
  readonly message: string;
  readonly type?: (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES];
}

export const OPERATION_AUDIT_ENTITY = 'order_operation';

/** Order statuses in which an operation takes terminal writes. */
const ACTIVE = ['dispatched', 'in-progress', 'completed'] as const;

type ActivityRow = Selectable<OperationActivityTable>;
type OperationRow = Selectable<OrderOperationTable>;

export function toActivity(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    operation: row.operation,
    workCenter: row.work_center,
    userId: row.user_id,
    username: row.username,
    kind: row.kind,
    reason: row.reason as PauseReason | null,
    comment: row.comment,
    from: row.from_at,
    fromPlant: row.from_plant_at,
    to: row.to_at,
    toPlant: row.to_plant_at,
    endReason: row.end_reason,
  };
}

/** The operations' sign-off, completion and open activities. */
export async function readOperations(
  db: Kysely<Database> | Transaction<Database>,
  filter: {
    readonly orderIds?: readonly string[];
    readonly workCenter?: string;
    readonly operation?: string;
  },
): Promise<OperationRecord[]> {
  if (filter.orderIds?.length === 0) return [];
  let select = db
    .selectFrom('orders.order_operation as o')
    .leftJoin('orders.confirmation as c', (join) =>
      join
        .onRef('c.order_id', '=', 'o.order_id')
        .onRef('c.operation', '=', 'o.operation')
        .on('c.n', '=', 1),
    )
    .selectAll('o')
    .select('c.confirmed_at');
  if (filter.orderIds !== undefined)
    select = select.where('o.order_id', 'in', [...filter.orderIds]);
  if (filter.workCenter !== undefined)
    select = select.where('o.work_center', '=', filter.workCenter);
  if (filter.operation !== undefined) select = select.where('o.operation', '=', filter.operation);
  const rows = await select.orderBy('o.order_id').orderBy('o.position').execute();
  if (rows.length === 0) return [];
  const open = await db
    .selectFrom('orders.operation_activity')
    .selectAll()
    .where('to_at', 'is', null)
    .where('order_id', 'in', [...new Set(rows.map((r) => r.order_id))])
    .orderBy('id')
    .execute();
  return rows.map((row) => toOperation(row, row.confirmed_at, open.map(toActivity)));
}

function toOperation(
  row: OperationRow,
  completedAt: Date | null,
  open: readonly ActivityRecord[],
): OperationRecord {
  return {
    orderId: row.order_id,
    operation: row.operation,
    position: row.position,
    workCenter: row.work_center,
    version: row.version,
    completedAt,
    signedOff:
      row.signed_off_at === null ||
      row.signed_off_plant_at === null ||
      row.signed_off_by === null ||
      row.signed_off_user_id === null
        ? null
        : {
            userId: row.signed_off_user_id,
            username: row.signed_off_by,
            at: row.signed_off_at,
            plantAt: row.signed_off_plant_at,
          },
    activities: open.filter((a) => a.orderId === row.order_id && a.operation === row.operation),
  };
}

/** Activity intervals of an order operation (newest first) or of an operator. */
export async function readActivities(
  db: Kysely<Database>,
  filter: {
    readonly orderId?: string;
    readonly operation?: string;
    readonly userId?: number;
    readonly open?: boolean;
    readonly limit?: number;
  },
): Promise<ActivityRecord[]> {
  let select = db.selectFrom('orders.operation_activity').selectAll();
  if (filter.orderId !== undefined) select = select.where('order_id', '=', filter.orderId);
  if (filter.operation !== undefined) select = select.where('operation', '=', filter.operation);
  if (filter.userId !== undefined) select = select.where('user_id', '=', filter.userId);
  if (filter.open === true) select = select.where('to_at', 'is', null);
  const rows = await select
    .orderBy('id', 'desc')
    .limit(filter.limit ?? 500)
    .execute();
  return rows.map(toActivity);
}

/**
 * An interval's end in wall time: the database's clock, never before the interval's start (#344).
 * That clock is not monotonic: a host that steps its time back (NTP, or a VM's guest agent syncing
 * with its host, as Lima does by up to about 0.1 s every 10 s) would otherwise make a pause right
 * after a start break `to_at >= from_at` (`operation_activity_check4`) and fail the write. Crew
 * rows end the same way (`shifts/crew.ts`).
 */
const END_AT = sql<Date>`greatest(clock_timestamp(), from_at)`;

/**
 * One terminal write in the caller's transaction: the order row shared (a close waits for it), the
 * operation row locked at `version`, the transition of the operator's own interval (start: none
 * open; pause: work open; resume: pause open) or the sign-off (complete, not signed off: closes
 * every open interval on it), the version raised and the audit. Returns the refusal, if refused.
 * The crew row is locked first (`context.lockCrew`); without it the write is refused
 * (`not-signed-on`).
 */
export async function terminalWrite(
  trx: Transaction<Database>,
  orderId: string,
  operation: string,
  action: TerminalAction,
  request: TerminalRequest,
  context: TerminalWriteContext,
  plantAt: Date,
): Promise<TerminalRefusal | undefined> {
  const order = await trx
    .selectFrom('orders.production_order')
    .select(['id', 'status'])
    .where('id', '=', orderId)
    .forShare()
    .executeTakeFirst();
  if (!order) return { kind: 'not-found', message: `no order ${orderId}` };
  const row = await trx
    .selectFrom('orders.order_operation')
    .selectAll()
    .where('order_id', '=', orderId)
    .where('operation', '=', operation)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return { kind: 'not-found', message: `order ${orderId} has no operation ${operation}` };
  const crewId = context.lockCrew ? await context.lockCrew(trx, row.work_center) : null;
  if (crewId === undefined) {
    return {
      kind: 'conflict',
      message: `${context.by.username} is not signed on at ${row.work_center} with this session`,
      type: PROBLEM_TYPES.notSignedOn,
    };
  }
  const user = context.by;
  const mine = await trx
    .selectFrom('orders.operation_activity')
    .selectAll()
    .where('order_id', '=', orderId)
    .where('operation', '=', operation)
    .where('user_id', '=', user.userId)
    .where('to_at', 'is', null)
    // Locked: a crew end or orphan closure running now finishes first, and the interval is then
    // read again (closed: not the operator's open one any more).
    .forUpdate()
    .executeTakeFirst();
  const stale = (what: string): TerminalRefusal => ({
    kind: 'conflict',
    message: `operation ${orderId}/${operation} changed: ${what}`,
    type: PROBLEM_TYPES.operationStale,
  });
  if ('version' in request) {
    if (action !== 'sign-off') return stale('an activity write names the interval it read');
    if (row.version !== request.version) {
      return stale(`version is ${String(row.version)}, not ${String(request.version)}`);
    }
  } else {
    if (action === 'sign-off') return stale('a sign-off names the version it read');
    if ((mine?.id ?? null) !== request.activity) {
      return stale(
        `your open interval is ${mine ? String(mine.id) : 'none'}, not ${request.activity === null ? 'none' : String(request.activity)}`,
      );
    }
  }
  const pause = 'activity' in request ? request : undefined;
  const state = (message: string): TerminalRefusal => ({
    kind: 'conflict',
    message: `operation ${orderId}/${operation}: ${message}`,
    type: PROBLEM_TYPES.operationState,
  });
  if (!(ACTIVE as readonly string[]).includes(order.status)) {
    return state(`the order is ${order.status} (terminal writes need it ${ACTIVE.join(', ')})`);
  }
  if (row.signed_off_at !== null) return state(`signed off by ${row.signed_off_by ?? '?'} already`);
  const now = sql<Date>`clock_timestamp()`;
  const close = async (ids: readonly number[], reason: ActivityEndReason) => {
    if (ids.length === 0) return;
    await trx
      .updateTable('orders.operation_activity')
      .set({ to_at: END_AT, to_plant_at: plantAt, end_reason: reason })
      .where('id', 'in', [...ids])
      .where('to_at', 'is', null)
      .execute();
  };
  /**
   * The next interval of a pause or resume starts where the closed one ended (#366), read in the
   * database at full precision: after a clock step back the closed one ends at its start
   * (`END_AT`), later than the clock, and the two would overlap by up to the step.
   */
  const endOf = (id: number) =>
    sql<Date>`(SELECT to_at FROM orders.operation_activity WHERE id = ${id})`;
  const open = async (kind: 'work' | 'pause', from: RawBuilder<Date> = now) => {
    await trx
      .insertInto('orders.operation_activity')
      .values({
        order_id: orderId,
        operation,
        work_center: row.work_center,
        user_id: user.userId,
        username: user.username,
        kind,
        reason: kind === 'pause' ? (pause?.reason ?? 'other') : null,
        comment: kind === 'pause' ? (pause?.comment ?? null) : null,
        from_at: from,
        from_plant_at: plantAt,
        crew_id: crewId,
      })
      .execute();
  };
  let after: Record<string, unknown> = {};
  switch (action) {
    case 'start':
      if (mine) {
        return state(
          mine.kind === 'work' ? 'you are working on it already' : 'you paused it: resume instead',
        );
      }
      await open('work');
      break;
    case 'pause':
      if (mine?.kind !== 'work') return state('you are not working on it');
      await close([mine.id], 'paused');
      await open('pause', endOf(mine.id));
      after = { reason: pause?.reason, ...(pause?.comment ? { comment: pause.comment } : {}) };
      break;
    case 'resume':
      if (mine?.kind !== 'pause') return state('you have not paused it');
      await close([mine.id], 'resumed');
      await open('work', endOf(mine.id));
      break;
    case 'sign-off': {
      const confirmed = await trx
        .selectFrom('orders.confirmation')
        .select('confirmed_at')
        .where('order_id', '=', orderId)
        .where('operation', '=', operation)
        .where('n', '=', 1)
        .executeTakeFirst();
      if (!confirmed) return state('not complete yet (no unit may come back to it first)');
      // Locked in id order, as every bulk closure does, so two never deadlock (40P01).
      const others = await trx
        .selectFrom('orders.operation_activity')
        .select('id')
        .where('order_id', '=', orderId)
        .where('operation', '=', operation)
        .where('to_at', 'is', null)
        .orderBy('id')
        .forUpdate()
        .execute();
      await close(
        others.map((o) => o.id),
        'signed-off',
      );
      await trx
        .updateTable('orders.order_operation')
        .set({
          signed_off_user_id: user.userId,
          signed_off_by: user.username,
          signed_off_at: now,
          signed_off_plant_at: plantAt,
        })
        .where('order_id', '=', orderId)
        .where('operation', '=', operation)
        .execute();
      after = { completedAt: confirmed.confirmed_at.toISOString() };
      break;
    }
  }
  await trx
    .updateTable('orders.order_operation')
    .set({ version: row.version + 1 })
    .where('order_id', '=', orderId)
    .where('operation', '=', operation)
    .execute();
  await Identity.audit(trx, {
    actor: user,
    authenticated: true,
    action: `operation.${action}`,
    entityType: OPERATION_AUDIT_ENTITY,
    entityId: `${orderId}/${operation}`,
    before: { version: row.version, activity: mine?.kind ?? null },
    after: { version: row.version + 1, workCenter: row.work_center, ...after },
    requestId: context.requestId,
    plantAt,
  });
  return undefined;
}

/** A crew row's end as the orders module reads it: wall time and plant time (#383). */
export interface CrewRowEnd {
  readonly at: Date;
  readonly plantAt: Date;
}

/**
 * Closes an operator's open intervals at a work center (`crew-ended`): their crew row there ended
 * (sign-off at the terminal, the session's end, the shift's end). Only intervals started under that
 * row (`crewId`, #366): a notice that arrives late never closes work begun under a newer sign-on.
 * Those close at the row's end (`end`, #383), as the orphan sweep closes them, so the interval's
 * end doesn't depend on which of the two gets there first. An interval without a crew row (written
 * before #366, or without the crew check) is judged by time instead: started by `until`, the crew
 * row's end in wall time, compared in whole milliseconds as `until` was read (a start later in the
 * same millisecond is not after it), and closed now. Returns the operations touched.
 */
export async function endActivities(
  db: Kysely<Database>,
  who: {
    readonly userId: number;
    readonly workCenter: string;
    readonly until: Date;
    readonly crewId?: number;
    /** The crew row's end, for the intervals started under it (`crewId`). */
    readonly end?: CrewRowEnd;
  },
  plantAt: Date,
): Promise<{ orderId: string; operation: string }[]> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('orders.operation_activity')
      .select(['id', 'crew_id'])
      .where('user_id', '=', who.userId)
      .where('work_center', '=', who.workCenter)
      .where((eb) => {
        const byTime = eb(sql<Date>`date_trunc('milliseconds', from_at)`, '<=', who.until);
        return who.crewId === undefined
          ? byTime
          : eb.or([eb('crew_id', '=', who.crewId), eb.and([eb('crew_id', 'is', null), byTime])]);
      })
      .where('to_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute();
    const byRow = (r: { crew_id: number | null }) =>
      who.end !== undefined && who.crewId !== undefined && r.crew_id === who.crewId;
    const touched = await closeLocked(
      trx,
      rows.filter((r) => !byRow(r)).map((r) => r.id),
      plantAt,
    );
    if (who.end) {
      touched.push(
        ...(await closeAt(
          trx,
          rows.filter(byRow).map((r) => r.id),
          who.end,
        )),
      );
    }
    return touched;
  });
}

/**
 * Closes intervals (`crew-ended`) the caller locked in id order in this transaction, now; those
 * another transaction closed meanwhile keep their end. Returns the operations of those it closed.
 */
async function closeLocked(
  trx: Transaction<Database>,
  ids: readonly number[],
  plantAt: Date,
): Promise<{ orderId: string; operation: string }[]> {
  if (ids.length === 0) return [];
  const rows = await trx
    .updateTable('orders.operation_activity')
    .set({
      to_at: END_AT,
      to_plant_at: plantAt,
      end_reason: 'crew-ended',
    })
    .where('id', 'in', [...ids])
    .where('to_at', 'is', null)
    .returning(['order_id', 'operation'])
    .execute();
  return rows.map((r) => ({ orderId: r.order_id, operation: r.operation }));
}

/**
 * As `closeLocked`, at a crew row's end (#383), never before an interval's own start, in wall time
 * and in plant time each (a clock step back; work begun at a plant time after the shift's end, in
 * the tick before the shift's end closed the row).
 */
async function closeAt(
  trx: Transaction<Database>,
  ids: readonly number[],
  end: CrewRowEnd,
): Promise<{ orderId: string; operation: string }[]> {
  if (ids.length === 0) return [];
  const rows = await trx
    .updateTable('orders.operation_activity')
    .set({
      to_at: sql<Date>`greatest(${end.at}::timestamptz, from_at)`,
      to_plant_at: sql<Date>`greatest(${end.plantAt}::timestamptz, from_plant_at)`,
      end_reason: 'crew-ended',
    })
    .where('id', 'in', [...ids])
    .where('to_at', 'is', null)
    .returning(['order_id', 'operation'])
    .execute();
  return rows.map((r) => ({ orderId: r.order_id, operation: r.operation }));
}

/**
 * A crew check as the orphan sweep reads it (#383; the shifts module's `CrewCheck`, passed in at
 * composition): the open crew rows as `{userId}|{workCenter}` (`signedOn`) and by id (`open`), the
 * database time read before them (`readAt`), and the ends of other rows (`ends`: a row of that
 * user at that work center that has ended; rows still open, and unknown ones, left out).
 */
export interface SweepCheck {
  readonly signedOn: ReadonlySet<string>;
  readonly readAt: Date;
  readonly crew?: {
    readonly open: ReadonlySet<number>;
    ends(
      keys: readonly {
        readonly id: number;
        readonly userId: number;
        readonly workCenter: string;
      }[],
    ): Promise<readonly ({ readonly id: number } & CrewRowEnd)[]>;
  };
}

/**
 * Closes (`crew-ended`) every open interval started before `check.readAt` (database time, read
 * before the crew rows) that holds no crew row any more: a crew row ended while the MES was down,
 * or its notice was lost. Only intervals started before it are judged, so a sign-on and a start
 * after the crew rows were read are never taken for orphans.
 *
 * - An interval started under a crew row (`crew_id`, #366), given `check.crew`, is judged by that
 *   row (#383): kept while the row is open (`crew.open`); otherwise closed at the row's end
 *   (`crew.ends`), never before the interval's own start, in wall and plant time, as the row's
 *   notice closes it (`endActivities`). So a lost crew end is closed even after the operator signed
 *   on there again (a new row: `signedOn` has them), and at the time the row ended.
 * - Any other (no crew row, a row `crew.ends` doesn't answer, or no `crew`): closed now when its
 *   operator holds no open crew row at its work center (`{userId}|{workCenter}` in `signedOn`).
 *
 * As every closure: a closed interval keeps its end (only `to_at IS NULL` rows change), so a run
 * again, a late crew-end notice and checks delivered out of order or twice change nothing more.
 */
export async function endOrphanedActivities(
  db: Kysely<Database>,
  check: SweepCheck,
  plantAt: Date,
): Promise<{ orderId: string; operation: string }[]> {
  const { signedOn, readAt, crew } = check;
  const open = await db
    .selectFrom('orders.operation_activity')
    .select(['id', 'user_id', 'work_center', 'crew_id'])
    .where('to_at', 'is', null)
    .where('from_at', '<', readAt)
    .execute();
  // The crew rows of intervals whose row is no longer open, each asked once.
  const keys = new Map<number, { id: number; userId: number; workCenter: string }>();
  for (const a of open) {
    if (!crew || a.crew_id === null || crew.open.has(a.crew_id)) continue;
    keys.set(a.crew_id, { id: a.crew_id, userId: a.user_id, workCenter: a.work_center });
  }
  const ends = new Map(
    (crew && keys.size > 0 ? await crew.ends([...keys.values()]) : []).map((e) => [e.id, e]),
  );
  /** The intervals to close: at a crew row's end, or now (undefined). */
  const closing = new Map<number, CrewRowEnd | undefined>();
  for (const a of open) {
    if (crew && a.crew_id !== null) {
      if (crew.open.has(a.crew_id)) continue;
      const end = ends.get(a.crew_id);
      if (end) {
        closing.set(a.id, end);
        continue;
      }
    }
    if (!signedOn.has(`${String(a.user_id)}|${a.work_center}`)) closing.set(a.id, undefined);
  }
  if (closing.size === 0) return [];
  return db.transaction().execute(async (trx) => {
    // Locked in id order (no deadlock with a sign-off's or a crew end's closure, 40P01).
    const locked = await trx
      .selectFrom('orders.operation_activity')
      .select('id')
      .where('id', 'in', [...closing.keys()])
      .where('to_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute();
    const now: number[] = [];
    const byEnd = new Map<string, { end: CrewRowEnd; ids: number[] }>();
    for (const { id } of locked) {
      const end = closing.get(id);
      if (!end) {
        now.push(id);
        continue;
      }
      const key = `${String(end.at.getTime())}|${String(end.plantAt.getTime())}`;
      const group = byEnd.get(key) ?? { end, ids: [] };
      group.ids.push(id);
      byEnd.set(key, group);
    }
    const touched = await closeLocked(trx, now, plantAt);
    for (const { end, ids } of byEnd.values()) touched.push(...(await closeAt(trx, ids, end)));
    return touched;
  });
}
