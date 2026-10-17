import { PROBLEM_TYPES, type ProblemType } from '@shopfloor/contracts/mes-api';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { Counter, type Registry } from 'prom-client';
import type { Database } from '../../db/database.ts';
import {
  Identity,
  auditActor,
  isAuthenticated,
  nameOf,
  type StoredAuditEntry,
  type WriteBy,
} from '../identity/index.ts';
import type {
  CycleFact,
  DeviceProgress,
  IngestNotice,
  JobFact,
  StateFact,
} from '../ingest/index.ts';
import type { EquipmentInfo, ReasonCode, Routing } from '../master-data/index.ts';
import type {
  BlankCounter,
  CommandRecord,
  ConfirmationRecord,
  OperationConfirmation,
  OrderRecord,
} from '../orders/index.ts';
import {
  buildUnit,
  completion,
  confirmationTotals,
  holdsBlank,
  orderTotals,
  type BuiltUnit,
  type JobStart,
  type OperationTotals,
  type RoutingModel,
} from './derive.ts';
import type {
  ExecutionIncidentTable,
  RoutingViolation,
  ScrapRecordTable,
  UnitStatus,
  UnitTable,
} from './tables.ts';

/** What the execution module reads of ingest (#175). */
export interface ExecutionIngest {
  onStored(listener: (notice: IngestNotice) => void | Promise<void>): () => void;
  cycleFacts(options: {
    readonly epoch: number;
    readonly partIds?: readonly number[];
    readonly equipment?: string;
    readonly seqs?: readonly number[];
    readonly afterSeq?: number;
    readonly beforeSeq?: number;
  }): Promise<CycleFact[]>;
  cycleFactCounts(): Promise<
    readonly { readonly equipment: string; readonly epoch: number; readonly facts: number }[]
  >;
  jobFacts(options?: {
    readonly commandIds?: readonly string[];
    readonly equipment?: string;
    readonly epoch?: number;
  }): Promise<JobFact[]>;
  stateFacts(
    equipment: string,
    epoch: number,
    window?: { readonly fromSeq?: number; readonly toSeq?: number },
  ): Promise<readonly Pick<StateFact, 'seq' | 'state' | 'cause'>[]>;
  deviceProgress(equipment: string): Promise<DeviceProgress>;
  newestDeviceEpochs(): Promise<Map<string, number>>;
  cyclesBetween(
    equipment: string,
    epoch: number,
    afterSeq: number,
    beforeSeq: number | null,
  ): Promise<number>;
}

/** What the execution module uses of the orders module (#175's seams). */
export interface ExecutionOrders {
  list(query: {
    readonly status?: readonly OrderRecord['status'][];
  }): Promise<{ orders: OrderRecord[] }>;
  order(id: string): Promise<OrderRecord | undefined>;
  commands(filter: { readonly orderId?: string }): Promise<CommandRecord[]>;
  complete(id: string, outcome: { readonly short: boolean; readonly at: Date }): Promise<unknown>;
  confirm(
    id: string,
    operation: string,
    totals: OperationConfirmation,
    at: Date,
  ): Promise<ConfirmationRecord | undefined>;
}

export interface ExecutionLog {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface ExecutionOptions {
  readonly db: Kysely<Database>;
  /** The API's pool for reads (default `db`). */
  readonly readDb?: Kysely<Database>;
  readonly ingest: ExecutionIngest;
  readonly masterData: {
    equipment(): Promise<EquipmentInfo[]>;
    routings(): Promise<Routing[]>;
    scrapReasons(options?: { readonly inactive?: boolean }): Promise<ReasonCode[]>;
  };
  readonly orders: ExecutionOrders;
  /**
   * The leak test and the operation a unit goes back to after its first failure
   * (`process.yaml` `leakTest.operation`, `leakTest.reworkOperation`).
   */
  readonly rework: { readonly test: string; readonly back: string };
  /** The plant clock (the newest epoch's watermark), for the audit's plant time. */
  readonly clock?: () => Date | undefined;
  /** How often units, orders and confirmations are brought up to date (1 s; a notice brings one forward by 250 ms); 0: only `tick()`. */
  readonly tickMs?: number;
  readonly registry?: Registry;
  readonly log?: ExecutionLog;
}

export type ExecutionErrorKind = 'not-found' | 'conflict' | 'invalid';

/** A refused write: the API answers 404, 409 or 422. */
export class ExecutionError extends Error {
  readonly kind: ExecutionErrorKind;
  readonly type: ProblemType | undefined;

