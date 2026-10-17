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
import { Genealogy, type GenealogyCrew } from './modules/genealogy/index.ts';
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
  restart(): Promise<Genealogy>;
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
  const make = async () => {
    const genealogy = new Genealogy({
      db,
      ingest,
      execution,
      orders,
      masterData,
      erp,
      crew: () => Promise.resolve(crew),
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
    restart: async () => {
      await h.genealogy.stop();
      h.genealogy = await make();
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
    expect((await get('/api/v1/genealogy-incidents?type=other')).status).toBe(400);
  });
});
