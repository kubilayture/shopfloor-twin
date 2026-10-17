import type { LotList } from '@shopfloor/contracts/erp-api';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { Counter, type Registry } from 'prom-client';
import type { Database } from '../../db/database.ts';
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
  readonly crew?: (workCenter: string) => Promise<readonly GenealogyCrew[]>;
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

const PART_BATCH = 300;
/** Units a forward trace or a carton answers at most. */
export const TRACE_UNIT_LIMIT = 5_000;
const silent: GenealogyLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
  readonly #rebuilt: Counter | undefined;
  readonly #incidents: Counter | undefined;
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
    }
  }

  /**
   * Loads the machines and BOMs, follows the execution module's units, imports the ERP's lot list
   * once, catches up from the tables (every unit of the newest device run, and of older runs whose
   * records lag their cycle facts; every order's cartons) and starts the timers.
   */
  async start(): Promise<void> {
    await this.#loadMaster();
    this.#unsubscribe = this.#options.execution.onUnits((epoch, partIds) => {
      let parts = this.#dirty.get(epoch);
      if (!parts) {
        parts = new Set();
        this.#dirty.set(epoch, parts);
      }
      for (const id of partIds) parts.add(id);
      this.#soon();
    });
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

  /**
   * One round: the execution module's progress first (what it has handled is in the units it
   * announced, taken next), then the announced units rebuilt, then the cartons of every order
   * whose units changed or that has a pack not placed yet or an open carton. On success the
   * processed watermark moves to that progress.
   */
  async tick(): Promise<void> {
    if (!this.#started || this.#stopping) return;
    await this.#serial(async () => {
      // Read before the units are taken: every unit the execution round changed up to this
      // progress was announced before it completed, so it is in the set taken below (#199).
      const watermark = this.#options.execution.processedThrough();
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
        for (const id of orders) await this.#placeOrder(id, watermark);
        this.#processed = watermark;
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
   * transaction (quantity and status follow the list; a lot no longer listed is kept as
   * `retired`), and `unknown-lot` incidents of lots now listed closed, their units rebuilt (the
   * material check now has the lot). Returns the lots listed.
   */
  async importLots(): Promise<number> {
    const erp = this.#options.erp;
    if (!erp) return 0;
    const list = await erp.lots();
    const ids = list.lots.map((l) => l.id);
    const known = await this.#db.transaction().execute(async (trx) => {
      const existing = new Map(
        (await trx.selectFrom('genealogy.material_lot').selectAll().forUpdate().execute()).map(
          (row) => [row.id, row],
        ),
      );
      for (const lot of list.lots) {
        const before = existing.get(lot.id);
        if (before && before.material !== lot.material) {
          this.#log.warn(
            { lot: lot.id, was: before.material, now: lot.material },
            'genealogy: the ERP changed a lot’s material; kept as first imported',
          );
        }
        if (
          before?.quantity === lot.quantity &&
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
    // The units of lots that were unknown: rebuilt, so the lot's listed material is checked.
    const lots = known.map((row) => row.lot).filter((lot): lot is string => lot !== null);
    if (lots.length > 0) {
      const units = await this.#db
        .selectFrom('genealogy.genealogy_link')
        .select(['epoch', 'part_id'])
        .distinct()
        .where('kind', '=', 'lot-unit')
        .where('lot', 'in', lots)
        .execute();
      for (const unit of units) {
        let parts = this.#dirty.get(unit.epoch);
        if (!parts) {
          parts = new Set();
          this.#dirty.set(unit.epoch, parts);
        }
        parts.add(unit.part_id);
      }
      this.#soon();
    }
    return list.lots.length;
  }

  // ---- the processed watermark (#201's close guard, plan review round 2 HIGH C) ----

  /**
   * Genealogy's contiguous processed-through sequence of a machine in a device epoch: every fact
   * up to it (the device stream received without a gap, ADR-0018) is reflected in the links.
   * `null` when nothing of that epoch is processed yet; an epoch older than the machine's newest
   * processed one counts as processed through every number.
   */
  processedThrough(equipment: string, epoch: number): number | null {
    const device = this.#processed.get(equipment);
    if (device?.epoch === null || device?.epoch === undefined) return null;
    if (device.epoch > epoch) return Number.MAX_SAFE_INTEGER;
    if (device.epoch < epoch) return null;
    return device.receivedThrough;
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

  /** The lots imported from the ERP, by id. */
  async lots(): Promise<MaterialLot[]> {
    const rows = await this.#readDb
      .selectFrom('genealogy.material_lot')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map(toLot);
  }

  /** Serials, lots, cartons and orders whose id starts with `q` (case as given), at most `limit` each. */
  async search(q: string, limit = 20): Promise<{ kind: SearchKind; id: string }[]> {
    const prefix = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const like = (column: string) => sql<boolean>`${sql.ref(column)} LIKE ${prefix}`;
    const [serials, lots, linked, cartons, orders] = await Promise.all([
      this.#readDb
        .selectFrom('genealogy.serial_unit')
        .select('serial')
        .distinct()
        .where('serial', 'is not', null)
        .where(like('serial'))
        .orderBy('serial')
        .limit(limit)
        .execute(),
      this.#readDb
        .selectFrom('genealogy.material_lot')
        .select('id')
        .where(like('id'))
        .orderBy('id')
        .limit(limit)
        .execute(),
      this.#readDb
        .selectFrom('genealogy.genealogy_link')
        .select('lot')
        .distinct()
        .where('kind', '=', 'lot-unit')
        .where(like('lot'))
        .orderBy('lot')
        .limit(limit)
        .execute(),
      this.#readDb
        .selectFrom('genealogy.carton')
        .select('id')
        .where(like('id'))
        .orderBy('id')
        .limit(limit)
        .execute(),
      this.#readDb
        .selectFrom('genealogy.serial_unit')
        .select('order_id')
        .distinct()
        .where('order_id', 'is not', null)
        .where(like('order_id'))
        .orderBy('order_id')
        .limit(limit)
        .execute(),
    ]);
    const lotIds = [...new Set([...lots.map((l) => l.id), ...linked.map((l) => l.lot ?? '')])]
      .filter((id) => id !== '')
      .sort(byText)
      .slice(0, limit);
    return [
      ...serials.map((s) => ({ kind: 'serial' as const, id: s.serial ?? '' })),
      ...lotIds.map((id) => ({ kind: 'lot' as const, id })),
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
    this.#firstOperation = routings[0]?.operations[0]?.operation ?? 'OP10';
    this.#workCenterOf = new Map(equipment.map((e) => [e.id, e.workCenter.id]));
    this.#bomOf = new Map(routings.map((r) => [r.product, r.bom.map(bomLine)]));
    this.#idealCycle = new Map(
      routings.map((r) => [
        r.product,
        new Map(r.operations.map((o) => [o.operation, o.idealCycleMs])),
      ]),
    );
  }

  /** Every unit of the newest device run, and of older runs whose records lag their facts. */
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
      await this.#rebuild(epoch, [...parts], this.#options.execution.processedThrough());
    }
    // Every order with units: its cartons placed again at the first round.
    const orders = await this.#db
      .selectFrom('genealogy.serial_unit')
      .select('order_id')
      .distinct()
      .where('order_id', 'is not', null)
      .execute();
    for (const row of orders) if (row.order_id !== null) this.#dirtyOrders.add(row.order_id);
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
      await this.#store(epoch, built, orders, watermark);
      this.#rebuilt?.inc(built.length);
    }
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
        // Judged only once the unit's order is final (plan: incidents on final data): its first
        // operation's machine final through that record, so no job fact still on its way can
        // attribute it to another order (ADR-0031). Until then a mismatch may come from a
        // provisional attribution, and the unit is looked at again next round.
        const first = unit.records.find((r) => r.operation === this.#firstOperation);
        const final =
          first !== undefined &&
          finalThrough(watermark.get(first.equipment), { epoch, seq: first.seq });
        if (found.length > 0 && !final) {
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
    for (const type of raised) this.#incidents?.inc({ type });
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
   * cycles placed in order up to the first one its machine isn't final through, the last carton
   * closed at the order's completion once every pack is placed. Rewrites the order's cartons and
   * `unit-carton` links; keeps the order for the next round while a pack is not placed or a carton
   * is open.
   */
  async #placeOrder(
    orderId: string,
    watermark: ReadonlyMap<string, DeviceProgress>,
  ): Promise<void> {
    const order = await this.#options.orders.order(orderId);
    if (!order) {
      this.#unsettled.delete(orderId);
      return;
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
    const placedPacks: PlacedPack[] = packs.map((p) => ({
      unit: { epoch: p.epoch, partId: p.part_id },
      orderId,
      at: p.completed_at.getTime(),
      seq: p.seq,
      final: finalThrough(watermark.get(p.equipment), { epoch: p.epoch, seq: p.seq }),
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
      return;
    }
    const { cartons } = placed;
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
    if (!placed.complete || cartons.some((c) => c.status === 'open')) this.#unsettled.add(orderId);
    else this.#unsettled.delete(orderId);
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
    const crew = new Map<string, readonly GenealogyCrew[]>();
    const crewOf = async (workCenter: string): Promise<readonly GenealogyCrew[]> => {
      let found = crew.get(workCenter);
      if (!found) {
        found = this.#options.crew ? await this.#options.crew(workCenter) : [];
        crew.set(workCenter, found);
      }
      return found;
    };
    const units: TraceUnitRecord[] = [];
    for (const row of rows) {
      const list = records.get(`${String(row.epoch)}/${String(row.part_id)}`) ?? [];
      const traced = [];
      for (const r of list) {
        let signedOn: readonly GenealogyCrew[] = [];
        const workCenter = this.#workCenterOf.get(r.equipment);
        if (r.operator_reported && r.operator !== null && workCenter !== undefined) {
          // The fact carries no start: the cycle is taken as its ideal length before completion.
          const start =
            r.completed_at.getTime() - (this.#idealCycle.get(row.product)?.get(r.operation) ?? 0);
          signedOn = (await crewOf(workCenter)).filter(
            (c) =>
              c.fromPlant.getTime() <= r.completed_at.getTime() &&
              (c.toPlant === null || c.toPlant.getTime() >= start),
          );
        }
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
