import { randomUUID } from 'node:crypto';
import {
  qualityNotificationKey,
  type QualityHoldTransition,
  type QualityNotificationInput,
} from '@shopfloor/contracts/erp-api';
import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import type { HoldReason } from '@shopfloor/plant-config';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { Counter, Histogram, type Registry } from 'prom-client';
import type { Database } from '../../db/database.ts';
import { DERIVED_WORK_BUCKETS } from '../../metrics.ts';
import { Identity, auditActor, isAuthenticated, nameOf } from '../identity/index.ts';
import { QualityError, type QualityWriteContext, type SignalWindow } from './quality.ts';
import type {
  HoldIncidentTable,
  HoldState,
  HoldSubjectKind,
  HoldTable,
  HoldTransitionKind,
  HoldUnitTable,
  StoredScope,
} from './tables.ts';

/**
 * The one transaction-level advisory lock that opening a hold and closing an order serialize on
 * (#201, plan "Quality holds", review round 1 HIGH 1): taken first in both transactions. An
 * arbitrary constant, apart from the migration runner's (7_004_001).
 */
export const HOLD_CLOSE_LOCK = 8_201_001;

/** A unit as the genealogy answers it (`UnitRef`). */
export interface HoldScopeUnit {
  readonly epoch: number;
  readonly partId: number;
  readonly serial: string | null;
  readonly orderId: string | null;
  readonly carton: string | null;
}

export interface HoldSubject {
  readonly kind: HoldSubjectKind;
  readonly id: string;
}

/** A consumption of a lot by a unit's cycle, as the genealogy answers it. */
export interface LotConsumptionRef {
  readonly epoch: number;
  readonly partId: number;
  readonly equipment: string;
  readonly seq: number;
  readonly operation: string;
  readonly pass: number;
  readonly at: Date;
}

/**
 * A lot's scope and consumptions, as the genealogy reads them for every held lot at once, with
 * what its next read reuses (`blocks`, the genealogy's).
 */
export interface LotRead {
  readonly scope: readonly HoldScopeUnit[];
  readonly consumptions: readonly LotConsumptionRef[];
  readonly blocks: ReadonlyMap<string, unknown>;
}

/** What the holds read of the genealogy module (#199): scope, consumptions and its watermark. */
export interface HoldsGenealogy {
  scope(
    subject: HoldSubject,
    options?: { readonly orderId?: string; readonly db?: Kysely<Database> },
  ): Promise<HoldScopeUnit[]>;
  /** Many subjects' scopes at once, one list per subject in their order (#238). */
  scopes(
    subjects: readonly HoldSubject[],
    db?: Kysely<Database>,
  ): Promise<readonly (readonly HoldScopeUnit[])[]>;
  /**
   * Many lots' scopes (as `scopes`) and consumptions (each in plant-time order) at once, by lot, in
   * one read of their links; with `previous` (its last answer), only the links that changed are
   * sent, and a lot with none changed is answered with the very object of `previous` (#238, #399).
   */
  lotsScopesAndConsumptions(
    lots: readonly string[],
    options?: { readonly db?: Kysely<Database>; readonly previous?: ReadonlyMap<string, LotRead> },
  ): Promise<ReadonlyMap<string, LotRead>>;
  /** Called after a genealogy round that changed units or cartons (#238: the scopes follow it). */
  onChange(listener: () => void): () => void;
  units(keys: readonly { epoch: number; partId: number }[]): Promise<HoldScopeUnit[]>;
  covers(
    facts: readonly { readonly equipment: string; readonly epoch: number; readonly seq: number }[],
  ): boolean;
  /** The facts genealogy has no record of for their unit (review of PR #222, H1). */
  unrecorded<
    F extends {
      readonly equipment: string;
      readonly epoch: number;
      readonly seq: number;
      readonly partId: number;
    },
  >(
    facts: readonly F[],
    db?: Kysely<Database>,
  ): Promise<F[]>;
  finalityAt(at: Date, epochs: readonly number[]): { final: boolean; notFinal: readonly string[] };
  lots(): Promise<readonly { readonly id: string }[]>;
  carton(id: string): Promise<unknown>;
}

/**
 * What the close guard reads of ingest: the cycle facts of the order's units (ADR-0034), and the
 * job facts and cycle facts of its jobs on their CNCs (a unit execution has not built yet).
 */
export interface HoldsIngest {
  cycleFacts(
    options: {
      readonly epoch: number;
      readonly partIds?: readonly number[];
      readonly equipment?: string;
      readonly afterSeq?: number;
      readonly beforeSeq?: number;
    },
    db?: Kysely<Database>,
  ): Promise<
    readonly {
      readonly equipment: string;
      readonly epoch: number;
      readonly seq: number;
      readonly partId: number;
    }[]
  >;
  jobFacts(
    options: { readonly equipment?: string; readonly epoch?: number },
    db?: Kysely<Database>,
  ): Promise<
    readonly {
      readonly equipment: string;
      readonly epoch: number;
      readonly seq: number;
      readonly transition: string;
      readonly commandId: string;
    }[]
  >;
}

/** What the holds use of the orders module: its ERP outbox and its orders. */
export interface HoldsOrders {
  enqueueErpMessage(
    trx: Transaction<Database>,
    message: {
      readonly kind: 'quality-notification';
      readonly idempotencyKey: string;
      readonly subject: { readonly kind: 'hold'; readonly id: string };
      readonly payload: unknown;
    },
  ): Promise<void>;
  erpMessagesOf(subject: { readonly kind: 'hold'; readonly id: string }): Promise<
    readonly {
      readonly idempotencyKey: string | null;
      readonly status: string;
      readonly attempts: number;
      readonly lastError: string | null;
    }[]
  >;
  order(id: string): Promise<unknown>;
  /** The order's dispatch commands: where its jobs ran (the guard's unbuilt units). */
  commands(
    filter: { readonly orderId?: string },
    db?: Kysely<Database>,
  ): Promise<
    readonly {
      readonly commandId: string;
      readonly equipment: string;
      readonly deviceEpoch: number;
    }[]
  >;
}

