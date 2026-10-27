import {
  commandTopic,
  loadOrderCommandId,
  loadOrderCommandSchema,
  type LoadOrderCommand,
} from '@shopfloor/contracts';
import {
  confirmationKey,
  statusKey,
  type ConfirmationRequest,
  type FeedEntry,
  type OrderStatusMessage,
  type StatusMessageRequest,
} from '@shopfloor/contracts/erp-api';
import {
  PROBLEM_TYPES,
  type CommandState,
  type JobState,
  type OrderIncidentType,
  type OrderStatus,
  type PauseReason,
  type ProblemType,
} from '@shopfloor/contracts/mes-api';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { Counter, type Registry } from 'prom-client';
import type { Database } from '../../db/database.ts';
import {
  Identity,
  auditActor,
  isAuthenticated,
  type StoredAuditEntry,
  type WriteBy,
} from '../identity/index.ts';
import type {
  DeviceProgress,
  IngestNotice,
  JobFact,
  StoredCommandResult,
} from '../ingest/index.ts';
import type { EquipmentInfo, Routing } from '../master-data/index.ts';
import {
  DEFAULT_POLICY,
  readCommand,
  type CommandPolicy,
  type CommandReading,
} from './command-state.ts';
import { chooseCnc, type CncQueue, type ProductTimes } from './dispatch-rule.ts';
import type { ErpApi } from './erp-client.ts';
import {
  endActivities,
  endOrphanedActivities,
  readActivities,
  readOperations,
  terminalWrite,
  type ActivityRecord,
  type OperationRecord,
  type TerminalAction,
  type TerminalRequest,
  type TerminalWriteContext,
} from './operations.ts';
import type { CommandPublisher } from './publisher.ts';
import type {
  ConfirmationTable,
  DispatchCommandTable,
  ErpMessageLogTable,
  OrderIncidentTable,
  ProductionOrderTable,
} from './tables.ts';
import { validateErpOrder } from './validate.ts';

/** What the orders module reads of ingest (#174). */
export interface OrdersIngest {
  onStored(listener: (notice: IngestNotice) => void | Promise<void>): () => void;
  jobFacts(options?: {
    readonly commandIds?: readonly string[];
    readonly equipment?: string;
    readonly epoch?: number;
  }): Promise<JobFact[]>;
  commandResults(
    commandIds: readonly string[],
    db?: Kysely<Database>,
  ): Promise<StoredCommandResult[]>;
  componentStatuses(
    component: string,
  ): Promise<readonly { readonly instance: string; readonly status: 'online' | 'offline' }[]>;
  deviceProgress(equipment: string): Promise<DeviceProgress>;
  maxStoredSeq(equipment: string, epoch: number): Promise<number | null>;
  stateFacts(
    equipment: string,
    epoch: number,
    window?: { readonly fromSeq?: number; readonly toSeq?: number },
  ): Promise<
    readonly { readonly seq: number; readonly state: string; readonly cause: string | null }[]
  >;
  settled(
    equipment: string,
    epoch: number,
  ): Promise<{
    readonly incidents: readonly { readonly seqFrom: number; readonly seqTo: number }[];
  }>;
  newestDeviceEpochs(): Promise<Map<string, number>>;
  cyclesBetween(
    equipment: string,
    epoch: number,
    afterSeq: number,
    beforeSeq: number | null,
  ): Promise<number>;
}

/**
 * What the orders module reads of the execution module's units (#175, ADR-0031): the blanks a job
 * started, exactly; undefined when its units are not all known yet.
 */
export interface BlankCounter {
  blanksStarted(job: {
    readonly commandId: string;
    readonly equipment: string;
    readonly deviceEpoch: number;
    readonly quantity: number;
    readonly startedSeq: number;
  }): Promise<number | undefined>;
}

/**
 * Why an order may not close now (#201, ADR-0035): an open hold covers a unit of it (or the order
 * itself), or genealogy has not processed every fact of its units yet (retryable).
 */
export type CloseRefusal =
  | { readonly kind: 'quality-hold'; readonly holds: readonly string[]; readonly message: string }
  | { readonly kind: 'genealogy-pending'; readonly message: string };

/**
 * The quality module's guard on `close` (#201, plan "Quality holds", review rounds 1 and 2),
 * injected at composition (as `BlankCounter`), so `orders` imports nothing of `quality`. `lock`
 * takes the advisory lock that opening a hold takes too, first in the close's transaction (before
 * the order row's lock); `check` runs after it in the same transaction and derives the order's
 * held units from the open holds' subjects and the genealogy links at that moment. Neither may wait
 * on the orders module's in-process queue.
 */
export interface CloseGuard {
  lock(trx: Transaction<Database>): Promise<void>;
  check(trx: Transaction<Database>, orderId: string): Promise<CloseRefusal | undefined>;
}

/** An outbound ERP message another module writes into the outbox in its own transaction (#201). */
export interface ErpOutboundMessage {
  readonly kind: 'quality-notification';
  /** `qualityNotificationKey`: `{holdId}~{transition}~{n}`. */
  readonly idempotencyKey: string;
  /** What the message is about: the hold. */
  readonly subject: { readonly kind: 'hold'; readonly id: string };
  /** The body as posted (`QualityNotificationRequest`). */
  readonly payload: unknown;
}

export interface OrdersLog {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

/** Command timings (plan "Command path"); every one can be shortened for tests. */
export interface CommandTimings extends CommandPolicy {
  /** `expiresAt` of a delivery, from its publish (60 s). */
  readonly ttlMs: number;
}

export const DEFAULT_TIMINGS: CommandTimings = { ...DEFAULT_POLICY, ttlMs: 60_000 };

export interface OrdersOptions {
  readonly db: Kysely<Database>;
  /** The API's pool for reads (default `db`). */
  readonly readDb?: Kysely<Database>;
  readonly ingest: OrdersIngest;
  readonly masterData: {
    equipment(): Promise<EquipmentInfo[]>;
    routings(): Promise<Routing[]>;
  };
  /** Where commands go; without it nothing is published (the outbox keeps them). */
  readonly publisher?: CommandPublisher;
  /** The ERP; without it nothing is imported or posted (messages wait in the outbox). */
  readonly erp?: ErpApi;
  /** The plant clock (the newest epoch's watermark); undefined before any fact. */
  readonly clock?: () => Date | undefined;
  /** Wall clock, ms (tests move it). */
  readonly now?: () => number;
  readonly timings?: Partial<CommandTimings>;
  /** How often the ERP feed is pulled (`ERP_POLL_MS`, 10 s); 0: only `importNow()`. */
  readonly erpPollMs?: number;
  /** How often the outbound ERP messages are posted (1 s); 0: only `postNow()`. */
  readonly erpPostMs?: number;
  /**
   * How often commands are read and the outbox published (500 ms), besides soon after a notice
   * or a dispatch; 0: only `tick()`.
   */
  readonly tickMs?: number;
  /** The command envelope's `epoch` (the MES process start, Unix seconds). */
  readonly mesEpoch?: number;
  readonly registry?: Registry;
  readonly log?: OrdersLog;
  /**
   * Closes without a close guard (#201 review, L2): module tests of orders alone. Otherwise a close
   * with no guard wired is refused (fail closed): the quality holds must be asked.
   */
  readonly unguardedClose?: boolean;
  /** Test seam: runs after a delivery's attempt row is committed, before its publish. */
  readonly beforePublish?: (commandId: string) => Promise<void>;
}

export type OrderErrorKind = 'not-found' | 'conflict' | 'invalid';

/** A refused write: the API answers 404, 409 or 422. */
export class OrderError extends Error {
  readonly kind: OrderErrorKind;
  readonly type: ProblemType | undefined;
  /** The open holds a close was refused for (`quality-hold`, #203). */
  readonly holds: readonly string[] | undefined;

  constructor(
    kind: OrderErrorKind,
    message: string,
    type?: ProblemType,
    holds?: readonly string[],
  ) {
    super(message);
    this.kind = kind;
    this.type = type;
    this.holds = holds;
  }
}

/** An order as the module reports it. */
export interface OrderRecord {
  readonly id: string;
  readonly revision: number;
  readonly product: string;
  readonly quantity: number;
  readonly priority: number;
  readonly plannedStart: Date;
  readonly dueDate: Date;
  readonly erpStatus: 'open' | 'cancelled';
  readonly status: OrderStatus;
  readonly short: boolean;
  readonly dispatchFailed: boolean;
  readonly dispatchLost: boolean;
  readonly rejection: string | null;
  /** Blanks of jobs the device accepted (a lost job counts the blanks it started). */
  readonly dispatched: number;
  /** Blanks of commands not settled yet. */
  readonly inFlight: number;
  readonly version: number;
  readonly importedAt: Date;
  readonly updatedAt: Date;
  readonly releasedAt: Date | null;
  readonly dispatchedAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly closedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly routing: readonly { readonly operation: string; readonly workCenter: string }[];
  readonly bom: Selectable<ProductionOrderTable>['bom'];
}

/** A dispatch command as the module reports it. */
export interface CommandRecord {
  readonly commandId: string;
  readonly orderId: string;
  readonly n: number;
  readonly equipment: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: Date;
  readonly deviceEpoch: number;
  readonly queuePosition: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly state: CommandState;
  readonly settled: boolean;
  readonly failed: boolean;
  readonly confirmed: boolean;
  readonly acceptedBy: 'fact' | 'result' | null;
  readonly acceptedSeq: number | null;
  readonly acceptedAt: Date | null;
  readonly rejection: string | null;
  readonly seqAfterExpiry: number | null;
  readonly job: JobState | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly lostStarted: number | null;
  readonly attempts: readonly {
    readonly attempt: number;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly publishedAt: Date | null;
  }[];
}

export interface ErpMessageRecord {
  readonly id: number;
  readonly direction: 'in' | 'out';
  readonly kind: 'feed-entry' | 'status' | 'confirmation' | 'quality-notification';
  /** Null only for a quality notification (#201), which is about a hold. */
  readonly orderId: string | null;
  readonly revision: number | null;
  readonly subject: { readonly kind: 'hold'; readonly id: string } | null;
  readonly idempotencyKey: string | null;
  readonly status: string;
  readonly detail: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly payload: unknown;
}

/** The totals of an order operation as a confirmation carries them (#175). */
export interface OperationConfirmation {
  readonly yield: number;
  /** Scrap per reason. */
  readonly scrap: Readonly<Record<string, number>>;
  readonly reworkPasses: number;
  /** Backflushed material per material id. */
  readonly material: Readonly<Record<string, number>>;
}

/** A confirmation sent to the ERP (#175): its counts (deltas in a correction) and the totals. */
export interface ConfirmationRecord extends OperationConfirmation {
  readonly orderId: string;
  readonly operation: string;
  readonly n: number;
  readonly kind: 'final' | 'correction';
  readonly revision: number;
  /** Every confirmation up to this one summed. */
  readonly totals: OperationConfirmation;
  readonly confirmedAt: Date;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  /** Of its outbound message: pending, sent, conflict or refused. */
  readonly messageStatus: string;
}

export interface OrderIncident {
  readonly id: number;
  readonly type: OrderIncidentType;
  readonly orderId: string | null;
  readonly commandId: string | null;
  readonly equipment: string | null;
  readonly message: string;
  readonly detectedAt: Date;
  readonly closedAt: Date | null;
  readonly resolution: string | null;
}

export interface OrderDetailRecord {
  readonly order: OrderRecord;
  readonly commands: readonly (CommandRecord & { readonly results: StoredCommandResult[] })[];
  readonly erpMessages: readonly ErpMessageRecord[];
  /** Confirmations sent to the ERP (#175), by operation and number. */
  readonly confirmations: readonly ConfirmationRecord[];
  readonly incidents: readonly OrderIncident[];
  readonly history: readonly StoredAuditEntry[];
}

export type OrderChange =
  | { readonly type: 'order'; readonly event: 'imported' | 'updated'; readonly order: OrderRecord }
  | {
      readonly type: 'command';
      readonly event: 'created' | 'updated';
      readonly command: CommandRecord;
    }
  | {
      /** A terminal write or a crew end changed an operation's activities or sign-off (#177). */
      readonly type: 'operation';
      readonly event: 'updated';
      readonly operation: OperationRecord;
    };

export interface OrderQuery {
  readonly status?: readonly OrderStatus[];
  /** Planned start in [from, to). */
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
}

/** Who writes and which request (the audit's). */
export interface WriteContext {
  readonly by: WriteBy;
  readonly requestId?: string;
}

export const AUDIT_ENTITY = 'production_order';
const FEED_PAGE = 100;
const POST_BATCH = 50;
const POST_MAX_BACKOFF_MS = 60_000;

const silent: OrdersLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

const time = (date: Date | null): number | null => (date === null ? null : date.getTime());

type OrderRow = Selectable<ProductionOrderTable>;
/** A reading with what is recorded beside it. */
type Recorded = CommandReading & { readonly final: boolean; readonly lostStarted: number | null };
type CommandRow = Selectable<DispatchCommandTable>;

/**
 * The `orders` module (#174, Phase 7 plan "Orders", "Command path"): imports orders from the
 * ERP's change feed and validates them against master data, the supervisor's writes (release,
 * dispatch, cancel, re-dispatch, close) with a version and an audit, the dispatch rule, the command
 * outbox with resends and one command in flight per CNC, the reading of every command from its
 * results and the device's job facts, incidents, and order status messages to the ERP through a
 * second outbox.
 */
export class Orders {
  readonly #db: Kysely<Database>;
  readonly #readDb: Kysely<Database>;
  readonly #options: OrdersOptions;
  readonly #ingest: OrdersIngest;
  readonly #now: () => number;
  readonly #log: OrdersLog;
  readonly #timings: CommandTimings;
  readonly #mesEpoch: number;
  readonly #listeners = new Set<(change: OrderChange) => void>();
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #sequences = new Map<string, number>();
  /** Keys of the open incidents (loaded at start, kept with every change). */
  readonly #openIncidents = new Set<string>();
  /**
   * Incident keys opened and closed inside the transaction running now (a tick's, a write's):
   * applied to `#openIncidents` only once it committed, dropped if it rolled back.
   */
  #pending: { opened: string[]; closed: string[] } | undefined;
  /** Job facts heard of, to check against the commands at the next tick. */
  readonly #heardJobs: JobFact[] = [];
  readonly #published: Counter | undefined;
  readonly #incidentCounter: Counter<'type'> | undefined;
  readonly #erpPosts: Counter<'outcome'> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #cncs = new Map<string, EquipmentInfo>();
  #routings = new Map<string, Routing>();
  #started = false;
  #stopping = false;
  #importing = false;
  #posting = false;
  #kick: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #blanks: BlankCounter | undefined;
  #guard: CloseGuard | undefined;

