/**
 * The `genealogy` module (#199) against a real database (as `mes_app`) with the real ingest store,
 * the orders and execution modules and a fake ERP: the lot import (upsert, retire, an unknown lot's
 * incident closed by the import), lot links per operation and pass with the absent / `[]` / null
 * distinction, device operators, readings and the crew, the BOM check judged on final attribution
 * (the order's BOM, the product's without an order), serials reused across device epochs, cartons
 * placed on final packing data (a late earlier pack) and closed at the order's completion, the
 * contiguous processed watermark, a restart's catch-up, and the trace API.
 */
import {
  expandErpDataset,
  type FeedEntry,
  type Lot,
  type LotList,
} from '@shopfloor/contracts/erp-api';
import {
  cartonTraceSchema,
  genealogyIncidentListSchema,
  lotTraceSchema,
  serialTraceSchema,
  traceSearchSchema,
} from '@shopfloor/contracts/mes-api';
import type { EquipmentPath } from '@shopfloor/contracts';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  type Delivery,
} from './modules/equipment/test-support.ts';
import { Execution } from './modules/execution/index.ts';
import {
  Genealogy,
  type GenealogyCrew,
  type GenealogyExecution,
} from './modules/genealogy/index.ts';
import { Identity } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData, erpMasterData } from './modules/master-data/index.ts';
import {
  Orders,
  type CommandPublisher,
  type ErpApi,
  type FeedPage,
  type PostOutcome,
} from './modules/orders/index.ts';
import type { ApiSources } from './modules/realtime/index.ts';
import { startDatabase } from './testing.ts';

const PLANT_T0 = Date.parse('2026-10-12T03:00:00.000Z');
const E1 = 1_760_000_000;
const E2 = 1_760_000_500;
const MACHINES = ['cnc-01', 'cnc-02', 'wsh-01', 'asm-01', 'lkt-01', 'pck-01'];
const READING = { characteristic: 'leak-rate', value: 2.104, unit: 'Pa/min', upperLimit: 3.2 };

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
let paths: Map<string, EquipmentPath>;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  paths = new Map();
  for (const area of plant.plant.areas) {
    for (const wc of area.workCenters) {
      for (const item of wc.equipment) {
        paths.set(item.id, { area: area.id, workCenter: wc.id, equipment: item.id });
      }
    }
  }
}, 180_000);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

afterAll(async () => {
  await container.stop();
});

class FakeErp implements ErpApi {
  readonly entries: FeedEntry[] = [];
  lotList: Lot[] = [
    { id: 'B1', material: 'BLANK-100', quantity: 10 },
    { id: 'B2', material: 'BLANK-100', quantity: 10 },
    { id: 'K1', material: 'SK-1', quantity: 10 },
    { id: 'K2', material: 'SK-1', quantity: 10 },
    { id: 'P1', material: 'SP-100', quantity: 10 },
  ];

  feed(after: number, limit: number): Promise<FeedPage> {
    const entries = this.entries.slice(after, after + limit);
    return Promise.resolve({
      kind: 'page',
      page: {
        feedId: 'c'.repeat(32),
        entries,
        cursor: entries.at(-1)?.feedSeq ?? after,
        more: after + entries.length < this.entries.length,
      },
    });
  }

  lots(): Promise<LotList> {
    return Promise.resolve({ feedId: 'c'.repeat(32), lots: this.lotList.map((l) => ({ ...l })) });
  }

  post(kind: 'status' | 'confirmation', key: string): Promise<PostOutcome> {
    return Promise.resolve({
      kind: 'stored',
      status: 201,
      receipt: {
        idempotencyKey: key,
        kind,
        orderNumber: key.split('~')[0] ?? '',
        receivedSeq: 1,
        receivedAt: new Date(PLANT_T0).toISOString(),
      },
    });
  }
}

class Sink implements CommandPublisher {
  readonly connected = true;
  publish(): Promise<void> {
    return Promise.resolve();
  }
}

/** The facts of one simulator run, numbered per machine, one minute apart. */
class Line {
  readonly #feed: UnsFeed;
  readonly #seqs = new Map<string, number>();
  #at = PLANT_T0;
  readonly epoch: number;

  constructor(feed: UnsFeed, epoch: number) {
    this.#feed = feed;
    this.epoch = epoch;
  }

  get at(): number {
    return this.#at;
  }

  seq(equipment: string): number {
    return this.#seqs.get(equipment) ?? 0;
  }

  #next(equipment: string): number {
    const seq = (this.#seqs.get(equipment) ?? 0) + 1;
    this.#seqs.set(equipment, seq);
    return seq;
  }

  #time(): number {
    this.#at += 60_000;
    return this.#at;
  }

  state(equipment: string, state: 'Idle' | 'Running' = 'Running'): Delivery {
    return this.#feed.state(
      equipment,
      this.epoch,
      this.#next(equipment),
      this.#time(),
      state,
      null,
    );
  }

  cycle(
    equipment: string,
    partId: number,
    options: {
      result?: 'good' | 'scrap' | 'rework';
      reason?: string | null;
      lots?: { material: string; lot: string }[];
      operator?: string | null;
      measurement?: typeof READING;
      product?: string;
      serial?: string;
    } = {},
  ): Delivery {
    const modbus = equipment.startsWith('wsh');
    return this.#feed.cycle(equipment, this.epoch, this.#next(equipment), this.#time(), {
      product: options.product ?? 'VB-100',
      partId,
      serial: equipment.startsWith('cnc')
        ? (options.serial ?? `VB-100-${String(partId).padStart(6, '0')}`)
        : '',
      result: options.result ?? 'good',
      reason: options.reason ?? null,
      measurement: options.measurement ?? null,
      ...(modbus ? {} : { lots: options.lots ?? [] }),
      ...(modbus || options.operator === undefined ? {} : { operator: options.operator }),
    });
  }

  job(
    equipment: string,
    transition: 'accepted' | 'started' | 'completed',
    orderId: string,
    quantity: number,
  ): Delivery {
    return this.#feed.job(equipment, this.epoch, this.#next(equipment), this.#time(), {
      transition,
      commandId: `${orderId}~OP10~1`,
      orderId,
      product: 'VB-100',
      quantity,
    });
  }

  /** One unit through the routing: blank lot, components, the leak test's reading, packing. */
  unit(
    partId: number,
    lots: { blank: string; kit: string; spring?: string },
    serial?: string,
  ): Delivery[] {
    return [
      this.cycle('cnc-01', partId, {
        lots: [{ material: 'BLANK-100', lot: lots.blank }],
        operator: null,
        ...(serial === undefined ? {} : { serial }),
      }),
      this.cycle('wsh-01', partId),
      this.cycle('asm-01', partId, {
        lots: [
          { material: 'SK-1', lot: lots.kit },
          { material: 'SP-100', lot: lots.spring ?? 'P1' },
        ],
        operator: 'op-ayse',
      }),
      this.cycle('lkt-01', partId, { measurement: READING }),
      this.cycle('pck-01', partId),
    ];
  }

  /** A state fact on every machine: each is final through everything before it. */
  settleAll(): Delivery[] {
    return MACHINES.map((m) => this.state(m, 'Idle'));
  }
}