export interface HoldsLog {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface HoldsOptions {
  readonly db: Kysely<Database>;
  /** The API's pool for reads (default `db`). */
  readonly readDb?: Kysely<Database>;
  readonly genealogy: HoldsGenealogy;
  readonly ingest: HoldsIngest;
  /** The units an order has in the execution module (`Execution.orderUnits`). */
  readonly execution: {
    orderUnits(
      orderId: string,
      db?: Kysely<Database>,
    ): Promise<readonly { readonly epoch: number; readonly partId: number }[]>;
  };
  readonly orders: HoldsOrders;
  /** The reasons of `quality.yaml` (`holdReasons`). */
  readonly reasons: readonly HoldReason[];
  /** The SPC module's window of a signal (the suggested scope), if any. */
  readonly signals?: { signalWindow(id: number): Promise<SignalWindow | undefined> };
  /** The plant clock (the newest epoch's watermark): `opened_plant_at`, decisions, notifications. */
  readonly clock?: () => Date | undefined;
  /** The newest device epoch, the plant clock's (`opened_epoch`, `decided_epoch`). */
  readonly epoch?: () => number | undefined;
  /** Wall clock, ms (tests move it). */
  readonly now?: () => number;
  /**
   * Whether the scopes are rebuilt on change (#238; default true): after a genealogy round that
   * changed units or cartons (`HoldsGenealogy.onChange`) and after a hold opens or is decided.
   * False: only `tick()` (tests that drive the rounds by hand).
   */
  readonly follow?: boolean;
  readonly registry?: Registry;
  readonly log?: HoldsLog;
  /**
   * Called with the raw timing of every scope rebuild (`mes_quality_hold_scope_seconds`, #238:
   * the budget tests compute their percentiles from these), with the holds it covered.
   */
  readonly onTiming?: (timing: {
    readonly metric: 'hold-scope';
    readonly seconds: number;
    readonly holds: number;
  }) => void;
  /** Test seam: runs last in an opening's transaction, before its COMMIT (the lock race tests). */
  readonly beforeCommit?: (trx: Transaction<Database>, holdId: string) => Promise<void>;
}

/** A hold as the module reports it. */
export interface HoldRecord {
  readonly id: string;
  readonly subject: HoldSubject;
  readonly state: HoldState;
  readonly reason: string;
  readonly openedBy: string;
  readonly openedAt: Date;
  readonly openedPlantAt: Date | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decidedPlantAt: Date | null;
  readonly decisionReason: string | null;
  readonly transitions: number;
  readonly version: number;
  /** The scope as last derived (`hold_unit`). */
  readonly scope: { readonly units: number; readonly cartons: number; readonly orders: number };
  readonly heldMaterialConsumed: number;
}

export interface HoldTransitionRecord {
  readonly n: number;
  readonly kind: HoldTransitionKind;
  readonly reason: string | null;
  readonly comment: string | null;
  readonly by: string;
  readonly at: Date;
  readonly plantAt: Date | null;
  readonly scope: StoredScope | null;
  readonly notification: {
    readonly idempotencyKey: string;
    readonly status: string;
    readonly attempts: number;
    readonly lastError: string | null;
  } | null;
}

export interface HoldIncidentRecord {
  readonly id: number;
  readonly type: 'held-material-consumed';
  readonly lot: string;
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  readonly partId: number;
  readonly operation: string | null;
  readonly pass: number | null;
  readonly consumedAt: Date;
  readonly message: string;
  readonly detectedAt: Date;
}

export interface HoldDetail {
  readonly hold: HoldRecord;
  readonly transitions: readonly HoldTransitionRecord[];
  readonly units: readonly (HoldScopeUnit & { readonly joinedAt: Date })[];
  readonly unitsTruncated: boolean;
  readonly orders: readonly string[];
  readonly cartons: readonly string[];
  readonly incidents: readonly HoldIncidentRecord[];
}

/** A hold as a trace answer names it (#201: the trace pages show the holds on any node). */
export interface HoldRef {
  readonly id: string;
  readonly state: HoldState;
  readonly subject: HoldSubject;
}

/** The units of a signal's window with their orders and cartons (a suggested hold scope). */
export interface HoldSuggestion {
  readonly window: SignalWindow;
  readonly units: readonly HoldScopeUnit[];
  readonly orders: readonly string[];
  readonly cartons: readonly string[];
}

export interface HoldChange {
  readonly type: 'hold';
  readonly event: 'opened' | 'commented' | 'released' | 'rejected' | 'scope';
  readonly hold: HoldRecord;
}

export const HOLD_AUDIT_ENTITY = 'quality_hold';
/** Units a hold's detail lists at most. */
const UNIT_LIMIT = 5_000;
const CHUNK = 5_000;
/** Rows one insert of scope copy units or incidents carries at most. */
const INSERT_CHUNK = 1_000;

const silent: HoldsLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const unitKey = (u: { epoch: number; partId: number }) => `${String(u.epoch)}/${String(u.partId)}`;
/** A consumption's fact, as a hold's `held-material-consumed` incidents name it. */
const consumedKey = (c: { equipment: string; epoch: number; seq: number }): string =>
  `${c.equipment}/${String(c.epoch)}/${String(c.seq)}`;

/** What brings a hold's scope copy in line with its scope. */
/** A unit of a hold's stored scope copy, as the rebuild compares it. */
type CopyUnit = Pick<
  Selectable<HoldUnitTable>,
  'epoch' | 'part_id' | 'serial' | 'order_id' | 'carton_id'
>;

interface UnitPlan {
  readonly gone: readonly CopyUnit[];
  readonly added: readonly HoldScopeUnit[];
  /** Units whose serial, order or carton changed. */
  readonly moved: readonly HoldScopeUnit[];
}

const copyOf = (u: HoldScopeUnit): CopyUnit => ({
  epoch: u.epoch,
  part_id: u.partId,
  serial: u.serial,
  order_id: u.orderId,
  carton_id: u.carton,
});

/** `stored` by `unitKey`, as the rebuild keeps the copies in memory. */
function planUnits(
  stored: ReadonlyMap<string, CopyUnit>,
  scope: readonly HoldScopeUnit[],
): UnitPlan {
  const added: HoldScopeUnit[] = [];
  const moved: HoldScopeUnit[] = [];
  // The scope lists each unit once (genealogy's DISTINCT), so `kept` counts stored units in it.
  const keys = new Set<string>();
  let kept = 0;
  for (const unit of scope) {
    const key = unitKey(unit);
    if (keys.has(key)) continue;
    keys.add(key);
    const before = stored.get(key);
    if (before) kept += 1;
    if (!before) added.push(unit);
    else if (
      before.serial !== unit.serial ||
      before.order_id !== unit.orderId ||
      before.carton_id !== unit.carton
    ) {
      moved.push(unit);
    }
  }
  const gone: CopyUnit[] = [];
  if (kept < stored.size) for (const [key, unit] of stored) if (!keys.has(key)) gone.push(unit);
  return { gone, added, moved };
}

/**
 * A lot hold's consumptions after its opening (and before its release, for a released one) that
 * its incidents don't name yet.
 */
function lateConsumptions(
  hold: Selectable<HoldTable>,
  consumptions: readonly LotConsumptionRef[],
  known: ReadonlySet<string>,
): LotConsumptionRef[] {
  // Positions (epoch, plant time): within the hold's epoch by time, a newer epoch is later and an
  // older one earlier (review of PR #222, L1); without an epoch, by time alone.
  const position = (epoch: number | null, at: Date | null, fallback: number) => ({
    epoch,
    at: at?.getTime() ?? fallback,
  });
  const opened = position(hold.opened_epoch, hold.opened_plant_at, Number.NEGATIVE_INFINITY);
  const decided =
    hold.state === 'released'
      ? position(hold.decided_epoch, hold.decided_plant_at, Number.NEGATIVE_INFINITY)
      : { epoch: null, at: Number.POSITIVE_INFINITY };
  const later = (
    c: { epoch: number; at: Date },
    than: { epoch: number | null; at: number },
  ): boolean =>
    than.epoch === null || c.epoch === than.epoch ? c.at.getTime() > than.at : c.epoch > than.epoch;
  const earlier = (
    c: { epoch: number; at: Date },
    than: { epoch: number | null; at: number },
  ): boolean =>
    than.epoch === null || c.epoch === than.epoch ? c.at.getTime() < than.at : c.epoch < than.epoch;
  return consumptions.filter(
    (c) => later(c, opened) && earlier(c, decided) && !known.has(consumedKey(c)),
  );
}

/**
 * Quality holds (#201, Phase 8 plan "Quality holds", ADR-0035): a hold on a lot, a serial, a carton
 * or an order, whose scope is derived through the genealogy and grows with facts; opened (and
 * commented) with `quality:hold`, released or rejected with `quality:release`; every transition
 * appended to `quality.hold_transition`, audited, and (but a comment) notified to the ERP through
 * the orders module's outbox in the same transaction; `held-material-consumed` when a held lot is
 * consumed after the opening; and the orders module's close guard: one advisory lock with hold
 * opening, genealogy's watermark over the order's facts, and the scope derived at check time.
 */
export class Holds {
  readonly #db: Kysely<Database>;
  readonly #readDb: Kysely<Database>;
  readonly #options: HoldsOptions;
  readonly #log: HoldsLog;
  readonly #listeners = new Set<(change: HoldChange) => void>();
  readonly #transitions: Counter<'kind'> | undefined;
  readonly #consumed: Counter | undefined;
  readonly #scopeSeconds: Histogram | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  /** A rebuild is scheduled (a change was heard of). */
  #kick: NodeJS.Timeout | undefined;
  /** A change was heard of since the last rebuild started. */
  #due = false;
  #unsubscribe: (() => void) | undefined;
  /** The scope copies (`hold_unit`) as last read or written, by hold. */
  readonly #copies = new Map<string, Map<string, CopyUnit>>();
  /**
   * The facts (`equipment/epoch/seq`) of each lot hold's `held-material-consumed` incidents as last
   * read or raised (#399: as the copies; incidents are never deleted, and only the rebuild raises
   * them).
   */
  readonly #incidentFacts = new Map<string, Set<string>>();
  /**
   * Each held lot's links as last read (#399): a rebuild reads again only the links that changed.
   */
  readonly #lotReads = new Map<string, LotRead>();
  /**
   * The lot holds whose copy and incidents a rebuild brought in line with this read of their lot
   * while the hold had this version (#399): with the same read (unchanged links) and version, the
   * next rebuild has nothing to compare or raise for them. Dropped with their copy in memory.
   */
  readonly #settled = new Map<string, { readonly read: LotRead; readonly version: number }>();
  #started = false;
  #stopping = false;