  constructor(options: OrdersOptions) {
    this.#options = options;
    this.#db = options.db;
    this.#readDb = options.readDb ?? options.db;
    this.#ingest = options.ingest;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? silent;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#mesEpoch = options.mesEpoch ?? Math.floor(Date.now() / 1000);
    const registers = options.registry ? [options.registry] : [];
    if (registers.length > 0) {
      this.#published = new Counter({
        name: 'mes_orders_command_deliveries_total',
        help: 'cmd/load-order deliveries published (first deliveries and resends)',
        registers,
      });
      this.#incidentCounter = new Counter({
        name: 'mes_orders_incidents_total',
        help: 'Incidents raised by the orders module, by type',
        labelNames: ['type'],
        registers,
      });
      this.#erpPosts = new Counter({
        name: 'mes_orders_erp_posts_total',
        help: 'Messages posted to the ERP, by outcome (stored, conflict, refused, retry)',
        labelNames: ['outcome'],
        registers,
      });
    }
  }

  /** Counts a lost job's blanks from the execution module's units from now on (#175). */
  useBlankCounter(counter: BlankCounter): void {
    this.#blanks = counter;
  }

  /**
   * Guards `close` with the quality module's holds from now on (#201, ADR-0035): the guard's lock
   * first in the close's transaction, then its check.
   */
  useCloseGuard(guard: CloseGuard): void {
    this.#guard = guard;
  }

  /** Whether a close guard is wired (the MES asserts it at start: a close fails closed without). */
  get closeGuarded(): boolean {
    return this.#guard !== undefined;
  }

  /**
   * Writes an outbound ERP message into the outbox in the caller's transaction (#201: a quality
   * notification in the transaction of its hold's transition), so one publisher and one backoff
   * serve every ERP message. Never takes the module's in-process queue and touches no order row:
   * a hold's transaction holds the advisory lock a close waits for inside that queue (plan review
   * round 2, MEDIUM D). A key used before is refused by the database (the transaction fails).
   */
  async enqueueErpMessage(trx: Transaction<Database>, message: ErpOutboundMessage): Promise<void> {
    await trx
      .insertInto('orders.erp_message_log')
      .values({
        direction: 'out',
        kind: message.kind,
        order_id: null,
        revision: null,
        idempotency_key: message.idempotencyKey,
        feed_id: null,
        feed_seq: null,
        payload: JSON.stringify(message.payload),
        status: 'pending',
        detail: null,
        receipt: null,
        subject_kind: message.subject.kind,
        subject_id: message.subject.id,
      })
      .execute();
  }

  /** The outbound ERP messages about a subject (#201: a hold's notifications), in order. */
  async erpMessagesOf(
    subject: { readonly kind: 'hold'; readonly id: string },
    db: Kysely<Database> = this.#readDb,
  ): Promise<ErpMessageRecord[]> {
    const rows = await db
      .selectFrom('orders.erp_message_log')
      .selectAll()
      .where('subject_kind', '=', subject.kind)
      .where('subject_id', '=', subject.id)
      .orderBy('id')
      .execute();
    return rows.map(toMessage);
  }

  /** Listens for order and command changes (push); returns an unsubscribe. */
  onChange(listener: (change: OrderChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Loads master data and the open incidents, reads every live command once (catch-up from the
   * tables: notices are only a fast path), checks the stored job facts against the commands, and
   * starts the timers: the command tick, the ERP feed and the ERP outbox.
   */
  async start(): Promise<void> {
    await this.#loadMaster();
    const open = await this.#db
      .selectFrom('orders.order_incident')
      .select('key')
      .where('closed_at', 'is', null)
      .execute();
    for (const row of open) this.#openIncidents.add(row.key);
    // Job facts of the runs still going (an older run's commands are all settled by its end).
    for (const [equipment, epoch] of await this.#ingest.newestDeviceEpochs()) {
      this.#heardJobs.push(...(await this.#ingest.jobFacts({ equipment, epoch })));
    }
    this.#unsubscribe = this.#ingest.onStored((notice) => {
      this.#onNotice(notice);
    });
    this.#started = true;
    await this.tick();
    const every = (ms: number | undefined, fallback: number, work: () => Promise<unknown>) => {
      const period = ms ?? fallback;
      if (period <= 0) return;
      const timer = setInterval(() => {
        work().catch((error: unknown) => {
          this.#log.error({ err: error }, 'orders: periodic work failed');
        });
      }, period);
      timer.unref();
      this.#timers.push(timer);
    };
    every(this.#options.tickMs, 500, () => this.tick());
    every(this.#options.erpPollMs, 10_000, () => this.importNow());
    every(this.#options.erpPostMs, 1_000, () => this.postNow());
    if (this.#options.erp && this.#options.erpPollMs !== 0) {
      this.importNow().catch((error: unknown) => {
        this.#log.warn({ err: error }, 'orders: first ERP import failed; retrying');
      });
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

  // ---- reads ----

  /** Orders by planned start (then id), at most `limit` (default 500) + 1 to tell truncation. */
  async list(query: OrderQuery = {}): Promise<{ orders: OrderRecord[]; truncated: boolean }> {
    const limit = query.limit ?? 500;
    let select = this.#readDb.selectFrom('orders.production_order').selectAll();
    if (query.status !== undefined && query.status.length > 0) {
      select = select.where('status', 'in', [...query.status]);
    }
    if (query.from !== undefined) select = select.where('planned_start', '>=', query.from);
    if (query.to !== undefined) select = select.where('planned_start', '<', query.to);
    const rows = await select
      .orderBy('planned_start')
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const orders = await this.#records(this.#readDb, rows.slice(0, limit));
    return { orders, truncated: rows.length > limit };
  }

  async order(id: string): Promise<OrderRecord | undefined> {
    const row = await this.#readDb
      .selectFrom('orders.production_order')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && (await this.#records(this.#readDb, [row]))[0];
  }

  /** One order with its commands (attempts and every result), ERP messages, incidents and audit. */
  async detail(id: string): Promise<OrderDetailRecord | undefined> {
    const order = await this.order(id);
    if (!order) return undefined;
    const commands = await this.commands({ orderId: id }, this.#readDb);
    const results = await this.#ingest.commandResults(
      commands.map((c) => c.commandId),
      this.#readDb,
    );
    const messages = await this.#readDb
      .selectFrom('orders.erp_message_log')
      .selectAll()
      .where('order_id', '=', id)
      .orderBy('id')
      .execute();
    const incidents = await this.#readDb
      .selectFrom('orders.order_incident')
      .selectAll()
      .where('order_id', '=', id)
      .orderBy('id')
      .execute();
    const history = await Identity.auditEntries(this.#readDb, AUDIT_ENTITY, [id], { limit: 500 });
    return {
      order,
      commands: commands.map((command) => ({
        ...command,
        results: results.filter((r) => r.value.commandId === command.commandId),
      })),
      erpMessages: messages.map(toMessage),
      confirmations: await this.confirmations(id),
      incidents: incidents.map(toIncident),
      history,
    };
  }

  /** Commands (with their attempts) of an order, or all, in queue order. */
  async commands(
    filter: {
      readonly orderId?: string;
      /** Only the commands of these orders (#177: the terminal's candidates). */
      readonly orderIds?: readonly string[];
      readonly commandIds?: readonly string[];
    } = {},
    db: Kysely<Database> = this.#readDb,
  ): Promise<CommandRecord[]> {
    let select = db.selectFrom('orders.dispatch_command').selectAll();
    if (filter.orderId !== undefined) select = select.where('order_id', '=', filter.orderId);
    if (filter.orderIds !== undefined) {
      if (filter.orderIds.length === 0) return [];
      select = select.where('order_id', 'in', [...filter.orderIds]);
    }
    if (filter.commandIds !== undefined) {
      if (filter.commandIds.length === 0) return [];
      select = select.where('command_id', 'in', [...filter.commandIds]);
    }
    const rows = await select.orderBy('queue_position').execute();
    if (rows.length === 0) return [];
    const attempts = await db
      .selectFrom('orders.command_attempt')
      .selectAll()
      .where(
        'command_id',
        'in',
        rows.map((r) => r.command_id),
      )
      .orderBy('command_id')
      .orderBy('attempt')
      .execute();
    return rows.map((row) =>
      toCommand(
        row,
        attempts.filter((a) => a.command_id === row.command_id),
      ),
    );
  }

  /** The module's incidents, newest first (`open`: only those not closed). */
  async incidents(
    query: { readonly open?: boolean; readonly limit?: number } = {},
  ): Promise<OrderIncident[]> {
    let select = this.#readDb.selectFrom('orders.order_incident').selectAll();
    if (query.open === true) select = select.where('closed_at', 'is', null);
    const rows = await select
      .orderBy('id', 'desc')
      .limit(query.limit ?? 500)
      .execute();
    return rows.map(toIncident);
  }

  // ---- supervisor writes ----

  /** `imported → released`; posts `released`. */
  async release(
    id: string,
    request: { readonly version: number },
    context: WriteContext,
  ): Promise<OrderRecord> {
    return this.#write(id, request.version, context, 'order.release', async (trx, row, plantAt) => {
      expectStatus(row, ['imported'], 'release');
      if (row.erp_status !== 'open') {
        throw new OrderError(
          'conflict',
          `order ${id} is cancelled in the ERP`,
          PROBLEM_TYPES.orderState,
        );
      }
      await this.#statusMessage(trx, row, 'released', plantAt);
      return { set: { status: 'released', released_at: plantAt } };
    }).then((r) => r.order);
  }

  /** Cancels an order not dispatched yet; posts `cancelled`. */
  async cancel(
    id: string,
    request: { readonly version: number; readonly reason?: string | undefined },
    context: WriteContext,
  ): Promise<OrderRecord> {
    return this.#write(id, request.version, context, 'order.cancel', async (trx, row, plantAt) => {
      expectStatus(row, ['imported', 'released'], 'cancel');
      await this.#statusMessage(trx, row, 'cancelled', plantAt, {
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      });
      return {
        set: { status: 'cancelled', cancelled_at: plantAt },
        ...(request.reason === undefined ? {} : { audit: { reason: request.reason } }),
      };
    }).then((r) => r.order);
  }

  /**
   * `completed → closed`; posts `closed`. With a close guard (#201, ADR-0035) the transaction
   * first takes the advisory lock opening a hold takes too, then the order row's lock, and the
   * guard refuses while genealogy has not processed every fact of the order's units (409
   * `genealogy-pending`, retryable) or an open hold covers a unit of it or the order (409
   * `quality-hold`). Every operation of the order must be signed off at its terminal (#177: the
   * operators' sign-off, then the supervisor's close); 409 `sign-off-missing` names those that are
   * not.
   */
  async close(
    id: string,
    request: { readonly version: number },
    context: WriteContext,
  ): Promise<OrderRecord> {
    const guard = this.#guard;
    const write = async (trx: Transaction<Database>, row: OrderRow, plantAt: Date) => {
      expectStatus(row, ['completed'], 'close');
      if (!guard && this.#options.unguardedClose !== true) {
        throw new OrderError(
          'conflict',
          `order ${id}: no quality close guard is wired; refusing the close (fail closed)`,
        );
      }
      const refusal = guard ? await guard.check(trx, id) : undefined;
      if (refusal) {
        throw new OrderError(
          'conflict',
          refusal.message,
          refusal.kind === 'quality-hold'
            ? PROBLEM_TYPES.qualityHold
            : PROBLEM_TYPES.genealogyPending,
          refusal.kind === 'quality-hold' ? refusal.holds : undefined,
        );
      }
      const missing = await trx
        .selectFrom('orders.order_operation')
        .select(['operation', 'work_center'])
        .where('order_id', '=', id)
        .where('signed_off_at', 'is', null)
        .orderBy('position')
        .execute();
      if (missing.length > 0) {
        throw new OrderError(
          'conflict',
          `order ${id}: not signed off at the terminal yet: ${missing
            .map((m) => `${m.operation} (${m.work_center})`)
            .join(', ')}`,
          PROBLEM_TYPES.signOffMissing,
        );
      }
      await this.#statusMessage(trx, row, 'closed', plantAt);
      return { set: { status: 'closed' as const, closed_at: plantAt } };
    };
    return this.#write(
      id,
      request.version,
      context,
      'order.close',
      write,
      guard ? (trx) => guard.lock(trx) : undefined,
    ).then((r) => r.order);
  }

  /**
   * Dispatches the whole released order as one job (command n = 1) to the CNC the dispatch rule
   * chooses, or the one named: the command is written in this transaction (the outbox), and
   * published by the next tick once the CNC's previous command is settled.
   */
  async dispatch(
    id: string,
    request: { readonly version: number; readonly equipment?: string | undefined },
    context: WriteContext,
  ): Promise<{ order: OrderRecord; command: CommandRecord }> {
    const result = await this.#write(
      id,
      request.version,
      context,
      'order.dispatch',
      async (trx, row, plantAt) => {
        expectStatus(row, ['released'], 'dispatch');
        const command = await this.#newCommand(trx, row, 1, row.quantity, request.equipment);
        return {
          set: { status: 'dispatched', dispatched_at: plantAt },
          command: command.command_id,
          audit: commandAudit(command),
        };
      },
    );
    this.#soon();
    if (!result.command) throw new Error('unreachable: no command');
    return { order: result.order, command: result.command };
  }

  /**
   * Dispatches the remainder again with a new command (n + 1), ADR-0029 B2: only when every
   * earlier command of the order is settled, and at most the order quantity minus the blanks of
   * the jobs the device accepted (a lost job counting the blanks it started), so the device can
   * never hold more accepted blanks for the order than its quantity.
   */
  async redispatch(
    id: string,
    request: {
      readonly version: number;
      readonly equipment?: string | undefined;
      readonly quantity?: number | undefined;
    },
    context: WriteContext,
  ): Promise<{ order: OrderRecord; command: CommandRecord }> {
    const result = await this.#write(
      id,
      request.version,
      context,
      'order.redispatch',
      async (trx, row) => {
        expectStatus(row, ['dispatched', 'in-progress'], 'redispatch');
        // The latest reading of the order's commands, inside the queue, before deciding.
        const evaluated = await this.#evaluate(trx, { orderId: id });
        const commands = await trx
          .selectFrom('orders.dispatch_command')
          .selectAll()
          .where('order_id', '=', id)
          .orderBy('n')
          .forUpdate()
          .execute();
        const open = commands.filter((c) => !c.settled);
        if (open.length > 0) {
          throw new OrderError(
            'conflict',
            `an earlier command is not settled: ${open
              .map((c) => `${c.command_id} (${c.state})`)
              .join(', ')}; a re-dispatch could make a second job`,
            PROBLEM_TYPES.commandsUnsettled,
          );
        }
        const dispatched = commands.reduce((sum, c) => sum + countedBlanks(c), 0);
        const remaining = row.quantity - dispatched;
        if (remaining <= 0) {
          throw new OrderError(
            'invalid',
            `nothing to dispatch: the device accepted ${String(dispatched)} of ${String(row.quantity)} blanks`,
          );
        }
        const quantity = request.quantity ?? remaining;
        if (quantity > remaining) {
          throw new OrderError(
            'invalid',
            `at most ${String(remaining)} blanks remain (${String(dispatched)} of ${String(row.quantity)} accepted)`,
          );
        }
        const n = Math.max(0, ...commands.map((c) => c.n)) + 1;
        const command = await this.#newCommand(trx, row, n, quantity, request.equipment);
        await this.#closeIncidents(trx, { orderId: id, type: 'dispatch-lost' }, 'redispatched');
        return {
          set: { dispatch_failed: false, dispatch_lost: false },
          command: command.command_id,
          touched: evaluated.commands,
          audit: { ...commandAudit(command), remainingBefore: remaining },
        };
      },
    );
    this.#soon();
    if (!result.command) throw new Error('unreachable: no command');
    return { order: result.order, command: result.command };
  }

  /**
   * Writes off a command of the order whose device run has ended (`order:abandon`, #174 review):
   * it becomes `abandoned` (settled and final; its incidents closed) and its whole quantity counts
   * as dispatched, unless it is already final with what its facts proved. A run's end settles
   * its commands by itself; this is the supervisor's explicit sign-off for one whose facts will
   * never be fully known, so that the CNC's queue and the order's books move on knowingly.
   * Refused (409 `order-state`) while its run goes on.
   */
  async abandon(
    id: string,
    request: { readonly version: number; readonly commandId: string },
    context: WriteContext,
  ): Promise<OrderRecord> {
    return this.#write(id, request.version, context, 'order.abandon-command', async (trx, row) => {
      expectStatus(row, ['dispatched', 'in-progress'], 'abandon a command');
      const command = await trx
        .selectFrom('orders.dispatch_command')
        .selectAll()
        .where('command_id', '=', request.commandId)
        .where('order_id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!command) {
        throw new OrderError('not-found', `no command ${request.commandId} of order ${id}`);
      }
      if (command.state === 'abandoned') {
        throw new OrderError(
          'conflict',
          `${request.commandId} is abandoned already`,
          PROBLEM_TYPES.orderState,
        );
      }
      const newest = (await this.#ingest.newestDeviceEpochs()).get(command.equipment);
      if (newest === undefined || newest <= command.device_epoch) {
        throw new OrderError(
          'conflict',
          `${request.commandId}: its device run ${String(command.device_epoch)} has not ended; only a command of an ended run may be abandoned`,
          PROBLEM_TYPES.orderState,
        );
      }
      await trx
        .updateTable('orders.dispatch_command')
        .set({
          state: 'abandoned',
          settled: true,
          final: true,
          updated_at: sql<Date>`clock_timestamp()`,
        })
        .where('command_id', '=', request.commandId)
        .execute();
      await this.#closeIncidents(trx, { orderId: id, commandId: request.commandId }, 'abandoned');
      return {
        set: { dispatch_lost: true },
        touched: [request.commandId],
        audit: {
          commandId: request.commandId,
          stateBefore: command.state,
          job: command.job,
          deviceEpoch: command.device_epoch,
          counted: command.quantity,
        },
      };
    }).then((r) => r.order);
  }

  /**
   * The order is completed (#175's seam: execution decides it from final data, plan H1);
   * `short` when packed good < quantity. Posts `completed`.
   */
  async complete(
    id: string,
    outcome: { readonly short: boolean; readonly at: Date },
  ): Promise<OrderRecord> {
    const changed = await this.#serial(() =>
      this.#db.transaction().execute(async (trx) => {
        const row = await this.#lock(trx, id);
        expectStatus(row, ['dispatched', 'in-progress'], 'complete');
        await this.#statusMessage(trx, row, 'completed', outcome.at, { short: outcome.short });
        await trx
          .updateTable('orders.production_order')
          .set({
            status: 'completed',
            short: outcome.short,
            completed_at: outcome.at,
            version: row.version + 1,
            updated_at: sql<Date>`clock_timestamp()`,
          })
          .where('id', '=', id)
          .execute();
        return id;
      }),
    );
    const order = await this.#emitOrder(changed, 'updated');
    if (!order) throw new Error('unreachable: no order');
    return order;
  }

  // ---- the operator terminal (#177) ----

  /** Order operations with their version, completion, sign-off and open activities. */
  async operations(
    filter: {
      readonly orderIds?: readonly string[];
      readonly workCenter?: string;
      readonly operation?: string;
    } = {},
  ): Promise<OperationRecord[]> {
    return readOperations(this.#readDb, filter);
  }

  /** Activity intervals, newest first. */
  async activities(
    filter: {
      readonly orderId?: string;
      readonly operation?: string;
      readonly userId?: number;
      readonly open?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<ActivityRecord[]> {
    return readActivities(this.#readDb, filter);
  }

  /**
   * The operator starts work on an order operation (no interval of theirs open on it: `activity`
   * null as read; another one open is 409 `operation-stale`).
   */
  async startWork(
    id: string,
    operation: string,
    request: { readonly activity: number | null },
    context: TerminalWriteContext,
  ): Promise<OperationRecord> {
    return this.#terminal(id, operation, 'start', request, context);
  }

  /** The operator pauses their work on it, with a reason (`activity`: their open work interval). */
  async pauseWork(
    id: string,
    operation: string,
    request: {
      readonly activity: number | null;
      readonly reason: PauseReason;
      readonly comment?: string | undefined;
    },
    context: TerminalWriteContext,
  ): Promise<OperationRecord> {
    return this.#terminal(id, operation, 'pause', request, context);
  }

  /** The operator resumes their paused work on it (`activity`: their open pause). */
  async resumeWork(
    id: string,
    operation: string,
    request: { readonly activity: number | null },
    context: TerminalWriteContext,
  ): Promise<OperationRecord> {
    return this.#terminal(id, operation, 'resume', request, context);
  }

  /**
   * Signs the operation off: only once the MES has it complete (its final confirmation is
   * written); closes every open interval on it. A close needs every operation signed off.
   */
  async signOff(
    id: string,
    operation: string,
    request: { readonly version: number },
    context: TerminalWriteContext,
  ): Promise<OperationRecord> {
    return this.#terminal(id, operation, 'sign-off', request, context);
  }

  /**
   * Closes an operator's open intervals at a work center started under the crew row `crewId`
   * (#366; those without one: started by `until`, the crew row's end in wall time): that crew row
   * ended.
   */
  async endActivities(who: {
    readonly userId: number;
    readonly workCenter: string;
    readonly until: Date;
    readonly crewId?: number;
  }): Promise<number> {
    const touched = await endActivities(this.#db, who, this.#plantNow());
    await this.#emitOperations(touched);
    return touched.length;
  }

  /**
   * Closes every open interval whose operator has no open crew row at its work center
   * (`{userId}|{workCenter}` in `signedOn`, read after `before`, database time) and started before
   * it: crew rows that ended while the MES was down, or whose notice was lost.
   */
  async endOrphanedActivities(signedOn: ReadonlySet<string>, before: Date): Promise<number> {
    const touched = await endOrphanedActivities(this.#db, signedOn, before, this.#plantNow());
    await this.#emitOperations(touched);
    return touched.length;
  }

  async #terminal(
    id: string,
    operation: string,
    action: TerminalAction,
    request: TerminalRequest,
    context: TerminalWriteContext,
  ): Promise<OperationRecord> {
    if (!this.#started) throw new OrderError('conflict', 'the orders module is starting');
    const plantAt = this.#plantNow();
    const refusal = await this.#db
      .transaction()
      .execute((trx) => terminalWrite(trx, id, operation, action, request, context, plantAt));
    if (refusal) throw new OrderError(refusal.kind, refusal.message, refusal.type);
    const [record] = await readOperations(this.#db, { orderIds: [id], operation });
    if (!record) throw new Error('unreachable: no operation');
    this.#emit({ type: 'operation', event: 'updated', operation: record });
    return record;
  }

  async #emitOperations(
    touched: readonly { readonly orderId: string; readonly operation: string }[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const { orderId, operation } of touched) {
      const key = `${orderId}/${operation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [record] = await readOperations(this.#db, { orderIds: [orderId], operation });
      if (record) this.#emit({ type: 'operation', event: 'updated', operation: record });
    }
  }

  // ---- confirmations (#175, ADR-0028, ADR-0031) ----

  /**
   * Confirms an order operation to the ERP from its final totals (#175's execution module calls
   * it once the operation is complete, plan H1): the first time a final confirmation (n = 1) with
   * the totals; later, only when the totals differ from the sum of every confirmation sent, a
   * correction (n + 1) with the signed deltas, judged against what was confirmed before the change.
   * Written with its outbound message (key `confirmationKey`) in one transaction; posted by the
   * outbox. Returns the confirmation written, or undefined when nothing changed.
   */
  async confirm(
    id: string,
    operation: string,
    totals: OperationConfirmation,
    at: Date,
  ): Promise<ConfirmationRecord | undefined> {
    const written = await this.#serial(() =>
      this.#db.transaction().execute(async (trx) => {
        const row = await this.#lock(trx, id);
        expectStatus(row, ['dispatched', 'in-progress', 'completed', 'closed'], 'confirm');
        const earlier = await trx
          .selectFrom('orders.confirmation')
          .selectAll()
          .where('order_id', '=', id)
          .where('operation', '=', operation)
          .orderBy('n', 'desc')
          .limit(1)
          .executeTakeFirst();
        const confirmed = earlier ? (earlier.totals as OperationConfirmation) : undefined;
        const delta = confirmed ? difference(totals, confirmed) : totals;
        if (confirmed && isZero(delta)) return undefined;
        const n = (earlier?.n ?? 0) + 1;
        const kind = n === 1 ? 'final' : 'correction';
        const key = confirmationKey(id, operation, n);
        const body: ConfirmationRequest = {
          orderNumber: id,
          revision: row.revision,
          operation,
          kind,
          confirmation: n,
          yield: delta.yield,
          scrap: lines(delta.scrap).map(([reason, quantity]) => ({ reason, quantity })),
          reworkPasses: delta.reworkPasses,
          material: lines(delta.material).map(([material, quantity]) => ({ material, quantity })),
          confirmedAt: at.toISOString(),
        };
        const stored = await trx
          .insertInto('orders.confirmation')
          .values({
            order_id: id,
            operation,
            n,
            kind,
            revision: row.revision,
            yield: delta.yield,
            scrap: JSON.stringify(delta.scrap),
            rework_passes: delta.reworkPasses,
            material: JSON.stringify(delta.material),
            totals: JSON.stringify(canonicalTotals(totals)),
            confirmed_at: at,
            idempotency_key: key,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('orders.erp_message_log')
          .values({
            direction: 'out',
            kind: 'confirmation',
            order_id: id,
            revision: row.revision,
            idempotency_key: key,
            feed_id: null,
            feed_seq: null,
            payload: JSON.stringify(body),
            status: 'pending',
            detail: null,
            receipt: null,
          })
          .execute();
        return toConfirmation(stored, 'pending');
      }),
    );
    if (written) {
      this.#log.info(
        { order: id, operation, n: written.n, kind: written.kind },
        'order operation confirmed',
      );
      await this.#emitOrder(id, 'updated');
    }
    return written;
  }

  /** The confirmations sent for an order, by operation and number, with their message status. */
  async confirmations(
    id: string,
    db: Kysely<Database> = this.#readDb,
  ): Promise<ConfirmationRecord[]> {
    const rows = await db
      .selectFrom('orders.confirmation as c')
      .leftJoin('orders.erp_message_log as m', 'm.idempotency_key', 'c.idempotency_key')
      .selectAll('c')
      .select('m.status as message_status')
      .where('c.order_id', '=', id)
      .orderBy('c.operation')
      .orderBy('c.n')
      .execute();
    return rows.map((row) => toConfirmation(row, row.message_status ?? 'pending'));
  }

  // ---- ERP import (ADR-0028) ----

  /**
   * Pulls the change feed from the cursor until the ERP has no more, one page per transaction with
   * the cursor committed in it (a crash never skips or half-imports a page). A changed `feedId`, or
   * a 409 `erp-cursor-ahead`, is an `erp-feed-changed` incident and resets the cursor to 0: the
   * import is idempotent by (order number, revision). Returns the feed entries handled.
   */
  async importNow(): Promise<number> {
    const erp = this.#options.erp;
    if (!erp || this.#importing || this.#stopping) return 0;
    this.#importing = true;
    let handled = 0;
    try {
      for (let pages = 0; pages < 10_000 && !this.#isStopping(); pages++) {
        const cursor = await this.#cursor();
        const answer = await erp.feed(cursor.cursor, FEED_PAGE);
        if (answer.kind === 'cursor-ahead') {
          if (cursor.cursor === 0) throw new Error(`ERP: cursor 0 is ahead (${answer.detail})`);
          await this.#resetCursor(
            cursor,
            null,
            `the ERP answered erp-cursor-ahead to cursor ${String(cursor.cursor)} (${answer.detail})`,
          );
          continue;
        }
        const page = answer.page;
        if (cursor.feedId !== null && page.feedId !== cursor.feedId) {
          await this.#resetCursor(
            cursor,
            page.feedId,
            `the ERP's feed changed from ${cursor.feedId} to ${page.feedId}`,
          );
          continue;
        }
        const deferred: string[] = [];
        const changed = await this.#serial(() =>
          this.#db.transaction().execute(async (trx) => {
            const now = await trx
              .selectFrom('orders.erp_cursor')
              .selectAll()
              .where('id', '=', 'erp')
              .forUpdate()
              .executeTakeFirst();
            // Another import moved the cursor meanwhile: read this page again from there.
            if ((now?.cursor ?? 0) !== cursor.cursor || (now?.feed_id ?? null) !== cursor.feedId) {
              return undefined;
            }
            const orders = new Map<string, 'imported' | 'updated'>();
            for (const entry of page.entries) {
              // One entry the database refuses must not poison the page (nor every later import):
              // it is undone to its savepoint and recorded as rejected, the page commits.
              await sql`SAVEPOINT erp_entry`.execute(trx);
              let change: 'imported' | 'updated' | undefined;
              try {
                change = await this.#importEntry(trx, entry, page.feedId);
                await sql`RELEASE SAVEPOINT erp_entry`.execute(trx);
              } catch (error) {
                await sql`ROLLBACK TO SAVEPOINT erp_entry`.execute(trx);
                change = await this.#invalidEntry(trx, entry, page.feedId, error, deferred);
              }
              if (change && orders.get(entry.order.orderNumber) !== 'imported') {
                orders.set(entry.order.orderNumber, change);
              }
            }
            await trx
              .insertInto('orders.erp_cursor')
              .values({ id: 'erp', feed_id: page.feedId, cursor: page.cursor })
              .onConflict((c) =>
                c.column('id').doUpdateSet({
                  feed_id: page.feedId,
                  cursor: page.cursor,
                  updated_at: sql<Date>`clock_timestamp()`,
                }),
              )
              .execute();
            return orders;
          }),
        );
        if (changed === undefined) continue;
        // Committed: the page's incidents are open now.
        for (const key of deferred) this.#openIncidents.add(key);
        handled += page.entries.length;
        for (const [id, event] of changed) await this.#emitOrder(id, event);
        if (!page.more) break;
      }
    } finally {
      this.#importing = false;
    }
    return handled;
  }

  /**
   * Posts the pending outbound ERP messages in order (ADR-0028): 201/200 stored, 409 an
   * `erp-conflict` incident, another refusal an `erp-refused` incident (neither retried); anything
   * transient stops the round and retries the message with backoff. Returns the messages settled.
   */
  async postNow(): Promise<number> {
    const erp = this.#options.erp;
    if (!erp || this.#posting || this.#stopping) return 0;
    this.#posting = true;
    let settled = 0;
    try {
      const now = new Date(this.#now());
      const pending = await this.#db
        .selectFrom('orders.erp_message_log')
        .selectAll()
        .where('status', '=', 'pending')
        .orderBy('id')
        .limit(POST_BATCH)
        .execute();
      for (const message of pending) {
        if (message.next_attempt_at !== null && message.next_attempt_at > now) break;
        const kind = message.kind === 'feed-entry' ? 'status' : message.kind;
        const outcome = await erp.post(kind, message.idempotency_key ?? '', message.payload);
        this.#erpPosts?.inc({ outcome: outcome.kind });
        const attempts = message.attempts + 1;
        if (outcome.kind === 'retry') {
          const wait = Math.min(1_000 * 2 ** message.attempts, POST_MAX_BACKOFF_MS);
          await this.#db
            .updateTable('orders.erp_message_log')
            .set({
              attempts,
              last_error: outcome.detail,
              next_attempt_at: new Date(this.#now() + wait),
              updated_at: sql<Date>`clock_timestamp()`,
            })
            .where('id', '=', message.id)
            .execute();
          this.#log.warn(
            { key: message.idempotency_key, attempts, detail: outcome.detail },
            'ERP post failed; retrying',
          );
          break;
        }
        await this.#serial(() =>
          this.#db.transaction().execute(async (trx) => {
            await trx
              .updateTable('orders.erp_message_log')
              .set({
                status:
                  outcome.kind === 'stored'
                    ? 'sent'
                    : outcome.kind === 'conflict'
                      ? 'conflict'
                      : 'refused',
                attempts,
                last_error: outcome.kind === 'stored' ? null : outcome.detail,
                next_attempt_at: null,
                receipt: outcome.kind === 'stored' ? JSON.stringify(outcome.receipt) : null,
                updated_at: sql<Date>`clock_timestamp()`,
              })
              .where('id', '=', message.id)
              .execute();
            if (outcome.kind !== 'stored') {
              await this.#incident(trx, {
                type: outcome.kind === 'conflict' ? 'erp-conflict' : 'erp-refused',
                key: `${outcome.kind === 'conflict' ? 'erp-conflict' : 'erp-refused'}:${message.idempotency_key ?? String(message.id)}`,
                orderId: message.order_id,
                message: `the ERP refused ${message.kind} ${message.idempotency_key ?? ''}: ${outcome.detail}`,
              });
            }
          }),
        );
        settled++;
      }
    } finally {
      this.#posting = false;
    }
    return settled;
  }

  // ---- commands ----

  /**
   * Reads every live command again (results, job facts, the CNCs' progress), records what changed
   * (states, jobs, flags, incidents, the order's `in-progress`), checks job facts heard of against
   * the commands (`unknown-job`), then publishes what the outbox owes: per CNC only the first
   * command not settled, and only while the gateway is not offline.
   */
  async tick(): Promise<void> {
    if (!this.#started || this.#stopping) return;
    await this.#serial(async () => {
      const evaluated = await this.#deferringIncidents(() =>
        this.#db.transaction().execute((trx) => this.#evaluate(trx, {})),
      );
      await this.#emitAfter(evaluated.orders, evaluated.commands);
      await this.#checkJobs();
      await this.#publish(evaluated.readings);
    });
  }

  /** A tick soon after a notice or a dispatch (none with `tickMs: 0`: tests tick themselves). */
  #soon(): void {
    if (this.#kick !== undefined || !this.#started || this.#options.tickMs === 0) return;
    this.#kick = setTimeout(() => {
      this.#kick = undefined;
      this.tick().catch((error: unknown) => {
        this.#log.error({ err: error }, 'orders: tick failed');
      });
    }, 20);
    this.#kick.unref();
  }

  #onNotice(notice: IngestNotice): void {
    if (notice.type === 'job') this.#heardJobs.push(notice.fact);
    const relevant =
      notice.type === 'job' ||
      notice.type === 'command-result' ||
      notice.type === 'epoch' ||
      notice.type === 'anchor' ||
      notice.type === 'gaps' ||
      (notice.type === 'sample' && notice.sample.scope === 'device');
    if (relevant) this.#soon();
  }

  /** A method, so that the check is repeated after every await. */
  #isStopping(): boolean {
    return this.#stopping;
  }

  /**
   * Reads the live commands (of one order, or all) and writes what changed, in `trx`. A command is
   * live until nothing can change it any more: settled without a job, or its job completed and
   * confirmed, or lost.
   */
  async #evaluate(
    trx: Transaction<Database>,
    filter: { readonly orderId?: string },
  ): Promise<{
    readings: Map<string, { row: CommandRow; reading: CommandReading }>;
    /** Orders and commands changed (to tell listeners once committed). */
    orders: string[];
    commands: string[];
  }> {
    let select = trx.selectFrom('orders.dispatch_command').selectAll().where('final', '=', false);
    if (filter.orderId !== undefined) select = select.where('order_id', '=', filter.orderId);
    const rows = await select.orderBy('queue_position').execute();
    const readings = new Map<string, { row: CommandRow; reading: CommandReading }>();
    if (rows.length === 0) return { readings, orders: [], commands: [] };
    const ids = rows.map((r) => r.command_id);
    // What settles a command without a job (how far each CNC's stream arrived, the newest run) is
    // read BEFORE the facts and results it is weighed against (#218). Ingest commits a fact and
    // its stream's cursor in one transaction, so every number this progress counts as received is
    // visible to the later reads: the acceptance can't be counted as arrived yet missing from
    // `facts`. Read the other way round, an `accepted` fact stored between the two reads settled
    // the command `not-accepted` (or `epoch-ended`) with its job on the device.
    const progress = new Map<string, DeviceProgress>();
    for (const equipment of new Set(rows.map((r) => r.equipment))) {
      progress.set(equipment, await this.#ingest.deviceProgress(equipment));
    }
    const newest = await this.#ingest.newestDeviceEpochs();
    const [attempts, results, facts] = await Promise.all([
      trx
        .selectFrom('orders.command_attempt')
        .selectAll()
        .where('command_id', 'in', ids)
        .orderBy('attempt')
        .execute(),
      this.#ingest.commandResults(ids),
      this.#ingest.jobFacts({ commandIds: ids }),
    ]);
    const now = this.#now();
    const changed: { row: CommandRow; reading: Recorded }[] = [];
    for (const row of rows) {
      const device = progress.get(row.equipment);
      // What the MES had stored of the run before the first delivery was written (no clock).
      const before =
        attempts.find((a) => a.command_id === row.command_id && a.attempt === 1)?.stored_seq ??
        null;
      const reading = readCommand(
        {
          commandId: row.command_id,
          equipment: row.equipment,
          deviceEpoch: row.device_epoch,
          previous: { state: row.state, settled: row.settled },
          attempts: attempts
            .filter((a) => a.command_id === row.command_id)
            .map((a) => ({
              issuedAt: a.issued_at.getTime(),
              expiresAt: a.expires_at.getTime(),
              published: a.published_at !== null,
            })),
          results: results.filter((r) => r.value.commandId === row.command_id),
          facts: facts
            .filter((f) => f.commandId === row.command_id)
            .map((f) => ({ ...f, sourceTime: f.sourceTime.getTime() })),
          device: {
            epoch: device?.epoch ?? null,
            newestEpoch: newest.get(row.equipment) ?? null,
            receivedThrough: device?.receivedThrough ?? null,
            seen: device?.seen ?? [],
            before,
            settledSeq: device?.settledSeq ?? null,
            settledTime: time(device?.settledTime ?? null),
          },
        },
        now,
        this.#timings,
      );
      readings.set(row.command_id, { row, reading });
      // Final once its run's facts are refused (a newer epoch reached the device stream), or its
      // job completed and was confirmed: nothing can change it any more.
      // A lost job's blanks: the exact count from the execution module's units wins once known
      // (#175 review); until then the running maximum of the conservative count, and the command
      // stays live so that the exact count can still replace it.
      const counted =
        reading.job === 'lost' && device ? await this.#lostStarted(row, reading, device) : null;
      const lostStarted =
        counted === null
          ? null
          : counted.exact
            ? counted.count
            : Math.max(row.lost_started ?? 0, counted.count);
      const final =
        ((device?.epoch !== null &&
          device?.epoch !== undefined &&
          device.epoch > row.device_epoch) ||
          (reading.job === 'completed' && reading.confirmed)) &&
        counted?.pending !== true;
      const record = { ...reading, final, lostStarted };
      if (this.#differs(row, record)) changed.push({ row, reading: record });
    }
    const orders = new Set<string>();
    const commands = new Set<string>();
    for (const orderId of new Set(changed.map((c) => c.row.order_id))) {
      const order = await this.#lock(trx, orderId);
      const blanksBefore = await this.#orderBlanks(trx, orderId);
      let flags: Partial<{
        dispatch_failed: boolean;
        dispatch_lost: boolean;
        status: OrderStatus;
        started_at: Date;
      }> = {};
      for (const { row, reading } of changed.filter((c) => c.row.order_id === orderId)) {
        const updated = await this.#record(trx, row, reading);
        readings.set(row.command_id, { row: updated, reading });
        commands.add(row.command_id);
        flags = { ...flags, ...(await this.#effects(trx, order, row, reading)) };
      }
      const status = flags.status ?? order.status;
      // `dispatched` and `inFlight` are read from the commands: when they move, the order has
      // changed too, so its version, `updated_at` and push move with them (#176 review H1).
      const blanksAfter = await this.#orderBlanks(trx, orderId);
      const changes =
        blanksAfter.dispatched !== blanksBefore.dispatched ||
        blanksAfter.inFlight !== blanksBefore.inFlight ||
        flags.status !== undefined ||
        (flags.dispatch_failed === true && !order.dispatch_failed) ||
        (flags.dispatch_lost === true && !order.dispatch_lost);
      if (changes) {
        await trx
          .updateTable('orders.production_order')
          .set({
            ...flags,
            status,
            version: order.version + 1,
            updated_at: sql<Date>`clock_timestamp()`,
          })
          .where('id', '=', orderId)
          .execute();
        orders.add(orderId);
      }
    }
    return { readings, orders: [...orders], commands: [...commands] };
  }

  /** The order's counted and in-flight blanks, as `#records` derives them for the API. */
  async #orderBlanks(
    trx: Transaction<Database>,
    orderId: string,
  ): Promise<{ dispatched: number; inFlight: number }> {
    const commands = await trx
      .selectFrom('orders.dispatch_command')
      .select(['quantity', 'job', 'lost_started', 'settled', 'state', 'rejection'])
      .where('order_id', '=', orderId)
      .execute();
    return {
      dispatched: commands.reduce((sum, c) => sum + countedBlanks(c), 0),
      inFlight: commands
        .filter((c) => !c.settled && c.job === null)
        .reduce((sum, c) => sum + c.quantity, 0),
    };
  }

  #differs(row: CommandRow, reading: Recorded): boolean {
    const accepted = reading.accepted;
    return (
      row.final !== reading.final ||
      row.lost_started !== reading.lostStarted ||
      row.state !== reading.state ||
      row.settled !== reading.settled ||
      (reading.failed && !row.failed) ||
      row.confirmed !== reading.confirmed ||
      row.job !== reading.job ||
      row.accepted_by !== (accepted?.by ?? null) ||
      row.accepted_seq !== (accepted?.seq ?? null) ||
      time(row.accepted_at) !== (accepted?.at ?? null) ||
      time(row.started_at) !== (reading.started?.at ?? null) ||
      time(row.completed_at) !== reading.completedAt ||
      row.rejection !== reading.rejection ||
      row.seq_after_expiry !== reading.seqAfterExpiry ||
      reading.unconfirmed !== this.#openIncidents.has(`command-unconfirmed:${row.command_id}`) ||
      (reading.acceptedFacts > 1 && !this.#openIncidents.has(`duplicate-job:${row.command_id}`))
    );
  }

  async #record(
    trx: Transaction<Database>,
    row: CommandRow,
    reading: Recorded,
  ): Promise<CommandRow> {
    return trx
      .updateTable('orders.dispatch_command')
      .set({
        state: reading.state,
        settled: reading.settled,
        final: reading.final,
        failed: row.failed || reading.failed,
        accepted_by: reading.accepted?.by ?? null,
        accepted_seq: reading.accepted?.seq ?? null,
        accepted_at: reading.accepted ? new Date(reading.accepted.at) : null,
        confirmed: reading.confirmed,
        job: reading.job,
        started_at: reading.started ? new Date(reading.started.at) : null,
        completed_at: reading.completedAt === null ? null : new Date(reading.completedAt),
        lost_started: reading.lostStarted,
        rejection: reading.rejection,
        seq_after_expiry: reading.seqAfterExpiry,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('command_id', '=', row.command_id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The blanks a lost job started (its run ended before `completed`), erring towards a short
   * order, never towards more blanks than the order's quantity:
   * - its whole quantity while its facts are not fully known: accepted only by a result (no fact),
   *   or a number after its `started` fact (or, without one, its acceptance) missing, in the
   *   stream (while the run's epoch is still the stream's) or as a gap incident of the run;
   * - else none if it never started, or its OP10 cycles before the next job's `started` fact,
   *   plus one that may have been in the machine, at most its quantity.
   * Exact (`exact`) from the execution module's units once every OP10 cycle of the job is a unit
   * (#175); `pending` while they are still being built, so the caller keeps the command live and
   * lets the exact count replace the conservative one. Otherwise the caller keeps the running
   * maximum.
   */
  async #lostStarted(
    row: CommandRow,
    reading: CommandReading,
    device: DeviceProgress,
  ): Promise<{ count: number; exact: boolean; pending: boolean }> {
    const sure = (count: number) => ({ count, exact: false, pending: false });
    if (!reading.confirmed || reading.accepted === null) return sure(row.quantity);
    const from = reading.started?.seq ?? reading.accepted.seq;
    let known: boolean;
    if (device.epoch === row.device_epoch) {
      const range = device.seen.find(([lo, hi]) => lo <= from && from <= hi);
      known = range !== undefined && device.lastSeq !== null && range[1] >= device.lastSeq;
    } else {
      const { incidents } = await this.#ingest.settled(row.equipment, row.device_epoch);
      known = !incidents.some((incident) => incident.seqTo >= from);
    }
    if (!known) return sure(row.quantity);
    if (reading.started === null) {
      // Accepted, never started: one blank may have been taken without its `started` fact
      // having been raised yet only if it was the CNC's head job (an earlier job not completed
      // keeps it waiting), unless a later fact shows the CNC moved on (another job started, or
      // it went Idle for want of a startable order).
      const acceptedSeq = reading.accepted.seq;
      const jobs = await this.#ingest.jobFacts({
        equipment: row.equipment,
        epoch: row.device_epoch,
      });
      const earlier = new Set(
        jobs
          .filter((f) => f.transition === 'accepted' && f.seq < acceptedSeq)
          .map((f) => f.commandId),
      );
      for (const f of jobs) if (f.transition === 'completed') earlier.delete(f.commandId);
      if (earlier.size > 0) return sure(0);
      const movedOn =
        jobs.some(
          (f) =>
            f.transition === 'started' && f.seq > acceptedSeq && f.commandId !== row.command_id,
        ) ||
        (
          await this.#ingest.stateFacts(row.equipment, row.device_epoch, {
            fromSeq: acceptedSeq + 1,
          })
        ).some((f) => f.state === 'Idle' && f.cause === 'NO-ORDER');
      return sure(movedOn ? 0 : Math.min(1, row.quantity));
    }
    const started = reading.started;
    // #175: the execution module's units count the job's blanks exactly (its OP10 units, plus one
    // only if the CNC's states show it still held one); without them, the conservative count.
    const exact = await this.#blanks?.blanksStarted({
      commandId: row.command_id,
      equipment: row.equipment,
      deviceEpoch: row.device_epoch,
      quantity: row.quantity,
      startedSeq: started.seq,
    });
    if (exact !== undefined) {
      return { count: Math.min(row.quantity, exact), exact: true, pending: false };
    }
    const later = (
      await this.#ingest.jobFacts({ equipment: row.equipment, epoch: row.device_epoch })
    )
      .filter((f) => f.transition === 'started' && f.seq > started.seq)
      .sort((a, b) => a.seq - b.seq)[0];
    const cycles = await this.#ingest.cyclesBetween(
      row.equipment,
      row.device_epoch,
      started.seq,
      later?.seq ?? null,
    );
    // Pending while a blank counter is attached: its units are still being built.
    return {
      count: Math.min(row.quantity, cycles + 1),
      exact: false,
      pending: this.#blanks !== undefined,
    };
  }

  /** Incidents and order changes that follow from a command's new reading. */
  async #effects(
    trx: Transaction<Database>,
    order: OrderRow,
    row: CommandRow,
    reading: CommandReading,
  ): Promise<
    Partial<{
      dispatch_failed: boolean;
      dispatch_lost: boolean;
      status: OrderStatus;
      started_at: Date;
    }>
  > {
    const id = row.command_id;
    const flags: Partial<{
      dispatch_failed: boolean;
      dispatch_lost: boolean;
      status: OrderStatus;
      started_at: Date;
    }> = {};
    const base = { orderId: row.order_id, commandId: id, equipment: row.equipment };
    if (reading.failed && !row.failed) {
      await this.#incident(trx, {
        ...base,
        type: 'command-failed',
        key: `command-failed:${id}`,
        message: `${id}: no final answer after its last expiresAt plus ${String(this.#timings.failMarginMs)} ms; a re-dispatch waits until it is settled`,
      });
      flags.dispatch_failed = true;
    }
    if (reading.settled) {
      await this.#closeIncidents(trx, { key: `command-failed:${id}` }, reading.state);
      await this.#closeIncidents(trx, { key: `command-conflict:${id}` }, reading.state);
      await this.#closeIncidents(trx, { key: `command-publish-refused:${id}` }, reading.state);
    }
    if (reading.state === 'conflict' && row.state !== 'conflict') {
      await this.#incident(trx, {
        ...base,
        type: 'command-conflict',
        key: `command-conflict:${id}`,
        message: `${id}: the device holds another job under this command id (command-conflict); nothing is settled until its run ends, and its quantity counts as dispatched`,
      });
      flags.dispatch_failed = true;
    }
    if (row.settled && row.job === null && reading.job !== null) {
      // A reading proven wrong: the order may now hold more than its quantity on the device.
      await this.#incident(trx, {
        ...base,
        type: 'duplicate-job',
        key: `duplicate-job:late:${id}`,
        message: `${id}: an accepted fact arrived for a command settled without a job (${row.state}); its quantity now counts as dispatched`,
      });
    }
    if (reading.settled && !row.settled && reading.job === null) {
      if (reading.state === 'epoch-ended') flags.dispatch_lost = true;
      else flags.dispatch_failed = true;
    }
    if (reading.job === 'lost' && row.job !== 'lost') {
      await this.#incident(trx, {
        ...base,
        type: 'dispatch-lost',
        key: `dispatch-lost:${id}`,
        message: `${id}: device run ${String(row.device_epoch)} ended with the job ${row.job ?? 'accepted'}, not completed`,
      });
      flags.dispatch_lost = true;
    }
    if (reading.state === 'epoch-ended' && row.state !== 'epoch-ended') {
      await this.#incident(trx, {
        ...base,
        type: 'dispatch-lost',
        key: `dispatch-lost:${id}`,
        message: `${id}: device run ${String(row.device_epoch)} ended before the command was accepted`,
      });
    }
    const unconfirmedKey = `command-unconfirmed:${id}`;
    if (reading.unconfirmed && !this.#openIncidents.has(unconfirmedKey)) {
      await this.#incident(trx, {
        ...base,
        type: 'command-unconfirmed',
        key: unconfirmedKey,
        message: `${id}: accepted (seq ${String(reading.accepted?.seq ?? '?')}) by the gateway's answer, but its accepted fact never arrived though the CNC's facts passed it`,
      });
    } else if (!reading.unconfirmed && this.#openIncidents.has(unconfirmedKey)) {
      await this.#closeIncidents(trx, { key: unconfirmedKey }, 'confirmed');
    }
    if (reading.acceptedFacts > 1 && !this.#openIncidents.has(`duplicate-job:${id}`)) {
      await this.#incident(trx, {
        ...base,
        type: 'duplicate-job',
        key: `duplicate-job:${id}`,
        message: `${id}: ${String(reading.acceptedFacts)} accepted facts for one command id`,
      });
    }
    if (reading.started && order.status === 'dispatched') {
      const at = new Date(reading.started.at);
      flags.status = 'in-progress';
      flags.started_at = at;
      await this.#statusMessage(trx, order, 'in-progress', at);
    }
    return flags;
  }

  /** Job facts of command ids the MES never issued (or of another CNC): `unknown-job`. */
  async #checkJobs(): Promise<void> {
    const facts = this.#heardJobs.splice(0);
    if (facts.length === 0) return;
    const ids = [...new Set(facts.map((f) => f.commandId))];
    const known = await this.#db
      .selectFrom('orders.dispatch_command')
      .select(['command_id', 'equipment'])
      .where('command_id', 'in', ids)
      .execute();
    const unknown = facts.filter(
      (f) => !known.some((k) => k.command_id === f.commandId && k.equipment === f.equipment),
    );
    if (unknown.length === 0) return;
    await this.#db.transaction().execute(async (trx) => {
      for (const fact of unknown) {
        const key = `unknown-job:${fact.equipment}:${String(fact.epoch)}:${fact.commandId}`;
        if (this.#openIncidents.has(key)) continue;
        await this.#incident(trx, {
          type: 'unknown-job',
          key,
          orderId: null,
          commandId: fact.commandId,
          equipment: fact.equipment,
          message: `job fact ${fact.transition} (seq ${String(fact.seq)}, epoch ${String(fact.epoch)}) of command ${fact.commandId} the MES never issued to ${fact.equipment}`,
        });
      }
    });
  }

  /** Publishes, per CNC, the first command not settled when a delivery is due (ADR-0029). */
  async #publish(
    readings: Map<string, { row: CommandRow; reading: CommandReading }>,
  ): Promise<void> {
    const publisher = this.#options.publisher;
    if (!publisher?.connected) return;
    const statuses = await this.#ingest.componentStatuses('edge-gateway');
    if (statuses.some((s) => s.status === 'offline')) return;
    const heads = new Map<string, { row: CommandRow; reading: CommandReading }>();
    for (const entry of [...readings.values()].sort(
      (a, b) => a.row.queue_position - b.row.queue_position,
    )) {
      if (entry.reading.settled || heads.has(entry.row.equipment)) continue;
      heads.set(entry.row.equipment, entry);
    }
    for (const { row, reading } of heads.values()) {
      if (!reading.send) continue;
      await this.#deliver(publisher, row).catch((error: unknown) => {
        this.#log.warn({ err: error, command: row.command_id }, 'publishing a command failed');
      });
    }
  }

  /** One delivery: its attempt row is committed first, then it is published (QoS 1). */
  async #deliver(publisher: CommandPublisher, row: CommandRow): Promise<void> {
    const info = this.#cncs.get(row.equipment);
    if (!info) throw new Error(`${row.equipment} is not a CNC of master data`);
    const topic = commandTopic(
      { area: info.area.id, workCenter: info.workCenter.id, equipment: info.id },
      'load-order',
    );
    const issuedAt = this.#now();
    const expiresAt = issuedAt + this.#timings.ttlMs;
    const seq = (this.#sequences.get(topic) ?? 0) + 1;
    this.#sequences.set(topic, seq);
    const message: LoadOrderCommand = loadOrderCommandSchema.parse({
      schema: 'uns.cmd.load-order/1',
      scope: 'topic',
      epoch: this.#mesEpoch,
      seq,
      source: { id: 'mes-server', protocol: 'internal' },
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      value: {
        commandId: row.command_id,
        orderId: row.order_id,
        operation: 'OP10',
        product: row.product,
        quantity: row.quantity,
        notBefore: row.not_before.toISOString(),
        deviceEpoch: row.device_epoch,
      },
    });
    // Read before the delivery exists: every fact stored by now was emitted before the command.
    const storedSeq = await this.#ingest.maxStoredSeq(row.equipment, row.device_epoch);
    const attempt = await this.#db.transaction().execute(async (trx) => {
      const last = await trx
        .selectFrom('orders.command_attempt')
        .select((eb) => eb.fn.max('attempt').as('attempt'))
        .where('command_id', '=', row.command_id)
        .executeTakeFirst();
      const number = (last?.attempt ?? 0) + 1;
      await trx
        .insertInto('orders.command_attempt')
        .values({
          command_id: row.command_id,
          attempt: number,
          issued_at: new Date(issuedAt),
          expires_at: new Date(expiresAt),
          mes_epoch: this.#mesEpoch,
          mes_seq: seq,
          stored_seq: storedSeq,
        })
        .execute();
      await trx
        .updateTable('orders.dispatch_command')
        .set({ state: 'sent', updated_at: sql<Date>`clock_timestamp()` })
        .where('command_id', '=', row.command_id)
        .where('state', '=', 'queued')
        .execute();
      return number;
    });
    await this.#options.beforePublish?.(row.command_id);
    try {
      await publisher.publish(topic, JSON.stringify(message));
    } catch (error) {
      // A reason code from the broker (PUBACK ≥ 0x80, e.g. 0x87 not authorised): the delivery is
      // refused for good, not lost on the way. The attempt stays unpublished (resent after
      // `resendMs`, capped); a person must look.
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (typeof code === 'number' && code >= 0x80) {
        await this.#db.transaction().execute(async (trx) => {
          await this.#incident(trx, {
            type: 'command-publish-refused',
            key: `command-publish-refused:${row.command_id}`,
            orderId: row.order_id,
            commandId: row.command_id,
            equipment: row.equipment,
            message: `${row.command_id}: the broker refused the delivery on ${topic} (reason code 0x${code.toString(16)}); check the ACL of the MES's user`,
          });
        });
      }
      throw error;
    }
    // Acknowledged by the broker: only now does the delivery count towards the attempts.
    await this.#db
      .updateTable('orders.command_attempt')
      .set({ published_at: new Date(this.#now()) })
      .where('command_id', '=', row.command_id)
      .where('attempt', '=', attempt)
      .execute();
    // The broker takes the command's deliveries again (the ACL was fixed): no refusal open.
    if (this.#openIncidents.has(`command-publish-refused:${row.command_id}`)) {
      await this.#db
        .transaction()
        .execute((trx) =>
          this.#closeIncidents(
            trx,
            { key: `command-publish-refused:${row.command_id}` },
            'published',
          ),
        );
    }
    this.#published?.inc();
    this.#log.info(
      { command: row.command_id, equipment: row.equipment, expiresAt: message.expiresAt },
      'command published',
    );
    await this.#emitAfter([], [row.command_id]);
  }

  // ---- internals ----

  async #loadMaster(): Promise<void> {
    const [equipment, routings] = await Promise.all([
      this.#options.masterData.equipment(),
      this.#options.masterData.routings(),
    ]);
    const first = routings[0]?.operations[0]?.operation ?? 'OP10';
    // The CNCs: the first operation's machines with an OPC UA interface (LoadOrder, ADR-0030).
    this.#cncs = new Map(
      equipment
        .filter((e) => e.operation === first && e.interface === 'opcua')
        .map((e) => [e.id, e]),
    );
    this.#routings = new Map(routings.map((r) => [r.product, r]));
  }

  /**
   * Runs a transaction whose incident keys count only once it committed (#174 review): opened and
   * closed keys are collected meanwhile, applied after, dropped when it throws.
   */
  async #deferringIncidents<T>(transaction: () => Promise<T>): Promise<T> {
    const pending = { opened: [] as string[], closed: [] as string[] };
    this.#pending = pending;
    try {
      const result = await transaction();
      for (const key of pending.opened) this.#openIncidents.add(key);
      for (const key of pending.closed) this.#openIncidents.delete(key);
      return result;
    } finally {
      this.#pending = undefined;
    }
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #lock(trx: Transaction<Database>, id: string): Promise<OrderRow> {
    const row = await trx
      .selectFrom('orders.production_order')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new OrderError('not-found', `no order ${id}`);
    return row;
  }

  /** A supervisor write: the order locked at `version`, the change, its audit, then the emit. */
  async #write(
    id: string,
    version: number,
    context: WriteContext,
    action: string,
    change: (
      trx: Transaction<Database>,
      row: OrderRow,
      plantAt: Date,
    ) => Promise<{
      set: Partial<{
        status: OrderStatus;
        released_at: Date;
        dispatched_at: Date;
        cancelled_at: Date;
        closed_at: Date;
        dispatch_failed: boolean;
        dispatch_lost: boolean;
      }>;
      command?: string;
      /** Commands whose reading changed on the way (told to listeners after the commit). */
      touched?: readonly string[];
      audit?: Record<string, unknown>;
    }>,
    /**
     * Runs first in the transaction, before the order row's lock (#201: the close guard's advisory
     * lock, the one lock order holds and closes share; plan review round 2, MEDIUM D).
     */
    first?: (trx: Transaction<Database>) => Promise<void>,
  ): Promise<{ order: OrderRecord; command: CommandRecord | undefined }> {
    if (!this.#started) throw new OrderError('conflict', 'the orders module is starting');
    const done = await this.#serial(() =>
      this.#deferringIncidents(() =>
        this.#db.transaction().execute(async (trx) => {
          if (first) await first(trx);
          const row = await this.#lock(trx, id);
          if (row.version !== version) {
            throw new OrderError(
              'conflict',
              `order ${id} changed: version is ${String(row.version)}, not ${String(version)}`,
              PROBLEM_TYPES.orderStale,
            );
          }
          const plantAt = this.#plantNow();
          const result = await change(trx, row, plantAt);
          const after = await trx
            .updateTable('orders.production_order')
            .set({
              ...result.set,
              version: row.version + 1,
              updated_at: sql<Date>`clock_timestamp()`,
            })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await Identity.audit(trx, {
            actor: auditActor(context.by),
            authenticated: isAuthenticated(context.by),
            action,
            entityType: AUDIT_ENTITY,
            entityId: id,
            before: { status: row.status, version: row.version },
            after: { status: after.status, version: after.version, ...result.audit },
            requestId: context.requestId,
            plantAt,
          });
          return { command: result.command, touched: result.touched ?? [] };
        }),
      ),
    );
    await this.#emitAfter([], done.touched);
    const order = await this.#emitOrder(id, 'updated');
    if (!order) throw new Error('unreachable: no order');
    const command =
      done.command === undefined
        ? undefined
        : (await this.commands({ commandIds: [done.command] }, this.#db))[0];
    if (command) this.#emit({ type: 'command', event: 'created', command });
    return { order, command };
  }

  /** A new command row for the order (the outbox), on the named CNC or the rule's choice. */
  async #newCommand(
    trx: Transaction<Database>,
    order: OrderRow,
    n: number,
    quantity: number,
    named: string | undefined,
  ): Promise<CommandRow> {
    if (this.#cncs.size === 0) await this.#loadMaster();
    if (named !== undefined && !this.#cncs.has(named)) {
      throw new OrderError(
        'invalid',
        `${named} is not a CNC (one of ${[...this.#cncs.keys()].join(', ')})`,
      );
    }
    const epochs = await this.#ingest.newestDeviceEpochs();
    const equipment = named ?? (await this.#choose(trx, order, quantity, epochs));
    const deviceEpoch = epochs.get(equipment);
    if (deviceEpoch === undefined) {
      throw new OrderError(
        'invalid',
        `no device run of ${equipment} is known yet (no fact or snapshot): its device epoch is needed`,
      );
    }
    return trx
      .insertInto('orders.dispatch_command')
      .values({
        command_id: loadOrderCommandId(order.id, n),
        order_id: order.id,
        n,
        equipment,
        product: order.product,
        quantity,
        not_before: order.planned_start,
        device_epoch: deviceEpoch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The dispatch rule over the CNCs' current queues (`dispatch-rule.ts`). */
  async #choose(
    trx: Transaction<Database>,
    order: OrderRow,
    quantity: number,
    epochs: ReadonlyMap<string, number>,
  ): Promise<string> {
    const routing = this.#routings.get(order.product);
    const times: ProductTimes = {
      idealMs: (product) => this.#routings.get(product)?.operations[0]?.idealCycleMs ?? 0,
      changeoverMs: (product) => this.#routings.get(product)?.changeoverMs ?? 0,
    };
    if (!routing) throw new OrderError('invalid', `no routing for ${order.product}`);
    const candidates = [...this.#cncs.keys()].filter((id) => epochs.has(id));
    if (candidates.length === 0) {
      throw new OrderError('invalid', 'no CNC has a known device run yet (no fact or snapshot)');
    }
    const rows = await trx
      .selectFrom('orders.dispatch_command')
      .select(['equipment', 'product', 'quantity', 'not_before', 'job', 'settled', 'device_epoch'])
      .where('equipment', 'in', candidates)
      .orderBy('queue_position')
      .execute();
    const queues: CncQueue[] = candidates.map((equipment) => {
      const mine = rows.filter(
        (r) => r.equipment === equipment && r.device_epoch === epochs.get(equipment),
      );
      // A job finished or lost, or a command settled without one, is out of the queue; the last
      // finished job's product is what is loaded before the rest.
      const open = mine.filter(
        (r) => !(r.job === 'completed' || r.job === 'lost' || (r.settled && r.job === null)),
      );
      const done = mine.filter((r) => r.job === 'completed');
      return {
        equipment,
        loaded: done.at(-1)?.product,
        jobs: open.map((r) => ({
          product: r.product,
          quantity: r.quantity,
          notBefore: r.not_before.getTime(),
        })),
      };
    });
    const choice = chooseCnc(
      queues,
      { product: order.product, quantity, notBefore: order.planned_start.getTime() },
      times,
      this.#options.clock?.()?.getTime(),
    );
    if (choice === undefined) throw new OrderError('invalid', 'no CNC to dispatch to');
    return choice;
  }

  /** One feed entry, in the page's transaction; what happened to the order, if anything. */
  async #importEntry(
    trx: Transaction<Database>,
    entry: FeedEntry,
    feedId: string,
  ): Promise<'imported' | 'updated' | undefined> {
    const erp = entry.order;
    const existing = await trx
      .selectFrom('orders.production_order')
      .selectAll()
      .where('id', '=', erp.orderNumber)
      .forUpdate()
      .executeTakeFirst();
    const log = async (status: ErpMessageLogTable['status'], detail: string | null) => {
      await trx
        .insertInto('orders.erp_message_log')
        .values({
          direction: 'in',
          kind: 'feed-entry',
          order_id: erp.orderNumber,
          revision: erp.revision,
          idempotency_key: null,
          feed_id: feedId,
          feed_seq: entry.feedSeq,
          payload: JSON.stringify(entry),
          status,
          detail,
          receipt: null,
        })
        .execute();
    };
    const plantAt = this.#plantNow();
    if (existing && erp.revision <= existing.revision) {
      await log(
        'unchanged',
        `revision ${String(erp.revision)} already held (${String(existing.revision)})`,
      );
      return undefined;
    }
    if (existing && !['imported', 'rejected'].includes(existing.status)) {
      const detail = `revision ${String(erp.revision)} after the order was ${existing.status} (revision ${String(existing.revision)} kept)`;
      await log('revision-refused', detail);
      await this.#statusMessage(
        trx,
        { id: erp.orderNumber, revision: erp.revision },
        'rejected-revision',
        plantAt,
        { reason: detail },
      );
      this.#log.warn(
        { order: erp.orderNumber, revision: erp.revision },
        'ERP revision after release refused',
      );
      return undefined;
    }
    const cancelled = erp.status === 'cancelled';
    const rejection = cancelled
      ? undefined
      : validateErpOrder(erp, this.#routings.get(erp.product));
    const status: OrderStatus = cancelled ? 'cancelled' : rejection ? 'rejected' : 'imported';
    const values = {
      revision: erp.revision,
      feed_seq: entry.feedSeq,
      product: erp.product,
      quantity: erp.quantity,
      priority: erp.priority,
      planned_start: erp.plannedStart,
      due_date: erp.dueDate,
      erp_status: erp.status,
      status,
      rejection: rejection ?? null,
      routing: JSON.stringify(erp.routing),
      bom: JSON.stringify(erp.bom),
      cancelled_at: cancelled ? plantAt : null,
    };
    if (existing) {
      await trx
        .updateTable('orders.production_order')
        .set({ ...values, version: existing.version + 1, updated_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', erp.orderNumber)
        .execute();
      await trx
        .deleteFrom('orders.order_operation')
        .where('order_id', '=', erp.orderNumber)
        .execute();
    } else {
      await trx
        .insertInto('orders.production_order')
        .values({ id: erp.orderNumber, ...values })
        .execute();
    }
    // Operations only for an order the MES will run (a refused routing may not even be one).
    if (status === 'imported' && erp.routing.length > 0) {
      await trx
        .insertInto('orders.order_operation')
        .values(
          erp.routing.map((step, position) => ({
            order_id: erp.orderNumber,
            operation: step.operation,
            position,
            work_center: step.workCenter,
          })),
        )
        .execute();
    }
    await log(cancelled ? 'cancelled' : rejection ? 'rejected' : 'imported', rejection ?? null);
    await this.#statusMessage(
      trx,
      { id: erp.orderNumber, revision: erp.revision },
      cancelled ? 'cancelled' : rejection ? 'rejected' : 'accepted',
      plantAt,
      rejection ? { reason: rejection } : {},
    );
    await Identity.audit(trx, {
      actor: { system: 'erp-import' },
      authenticated: false,
      action: existing ? 'order.revise' : 'order.import',
      entityType: AUDIT_ENTITY,
      entityId: erp.orderNumber,
      before: existing ? { status: existing.status, revision: existing.revision } : undefined,
      after: {
        status,
        revision: erp.revision,
        feedId,
        feedSeq: entry.feedSeq,
        ...(rejection ? { rejection } : {}),
      },
      plantAt,
    });
    return existing ? 'updated' : 'imported';
  }

  /**
   * A feed entry the database refused (#174 review): recorded as rejected where it can be (the
   * order row if none exists yet, the inbound log and a `rejected` status message, each under a
   * savepoint of its own), with an `erp-invalid-entry` incident; the page then commits.
   */
  async #invalidEntry(
    trx: Transaction<Database>,
    entry: FeedEntry,
    feedId: string,
    error: unknown,
    deferred: string[],
  ): Promise<'imported' | undefined> {
    const erp = entry.order;
    const reason = `the entry could not be stored: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
    const attempt = async (work: () => Promise<unknown>): Promise<boolean> => {
      await sql`SAVEPOINT erp_invalid`.execute(trx);
      try {
        await work();
        await sql`RELEASE SAVEPOINT erp_invalid`.execute(trx);
        return true;
      } catch {
        await sql`ROLLBACK TO SAVEPOINT erp_invalid`.execute(trx);
        return false;
      }
    };
    const stored = await attempt(async () => {
      const row = await trx
        .insertInto('orders.production_order')
        .values({
          id: erp.orderNumber,
          revision: erp.revision,
          feed_seq: entry.feedSeq,
          product: erp.product,
          quantity: erp.quantity,
          priority: erp.priority,
          planned_start: erp.plannedStart,
          due_date: erp.dueDate,
          erp_status: erp.status,
          status: 'rejected',
          rejection: reason,
          routing: JSON.stringify(erp.routing),
          bom: JSON.stringify(erp.bom),
        })
        .onConflict((c) => c.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();
      return row;
    });
    await attempt(async () => {
      await trx
        .insertInto('orders.erp_message_log')
        .values({
          direction: 'in',
          kind: 'feed-entry',
          order_id: erp.orderNumber,
          revision: erp.revision,
          idempotency_key: null,
          feed_id: feedId,
          feed_seq: entry.feedSeq,
          payload: JSON.stringify(entry),
          status: 'rejected',
          detail: reason,
          receipt: null,
        })
        .execute();
      await this.#statusMessage(
        trx,
        { id: erp.orderNumber, revision: erp.revision },
        'rejected',
        this.#plantNow(),
        { reason },
      );
    });
    await this.#incident(trx, {
      type: 'erp-invalid-entry',
      key: `erp-invalid-entry:${feedId}:${String(entry.feedSeq)}`,
      deferred,
      orderId: null,
      message: `ERP feed entry ${String(entry.feedSeq)} (${erp.orderNumber} revision ${String(erp.revision)}) recorded as rejected: ${reason}`,
    });
    return stored ? 'imported' : undefined;
  }

  async #cursor(): Promise<{ feedId: string | null; cursor: number }> {
    const row = await this.#db
      .selectFrom('orders.erp_cursor')
      .selectAll()
      .where('id', '=', 'erp')
      .executeTakeFirst();
    return { feedId: row?.feed_id ?? null, cursor: row?.cursor ?? 0 };
  }

  /** The feed changed (ADR-0028): an `erp-feed-changed` incident and the cursor back to 0. */
  async #resetCursor(
    from: { feedId: string | null; cursor: number },
    feedId: string | null,
    message: string,
  ): Promise<void> {
    await this.#serial(() =>
      this.#db.transaction().execute(async (trx) => {
        await trx
          .insertInto('orders.erp_cursor')
          .values({ id: 'erp', feed_id: feedId, cursor: 0 })
          .onConflict((c) =>
            c.column('id').doUpdateSet({
              feed_id: feedId,
              cursor: 0,
              updated_at: sql<Date>`clock_timestamp()`,
            }),
          )
          .execute();
        await this.#incident(trx, {
          type: 'erp-feed-changed',
          key: `erp-feed-changed:${from.feedId ?? 'none'}:${String(from.cursor)}:${feedId ?? 'none'}:${String(this.#now())}`,
          orderId: null,
          message: `${message}: cursor reset from ${String(from.cursor)} to 0 (imports are idempotent by order and revision)`,
          close: 'cursor-reset',
        });
      }),
    );
    this.#log.warn({ from: from.cursor, feedId }, 'ERP feed changed: cursor reset to 0');
  }

  /** A status message for the ERP (outbox; once per order, revision and status: its key). */
  async #statusMessage(
    trx: Transaction<Database>,
    order: { readonly id: string; readonly revision: number },
    status: OrderStatusMessage,
    at: Date,
    extra: { readonly short?: boolean; readonly reason?: string } = {},
  ): Promise<void> {
    const body: StatusMessageRequest = {
      orderNumber: order.id,
      revision: order.revision,
      status,
      ...(extra.short === undefined ? {} : { short: extra.short }),
      ...(extra.reason === undefined ? {} : { reason: extra.reason.slice(0, 500) }),
      sentAt: at.toISOString(),
    };
    await trx
      .insertInto('orders.erp_message_log')
      .values({
        direction: 'out',
        kind: 'status',
        order_id: order.id,
        revision: order.revision,
        idempotency_key: statusKey(order.id, order.revision, status),
        feed_id: null,
        feed_seq: null,
        payload: JSON.stringify(body),
        status: 'pending',
        detail: null,
        receipt: null,
      })
      .onConflict((c) => c.column('idempotency_key').doNothing())
      .execute();
  }

  async #incident(
    trx: Transaction<Database>,
    incident: {
      readonly type: OrderIncidentType;
      readonly key: string;
      readonly orderId: string | null;
      readonly commandId?: string;
      readonly equipment?: string;
      readonly message: string;
      /** Recorded closed at once, with this resolution (an event, nothing to resolve). */
      readonly close?: string;
      /**
       * Keys of open incidents are remembered only after the caller's commit: they go here and the
       * caller adds them then (a page that rolls back leaves no key behind).
       */
      readonly deferred?: string[];
    },
  ): Promise<void> {
    const row = await trx
      .insertInto('orders.order_incident')
      .values({
        type: incident.type,
        key: incident.key,
        order_id: incident.orderId,
        command_id: incident.commandId ?? null,
        equipment: incident.equipment ?? null,
        message: incident.message,
        closed_at: incident.close === undefined ? null : sql<Date>`clock_timestamp()`,
        resolution: incident.close ?? null,
      })
      .onConflict((c) => c.column('key').where('closed_at', 'is', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) return;
    if (incident.close === undefined) {
      if (incident.deferred) incident.deferred.push(incident.key);
      else if (this.#pending) this.#pending.opened.push(incident.key);
      else this.#openIncidents.add(incident.key);
    }
    this.#incidentCounter?.inc({ type: incident.type });
    this.#log.warn({ incident: incident.type, key: incident.key }, incident.message);
  }

  async #closeIncidents(
    trx: Transaction<Database>,
    which: {
      readonly key?: string;
      readonly orderId?: string;
      readonly commandId?: string;
      readonly type?: OrderIncidentType;
    },
    resolution: string,
  ): Promise<void> {
    let update = trx
      .updateTable('orders.order_incident')
      .set({ closed_at: sql<Date>`clock_timestamp()`, resolution })
      .where('closed_at', 'is', null);
    if (which.key !== undefined) update = update.where('key', '=', which.key);
    if (which.orderId !== undefined) update = update.where('order_id', '=', which.orderId);
    if (which.type !== undefined) update = update.where('type', '=', which.type);
    if (which.commandId !== undefined) update = update.where('command_id', '=', which.commandId);
    const closed = await update.returning('key').execute();
    for (const row of closed) {
      if (this.#pending) this.#pending.closed.push(row.key);
      else this.#openIncidents.delete(row.key);
    }
  }

  #plantNow(): Date {
    return this.#options.clock?.() ?? new Date(this.#now());
  }

  async #records(db: Kysely<Database>, rows: readonly OrderRow[]): Promise<OrderRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [commands, operations] = await Promise.all([
      db
        .selectFrom('orders.dispatch_command')
        .select(['order_id', 'quantity', 'job', 'lost_started', 'settled', 'state', 'rejection'])
        .where('order_id', 'in', ids)
        .execute(),
      db
        .selectFrom('orders.order_operation')
        .selectAll()
        .where('order_id', 'in', ids)
        .orderBy('order_id')
        .orderBy('position')
        .execute(),
    ]);
    return rows.map((row) => {
      const mine = commands.filter((c) => c.order_id === row.id);
      return {
        id: row.id,
        revision: row.revision,
        product: row.product,
        quantity: row.quantity,
        priority: row.priority,
        plannedStart: row.planned_start,
        dueDate: row.due_date,
        erpStatus: row.erp_status,
        status: row.status,
        short: row.short,
        dispatchFailed: row.dispatch_failed,
        dispatchLost: row.dispatch_lost,
        rejection: row.rejection,
        dispatched: mine.reduce((sum, c) => sum + countedBlanks(c), 0),
        inFlight: mine
          .filter((c) => !c.settled && c.job === null)
          .reduce((sum, c) => sum + c.quantity, 0),
        version: row.version,
        importedAt: row.imported_at,
        updatedAt: row.updated_at,
        releasedAt: row.released_at,
        dispatchedAt: row.dispatched_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        closedAt: row.closed_at,
        cancelledAt: row.cancelled_at,
        routing: operations
          .filter((op) => op.order_id === row.id)
          .map((op) => ({ operation: op.operation, workCenter: op.work_center })),
        bom: row.bom,
      };
    });
  }

  async #emitOrder(id: string, event: 'imported' | 'updated'): Promise<OrderRecord | undefined> {
    const row = await this.#db
      .selectFrom('orders.production_order')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    const [order] = await this.#records(this.#db, [row]);
    if (order) this.#emit({ type: 'order', event, order });
    return order;
  }

  async #emitAfter(orderIds: readonly string[], commandIds: readonly string[]): Promise<void> {
    for (const command of await this.commands({ commandIds }, this.#db)) {
      this.#emit({ type: 'command', event: 'updated', command });
    }
    for (const id of orderIds) await this.#emitOrder(id, 'updated');
  }

  #emit(change: OrderChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error({ err: error }, 'orders listener failed');
      }
    }
  }
}