interface Harness {
  readonly db: Kysely<Database>;
  readonly ingest: Ingest;
  readonly orders: Orders;
  readonly execution: Execution;
  genealogy: Genealogy;
  readonly erp: FakeErp;
  readonly feed: UnsFeed;
  readonly line: Line;
  readonly crew: GenealogyCrew[];
  /** What the genealogy module logged (`warn` and `error`). */
  readonly logged: string[];
  /** Stops the genealogy module and starts a new one, on `execution` if given. */
  restart(execution?: GenealogyExecution): Promise<Genealogy>;
  readonly by: {
    by: { userId: number; username: string; roles: 'supervisor'[] };
    requestId: string;
  };
}

async function harness(
  name: string,
  options: { capacity?: Record<string, number>; epoch?: number } = {},
): Promise<Harness> {
  const db = await freshDatabase(serverUrl, `genealogy_${name}`);
  cleanups.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const identity = new Identity({ db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
  const sam = await identity.createUser(
    {
      username: 'sam',
      roles: ['supervisor'],
      password: 'a-long-test-password',
      mustChangePassword: false,
    },
    { system: 'test' },
  );
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'x',
    sweepIntervalMs: 0,
    gapGraceMs: 3_600_000,
  });
  const erp = new FakeErp();
  const feed = new UnsFeed(paths);
  const orders = new Orders({
    db,
    ingest,
    masterData,
    publisher: new Sink(),
    erp,
    clock: () => new Date(PLANT_T0),
    tickMs: 0,
    erpPollMs: 0,
    erpPostMs: 0,
    timings: { ttlMs: 3_600_000, failMarginMs: 3_600_000 },
  });
  await orders.start();
  cleanups.push(() => orders.stop());
  const execution = new Execution({
    db,
    ingest,
    masterData,
    orders,
    rework: { test: 'OP40', back: 'OP30' },
    clock: () => new Date(PLANT_T0),
    tickMs: 0,
  });
  await execution.start();
  cleanups.push(() => execution.stop());
  orders.useBlankCounter(execution);
  const crew: GenealogyCrew[] = [];
  const logged: string[] = [];
  const make = async (source: GenealogyExecution = execution) => {
    const genealogy = new Genealogy({
      db,
      ingest,
      execution: source,
      orders,
      masterData,
      erp,
      crew: () => Promise.resolve(crew),
      log: {
        info: () => undefined,
        warn: (_object, message) => logged.push(message),
        error: (_object, message) => logged.push(message),
      },
      packing: { operation: 'OP50', capacity: options.capacity ?? { ...plant.packing.capacity } },
      tickMs: 0,
      lotPollMs: 0,
    });
    await genealogy.start();
    cleanups.push(() => genealogy.stop());
    return genealogy;
  };
  const h: Harness = {
    db,
    ingest,
    orders,
    execution,
    genealogy: await make(),
    erp,
    feed,
    line: new Line(feed, options.epoch ?? E1),
    crew,
    logged,
    restart: async (source) => {
      await h.genealogy.stop();
      h.genealogy = await make(source);
      return h.genealogy;
    },
    by: { by: { userId: sam.id, username: 'sam', roles: ['supervisor'] }, requestId: 'req' },
  };
  return h;
}

/** Imports, releases and dispatches an order of `quantity` VB-100 to CNC-01. */
async function dispatched(h: Harness, number: string, quantity: number): Promise<void> {
  // The CNC's run must be known before a dispatch (its device epoch).
  if (h.line.seq('cnc-01') === 0) await send(h, [h.line.state('cnc-01', 'Idle')]);
  const expanded = expandErpDataset(
    {
      orders: [
        {
          orderNumber: number,
          revision: 1,
          product: 'VB-100',
          quantity,
          plannedStart: '2026-10-12T06:00:00+03:00',
          dueDate: '2026-10-12T14:00:00+03:00',
        },
      ],
    },
    erpMasterData(plant),
  );
  if (!expanded.ok) throw new Error(expanded.issues.join('\n'));
  h.erp.entries.push(...expanded.feed.map((e) => ({ ...e, feedSeq: h.erp.entries.length + 1 })));
  await h.orders.importNow();
  const imported = await h.orders.order(number);
  const released = await h.orders.release(number, { version: imported?.version ?? 0 }, h.by);
  await h.orders.dispatch(number, { version: released.version, equipment: 'cnc-01' }, h.by);
}

const send = async (h: Harness, deliveries: readonly Delivery[]) => {
  for (const d of deliveries) await h.ingest.deliver(d.topic, d.payload);
};

/** Orders, execution and genealogy up to date. */
async function settle(h: Harness): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await h.orders.tick();
    await h.execution.tick();
    await h.genealogy.tick();
  }
}