  constructor(kind: ExecutionErrorKind, message: string, type?: ProblemType) {
    super(message);
    this.kind = kind;
    this.type = type;
  }
}

/** A unit as the module reports it. */
export interface UnitRecord {
  readonly epoch: number;
  readonly partId: number;
  readonly serial: string | null;
  readonly product: string;
  readonly orderId: string | null;
  readonly commandId: string | null;
  readonly status: UnitStatus;
  readonly position: string;
  readonly lastAt: Date;
  readonly terminalAt: Date | null;
  readonly violation: RoutingViolation | null;
  /** A routing break not proven yet (judged once the expected machines are final through it). */
  readonly suspect: Exclude<RoutingViolation, 'after-terminal'> | null;
  /** The operation whose fact would explain the suspect. */
  readonly suspectOperation: string | null;
  readonly records: readonly {
    readonly operation: string;
    readonly equipment: string;
    readonly pass: number;
    readonly at: Date;
    readonly result: 'good' | 'scrap' | 'rework';
    readonly reason: string | null;
    readonly seq: number;
  }[];
}

/** One operation of an order as execution sees it: quantities, material and completion. */
export interface OrderOperationRecord extends OperationTotals {
  readonly workCenter: string | null;
  /** Plant time the operation was complete (plan H1), null while a unit can still come to it. */
  readonly completedAt: Date | null;
}

/** An order's execution: its operations, units by status and WIP by position. */
export interface OrderExecutionRecord {
  readonly orderId: string;
  readonly operations: readonly OrderOperationRecord[];
  readonly units: {
    readonly total: number;
    readonly wip: number;
    readonly packed: number;
    readonly scrapped: number;
    readonly lost: number;
  };
  /** Units in WIP per position (`after:OPxx`, `rework:OPxx`, `at:{equipment}`). */
  readonly wip: Readonly<Record<string, number>>;
  /** Blanks a CNC holds for the order whose OP10 cycle has not completed, per CNC. */
  readonly inMachine: Readonly<Record<string, number>>;
  /** Rework passes of the order (leak-test failures that sent a unit back). */
  readonly reworkPasses: number;
  /** Scrap per operation and reason. */
  readonly scrap: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly packedGood: number;
  readonly completedAt: Date | null;
}

export interface ScrapRecord {
  readonly id: number;
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  readonly partId: number;
  readonly serial: string | null;
  readonly orderId: string | null;
  readonly operation: string;
  readonly pass: number;
  readonly scrappedAt: Date;
  readonly machineReason: string;
  readonly codedReason: string | null;
  readonly comment: string | null;
  readonly codedBy: string | null;
  readonly codedAt: Date | null;
  readonly version: number;
}

export interface ExecutionIncident {
  readonly id: number;
  readonly type: 'routing-violation';
  readonly epoch: number | null;
  readonly partId: number | null;
  readonly orderId: string | null;
  readonly equipment: string | null;
  readonly message: string;
  readonly detectedAt: Date;
  readonly closedAt: Date | null;
  readonly resolution: string | null;
}

/** Who writes and which request (the audit's). */
export interface ExecutionWriteContext {
  readonly by: WriteBy;
  readonly requestId?: string;
}

/** A change for push and listeners: units of orders, scrap records. */
export type ExecutionChange =
  | { readonly type: 'order'; readonly orderId: string }
  | { readonly type: 'scrap'; readonly record: ScrapRecord };

export const SCRAP_AUDIT_ENTITY = 'scrap_record';
const PART_BATCH = 300;
const silent: ExecutionLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type UnitRow = Selectable<UnitTable>;

/**
 * The `execution` module (#175, Phase 7 plan "Routing execution per part", ADR-0031): units keyed
 * (device epoch, partId) built from the device's cycle facts and attributed to an order by the job
 * facts, one operation record per cycle with its rework pass, routing violations, WIP, quantities
 * and backflushed material per order operation, scrap records with their coding, the completion of
 * each order operation once no unit can come back to it (H1), and from there the confirmations to
 * the ERP (final and corrections, through the orders module's outbox) and the order's completion.
 * Units are derived and rebuilt like alarm occurrences: a reordered or late fact rebuilds its unit.
 */
export class Execution implements BlankCounter {
  readonly #db: Kysely<Database>;
  readonly #readDb: Kysely<Database>;
  readonly #options: ExecutionOptions;
  readonly #ingest: ExecutionIngest;
  readonly #log: ExecutionLog;
  readonly #listeners = new Set<(change: ExecutionChange) => void>();
  readonly #timers: NodeJS.Timeout[] = [];
  /** Cycle facts heard of, by `equipment␀epoch`. */
  readonly #pendingCycles = new Map<string, Set<number>>();
  /** `started` job facts heard of: they re-attribute the OP10 cycles after them. */
  readonly #pendingStarts: JobFact[] = [];
  /** Orders whose units, jobs or confirmations may have changed. */
  readonly #dirtyOrders = new Set<string>();
  /** The totals last confirmed per `order␀operation` (a cache; the orders module decides). */
  readonly #confirmed = new Map<string, string>();
  readonly #rebuilt: Counter | undefined;
  readonly #violations: Counter | undefined;
  #model: RoutingModel = { operations: [], test: '', back: '' };
  #operationOf = new Map<string, string>();
  #workCenterOf = new Map<string, Map<string, string>>();
  #machines = new Map<string, string[]>();
  #newestEpoch: number | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #started = false;
  #stopping = false;
  #kick: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: ExecutionOptions) {
    this.#options = options;
    this.#db = options.db;
    this.#readDb = options.readDb ?? options.db;
    this.#ingest = options.ingest;
    this.#log = options.log ?? silent;
    const registers = options.registry ? [options.registry] : [];
    if (registers.length > 0) {
      this.#rebuilt = new Counter({
        name: 'mes_execution_units_rebuilt_total',
        help: 'Units rebuilt from their cycle facts',
        registers,
      });
      this.#violations = new Counter({
        name: 'mes_execution_routing_violations_total',
        help: 'Routing violations found',
        registers,
      });
    }
  }

  /** Listens for order and scrap-record changes; returns an unsubscribe. */
  onChange(listener: (change: ExecutionChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Loads the routing and the machines, catches up from the tables (every unit of the newest
   * device runs, and of older runs whose cycle facts differ from the records), follows ingest's
   * notices and starts the tick.
   */
  async start(): Promise<void> {
    await this.#loadMaster();
    this.#unsubscribe = this.#ingest.onStored((notice) => {
      this.#onNotice(notice);
    });
    this.#started = true;
    await this.#serial(() => this.#catchUp());
    await this.tick();
    const period = this.#options.tickMs ?? 1_000;
    if (period > 0) {
      const timer = setInterval(() => {
        this.tick().catch((error: unknown) => {
          this.#log.error({ err: error }, 'execution: tick failed');
        });
      }, period);
      timer.unref();
      this.#timers.push(timer);
    }
  }

  get started(): boolean {
    return this.#started;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    clearTimeout(this.#kick);
    this.#unsubscribe?.();
    await this.#queue.catch(() => undefined);
  }

  /** The routing as followed (operations in order, the test and the rework operation). */
  get model(): RoutingModel {
    return this.#model;
  }

  /**
   * One round: rebuilds the units of the facts heard of, marks units of ended runs lost, judges
   * routing suspects against the machines' final-through, then brings every active order (and
   * every order whose units changed) up to date: confirmations of the operations complete, and the
   * order's completion.
   */
  async tick(): Promise<void> {
    if (!this.#started || this.#stopping) return;
    await this.#serial(async () => {
      // What this round handles is taken out of the pending sets, and put back if the round
      // fails, so a failed tick (a lost connection, a deadlock) loses no fact heard of.
      const cycles = [...this.#pendingCycles];
      this.#pendingCycles.clear();
      const starts = this.#pendingStarts.splice(0);
      const orders = [...this.#dirtyOrders];
      try {
        const progress = new Map<string, DeviceProgress>();
        const dirty = await this.#collectDirty(cycles, starts);
        for (const [epoch, parts] of dirty) await this.#rebuild(epoch, [...parts]);
        await this.#markLost();
        await this.#checkSuspects(progress);
        await this.#evaluateOrders(progress);
      } catch (error) {
        for (const [key, seqs] of cycles) {
          const pending = this.#pendingCycles.get(key) ?? new Set<number>();
          for (const seq of seqs) pending.add(seq);
          this.#pendingCycles.set(key, pending);
        }
        this.#pendingStarts.unshift(...starts);
        for (const id of orders) this.#dirtyOrders.add(id);
        throw error;
      }
    });
  }

  // ---- reads ----

  /** Units (with their records), of an order or of a device run, by part id; at most `limit`. */
  async units(
    query: {
      readonly orderId?: string;
      readonly epoch?: number;
      readonly status?: readonly UnitStatus[];
      readonly limit?: number;
    } = {},
    db: Kysely<Database> = this.#readDb,
  ): Promise<{ units: UnitRecord[]; truncated: boolean }> {
    const limit = query.limit ?? 1_000;
    let select = db.selectFrom('execution.unit').selectAll();
    if (query.orderId !== undefined) select = select.where('order_id', '=', query.orderId);
    if (query.epoch !== undefined) select = select.where('epoch', '=', query.epoch);
    if (query.status !== undefined && query.status.length > 0) {
      select = select.where('status', 'in', [...query.status]);
    }
    const rows = await select
      .orderBy('epoch')
      .orderBy('part_id')
      .limit(limit + 1)
      .execute();
    const kept = rows.slice(0, limit);
    return { units: await this.#withRecords(db, kept), truncated: rows.length > limit };
  }

  /** One order's execution (quantities, material, completion, units and WIP). */
  async orderExecution(orderId: string): Promise<OrderExecutionRecord | undefined> {
    const order = await this.#options.orders.order(orderId);
    if (!order) return undefined;
    const progress = new Map<string, DeviceProgress>();
    const state = await this.#orderState(order, this.#readDb, progress);
    const wip: Record<string, number> = {};
    for (const unit of state.units.filter((u) => u.status === 'wip')) {
      const position = await this.#placeOf(unit);
      wip[position] = (wip[position] ?? 0) + 1;
    }
    const inMachine: Record<string, number> = {};
    for (const command of state.commands) {
      if (command.job !== 'started' && command.job !== 'accepted') continue;
      const held = await this.#heldBlank(command, state.units);
      if (held) inMachine[command.equipment] = (inMachine[command.equipment] ?? 0) + 1;
    }
    const scrap: Record<string, Record<string, number>> = {};
    for (const totals of state.totals) {
      if (Object.keys(totals.scrap).length > 0) scrap[totals.operation] = { ...totals.scrap };
    }
    const last = this.#model.operations.at(-1) ?? 'OP50';
    const completedAt = state.completion.get(last) ?? null;
    return {
      orderId,
      operations: state.totals.map((totals) => ({
        ...totals,
        workCenter: order.routing.find((r) => r.operation === totals.operation)?.workCenter ?? null,
        completedAt:
          state.completion.get(totals.operation) === null ||
          state.completion.get(totals.operation) === undefined
            ? null
            : new Date(state.completion.get(totals.operation) ?? 0),
      })),
      units: {
        total: state.units.length,
        wip: state.units.filter((u) => u.status === 'wip').length,
        packed: state.units.filter((u) => u.status === 'packed').length,
        scrapped: state.units.filter((u) => u.status === 'scrapped').length,
        lost: state.units.filter((u) => u.status === 'lost').length,
      },
      wip: sortKeys(wip),
      inMachine: sortKeys(inMachine),
      reworkPasses: state.totals.reduce((sum, t) => sum + t.rework, 0),
      scrap,
      packedGood: state.units.filter((u) => u.status === 'packed').length,
      completedAt: completedAt === null ? null : new Date(completedAt),
    };
  }

  /** Scrap records, newest first, of an order or all; `uncoded` only those not coded yet. */
  async scrapRecords(
    query: { readonly orderId?: string; readonly uncoded?: boolean; readonly limit?: number } = {},
  ): Promise<{ records: ScrapRecord[]; truncated: boolean }> {
    const limit = query.limit ?? 500;
    let select = this.#readDb.selectFrom('execution.scrap_record').selectAll();
    if (query.orderId !== undefined) select = select.where('order_id', '=', query.orderId);
    if (query.uncoded === true) select = select.where('coded_reason', 'is', null);
    const rows = await select
      .orderBy('scrapped_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    return { records: rows.slice(0, limit).map(toScrap), truncated: rows.length > limit };
  }

  async scrapRecord(id: number): Promise<ScrapRecord | undefined> {
    const row = await this.#readDb
      .selectFrom('execution.scrap_record')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toScrap(row);
  }

  /** A scrap record's coding history (identity.audit_log), newest first. */
  async scrapAudit(id: number): Promise<StoredAuditEntry[]> {
    return Identity.auditEntries(this.#readDb, SCRAP_AUDIT_ENTITY, [String(id)], { limit: 100 });
  }

  /** The scrap reason tree (master data). */
  async scrapReasons(): Promise<ReasonCode[]> {
    return this.#options.masterData.scrapReasons();
  }

  /** The module's incidents, newest first (`open`: only those not closed). */
  async incidents(
    query: { readonly open?: boolean; readonly orderId?: string; readonly limit?: number } = {},
  ): Promise<ExecutionIncident[]> {
    let select = this.#readDb.selectFrom('execution.execution_incident').selectAll();
    if (query.open === true) select = select.where('closed_at', 'is', null);
    if (query.orderId !== undefined) select = select.where('order_id', '=', query.orderId);
    const rows = await select
      .orderBy('id', 'desc')
      .limit(query.limit ?? 500)
      .execute();
    return rows.map(toIncident);
  }

  // ---- writes ----

  /**
   * Codes a scrap record with a detailed reason (`scrap:code`, plan "Scrap records"): the record's
   * machine reason or a reason below it in the active tree; the version read (409 `scrap-stale`);
   * audited with the session's user. Coding never changes a quantity or a confirmation.
   */
  async codeScrap(
    id: number,
    request: {
      readonly version: number;
      readonly reason: string;
      readonly comment?: string | undefined;
    },
    context: ExecutionWriteContext,
  ): Promise<ScrapRecord> {
    const reasons = await this.#options.masterData.scrapReasons();
    const record = await this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('execution.scrap_record')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ExecutionError('not-found', `no scrap record ${String(id)}`);
      if (row.version !== request.version) {
        throw new ExecutionError(
          'conflict',
          `scrap record ${String(id)} changed: version is ${String(row.version)}, not ${String(request.version)}`,
          PROBLEM_TYPES.scrapStale,
        );
      }
      const reason = reasons.find((r) => r.id === request.reason && r.active);
      const root = request.reason.split('/')[0];
      if (!reason || root !== row.machine_reason) {
        throw new ExecutionError(
          'invalid',
          `"${request.reason}" is not an active scrap reason under ${row.machine_reason} (the machine's reason)`,
        );
      }
      const comment = request.comment?.trim() === '' ? null : (request.comment?.trim() ?? null);
      const updated = await trx
        .updateTable('execution.scrap_record')
        .set({
          coded_reason: request.reason,
          comment,
          coded_by: nameOf(context.by),
          coded_at: sql<Date>`clock_timestamp()`,
          version: row.version + 1,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await Identity.audit(trx, {
        actor: auditActor(context.by),
        authenticated: isAuthenticated(context.by),
        action: 'scrap.code',
        entityType: SCRAP_AUDIT_ENTITY,
        entityId: String(id),
        before: { codedReason: row.coded_reason, comment: row.comment, version: row.version },
        after: {
          codedReason: updated.coded_reason,
          comment: updated.comment,
          version: updated.version,
          orderId: updated.order_id,
          machineReason: updated.machine_reason,
        },
        requestId: context.requestId,
        plantAt: this.#options.clock?.(),
      });
      return toScrap(updated);
    });
    this.#emit({ type: 'scrap', record });
    return record;
  }

  // ---- BlankCounter (the orders module's lost-job count) ----

  /**
   * The blanks a lost job started (ADR-0029 note, ADR-0031): its OP10 units, exactly, plus one
   * while it had blanks left and no later job started (a fact lost at the run's end may hide it).
   * Undefined while its OP10 cycles are not all units yet (the conservative count applies then).
   */
  async blanksStarted(job: {
    readonly commandId: string;
    readonly equipment: string;
    readonly deviceEpoch: number;
    readonly quantity: number;
    readonly startedSeq: number;
  }): Promise<number | undefined> {
    const starts = (
      await this.#ingest.jobFacts({ equipment: job.equipment, epoch: job.deviceEpoch })
    ).filter((f) => f.transition === 'started');
    const next = starts
      .filter((f) => f.seq > job.startedSeq)
      .reduce<number | null>((min, f) => (min === null || f.seq < min ? f.seq : min), null);
    const cycles = await this.#ingest.cyclesBetween(
      job.equipment,
      job.deviceEpoch,
      job.startedSeq,
      next,
    );
    const records = await this.#db
      .selectFrom('execution.operation_record as r')
      .innerJoin('execution.unit as u', (j) =>
        j.onRef('u.epoch', '=', 'r.epoch').onRef('u.part_id', '=', 'r.part_id'),
      )
      .select(['r.seq'])
      .where('u.command_id', '=', job.commandId)
      .where('r.epoch', '=', job.deviceEpoch)
      .where('r.equipment', '=', job.equipment)
      .execute();
    if (records.length !== cycles) return undefined;
    if (next !== null || records.length >= job.quantity) return records.length;
    // The run ended (this counts lost jobs only): whatever the CNC's last received facts say, a
    // fact lost at the run's very end has no later number to show it missing. After a "none held"
    // state (Starved, Blocked, a changeover, Idle NO-ORDER) the machine's next move is a fact of
    // its own (Running when it takes a blank), and so is the end of a break, a shift or a stop
    // that may follow; any of them may be that lost tail. So one more blank may have been taken
    // while the job had blanks left and no later job started, at most its quantity (#175 review,
    // LOW-6: never under-count, an order may end short but never over).
    return Math.min(job.quantity, records.length + 1);
  }

  // ---- internals: units ----

  #onNotice(notice: IngestNotice): void {
    let relevant = false;
    if (notice.type === 'cycle') {
      const key = `${notice.cycle.equipment}\u0000${String(notice.cycle.epoch)}`;
      let seqs = this.#pendingCycles.get(key);
      if (!seqs) {
        seqs = new Set();
        this.#pendingCycles.set(key, seqs);
      }
      seqs.add(notice.cycle.seq);
      relevant = true;
    } else if (notice.type === 'job') {
      if (notice.fact.transition === 'started') this.#pendingStarts.push(notice.fact);
      this.#dirtyOrders.add(notice.fact.orderId);
      relevant = true;
    } else if (
      notice.type === 'state' ||
      notice.type === 'gaps' ||
      notice.type === 'epoch' ||
      (notice.type === 'sample' && notice.sample.scope === 'device')
    ) {
      relevant = true;
    }
    if (relevant) this.#soon();
  }

  #soon(): void {
    if (this.#kick !== undefined || !this.#started || this.#options.tickMs === 0) return;
    this.#kick = setTimeout(() => {
      this.#kick = undefined;
      this.tick().catch((error: unknown) => {
        this.#log.error({ err: error }, 'execution: tick failed');
      });
    }, 250);
    this.#kick.unref();
  }

  async #loadMaster(): Promise<void> {
    const [equipment, routings] = await Promise.all([
      this.#options.masterData.equipment(),
      this.#options.masterData.routings(),
    ]);
    const operations = routings[0]?.operations.map((o) => o.operation) ?? [];
    this.#model = { operations, ...this.#options.rework };
    this.#operationOf = new Map(equipment.map((e) => [e.id, e.operation]));
    this.#machines = new Map();
    for (const item of equipment) {
      this.#machines.set(item.operation, [...(this.#machines.get(item.operation) ?? []), item.id]);
    }
    this.#workCenterOf = new Map(
      routings.map((r) => [
        r.product,
        new Map(r.operations.map((o) => [o.operation, o.workCenter])),
      ]),
    );
  }

  /** Every unit of the newest device runs, and of older runs whose records lag their facts. */
  async #catchUp(): Promise<void> {
    const counts = await this.#ingest.cycleFactCounts();
    const stored = await this.#db
      .selectFrom('execution.operation_record')
      .select(['equipment', 'epoch'])
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .groupBy(['equipment', 'epoch'])
      .execute();
    const newest = Math.max(Number.NEGATIVE_INFINITY, ...counts.map((c) => c.epoch));
    const epochs = new Set<number>();
    for (const count of counts) {
      const mine = stored.find((s) => s.equipment === count.equipment && s.epoch === count.epoch);
      if (count.epoch === newest || Number(mine?.n ?? 0) !== count.facts) epochs.add(count.epoch);
    }
    for (const epoch of epochs) {
      const parts = new Set<number>();
      for (const count of counts.filter((c) => c.epoch === epoch)) {
        for (const fact of await this.#ingest.cycleFacts({ epoch, equipment: count.equipment })) {
          parts.add(fact.partId);
        }
      }
      await this.#rebuild(epoch, [...parts]);
    }
  }

  /** The units the facts heard of touch: their own, and the OP10 cycles a `started` fact re-attributes. */
  async #collectDirty(
    cycles: readonly (readonly [string, ReadonlySet<number>])[],
    starts: readonly JobFact[],
  ): Promise<Map<number, Set<number>>> {
    const dirty = new Map<number, Set<number>>();
    const add = (epoch: number, partId: number) => {
      let parts = dirty.get(epoch);
      if (!parts) {
        parts = new Set();
        dirty.set(epoch, parts);
      }
      parts.add(partId);
    };
    for (const [key, seqs] of cycles) {
      const [equipment = '', epochText = '0'] = key.split('\u0000');
      const epoch = Number(epochText);
      const list = [...seqs];
      for (let i = 0; i < list.length; i += 1_000) {
        for (const fact of await this.#ingest.cycleFacts({
          epoch,
          equipment,
          seqs: list.slice(i, i + 1_000),
        })) {
          add(epoch, fact.partId);
        }
      }
    }
    const byRun = new Map<string, JobFact[]>();
    for (const start of starts) {
      const key = `${start.equipment}\u0000${String(start.epoch)}`;
      byRun.set(key, [...(byRun.get(key) ?? []), start]);
    }
    for (const list of byRun.values()) {
      const [{ equipment, epoch } = { equipment: '', epoch: 0 }] = list;
      const all = (await this.#ingest.jobFacts({ equipment, epoch })).filter(
        (f) => f.transition === 'started',
      );
      for (const start of list) {
        const next = all
          .filter((f) => f.seq > start.seq)
          .reduce<number | undefined>(
            (min, f) => (min === undefined || f.seq < min ? f.seq : min),
            undefined,
          );
        for (const fact of await this.#ingest.cycleFacts({
          epoch,
          equipment,
          afterSeq: start.seq,
          ...(next === undefined ? {} : { beforeSeq: next }),
        })) {
          add(epoch, fact.partId);
        }
      }
    }
    return dirty;
  }

  /** Rebuilds units of one device run from every cycle fact of their parts, and stores them. */
  async #rebuild(epoch: number, partIds: readonly number[]): Promise<void> {
    if (partIds.length === 0) return;
    if (this.#newestEpoch === undefined) await this.#refreshNewest();
    const starts = new Map<string, JobStart[]>();
    const startsOf = async (equipment: string): Promise<JobStart[]> => {
      let found = starts.get(equipment);
      if (!found) {
        found = (await this.#ingest.jobFacts({ equipment, epoch }))
          .filter((f) => f.transition === 'started')
          .map((f) => ({ seq: f.seq, commandId: f.commandId, orderId: f.orderId }));
        starts.set(equipment, found);
      }
      return found;
    };
    const first = this.#model.operations[0] ?? 'OP10';
    for (const cnc of this.#machines.get(first) ?? []) await startsOf(cnc);
    const sorted = [...partIds].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += PART_BATCH) {
      const chunk = sorted.slice(i, i + PART_BATCH);
      // A fact of a machine master data doesn't know has no operation: no record can hold it.
      const facts = (await this.#ingest.cycleFacts({ epoch, partIds: chunk })).filter((f) =>
        this.#operationOf.has(f.equipment),
      );
      const byPart = new Map<number, CycleFact[]>();
      for (const fact of facts) byPart.set(fact.partId, [...(byPart.get(fact.partId) ?? []), fact]);
      const built: BuiltUnit[] = [];
      for (const [, list] of byPart) {
        built.push(
          buildUnit(
            list.map((f) => ({
              equipment: f.equipment,
              epoch: f.epoch,
              seq: f.seq,
              at: f.sourceTime.getTime(),
              product: f.product,
              partId: f.partId,
              serial: f.serial,
              result: f.result,
              reason: f.reason,
            })),
            (equipment) => this.#operationOf.get(equipment),
            (equipment) => starts.get(equipment) ?? [],
            this.#model,
          ),
        );
      }
      await this.#store(epoch, built);
      this.#rebuilt?.inc(built.length);
    }
  }

  async #store(epoch: number, units: readonly BuiltUnit[]): Promise<void> {
    if (units.length === 0) return;
    const ids = units.map((u) => u.partId);
    const opened: string[] = [];
    await this.#db.transaction().execute(async (trx) => {
      const existing = new Map(
        (
          await trx
            .selectFrom('execution.unit')
            .selectAll()
            .where('epoch', '=', epoch)
            .where('part_id', 'in', ids)
            // In one order, so two rounds locking overlapping units can't deadlock.
            .orderBy('part_id')
            .forUpdate()
            .execute()
        ).map((row) => [row.part_id, row]),
      );
      const lost = this.#newestEpoch !== undefined && this.#newestEpoch > epoch;
      for (const unit of units) {
        const before = existing.get(unit.partId);
        if (before?.order_id) this.#dirtyOrders.add(before.order_id);
        if (unit.orderId) this.#dirtyOrders.add(unit.orderId);
        // A suspect judged a violation stays one while the rebuilt unit shows the same suspect.
        const violation: RoutingViolation | null =
          unit.violation ??
          (before?.violation !== undefined &&
          before.violation !== null &&
          before.violation === unit.suspect?.kind
            ? before.violation
            : null);
        const status: UnitStatus = unit.status === 'wip' && lost ? 'lost' : unit.status;
        const values = {
          serial: unit.serial,
          product: unit.product,
          order_id: unit.orderId,
          command_id: unit.commandId,
          status,
          position: unit.position,
          last_at: new Date(unit.lastAt),
          terminal_at: unit.terminalAt === null ? null : new Date(unit.terminalAt),
          suspect: unit.suspect?.kind ?? null,
          suspect_operation: unit.suspect?.operation ?? null,
          suspect_before: unit.suspect ? new Date(unit.suspect.before) : null,
          violation,
          updated_at: sql<Date>`clock_timestamp()`,
        };
        await trx
          .insertInto('execution.unit')
          .values({ epoch, part_id: unit.partId, ...values })
          .onConflict((c) => c.columns(['epoch', 'part_id']).doUpdateSet(values))
          .execute();
        const key = `routing-violation:${String(epoch)}:${String(unit.partId)}`;
        if (unit.violation !== null && before?.violation !== unit.violation) {
          if (await this.#incident(trx, unit, key, unit.violation)) opened.push(key);
        } else if (violation === null && before?.violation) {
          await this.#closeIncident(trx, key, 'resolved by later facts');
        }
      }
      await trx
        .deleteFrom('execution.operation_record')
        .where('epoch', '=', epoch)
        .where('part_id', 'in', ids)
        .execute();
      const records = units.flatMap((unit) =>
        unit.records.map((r) => ({
          equipment: r.equipment,
          epoch,
          seq: r.seq,
          part_id: unit.partId,
          operation: r.operation,
          pass: r.pass,
          completed_at: new Date(r.at),
          result: r.result,
          reason: r.reason,
          order_id: unit.orderId,
        })),
      );
      for (let i = 0; i < records.length; i += 2_000) {
        await trx
          .insertInto('execution.operation_record')
          .values(records.slice(i, i + 2_000))
          .execute();
      }
      for (const unit of units) {
        for (const r of unit.records.filter((x) => x.result === 'scrap')) {
          const derived = {
            part_id: unit.partId,
            serial: unit.serial,
            order_id: unit.orderId,
            operation: r.operation,
            pass: r.pass,
            scrapped_at: new Date(r.at),
            machine_reason: r.reason ?? 'UNKNOWN',
          };
          await trx
            .insertInto('execution.scrap_record')
            .values({ equipment: r.equipment, epoch, seq: r.seq, ...derived })
            .onConflict((c) => c.columns(['equipment', 'epoch', 'seq']).doUpdateSet(derived))
            .execute();
        }
      }
    });
    if (opened.length > 0) this.#violations?.inc(opened.length);
  }

  async #refreshNewest(): Promise<void> {
    const epochs = [...(await this.#ingest.newestDeviceEpochs()).values()];
    if (epochs.length > 0) this.#newestEpoch = Math.max(...epochs);
  }

  /** Units in WIP of an older device run than the newest are lost (ADR-0029 "Simulator restart"). */
  async #markLost(): Promise<void> {
    await this.#refreshNewest();
    const newest = this.#newestEpoch;
    // Every tick, not only when the newest epoch moves: an epoch that changed while the MES was
    // down, or units of the old run rebuilt by a lagging machine's late facts, are caught too
    // (cheap: `execution.unit_wip` holds only the units in WIP).
    if (newest === undefined) return;
    const rows = await this.#db
      .updateTable('execution.unit')
      .set({ status: 'lost', updated_at: sql<Date>`clock_timestamp()` })
      .where('status', '=', 'wip')
      .where('epoch', '<', newest)
      .returning('order_id')
      .execute();
    for (const row of rows) if (row.order_id) this.#dirtyOrders.add(row.order_id);
  }

  /**
   * A unit seen where another operation was expected (its predecessor missing, or an operation
   * repeated) is a routing violation once every machine of the expected operation is final through
   * that record's time (or its run ended): facts are never refused, and a fact still on its way
   * (a leak-test rework, an OP20 cycle) is not a violation.
   */
  async #checkSuspects(progress: Map<string, DeviceProgress>): Promise<void> {
    const suspects = await this.#db
      .selectFrom('execution.unit')
      .selectAll()
      .where('suspect', 'is not', null)
      .where('violation', 'is', null)
      .execute();
    for (const unit of suspects) {
      const kind = unit.suspect ?? 'missing-predecessor';
      const machines = this.#machines.get(unit.suspect_operation ?? '') ?? [];
      let final = machines.length > 0;
      for (const machine of machines) {
        const device = await this.#progress(progress, machine);
        const before = unit.suspect_before?.getTime() ?? Number.POSITIVE_INFINITY;
        const through =
          device.epoch !== null &&
          (device.epoch > unit.epoch ||
            (device.epoch === unit.epoch &&
              device.settledTime !== null &&
              device.settledTime.getTime() >= before));
        if (!through) {
          final = false;
          break;
        }
      }
      if (!final) continue;
      const key = `routing-violation:${String(unit.epoch)}:${String(unit.part_id)}`;
      await this.#db.transaction().execute(async (trx) => {
        await trx
          .updateTable('execution.unit')
          .set({ violation: kind, updated_at: sql<Date>`clock_timestamp()` })
          .where('epoch', '=', unit.epoch)
          .where('part_id', '=', unit.part_id)
          .execute();
        await this.#incident(
          trx,
          { epoch: unit.epoch, partId: unit.part_id, orderId: unit.order_id, serial: unit.serial },
          key,
          kind,
          unit.suspect_operation ?? undefined,
        );
      });
      this.#violations?.inc();
    }
  }

  async #incident(
    trx: Transaction<Database>,
    unit: {
      readonly epoch: number;
      readonly partId: number;
      readonly orderId: string | null;
      readonly serial: string | null;
    },
    key: string,
    violation: RoutingViolation,
    expected?: string,
  ): Promise<boolean> {
    const what =
      violation === 'missing-predecessor'
        ? `seen later in the routing with no record at ${expected ?? 'an operation'}, though every machine of it is final through that time`
        : violation === 'repeated'
          ? `seen again at an operation it had passed while ${expected ?? 'the next operation'} was expected, though every machine of it is final through that time`
          : 'seen at an operation after it was packed or scrapped';
    const row = await trx
      .insertInto('execution.execution_incident')
      .values({
        type: 'routing-violation',
        key,
        epoch: unit.epoch,
        part_id: unit.partId,
        order_id: unit.orderId,
        equipment: null,
        message: `unit ${String(unit.epoch)}/${String(unit.partId)}${unit.serial ? ` (${unit.serial})` : ''}: ${what} (${violation}); facts are kept as they are`,
      })
      .onConflict((c) => c.column('key').where('closed_at', 'is', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (row) this.#log.warn({ incident: 'routing-violation', key, violation }, 'routing violation');
    return row !== undefined;
  }

  async #closeIncident(trx: Transaction<Database>, key: string, resolution: string): Promise<void> {
    await trx
      .updateTable('execution.execution_incident')
      .set({ closed_at: sql<Date>`clock_timestamp()`, resolution })
      .where('key', '=', key)
      .where('closed_at', 'is', null)
      .execute();
  }

  async #progress(cache: Map<string, DeviceProgress>, equipment: string): Promise<DeviceProgress> {
    let found = cache.get(equipment);
    if (!found) {
      found = await this.#ingest.deviceProgress(equipment);
      cache.set(equipment, found);
    }
    return found;
  }

  // ---- internals: orders, completion and confirmations ----

  async #orderState(
    order: OrderRecord,
    db: Kysely<Database>,
    progress: Map<string, DeviceProgress>,
  ): Promise<{
    units: UnitRecord[];
    commands: CommandRecord[];
    totals: OperationTotals[];
    completion: Map<string, number | null>;
  }> {
    const rows = await db
      .selectFrom('execution.unit')
      .selectAll()
      .where('order_id', '=', order.id)
      .orderBy('epoch')
      .orderBy('part_id')
      .execute();
    const units = await this.#withRecords(db, rows);
    const commands = await this.#options.orders.commands({ orderId: order.id });
    const records = units.flatMap((u) => u.records);
    const totals = orderTotals(records, order.bom, this.#model.operations);
    const jobsDone = await this.#jobsDone(commands, units, progress);
    const settledOf = new Map<string, DeviceProgress>();
    for (const record of records) {
      if (!settledOf.has(record.equipment)) {
        settledOf.set(record.equipment, await this.#progress(progress, record.equipment));
      }
    }
    const completionUnits = [];
    for (const u of units) {
      completionUnits.push({
        // A lost unit counts as done only once no machine of its remaining operations can still
        // report it (each is past its epoch); until then it may still move.
        status:
          u.status === 'lost' && !(await this.#lostFinal(u, progress))
            ? ('wip' as const)
            : u.status,
        suspect: u.violation === null ? u.suspectOperation : null,
        violation: u.violation !== null,
        records: u.records.map((r) => ({
          equipment: r.equipment,
          epoch: u.epoch,
          seq: r.seq,
          operation: r.operation,
          at: r.at.getTime(),
          result: r.result,
        })),
      });
    }
    // Every machine's progress, for a violated unit's skipped operations (`finalThrough`).
    const machines = new Map<string, DeviceProgress>();
    for (const list of this.#machines.values()) {
      for (const machine of list) machines.set(machine, await this.#progress(progress, machine));
    }
    const done = completion(
      completionUnits,
      jobsDone,
      (record) => {
        const device = settledOf.get(record.equipment);
        if (device?.epoch === null || device?.epoch === undefined) return false;
        if (device.epoch > record.epoch) return true;
        return (
          device.epoch === record.epoch &&
          device.settledSeq !== null &&
          device.settledSeq >= record.seq
        );
      },
      this.#model,
      (operation, epoch, at) =>
        (this.#machines.get(operation) ?? []).every((machine) => {
          const device = machines.get(machine);
          if (device?.epoch === null || device?.epoch === undefined) return false;
          if (device.epoch > epoch) return true;
          return (
            device.epoch === epoch &&
            device.settledTime !== null &&
            device.settledTime.getTime() >= at
          );
        }),
    );
    return { units, commands, totals, completion: done };
  }

  /**
   * Whether a lost unit can no longer move: every machine of the operations still ahead of it has
   * reported a newer epoch than the unit's (as `settled` judges records), so none of them can still
   * deliver a fact of the unit's run.
   */
  async #lostFinal(unit: UnitRecord, progress: Map<string, DeviceProgress>): Promise<boolean> {
    const operations = this.#model.operations;
    const [kind = '', operation = ''] = unit.position.split(':');
    const from =
      kind === 'rework' ? operations.indexOf(operation) : operations.indexOf(operation) + 1;
    if (kind !== 'rework' && kind !== 'after') return true;
    for (const op of operations.slice(Math.max(0, from))) {
      for (const machine of this.#machines.get(op) ?? []) {
        const device = await this.#progress(progress, machine);
        if (device.epoch === null || device.epoch <= unit.epoch) return false;
      }
    }
    return true;
  }

  /**
   * Whether an order's jobs are done for OP10 (plan H1): every command settled; every job
   * `completed` with its CNC final through the `completed` fact and each of its OP10 cycles a unit;
   * a job lost with its run counts only once a later command (a re-dispatch) made a job, an abandoned
   * command always (the supervisor wrote it off); at least one such job.
   */
  async #jobsDone(
    commands: readonly CommandRecord[],
    units: readonly UnitRecord[],
    progress: Map<string, DeviceProgress>,
  ): Promise<boolean> {
    if (commands.length === 0 || commands.some((c) => !c.settled)) return false;
    let jobs = 0;
    for (const command of commands) {
      // Written off by a supervisor, or lost with its run and followed by a re-dispatch the device
      // accepted (a later command with a job): done. A lost job alone, or followed only by
      // commands that made no job, keeps the order open for the supervisor (ADR-0029).
      const redispatched = commands.some((c) => c.n > command.n && c.job !== null);
      if (command.state === 'abandoned' || (command.job === 'lost' && redispatched)) {
        jobs++;
        continue;
      }
      if (command.job === 'lost') return false;
      if (command.job === null) continue;
      if (command.job !== 'completed') return false;
      const facts = await this.#ingest.jobFacts({ commandIds: [command.commandId] });
      const started = facts.find(
        (f) => f.transition === 'started' && f.equipment === command.equipment,
      );
      const completed = facts.find(
        (f) => f.transition === 'completed' && f.equipment === command.equipment,
      );
      if (!started || !completed) return false;
      const device = await this.#progress(progress, command.equipment);
      const final =
        device.epoch !== null &&
        (device.epoch > command.deviceEpoch ||
          (device.epoch === command.deviceEpoch &&
            device.settledSeq !== null &&
            device.settledSeq >= completed.seq));
      if (!final) return false;
      const cycles = await this.#ingest.cyclesBetween(
        command.equipment,
        command.deviceEpoch,
        started.seq,
        completed.seq,
      );
      const mine = units.filter(
        (u) => u.commandId === command.commandId && u.epoch === command.deviceEpoch,
      ).length;
      if (mine !== cycles) return false;
      jobs++;
    }
    return jobs > 0;
  }

  /**
   * Every active order (dispatched or in progress) and every order whose units changed: confirms
   * each operation complete (the orders module writes a final confirmation, or a correction when the
   * totals moved), and completes the order once its last operation is.
   */
  async #evaluateOrders(progress: Map<string, DeviceProgress>): Promise<void> {
    const active = (await this.#options.orders.list({ status: ['dispatched', 'in-progress'] }))
      .orders;
    const ids = new Set([...active.map((o) => o.id), ...this.#dirtyOrders]);
    this.#dirtyOrders.clear();
    const last = this.#model.operations.at(-1) ?? 'OP50';
    for (const id of [...ids].sort()) {
      const order = active.find((o) => o.id === id) ?? (await this.#options.orders.order(id));
      if (!order) continue;
      if (!['dispatched', 'in-progress', 'completed', 'closed'].includes(order.status)) continue;
      try {
        const state = await this.#orderState(order, this.#db, progress);
        for (const totals of state.totals) {
          const at = state.completion.get(totals.operation);
          if (at === null || at === undefined) continue;
          const confirmation = confirmationTotals(totals);
          const key = `${id}\u0000${totals.operation}`;
          const text = JSON.stringify(confirmation);
          if (this.#confirmed.get(key) === text) continue;
          await this.#options.orders.confirm(id, totals.operation, confirmation, new Date(at));
          this.#confirmed.set(key, text);
        }
        const completedAt = state.completion.get(last);
        if (
          completedAt !== null &&
          completedAt !== undefined &&
          (order.status === 'dispatched' || order.status === 'in-progress')
        ) {
          const packed = state.units.filter((u) => u.status === 'packed').length;
          await this.#options.orders.complete(id, {
            short: packed < order.quantity,
            at: new Date(completedAt),
          });
        }
        this.#emit({ type: 'order', orderId: id });
      } catch (error) {
        // An order changed meanwhile (a supervisor's write): judged again at the next tick.
        this.#dirtyOrders.add(id);
        this.#log.warn({ err: error, order: id }, 'execution: evaluating an order failed');
      }
    }
  }

  /** A unit's place in WIP: its routing position, or the Blocked machine still holding it. */
  async #placeOf(unit: UnitRecord): Promise<string> {
    const lastRecord = unit.records.at(-1);
    if (lastRecord?.result !== 'good') return unit.position;
    const later = await this.#ingest.cycleFacts({
      epoch: unit.epoch,
      equipment: lastRecord.equipment,
      afterSeq: lastRecord.seq,
    });
    if (later.length > 0) return unit.position;
    const states = await this.#ingest.stateFacts(lastRecord.equipment, unit.epoch, {
      fromSeq: lastRecord.seq + 1,
    });
    return states.at(-1)?.state === 'Blocked' ? `at:${lastRecord.equipment}` : unit.position;
  }

  /** Whether a running job's CNC holds a blank of it whose OP10 cycle has not completed. */
  async #heldBlank(command: CommandRecord, units: readonly UnitRecord[]): Promise<boolean> {
    const facts = await this.#ingest.jobFacts({ commandIds: [command.commandId] });
    const started = facts.find(
      (f) => f.transition === 'started' && f.equipment === command.equipment,
    );
    if (!started || facts.some((f) => f.transition === 'completed')) return false;
    const mine = units.filter(
      (u) => u.commandId === command.commandId && u.epoch === command.deviceEpoch,
    );
    if (mine.length >= command.quantity) return false;
    const device = await this.#ingest.deviceProgress(command.equipment);
    if (device.epoch !== command.deviceEpoch) return false;
    const lastSeq = Math.max(
      started.seq,
      ...mine.flatMap((u) =>
        u.records.filter((r) => r.equipment === command.equipment).map((r) => r.seq),
      ),
    );
    return holdsBlank(
      await this.#ingest.stateFacts(command.equipment, command.deviceEpoch, {
        fromSeq: lastSeq + 1,
      }),
    );
  }

  async #withRecords(db: Kysely<Database>, rows: readonly UnitRow[]): Promise<UnitRecord[]> {
    if (rows.length === 0) return [];
    const byEpoch = new Map<number, number[]>();
    for (const row of rows)
      byEpoch.set(row.epoch, [...(byEpoch.get(row.epoch) ?? []), row.part_id]);
    const records = new Map<string, UnitRecord['records'][number][]>();
    for (const [epoch, parts] of byEpoch) {
      for (let i = 0; i < parts.length; i += 5_000) {
        const found = await db
          .selectFrom('execution.operation_record')
          .selectAll()
          .where('epoch', '=', epoch)
          .where('part_id', 'in', parts.slice(i, i + 5_000))
          .execute();
        for (const r of found) {
          const key = `${String(epoch)}:${String(r.part_id)}`;
          records.set(key, [
            ...(records.get(key) ?? []),
            {
              operation: r.operation,
              equipment: r.equipment,
              pass: r.pass,
              at: r.completed_at,
              result: r.result,
              reason: r.reason,
              seq: r.seq,
            },
          ]);
        }
      }
    }
    const position = (op: string) => this.#model.operations.indexOf(op);
    return rows.map((row) => ({
      epoch: row.epoch,
      partId: row.part_id,
      serial: row.serial,
      product: row.product,
      orderId: row.order_id,
      commandId: row.command_id,
      status: row.status,
      position: row.position,
      lastAt: row.last_at,
      terminalAt: row.terminal_at,
      violation: row.violation,
      suspect: row.suspect,
      suspectOperation: row.suspect_operation,
      records: (records.get(`${String(row.epoch)}:${String(row.part_id)}`) ?? []).sort(
        (a, b) =>
          a.at.getTime() - b.at.getTime() ||
          position(a.operation) - position(b.operation) ||
          (a.equipment < b.equipment ? -1 : a.equipment > b.equipment ? 1 : 0) ||
          a.seq - b.seq,
      ),
    }));
  }

  /** The work center of an operation for a product (master data). */
  workCenter(product: string, operation: string): string | undefined {
    return this.#workCenterOf.get(product)?.get(operation);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #emit(change: ExecutionChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error({ err: error }, 'execution listener failed');
      }
    }
  }
}

const sortKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function toScrap(row: Selectable<ScrapRecordTable>): ScrapRecord {
  return {
    id: row.id,
    equipment: row.equipment,
    epoch: row.epoch,
    seq: row.seq,
    partId: row.part_id,
    serial: row.serial,
    orderId: row.order_id,
    operation: row.operation,
    pass: row.pass,
    scrappedAt: row.scrapped_at,
    machineReason: row.machine_reason,
    codedReason: row.coded_reason,
    comment: row.comment,
    codedBy: row.coded_by,
    codedAt: row.coded_at,
    version: row.version,
  };
}

function toIncident(row: Selectable<ExecutionIncidentTable>): ExecutionIncident {
  return {
    id: row.id,
    type: row.type,
    epoch: row.epoch,
    partId: row.part_id,
    orderId: row.order_id,
    equipment: row.equipment,
    message: row.message,
    detectedAt: row.detected_at,
    closedAt: row.closed_at,
    resolution: row.resolution,
  };
}