function expectStatus(row: OrderRow, allowed: readonly OrderStatus[], write: string): void {
  if (!allowed.includes(row.status)) {
    throw new OrderError(
      'conflict',
      `order ${row.id} is ${row.status}: ${write} needs ${allowed.join(' or ')}`,
      PROBLEM_TYPES.orderState,
    );
  }
}

/** Blanks a command counts against its order: an accepted job's, a lost one's started blanks. */
function countedBlanks(command: {
  readonly job: JobState | null;
  readonly quantity: number;
  readonly lost_started: number | null;
  readonly state: CommandState;
  readonly rejection: string | null;
}): number {
  // A job under its id that isn't its own (command-conflict), or a command written off without
  // knowing: its quantity counts, so the order can end short but never over.
  if (command.state === 'abandoned' || command.rejection === 'command-conflict') {
    return command.quantity;
  }
  if (command.job === null) return 0;
  if (command.job === 'lost') return command.lost_started ?? command.quantity;
  return command.quantity;
}

function commandAudit(command: CommandRow): Record<string, unknown> {
  return {
    commandId: command.command_id,
    equipment: command.equipment,
    quantity: command.quantity,
    notBefore: command.not_before.toISOString(),
    deviceEpoch: command.device_epoch,
  };
}

function toCommand(
  row: CommandRow,
  attempts: readonly {
    attempt: number;
    issued_at: Date;
    expires_at: Date;
    published_at: Date | null;
  }[],
): CommandRecord {
  return {
    commandId: row.command_id,
    orderId: row.order_id,
    n: row.n,
    equipment: row.equipment,
    product: row.product,
    quantity: row.quantity,
    notBefore: row.not_before,
    deviceEpoch: row.device_epoch,
    queuePosition: row.queue_position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
    settled: row.settled,
    failed: row.failed,
    confirmed: row.confirmed,
    acceptedBy: row.accepted_by,
    acceptedSeq: row.accepted_seq,
    acceptedAt: row.accepted_at,
    rejection: row.rejection,
    seqAfterExpiry: row.seq_after_expiry,
    job: row.job,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lostStarted: row.lost_started,
    attempts: attempts.map((a) => ({
      attempt: a.attempt,
      issuedAt: a.issued_at,
      expiresAt: a.expires_at,
      publishedAt: a.published_at,
    })),
  };
}