const incidents = async (h: Harness) =>
  (await h.genealogy.incidents()).map((i) => [
    i.type,
    i.lot,
    i.closedAt === null ? 'open' : 'closed',
  ]);

describe('genealogy: lots, links, incidents and cartons (#199)', () => {
  it('imports the ERP’s lots, retires one no longer listed, and an unknown lot’s incident closes with the import', async () => {
    const h = await harness('lots');
    expect((await h.genealogy.lots()).map((l) => [l.id, l.material, l.status])).toEqual([
      ['B1', 'BLANK-100', 'active'],
      ['B2', 'BLANK-100', 'active'],
      ['K1', 'SK-1', 'active'],
      ['K2', 'SK-1', 'active'],
      ['P1', 'SP-100', 'active'],
    ]);
    await dispatched(h, 'X-1', 1);
    const l = h.line;
    await send(h, [
      l.job('cnc-01', 'accepted', 'X-1', 1),
      l.job('cnc-01', 'started', 'X-1', 1),
      ...l.unit(1, { blank: 'B1', kit: 'K9' }),
    ]);
    await settle(h);
    expect(await incidents(h)).toEqual([['unknown-lot', 'K9', 'open']]);
    // The forward trace of a lot never imported still answers, from the links.
    expect((await h.genealogy.lot('K9'))?.master).toBeNull();
    h.erp.lotList = [
      ...h.erp.lotList.filter((lot) => lot.id !== 'P1'),
      { id: 'K9', material: 'SK-1', quantity: 5 },
    ];
    expect(await h.genealogy.importLots()).toBe(5);
    await settle(h);
    expect(await incidents(h)).toEqual([['unknown-lot', 'K9', 'closed']]);
    const lots = await h.genealogy.lots();
    expect(lots.find((lot) => lot.id === 'P1')?.status).toBe('retired');
    expect((await h.genealogy.lot('K9'))?.master).toMatchObject({ material: 'SK-1', quantity: 5 });
    // Listed again: active again; an import is idempotent.
    h.erp.lotList.push({ id: 'P1', material: 'SP-100', quantity: 10 });
    await h.genealogy.importLots();
    await h.genealogy.importLots();
    expect((await h.genealogy.lots()).map((lot) => lot.status)).toEqual(Array(6).fill('active'));
    // The ERP changes a lot's material: logged once (not on every poll), the stored material
    // follows, and the units of the lot are judged against it (review L8).
    h.erp.lotList = h.erp.lotList.map((lot) =>
      lot.id === 'B1' ? { ...lot, material: 'BLANK-200' } : lot,
    );
    await h.genealogy.importLots();
    await h.genealogy.importLots();
    await settle(h);
    expect(h.logged.filter((m) => m.includes('changed a lot’s material'))).toHaveLength(1);
    expect((await h.genealogy.lot('B1'))?.master?.material).toBe('BLANK-200');
    const changed = await h.genealogy.incidents({ type: 'material-mismatch' });
    expect(
      changed.map((i) => [i.lot, i.message.includes('the ERP lists it as BLANK-200')]),
    ).toEqual([['B1', true]]);
  });

  it('links lots per operation and pass with operator and reading, keeps absent apart from [] and null, and says when an answer is final', async () => {
    const h = await harness('links');
    await dispatched(h, 'X-1', 1);
    const l = h.line;
    h.crew.push({
      userId: 7,
      username: 'olga',
      fromPlant: new Date(PLANT_T0),
      toPlant: null,
    });
    await send(h, [
      l.job('cnc-01', 'accepted', 'X-1', 1),
      l.job('cnc-01', 'started', 'X-1', 1),
      l.cycle('cnc-01', 1, { lots: [{ material: 'BLANK-100', lot: 'B1' }], operator: null }),
      l.job('cnc-01', 'completed', 'X-1', 1),
      l.cycle('wsh-01', 1),
      l.cycle('asm-01', 1, {
        lots: [
          { material: 'SK-1', lot: 'K1' },
          { material: 'SP-100', lot: 'P1' },
        ],
        operator: 'op-ayse',
      }),
      l.cycle('lkt-01', 1, {
        result: 'rework',
        reason: 'LEAK',
        measurement: { ...READING, value: 3.5 },
      }),
      // The rework pass takes a new seal kit, of another lot.
      l.cycle('asm-01', 1, { lots: [{ material: 'SK-1', lot: 'K2' }], operator: 'op-mehmet' }),
      l.cycle('lkt-01', 1, { measurement: READING }),
      l.cycle('pck-01', 1),
    ]);
    await settle(h);
    // Only PCK-01 has reported up to the unit's latest record (its packing): the others may still
    // deliver a fact before it, so the answer is not final yet.
    const early = await h.genealogy.serial('VB-100-000001');
    expect([early?.final, early?.notFinal]).toEqual([
      false,
      ['asm-01', 'cnc-01', 'cnc-02', 'lkt-01', 'wsh-01'],
    ]);
    await send(h, l.settleAll());
    await settle(h);
    const trace = await h.genealogy.serial('VB-100-000001');
    expect([trace?.final, trace?.notFinal]).toEqual([true, []]);
    const [unit] = trace?.units ?? [];
    expect([unit?.orderId, unit?.status, unit?.carton]).toEqual(['X-1', 'packed', 'X-1-C01']);
    expect(
      unit?.records.map((r) => [
        r.operation,
        r.pass,
        r.equipment,
        r.result,
        r.lots?.map((x) => x.lot) ?? null,
        r.operator,
        r.operatorReported,
        r.measurement?.value ?? null,
        r.crew.map((c) => c.username),
      ]),
    ).toEqual([
      ['OP10', 1, 'cnc-01', 'good', ['B1'], null, true, null, []],
      // WSH-01 (Modbus) reports no lots: not reported, not "none".
      ['OP20', 1, 'wsh-01', 'good', null, null, false, null, []],
      ['OP30', 1, 'asm-01', 'good', ['K1', 'P1'], 'op-ayse', true, null, ['olga']],
      ['OP40', 1, 'lkt-01', 'rework', [], null, false, 3.5, []],
      ['OP30', 2, 'asm-01', 'good', ['K2'], 'op-mehmet', true, null, ['olga']],
      ['OP40', 2, 'lkt-01', 'good', [], null, false, 2.104, []],
      ['OP50', 1, 'pck-01', 'good', [], null, false, null, []],
    ]);
    // The links themselves: lot, operation, pass, machine and the cycle's time (review L10).
    const links = await h.db
      .selectFrom('genealogy.genealogy_link')
      .select(['lot', 'material', 'operation', 'pass', 'equipment', 'position', 'at'])
      .where('kind', '=', 'lot-unit')
      .orderBy('at')
      .orderBy('position')
      .execute();
    const times = (unit?.records ?? []).map((r) => r.at.getTime());
    expect(
      links.map((x) => [
        x.lot,
        x.material,
        x.operation,
        x.pass,
        x.equipment,
        x.position,
        x.at.getTime(),
      ]),
    ).toEqual([
      ['B1', 'BLANK-100', 'OP10', 1, 'cnc-01', 0, times[0]],
      ['K1', 'SK-1', 'OP30', 1, 'asm-01', 0, times[2]],
      ['P1', 'SP-100', 'OP30', 1, 'asm-01', 1, times[2]],
      ['K2', 'SK-1', 'OP30', 2, 'asm-01', 0, times[4]],
    ]);
    const k2 = await h.genealogy.lot('K2');
    expect([k2?.consumed, k2?.units.map((u) => u.partId), k2?.orders, k2?.cartons]).toEqual([
      1,
      [1],
      ['X-1'],
      ['X-1-C01'],
    ]);
    expect(k2?.withLots.map((x) => x.lot)).toEqual(['B1', 'K1', 'P1']);
    expect(k2?.final).toBe(true);
    // The order is complete: its one carton closed at the completion, partial.
    const carton = await h.genealogy.carton('X-1-C01');
    expect([
      carton?.carton.status,
      carton?.carton.members,
      carton?.units.map((u) => u.partId),
    ]).toEqual(['closed', 1, [1]]);
    expect(carton?.carton.closedAt).toEqual((await h.orders.order('X-1'))?.completedAt);
    expect(await h.genealogy.incidents()).toEqual([]);
    expect(await h.genealogy.search('VB-100-0000')).toEqual([
      { kind: 'serial', id: 'VB-100-000001' },
    ]);
    expect(await h.genealogy.search('X-1')).toEqual([
      { kind: 'carton', id: 'X-1-C01' },
      { kind: 'order', id: 'X-1' },
    ]);
    expect(await h.genealogy.search('K')).toEqual([
      { kind: 'lot', id: 'K1' },
      { kind: 'lot', id: 'K2' },
    ]);
    expect(await h.genealogy.search('%')).toEqual([]);
    // A restarted module catches up from the tables and gives the same answer.
    const before = await h.genealogy.serial('VB-100-000001');
    await h.db.deleteFrom('genealogy.genealogy_link').execute();
    await h.db.deleteFrom('genealogy.unit_record').execute();
    await h.restart();
    await settle(h);
    expect(await h.genealogy.serial('VB-100-000001')).toEqual(before);
  });

  it('raises material-mismatch against the order’s BOM, and the product’s without an order, only on final attribution', async () => {
    const h = await harness('mismatch');
    await dispatched(h, 'X-1', 2);
    const l = h.line;
    // A cycle of the order delivered before its job's `started` fact: no order yet, nothing judged.
    const accepted = l.job('cnc-01', 'accepted', 'X-1', 2);
    const started = l.job('cnc-01', 'started', 'X-1', 2);
    const first = l.cycle('cnc-01', 1, { lots: [{ material: 'BLANK-100', lot: 'B1' }] });
    const wrong = l.cycle('asm-01', 1, {
      lots: [
        { material: 'BLANK-100', lot: 'B2' },
        { material: 'SP-100', lot: 'P1' },
      ],
      operator: 'op-ayse',
    });
    await send(h, [first, wrong]);
    await settle(h);
    // The CNC is not final through the OP10 record (its job facts are missing): not judged yet.
    expect(await incidents(h)).toEqual([]);
    await send(h, [accepted, started]);
    await settle(h);
    expect(await incidents(h)).toEqual([['material-mismatch', 'B2', 'open']]);
    const [incident] = await h.genealogy.incidents();
    expect(incident?.message).toContain('BLANK-100 (lot B2) is not a standard material of OP30');
    expect(incident?.message).toContain('(order X-1)');
    // Schedule mode on CNC-02 (no job): the product's BOM.
    await send(h, [
      l.cycle('cnc-02', 2, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      l.state('cnc-02'),
      l.cycle('asm-01', 2, { lots: [{ material: 'SK-2', lot: 'K1' }], operator: 'op-ayse' }),
    ]);
    await settle(h);
    const found = (await h.genealogy.incidents()).map((i) => i.message);
    expect(found.filter((m) => m.includes('product BOM: no order'))).toHaveLength(1);
    expect(found.some((m) => m.includes('lot K1 was reported as SK-2'))).toBe(false);
    expect(found.some((m) => m.includes('SK-2 (lot K1) is not a standard material of OP30'))).toBe(
      true,
    );
  });

  it('raises serial-reused once per pair of device epochs, and lists every unit of a serial, newest first', async () => {
    const h = await harness('serials');
    const run1 = h.line;
    const run2 = new Line(h.feed, E2);
    await send(h, [
      run1.cycle('cnc-01', 1, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      run1.cycle('cnc-01', 2, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
    ]);
    await settle(h);
    await send(h, [
      run2.cycle('cnc-01', 1, { lots: [{ material: 'BLANK-100', lot: 'B2' }] }),
      run2.cycle('cnc-01', 2, { lots: [{ material: 'BLANK-100', lot: 'B2' }] }),
    ]);
    await settle(h);
    const reused = await h.genealogy.incidents({ type: 'serial-reused' });
    expect(reused.map((i) => [i.type, i.epoch, i.closedAt])).toEqual([['serial-reused', E2, null]]);
    expect(reused[0]?.message).toContain(`${String(E1)} and ${String(E2)}`);
    const trace = await h.genealogy.serial('VB-100-000001');
    expect(trace?.units.map((u) => [u.epoch, u.records[0]?.lots?.map((x) => x.lot)])).toEqual([
      [E2, ['B2']],
      [E1, ['B1']],
    ]);
    // A lot is not tied to a run: its forward trace spans epochs.
    expect((await h.genealogy.lot('B1'))?.units.map((u) => [u.epoch, u.partId])).toEqual([
      [E1, 1],
      [E1, 2],
    ]);
  });

  it('places cartons on final packing data only, re-places after a late earlier pack, and keeps a contiguous processed watermark', async () => {
    const h = await harness('cartons', { capacity: { 'VB-100': 2, 'VB-200': 2 } });
    expect(h.genealogy.processedThrough('pck-01', E1)).toBeNull();
    await dispatched(h, 'X-1', 3);
    const l = h.line;
    await send(h, [l.job('cnc-01', 'accepted', 'X-1', 3), l.job('cnc-01', 'started', 'X-1', 3)]);
    const units = [1, 2, 3].map((id) => l.unit(id, { blank: 'B1', kit: 'K1' }));
    const late = units[1]?.[4];
    if (!late) throw new Error('fact');
    // Every fact but unit 2's packing cycle: PCK-01 is not final past it.
    await send(h, [
      ...units.flatMap((facts) => facts.filter((f) => f !== late)),
      l.job('cnc-01', 'completed', 'X-1', 3),
    ]);
    await settle(h);
    const placed = async () =>
      (await h.genealogy.cartons()).map((c) => [c.id, c.status, c.members]);
    const members = async () =>
      Object.fromEntries(
        [...(await h.genealogy.cartonMembers())].map(([id, list]) => [
          id,
          list.map((m) => m.partId),
        ]),
      );
    // Unit 1's pack is final; unit 3's is above the gap: not placed (it would take unit 2's place).
    expect(await placed()).toEqual([['X-1-C01', 'open', 1]]);
    expect(await members()).toEqual({ 'X-1-C01': [1] });
    // The processed watermark stops below the gap on PCK-01 (contiguous, not the highest seen).
    const gapAt = (JSON.parse(late.payload) as { seq: number }).seq;
    expect(h.genealogy.processedThrough('pck-01', E1)).toBe(gapAt - 1);
    expect(h.genealogy.covers([{ equipment: 'pck-01', epoch: E1, seq: gapAt - 1 }])).toBe(true);
    expect(h.genealogy.covers([{ equipment: 'pck-01', epoch: E1, seq: gapAt + 1 }])).toBe(false);
    expect(h.genealogy.processedThrough('pck-01', E1 - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(h.genealogy.processedThrough('pck-01', E2)).toBeNull();
    // The late pack arrives: placed in plant-time order, and the order completes.
    await send(h, [late, ...l.settleAll()]);
    await settle(h);
    expect(h.genealogy.processedThrough('pck-01', E1)).toBe(l.seq('pck-01'));
    expect(await members()).toEqual({ 'X-1-C01': [1, 2], 'X-1-C02': [3] });
    const order = await h.orders.order('X-1');
    expect(order?.status).toBe('completed');
    const cartons = await h.genealogy.cartons({ orderId: 'X-1' });
    expect(cartons.map((c) => [c.id, c.status, c.members, c.closedAt?.getTime()])).toEqual([
      [
        'X-1-C01',
        'closed',
        2,
        Date.parse((JSON.parse(late.payload) as { sourceTime: string }).sourceTime),
      ],
      ['X-1-C02', 'closed', 1, order?.completedAt?.getTime()],
    ]);
    expect((await h.genealogy.serial('VB-100-000003'))?.units[0]?.carton).toBe('X-1-C02');
  });
});

describe('the trace API (#199)', () => {
  it('answers serials, lots, cartons, search and incidents, 404 for unknown ids and 400 for bad ones', async () => {
    const h = await harness('api');
    await dispatched(h, 'X-1', 1);
    const l = h.line;
    await send(h, [
      l.job('cnc-01', 'accepted', 'X-1', 1),
      l.job('cnc-01', 'started', 'X-1', 1),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
      l.job('cnc-01', 'completed', 'X-1', 1),
      ...l.settleAll(),
    ]);
    await settle(h);
    const identity = new Identity({ db: h.db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
    const http = await buildMesHttp({ ready: () => Promise.resolve(true), identity, auth: false });
    cleanups.push(() => http.app.close());
    await http.realtime.attach({
      masterData: new MasterData(h.db),
      equipment: {
        currentStates: () => [],
        currentState: () => undefined,
        onChange: () => () => undefined,
        watermark: () => undefined,
        watermarks: () => [],
      },
      ingest: { onStored: () => () => undefined, telemetryMetrics: () => Promise.resolve([]) },
      oee: { workCenters: () => Promise.resolve([]), onChange: () => () => undefined },
      coding: {},
      genealogy: h.genealogy,
    } as unknown as ApiSources);
    const get = async (url: string) => {
      const response = await http.app.inject({
        method: 'GET',
        url,
        headers: { host: 'localhost:4700' },
      });
      return { status: response.statusCode, body: response.json<unknown>() };
    };
    const serial = await get('/api/v1/trace/serials/VB-100-000001');
    expect(serial.status).toBe(200);
    const parsed = serialTraceSchema.parse(serial.body);
    expect([parsed.final, parsed.units[0]?.carton, parsed.units[0]?.records.length]).toEqual([
      true,
      'X-1-C01',
      5,
    ]);
    expect(parsed.units[0]?.records[3]?.reading?.value).toBe(2.104);
    const lot = lotTraceSchema.parse((await get('/api/v1/trace/lots/B1')).body);
    expect([lot.consumed, lot.orders, lot.cartons, lot.master?.status]).toEqual([
      1,
      ['X-1'],
      ['X-1-C01'],
      'active',
    ]);
    const carton = cartonTraceSchema.parse((await get('/api/v1/trace/cartons/X-1-C01')).body);
    expect([
      carton.carton.status,
      carton.units.map((u) => u.serial),
      carton.lots.map((x) => x.lot),
    ]).toEqual(['closed', ['VB-100-000001'], ['B1', 'K1', 'P1']]);
    expect(traceSearchSchema.parse((await get('/api/v1/trace/search?q=B')).body).results).toEqual([
      { kind: 'lot', id: 'B1' },
      { kind: 'lot', id: 'B2' },
    ]);
    expect(
      genealogyIncidentListSchema.parse((await get('/api/v1/genealogy-incidents?open=true')).body),
    ).toEqual({ incidents: [] });
    expect((await get('/api/v1/trace/serials/NOPE')).status).toBe(404);
    expect((await get('/api/v1/trace/lots/NOPE')).status).toBe(404);
    expect((await get('/api/v1/trace/cartons/NOPE')).status).toBe(404);
    expect((await get('/api/v1/trace/search')).status).toBe(400);
    expect((await get('/api/v1/trace/search?q=B%00')).status).toBe(400);
    expect(await h.genealogy.search('B\u0000')).toEqual([]);
    expect((await get('/api/v1/genealogy-incidents?type=other')).status).toBe(400);
  });
});

/** Every closed carton's members (by id), for the invariant that they never change. */
const closedMembers = async (h: Harness) => {
  const members = await h.genealogy.cartonMembers();
  return new Map(
    (await h.genealogy.cartons())
      .filter((c) => c.status === 'closed')
      .map((c) => [c.id, (members.get(c.id) ?? []).map((m) => m.partId)]),
  );
};

describe('genealogy on partial data (#199 review)', () => {
  it('places a pack only once its unit’s order is final, so a late job fact moves no closed carton’s member (H2)', async () => {
    const h = await harness('h2', { capacity: { 'VB-100': 2, 'VB-200': 2 } });
    await dispatched(h, 'X-1', 3);
    await dispatched(h, 'X-2', 3);
    const l = h.line;
    const start = [l.job('cnc-01', 'accepted', 'X-1', 3), l.job('cnc-01', 'started', 'X-1', 3)];
    const u1 = l.unit(1, { blank: 'B1', kit: 'K1' });
    // X-1 ends after one unit, X-2 starts: its job facts arrive last.
    const late = [
      l.job('cnc-01', 'completed', 'X-1', 3),
      l.job('cnc-01', 'accepted', 'X-2', 3),
      l.job('cnc-01', 'started', 'X-2', 3),
    ];
    const u2 = l.unit(2, { blank: 'B1', kit: 'K1' });
    const u3 = l.unit(3, { blank: 'B1', kit: 'K1' });
    // Every machine final but the CNC (its job facts are missing).
    const tail = l.settleAll().filter((d) => !d.topic.includes('cnc-01'));
    await send(h, [...start, ...u1, ...u2, ...u3, ...tail]);
    await settle(h);
    // Units 2 and 3 count for X-1 for now, but their order is not final: not placed.
    expect((await h.genealogy.serial('VB-100-000002'))?.units[0]?.orderId).toBe('X-1');
    const before = await closedMembers(h);
    expect(Object.fromEntries([...(await h.genealogy.cartonMembers())])).toEqual({
      'X-1-C01': [{ epoch: E1, partId: 1 }],
    });
    await send(h, [...late, l.state('cnc-01', 'Idle')]);
    await settle(h);
    const after = await closedMembers(h);
    for (const [id, members] of before) expect([id, after.get(id)]).toEqual([id, members]);
    expect(
      Object.fromEntries(
        [...(await h.genealogy.cartonMembers())].map(([id, m]) => [id, m.map((x) => x.partId)]),
      ),
    ).toEqual({ 'X-1-C01': [1], 'X-2-C01': [2, 3] });
    expect((await h.genealogy.cartons({ orderId: 'X-2' }))[0]?.status).toBe('closed');
    expect(await incidents(h)).toEqual([]);
  });

  it('moves the processed watermark on past a written-off gap (H1)', async () => {
    const h = await harness('h1', { capacity: { 'VB-100': 2, 'VB-200': 2 } });
    await dispatched(h, 'X-1', 5);
    const l = h.line;
    await send(h, [
      l.state('pck-01'),
      l.job('cnc-01', 'accepted', 'X-1', 5),
      l.job('cnc-01', 'started', 'X-1', 5),
    ]);
    const u1 = l.unit(1, { blank: 'B1', kit: 'K1' });
    const lost = u1[4]; // PCK-01's cycle of unit 1 never arrives
    await send(
      h,
      u1.filter((d) => d !== lost),
    );
    await settle(h);
    await send(h, l.unit(2, { blank: 'B1', kit: 'K1' }));
    await settle(h);
    const gap = (JSON.parse(lost?.payload ?? '{}') as { seq: number }).seq;
    expect(h.genealogy.processedThrough('pck-01', E1)).toBe(gap - 1);
    // The gap is written off (an incident): every number up to the stream's end is settled.
    await h.ingest.sweep(0);
    await settle(h);
    await send(h, [...l.unit(3, { blank: 'B1', kit: 'K1' }), ...l.settleAll()]);
    await settle(h);
    expect(h.genealogy.processedThrough('pck-01', E1)).toBe(l.seq('pck-01'));
    expect(h.genealogy.covers([{ equipment: 'pck-01', epoch: E1, seq: l.seq('pck-01') }])).toBe(
      true,
    );
    const trace = await h.genealogy.serial('VB-100-000003');
    expect([trace?.final, trace?.units[0]?.carton]).toEqual([true, 'X-1-C01']);
    expect(
      Object.fromEntries(
        [...(await h.genealogy.cartonMembers())].map(([id, m]) => [id, m.map((x) => x.partId)]),
      ),
    ).toEqual({ 'X-1-C01': [2, 3] });
  });

  it('judges a mismatch of a unit whose OP10 fact was lost once its machines are final through its records (M3)', async () => {
    const h = await harness('m3');
    const l = h.line;
    // Schedule mode on CNC-02; unit 1's OP10 fact never arrives.
    const lost = l.cycle('cnc-02', 1, { lots: [{ material: 'BLANK-100', lot: 'B1' }] });
    await send(h, [
      l.state('cnc-02'),
      l.cycle('asm-01', 1, { lots: [{ material: 'SK-2', lot: 'K1' }], operator: 'op-ayse' }),
    ]);
    await send(h, [...l.settleAll()]);
    await settle(h);
    // The lost fact's gap is written off: the unit has no OP10 record for good, and every machine
    // of its records is final through them. Judged with the product's BOM.
    await h.ingest.sweep(0);
    await settle(h);
    expect(await h.genealogy.serial('VB-100-000001')).toBeUndefined();
    const found = await h.genealogy.incidents({ type: 'material-mismatch' });
    expect(found.map((i) => [i.partId, i.message.includes('product BOM: no order')])).toEqual([
      [1, true],
    ]);
    expect(lost.topic).toContain('cnc-02');
  });

  it('catches up on start with the units execution changed while genealogy was not following (M4)', async () => {
    const h = await harness('m4');
    const l = h.line;
    await send(h, [
      l.cycle('cnc-02', 1, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      l.state('cnc-02'),
    ]);
    await settle(h);
    expect((await h.genealogy.serial('VB-100-000001'))?.units[0]?.status).toBe('wip');
    await h.genealogy.stop();
    // A new run: execution marks the old run's unit in WIP lost, and nobody follows.
    const run2 = new Line(h.feed, E2);
    await send(h, [run2.state('cnc-02')]);
    await h.execution.tick();
    await h.restart();
    expect((await h.genealogy.serial('VB-100-000001'))?.units[0]?.status).toBe('lost');
  });

  it('rewrites no carton whose placement is unchanged (M5)', async () => {
    const h = await harness('m5', { capacity: { 'VB-100': 2, 'VB-200': 2 } });
    await dispatched(h, 'X-1', 2);
    const l = h.line;
    await send(h, [
      l.job('cnc-01', 'accepted', 'X-1', 2),
      l.job('cnc-01', 'started', 'X-1', 2),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
      ...l.unit(2, { blank: 'B1', kit: 'K1' }),
      l.job('cnc-01', 'completed', 'X-1', 2),
      ...l.settleAll(),
    ]);
    await settle(h);
    const stamp = async () =>
      (await h.db.selectFrom('genealogy.carton').select(['id', 'updated_at']).execute()).map(
        (r) => [r.id, r.updated_at.getTime()],
      );
    const first = await stamp();
    expect(first).toHaveLength(1);
    await send(h, [l.state('pck-01', 'Running')]);
    await settle(h);
    await h.restart();
    await settle(h);
    expect(await stamp()).toEqual(first);
  });

  it('keeps a unit whose rebuild fails on its own as it was, with an incident, and goes on (L10)', async () => {
    const h = await harness('isolate');
    const l = h.line;
    const broken: GenealogyExecution = {
      onUnits: (listener) => h.execution.onUnits(listener),
      processedThrough: () => h.execution.processedThrough(),
      unitStates: () => h.execution.unitStates(),
      units: async (query) => {
        const found = await h.execution.units(query);
        // Unit 2 can't be stored (a status the table refuses).
        return {
          units: found.units.map((u) => (u.partId === 2 ? { ...u, status: 'bogus' as never } : u)),
        };
      },
    };
    await h.restart(broken);
    await send(h, [
      l.cycle('cnc-02', 1, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      l.cycle('cnc-02', 2, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      l.cycle('cnc-02', 3, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      l.state('cnc-02'),
    ]);
    await settle(h);
    expect((await h.genealogy.lot('B1'))?.units.map((u) => u.partId)).toEqual([1, 3]);
    expect(await incidents(h)).toEqual([['rebuild-failed', null, 'open']]);
    // The watermark holds below unit 2's fact (seq 2 on CNC-02): a close guard would answer
    // genealogy-pending (#201) while the unit keeps failing, and its answers are not final.
    expect(h.genealogy.processedThrough('cnc-02', E1)).toBe(1);
    expect(h.genealogy.covers([{ equipment: 'cnc-02', epoch: E1, seq: 2 }])).toBe(false);
    expect((await h.genealogy.serial('VB-100-000003'))?.notFinal).toContain('cnc-02');
    // Further rounds retry it with a backoff, still failing: the watermark keeps holding.
    await settle(h);
    await settle(h);
    expect(h.genealogy.processedThrough('cnc-02', E1)).toBe(1);
    // Rebuilt by a sound module, the incident closes and the watermark moves on.
    await h.restart();
    await settle(h);
    expect((await h.genealogy.lot('B1'))?.units.map((u) => u.partId)).toEqual([1, 2, 3]);
    expect(await incidents(h)).toEqual([['rebuild-failed', null, 'closed']]);
    expect(h.genealogy.processedThrough('cnc-02', E1)).toBe(l.seq('cnc-02'));
  });

  it('retries a unit whose single-unit round failed once, and the watermark moves on once it is rebuilt (PROBE4)', async () => {
    const h = await harness('transient');
    const l = h.line;
    let fail = false;
    const flaky: GenealogyExecution = {
      onUnits: (listener) => h.execution.onUnits(listener),
      processedThrough: () => h.execution.processedThrough(),
      unitStates: () => h.execution.unitStates(),
      units: async (query) => {
        const found = await h.execution.units(query);
        if (!fail) return found;
        fail = false;
        return { units: found.units.map((u) => ({ ...u, status: 'bogus' as never })) };
      },
    };
    await h.restart(flaky);
    await send(h, [
      l.cycle('cnc-02', 1, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      l.state('cnc-02'),
    ]);
    await settle(h);
    fail = true;
    const unit2 = l.cycle('cnc-02', 2, { lots: [{ material: 'BLANK-100', lot: 'B2' }] });
    await send(h, [unit2, l.state('cnc-02')]);
    // The round that rebuilds unit 2 alone fails once: the watermark stays below its fact.
    await h.execution.tick();
    await h.genealogy.tick();
    const seq = (JSON.parse(unit2.payload) as { seq: number }).seq;
    expect(h.genealogy.processedThrough('cnc-02', E1)).toBe(seq - 1);
    expect(h.genealogy.covers([{ equipment: 'cnc-02', epoch: E1, seq }])).toBe(false);
    // The next round retries it, and it is rebuilt: no incident, the watermark moves on.
    await settle(h);
    expect((await h.genealogy.lot('B2'))?.units.map((u) => u.partId)).toEqual([2]);
    expect(h.genealogy.processedThrough('cnc-02', E1)).toBe(l.seq('cnc-02'));
    expect(h.genealogy.covers([{ equipment: 'cnc-02', epoch: E1, seq }])).toBe(true);
    expect(await incidents(h)).toEqual([]);
  });

  it('places no order’s pack at or after a pack whose unit’s order is not final, of any order (two CNCs)', async () => {
    const h = await harness('cutoff', { capacity: { 'VB-100': 2, 'VB-200': 2 } });
    await dispatched(h, 'X-1', 2);
    const l = h.line;
    await send(h, [l.state('cnc-02')]);
    // A fact of CNC-02 is missing: its unit 3's order is not final (a job fact may be on its way).
    const missing = l.state('cnc-02');
    const jobs = [l.job('cnc-01', 'accepted', 'X-1', 2), l.job('cnc-01', 'started', 'X-1', 2)];
    const u1 = l.unit(1, { blank: 'B1', kit: 'K1' });
    // Unit 3 runs on CNC-02 and packs between units 1 and 2.
    const u3 = [
      l.cycle('cnc-02', 3, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      l.cycle('wsh-01', 3),
      l.cycle('asm-01', 3, {
        lots: [
          { material: 'SK-1', lot: 'K1' },
          { material: 'SP-100', lot: 'P1' },
        ],
        operator: 'op-ayse',
      }),
      l.cycle('lkt-01', 3, { measurement: READING }),
      l.cycle('pck-01', 3),
    ];
    const u2 = l.unit(2, { blank: 'B1', kit: 'K1' });
    await send(h, [
      ...jobs,
      ...u1,
      ...u3,
      ...u2,
      l.job('cnc-01', 'completed', 'X-1', 2),
      ...l.settleAll(),
    ]);
    await settle(h);
    const members = async () =>
      Object.fromEntries(
        [...(await h.genealogy.cartonMembers())].map(([id, m]) => [id, m.map((x) => x.partId)]),
      );
    // Unit 2 packs after unit 3, whose order is not final: not placed yet.
    expect(await members()).toEqual({ 'X-1-C01': [1] });
    await send(h, [missing]);
    await settle(h);
    expect(await members()).toEqual({ 'X-1-C01': [1, 2] });
    expect((await h.genealogy.cartons({ orderId: 'X-1' }))[0]?.status).toBe('closed');
  });

  it('places no pack past a unit whose rebuild keeps failing, so no carton closes without it (PROBE5)', async () => {
    const h = await harness('poison_carton', { capacity: { 'VB-100': 2, 'VB-200': 2 } });
    let poison = 0;
    const flaky: GenealogyExecution = {
      onUnits: (listener) => h.execution.onUnits(listener),
      processedThrough: () => h.execution.processedThrough(),
      unitStates: () => h.execution.unitStates(),
      units: async (query) => {
        const found = await h.execution.units(query);
        if (poison === 0 || !found.units.some((u) => u.partId === 2)) return found;
        poison--;
        return {
          units: found.units.map((u) => (u.partId === 2 ? { ...u, status: 'bogus' as never } : u)),
        };
      },
    };
    await h.restart(flaky);
    await dispatched(h, 'X-1', 3);
    const l = h.line;
    await send(h, [l.job('cnc-01', 'accepted', 'X-1', 3), l.job('cnc-01', 'started', 'X-1', 3)]);
    poison = 1_000;
    await send(h, [
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
      ...l.unit(2, { blank: 'B1', kit: 'K1' }),
      ...l.unit(3, { blank: 'B1', kit: 'K1' }),
      ...l.settleAll(),
    ]);
    for (let i = 0; i < 4; i++) await settle(h);
    const members = async () =>
      Object.fromEntries(
        [...(await h.genealogy.cartonMembers())].map(([id, m]) => [id, m.map((x) => x.partId)]),
      );
    // Unit 2 keeps failing: unit 3 doesn't take its place, the carton stays open with unit 1.
    expect(await members()).toEqual({ 'X-1-C01': [1] });
    expect((await h.genealogy.cartons({ orderId: 'X-1' })).map((c) => c.status)).toEqual(['open']);
    expect(await incidents(h)).toEqual([['rebuild-failed', null, 'open']]);
    // Once it rebuilds (within the backoff), the cartons are placed in order.
    poison = 0;
    for (let i = 0; i < 40; i++) await settle(h);
    expect(await members()).toEqual({ 'X-1-C01': [1, 2], 'X-1-C02': [3] });
    expect(await incidents(h)).toEqual([['rebuild-failed', null, 'closed']]);
  });
});
