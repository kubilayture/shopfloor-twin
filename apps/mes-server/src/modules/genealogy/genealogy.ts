import { BLANK_OPERATION } from '@shopfloor/contracts/mes-api';
import type { LotList } from '@shopfloor/contracts/erp-api';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { Counter, Histogram, type Registry } from 'prom-client';
import type { Database } from '../../db/database.ts';
import { DERIVED_WORK_BUCKETS } from '../../metrics.ts';
import type { UnitRecord } from '../execution/index.ts';
import type { CycleFact, DeviceProgress } from '../ingest/index.ts';
import type { EquipmentInfo, Routing } from '../master-data/index.ts';
import type { OrderRecord } from '../orders/index.ts';
import {
  finality,
  finalThrough,
  mismatches,
  placeCartons,
  traceUnit,
  type BomLine,
  type Carton,
  type LotLink,
  type LotRef,
  type PlacedPack,
  type TracedRecord,
} from './derive.ts';
import type {
  CartonTable,
  GenealogyIncidentTable,
  GenealogyIncidentType,
  LotStatus,
  MaterialLotTable,
  SerialUnitTable,
  UnitRecordTable,
} from './tables.ts';

/** What the genealogy module reads of ingest (#199). */
export interface GenealogyIngest {
  cycleFacts(options: {
    readonly epoch: number;
    readonly partIds?: readonly number[];
    readonly equipment?: string;
  }): Promise<CycleFact[]>;
  cycleFactCounts(): Promise<
    readonly { readonly equipment: string; readonly epoch: number; readonly facts: number }[]
  >;
}

/** What it reads of the execution module: units, which it follows, and how far they are. */
export interface GenealogyExecution {
  onUnits(listener: (epoch: number, partIds: readonly number[]) => void): () => void;
  processedThrough(): ReadonlyMap<string, DeviceProgress>;
  units(query: {
    readonly epoch: number;
    readonly partIds: readonly number[];
    readonly limit: number;
  }): Promise<{ units: UnitRecord[] }>;
  /** Every unit's order and status, without records (the catch-up's comparison). */
  unitStates(): Promise<
    readonly {
      readonly epoch: number;
      readonly partId: number;
      readonly orderId: string | null;
      readonly status: UnitRecord['status'];
    }[]
  >;
}

/** The ERP's lot list (`ErpClient.lots`, #198). */
export interface GenealogyErp {
  lots(): Promise<LotList>;
}

/** A crew row as the shifts module reports it (shown, not reconciled). */
export interface GenealogyCrew {
  readonly userId: number;
  readonly username: string;
  readonly fromPlant: Date;
  readonly toPlant: Date | null;
}

export interface GenealogyLog {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface GenealogyOptions {
  readonly db: Kysely<Database>;
  /** The API's pool for reads (default `db`). */
  readonly readDb?: Kysely<Database>;
  readonly ingest: GenealogyIngest;
  readonly execution: GenealogyExecution;
  readonly orders: { order(id: string): Promise<OrderRecord | undefined> };
  readonly masterData: {
    equipment(): Promise<EquipmentInfo[]>;
    routings(): Promise<Routing[]>;
  };
  /** The crew signed on to a work center (`Shifts.crew`); none without it. */
  readonly crew?: (
    workCenter: string,
    span: { readonly from: Date; readonly to: Date },
  ) => Promise<readonly GenealogyCrew[]>;
  /** The ERP's lot list; without it no lot is imported. */
  readonly erp?: GenealogyErp;
  /** The packing rule's configuration (`config/plant/packing.yaml`). */
  readonly packing: {
    readonly operation: string;
    readonly capacity: Readonly<Record<string, number>>;
  };
  /** How often the lot list is imported (the ERP poll, 10 s); 0: only `importLots()`. */
  readonly lotPollMs?: number;
  /** How often units and cartons are brought up to date (1 s; a change brings one forward by 250 ms); 0: only `tick()`. */
  readonly tickMs?: number;
  readonly registry?: Registry;
  readonly log?: GenealogyLog;
  /**
   * Called with the raw timing of every round (`mes_genealogy_round_seconds`, #238: the budget
   * tests compute their percentiles from these).
   */
  readonly onTiming?: (timing: { readonly metric: 'round'; readonly seconds: number }) => void;
}

/** A unit as a trace answers it. */
export interface TraceUnitRecord {
  readonly epoch: number;
  readonly partId: number;
  readonly serial: string | null;
  readonly product: string;
  readonly orderId: string | null;
  readonly status: SerialUnitTable['status'];
  readonly carton: string | null;
  readonly records: readonly (TracedRecord & {
    readonly epoch: number;
    readonly crew: readonly GenealogyCrew[];
  })[];
}

/** A unit as a forward trace or a carton lists it. */
export interface UnitRef {
  readonly epoch: number;
  readonly partId: number;
  readonly serial: string | null;
  readonly orderId: string | null;
  readonly carton: string | null;
  readonly status: SerialUnitTable['status'];
}

export interface Finality {
  readonly final: boolean;
  readonly notFinal: readonly string[];
}

export interface MaterialLot {
  readonly id: string;
  readonly material: string;
  readonly quantity: number;
  readonly status: LotStatus;
  readonly importedAt: Date;
}

export interface SerialTrace extends Finality {
  readonly serial: string;
  readonly units: readonly TraceUnitRecord[];
}

export interface LotTrace extends Finality {
  readonly lot: string;
  readonly material: string;
  readonly master: MaterialLot | null;
  readonly consumed: number;
  readonly units: readonly UnitRef[];
  readonly truncated: boolean;
  readonly orders: readonly string[];
  readonly cartons: readonly string[];
  readonly withLots: readonly LotRef[];
}

export interface CartonRecord {
  readonly id: string;
  readonly orderId: string;
  readonly number: number;
  readonly product: string;
  readonly capacity: number;
  readonly status: 'open' | 'closed';
  readonly closedAt: Date | null;
  readonly members: number;
}

export interface CartonTrace extends Finality {
  readonly carton: CartonRecord;
  readonly units: readonly UnitRef[];
  readonly lots: readonly LotRef[];
}

export interface GenealogyIncident {
  readonly id: number;
  readonly type: GenealogyIncidentType;
  readonly lot: string | null;
  readonly epoch: number | null;
  readonly partId: number | null;
  readonly equipment: string | null;
  readonly message: string;
  readonly detectedAt: Date;
  readonly closedAt: Date | null;
  readonly resolution: string | null;
}

export type SearchKind = 'serial' | 'lot' | 'carton' | 'order';

/** What a quality hold is on (#201): its scope follows the genealogy. */
export interface ScopeSubject {
  readonly kind: 'lot' | 'serial' | 'carton' | 'order';
  readonly id: string;
}

/** A consumption of a lot by a unit's cycle (a `lot-unit` link), with the fact it came from. */
export interface LotConsumption {
  readonly epoch: number;
  readonly partId: number;
  readonly equipment: string;
  readonly seq: number;
  readonly operation: string;
  readonly pass: number;
  readonly at: Date;
}

const PART_BATCH = 300;
/** Units a forward trace or a carton answers at most. */
export const TRACE_UNIT_LIMIT = 5_000;

/**
 * A round of genealogy rebuilt units (#203) or rewrote an order's cartons (#238: hold scopes are
 * rebuilt on it, and a carton's members are part of a scope).
 */
export interface GenealogyChange {
  readonly type: 'units';
}

/** A machine's last cycle that reported lots, with them (#203). */
export interface LastLots {
  readonly equipment: string;
  readonly operation: string;
  readonly epoch: number;
  readonly partId: number;
  readonly serial: string | null;
  readonly pass: number;
  readonly seq: number;
  readonly at: Date;
  readonly lots: readonly { readonly lot: string; readonly material: string | null }[];
}
const silent: GenealogyLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A subject's key while {@link Genealogy.scopes} groups its rows. */
const scopeKey = (subject: ScopeSubject): string => `${subject.kind}\u0000${subject.id}`;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/**
 * The `genealogy` module (#199, Phase 8 plan "Genealogy", ADR-0034): lots imported from the ERP's
 * lot list, every unit (device epoch, partId) with its serial, the lots each of its cycles
 * consumed (`lot-unit` links per operation and pass), the device operator and reading per record,
 * cartons formed by the packing rule on final data (`unit-carton` links), incidents, and the trace
 * queries with their finality. It follows the execution module's units (`onUnits`), rebuilding a
 * unit's rows from its records and cycle facts, never patching them; its processed watermark is
 * the execution round's it has caught up with.
 */
export class Genealogy {
  readonly #db: Kysely<Database>;
  readonly #readDb: Kysely<Database>;
  readonly #options: GenealogyOptions;
  readonly #log: GenealogyLog;
  readonly #timers: NodeJS.Timeout[] = [];
  /** Units the execution module announced, by epoch. */
  readonly #dirty = new Map<number, Set<number>>();
  /** Orders whose cartons may have changed. */
  readonly #dirtyOrders = new Set<string>();
  /** Orders with a pack not placed yet or a carton still open: placed again every round. */
  readonly #unsettled = new Set<string>();
  /**
   * Units with a material the BOM may not list whose order is not final yet (their first
   * operation's machine not final through it): rebuilt every round until it is.
   */
  readonly #unjudged = new Map<number, Set<number>>();
  /**
   * Units whose rebuild failed on their own (review of PR #219, round 2): retried in later rounds
   * with a backoff (`wait` rounds skipped, doubling up to 31); while one is pending, the processed
   * watermark stays below its facts (`#capped`).
   */
  readonly #failed = new Map<
    string,
    { readonly epoch: number; readonly partId: number; attempts: number; wait: number }
  >();
  /**
   * Units with a good packing cycle whose order is not final yet (`#attributionFinal`), by unit:
   * no order's pack is placed at or after the earliest of them (a late job fact could still move
   * that unit into any order, also one of another CNC).
   */
  readonly #unattributed = new Map<
    string,
    {
      readonly epoch: number;
      readonly pack: { readonly at: number; readonly seq: number; readonly partId: number };
      readonly records: readonly { operation: string; equipment: string; seq: number }[];
    }
  >();
  readonly #rebuilt: Counter | undefined;
  readonly #incidents: Counter | undefined;
  readonly #rounds: Histogram | undefined;
  /** Every machine's progress as the execution round genealogy last caught up with read it. */
  #processed: ReadonlyMap<string, DeviceProgress> = new Map();
  #machines: string[] = [];
  #firstOperation = '';
  #workCenterOf = new Map<string, string>();
  #bomOf = new Map<string, BomLine[]>();
  #idealCycle = new Map<string, Map<string, number>>();
  #queue: Promise<unknown> = Promise.resolve();
  #started = false;
  #stopping = false;
  #kick: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #listeners = new Set<(change: GenealogyChange) => void>();
  /**
   * Per machine, its newest cycle with lots (#203 review): loaded once at start, then kept as
   * units are stored, so the terminal never reads a machine's history. Machines that never
   * reported a lot have no entry.
   */
  readonly #lastLots = new Map<string, LastLots>();