  constructor(options: HoldsOptions) {
    this.#options = options;
    this.#db = options.db;
    this.#readDb = options.readDb ?? options.db;
    this.#log = options.log ?? silent;
    const registers = options.registry ? [options.registry] : [];
    if (registers.length > 0) {
      this.#transitions = new Counter({
        name: 'mes_quality_hold_transitions_total',
        help: 'Quality hold transitions and comments, by kind',
        labelNames: ['kind'] as const,
        registers,
      });
      this.#consumed = new Counter({
        name: 'mes_quality_held_material_consumed_total',
        help: 'held-material-consumed incidents raised (a held lot consumed after its hold opened)',
        registers,
      });
      this.#scopeSeconds = new Histogram({
        name: 'mes_quality_hold_scope_seconds',
        help: 'One rebuild of every hold scope (hold_unit) and held-material-consumed check, on a genealogy change or a hold transition',
        buckets: [...DERIVED_WORK_BUCKETS],
        registers,
      });
    }
  }

  /**
   * Derives every open or rejected hold's scope once, then follows the genealogy's changes and
   * the holds' own transitions (#238: no timer).
   */
  async start(): Promise<void> {
    this.#started = true;
    if (this.#options.follow !== false) {
      this.#unsubscribe = this.#options.genealogy.onChange(() => {
        this.#soon();
      });
    }
    await this.tick();
  }

  get started(): boolean {
    return this.#started;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#kick);
    this.#unsubscribe?.();
    await this.#queue.catch(() => undefined);
  }

  /** Listens for hold changes (push); returns an unsubscribe. */
  onChange(listener: (change: HoldChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The reasons of `quality.yaml`. */
  reasons(): readonly HoldReason[] {
    return this.#options.reasons;
  }

  // ---- the close guard (plan "Quality holds", review rounds 1–3) ----

  /**
   * The orders module's `CloseGuard`: `lock` takes the advisory lock opening a hold takes too, first
   * in the close's transaction; `check` then requires genealogy's processed watermark to cover
   * every cycle fact of the order's units (taken from ingest, not from execution's records:
   * ADR-0034), else `genealogy-pending` (retryable), and derives from the open holds' subjects and
   * the genealogy links, at that moment and in that transaction, whether one covers a unit of the
   * order (or is on the order): `quality-hold`. Never reads `hold_unit` (a rebuild may lag: the
   * race reproduced in probe P2) and never waits on an in-process queue.
   */
  closeGuard(): {
    lock(trx: Transaction<Database>): Promise<void>;
    check(
      trx: Transaction<Database>,
      orderId: string,
    ): Promise<
      | { kind: 'quality-hold'; holds: string[]; message: string }
      | { kind: 'genealogy-pending'; message: string }
      | undefined
    >;
  } {
    return {
      lock: (trx) => lockHolds(trx),
      check: (trx, orderId) => this.#check(trx, orderId),
    };
  }

  async #check(
    trx: Transaction<Database>,
    orderId: string,
  ): Promise<
    | { kind: 'quality-hold'; holds: string[]; message: string }
    | { kind: 'genealogy-pending'; message: string }
    | undefined
  > {
    const { genealogy, execution, ingest } = this.#options;
    // The order's units as execution and genealogy have them (either may be ahead of the other).
    const units = new Map<string, { epoch: number; partId: number }>();
    for (const u of await execution.orderUnits(orderId, trx)) units.set(unitKey(u), u);
    for (const u of await genealogy.scope({ kind: 'order', id: orderId }, { db: trx })) {
      units.set(unitKey(u), { epoch: u.epoch, partId: u.partId });
    }
    // Units neither module has built yet (review of PR #222, H1): every part of a cycle fact on the
    // order's CNC inside one of its jobs (after its `started`, before the CNC's next `started`), as
    // execution attributes them (ADR-0031).
    for (const u of await this.#jobParts(trx, orderId)) units.set(unitKey(u), u);
    const facts: { equipment: string; epoch: number; seq: number; partId: number }[] = [];
    for (const [epoch, parts] of byEpoch([...units.values()])) {
      for (let i = 0; i < parts.length; i += CHUNK) {
        const found = await ingest.cycleFacts({ epoch, partIds: parts.slice(i, i + CHUNK) }, trx);
        facts.push(
          ...found.map((f) => ({
            equipment: f.equipment,
            epoch: f.epoch,
            seq: f.seq,
            partId: f.partId,
          })),
        );
      }
    }
    // Every fact must be in genealogy's records of its unit: the watermark alone counts a
    // written-off number as settled, so a late fact of that gap would pass it unprocessed.
    const unrecorded = await genealogy.unrecorded(facts, trx);
    if (unrecorded.length > 0) {
      return {
        kind: 'genealogy-pending',
        message: `order ${orderId}: genealogy has no record yet of ${String(unrecorded.length)} fact(s) of its units (${unrecorded
          .slice(0, 5)
          .map((f) => `${f.equipment} #${String(f.seq)} part ${String(f.partId)}`)
          .join(', ')}); retry shortly`,
      };
    }
    if (!genealogy.covers(facts)) {
      const behind = new Map<string, number>();
      for (const f of facts) {
        if (genealogy.covers([f])) continue;
        const key = `${f.equipment} (epoch ${String(f.epoch)})`;
        behind.set(key, Math.max(behind.get(key) ?? 0, f.seq));
      }
      return {
        kind: 'genealogy-pending',
        message: `order ${orderId}: genealogy has not processed every fact of its units yet (${[
          ...behind,
        ]
          .map(([machine, seq]) => `${machine} through ${String(seq)}`)
          .join(', ')}); retry shortly`,
      };
    }
    const open = await trx
      .selectFrom('quality.hold')
      .select(['id', 'subject_kind', 'subject_id'])
      .where('state', '=', 'open')
      .orderBy('opened_at')
      .execute();
    const blocking: string[] = [];
    for (const hold of open) {
      const subject = { kind: hold.subject_kind, id: hold.subject_id };
      if (subject.kind === 'order' && subject.id === orderId) {
        blocking.push(hold.id);
        continue;
      }
      const covered = await genealogy.scope(subject, { orderId, db: trx });
      if (covered.length > 0) blocking.push(hold.id);
    }
    if (blocking.length === 0) return undefined;
    return {
      kind: 'quality-hold',
      holds: blocking,
      message: `order ${orderId} has units in open quality holds: ${blocking.join(', ')}`,
    };
  }

  /** Parts of the cycle facts inside the order's jobs on their CNCs (the unit attribution rule). */
  async #jobParts(
    trx: Transaction<Database>,
    orderId: string,
  ): Promise<{ epoch: number; partId: number }[]> {
    const { ingest, orders } = this.#options;
    const commands = await orders.commands({ orderId }, trx);
    const parts: { epoch: number; partId: number }[] = [];
    const ranges: {
      run: { equipment: string; epoch: number };
      after: number;
      before: number | undefined;
    }[] = [];
    const runs = new Map<string, { equipment: string; epoch: number; ids: Set<string> }>();
    for (const c of commands) {
      const key = `${c.equipment}/${String(c.deviceEpoch)}`;
      const run = runs.get(key) ?? { equipment: c.equipment, epoch: c.deviceEpoch, ids: new Set() };
      run.ids.add(c.commandId);
      runs.set(key, run);
    }
    for (const run of runs.values()) {
      const starts = (await ingest.jobFacts({ equipment: run.equipment, epoch: run.epoch }, trx))
        .filter((j) => j.transition === 'started')
        .sort((a, b) => a.seq - b.seq);
      starts.forEach((start, i) => {
        if (!run.ids.has(start.commandId)) return;
        const next = starts.slice(i + 1).find((s) => s.commandId !== start.commandId);
        ranges.push({ run, after: start.seq, before: next?.seq });
      });
    }
    for (const r of ranges) {
      const found = await ingest.cycleFacts(
        {
          epoch: r.run.epoch,
          equipment: r.run.equipment,
          afterSeq: r.after,
          ...(r.before === undefined ? {} : { beforeSeq: r.before }),
        },
        trx,
      );
      for (const f of found) parts.push({ epoch: f.epoch, partId: f.partId });
    }
    return parts;
  }

  // ---- reads ----

  async list(
    query: {
      readonly state?: readonly HoldState[];
      readonly subject?: HoldSubject;
      readonly limit?: number;
    } = {},
  ): Promise<{ holds: HoldRecord[]; truncated: boolean }> {
    const limit = query.limit ?? 500;
    let select = this.#readDb.selectFrom('quality.hold').selectAll();
    if (query.state !== undefined && query.state.length > 0) {
      select = select.where('state', 'in', [...query.state]);
    }
    if (query.subject !== undefined) {
      select = select
        .where('subject_kind', '=', query.subject.kind)
        .where('subject_id', '=', query.subject.id);
    }
    const rows = await select
      .orderBy('opened_at', 'desc')
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    return {
      holds: await this.#records(this.#readDb, rows.slice(0, limit)),
      truncated: rows.length > limit,
    };
  }

  async hold(id: string): Promise<HoldRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const row = await this.#readDb
      .selectFrom('quality.hold')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && (await this.#records(this.#readDb, [row]))[0];
  }

  /** A hold with its transitions (and their notifications), scope as last derived and incidents. */
  async detail(id: string): Promise<HoldDetail | undefined> {
    const hold = await this.hold(id);
    if (!hold) return undefined;
    const db = this.#readDb;
    const [transitions, units, incidents, messages] = await Promise.all([
      db
        .selectFrom('quality.hold_transition')
        .selectAll()
        .where('hold_id', '=', id)
        .orderBy('n')
        .execute(),
      db
        .selectFrom('quality.hold_unit')
        .selectAll()
        .where('hold_id', '=', id)
        .orderBy('epoch')
        .orderBy('part_id')
        .limit(UNIT_LIMIT + 1)
        .execute(),
      db
        .selectFrom('quality.hold_incident')
        .selectAll()
        .where('hold_id', '=', id)
        .orderBy('id')
        .execute(),
      this.#options.orders.erpMessagesOf({ kind: 'hold', id }),
    ]);
    const all = await db
      .selectFrom('quality.hold_unit')
      .select(['order_id', 'carton_id'])
      .where('hold_id', '=', id)
      .execute();
    const byKey = new Map(messages.map((m) => [m.idempotencyKey ?? '', m]));
    return {
      hold,
      transitions: transitions.map((t) => {
        const key =
          t.kind === 'commented'
            ? undefined
            : qualityNotificationKey(id, transitionOf(t.kind), t.n);
        const message = key === undefined ? undefined : byKey.get(key);
        return {
          n: t.n,
          kind: t.kind,
          reason: t.reason,
          comment: t.comment,
          by: t.actor,
          at: t.at,
          plantAt: t.plant_at,
          scope: t.scope,
          notification:
            key === undefined
              ? null
              : {
                  idempotencyKey: key,
                  status: message?.status ?? 'missing',
                  attempts: message?.attempts ?? 0,
                  lastError: message?.lastError ?? null,
                },
        };
      }),
      units: units.slice(0, UNIT_LIMIT).map((u) => ({
        epoch: u.epoch,
        partId: u.part_id,
        serial: u.serial,
        orderId: u.order_id,
        carton: u.carton_id,
        joinedAt: u.joined_at,
      })),
      unitsTruncated: units.length > UNIT_LIMIT,
      orders: distinct(all.map((u) => u.order_id)),
      cartons: distinct(all.map((u) => u.carton_id)),
      incidents: incidents.map(toIncident),
    };
  }

  /** The `held-material-consumed` incidents of every hold, newest first. */
  async incidents(query: { readonly limit?: number } = {}): Promise<HoldIncidentRecord[]> {
    const rows = await this.#readDb
      .selectFrom('quality.hold_incident')
      .selectAll()
      .orderBy('id', 'desc')
      .limit(query.limit ?? 500)
      .execute();
    return rows.map(toIncident);
  }

  /**
   * Holds open or rejected on these units, by unit, and those whose subject is one of `subjects`
   * (#201: a trace answer's holds and a carton's `held`), by the scope last derived.
   */
  async holdsOn(
    units: readonly { epoch: number; partId: number }[],
    subjects: readonly HoldSubject[] = [],
  ): Promise<{ byUnit: Map<string, HoldRef[]>; all: HoldRef[] }> {
    const db = this.#readDb;
    const byUnit = new Map<string, HoldRef[]>();
    const all = new Map<string, HoldRef>();
    for (const [epoch, parts] of byEpoch(units)) {
      for (let i = 0; i < parts.length; i += CHUNK) {
        const rows = await db
          .selectFrom('quality.hold_unit as u')
          .innerJoin('quality.hold as h', 'h.id', 'u.hold_id')
          .select(['u.epoch', 'u.part_id', 'h.id', 'h.state', 'h.subject_kind', 'h.subject_id'])
          .where('h.state', 'in', ['open', 'rejected'])
          .where('u.epoch', '=', epoch)
          .where('u.part_id', 'in', parts.slice(i, i + CHUNK))
          .orderBy('h.opened_at')
          .execute();
        for (const row of rows) {
          const ref = {
            id: row.id,
            state: row.state,
            subject: { kind: row.subject_kind, id: row.subject_id },
          };
          const key = unitKey({ epoch: row.epoch, partId: row.part_id });
          const list = byUnit.get(key);
          if (list) list.push(ref);
          else byUnit.set(key, [ref]);
          all.set(ref.id, ref);
        }
      }
    }
    for (const subject of subjects) {
      const rows = await db
        .selectFrom('quality.hold')
        .select(['id', 'state', 'subject_kind', 'subject_id'])
        .where('state', 'in', ['open', 'rejected'])
        .where('subject_kind', '=', subject.kind)
        .where('subject_id', '=', subject.id)
        .execute();
      for (const row of rows) {
        all.set(row.id, {
          id: row.id,
          state: row.state,
          subject: { kind: row.subject_kind, id: row.subject_id },
        });
      }
    }
    return { byUnit, all: [...all.values()].sort((a, b) => byText(a.id, b.id)) };
  }

  /**
   * Open holds that touch one of these orders (#203, the terminal's banners): on the order itself,
   * or with a unit of it in the scope as last derived (`hold_unit`: a display, never a decision),
   * each with the orders of `orderIds` it touches; newest first, at most `limit`.
   */
  async openOnOrders(
    orderIds: readonly string[],
    limit = 10,
  ): Promise<{ holds: { hold: HoldRecord; orders: string[] }[]; truncated: boolean }> {
    if (orderIds.length === 0) return { holds: [], truncated: false };
    const db = this.#readDb;
    const ids = [...new Set(orderIds)];
    const touched = new Map<string, Set<string>>();
    const add = (hold: string, order: string) => {
      const set = touched.get(hold);
      if (set) set.add(order);
      else touched.set(hold, new Set([order]));
    };
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const [byUnit, bySubject] = await Promise.all([
        db
          .selectFrom('quality.hold_unit as u')
          .innerJoin('quality.hold as h', 'h.id', 'u.hold_id')
          .select(['h.id', 'u.order_id'])
          .distinct()
          .where('h.state', '=', 'open')
          .where('u.order_id', 'in', chunk)
          .execute(),
        db
          .selectFrom('quality.hold')
          .select(['id', 'subject_id'])
          .where('state', '=', 'open')
          .where('subject_kind', '=', 'order')
          .where('subject_id', 'in', chunk)
          .execute(),
      ]);
      for (const row of byUnit) if (row.order_id !== null) add(row.id, row.order_id);
      for (const row of bySubject) add(row.id, row.subject_id);
    }
    if (touched.size === 0) return { holds: [], truncated: false };
    const rows = await db
      .selectFrom('quality.hold')
      .selectAll()
      .where('id', 'in', [...touched.keys()])
      .orderBy('opened_at', 'desc')
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const records = await this.#records(db, rows.slice(0, limit));
    return {
      holds: records.map((hold) => ({
        hold,
        orders: [...(touched.get(hold.id) ?? [])].sort(byText),
      })),
      truncated: rows.length > limit,
    };
  }

  /**
   * Of these lots, those an open hold is on as its subject (#203 review: the terminal marks a lot in
   * use as held from the holds themselves, not from the scope copy).
   */
  async openLotHolds(lots: readonly string[]): Promise<Set<string>> {
    if (lots.length === 0) return new Set();
    const rows = await this.#readDb
      .selectFrom('quality.hold')
      .select('subject_id')
      .distinct()
      .where('state', '=', 'open')
      .where('subject_kind', '=', 'lot')
      .where('subject_id', 'in', [...new Set(lots)])
      .execute();
    return new Set(rows.map((r) => r.subject_id));
  }

  /**
   * The units tested since the last in-control point before a signal episode, with their orders
   * and cartons: the scope a quality user may hold (plan "Signals and people"); never a hold by
   * itself. Undefined for an unknown or withdrawn signal.
   */
  async suggestion(signalId: number): Promise<HoldSuggestion | undefined> {
    const window = await this.#options.signals?.signalWindow(signalId);
    if (!window) return undefined;
    const keys = new Map<string, { epoch: number; partId: number }>();
    for (const r of window.readings) keys.set(unitKey(r), { epoch: r.epoch, partId: r.partId });
    const known = new Map(
      (await this.#options.genealogy.units([...keys.values()])).map((u) => [unitKey(u), u]),
    );
    const units = [...keys.values()].map(
      (k) =>
        known.get(unitKey(k)) ?? {
          epoch: k.epoch,
          partId: k.partId,
          serial: null,
          orderId: null,
          carton: null,
        },
    );
    return {
      window,
      units,
      orders: distinct(units.map((u) => u.orderId)),
      cartons: distinct(units.map((u) => u.carton)),
    };
  }

  // ---- writes ----

  /**
   * Opens a hold (`quality:hold`): the subject must be known (an imported lot, a serial or carton
   * the genealogy has, an order the MES imported; else 404), the reason one of `quality.yaml` for
   * an opening (else 422). One transaction, which first takes the advisory lock a close takes too:
   * the hold, its `opened` transition with the scope counts at that moment, the scope copy, the
   * audit (`hold.open`) and the ERP notification (`{holdId}~opened~1`) in the orders outbox.
   * `plantAt` (scripted golden holds) sets `opened_plant_at` instead of the plant clock.
   */
  async open(
    request: { readonly subject: HoldSubject; readonly reason: string; readonly comment?: string },
    context: QualityWriteContext,
    options: { readonly plantAt?: Date; readonly epoch?: number } = {},
  ): Promise<HoldRecord> {
    this.#reason(request.reason, 'open');
    await this.#known(request.subject);
    const id = randomUUID();
    const plantAt = options.plantAt ?? this.#options.clock?.() ?? null;
    const epoch = plantAt === null ? null : (options.epoch ?? this.#options.epoch?.() ?? null);
    const by = nameOf(context.by);
    const hold = await this.#serial(() =>
      this.#db.transaction().execute(async (trx) => {
        // First, before anything else (review round 2, MEDIUM D): a close holding it has its
        // guard's answer and commits before this hold exists, or waits for this one.
        await lockHolds(trx);
        // One open hold per subject and reason (#203 review): under the lock, so two openings at
        // once can't both pass. Another reason on the same subject is a separate hold.
        const existing = await trx
          .selectFrom('quality.hold')
          .select('id')
          .where('state', '=', 'open')
          .where('subject_kind', '=', request.subject.kind)
          .where('subject_id', '=', request.subject.id)
          .where('reason', '=', request.reason)
          .orderBy('opened_at')
          .execute();
        if (existing.length > 0) {
          const ids = existing.map((row) => row.id);
          throw new QualityError(
            'conflict',
            `an open hold on ${request.subject.kind} ${request.subject.id} with reason ${request.reason} exists already: ${ids.join(', ')}`,
            PROBLEM_TYPES.holdExists,
            ids,
          );
        }
        const scope = await this.#options.genealogy.scope(request.subject, { db: trx });
        const counts = this.#counts(scope, plantAt);
        await trx
          .insertInto('quality.hold')
          .values({
            id,
            subject_kind: request.subject.kind,
            subject_id: request.subject.id,
            state: 'open',
            reason: request.reason,
            opened_by: by,
            opened_plant_at: plantAt,
            opened_epoch: epoch,
            decided_by: null,
            decided_at: null,
            decided_plant_at: null,
            decided_epoch: null,
            decision_reason: null,
          })
          .execute();
        await this.#transition(trx, {
          id,
          n: 1,
          kind: 'opened',
          reason: request.reason,
          comment: request.comment ?? null,
          by,
          plantAt,
          scope: counts,
        });
        await this.#replaceUnits(trx, id, scope);
        await Identity.audit(trx, {
          actor: auditActor(context.by),
          authenticated: isAuthenticated(context.by),
          action: 'hold.open',
          entityType: HOLD_AUDIT_ENTITY,
          entityId: id,
          after: {
            state: 'open',
            version: 1,
            subject: request.subject,
            reason: request.reason,
            ...(request.comment === undefined ? {} : { comment: request.comment }),
            scope: counts,
          },
          requestId: context.requestId,
          plantAt: plantAt ?? undefined,
        });
        await this.#notify(trx, {
          id,
          subject: request.subject,
          transition: 'opened',
          n: 1,
          reason: request.reason,
          comment: request.comment,
          by,
          plantAt,
          scope: counts,
        });
        const record = await this.#recordIn(trx, id);
        await this.#options.beforeCommit?.(trx, id);
        return record;
      }),
    );
    this.#transitions?.inc({ kind: 'opened' });
    this.#log.info({ hold: id, subject: request.subject, reason: request.reason }, 'hold opened');
    this.#emit({ type: 'hold', event: 'opened', hold });
    this.#soon();
    return hold;
  }

  /** A comment on a hold (`quality:hold`): appended and audited (`hold.comment`), not notified. */
  async comment(
    id: string,
    request: { readonly version: number; readonly comment: string },
    context: QualityWriteContext,
  ): Promise<HoldRecord> {
    const hold = await this.#serial(() =>
      this.#db.transaction().execute(async (trx) => {
        const row = await this.#lockRow(trx, id, request.version);
        const plantAt = this.#options.clock?.() ?? null;
        const n = row.transitions + 1;
        await this.#transition(trx, {
          id,
          n,
          kind: 'commented',
          reason: null,
          comment: request.comment,
          by: nameOf(context.by),
          plantAt,
          scope: null,
        });
        await this.#bump(trx, row);
        await Identity.audit(trx, {
          actor: auditActor(context.by),
          authenticated: isAuthenticated(context.by),
          action: 'hold.comment',
          entityType: HOLD_AUDIT_ENTITY,
          entityId: id,
          before: { version: row.version },
          after: { version: row.version + 1, n, comment: request.comment },
          requestId: context.requestId,
          plantAt: plantAt ?? undefined,
        });
        return this.#recordIn(trx, id);
      }),
    );
    this.#transitions?.inc({ kind: 'commented' });
    this.#emit({ type: 'hold', event: 'commented', hold });
    return hold;
  }

  /**
   * Releases (use as is) or rejects an open hold (`quality:release`): the hold's version read (409
   * `hold-stale`), open (409 `hold-decided`), a reason of `quality.yaml` for that decision (422);
   * the scope derived once more and kept as it stands, the transition with the scope counts, the
   * audit (`hold.release`, `hold.reject`) and the ERP notification. A rejection changes no
   * quantity: quantities change only from machine facts; its cartons stay held.
   */
  async decide(
    id: string,
    decision: 'release' | 'reject',
    request: { readonly version: number; readonly reason: string; readonly comment?: string },
    context: QualityWriteContext,
  ): Promise<HoldRecord> {
    this.#reason(request.reason, decision);
    const kind: HoldTransitionKind = decision === 'release' ? 'released' : 'rejected';
    const hold = await this.#serial(() =>
      this.#db.transaction().execute(async (trx) => {
        const row = await this.#lockRow(trx, id, request.version);
        if (row.state !== 'open') {
          throw new QualityError(
            'conflict',
            `hold ${id} is ${row.state} already`,
            PROBLEM_TYPES.holdDecided,
          );
        }
        const plantAt = this.#options.clock?.() ?? null;
        const by = nameOf(context.by);
        const subject = { kind: row.subject_kind, id: row.subject_id };
        const scope = await this.#options.genealogy.scope(subject, { db: trx });
        const counts = this.#counts(scope, plantAt);
        const n = row.transitions + 1;
        await this.#replaceUnits(trx, id, scope);
        await this.#transition(trx, {
          id,
          n,
          kind,
          reason: request.reason,
          comment: request.comment ?? null,
          by,
          plantAt,
          scope: counts,
        });
        await this.#bump(trx, row, {
          state: kind === 'released' ? 'released' : 'rejected',
          by,
          plantAt,
          reason: request.reason,
        });
        await Identity.audit(trx, {
          actor: auditActor(context.by),
          authenticated: isAuthenticated(context.by),
          action: decision === 'release' ? 'hold.release' : 'hold.reject',
          entityType: HOLD_AUDIT_ENTITY,
          entityId: id,
          before: { state: row.state, version: row.version },
          after: {
            state: kind,
            version: row.version + 1,
            n,
            reason: request.reason,
            ...(request.comment === undefined ? {} : { comment: request.comment }),
            scope: counts,
          },
          requestId: context.requestId,
          plantAt: plantAt ?? undefined,
        });
        await this.#notify(trx, {
          id,
          subject,
          transition: kind,
          n,
          reason: request.reason,
          comment: request.comment,
          by,
          plantAt,
          scope: counts,
        });
        return this.#recordIn(trx, id);
      }),
    );
    this.#transitions?.inc({ kind });
    this.#log.info({ hold: id, decision, reason: request.reason }, `hold ${kind}`);
    this.#emit({ type: 'hold', event: kind, hold });
    this.#soon();
    return hold;
  }

  // ---- the scope copy and incidents ----

  /**
   * One rebuild now: every open or rejected hold's scope derived from the genealogy again (units
   * that joined are added with the time they joined; a unit no longer covered, after a rebuild, is
   * removed), and `held-material-consumed` for every consumption of a held lot after its hold
   * opened (and before its release, for a released one: a late fact may still show one). The MES
   * runs it on change (#238); tests call it after driving the genealogy by hand.
   */
  async tick(): Promise<void> {
    if (!this.#started || this.#stopping) return;
    await this.#serial(() => this.#rebuild());
  }

  /** A rebuild soon, coalesced: one for any number of changes heard of meanwhile. */
  #soon(delayMs = 0): void {
    this.#due = true;
    if (
      this.#kick !== undefined ||
      !this.#started ||
      this.#stopping ||
      this.#options.follow === false
    ) {
      return;
    }
    this.#kick = setTimeout(() => {
      this.#kick = undefined;
      this.#serial(async () => {
        if (!this.#due || this.#stopping) return;
        await this.#rebuild();
      }).catch((error: unknown) => {
        // Retried every second until a rebuild succeeds (a lost connection): the scopes stay as
        // they were meanwhile.
        this.#log.error({ err: error }, 'holds: rebuilding the scopes failed');
        this.#soon(1_000);
      });
    }, delayMs);
    this.#kick.unref();
  }

  /**
   * Every hold's scope and incidents in a few queries whatever the number of holds (#238): every
   * held lot's scope and consumptions in one read of its links, sent only where they changed since
   * the last read (#399); the scopes of the other open and rejected holds' subjects by kind; and
   * the stored copies and known incidents of holds not seen yet (both kept in memory). A lot hold
   * already in line with an unchanged read of its lot, at the same version, is skipped. Then one
   * insert for the added units (in a transaction when there is more to write), one for the new
   * incidents, and one read of the changed holds' records when someone listens.
   */
  async #rebuild(): Promise<void> {
    try {
      await this.#rebuildScopes();
    } catch (error) {
      // A failed rebuild may have committed or not (a connection lost at COMMIT): the copies and
      // incidents in memory are read again from the database by the next one.
      this.#copies.clear();
      this.#incidentFacts.clear();
      this.#lotReads.clear();
      this.#settled.clear();
      throw error;
    }
  }

  async #rebuildScopes(): Promise<void> {
    this.#due = false;
    const started = performance.now();
    const holds = await this.#db
      .selectFrom('quality.hold')
      .selectAll()
      .orderBy('opened_at')
      .execute();
    const live = holds.filter((h) => h.state !== 'released');
    const lots = holds.filter((h) => h.subject_kind === 'lot');
    const others = live.filter((h) => h.subject_kind !== 'lot');
    const genealogy = this.#options.genealogy;
    // A lot's scope and its consumptions come from the same links: one read for both (#399).
    const [byLot, otherScopes, stored, known] = await Promise.all([
      this.#readLots(lots.map((h) => h.subject_id)),
      others.length === 0
        ? []
        : genealogy.scopes(others.map((h) => ({ kind: h.subject_kind, id: h.subject_id }))),
      this.#loadCopies(live.map((h) => h.id)),
      this.#loadKnown(lots.map((h) => h.id)),
    ]);
    const liveIds = new Set(live.map((h) => h.id));
    for (const id of this.#copies.keys()) if (!liveIds.has(id)) this.#copies.delete(id);
    const unsettled = (hold: Selectable<HoldTable>): boolean => {
      const settled = this.#settled.get(hold.id);
      return settled?.version !== hold.version || settled.read !== byLot.get(hold.subject_id);
    };
    const otherScope = new Map(others.map((h, index) => [h.id, otherScopes[index] ?? []]));
    const changed = new Set<string>();
    const plans: { readonly id: string; readonly plan: UnitPlan }[] = [];
    for (const hold of live) {
      if (hold.subject_kind === 'lot' && !unsettled(hold)) continue;
      const scope =
        hold.subject_kind === 'lot'
          ? (byLot.get(hold.subject_id)?.scope ?? [])
          : (otherScope.get(hold.id) ?? []);
      const plan = planUnits(stored.get(hold.id) ?? new Map<string, CopyUnit>(), scope);
      if (plan.gone.length + plan.added.length + plan.moved.length > 0) {
        plans.push({ id: hold.id, plan });
        changed.add(hold.id);
      }
    }
    if (plans.length > 0) {
      await this.#applyPlans(plans);
      // Committed: the copies in memory follow.
      for (const { id, plan } of plans) {
        const copy = this.#copies.get(id);
        if (!copy) continue;
        for (const unit of plan.gone)
          copy.delete(unitKey({ epoch: unit.epoch, partId: unit.part_id }));
        for (const unit of [...plan.added, ...plan.moved]) copy.set(unitKey(unit), copyOf(unit));
      }
    }
    const raised = await this.#consumptions(
      lots.filter(unsettled).map((hold) => ({
        hold,
        consumptions: byLot.get(hold.subject_id)?.consumptions ?? [],
        known: known.get(hold.id) ?? new Set<string>(),
      })),
    );
    for (const id of raised) changed.add(id);
    for (const hold of lots) {
      const read = byLot.get(hold.subject_id);
      // A released hold has no copy: only its incidents follow the read.
      if (read && (hold.state === 'released' || this.#copies.has(hold.id))) {
        this.#settled.set(hold.id, { read, version: hold.version });
      }
    }
    // The changed holds' records, for the listeners only, in one read of their counts (#399): the
    // rows read above are current, as transitions go through the same queue as this rebuild.
    if (changed.size > 0 && this.#listeners.size > 0) {
      const records = await this.#records(
        this.#readDb,
        holds.filter((h) => changed.has(h.id)),
      );
      for (const record of records) this.#emit({ type: 'hold', event: 'scope', hold: record });
    }
    const seconds = (performance.now() - started) / 1_000;
    this.#scopeSeconds?.observe(seconds);
    this.#options.onTiming?.({ metric: 'hold-scope', seconds, holds: holds.length });
  }

  /**
   * These lots' scopes and consumptions, by lot: read again only where their links changed since
   * the last read, which answers a lot with no change with the same object (#399).
   */
  async #readLots(lots: readonly string[]): Promise<ReadonlyMap<string, LotRead>> {
    const wanted = new Set(lots);
    for (const lot of this.#lotReads.keys()) if (!wanted.has(lot)) this.#lotReads.delete(lot);
    if (wanted.size === 0) return new Map();
    const reads = await this.#options.genealogy.lotsScopesAndConsumptions([...wanted], {
      db: this.#db,
      previous: this.#lotReads,
    });
    for (const [lot, read] of reads) this.#lotReads.set(lot, read);
    return reads;
  }

  /**
   * The stored scope copies of these holds, by hold: kept in memory once read (#238: the holds
   * module is the copy's only writer, and every write goes through its queue), so a rebuild reads
   * only the copies of holds it has not seen yet.
   */
  async #loadCopies(ids: readonly string[]): Promise<Map<string, Map<string, CopyUnit>>> {
    const missing = ids.filter((id) => !this.#copies.has(id));
    for (const id of missing) this.#copies.set(id, new Map());
    for (let i = 0; i < missing.length; i += CHUNK) {
      const rows = await this.#db
        .selectFrom('quality.hold_unit')
        .select(['hold_id', 'epoch', 'part_id', 'serial', 'order_id', 'carton_id'])
        .where('hold_id', 'in', missing.slice(i, i + CHUNK))
        .execute();
      for (const { hold_id: hold, ...unit } of rows) {
        this.#copies.get(hold)?.set(unitKey({ epoch: unit.epoch, partId: unit.part_id }), unit);
      }
    }
    return this.#copies;
  }

  /**
   * The facts of the `held-material-consumed` incidents of these holds, by hold: kept in memory
   * once read, as the copies (#399), so a rebuild reads only those of holds it has not seen yet.
   */
  async #loadKnown(ids: readonly string[]): Promise<Map<string, Set<string>>> {
    const missing = ids.filter((id) => !this.#incidentFacts.has(id));
    for (const id of missing) this.#incidentFacts.set(id, new Set());
    for (let i = 0; i < missing.length; i += CHUNK) {
      const rows = await this.#db
        .selectFrom('quality.hold_incident')
        .select(['hold_id', 'equipment', 'epoch', 'seq'])
        .where('hold_id', 'in', missing.slice(i, i + CHUNK))
        .execute();
      for (const row of rows) {
        this.#incidentFacts.get(row.hold_id)?.add(consumedKey(row));
      }
    }
    return this.#incidentFacts;
  }

  /** Brings the scope copy in line with `scope`; whether anything changed. */
  async #replaceUnits(
    trx: Transaction<Database>,
    id: string,
    scope: readonly HoldScopeUnit[],
  ): Promise<boolean> {
    const stored = await trx
      .selectFrom('quality.hold_unit')
      .selectAll()
      .where('hold_id', '=', id)
      .execute();
    const plan = planUnits(
      new Map(stored.map((u) => [unitKey({ epoch: u.epoch, partId: u.part_id }), u])),
      scope,
    );
    await this.#applyUnits(trx, [{ id, plan }]);
    // Read again by the next rebuild (this transaction may still roll back).
    this.#copies.delete(id);
    this.#settled.delete(id);
    return plan.gone.length + plan.added.length + plan.moved.length > 0;
  }

  /**
   * Writes holds' scope copy changes (`planUnits`) in one transaction; a single statement (units
   * only added, the common case) runs on its own, being atomic already (#399: two round trips
   * fewer per rebuild).
   */
  async #applyPlans(
    plans: readonly { readonly id: string; readonly plan: UnitPlan }[],
  ): Promise<void> {
    const added = plans.reduce((n, { plan }) => n + plan.added.length, 0);
    const single = plans.every(({ plan }) => plan.gone.length + plan.moved.length === 0);
    if (single && added <= INSERT_CHUNK) await this.#applyUnits(this.#db, plans);
    else await this.#db.transaction().execute((trx) => this.#applyUnits(trx, plans));
  }

  /** Writes holds' scope copy changes (`planUnits`): every added unit in one insert. */
  async #applyUnits(
    db: Kysely<Database>,
    plans: readonly { readonly id: string; readonly plan: UnitPlan }[],
  ): Promise<void> {
    for (const { id, plan } of plans) {
      for (const unit of plan.gone) {
        await db
          .deleteFrom('quality.hold_unit')
          .where('hold_id', '=', id)
          .where('epoch', '=', unit.epoch)
          .where('part_id', '=', unit.part_id)
          .execute();
      }
    }
    const added = plans.flatMap(({ id, plan }) =>
      plan.added.map((u): Omit<Selectable<HoldUnitTable>, 'joined_at'> => ({
        hold_id: id,
        epoch: u.epoch,
        part_id: u.partId,
        serial: u.serial,
        order_id: u.orderId,
        carton_id: u.carton,
      })),
    );
    for (let i = 0; i < added.length; i += INSERT_CHUNK) {
      await db
        .insertInto('quality.hold_unit')
        .values(added.slice(i, i + INSERT_CHUNK))
        .execute();
    }
    for (const { id, plan } of plans) {
      for (const unit of plan.moved) {
        await db
          .updateTable('quality.hold_unit')
          .set({ serial: unit.serial, order_id: unit.orderId, carton_id: unit.carton })
          .where('hold_id', '=', id)
          .where('epoch', '=', unit.epoch)
          .where('part_id', '=', unit.partId)
          .execute();
      }
    }
  }

  /**
   * Raises `held-material-consumed` for lot holds' consumptions after their opening, given each
   * lot's consumptions and the facts each hold's incidents already name (to which it adds those it
   * raised), in one insert for all holds (#399); the holds that raised any.
   */
  async #consumptions(
    lots: readonly {
      readonly hold: Selectable<HoldTable>;
      readonly consumptions: readonly LotConsumptionRef[];
      readonly known: Set<string>;
    }[],
  ): Promise<Set<string>> {
    const late = lots.flatMap(({ hold, consumptions, known }) =>
      lateConsumptions(hold, consumptions, known).map((c) => ({ hold, c, known })),
    );
    const raised = new Map<string, number>();
    for (let i = 0; i < late.length; i += INSERT_CHUNK) {
      for (const id of await this.#raiseConsumed(late.slice(i, i + INSERT_CHUNK))) {
        raised.set(id, (raised.get(id) ?? 0) + 1);
      }
    }
    // Every one of them has its incident now (raised here, or already there).
    for (const { c, known } of late) known.add(consumedKey(c));
    for (const { hold } of lots) {
      const count = raised.get(hold.id) ?? 0;
      if (count === 0) continue;
      this.#consumed?.inc(count);
      this.#log.warn(
        { hold: hold.id, lot: hold.subject_id, consumptions: count },
        'held-material-consumed: a held lot was consumed after its hold opened',
      );
    }
    return new Set(raised.keys());
  }

  /** Inserts these incidents (a fact already there is skipped); the hold of each one inserted. */
  async #raiseConsumed(
    late: readonly {
      readonly hold: Selectable<HoldTable>;
      readonly c: LotConsumptionRef;
    }[],
  ): Promise<string[]> {
    const inserted = await this.#db
      .insertInto('quality.hold_incident')
      .values(
        late.map(({ hold, c }) => ({
          type: 'held-material-consumed' as const,
          hold_id: hold.id,
          lot: hold.subject_id,
          equipment: c.equipment,
          epoch: c.epoch,
          seq: c.seq,
          part_id: c.partId,
          operation: c.operation,
          pass: c.pass,
          consumed_at: c.at,
          message: `lot ${hold.subject_id} under hold ${hold.id} consumed by part ${String(c.partId)} at ${c.operation} pass ${String(c.pass)} on ${c.equipment} at ${c.at.toISOString()}, after the hold opened${hold.opened_plant_at === null ? '' : ` (${hold.opened_plant_at.toISOString()})`}`,
        })),
      )
      .onConflict((oc) => oc.columns(['hold_id', 'equipment', 'epoch', 'seq', 'lot']).doNothing())
      .returning('hold_id')
      .execute();
    return inserted.map((row) => row.hold_id);
  }

  // ---- internals ----

  #reason(reason: string, use: 'open' | 'release' | 'reject'): void {
    const found = this.#options.reasons.find((r) => r.id === reason);
    if (!found?.for.includes(use)) {
      throw new QualityError(
        'invalid',
        `${reason} is not a hold reason for ${use === 'open' ? 'an opening' : `a ${use}`} (quality.yaml)`,
      );
    }
  }

  async #known(subject: HoldSubject): Promise<void> {
    const { genealogy, orders } = this.#options;
    let known: boolean;
    if (subject.kind === 'lot') known = (await genealogy.lots()).some((l) => l.id === subject.id);
    else if (subject.kind === 'serial') known = (await genealogy.scope(subject)).length > 0;
    else if (subject.kind === 'carton') known = (await genealogy.carton(subject.id)) !== undefined;
    else known = (await orders.order(subject.id)) !== undefined;
    if (!known) {
      throw new QualityError(
        'not-found',
        subject.kind === 'lot'
          ? `no lot ${subject.id} in the lot list imported from the ERP`
          : `no ${subject.kind} ${subject.id}`,
      );
    }
  }

  #counts(scope: readonly HoldScopeUnit[], plantAt: Date | null): StoredScope {
    const finality =
      plantAt === null
        ? { final: false }
        : this.#options.genealogy.finalityAt(plantAt, distinctNumbers(scope.map((u) => u.epoch)));
    return {
      units: scope.length,
      cartons: distinct(scope.map((u) => u.carton)).length,
      orders: distinct(scope.map((u) => u.orderId)).length,
      asOf: plantAt === null ? null : plantAt.toISOString(),
      final: finality.final,
    };
  }

  async #lockRow(
    trx: Transaction<Database>,
    id: string,
    version: number,
  ): Promise<Selectable<HoldTable>> {
    const row = isUuid(id)
      ? await trx
          .selectFrom('quality.hold')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (!row) throw new QualityError('not-found', `no hold ${id}`);
    if (row.version !== version) {
      throw new QualityError(
        'conflict',
        `hold ${id} changed: version is ${String(row.version)}, not ${String(version)}`,
        PROBLEM_TYPES.holdStale,
      );
    }
    return row;
  }

  /** The hold's next transition: its count and version, and a decision if one. */
  async #bump(
    trx: Transaction<Database>,
    row: Selectable<HoldTable>,
    decision?: {
      readonly state: HoldState;
      readonly by: string;
      readonly plantAt: Date | null;
      readonly reason: string;
    },
  ): Promise<void> {
    await trx
      .updateTable('quality.hold')
      .set({
        ...(decision === undefined
          ? {}
          : {
              state: decision.state,
              decided_by: decision.by,
              decided_at: sql<Date>`clock_timestamp()`,
              decided_plant_at: decision.plantAt,
              decided_epoch: decision.plantAt === null ? null : (this.#options.epoch?.() ?? null),
              decision_reason: decision.reason,
            }),
        transitions: row.transitions + 1,
        version: row.version + 1,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', row.id)
      .execute();
  }

  async #transition(
    trx: Transaction<Database>,
    t: {
      readonly id: string;
      readonly n: number;
      readonly kind: HoldTransitionKind;
      readonly reason: string | null;
      readonly comment: string | null;
      readonly by: string;
      readonly plantAt: Date | null;
      readonly scope: StoredScope | null;
    },
  ): Promise<void> {
    await trx
      .insertInto('quality.hold_transition')
      .values({
        hold_id: t.id,
        n: t.n,
        kind: t.kind,
        reason: t.reason,
        comment: t.comment,
        actor: t.by,
        plant_at: t.plantAt,
        scope: t.scope === null ? null : JSON.stringify(t.scope),
      })
      .execute();
  }

  /**
   * The quality notification of a transition (ADR-0028 amendment), into the orders module's outbox
   * in this transaction: key `{holdId}~{transition}~{n}`, the order subject by its ERP order number
   * (the MES's order id), the scope counts as of now and whether they are final.
   */
  async #notify(
    trx: Transaction<Database>,
    n: {
      readonly id: string;
      readonly subject: HoldSubject;
      readonly transition: QualityHoldTransition;
      readonly n: number;
      readonly reason: string;
      readonly comment: string | undefined;
      readonly by: string;
      readonly plantAt: Date | null;
      readonly scope: StoredScope;
    },
  ): Promise<void> {
    const occurred = (n.plantAt ?? new Date(this.#options.now?.() ?? Date.now())).toISOString();
    const body: QualityNotificationInput = {
      holdId: n.id,
      transition: n.transition,
      transitionNo: n.n,
      subject: { kind: n.subject.kind, id: n.subject.id },
      reason: n.reason,
      ...(n.comment === undefined ? {} : { comment: n.comment }),
      user: n.by,
      occurredAt: occurred,
      scope: { units: n.scope.units, cartons: n.scope.cartons, orders: n.scope.orders },
      scopeAsOf: n.scope.asOf ?? occurred,
      scopeFinal: n.scope.final,
    };
    await this.#options.orders.enqueueErpMessage(trx, {
      kind: 'quality-notification',
      idempotencyKey: qualityNotificationKey(n.id, n.transition, n.n),
      subject: { kind: 'hold', id: n.id },
      payload: body,
    });
  }

  async #recordIn(trx: Transaction<Database>, id: string): Promise<HoldRecord> {
    const row = await trx
      .selectFrom('quality.hold')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const [record] = await this.#records(trx, [row]);
    if (!record) throw new Error('unreachable: no hold');
    return record;
  }

  async #records(
    db: Kysely<Database>,
    rows: readonly Selectable<HoldTable>[],
  ): Promise<HoldRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [units, incidents] = await Promise.all([
      db
        .selectFrom('quality.hold_unit')
        .select([
          'hold_id',
          sql<number>`count(*)::int`.as('units'),
          sql<number>`count(DISTINCT carton_id)::int`.as('cartons'),
          sql<number>`count(DISTINCT order_id)::int`.as('orders'),
        ])
        .where('hold_id', 'in', ids)
        .groupBy('hold_id')
        .execute(),
      db
        .selectFrom('quality.hold_incident')
        .select(['hold_id', sql<number>`count(*)::int`.as('n')])
        .where('hold_id', 'in', ids)
        .groupBy('hold_id')
        .execute(),
    ]);
    const scopes = new Map(units.map((u) => [u.hold_id, u]));
    const consumed = new Map(incidents.map((i) => [i.hold_id, i.n]));
    return rows.map((row) => {
      const scope = scopes.get(row.id);
      return {
        id: row.id,
        subject: { kind: row.subject_kind, id: row.subject_id },
        state: row.state,
        reason: row.reason,
        openedBy: row.opened_by,
        openedAt: row.opened_at,
        openedPlantAt: row.opened_plant_at,
        decidedBy: row.decided_by,
        decidedAt: row.decided_at,
        decidedPlantAt: row.decided_plant_at,
        decisionReason: row.decision_reason,
        transitions: row.transitions,
        version: row.version,
        scope: {
          units: scope?.units ?? 0,
          cartons: scope?.cartons ?? 0,
          orders: scope?.orders ?? 0,
        },
        heldMaterialConsumed: consumed.get(row.id) ?? 0,
      };
    });
  }

  #emit(change: HoldChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error({ err: error }, 'holds listener failed');
      }
    }
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

/** Takes the advisory lock hold opening and order close share (transaction-level). */
async function lockHolds(trx: Transaction<Database>): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${HOLD_CLOSE_LOCK}::bigint)`.execute(trx);
}

const transitionOf = (kind: Exclude<HoldTransitionKind, 'commented'>): QualityHoldTransition =>
  kind;

function toIncident(row: Selectable<HoldIncidentTable>): HoldIncidentRecord {
  return {
    id: row.id,
    type: row.type,
    lot: row.lot,
    equipment: row.equipment,
    epoch: row.epoch,
    seq: row.seq,
    partId: row.part_id,
    operation: row.operation,
    pass: row.pass,
    consumedAt: row.consumed_at,
    message: row.message,
    detectedAt: row.detected_at,
  };
}

function distinct(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))].sort(byText);
}

function distinctNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function byEpoch(keys: readonly { epoch: number; partId: number }[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const k of keys) {
    const parts = out.get(k.epoch);
    if (parts) parts.push(k.partId);
    else out.set(k.epoch, [k.partId]);
  }
  for (const parts of out.values()) parts.sort((a, b) => a - b);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id: string): boolean => UUID.test(id);