type Counts = Readonly<Record<string, number>>;

/** Signed per-key difference of two count maps, zero entries dropped. */
function diffCounts(a: Counts, b: Counts): Record<string, number> {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: Record<string, number> = {};
  for (const key of keys) {
    const value = (a[key] ?? 0) - (b[key] ?? 0);
    if (value !== 0) out[key] = value;
  }
  return out;
}

/** What the totals add to what was confirmed: the correction's deltas. */
function difference(
  totals: OperationConfirmation,
  confirmed: OperationConfirmation,
): OperationConfirmation {
  return {
    yield: totals.yield - confirmed.yield,
    scrap: diffCounts(totals.scrap, confirmed.scrap),
    reworkPasses: totals.reworkPasses - confirmed.reworkPasses,
    material: diffCounts(totals.material, confirmed.material),
  };
}

const isZero = (delta: OperationConfirmation): boolean =>
  delta.yield === 0 &&
  delta.reworkPasses === 0 &&
  Object.values(delta.scrap).every((v) => v === 0) &&
  Object.values(delta.material).every((v) => v === 0);

/** Count lines by key, zero ones dropped (a final confirmation lists only what happened). */
const lines = (counts: Counts): [string, number][] =>
  Object.entries(counts)
    .filter(([, n]) => n !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const canonicalTotals = (totals: OperationConfirmation): OperationConfirmation => ({
  yield: totals.yield,
  scrap: Object.fromEntries(lines(totals.scrap)),
  reworkPasses: totals.reworkPasses,
  material: Object.fromEntries(lines(totals.material)),
});

function toConfirmation(
  row: Selectable<ConfirmationTable>,
  messageStatus: string,
): ConfirmationRecord {
  return {
    orderId: row.order_id,
    operation: row.operation,
    n: row.n,
    kind: row.kind,
    revision: row.revision,
    yield: row.yield,
    scrap: row.scrap as Counts,
    reworkPasses: row.rework_passes,
    material: row.material as Counts,
    totals: row.totals as OperationConfirmation,
    confirmedAt: row.confirmed_at,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    messageStatus,
  };
}

function toMessage(row: Selectable<ErpMessageLogTable>): ErpMessageRecord {
  return {
    id: row.id,
    direction: row.direction,
    kind: row.kind,
    orderId: row.order_id,
    revision: row.revision,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    detail: row.detail,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: row.payload,
    subject:
      row.subject_kind === null || row.subject_id === null
        ? null
        : { kind: row.subject_kind, id: row.subject_id },
  };
}

function toIncident(row: Selectable<OrderIncidentTable>): OrderIncident {
  return {
    id: row.id,
    type: row.type,
    orderId: row.order_id,
    commandId: row.command_id,
    equipment: row.equipment,
    message: row.message,
    detectedAt: row.detected_at,
    closedAt: row.closed_at,
    resolution: row.resolution,
  };
}