  constructor(options: GenealogyOptions) {
    this.#options = options;
    this.#db = options.db;
    this.#readDb = options.readDb ?? options.db;
    this.#log = options.log ?? silent;
    const registers = options.registry ? [options.registry] : [];
    if (registers.length > 0) {
      this.#rebuilt = new Counter({
        name: 'mes_genealogy_units_rebuilt_total',
        help: 'Units whose genealogy (records, lot links) was rebuilt',
        registers,
      });
      this.#incidents = new Counter({
        name: 'mes_genealogy_incidents_total',
        help: 'Genealogy incidents raised, by type',
        labelNames: ['type'] as const,
        registers,
      });
      this.#rounds = new Histogram({
        name: 'mes_genealogy_round_seconds',
        help: 'One genealogy round (units rebuilt, cartons placed), without the work its listeners defer',
        buckets: [...DERIVED_WORK_BUCKETS],
        registers,
      });
    }
  }

  /**
   * Loads the machines and BOMs, follows the execution module's units, imports the ERP's lot list
   * once, catches up from the tables (every unit of the newest device run, and of older runs whose
   * records lag their cycle facts; every order's cartons) and starts the timers.
   */
  async start(): Promise<void> {
    await this.#loadMaster();
    await this.#loadLastLots();
    this.follow();
    this.#started = true;
    if (this.#options.erp) {
      await this.importLots().catch((error: unknown) => {
        this.#log.warn({ err: error }, 'genealogy: importing the ERP lot list failed; retrying');
      });
    }
    await this.#serial(() => this.#catchUp());
    await this.tick();
    const period = this.#options.tickMs ?? 1_000;
    if (period > 0) {
      const timer = setInterval(() => {
        this.tick().catch((error: unknown) => {
          this.#log.error({ err: error }, 'genealogy: tick failed');
        });
      }, period);
      timer.unref();
      this.#timers.push(timer);
    }
    const poll = this.#options.lotPollMs ?? 10_000;
    if (this.#options.erp && poll > 0) {
      const timer = setInterval(() => {
        this.importLots().catch((error: unknown) => {
          this.#log.warn({ err: error }, 'genealogy: importing the ERP lot list failed');
        });
      }, poll);
      timer.unref();
      this.#timers.push(timer);
    }
  }

  /**
   * Starts buffering the units the execution module announces (#199 review, M4): called before
   * `Execution.start()`, so the units its catch-up and first round rebuild are not missed; `start()`
   * calls it too. Idempotent.
   */
  follow(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#options.execution.onUnits((epoch, partIds) => {
      this.#mark(epoch, partIds);
      this.#soon();
    });
  }

  get started(): boolean {
    return this.#started;
  }

  #mark(epoch: number, partIds: Iterable<number>): void {
    let parts = this.#dirty.get(epoch);
    if (!parts) {
      parts = new Set();
      this.#dirty.set(epoch, parts);
    }
    for (const id of partIds) parts.add(id);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    clearTimeout(this.#kick);
    this.#unsubscribe?.();
    await this.#queue.catch(() => undefined);
  }

  /**
   * One round: the execution module's progress first (what it has handled is in the units it
   * announced, taken next), then the announced units rebuilt, then the cartons of every order
   * whose units changed or that has a pack not placed yet or an open carton. On success the
   * processed watermark moves to that progress.
   */
  async tick(): Promise<void> {
    if (!this.#started || this.#stopping) return;
    await this.#serial(async () => {
      const started = performance.now();
      // Read before the units are taken: every unit the execution round changed up to this
      // progress was announced before it completed, so it is in the set taken below (#199).
      const watermark = this.#options.execution.processedThrough();
      for (const failed of this.#failed.values()) {
        if (failed.wait > 0) failed.wait--;
        else this.#mark(failed.epoch, [failed.partId]);
      }
      for (const [epoch, parts] of this.#unjudged) {
        const pending = this.#dirty.get(epoch) ?? new Set<number>();
        for (const id of parts) pending.add(id);
        this.#dirty.set(epoch, pending);
      }
      this.#unjudged.clear();
      const dirty = [...this.#dirty].map(([epoch, parts]) => [epoch, [...parts]] as const);
      this.#dirty.clear();
      let orders: string[] = [];
      try {
        for (const [epoch, parts] of dirty) await this.#rebuild(epoch, parts, watermark);
        orders = [...new Set([...this.#dirtyOrders, ...this.#unsettled])].sort();
        this.#dirtyOrders.clear();
        // Cartons are placed with the progress held below failing units (review round 3): a
        // unit whose rebuild keeps failing has no rows, so its pack would otherwise be skipped
        // and a later unit take its place in a carton that closes.
        const processed = await this.#capped(watermark);
        const cutoff = this.#placementCutoff(processed);
        let cartons = false;
        for (const id of orders)
          cartons = (await this.#placeOrder(id, processed, cutoff)) || cartons;
        this.#processed = processed;
        const seconds = (performance.now() - started) / 1_000;
        this.#rounds?.observe(seconds);
        this.#options.onTiming?.({ metric: 'round', seconds });
        // Listeners are told after the round is timed: what they do is theirs (#238).
        if (dirty.length > 0 || cartons) this.#emit({ type: 'units' });
      } catch (error) {
        // What this round took is put back, so a failed round (a lost connection, a deadlock)
        // loses no unit or order it heard of.
        for (const [epoch, parts] of dirty) {
          const pending = this.#dirty.get(epoch) ?? new Set<number>();
          for (const id of parts) pending.add(id);
          this.#dirty.set(epoch, pending);
        }
        for (const id of orders) this.#dirtyOrders.add(id);
        throw error;
      }
    });
  }

  /**
   * Imports the ERP's lot list (plan "Lots from the ERP"): every lot upserted by id in one
   * transaction (material, quantity and status follow the list; a lot no longer listed is kept as
   * `retired`), and `unknown-lot` incidents of lots now listed closed, their units rebuilt (the
   * material check now has the lot). Returns the lots listed.
   */
  async importLots(): Promise<number> {
    const erp = this.#options.erp;
    if (!erp) return 0;
    const list = await erp.lots();
    const ids = list.lots.map((l) => l.id);
    const changed: string[] = [];
    const known = await this.#db.transaction().execute(async (trx) => {
      const existing = new Map(
        (await trx.selectFrom('genealogy.material_lot').selectAll().forUpdate().execute()).map(
          (row) => [row.id, row],
        ),
      );
      for (const lot of list.lots) {
        const before = existing.get(lot.id);
        if (before && before.material !== lot.material) {
          // Logged once: the stored material follows the list, so the next import is equal. The
          // lot's units are judged again against the material the ERP lists now (review L8).
          this.#log.warn(
            { lot: lot.id, was: before.material, now: lot.material },
            'genealogy: the ERP changed a lot’s material',
          );
          changed.push(lot.id);
        }
        if (
          before?.quantity === lot.quantity &&
          before.material === lot.material &&
          before.status === 'active' &&
          before.feed_id === list.feedId
        ) {
          continue;
        }
        await trx
          .insertInto('genealogy.material_lot')
          .values({
            id: lot.id,
            material: lot.material,
            quantity: lot.quantity,
            status: 'active',
            feed_id: list.feedId,
          })
          .onConflict((c) =>
            c.column('id').doUpdateSet({
              material: lot.material,
              quantity: lot.quantity,
              status: 'active',
              feed_id: list.feedId,
              updated_at: sql<Date>`clock_timestamp()`,
            }),
          )
          .execute();
      }
      let retire = trx
        .updateTable('genealogy.material_lot')
        .set({ status: 'retired', updated_at: sql<Date>`clock_timestamp()` })
        .where('status', '=', 'active');
      if (ids.length > 0) retire = retire.where('id', 'not in', ids);
      await retire.execute();
      if (ids.length === 0) return [];
      return trx
        .updateTable('genealogy.genealogy_incident')
        .set({
          closed_at: sql<Date>`clock_timestamp()`,
          resolution: 'imported from the ERP’s lot list',
        })
        .where('type', '=', 'unknown-lot')
        .where('closed_at', 'is', null)
        .where('lot', 'in', ids)
        .returning('lot')
        .execute();
    });
    // The units of lots that were unknown or changed material: rebuilt, so the lot's listed
    // material is checked.
    const lots = [
      ...new Set([
        ...known.map((row) => row.lot).filter((lot): lot is string => lot !== null),
        ...changed,
      ]),
    ];
    if (lots.length > 0) {
      const units = await this.#db
        .selectFrom('genealogy.genealogy_link')
        .select(['epoch', 'part_id'])
        .distinct()
        .where('kind', '=', 'lot-unit')
        .where('lot', 'in', lots)
        .execute();
      for (const unit of units) this.#mark(unit.epoch, [unit.part_id]);
      this.#soon();
    }
    return list.lots.length;
  }

  // ---- the processed watermark (#201's close guard, plan review round 2 HIGH C) ----

  /**
   * Genealogy's contiguous processed-through sequence of a machine in a device epoch: the
   * machine's final-through (`settledSeq`, ADR-0018) as the execution round genealogy caught up
   * with read it. Every number up to it was received or written off as a gap (a reported gap
   * counts: its facts are not coming), and every fact received up to it is reflected in the links;
   * so it moves on past a written-off gap (review H1; `receivedThrough` would stop at the gap for
   * the rest of the epoch). A fact of a written-off gap that arrives after all is a late fact
   * (ADR-0018) and moves nothing back. `null` when nothing of that epoch is processed yet; an
   * epoch older than the machine's newest processed one counts as processed through every number.
   */
  processedThrough(equipment: string, epoch: number): number | null {
    const device = this.#processed.get(equipment);
    if (device?.epoch === null || device?.epoch === undefined) return null;
    if (device.epoch > epoch) return Number.MAX_SAFE_INTEGER;
    if (device.epoch < epoch) return null;
    return device.settledSeq;
  }

  /** Whether every one of these facts is at or below genealogy's processed watermark. */
  covers(
    facts: readonly { readonly equipment: string; readonly epoch: number; readonly seq: number }[],
  ): boolean {
    return facts.every((f) => {
      const through = this.processedThrough(f.equipment, f.epoch);
      return through !== null && through >= f.seq;
    });
  }

  // ---- a hold's scope (#201, plan "Quality holds") ----

  /**
   * The units a hold's subject covers through the genealogy now (plan "Quality holds"): a lot, every
   * unit that consumed it at any operation and pass; a serial, every unit with it; a carton, its
   * members; an order, its units; each with its order and carton. With `orderId`, only the units of
   * that order (the close guard's question). Reads `db` (the caller's transaction, for the close
   * guard under its lock), by (epoch, partId).
   */
  async scope(
    subject: ScopeSubject,
    options: { readonly orderId?: string; readonly db?: Kysely<Database> } = {},
  ): Promise<UnitRef[]> {
    const db = options.db ?? this.#readDb;
    let select = db
      .selectFrom('genealogy.serial_unit as u')
      .select(['u.epoch', 'u.part_id', 'u.serial', 'u.order_id', 'u.carton_id', 'u.status']);
    if (subject.kind === 'lot') {
      select = select.where((eb) =>
        eb.exists(
          eb
            .selectFrom('genealogy.genealogy_link as l')
            .select('l.part_id')
            .where('l.kind', '=', 'lot-unit')
            .where('l.lot', '=', subject.id)
            .whereRef('l.epoch', '=', 'u.epoch')
            .whereRef('l.part_id', '=', 'u.part_id'),
        ),
      );
    } else if (subject.kind === 'serial') {
      select = select.where('u.serial', '=', subject.id);
    } else if (subject.kind === 'carton') {
      select = select.where('u.carton_id', '=', subject.id);
    } else {
      select = select.where('u.order_id', '=', subject.id);
    }
    if (options.orderId !== undefined) select = select.where('u.order_id', '=', options.orderId);
    const rows = await select.orderBy('u.epoch').orderBy('u.part_id').execute();
    return rows.map((r) => ({
      epoch: r.epoch,
      partId: r.part_id,
      serial: r.serial,
      orderId: r.order_id,
      carton: r.carton_id,
      status: r.status,
    }));
  }

  /**
   * The scopes of many subjects at once (#238: every open hold's scope rebuilt on a change, in a
   * query per subject kind rather than one per hold): one list per subject, in their order, each
   * as {@link scope} answers it, in (epoch, partId) order.
   */
  async scopes(
    subjects: readonly ScopeSubject[],
    db: Kysely<Database> = this.#readDb,
  ): Promise<UnitRef[][]> {
    const result = new Map<string, UnitRef[]>(subjects.map((s) => [scopeKey(s), []]));
    const ids = (kind: ScopeSubject['kind']): string[] => [
      ...new Set(subjects.filter((s) => s.kind === kind).map((s) => s.id)),
    ];
    const add = (
      kind: ScopeSubject['kind'],
      rows: readonly {
        readonly subject: string | null;
        readonly epoch: number;
        readonly part_id: number;
        readonly serial: string | null;
        readonly order_id: string | null;
        readonly carton_id: string | null;
        readonly status: UnitRef['status'];
      }[],
    ): void => {
      for (const r of rows) {
        if (r.subject === null) continue;
        result.get(scopeKey({ kind, id: r.subject }))?.push({
          epoch: r.epoch,
          partId: r.part_id,
          serial: r.serial,
          orderId: r.order_id,
          carton: r.carton_id,
          status: r.status,
        });
      }
    };
    const columns = [
      'u.epoch',
      'u.part_id',
      'u.serial',
      'u.order_id',
      'u.carton_id',
      'u.status',
    ] as const;
    for (const chunk of chunks(ids('lot'), 5_000)) {
      add(
        'lot',
        await db
          .selectFrom('genealogy.serial_unit as u')
          .innerJoin(
            (eb) =>
              eb
                .selectFrom('genealogy.genealogy_link')
                .select(['lot', 'epoch', 'part_id'])
                .distinct()
                .where('kind', '=', 'lot-unit')
                .where('lot', 'in', chunk)
                .as('l'),
            (j) => j.onRef('l.epoch', '=', 'u.epoch').onRef('l.part_id', '=', 'u.part_id'),
          )
          .select(['l.lot as subject', ...columns])
          .execute(),
      );
    }
    for (const [kind, column] of [
      ['serial', 'u.serial'],
      ['carton', 'u.carton_id'],
      ['order', 'u.order_id'],
    ] as const) {
      for (const chunk of chunks(ids(kind), 5_000)) {
        add(
          kind,
          await db
            .selectFrom('genealogy.serial_unit as u')
            .select([`${column} as subject`, ...columns])
            .where(column, 'in', chunk)
            .execute(),
        );
      }
    }
    for (const units of result.values()) {
      units.sort((a, b) => a.epoch - b.epoch || a.partId - b.partId);
    }
    // A subject listed twice gets the same list (they are the same scope).
    return subjects.map((subject) => result.get(scopeKey(subject)) ?? []);
  }

  /** {@link lotConsumptions} of many lots at once (#238), by lot, each in plant-time order. */
  async lotsConsumptions(
    lots: readonly string[],
    db: Kysely<Database> = this.#readDb,
  ): Promise<Map<string, LotConsumption[]>> {
    const result = new Map<string, LotConsumption[]>(lots.map((lot) => [lot, []]));
    for (const chunk of chunks([...new Set(lots)], 5_000)) {
      const rows = await db
        .selectFrom('genealogy.genealogy_link')
        .select(['lot', 'epoch', 'part_id', 'equipment', 'seq', 'operation', 'pass', 'at'])
        .where('kind', '=', 'lot-unit')
        .where('lot', 'in', chunk)
        .orderBy('lot')
        .orderBy('at')
        .orderBy('epoch')
        .orderBy('equipment')
        .orderBy('seq')
        .execute();
      for (const r of rows) {
        if (
          r.lot === null ||
          r.equipment === null ||
          r.seq === null ||
          r.operation === null ||
          r.pass === null
        ) {
          continue;
        }
        result.get(r.lot)?.push({
          epoch: r.epoch,
          partId: r.part_id,
          equipment: r.equipment,
          seq: r.seq,
          operation: r.operation,
          pass: r.pass,
          at: r.at,
        });
      }
    }
    return result;
  }

  /**
   * The cycle facts among these that genealogy has not recorded for their unit (no `unit_record`
   * with that fact's key and part): #201's close guard (review of PR #222, H1). The processed
   * watermark counts a written-off number as settled, so a late fact of a written-off gap is below
   * it before genealogy has rebuilt its unit; this asks the records themselves. Reads `db` (the
   * close's transaction).
   */
  async unrecorded<
    F extends {
      readonly equipment: string;
      readonly epoch: number;
      readonly seq: number;
      readonly partId: number;
    },
  >(facts: readonly F[], db: Kysely<Database> = this.#readDb): Promise<F[]> {
    const recorded = new Set<string>();
    const parts = new Map<number, Set<number>>();
    for (const f of facts) {
      const set = parts.get(f.epoch) ?? new Set<number>();
      set.add(f.partId);
      parts.set(f.epoch, set);
    }
    for (const [epoch, set] of parts) {
      const ids = [...set];
      for (let i = 0; i < ids.length; i += 5_000) {
        const rows = await db
          .selectFrom('genealogy.unit_record')
          .select(['equipment', 'seq', 'part_id'])
          .where('epoch', '=', epoch)
          .where('part_id', 'in', ids.slice(i, i + 5_000))
          .execute();
        for (const r of rows) {
          recorded.add(`${r.equipment}/${String(epoch)}/${String(r.seq)}/${String(r.part_id)}`);
        }
      }
    }
    return facts.filter(
      (f) =>
        !recorded.has(`${f.equipment}/${String(f.epoch)}/${String(f.seq)}/${String(f.partId)}`),
    );
  }

  /** Every consumption of a lot (its `lot-unit` links), in plant-time order. */
  async lotConsumptions(
    lot: string,
    db: Kysely<Database> = this.#readDb,
  ): Promise<LotConsumption[]> {
    const rows = await db
      .selectFrom('genealogy.genealogy_link')
      .select(['epoch', 'part_id', 'equipment', 'seq', 'operation', 'pass', 'at'])
      .where('kind', '=', 'lot-unit')
      .where('lot', '=', lot)
      .orderBy('at')
      .orderBy('epoch')
      .orderBy('equipment')
      .orderBy('seq')
      .execute();
    const consumptions: LotConsumption[] = [];
    for (const r of rows) {
      if (r.equipment === null || r.seq === null || r.operation === null || r.pass === null)
        continue;
      consumptions.push({
        epoch: r.epoch,
        partId: r.part_id,
        equipment: r.equipment,
        seq: r.seq,
        operation: r.operation,
        pass: r.pass,
        at: r.at,
      });
    }
    return consumptions;
  }

  /** Units by key, with serial, order, carton and status (those genealogy knows). */
  async units(keys: readonly { epoch: number; partId: number }[]): Promise<UnitRef[]> {
    return this.#unitRefs(keys);
  }

  /**
   * Whether every machine is final through plant time `at` in each of these device epochs by the
   * progress genealogy has processed (a hold notification's `scopeFinal`, #201); with no epoch,
   * in each machine's newest processed epoch.
   */
  finalityAt(at: Date, epochs: readonly number[]): Finality {
    const list =
      epochs.length > 0
        ? epochs
        : [
            ...new Set(
              [...this.#processed.values()]
                .map((p) => p.epoch)
                .filter((e): e is number => e !== null),
            ),
          ];
    if (list.length === 0) return { final: false, notFinal: [...this.#machines] };
    return this.#finality(list.map((epoch) => ({ epoch, at })));
  }

  // ---- reads ----

  /** Backward: every unit with this serial, newest epoch first; undefined when none. */
  async serial(serial: string): Promise<SerialTrace | undefined> {
    const rows = await this.#readDb
      .selectFrom('genealogy.serial_unit')
      .selectAll()
      .where('serial', '=', serial)
      .orderBy('epoch', 'desc')
      .orderBy('part_id')
      .execute();
    if (rows.length === 0) return undefined;
    const units = await this.#traceUnits(rows);
    return {
      serial,
      units,
      ...this.#finality(units.flatMap((u) => u.records)),
    };
  }

  /** Backward traces of units by key (the golden reconciliation and the API's serial page). */
  async unitTraces(epoch: number, partIds: readonly number[]): Promise<TraceUnitRecord[]> {
    if (partIds.length === 0) return [];
    const rows = await this.#readDb
      .selectFrom('genealogy.serial_unit')
      .selectAll()
      .where('epoch', '=', epoch)
      .where('part_id', 'in', [...partIds])
      .orderBy('part_id')
      .execute();
    return this.#traceUnits(rows);
  }

  /** Forward: the units, orders and cartons that consumed a lot; undefined when unknown. */
  async lot(id: string): Promise<LotTrace | undefined> {
    const master = await this.#readDb
      .selectFrom('genealogy.material_lot')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    const links = await this.#readDb
      .selectFrom('genealogy.genealogy_link')
      .select(['epoch', 'part_id', 'material'])
      .where('kind', '=', 'lot-unit')
      .where('lot', '=', id)
      .orderBy('epoch')
      .orderBy('part_id')
      .execute();
    if (!master && links.length === 0) return undefined;
    const keys = uniqueUnits(links);
    const kept = keys.slice(0, TRACE_UNIT_LIMIT);
    const units = await this.#unitRefs(kept);
    const orders = new Set<string>();
    const cartons = new Set<string>();
    for (const unit of units) {
      if (unit.orderId !== null) orders.add(unit.orderId);
      if (unit.carton !== null) cartons.add(unit.carton);
    }
    const others = new Map<string, LotRef>();
    for (const [epoch, parts] of byEpoch(kept)) {
      for (let i = 0; i < parts.length; i += 5_000) {
        const rows = await this.#readDb
          .selectFrom('genealogy.genealogy_link')
          .select(['lot', 'material'])
          .distinct()
          .where('kind', '=', 'lot-unit')
          .where('epoch', '=', epoch)
          .where('part_id', 'in', parts.slice(i, i + 5_000))
          .where('lot', '<>', id)
          .execute();
        for (const row of rows) {
          if (row.lot !== null && row.material !== null) {
            others.set(row.lot, { material: row.material, lot: row.lot });
          }
        }
      }
    }
    return {
      lot: id,
      material: master?.material ?? links[0]?.material ?? '',
      master: master ? toLot(master) : null,
      consumed: links.length,
      units,
      truncated: keys.length > kept.length,
      orders: [...orders].sort(byText),
      cartons: [...cartons].sort(byText),
      withLots: [...others.values()].sort((a, b) => byText(a.lot, b.lot)),
      ...this.#finality(await this.#latestRecords(kept)),
    };
  }

  /** A carton with its members in placement order; undefined when unknown. */
  async carton(id: string): Promise<CartonTrace | undefined> {
    const row = await this.#readDb
      .selectFrom('genealogy.carton')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    const members = await this.#readDb
      .selectFrom('genealogy.genealogy_link')
      .select(['epoch', 'part_id'])
      .where('kind', '=', 'unit-carton')
      .where('carton_id', '=', id)
      .orderBy('position')
      .execute();
    const keys = members.map((m) => ({ epoch: m.epoch, partId: m.part_id }));
    const refs = new Map(
      (await this.#unitRefs(keys)).map((u) => [`${String(u.epoch)}/${String(u.partId)}`, u]),
    );
    const lots = new Map<string, LotRef>();
    for (const [epoch, parts] of byEpoch(keys)) {
      const rows = await this.#readDb
        .selectFrom('genealogy.genealogy_link')
        .select(['lot', 'material'])
        .distinct()
        .where('kind', '=', 'lot-unit')
        .where('epoch', '=', epoch)
        .where('part_id', 'in', parts)
        .execute();
      for (const r of rows) {
        if (r.lot !== null && r.material !== null)
          lots.set(r.lot, { material: r.material, lot: r.lot });
      }
    }
    return {
      carton: toCarton(row),
      units: keys
        .map((k) => refs.get(`${String(k.epoch)}/${String(k.partId)}`))
        .filter((u): u is UnitRef => u !== undefined),
      lots: [...lots.values()].sort((a, b) => byText(a.lot, b.lot)),
      ...this.#finality(await this.#latestRecords(keys)),
    };
  }

  /** Every carton of an order (or all), by order and number. */
  async cartons(query: { readonly orderId?: string } = {}): Promise<CartonRecord[]> {
    let select = this.#readDb.selectFrom('genealogy.carton').selectAll();
    if (query.orderId !== undefined) select = select.where('order_id', '=', query.orderId);
    const rows = await select.orderBy('order_id').orderBy('number').execute();
    return rows.map(toCarton);
  }

  /** The members of every carton (or of an order's), in placement order, by carton id. */
  async cartonMembers(
    query: { readonly orderId?: string } = {},
  ): Promise<Map<string, { epoch: number; partId: number }[]>> {
    let select = this.#readDb
      .selectFrom('genealogy.genealogy_link as l')
      .innerJoin('genealogy.carton as c', 'c.id', 'l.carton_id')
      .select(['l.carton_id', 'l.epoch', 'l.part_id'])
      .where('l.kind', '=', 'unit-carton');
    if (query.orderId !== undefined) select = select.where('c.order_id', '=', query.orderId);
    const rows = await select.orderBy('l.carton_id').orderBy('l.position').execute();
    const members = new Map<string, { epoch: number; partId: number }[]>();
    for (const row of rows) {
      const id = row.carton_id ?? '';
      members.set(id, [...(members.get(id) ?? []), { epoch: row.epoch, partId: row.part_id }]);
    }
    return members;
  }

  /**
   * Called after a round that rebuilt units or rewrote an order's cartons (#203: the terminal's
   * lots in use follow it; #238: the hold scopes are rebuilt on it), after the round is timed and
   * inside its queue: a listener that has work to do defers it. Returns the unsubscribe.
   */
  onChange(listener: (change: GenealogyChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change: GenealogyChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error({ err: error }, 'genealogy listener failed');
      }
    }
  }

  /**
   * Per machine, its last cycle that consumed lots (newest epoch, then device sequence), as
   * genealogy has stored it (#203: the terminal's "lots in use"; a round behind the facts), from
   * memory. Machines that never reported a lot are left out.
   */
  lastLots(equipment: readonly string[]): Promise<LastLots[]> {
    return Promise.resolve(
      equipment.flatMap((machine) => {
        const found = this.#lastLots.get(machine);
        return found ? [found] : [];
      }),
    );
  }

  /** Each machine's newest cycle with lots from the tables (the link index backwards). */
  async #loadLastLots(): Promise<void> {
    for (const machine of this.#machines) {
      const newest = await this.#readDb
        .selectFrom('genealogy.genealogy_link')
        .select(['epoch', 'seq', 'part_id'])
        .where('kind', '=', 'lot-unit')
        .where('equipment', '=', machine)
        .orderBy('epoch', 'desc')
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!newest) continue;
      const seq = newest.seq;
      if (seq === null) continue;
      const [links, record, unit] = await Promise.all([
        this.#readDb
          .selectFrom('genealogy.genealogy_link')
          .select(['lot', 'material'])
          .where('kind', '=', 'lot-unit')
          .where('equipment', '=', machine)
          .where('epoch', '=', newest.epoch)
          .where('seq', '=', seq)
          .orderBy('position')
          .execute(),
        this.#readDb
          .selectFrom('genealogy.unit_record')
          .select(['operation', 'pass', 'completed_at'])
          .where('equipment', '=', machine)
          .where('epoch', '=', newest.epoch)
          .where('seq', '=', seq)
          .executeTakeFirst(),
        this.#readDb
          .selectFrom('genealogy.serial_unit')
          .select(['serial'])
          .where('epoch', '=', newest.epoch)
          .where('part_id', '=', newest.part_id)
          .executeTakeFirst(),
      ]);
      if (!record) continue;
      this.#lastLots.set(machine, {
        equipment: machine,
        operation: record.operation,
        epoch: newest.epoch,
        partId: newest.part_id,
        serial: unit?.serial ?? null,
        pass: record.pass,
        seq,
        at: record.completed_at,
        lots: links.flatMap((l) => (l.lot === null ? [] : [{ lot: l.lot, material: l.material }])),
      });
    }
  }

  /** Stored units' cycles with lots move each machine's newest one forward (after the commit). */
  #noteLots(
    epoch: number,
    built: readonly { unit: UnitRecord; records: readonly TracedRecord[] }[],
  ): void {
    for (const { unit, records } of built) {
      for (const r of records) {
        if (r.lots === null || r.lots.length === 0) continue;
        const known = this.#lastLots.get(r.equipment);
        if (known && (known.epoch > epoch || (known.epoch === epoch && known.seq > r.seq))) {
          continue;
        }
        this.#lastLots.set(r.equipment, {
          equipment: r.equipment,
          operation: r.operation,
          epoch,
          partId: unit.partId,
          serial: unit.serial,
          pass: r.pass,
          seq: r.seq,
          at: r.at,
          lots: r.lots.map((l) => ({ lot: l.lot, material: l.material })),
        });
      }
    }
  }

  /** The lots imported from the ERP, by id. */
  async lots(): Promise<MaterialLot[]> {
    const rows = await this.#readDb
      .selectFrom('genealogy.material_lot')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map(toLot);
  }

  /**
   * Serials, lots (as imported), cartons and orders whose id starts with `q` (case as given), at
   * most `limit` each, by id. A range on the id in byte order (`COLLATE "C"`), which the
   * `*_prefix` indexes serve (review M6).
   */
  async search(q: string, limit = 20): Promise<{ kind: SearchKind; id: string }[]> {
    // PostgreSQL text holds no U+0000: no id can start with it (the API refuses it with 400).
    if (q.includes('\u0000')) return [];
    const upper = prefixUpperBound(q);
    const range = (column: string) =>
      upper === null
        ? sql<boolean>`${sql.ref(column)} COLLATE "C" >= ${q}`
        : sql<boolean>`${sql.ref(column)} COLLATE "C" >= ${q} AND ${sql.ref(column)} COLLATE "C" < ${upper}`;
    const byte = (column: string) => sql`${sql.ref(column)} COLLATE "C"`;
    const [serials, lots, cartons, orders] = await Promise.all([
      this.#readDb
        .selectFrom('genealogy.serial_unit')
        .select('serial')
        .groupBy('serial')
        .where(range('serial'))
        .orderBy(byte('serial'))
        .limit(limit)
        .execute(),
      this.#readDb
        .selectFrom('genealogy.material_lot')
        .select('id')
        .where(range('id'))
        .orderBy(byte('id'))
        .limit(limit)
        .execute(),
      this.#readDb
        .selectFrom('genealogy.carton')
        .select('id')
        .where(range('id'))
        .orderBy(byte('id'))
        .limit(limit)
        .execute(),
      this.#readDb
        .selectFrom('genealogy.serial_unit')
        .select('order_id')
        .groupBy('order_id')
        .where(range('order_id'))
        .orderBy(byte('order_id'))
        .limit(limit)
        .execute(),
    ]);
    return [
      ...serials.map((s) => ({ kind: 'serial' as const, id: s.serial ?? '' })),
      ...lots.map((l) => ({ kind: 'lot' as const, id: l.id })),
      ...cartons.map((c) => ({ kind: 'carton' as const, id: c.id })),
      ...orders.map((o) => ({ kind: 'order' as const, id: o.order_id ?? '' })),
    ];
  }

  /** The module's incidents, newest first (`open`: only those not closed). */
  async incidents(
    query: {
      readonly open?: boolean;
      readonly type?: GenealogyIncidentType;
      readonly limit?: number;
    } = {},
  ): Promise<GenealogyIncident[]> {
    let select = this.#readDb.selectFrom('genealogy.genealogy_incident').selectAll();
    if (query.open === true) select = select.where('closed_at', 'is', null);
    if (query.type !== undefined) select = select.where('type', '=', query.type);
    const rows = await select
      .orderBy('id', 'desc')
      .limit(query.limit ?? 500)
      .execute();
    return rows.map(toIncident);
  }

  // ---- internals: units ----

  #soon(): void {
    if (this.#kick !== undefined || !this.#started || this.#options.tickMs === 0) return;
    this.#kick = setTimeout(() => {
      this.#kick = undefined;
      this.tick().catch((error: unknown) => {
        this.#log.error({ err: error }, 'genealogy: tick failed');
      });
    }, 250);
    this.#kick.unref();
  }

  async #loadMaster(): Promise<void> {
    const [equipment, routings] = await Promise.all([
      this.#options.masterData.equipment(),
      this.#options.masterData.routings(),
    ]);
    this.#machines = equipment.map((e) => e.id).sort(byText);
    this.#firstOperation = routings[0]?.operations[0]?.operation ?? BLANK_OPERATION;
    this.#workCenterOf = new Map(equipment.map((e) => [e.id, e.workCenter.id]));
    this.#bomOf = new Map(routings.map((r) => [r.product, r.bom.map(bomLine)]));
    this.#idealCycle = new Map(
      routings.map((r) => [
        r.product,
        new Map(r.operations.map((o) => [o.operation, o.idealCycleMs])),
      ]),
    );
  }

  /**
   * Catch-up at start: every unit of the newest device run, of older runs whose records lag their
   * facts, and every unit whose order or status differs from the execution module's (a change
   * announced while genealogy was not following, review M4); then the orders whose cartons are not
   * settled (an open carton, or packs not all placed), not every order (review M5).
   */
  async #catchUp(): Promise<void> {
    const counts = await this.#options.ingest.cycleFactCounts();
    const stored = await this.#db
      .selectFrom('genealogy.unit_record')
      .select(['equipment', 'epoch'])
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .groupBy(['equipment', 'epoch'])
      .execute();
    const known = new Set(this.#machines);
    const newest = Math.max(Number.NEGATIVE_INFINITY, ...counts.map((c) => c.epoch));
    const epochs = new Set<number>();
    for (const count of counts.filter((c) => known.has(c.equipment))) {
      const mine = stored.find((s) => s.equipment === count.equipment && s.epoch === count.epoch);
      if (count.epoch === newest || Number(mine?.n ?? 0) !== count.facts) epochs.add(count.epoch);
    }
    const dirty = new Map<number, Set<number>>();
    for (const epoch of epochs) {
      const parts = new Set<number>();
      for (const count of counts.filter((c) => c.epoch === epoch && known.has(c.equipment))) {
        for (const fact of await this.#options.ingest.cycleFacts({
          epoch,
          equipment: count.equipment,
        })) {
          parts.add(fact.partId);
        }
      }
      dirty.set(epoch, parts);
    }
    const mine = new Map(
      (
        await this.#db
          .selectFrom('genealogy.serial_unit')
          .select(['epoch', 'part_id', 'order_id', 'status'])
          .execute()
      ).map((r) => [`${String(r.epoch)}/${String(r.part_id)}`, r]),
    );
    for (const unit of await this.#options.execution.unitStates()) {
      const row = mine.get(`${String(unit.epoch)}/${String(unit.partId)}`);
      if (row?.order_id === unit.orderId && row.status === unit.status) continue;
      const parts = dirty.get(unit.epoch) ?? new Set<number>();
      parts.add(unit.partId);
      dirty.set(unit.epoch, parts);
    }
    const watermark = this.#options.execution.processedThrough();
    for (const [epoch, parts] of dirty) await this.#rebuild(epoch, [...parts], watermark);
    for (const id of await this.#unsettledOrders()) this.#dirtyOrders.add(id);
  }

  /** Orders with an open carton, or whose good packs are not all in its cartons. */
  async #unsettledOrders(): Promise<string[]> {
    const [open, packs, members] = await Promise.all([
      this.#db
        .selectFrom('genealogy.carton')
        .select('order_id')
        .distinct()
        .where('status', '=', 'open')
        .execute(),
      this.#db
        .selectFrom('genealogy.unit_record as r')
        .innerJoin('genealogy.serial_unit as u', (j) =>
          j.onRef('u.epoch', '=', 'r.epoch').onRef('u.part_id', '=', 'r.part_id'),
        )
        .select('u.order_id')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('u.order_id', 'is not', null)
        .where('r.operation', '=', this.#options.packing.operation)
        .where('r.result', '=', 'good')
        .groupBy('u.order_id')
        .execute(),
      this.#db
        .selectFrom('genealogy.carton')
        .select('order_id')
        .select((eb) => eb.fn.sum<string>('members').as('n'))
        .groupBy('order_id')
        .execute(),
    ]);
    const placed = new Map(members.map((m) => [m.order_id, Number(m.n)]));
    const ids = new Set(open.map((o) => o.order_id));
    for (const p of packs) {
      if (p.order_id !== null && Number(p.n) !== (placed.get(p.order_id) ?? 0)) ids.add(p.order_id);
    }
    return [...ids].sort();
  }

  /** Rebuilds units of one device run from their execution records and cycle facts. */
  async #rebuild(
    epoch: number,
    partIds: readonly number[],
    watermark: ReadonlyMap<string, DeviceProgress>,
  ): Promise<void> {
    const sorted = [...new Set(partIds)].sort((a, b) => a - b);
    const orders = new Map<string, OrderRecord | undefined>();
    for (let i = 0; i < sorted.length; i += PART_BATCH) {
      const chunk = sorted.slice(i, i + PART_BATCH);
      const [{ units }, facts] = await Promise.all([
        this.#options.execution.units({ epoch, partIds: chunk, limit: chunk.length }),
        this.#options.ingest.cycleFacts({ epoch, partIds: chunk }),
      ]);
      const factsOf = new Map<number, CycleFact[]>();
      for (const fact of facts)
        factsOf.set(fact.partId, [...(factsOf.get(fact.partId) ?? []), fact]);
      const built = units.map((unit) => ({
        unit,
        ...traceUnit(unit.records, factsOf.get(unit.partId) ?? []),
      }));
      for (const { unit } of built) {
        if (unit.orderId !== null && !orders.has(unit.orderId)) {
          orders.set(unit.orderId, await this.#options.orders.order(unit.orderId));
        }
      }
      try {
        await this.#store(epoch, built, orders, watermark);
      } catch (error) {
        await this.#isolate(epoch, built, orders, watermark, error);
      }
      this.#rebuilt?.inc(built.length);
    }
  }

  /**
   * A chunk of units that failed to store, unit by unit (review L10): a unit that fails on its own
   * raises `rebuild-failed` (its rows stay as they were, the round goes on and the watermark with
   * it, until the unit is announced again); when every unit fails, the cause is not the units (a
   * lost connection, a deadlock) and the round fails, to be retried with everything it took.
   */
  async #isolate(
    epoch: number,
    built: readonly { unit: UnitRecord; records: TracedRecord[]; links: LotLink[] }[],
    orders: ReadonlyMap<string, OrderRecord | undefined>,
    watermark: ReadonlyMap<string, DeviceProgress>,
    error: unknown,
  ): Promise<void> {
    if (built.length <= 1) {
      const [one] = built;
      if (!one) throw error;
      await this.#rebuildFailed(epoch, one.unit, error);
      return;
    }
    const failed: { unit: UnitRecord; error: unknown }[] = [];
    for (const one of built) {
      try {
        await this.#store(epoch, [one], orders, watermark);
      } catch (cause) {
        failed.push({ unit: one.unit, error: cause });
      }
    }
    if (failed.length === built.length) throw error;
    for (const { unit, error: cause } of failed) await this.#rebuildFailed(epoch, unit, cause);
  }

  /**
   * A unit whose rebuild failed on its own: kept in the retry set (retried next round, then after
   * 1, 3, 7, … rounds, at most 31), the watermark held below its facts meanwhile; a second failure
   * in a row raises `rebuild-failed` (a transient failure retried at once raises none).
   */
  async #rebuildFailed(epoch: number, unit: UnitRecord, error: unknown): Promise<void> {
    const key = `${String(epoch)}/${String(unit.partId)}`;
    const failed = this.#failed.get(key) ?? { epoch, partId: unit.partId, attempts: 0, wait: 0 };
    failed.attempts++;
    failed.wait = Math.min(2 ** (failed.attempts - 1) - 1, 31);
    this.#failed.set(key, failed);
    this.#log.error(
      { err: error, epoch, partId: unit.partId, attempts: failed.attempts },
      'genealogy: rebuilding a unit failed; its rows are kept as they were, and it is retried',
    );
    if (failed.attempts < 2) return;
    const raised = await this.#db.transaction().execute((trx) =>
      this.#raise(trx, {
        type: 'rebuild-failed',
        key: `rebuild-failed:${String(epoch)}:${String(unit.partId)}`,
        lot: null,
        epoch,
        part_id: unit.partId,
        equipment: null,
        message: `unit ${String(epoch)}/${String(unit.partId)}${unit.serial ? ` (${unit.serial})` : ''}: its genealogy could not be rebuilt (${error instanceof Error ? error.message : String(error)}); its rows are kept as they were and it is retried, while genealogy's watermark stays below its facts`,
      }),
    );
    if (raised) this.#incidents?.inc({ type: 'rebuild-failed' });
  }

  async #store(
    epoch: number,
    built: readonly { unit: UnitRecord; records: TracedRecord[]; links: LotLink[] }[],
    orders: ReadonlyMap<string, OrderRecord | undefined>,
    watermark: ReadonlyMap<string, DeviceProgress>,
  ): Promise<void> {
    if (built.length === 0) return;
    const ids = built.map((b) => b.unit.partId);
    const raised: GenealogyIncidentType[] = [];
    await this.#db.transaction().execute(async (trx) => {
      const before = new Map(
        (
          await trx
            .selectFrom('genealogy.serial_unit')
            .select(['part_id', 'order_id', 'carton_id'])
            .where('epoch', '=', epoch)
            .where('part_id', 'in', ids)
            // In one order, so two rounds locking overlapping units can't deadlock.
            .orderBy('part_id')
            .forUpdate()
            .execute()
        ).map((row) => [row.part_id, row]),
      );
      for (const { unit } of built) {
        const was = before.get(unit.partId);
        if (was?.order_id) this.#dirtyOrders.add(was.order_id);
        if (unit.orderId) this.#dirtyOrders.add(unit.orderId);
        const values = {
          serial: unit.serial,
          product: unit.product,
          order_id: unit.orderId,
          status: unit.status,
          // A unit that changed order leaves its carton; the order's cartons are placed again.
          carton_id: was?.order_id === unit.orderId ? was.carton_id : null,
          updated_at: sql<Date>`clock_timestamp()`,
        };
        await trx
          .insertInto('genealogy.serial_unit')
          .values({ epoch, part_id: unit.partId, ...values })
          .onConflict((c) => c.columns(['epoch', 'part_id']).doUpdateSet(values))
          .execute();
      }
      await trx
        .deleteFrom('genealogy.genealogy_link')
        .where('kind', '=', 'lot-unit')
        .where('epoch', '=', epoch)
        .where('part_id', 'in', ids)
        .execute();
      await trx
        .deleteFrom('genealogy.unit_record')
        .where('epoch', '=', epoch)
        .where('part_id', 'in', ids)
        .execute();
      const records = built.flatMap(({ unit, records: list }) =>
        list.map((r) => ({
          equipment: r.equipment,
          epoch,
          seq: r.seq,
          part_id: unit.partId,
          operation: r.operation,
          pass: r.pass,
          completed_at: r.at,
          result: r.result,
          reason: r.reason,
          lots_reported: r.lots !== null,
          operator: r.operator,
          operator_reported: r.operatorReported,
          measurement: r.measurement === null ? null : JSON.stringify(r.measurement),
        })),
      );
      for (let i = 0; i < records.length; i += 2_000) {
        await trx
          .insertInto('genealogy.unit_record')
          .values(records.slice(i, i + 2_000))
          .execute();
      }
      const links = built.flatMap(({ unit, links: list }) =>
        list.map((l) => ({
          kind: 'lot-unit' as const,
          epoch,
          part_id: unit.partId,
          at: l.at,
          position: l.position,
          lot: l.lot,
          material: l.material,
          operation: l.operation,
          pass: l.pass,
          equipment: l.equipment,
          seq: l.seq,
          carton_id: null,
        })),
      );
      for (let i = 0; i < links.length; i += 2_000) {
        await trx
          .insertInto('genealogy.genealogy_link')
          .values(links.slice(i, i + 2_000))
          .execute();
      }

      // Incidents: lots never imported, materials the BOM doesn't list, serials of another run.
      const lotIds = [...new Set(links.map((l) => l.lot))];
      const listed = new Map(
        lotIds.length === 0
          ? []
          : (
              await trx
                .selectFrom('genealogy.material_lot')
                .select(['id', 'material'])
                .where('id', 'in', lotIds)
                .execute()
            ).map((row) => [row.id, row.material]),
      );
      for (const { unit, links: list } of built) {
        for (const link of list.filter((l) => !listed.has(l.lot))) {
          if (
            await this.#raise(trx, {
              type: 'unknown-lot',
              key: `unknown-lot:${link.lot}`,
              lot: link.lot,
              epoch,
              part_id: unit.partId,
              equipment: link.equipment,
              message: `lot ${link.lot} (${link.material}) consumed at ${link.equipment} (seq ${String(link.seq)}) is not in the ERP’s lot list; the fact is kept`,
            })
          ) {
            raised.push('unknown-lot');
          }
        }
      }
      const mismatchKeys = new Set<string>();
      const judged: number[] = [];
      for (const { unit, links: list } of built) {
        const order = unit.orderId === null ? undefined : orders.get(unit.orderId);
        const bom = order ? order.bom.map(bomLine) : (this.#bomOf.get(unit.product) ?? []);
        const found = mismatches(list, bom, (lot) => listed.get(lot));
        // Judged only once the unit's order is final (plan: incidents on final data, see
        // `#attributionFinal`). Until then a mismatch may come from a provisional attribution,
        // and the unit is looked at again next round.
        if (found.length > 0 && !this.#attributionFinal(epoch, unit.records, watermark)) {
          let parts = this.#unjudged.get(epoch);
          if (!parts) {
            parts = new Set();
            this.#unjudged.set(epoch, parts);
          }
          parts.add(unit.partId);
          continue;
        }
        judged.push(unit.partId);
        for (const mismatch of found) {
          const key = `material-mismatch:${mismatch.link.equipment}:${String(epoch)}:${String(mismatch.link.seq)}:${String(mismatch.link.position)}`;
          mismatchKeys.add(key);
          if (
            await this.#raise(trx, {
              type: 'material-mismatch',
              key,
              lot: mismatch.link.lot,
              epoch,
              part_id: unit.partId,
              equipment: mismatch.link.equipment,
              message: `unit ${String(epoch)}/${String(unit.partId)}${unit.serial ? ` (${unit.serial})` : ''} at ${mismatch.link.operation} pass ${String(mismatch.link.pass)}: ${mismatch.message}${order ? ` (order ${order.id})` : ' (product BOM: no order)'}`,
            })
          ) {
            raised.push('material-mismatch');
          }
        }
      }
      // A mismatch the judged units no longer show (the unit's order changed) is closed.
      const open =
        judged.length === 0
          ? []
          : await trx
              .selectFrom('genealogy.genealogy_incident')
              .select(['id', 'key'])
              .where('type', '=', 'material-mismatch')
              .where('closed_at', 'is', null)
              .where('epoch', '=', epoch)
              .where('part_id', 'in', judged)
              .execute();
      const stale = open.filter((row) => !mismatchKeys.has(row.key)).map((row) => row.id);
      if (stale.length > 0) {
        await trx
          .updateTable('genealogy.genealogy_incident')
          .set({ closed_at: sql<Date>`clock_timestamp()`, resolution: 'resolved by later facts' })
          .where('id', 'in', stale)
          .execute();
      }
      await trx
        .updateTable('genealogy.genealogy_incident')
        .set({ closed_at: sql<Date>`clock_timestamp()`, resolution: 'rebuilt' })
        .where('type', '=', 'rebuild-failed')
        .where('closed_at', 'is', null)
        .where('epoch', '=', epoch)
        .where('part_id', 'in', ids)
        .execute();
      const serials = [
        ...new Set(
          built.map((b) => b.unit.serial).filter((s): s is string => s !== null && s !== ''),
        ),
      ];
      for (let i = 0; i < serials.length; i += 2_000) {
        const others = await trx
          .selectFrom('genealogy.serial_unit')
          .select(['epoch', 'serial'])
          .where('serial', 'in', serials.slice(i, i + 2_000))
          .where('epoch', '<>', epoch)
          .execute();
        const pairs = new Map<number, string>();
        for (const row of others) if (!pairs.has(row.epoch)) pairs.set(row.epoch, row.serial ?? '');
        for (const [other, serial] of pairs) {
          const [a, b] = other < epoch ? [other, epoch] : [epoch, other];
          if (
            await this.#raise(trx, {
              type: 'serial-reused',
              key: `serial-reused:${String(a)}:${String(b)}`,
              lot: null,
              epoch: b,
              part_id: null,
              equipment: null,
              message: `serials repeat across device epochs ${String(a)} and ${String(b)} (first seen: ${serial}); units stay keyed (epoch, partId) and a lookup by serial lists both (ADR-0034)`,
            })
          ) {
            raised.push('serial-reused');
          }
        }
      }
    });
    this.#noteLots(epoch, built);
    for (const type of raised) this.#incidents?.inc({ type });
    for (const { unit, records } of built) {
      const key = `${String(epoch)}/${String(unit.partId)}`;
      this.#failed.delete(key);
      const pack = records.find(
        (r) => r.operation === this.#options.packing.operation && r.result === 'good',
      );
      if (pack && !this.#attributionFinal(epoch, records, watermark)) {
        this.#unattributed.set(key, {
          epoch,
          pack: { at: pack.at.getTime(), seq: pack.seq, partId: unit.partId },
          records: records.map((r) => ({
            operation: r.operation,
            equipment: r.equipment,
            seq: r.seq,
          })),
        });
      } else {
        this.#unattributed.delete(key);
      }
    }
  }

  /**
   * The progress genealogy may call processed: the round's, held below the facts of every unit
   * whose rebuild is still failing (on each of their machines, the final-through just below the
   * unit's first fact there and the final-through time just before it), so a close guard sees
   * `genealogy-pending` (#201) rather than links that miss the unit. A failing unit of an older
   * epoch than its machine's keeps that machine's previous processed progress.
   */
  async #capped(
    watermark: ReadonlyMap<string, DeviceProgress>,
  ): Promise<ReadonlyMap<string, DeviceProgress>> {
    if (this.#failed.size === 0) return watermark;
    const capped = new Map(watermark);
    const byEpoch = new Map<number, number[]>();
    for (const f of this.#failed.values()) {
      byEpoch.set(f.epoch, [...(byEpoch.get(f.epoch) ?? []), f.partId]);
    }
    for (const [epoch, parts] of byEpoch) {
      for (const fact of await this.#options.ingest.cycleFacts({ epoch, partIds: parts })) {
        const device = capped.get(fact.equipment);
        if (device?.epoch === null || device?.epoch === undefined) continue;
        if (device.epoch !== epoch) {
          const previous = this.#processed.get(fact.equipment);
          if (previous) capped.set(fact.equipment, previous);
          else capped.delete(fact.equipment);
          continue;
        }
        const below = fact.seq - 1;
        const before = new Date(fact.sourceTime.getTime() - 1);
        capped.set(fact.equipment, {
          ...device,
          receivedThrough:
            device.receivedThrough === null ? null : Math.min(device.receivedThrough, below),
          settledSeq: device.settledSeq === null ? null : Math.min(device.settledSeq, below),
          settledTime:
            device.settledTime === null || device.settledTime.getTime() <= before.getTime()
              ? device.settledTime
              : before,
        });
      }
    }
    return capped;
  }

  /**
   * The earliest packing cycle, of any order or none, whose unit's order is not final yet (review
   * of PR #219, round 2: an order dispatched to two CNCs could gain a unit that packs before one
   * already placed); no order's pack is placed at or after it. Units now final leave the set.
   */
  #placementCutoff(
    watermark: ReadonlyMap<string, DeviceProgress>,
  ): { epoch: number; at: number; seq: number; partId: number } | null {
    let cutoff: { epoch: number; at: number; seq: number; partId: number } | null = null;
    for (const [key, unit] of this.#unattributed) {
      if (this.#attributionFinal(unit.epoch, unit.records, watermark)) {
        this.#unattributed.delete(key);
        continue;
      }
      const pack = { epoch: unit.epoch, ...unit.pack };
      if (cutoff === null || comparePackKeys(pack, cutoff) < 0) cutoff = pack;
    }
    return cutoff;
  }

  /**
   * Whether a unit's order can no longer change (ADR-0031: the latest `started` fact below its
   * first-operation cycle on that machine): its first operation's machine is final through that
   * record, so no job fact on its way can attribute it to another order. A unit without a
   * first-operation record (its fact lost, the gap written off) has no order for good once every
   * machine of its records is final through them (review M3): judged with the product's BOM.
   */
  #attributionFinal(
    epoch: number,
    records: readonly {
      readonly operation: string;
      readonly equipment: string;
      readonly seq: number;
    }[],
    watermark: ReadonlyMap<string, DeviceProgress>,
  ): boolean {
    const first = records.find((r) => r.operation === this.#firstOperation);
    if (first !== undefined) {
      return finalThrough(watermark.get(first.equipment), { epoch, seq: first.seq });
    }
    return (
      records.length > 0 &&
      records.every((r) => finalThrough(watermark.get(r.equipment), { epoch, seq: r.seq }))
    );
  }

  async #raise(
    trx: Transaction<Database>,
    incident: Omit<
      Selectable<GenealogyIncidentTable>,
      'id' | 'detected_at' | 'closed_at' | 'resolution'
    >,
  ): Promise<boolean> {
    const row = await trx
      .insertInto('genealogy.genealogy_incident')
      .values(incident)
      .onConflict((c) => c.column('key').where('closed_at', 'is', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (row) this.#log.warn({ incident: incident.type, key: incident.key }, incident.message);
    return row !== undefined;
  }

  // ---- internals: cartons ----

  /**
   * An order's cartons by the packing rule on final data (plan "Cartons"): its good packing
   * cycles placed in order up to the first one not final, the last carton closed at the order's
   * completion once every pack is placed. A pack is final when its machine is final through it
   * and its unit's order is (`#attributionFinal`: a late job fact can move a unit to another
   * order, review H2), so a closed carton's members never change but for a fact of a written-off
   * gap. Rewrites the order's cartons and `unit-carton` links only when they differ from the
   * stored ones (review M5); keeps the order for the next round while a pack is not placed or a
   * carton is open. Returns whether it wrote them (#238: a change for the hold scopes).
   */
  async #placeOrder(
    orderId: string,
    watermark: ReadonlyMap<string, DeviceProgress>,
    cutoff: { epoch: number; at: number; seq: number; partId: number } | null = null,
  ): Promise<boolean> {
    const order = await this.#options.orders.order(orderId);
    if (!order) {
      this.#unsettled.delete(orderId);
      return false;
    }
    const operation = this.#options.packing.operation;
    const packs = await this.#db
      .selectFrom('genealogy.unit_record as r')
      .innerJoin('genealogy.serial_unit as u', (j) =>
        j.onRef('u.epoch', '=', 'r.epoch').onRef('u.part_id', '=', 'r.part_id'),
      )
      .select(['r.equipment', 'r.epoch', 'r.seq', 'r.part_id', 'r.completed_at'])
      .where('u.order_id', '=', orderId)
      .where('r.operation', '=', operation)
      .where('r.result', '=', 'good')
      .execute();
    const firsts = await this.#db
      .selectFrom('genealogy.unit_record as r')
      .innerJoin('genealogy.serial_unit as u', (j) =>
        j.onRef('u.epoch', '=', 'r.epoch').onRef('u.part_id', '=', 'r.part_id'),
      )
      .select(['r.equipment', 'r.epoch', 'r.seq', 'r.part_id', 'r.operation'])
      .where('u.order_id', '=', orderId)
      .where('r.operation', '=', this.#firstOperation)
      .execute();
    const firstOf = new Map<string, (typeof firsts)[number][]>();
    for (const f of firsts) {
      const key = `${String(f.epoch)}/${String(f.part_id)}`;
      firstOf.set(key, [...(firstOf.get(key) ?? []), f]);
    }
    const placedPacks: PlacedPack[] = packs.map((p) => ({
      unit: { epoch: p.epoch, partId: p.part_id },
      orderId,
      at: p.completed_at.getTime(),
      seq: p.seq,
      final:
        (cutoff === null ||
          comparePackKeys(
            { epoch: p.epoch, at: p.completed_at.getTime(), seq: p.seq, partId: p.part_id },
            cutoff,
          ) < 0) &&
        finalThrough(watermark.get(p.equipment), { epoch: p.epoch, seq: p.seq }) &&
        (firstOf.get(`${String(p.epoch)}/${String(p.part_id)}`) ?? []).length > 0 &&
        this.#attributionFinal(
          p.epoch,
          firstOf.get(`${String(p.epoch)}/${String(p.part_id)}`) ?? [],
          watermark,
        ),
    }));
    const completedAt =
      (order.status === 'completed' || order.status === 'closed') && order.completedAt !== null
        ? order.completedAt.getTime()
        : null;
    let placed: ReturnType<typeof placeCartons>;
    try {
      placed = placeCartons(
        { orderId, product: order.product, completedAt },
        placedPacks,
        this.#options.packing.capacity,
      );
    } catch (error) {
      this.#log.error({ err: error, order: orderId }, 'genealogy: cartons of an order failed');
      this.#unsettled.delete(orderId);
      return false;
    }
    const { cartons } = placed;
    const pending = !placed.complete || cartons.some((c) => c.status === 'open');
    if (pending) this.#unsettled.add(orderId);
    else this.#unsettled.delete(orderId);
    if (await this.#sameCartons(orderId, cartons)) return false;
    await this.#db.transaction().execute(async (trx) => {
      const old = (
        await trx
          .selectFrom('genealogy.carton')
          .select('id')
          .where('order_id', '=', orderId)
          .orderBy('number')
          .forUpdate()
          .execute()
      ).map((row) => row.id);
      if (old.length > 0) {
        await trx
          .deleteFrom('genealogy.genealogy_link')
          .where('kind', '=', 'unit-carton')
          .where('carton_id', 'in', old)
          .execute();
        await trx
          .updateTable('genealogy.serial_unit')
          .set({ carton_id: null })
          .where('carton_id', 'in', old)
          .execute();
      }
      const ids = cartons.map((c) => c.id);
      const gone = old.filter((id) => !ids.includes(id));
      if (gone.length > 0)
        await trx.deleteFrom('genealogy.carton').where('id', 'in', gone).execute();
      for (const [index, carton] of cartons.entries()) {
        const values = {
          order_id: orderId,
          number: index + 1,
          product: carton.product,
          capacity: carton.capacity,
          status: carton.status,
          closed_at: carton.closedAt === null ? null : new Date(carton.closedAt),
          members: carton.members.length,
          updated_at: sql<Date>`clock_timestamp()`,
        };
        await trx
          .insertInto('genealogy.carton')
          .values({ id: carton.id, ...values })
          .onConflict((c) => c.column('id').doUpdateSet(values))
          .execute();
      }
      const atOf = new Map(
        placedPacks.map((p) => [`${String(p.unit.epoch)}/${String(p.unit.partId)}`, p.at]),
      );
      const links = cartons.flatMap((carton) =>
        carton.members.map((m, position) => ({
          kind: 'unit-carton' as const,
          epoch: m.epoch,
          part_id: m.partId,
          at: new Date(atOf.get(`${String(m.epoch)}/${String(m.partId)}`) ?? 0),
          position,
          lot: null,
          material: null,
          operation: null,
          pass: null,
          equipment: null,
          seq: null,
          carton_id: carton.id,
        })),
      );
      for (let i = 0; i < links.length; i += 2_000) {
        await trx
          .insertInto('genealogy.genealogy_link')
          .values(links.slice(i, i + 2_000))
          .execute();
      }
      for (const carton of cartons) {
        for (const [epoch, parts] of byEpoch(carton.members)) {
          await trx
            .updateTable('genealogy.serial_unit')
            .set({ carton_id: carton.id })
            .where('epoch', '=', epoch)
            .where('part_id', 'in', parts)
            .execute();
        }
      }
    });
    return true;
  }

  /** Whether an order's stored cartons and members are these (nothing to write, review M5). */
  async #sameCartons(orderId: string, cartons: readonly Carton[]): Promise<boolean> {
    const [rows, links] = await Promise.all([
      this.#db
        .selectFrom('genealogy.carton')
        .select(['id', 'number', 'status', 'closed_at', 'members'])
        .where('order_id', '=', orderId)
        .orderBy('number')
        .execute(),
      this.#db
        .selectFrom('genealogy.genealogy_link as l')
        .innerJoin('genealogy.carton as c', 'c.id', 'l.carton_id')
        .select(['l.carton_id', 'l.epoch', 'l.part_id', 'l.position'])
        .where('l.kind', '=', 'unit-carton')
        .where('c.order_id', '=', orderId)
        .orderBy('c.number')
        .orderBy('l.position')
        .execute(),
    ]);
    const stored = JSON.stringify({
      cartons: rows.map((r) => [
        r.id,
        r.number,
        r.status,
        r.closed_at?.getTime() ?? null,
        r.members,
      ]),
      members: links.map((l) => [l.carton_id, l.epoch, l.part_id, l.position]),
    });
    const wanted = JSON.stringify({
      cartons: cartons.map((c, i) => [c.id, i + 1, c.status, c.closedAt, c.members.length]),
      members: cartons.flatMap((c) =>
        c.members.map((m, position) => [c.id, m.epoch, m.partId, position]),
      ),
    });
    return stored === wanted;
  }

  // ---- internals: reads ----

  async #traceUnits(rows: readonly Selectable<SerialUnitTable>[]): Promise<TraceUnitRecord[]> {
    if (rows.length === 0) return [];
    const keys = rows.map((r) => ({ epoch: r.epoch, partId: r.part_id }));
    const records = new Map<string, Selectable<UnitRecordTable>[]>();
    const lots = new Map<string, LotRef[]>();
    for (const [epoch, parts] of byEpoch(keys)) {
      for (let i = 0; i < parts.length; i += 5_000) {
        const slice = parts.slice(i, i + 5_000);
        const [found, links] = await Promise.all([
          this.#readDb
            .selectFrom('genealogy.unit_record')
            .selectAll()
            .where('epoch', '=', epoch)
            .where('part_id', 'in', slice)
            .orderBy('completed_at')
            .orderBy('seq')
            .execute(),
          this.#readDb
            .selectFrom('genealogy.genealogy_link')
            .select(['equipment', 'seq', 'position', 'lot', 'material'])
            .where('kind', '=', 'lot-unit')
            .where('epoch', '=', epoch)
            .where('part_id', 'in', slice)
            .orderBy('equipment')
            .orderBy('seq')
            .orderBy('position')
            .execute(),
        ]);
        for (const r of found) {
          const key = `${String(epoch)}/${String(r.part_id)}`;
          records.set(key, [...(records.get(key) ?? []), r]);
        }
        for (const l of links) {
          const key = `${l.equipment ?? ''}\u0000${String(epoch)}\u0000${String(l.seq)}`;
          lots.set(key, [
            ...(lots.get(key) ?? []),
            { material: l.material ?? '', lot: l.lot ?? '' },
          ]);
        }
      }
    }
    // The cycle of a record with a device operator, whose crew is shown: the fact carries no
    // start, so the cycle is taken as its ideal length before completion.
    const cycleOf = (product: string, r: Selectable<UnitRecordTable>) => {
      const workCenter = this.#workCenterOf.get(r.equipment);
      if (!r.operator_reported || r.operator === null || workCenter === undefined) return undefined;
      const to = r.completed_at.getTime();
      return { workCenter, from: to - (this.#idealCycle.get(product)?.get(r.operation) ?? 0), to };
    };
    // Only the crew rows of the trace's time span, one read per work center (review L10).
    const spans = new Map<string, { from: number; to: number }>();
    for (const row of rows) {
      for (const r of records.get(`${String(row.epoch)}/${String(row.part_id)}`) ?? []) {
        const cycle = cycleOf(row.product, r);
        if (!cycle) continue;
        const span = spans.get(cycle.workCenter);
        spans.set(cycle.workCenter, {
          from: Math.min(span?.from ?? cycle.from, cycle.from),
          to: Math.max(span?.to ?? cycle.to, cycle.to),
        });
      }
    }
    const crew = new Map<string, readonly GenealogyCrew[]>();
    for (const [workCenter, span] of spans) {
      crew.set(
        workCenter,
        this.#options.crew
          ? await this.#options.crew(workCenter, {
              from: new Date(span.from),
              to: new Date(span.to),
            })
          : [],
      );
    }
    const units: TraceUnitRecord[] = [];
    for (const row of rows) {
      const list = records.get(`${String(row.epoch)}/${String(row.part_id)}`) ?? [];
      const traced = [];
      for (const r of list) {
        const cycle = cycleOf(row.product, r);
        const signedOn = cycle
          ? (crew.get(cycle.workCenter) ?? []).filter(
              (c) =>
                c.fromPlant.getTime() <= cycle.to &&
                (c.toPlant === null || c.toPlant.getTime() >= cycle.from),
            )
          : [];
        traced.push({
          operation: r.operation,
          equipment: r.equipment,
          pass: r.pass,
          at: r.completed_at,
          result: r.result,
          reason: r.reason,
          seq: r.seq,
          epoch: r.epoch,
          lots: r.lots_reported
            ? (lots.get(`${r.equipment}\u0000${String(r.epoch)}\u0000${String(r.seq)}`) ?? [])
            : null,
          operator: r.operator,
          operatorReported: r.operator_reported,
          measurement: r.measurement,
          crew: signedOn,
        });
      }
      units.push({
        epoch: row.epoch,
        partId: row.part_id,
        serial: row.serial,
        product: row.product,
        orderId: row.order_id,
        status: row.status,
        carton: row.carton_id,
        records: traced,
      });
    }
    return units;
  }

  async #unitRefs(keys: readonly { epoch: number; partId: number }[]): Promise<UnitRef[]> {
    const refs: UnitRef[] = [];
    for (const [epoch, parts] of byEpoch(keys)) {
      for (let i = 0; i < parts.length; i += 5_000) {
        const rows = await this.#readDb
          .selectFrom('genealogy.serial_unit')
          .select(['epoch', 'part_id', 'serial', 'order_id', 'carton_id', 'status'])
          .where('epoch', '=', epoch)
          .where('part_id', 'in', parts.slice(i, i + 5_000))
          .execute();
        refs.push(
          ...rows.map((r) => ({
            epoch: r.epoch,
            partId: r.part_id,
            serial: r.serial,
            orderId: r.order_id,
            carton: r.carton_id,
            status: r.status,
          })),
        );
      }
    }
    return refs.sort((a, b) => a.epoch - b.epoch || a.partId - b.partId);
  }

  /** The latest record time of these units per epoch (what an answer's finality is judged at). */
  async #latestRecords(
    keys: readonly { epoch: number; partId: number }[],
  ): Promise<{ epoch: number; at: Date }[]> {
    const latest: { epoch: number; at: Date }[] = [];
    for (const [epoch, parts] of byEpoch(keys)) {
      for (let i = 0; i < parts.length; i += 5_000) {
        const row = await this.#readDb
          .selectFrom('genealogy.unit_record')
          .select((eb) => eb.fn.max('completed_at').as('at'))
          .where('epoch', '=', epoch)
          .where('part_id', 'in', parts.slice(i, i + 5_000))
          .executeTakeFirst();
        if (row?.at) latest.push({ epoch, at: new Date(row.at) });
      }
    }
    return latest;
  }

  #finality(records: readonly { epoch: number; at: Date }[]): {
    final: boolean;
    notFinal: string[];
  } {
    return finality(records, this.#machines, (machine) => this.#processed.get(machine));
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

const bomLine = (b: {
  material: string;
  operation: string;
  usage: 'standard' | 'rework';
}): BomLine => ({
  material: b.material,
  operation: b.operation,
  usage: b.usage,
});

/**
 * The smallest string above every string that starts with `q`, in code-point (UTF-8 byte) order:
 * `q` with its last code point raised by one; `null` when there is none.
 */
export function prefixUpperBound(q: string): string | null {
  // Code points, not graphemes: the order compared is the bytes' (UTF-8 keeps code-point order).
  const points = Array.from(q);
  while (points.length > 0) {
    const last = (points.pop() ?? '').codePointAt(0) ?? 0;
    if (last < 0x10ffff) {
      const next = last + 1 === 0xd800 ? 0xe000 : last + 1;
      return points.join('') + String.fromCodePoint(next);
    }
  }
  return null;
}

/** The packing rule's order of packs (trace-core's): plant time, epoch, sequence, part. */
const comparePackKeys = (
  a: { epoch: number; at: number; seq: number; partId: number },
  b: { epoch: number; at: number; seq: number; partId: number },
): number => a.at - b.at || a.epoch - b.epoch || a.seq - b.seq || a.partId - b.partId;

function uniqueUnits(
  rows: readonly { epoch: number; part_id: number }[],
): { epoch: number; partId: number }[] {
  const seen = new Set<string>();
  const units: { epoch: number; partId: number }[] = [];
  for (const row of rows) {
    const key = `${String(row.epoch)}/${String(row.part_id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    units.push({ epoch: row.epoch, partId: row.part_id });
  }
  return units;
}

function byEpoch(keys: readonly { epoch: number; partId: number }[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const key of keys) map.set(key.epoch, [...(map.get(key.epoch) ?? []), key.partId]);
  return map;
}

function toLot(row: Selectable<MaterialLotTable>): MaterialLot {
  return {
    id: row.id,
    material: row.material,
    quantity: row.quantity,
    status: row.status,
    importedAt: row.imported_at,
  };
}

function toCarton(row: Selectable<CartonTable>): CartonRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    number: row.number,
    product: row.product,
    capacity: row.capacity,
    status: row.status,
    closedAt: row.closed_at,
    members: row.members,
  };
}

function toIncident(row: Selectable<GenealogyIncidentTable>): GenealogyIncident {
  return {
    id: row.id,
    type: row.type,
    lot: row.lot,
    epoch: row.epoch,
    partId: row.part_id,
    equipment: row.equipment,
    message: row.message,
    detectedAt: row.detected_at,
    closedAt: row.closed_at,
    resolution: row.resolution,
  };
}
