/**
 * Quality holds (#201, plan "Quality holds", ADR-0035) against a real database (as `mes_app`) with
 * the real ingest store and the orders, execution and genealogy modules: a lot hold's scope that
 * grows with late facts and with consumption after it (`held-material-consumed`), serial, carton
 * and order holds, the lifecycle (versions, decisions, reasons, append-only transitions), the ERP
 * notifications through the orders outbox (a 409 an incident, never retried), and the close guard:
 * 409 `quality-hold`, 409 `genealogy-pending`, the two-connection race in both orders of arrival
 * and a hold and a close at once in one process (with a timeout). And the hold routes.
 */
import {
  expandErpDataset,
  qualityNotificationKey,
  qualityNotificationRequestSchema,
  type FeedEntry,
  type Lot,
  type LotList,
} from '@shopfloor/contracts/erp-api';
import {
  PROBLEM_TYPES,
  problemSchema,
  cartonTraceSchema,
  holdDetailSchema,
  holdListSchema,
  holdReasonListSchema,
  holdSchema,
  lotTraceSchema,
  serialTraceSchema,
} from '@shopfloor/contracts/mes-api';
import type { EquipmentPath } from '@shopfloor/contracts';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  ownerOf,
  type Delivery,
} from './modules/equipment/test-support.ts';
import { Execution } from './modules/execution/index.ts';
import { Genealogy, type LotLinks } from './modules/genealogy/index.ts';
import { Identity } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData, erpMasterData } from './modules/master-data/index.ts';
import {
  Orders,
  type CommandPublisher,
  type ErpApi,
  type ErpMessageKind,
  type FeedPage,
  type PostOutcome,
} from './modules/orders/index.ts';
import { Holds, type SignalWindow } from './modules/quality/index.ts';
import type { ApiSources } from './modules/realtime/index.ts';
import { backendPid, blockedBy, startDatabase } from './testing.ts';

const PLANT_T0 = Date.parse('2026-10-12T03:00:00.000Z');
const E1 = 1_760_000_000;
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

/** The ERP: orders and lots, and every post stored with its answer (scripted per key). */
class FakeErp implements ErpApi {
  readonly entries: FeedEntry[] = [];
  readonly lotList: Lot[] = [
    { id: 'B1', material: 'BLANK-100', quantity: 10 },
    { id: 'B2', material: 'BLANK-100', quantity: 10 },
    { id: 'K1', material: 'SK-1', quantity: 10 },
    { id: 'K2', material: 'SK-1', quantity: 10 },
    { id: 'P1', material: 'SP-100', quantity: 10 },
  ];
  readonly posts: { kind: ErpMessageKind; key: string; body: unknown }[] = [];
  /** Answers by key; `stored` otherwise. */
  readonly answers = new Map<string, PostOutcome>();

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

  post(kind: ErpMessageKind, key: string, body: unknown): Promise<PostOutcome> {
    this.posts.push({ kind, key, body });
    const scripted = this.answers.get(key);
    if (scripted) return Promise.resolve(scripted);
    return Promise.resolve({
      kind: 'stored',
      status: 201,
      receipt:
        kind === 'quality-notification'
          ? {
              idempotencyKey: key,
              kind,
              holdId: key.split('~')[0] ?? '',
              receivedSeq: this.posts.length,
              receivedAt: new Date(PLANT_T0).toISOString(),
            }
          : {
              idempotencyKey: key,
              kind,
              orderNumber: key.split('~')[0] ?? '',
              receivedSeq: this.posts.length,
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
  epoch = E1;
  #at = PLANT_T0;

  constructor(feed: UnsFeed) {
    this.#feed = feed;
  }

  get at(): number {
    return this.#at;
  }

  seq(equipment: string): number {
    return this.#seqs.get(`${String(this.epoch)}/${equipment}`) ?? 0;
  }

  #next(equipment: string): number {
    const k = `${String(this.epoch)}/${equipment}`;
    const seq = (this.#seqs.get(k) ?? 0) + 1;
    this.#seqs.set(k, seq);
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
      lots?: { material: string; lot: string }[];
      measurement?: typeof READING;
      result?: 'good' | 'rework' | 'scrap';
      reason?: string;
    } = {},
  ): Delivery {
    const modbus = equipment.startsWith('wsh');
    return this.#feed.cycle(equipment, this.epoch, this.#next(equipment), this.#time(), {
      product: 'VB-100',
      partId,
      serial: equipment.startsWith('cnc') ? `VB-100-${String(partId).padStart(6, '0')}` : '',
      result: options.result ?? 'good',
      reason: (options.reason ?? null) as never,
      measurement: options.measurement ?? null,
      ...(modbus ? {} : { lots: options.lots ?? [] }),
      ...(equipment === 'asm-01' ? { operator: 'op-ayse' } : {}),
    });
  }

  job(transition: 'accepted' | 'started' | 'completed', orderId: string, quantity: number) {
    return this.#feed.job('cnc-01', this.epoch, this.#next('cnc-01'), this.#time(), {
      transition,
      commandId: `${orderId}~OP10~1`,
      orderId,
      product: 'VB-100',
      quantity,
    });
  }

  /** One unit through the routing: blank lot, components, the leak test's reading, packing. */
  unit(partId: number, lots: { blank: string; kit: string }): Delivery[] {
    return [
      this.cycle('cnc-01', partId, { lots: [{ material: 'BLANK-100', lot: lots.blank }] }),
      this.cycle('wsh-01', partId),
      this.cycle('asm-01', partId, {
        lots: [
          { material: 'SK-1', lot: lots.kit },
          { material: 'SP-100', lot: 'P1' },
        ],
      }),
      this.cycle('lkt-01', partId, { measurement: READING }),
      this.cycle('pck-01', partId),
    ];
  }

  settleAll(): Delivery[] {
    return MACHINES.map((m) => this.state(m, 'Idle'));
  }
}

const SAM = { userId: 0, username: 'sam', roles: ['supervisor' as const] };

interface Harness {
  readonly db: Kysely<Database>;
  readonly ingest: Ingest;
  readonly orders: Orders;
  readonly execution: Execution;
  readonly genealogy: Genealogy;
  readonly holds: Holds;
  readonly erp: FakeErp;
  readonly line: Line;
  readonly identity: Identity;
  /** The quality user's write context. */
  readonly qa: { by: { userId: number; username: string; roles: 'quality'[] }; requestId: string };
  /** The supervisor's. */
  readonly sup: { by: typeof SAM; requestId: string };
  /** Pauses the next opening's transaction before its COMMIT until the returned release. */
  pauseOpening(): { reached: Promise<number>; release: () => void };
  /** Another genealogy module on the same tables and sources, started (a restart). */
  restartGenealogy(): Promise<Genealogy>;
}

async function harness(
  name: string,
  options: {
    signals?: { signalWindow(id: number): Promise<SignalWindow | undefined> };
    wrapExecution?: (e: Execution) => Execution;
    /** The holds see no plant clock (no fact yet): `opened_plant_at` null. */
    noClock?: boolean;
    /** The holds follow the genealogy's changes (#238) instead of `tick()` alone. */
    follow?: boolean;
    onScopeRebuilt?: () => void;
  } = {},
): Promise<Harness> {
  const db = await freshDatabase(serverUrl, `holds_${name}`);
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
  const quinn = await identity.createUser(
    {
      username: 'quinn',
      roles: ['quality'],
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
  const line = new Line(feed);
  const clock = () => new Date(line.at);
  const orders = new Orders({
    db,
    ingest,
    masterData,
    publisher: new Sink(),
    erp,
    clock,
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
    clock,
    tickMs: 0,
  });
  const newGenealogy = () =>
    new Genealogy({
      db,
      ingest,
      execution: options.wrapExecution ? options.wrapExecution(execution) : execution,
      orders,
      masterData,
      erp,
      packing: { operation: 'OP50', capacity: { ...plant.packing.capacity } },
      tickMs: 0,
      lotPollMs: 0,
    });
  const genealogy = newGenealogy();
  genealogy.follow();
  await execution.start();
  cleanups.push(() => execution.stop());
  orders.useBlankCounter(execution);
  await genealogy.start();
  cleanups.push(() => genealogy.stop());
  let pause: { reached: (pid: number) => void; gate: Promise<void> } | undefined;
  const holds = new Holds({
    db,
    genealogy,
    ingest,
    execution,
    orders,
    reasons: plant.quality.holdReasons,
    ...(options.signals ? { signals: options.signals } : {}),
    clock: options.noClock === true ? () => undefined : clock,
    epoch: () => line.epoch,
    follow: options.follow === true,
    ...(options.onScopeRebuilt ? { onTiming: () => options.onScopeRebuilt?.() } : {}),
    beforeCommit: async (trx) => {
      const current = pause;
      if (!current) return;
      pause = undefined;
      current.reached(await backendPid(trx));
      await current.gate;
    },
  });
  await holds.start();
  cleanups.push(() => holds.stop());
  orders.useCloseGuard(holds.closeGuard());
  return {
    db,
    ingest,
    orders,
    execution,
    genealogy,
    holds,
    erp,
    line,
    identity,
    qa: { by: { userId: quinn.id, username: 'quinn', roles: ['quality'] }, requestId: 'req-q' },
    sup: { by: { ...SAM, userId: sam.id }, requestId: 'req-s' },
    restartGenealogy: async () => {
      const again = newGenealogy();
      await again.start();
      cleanups.push(() => again.stop());
      return again;
    },
    pauseOpening: () => {
      let release: () => void = () => undefined;
      let reached: (pid: number) => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const pid = new Promise<number>((resolve) => (reached = resolve));
      pause = { reached, gate };
      return { reached: pid, release };
    },
  };
}

const send = async (h: Harness, deliveries: readonly Delivery[]) => {
  for (const d of deliveries) await h.ingest.deliver(d.topic, d.payload);
};

async function settle(h: Harness): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await h.orders.tick();
    await h.execution.tick();
    await h.genealogy.tick();
  }
  await h.holds.tick();
}

/** Imports, releases and dispatches an order of `quantity` VB-100 to CNC-01. */
async function dispatched(h: Harness, number: string, quantity: number): Promise<void> {
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
  const released = await h.orders.release(number, { version: imported?.version ?? 0 }, h.sup);
  await h.orders.dispatch(number, { version: released.version, equipment: 'cnc-01' }, h.sup);
}

/**
 * An order of one unit run, completed by its facts, every operation signed off: ready to close.
 * With `genealogy: false` the genealogy module is not brought up to date (its watermark lags).
 */
async function completed(
  h: Harness,
  number: string,
  lots: { blank: string; kit: string },
  options: { genealogy?: boolean } = {},
) {
  await dispatched(h, number, 1);
  const l = h.line;
  const partId = l.seq('pck-01') + 1;
  await send(h, [
    l.job('accepted', number, 1),
    l.job('started', number, 1),
    ...l.unit(partId, lots),
    l.job('completed', number, 1),
    ...l.settleAll(),
  ]);
  if (options.genealogy === false) {
    for (let round = 0; round < 2; round++) {
      await h.orders.tick();
      await h.execution.tick();
    }
  } else {
    await settle(h);
  }
  const order = await h.orders.order(number);
  expect(order?.status).toBe('completed');
  for (const op of await h.orders.operations({ orderIds: [number] })) {
    await h.orders.signOff(number, op.operation, { version: op.version }, h.sup);
  }
  const ready = await h.orders.order(number);
  if (!ready) throw new Error('no order');
  return ready;
}

const keysOf = (erp: FakeErp) =>
  erp.posts.filter((p) => p.kind === 'quality-notification').map((p) => p.key);

async function postAll(h: Harness): Promise<void> {
  while ((await h.orders.postNow()) > 0) {
    // until nothing is pending
  }
}

describe('quality holds: scope, lifecycle and notifications (#201)', () => {
  it('rebuilds the scopes on a genealogy change and on an opening, not on a timer (#238)', async () => {
    let rebuilds = 0;
    const h = await harness('follow', {
      follow: true,
      onScopeRebuilt: () => {
        rebuilds++;
      },
    });
    const until = async (done: () => boolean | Promise<boolean>): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!(await done())) {
        if (Date.now() > deadline) throw new Error('not rebuilt in time');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await dispatched(h, 'X-1', 3);
    const l = h.line;
    await send(h, [
      l.job('accepted', 'X-1', 3),
      l.job('started', 'X-1', 3),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
    ]);
    for (let round = 0; round < 2; round++) {
      await h.orders.tick();
      await h.execution.tick();
      await h.genealogy.tick();
    }
    const opened = await h.holds.open(
      { subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    // The opening asks for a rebuild (held-material-consumed is checked on it).
    await until(() => rebuilds >= 2);
    // Unit 2 consumes the held lot: the genealogy round that builds it changes the scope, and the
    // holds rebuild on its change without being ticked.
    await send(h, l.unit(2, { blank: 'B1', kit: 'K1' }));
    for (let round = 0; round < 2; round++) {
      await h.orders.tick();
      await h.execution.tick();
      await h.genealogy.tick();
    }
    await until(async () => (await h.holds.hold(opened.id))?.scope.units === 2);
    await until(async () => (await h.holds.incidents()).length === 1);
    // A round that changes nothing asks for no rebuild: none runs without a change.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settled = rebuilds;
    await h.genealogy.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(rebuilds).toBe(settled);
  });

  it('a lot hold’s scope follows the genealogy and grows with later consumption and late facts; held-material-consumed after the opening', async () => {
    const h = await harness('lot');
    await dispatched(h, 'X-1', 3);
    const l = h.line;
    await send(h, [
      l.job('accepted', 'X-1', 3),
      l.job('started', 'X-1', 3),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
    ]);
    await settle(h);
    const opened = await h.holds.open(
      { subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT', comment: 'supplier warning' },
      h.qa,
    );
    expect(opened).toMatchObject({
      subject: { kind: 'lot', id: 'K1' },
      state: 'open',
      reason: 'SUSPECT-LOT',
      openedBy: 'quinn',
      transitions: 1,
      version: 1,
      scope: { units: 1, orders: 1 },
      heldMaterialConsumed: 0,
    });
    expect(opened.openedPlantAt?.getTime()).toBe(l.at);
    expect(opened.id).toMatch(/^[0-9a-f-]{36}$/);
    // Unit 2 consumes the held lot after the opening; unit 3 another kit lot; unit 2's OP30 fact
    // arrives late (after unit 3's).
    const unit2 = l.unit(2, { blank: 'B1', kit: 'K1' });
    const unit3 = l.unit(3, { blank: 'B2', kit: 'K2' });
    const late = unit2[2];
    if (!late) throw new Error('fact');
    await send(h, [...unit2.filter((f) => f !== late), ...unit3]);
    await settle(h);
    expect((await h.holds.hold(opened.id))?.scope.units).toBe(1);
    await send(h, [late, l.job('completed', 'X-1', 3), ...l.settleAll()]);
    await settle(h);
    const detail = await h.holds.detail(opened.id);
    expect(detail?.units.map((u) => [u.partId, u.serial, u.orderId])).toEqual([
      [1, 'VB-100-000001', 'X-1'],
      [2, 'VB-100-000002', 'X-1'],
    ]);
    expect(detail?.hold.scope).toEqual({ units: 2, cartons: 1, orders: 1 });
    expect(
      detail?.incidents.map((i) => [i.type, i.lot, i.partId, i.equipment, i.operation, i.pass]),
    ).toEqual([['held-material-consumed', 'K1', 2, 'asm-01', 'OP30', 1]]);
    expect(detail?.hold.heldMaterialConsumed).toBe(1);
    // A round again raises nothing new.
    await h.holds.tick();
    expect((await h.holds.incidents()).length).toBe(1);
    // The opening's notification: in the outbox in the hold's transaction, posted once.
    await postAll(h);
    const [notification] = h.erp.posts.filter((p) => p.kind === 'quality-notification');
    expect(notification?.key).toBe(qualityNotificationKey(opened.id, 'opened', 1));
    const body = qualityNotificationRequestSchema.parse(notification?.body);
    expect(body).toMatchObject({
      holdId: opened.id,
      transition: 'opened',
      transitionNo: 1,
      subject: { kind: 'lot', id: 'K1' },
      reason: 'SUSPECT-LOT',
      comment: 'supplier warning',
      user: 'quinn',
      scope: { units: 1, cartons: 1, orders: 1 },
      scopeFinal: false,
    });
    // The trace answers name the hold; the carton of a held unit is held.
    const holds = await h.holds.holdsOn([{ epoch: E1, partId: 2 }], [{ kind: 'lot', id: 'K1' }]);
    expect(holds.all.map((x) => x.id)).toEqual([opened.id]);
    expect(holds.byUnit.get(`${String(E1)}/2`)?.map((x) => x.state)).toEqual(['open']);
    expect((await h.holds.holdsOn([{ epoch: E1, partId: 3 }])).all).toEqual([]);
    // Released: the consumption after the decision is no incident; the scope copy is kept.
    const released = await h.holds.decide(
      opened.id,
      'release',
      { version: 1, reason: 'CONFORMS' },
      h.qa,
    );
    expect(released).toMatchObject({ state: 'released', decidedBy: 'quinn', transitions: 2 });
    await dispatched(h, 'X-2', 1);
    await send(h, [
      l.job('accepted', 'X-2', 1),
      l.job('started', 'X-2', 1),
      ...l.unit(4, { blank: 'B2', kit: 'K1' }),
    ]);
    await settle(h);
    const after = await h.holds.detail(opened.id);
    expect([after?.hold.scope.units, after?.incidents.length]).toEqual([2, 1]);
    await postAll(h);
    expect(keysOf(h.erp)).toEqual([
      qualityNotificationKey(opened.id, 'opened', 1),
      qualityNotificationKey(opened.id, 'released', 2),
    ]);
    const posted = await h.holds.detail(opened.id);
    expect(posted?.transitions.map((t) => [t.n, t.kind, t.notification?.status])).toEqual([
      [1, 'opened', 'sent'],
      [2, 'released', 'sent'],
    ]);
    // Audited with the user and the plant time.
    const audit = await Identity.auditEntries(h.db, 'quality_hold', [opened.id]);
    expect(audit.map((a) => [a.action, a.username]).sort()).toEqual([
      ['hold.open', 'quinn'],
      ['hold.release', 'quinn'],
    ]);
  });

  it('reads every held lot’s scope and consumptions at once, as one lot’s reads answer them, and again only where its links or units change (#399)', async () => {
    const h = await harness('lot_reads');
    await dispatched(h, 'X-1', 3);
    const l = h.line;
    await send(h, [
      l.job('accepted', 'X-1', 3),
      l.job('started', 'X-1', 3),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
      ...l.unit(2, { blank: 'B1', kit: 'K2' }),
    ]);
    await settle(h);
    const lots = ['B1', 'K1', 'K2', 'K9'];
    const asOne = async (lot: string) => ({
      scope: (await h.genealogy.scopes([{ kind: 'lot', id: lot }]))[0],
      consumptions: await h.genealogy.lotConsumptions(lot),
    });
    const read = async (previous?: ReadonlyMap<string, LotLinks>) => {
      const answer = await h.genealogy.lotsScopesAndConsumptions(
        lots,
        previous === undefined ? {} : { previous },
      );
      for (const lot of lots) {
        const got = answer.get(lot);
        expect({ scope: got?.scope, consumptions: got?.consumptions }).toEqual(await asOne(lot));
      }
      return answer;
    };
    const first = await read();
    // B1 is consumed by both units: one scope unit each; K9 by none.
    expect(first.get('B1')?.scope.map((u) => u.partId)).toEqual([1, 2]);
    expect(first.get('K9')?.scope).toEqual([]);
    // Unchanged: the very same answers.
    const again = await read(first);
    for (const lot of lots) expect(again.get(lot)).toBe(first.get(lot));
    // A new link of K1 and B1 (unit 3): those two are read again, K2 is not.
    await send(h, l.unit(3, { blank: 'B1', kit: 'K1' }));
    await settle(h);
    const grown = await read(first);
    expect(grown.get('K1')?.scope.map((u) => u.partId)).toEqual([1, 3]);
    expect(grown.get('K1')).not.toBe(first.get('K1'));
    expect(grown.get('B1')).not.toBe(first.get('B1'));
    expect(grown.get('K2')).toBe(first.get('K2'));
    // A unit's row changing without a new link (as a carton rewritten) changes its lots too, and a
    // lot hold's copy follows it through the reads the holds keep between rebuilds.
    const held = await h.holds.open(
      { subject: { kind: 'lot', id: 'K2' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    await h.holds.tick();
    await h.holds.tick();
    await h.db
      .updateTable('genealogy.serial_unit')
      .set({ carton_id: 'X-1-C99' })
      .where('epoch', '=', E1)
      .where('part_id', '=', 2)
      .execute();
    const moved = await read(grown);
    expect(moved.get('K2')?.scope.map((u) => u.carton)).toEqual(['X-1-C99']);
    expect(moved.get('B1')).not.toBe(grown.get('B1'));
    expect(moved.get('K1')).toBe(grown.get('K1'));
    await h.holds.tick();
    const detail = await h.holds.detail(held.id);
    expect(detail?.units.map((u) => [u.partId, u.carton])).toEqual([[2, 'X-1-C99']]);
    // Several blocks (review of #400, M1): unit 70 is in K2's second block of 64 units.
    await send(h, l.unit(70, { blank: 'B1', kit: 'K2' }));
    await settle(h);
    const two = await read(moved);
    expect(two.get('K2')?.scope.map((u) => u.partId)).toEqual([2, 70]);
    // Block 0 read again, block 1 kept: the blocks merge in (epoch, block) order.
    await h.db
      .updateTable('genealogy.serial_unit')
      .set({ carton_id: 'X-1-C98' })
      .where('epoch', '=', E1)
      .where('part_id', '=', 2)
      .execute();
    const reordered = await read(two);
    expect(reordered.get('K2')?.scope.map((u) => u.partId)).toEqual([2, 70]);
    // Block 0 emptied (as a unit rebuilt without the lot): the lot is no longer the previous one.
    await h.db
      .deleteFrom('genealogy.genealogy_link')
      .where('kind', '=', 'lot-unit')
      .where('lot', '=', 'K2')
      .where('part_id', '=', 2)
      .execute();
    const emptied = await read(reordered);
    expect(emptied.get('K2')?.scope.map((u) => u.partId)).toEqual([70]);
    await h.holds.tick();
    expect((await h.holds.detail(held.id))?.units.map((u) => u.partId)).toEqual([70]);
    // What the rebuild keeps in memory follows the holds there are (review of #400, L1): the one
    // lot hold, then none once it is gone from the database.
    expect(h.holds.cached()).toEqual({ copies: 1, incidentFacts: 1, lotReads: 1, settled: 1 });
    // Holds are never deleted by the MES: the superuser removes this one past the append-only
    // trigger (`session_replication_role`), as an operator's cleanup would.
    const owner = await ownerOf(serverUrl, h.db);
    try {
      await owner.transaction().execute(async (trx) => {
        await sql`SET LOCAL session_replication_role = replica`.execute(trx);
        for (const table of ['hold_incident', 'hold_unit', 'hold_transition'] as const) {
          await trx.deleteFrom(`quality.${table}`).where('hold_id', '=', held.id).execute();
        }
        await trx.deleteFrom('quality.hold').where('id', '=', held.id).execute();
      });
    } finally {
      await owner.destroy();
    }
    await h.holds.tick();
    expect(h.holds.cached()).toEqual({ copies: 0, incidentFacts: 0, lotReads: 0, settled: 0 });
  });

  it('checks subjects, reasons, versions and decisions; a comment is not notified; transitions are append-only; serial, carton and order holds cover their units', async () => {
    const h = await harness('lifecycle');
    await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    const refused = (promise: Promise<unknown>, match: Record<string, unknown>) =>
      expect(promise).rejects.toMatchObject(match);
    await refused(
      h.holds.open({ subject: { kind: 'lot', id: 'ZZ' }, reason: 'SUSPECT-LOT' }, h.qa),
      { kind: 'not-found' },
    );
    await refused(
      h.holds.open({ subject: { kind: 'serial', id: 'NOPE' }, reason: 'OTHER' }, h.qa),
      { kind: 'not-found' },
    );
    await refused(
      h.holds.open({ subject: { kind: 'carton', id: 'X-9-C01' }, reason: 'OTHER' }, h.qa),
      { kind: 'not-found' },
    );
    await refused(h.holds.open({ subject: { kind: 'order', id: 'X-9' }, reason: 'OTHER' }, h.qa), {
      kind: 'not-found',
    });
    await refused(h.holds.open({ subject: { kind: 'lot', id: 'B1' }, reason: 'CONFORMS' }, h.qa), {
      kind: 'invalid',
    });
    const serial = await h.holds.open(
      { subject: { kind: 'serial', id: 'VB-100-000001' }, reason: 'TEST-FAILURES' },
      h.sup,
    );
    const carton = await h.holds.open(
      { subject: { kind: 'carton', id: 'X-1-C01' }, reason: 'OTHER' },
      h.qa,
    );
    // Opened at a plant time every machine is final through: its counts are final.
    const order = await h.holds.open(
      { subject: { kind: 'order', id: 'X-1' }, reason: 'CUSTOMER-COMPLAINT' },
      h.qa,
      { plantAt: new Date(PLANT_T0 + 60_000) },
    );
    for (const hold of [serial, carton, order]) {
      expect(hold.scope).toEqual({ units: 1, cartons: 1, orders: 1 });
    }
    // A comment: appended and audited, not notified; the version moves.
    const commented = await h.holds.comment(
      serial.id,
      { version: 1, comment: 'checked 3 parts' },
      h.sup,
    );
    expect([commented.version, commented.transitions]).toEqual([2, 2]);
    await refused(h.holds.comment(serial.id, { version: 1, comment: 'again' }, h.sup), {
      type: PROBLEM_TYPES.holdStale,
    });
    await refused(h.holds.decide(serial.id, 'reject', { version: 2, reason: 'CONFORMS' }, h.qa), {
      kind: 'invalid',
    });
    const rejected = await h.holds.decide(
      serial.id,
      'reject',
      { version: 2, reason: 'NONCONFORMING', comment: 'scrap outside the MES' },
      h.qa,
    );
    expect(rejected.state).toBe('rejected');
    await refused(h.holds.decide(serial.id, 'release', { version: 3, reason: 'CONFORMS' }, h.qa), {
      type: PROBLEM_TYPES.holdDecided,
    });
    await refused(h.holds.comment('not-a-uuid', { version: 1, comment: 'x' }, h.qa), {
      kind: 'not-found',
    });
    // A rejection changes no quantity: the order's confirmations stay as they were.
    expect((await h.orders.confirmations('X-1')).every((c) => c.kind === 'final')).toBe(true);
    // The carton is held while a member is in an open or rejected hold.
    for (const hold of [carton, order]) {
      await h.holds.decide(hold.id, 'release', { version: 1, reason: 'CONFORMS' }, h.qa);
    }
    const left = await h.holds.holdsOn([{ epoch: E1, partId: 1 }]);
    expect(left.all.map((x) => [x.id, x.state])).toEqual([[serial.id, 'rejected']]);
    await postAll(h);
    expect(keysOf(h.erp).filter((k) => k.startsWith(serial.id))).toEqual([
      qualityNotificationKey(serial.id, 'opened', 1),
      qualityNotificationKey(serial.id, 'rejected', 3),
    ]);
    const orderBody = h.erp.posts.find(
      (p) => p.key === qualityNotificationKey(order.id, 'opened', 1),
    );
    expect(qualityNotificationRequestSchema.parse(orderBody?.body).subject).toEqual({
      kind: 'order',
      id: 'X-1',
    });
    expect(qualityNotificationRequestSchema.parse(orderBody?.body).scopeFinal).toBe(true);
    // Append-only, for mes_app too.
    const state = async (statement: ReturnType<typeof sql>) =>
      statement.execute(h.db).then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(await state(sql`UPDATE quality.hold_transition SET comment = 'x'`)).toBe('42501');
    expect(await state(sql`DELETE FROM quality.hold_transition`)).toBe('42501');
    expect((await h.holds.list({ state: ['open'] })).holds).toEqual([]);
    expect(
      (await h.holds.list({ subject: { kind: 'serial', id: 'VB-100-000001' } })).holds,
    ).toHaveLength(1);
  });

  it('posts notifications through the orders outbox; a 409 is an erp-conflict incident, never retried', async () => {
    const h = await harness('outbox');
    await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    const hold = await h.holds.open(
      { subject: { kind: 'lot', id: 'B1' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    const key = qualityNotificationKey(hold.id, 'opened', 1);
    h.erp.answers.set(key, { kind: 'conflict', status: 409, detail: 'another body' });
    await postAll(h);
    await postAll(h);
    expect(h.erp.posts.filter((p) => p.key === key)).toHaveLength(1);
    const incidents = await h.orders.incidents({ open: true });
    expect(incidents.map((i) => [i.type, i.orderId])).toEqual([['erp-conflict', null]]);
    const detail = await h.holds.detail(hold.id);
    expect(detail?.transitions[0]?.notification).toMatchObject({
      idempotencyKey: key,
      status: 'conflict',
    });
    // A notification is never under an order: the order's detail lists none.
    expect(
      (await h.orders.detail('X-1'))?.erpMessages.some((m) => m.kind === 'quality-notification'),
    ).toBe(false);
  });

  it('suggests the units of a signal’s window with their orders and cartons', async () => {
    const window: SignalWindow = {
      signal: { id: 7, characteristic: 'leak-rate', chart: 'I', rule: 1 } as SignalWindow['signal'],
      after: { epoch: E1, at: PLANT_T0, seq: 1 },
      from: { epoch: E1, at: PLANT_T0, seq: 2 },
      through: { epoch: E1, at: PLANT_T0 + 1, seq: 3 },
      readings: [
        { epoch: E1, partId: 1, pass: 1, at: PLANT_T0, seq: 2 },
        { epoch: E1, partId: 9, pass: 1, at: PLANT_T0 + 1, seq: 3 },
      ],
      final: true,
    };
    const h = await harness('suggest', {
      signals: { signalWindow: (id) => Promise.resolve(id === 7 ? window : undefined) },
    });
    await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    const found = await h.holds.suggestion(7);
    expect(found?.units.map((u) => [u.partId, u.serial, u.orderId, u.carton])).toEqual([
      [1, 'VB-100-000001', 'X-1', 'X-1-C01'],
      [9, null, null, null],
    ]);
    expect([found?.orders, found?.cartons]).toEqual([['X-1'], ['X-1-C01']]);
    expect(await h.holds.suggestion(8)).toBeUndefined();
  });
});

describe('the close guard (#201, review rounds 1–3)', () => {
  it('refuses a close while an open hold covers a unit of the order, and closes once released (409 quality-hold)', async () => {
    const h = await harness('guard');
    const order = await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    const hold = await h.holds.open(
      { subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    await expect(h.orders.close('X-1', { version: order.version }, h.sup)).rejects.toMatchObject({
      type: PROBLEM_TYPES.qualityHold,
    });
    // The guard derives the scope at check time: the scope copy emptied makes no difference.
    await h.db.deleteFrom('quality.hold_unit').execute();
    await expect(h.orders.close('X-1', { version: order.version }, h.sup)).rejects.toMatchObject({
      type: PROBLEM_TYPES.qualityHold,
    });
    // A hold on another lot (not in the order) does not block.
    const other = await h.holds.open(
      { subject: { kind: 'lot', id: 'B2' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    expect(other.scope.units).toBe(0);
    await h.holds.decide(hold.id, 'release', { version: 1, reason: 'CONFORMS' }, h.qa);
    const closed = await h.orders.close('X-1', { version: order.version }, h.sup);
    expect(closed.status).toBe('closed');
  });

  it('refuses a close while a hold on the order is open; a rejected one no longer blocks it', async () => {
    const h = await harness('order_hold');
    const order = await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    const hold = await h.holds.open(
      { subject: { kind: 'order', id: 'X-1' }, reason: 'OTHER' },
      h.qa,
    );
    await expect(h.orders.close('X-1', { version: order.version }, h.sup)).rejects.toMatchObject({
      type: PROBLEM_TYPES.qualityHold,
    });
    await h.holds.decide(hold.id, 'reject', { version: 1, reason: 'NONCONFORMING' }, h.qa);
    // Rejected: no longer open, so the close goes through (the cartons stay held).
    expect((await h.orders.close('X-1', { version: order.version }, h.sup)).status).toBe('closed');
    expect((await h.holds.holdsOn([{ epoch: E1, partId: 1 }])).all[0]?.state).toBe('rejected');
  });

  it('answers the terminal: open holds touching orders, and each machine’s last lots (#203)', async () => {
    const h = await harness('terminal_quality');
    const changes: string[] = [];
    h.genealogy.onChange((change) => changes.push(change.type));
    await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    expect(changes).toContain('units');
    expect(await h.holds.openOnOrders([])).toEqual({ holds: [], truncated: false });
    expect((await h.holds.openOnOrders(['X-1'])).holds).toEqual([]);
    const lot = await h.holds.open(
      { subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    await dispatched(h, 'X-2', 1);
    const order = await h.holds.open(
      { subject: { kind: 'order', id: 'X-2' }, reason: 'OTHER' },
      h.qa,
    );
    await h.holds.tick();
    const found = await h.holds.openOnOrders(['X-1', 'X-2', 'X-1']);
    expect(found.holds.map((x) => [x.hold.id, x.orders])).toEqual([
      [order.id, ['X-2']],
      [lot.id, ['X-1']],
    ]);
    expect((await h.holds.openOnOrders(['X-1', 'X-2'], 1)).truncated).toBe(true);
    // A released hold no longer shows.
    await h.holds.decide(lot.id, 'release', { version: 1, reason: 'CONFORMS' }, h.qa);
    expect((await h.holds.openOnOrders(['X-1'])).holds).toEqual([]);
    // The lots of each machine's last cycle that reported lots; none for a machine without.
    const lots = await h.genealogy.lastLots(['asm-01', 'cnc-01', 'wsh-01']);
    expect(lots.map((l) => [l.equipment, l.operation, l.partId, l.serial, l.pass])).toEqual([
      ['asm-01', 'OP30', 1, 'VB-100-000001', 1],
      ['cnc-01', 'OP10', 1, 'VB-100-000001', 1],
    ]);
    expect(lots[0]?.lots).toEqual([
      { lot: 'K1', material: 'SK-1' },
      { lot: 'P1', material: 'SP-100' },
    ]);
    // Kept in memory as units are stored; a restart loads the same from the tables.
    const restarted = await h.restartGenealogy();
    expect(await restarted.lastLots(['asm-01', 'cnc-01', 'wsh-01'])).toEqual(lots);
    await send(h, [...h.line.unit(2, { blank: 'B2', kit: 'K2' })]);
    await settle(h);
    const later = await h.genealogy.lastLots(['asm-01']);
    expect([later[0]?.partId, later[0]?.lots.map((l) => l.lot)]).toEqual([2, ['K2', 'P1']]);
  });

  it('refuses a close while genealogy has not processed every fact of the order’s units (409 genealogy-pending, retryable)', async () => {
    const h = await harness('pending');
    // Execution has completed the order from its facts; genealogy has not processed them yet.
    const order = await completed(h, 'X-1', { blank: 'B1', kit: 'K1' }, { genealogy: false });
    await expect(h.orders.close('X-1', { version: order.version }, h.sup)).rejects.toMatchObject({
      type: PROBLEM_TYPES.genealogyPending,
    });
    // Also when no hold is open: the guard asks first (a link not written could hold the order).
    expect(await h.holds.list({ state: ['open'] })).toEqual({ holds: [], truncated: false });
    await h.genealogy.tick();
    expect((await h.orders.close('X-1', { version: order.version }, h.sup)).status).toBe('closed');
  });

  it('two connections: a hold opening while a close is between its check and its commit waits for the close', async () => {
    const h = await harness('race_a');
    const order = await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    const guard = h.holds.closeGuard();
    let checked: (pid: number) => void = () => undefined;
    const reached = new Promise<number>((resolve) => (checked = resolve));
    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    h.orders.useCloseGuard({
      lock: (trx) => guard.lock(trx),
      check: async (trx: Transaction<Database>, id) => {
        const verdict = await guard.check(trx, id);
        checked(await backendPid(trx));
        await gate;
        return verdict;
      },
    });
    const closing = h.orders.close('X-1', { version: order.version }, h.sup);
    const pid = await reached;
    let opened = false;
    const opening = h.holds
      .open({ subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' }, h.qa)
      .then((hold) => {
        opened = true;
        return hold;
      });
    // The opening waits on the close's advisory lock.
    await blockedBy(h.db, pid, 'the hold opening blocked by the close');
    expect(opened).toBe(false);
    resume();
    expect((await closing).status).toBe('closed');
    const hold = await opening;
    // The close committed first, with no hold; the hold exists after it, over the closed order.
    expect(hold.scope.units).toBe(1);
    expect((await h.orders.order('X-1'))?.status).toBe('closed');
  });

  it('two connections: a close while a hold is opening waits for it and is refused', async () => {
    const h = await harness('race_b');
    const order = await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    const pause = h.pauseOpening();
    const opening = h.holds.open(
      { subject: { kind: 'lot', id: 'B1' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    const pid = await pause.reached;
    let settled = false;
    const closing = h.orders.close('X-1', { version: order.version }, h.sup).then(
      (o) => {
        settled = true;
        return o;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    await blockedBy(h.db, pid, 'the close blocked by the hold opening');
    expect(settled).toBe(false);
    pause.release();
    await opening;
    await expect(closing).rejects.toMatchObject({ type: PROBLEM_TYPES.qualityHold });
    expect((await h.orders.order('X-1'))?.status).toBe('completed');
  });

  it('same process: a hold and a close at once both finish, in either order (no deadlock with the orders queue)', async () => {
    const h = await harness('same');
    for (const [i, first] of (['hold', 'close'] as const).entries()) {
      const id = `S-${String(i + 1)}`;
      const order = await completed(h, id, { blank: 'B2', kit: 'K2' });
      // A dispatch's outbox write keeps the orders queue busy at the same time.
      const tick = h.orders.tick();
      const both = Promise.allSettled(
        first === 'hold'
          ? [
              h.holds.open({ subject: { kind: 'order', id }, reason: 'OTHER' }, h.qa),
              h.orders.close(id, { version: order.version }, h.sup),
            ]
          : [
              h.orders.close(id, { version: order.version }, h.sup),
              h.holds.open({ subject: { kind: 'order', id }, reason: 'OTHER' }, h.qa),
            ],
      );
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, 20_000).unref();
      });
      const result = await Promise.race([both, timeout]);
      await tick;
      expect(result).not.toBe('timeout');
      if (result === 'timeout') return;
      const [a, b] = result;
      const hold = first === 'hold' ? a : b;
      const close = first === 'hold' ? b : a;
      expect(hold.status).toBe('fulfilled');
      // Whichever took the lock first decided: the close either went through before the hold
      // existed, or was refused because of it.
      const status = (await h.orders.order(id))?.status;
      if (close.status === 'fulfilled') expect(status).toBe('closed');
      else {
        expect(close.reason).toMatchObject({ type: PROBLEM_TYPES.qualityHold });
        expect(status).toBe('completed');
      }
    }
  });
});

describe('the hold routes (#201)', () => {
  it('opens, lists, details, comments and releases over HTTP with the session’s user; traces name the hold and the carton is held', async () => {
    const h = await harness('api');
    await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    await h.identity.start();
    cleanups.push(() => {
      h.identity.stop();
      return Promise.resolve();
    });
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity: h.identity,
      auth: true,
      userWriteRate: { perSecond: 1e6, burst: 1e6 },
      writeRate: { perSecond: 1e6, burst: 1e6 },
    });
    cleanups.push(() => http.app.close());
    const none = () => () => undefined;
    await http.realtime.attach({
      masterData: new MasterData(h.db),
      equipment: {
        currentStates: () => [],
        currentState: () => undefined,
        onChange: none,
        watermark: () => undefined,
        watermarks: () => [],
      },
      ingest: { onStored: none, telemetryMetrics: () => Promise.resolve([]) },
      oee: { workCenters: () => Promise.resolve([]), onChange: none },
      coding: {},
      orders: h.orders,
      genealogy: h.genealogy,
      holds: h.holds,
    } as unknown as ApiSources);
    const HOST = 'localhost:4700';
    const headers = { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' };
    const login = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: { username: 'quinn', password: 'a-long-test-password' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const get = (url: string) =>
      http.app.inject({ method: 'GET', url, headers: { host: HOST, cookie } });
    const post = (url: string, payload: unknown) =>
      http.app.inject({
        method: 'POST',
        url,
        headers: { ...headers, cookie },
        payload: JSON.stringify(payload),
      });
    const reasons = holdReasonListSchema.parse((await get('/api/v1/quality/hold-reasons')).json());
    expect(reasons.reasons.find((r) => r.id === 'CONFORMS')?.for).toEqual(['release']);
    const created = await post('/api/v1/quality/holds', {
      subject: { kind: 'lot', id: 'K1' },
      reason: 'SUSPECT-LOT',
    });
    expect(created.statusCode, created.body).toBe(200);
    const hold = holdSchema.parse(created.json());
    expect(hold.openedBy).toBe('quinn');
    // A second open hold on the same subject with the same reason is refused, naming the first
    // (#203 review); another reason is a hold of its own (released at once below).
    const again = await post('/api/v1/quality/holds', {
      subject: { kind: 'lot', id: 'K1' },
      reason: 'SUSPECT-LOT',
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(problemSchema.parse(again.json())).toMatchObject({
      type: PROBLEM_TYPES.holdExists,
      holds: [hold.id],
    });
    expect(
      (await post('/api/v1/quality/holds', { subject: { kind: 'lot', id: 'K1' }, reason: 'NOPE' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await post('/api/v1/quality/holds', {
          subject: { kind: 'lot', id: 'NOPE' },
          reason: 'OTHER',
        })
      ).statusCode,
    ).toBe(404);
    const list = holdListSchema.parse((await get('/api/v1/quality/holds?state=open')).json());
    expect(list.holds.map((x) => x.id)).toEqual([hold.id]);
    expect((await get('/api/v1/quality/holds?subjectKind=lot')).statusCode).toBe(400);
    // The trace answers name it; the carton of its unit is held.
    const carton = cartonTraceSchema.parse((await get('/api/v1/trace/cartons/X-1-C01')).json());
    expect([carton.carton.held, carton.holds.map((x) => x.id)]).toEqual([true, [hold.id]]);
    const serial = serialTraceSchema.parse(
      (await get('/api/v1/trace/serials/VB-100-000001')).json(),
    );
    expect(serial.units[0]?.holds.map((x) => x.subject)).toEqual([{ kind: 'lot', id: 'K1' }]);
    const lot = lotTraceSchema.parse((await get('/api/v1/trace/lots/K1')).json());
    expect(lot.holds.map((x) => x.id)).toEqual([hold.id]);
    const commented = await post(`/api/v1/quality/holds/${hold.id}/comments`, {
      version: 1,
      comment: 'looking',
    });
    expect(commented.statusCode, commented.body).toBe(200);
    const stale = await post(`/api/v1/quality/holds/${hold.id}/release`, {
      version: 1,
      reason: 'CONFORMS',
    });
    expect([stale.statusCode, stale.json<{ type: string }>().type]).toEqual([
      409,
      PROBLEM_TYPES.holdStale,
    ]);
    const done = await post(`/api/v1/quality/holds/${hold.id}/release`, {
      version: 2,
      reason: 'CONFORMS',
    });
    expect(done.statusCode, done.body).toBe(200);
    const detail = holdDetailSchema.parse((await get(`/api/v1/quality/holds/${hold.id}`)).json());
    expect(detail.transitions.map((t) => [t.kind, t.by, t.notification === null])).toEqual([
      ['opened', 'quinn', false],
      ['commented', 'quinn', true],
      ['released', 'quinn', false],
    ]);
    expect(detail.units.map((u) => u.serial)).toEqual(['VB-100-000001']);
    expect(
      (await get(`/api/v1/quality/holds/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`))
        .statusCode,
    ).toBe(404);
    expect((await get('/api/v1/quality/hold-incidents')).statusCode).toBe(200);
    expect((await get('/api/v1/quality/signals/1/hold-suggestion')).statusCode).toBe(404);
    const after = cartonTraceSchema.parse((await get('/api/v1/trace/cartons/X-1-C01')).json());
    expect(after.carton.held).toBe(false);
    // A supervisor opens but may not release; the close of an order with a hold answers 409.
    const supLogin = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: { username: 'sam', password: 'a-long-test-password' },
    });
    const sup = String(supLogin.headers['set-cookie']).split(';')[0] ?? '';
    const asSup = (url: string, payload: unknown) =>
      http.app.inject({
        method: 'POST',
        url,
        headers: { ...headers, cookie: sup },
        payload: JSON.stringify(payload),
      });
    const second = await asSup('/api/v1/quality/holds', {
      subject: { kind: 'order', id: 'X-1' },
      reason: 'OTHER',
    });
    expect(second.statusCode, second.body).toBe(200);
    const secondId = holdSchema.parse(second.json()).id;
    expect(
      (await asSup(`/api/v1/quality/holds/${secondId}/release`, { version: 1, reason: 'CONFORMS' }))
        .statusCode,
    ).toBe(403);
    const order = await h.orders.order('X-1');
    const close = await asSup('/api/v1/orders/X-1/close', { version: order?.version ?? 0 });
    expect([close.statusCode, close.json<{ type: string }>().type]).toEqual([
      409,
      PROBLEM_TYPES.qualityHold,
    ]);
    expect(problemSchema.parse(close.json()).holds).toEqual([secondId]);
  });
});

const outcome = (promise: Promise<{ status: string }>) =>
  promise.then(
    (o) => `closed:${o.status}`,
    (e: unknown) => `refused:${String((e as { type?: string }).type)}`,
  );

async function signOffAll(h: Harness, id: string) {
  for (const op of await h.orders.operations({ orderIds: [id] })) {
    await h.orders.signOff(id, op.operation, { version: op.version }, h.sup);
  }
  const ready = await h.orders.order(id);
  if (!ready) throw new Error('no order');
  return ready;
}

describe('the close guard on late and lost facts (review of PR #222)', () => {
  it('a late fact of an ended run carrying a held lot is refused by ingest, so it never joins the order (PA)', async () => {
    const h = await harness('pa');
    await dispatched(h, 'X-1', 1);
    const l = h.line;
    const e1 = [
      l.job('accepted', 'X-1', 1),
      l.job('started', 'X-1', 1),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
      l.job('completed', 'X-1', 1),
      ...l.settleAll(),
    ];
    const hold = await h.holds.open(
      { subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    // A newer run starts first; the older run's facts arrive afterwards.
    l.epoch = E1 + 1000;
    await send(h, l.settleAll());
    await settle(h);
    await send(h, e1);
    for (let r = 0; r < 3; r++) {
      await h.orders.tick();
      await h.execution.tick();
    }
    // The order can't complete from an ended run's late facts (no close reaches the guard), so the
    // guard is asked directly, as a close would, in a transaction after its lock.
    const guard = h.holds.closeGuard();
    const ask = () =>
      h.db.transaction().execute(async (trx) => {
        await guard.lock(trx);
        return (await guard.check(trx, 'X-1'))?.kind;
      });
    // Ingest refuses an ended run's facts as stale (ADR-0015): they never become the order's, so
    // nothing is pending and no hold covers the order, before and after genealogy's rounds.
    expect(await h.ingest.cycleFacts({ epoch: E1 })).toEqual([]);
    expect(await ask()).toBeUndefined();
    await settle(h);
    expect(await ask()).toBeUndefined();
    expect((await h.holds.detail(hold.id))?.units).toEqual([]);
  });

  it('a late fact of a written-off gap carrying a held lot: refused until genealogy records it (PD, H1)', async () => {
    const h = await harness('pd');
    await dispatched(h, 'X-1', 1);
    const l = h.line;
    await send(
      h,
      ['wsh-01', 'asm-01', 'lkt-01', 'pck-01'].map((m) => l.state(m, 'Running')),
    );
    await settle(h);
    const facts = [
      l.job('accepted', 'X-1', 1),
      l.job('started', 'X-1', 1),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
      l.job('completed', 'X-1', 1),
      ...l.settleAll(),
    ];
    const late = facts[4]; // the OP30 cycle at ASM-01 with K1
    if (!late) throw new Error('late');
    const hold = await h.holds.open(
      { subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    await send(
      h,
      facts.filter((f) => f !== late),
    );
    // The gap is written off: ASM-01's settled sequence passes it.
    await h.ingest.sweep(0);
    for (let i = 0; i < 3; i++) await settle(h);
    expect((await h.orders.order('X-1'))?.status).toBe('completed');
    const ready = await signOffAll(h, 'X-1');
    expect((await h.holds.hold(hold.id))?.scope.units).toBe(0);
    // The late fact arrives; the watermark already covers its number, genealogy has no record.
    await send(h, [late]);
    const seq = (JSON.parse(late.payload) as { seq: number }).seq;
    expect(h.genealogy.covers([{ equipment: 'asm-01', epoch: E1, seq }])).toBe(true);
    expect(await outcome(h.orders.close('X-1', { version: ready.version }, h.sup))).toBe(
      `refused:${PROBLEM_TYPES.genealogyPending}`,
    );
    for (let i = 0; i < 3; i++) await settle(h);
    expect(await outcome(h.orders.close('X-1', { version: ready.version }, h.sup))).toBe(
      `refused:${PROBLEM_TYPES.qualityHold}`,
    );
    expect((await h.holds.detail(hold.id))?.units.map((u) => u.partId)).toEqual([1]);
  });

  it('a unit neither execution nor genealogy has built, inside the order’s job: pending (H1)', async () => {
    const h = await harness('unbuilt');
    await dispatched(h, 'X-1', 2);
    const l = h.line;
    await send(
      h,
      ['wsh-01', 'asm-01', 'lkt-01', 'pck-01'].map((m) => l.state(m, 'Running')),
    );
    await settle(h);
    const facts = [
      l.job('accepted', 'X-1', 2),
      l.job('started', 'X-1', 2),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
      ...l.unit(2, { blank: 'B1', kit: 'K2' }),
      l.job('completed', 'X-1', 2),
      ...l.settleAll(),
    ];
    // Every fact of unit 2 is lost; the gaps are written off and the order completes short.
    const lost = facts.slice(7, 12);
    await send(
      h,
      facts.filter((f) => !lost.includes(f)),
    );
    await h.ingest.sweep(0);
    for (let i = 0; i < 3; i++) await settle(h);
    const order = await h.orders.order('X-1');
    expect([order?.status, order?.short]).toEqual(['completed', true]);
    const ready = await signOffAll(h, 'X-1');
    // Unit 2's facts arrive late: no module has built it yet, its numbers are written off.
    await send(h, lost);
    expect(await h.execution.orderUnits('X-1')).toEqual([{ epoch: E1, partId: 1 }]);
    expect(await outcome(h.orders.close('X-1', { version: ready.version }, h.sup))).toBe(
      `refused:${PROBLEM_TYPES.genealogyPending}`,
    );
    for (let i = 0; i < 3; i++) await settle(h);
    expect(await outcome(h.orders.close('X-1', { version: ready.version }, h.sup))).toBe(
      'closed:closed',
    );
  });

  it('a poison unit of the order keeps the close pending, also with a hold genealogy can’t see (PB)', async () => {
    let poison = 0;
    const h = await harness('pb', {
      wrapExecution: (e) =>
        ({
          onUnits: (listener: never) => e.onUnits(listener),
          processedThrough: () => e.processedThrough(),
          unitStates: () => e.unitStates(),
          units: async (query: never) => {
            const found = await e.units(query);
            if (poison === 0 || !found.units.some((u) => u.partId === 1)) return found;
            return {
              ...found,
              units: found.units.map((u) =>
                u.partId === 1 ? { ...u, status: 'bogus' as never } : u,
              ),
            };
          },
        }) as unknown as Execution,
    });
    poison = 1;
    const order = await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    for (let i = 0; i < 3; i++) await settle(h);
    await h.holds.open({ subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' }, h.qa);
    expect(await outcome(h.orders.close('X-1', { version: order.version }, h.sup))).toBe(
      `refused:${PROBLEM_TYPES.genealogyPending}`,
    );
    poison = 0;
    for (let i = 0; i < 40; i++) await settle(h);
    expect(await outcome(h.orders.close('X-1', { version: order.version }, h.sup))).toBe(
      `refused:${PROBLEM_TYPES.qualityHold}`,
    );
  });

  it('a held lot consumed at a rework pass joins the scope and blocks the close (PC, M1)', async () => {
    const h = await harness('pc');
    await dispatched(h, 'X-1', 1);
    const l = h.line;
    const fail = { characteristic: 'leak-rate', value: 4.5, unit: 'Pa/min', upperLimit: 3.2 };
    await send(h, [
      l.job('accepted', 'X-1', 1),
      l.job('started', 'X-1', 1),
      l.cycle('cnc-01', 1, { lots: [{ material: 'BLANK-100', lot: 'B1' }] }),
      l.cycle('wsh-01', 1),
      l.cycle('asm-01', 1, {
        lots: [
          { material: 'SK-1', lot: 'K1' },
          { material: 'SP-100', lot: 'P1' },
        ],
      }),
      l.cycle('lkt-01', 1, { measurement: fail, result: 'rework', reason: 'LEAK' }),
      l.cycle('asm-01', 1, {
        lots: [
          { material: 'SK-1', lot: 'K2' },
          { material: 'SP-100', lot: 'P1' },
        ],
      }),
      l.cycle('lkt-01', 1, { measurement: READING }),
      l.cycle('pck-01', 1),
      l.job('completed', 'X-1', 1),
      ...l.settleAll(),
    ]);
    await settle(h);
    await settle(h);
    expect(
      (await h.genealogy.lotConsumptions('K2')).map((c) => [c.partId, c.operation, c.pass]),
    ).toEqual([[1, 'OP30', 2]]);
    const hold = await h.holds.open(
      { subject: { kind: 'lot', id: 'K2' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    expect(hold.scope.units).toBe(1);
    expect((await h.orders.order('X-1'))?.status).toBe('completed');
    const ready = await signOffAll(h, 'X-1');
    expect(await outcome(h.orders.close('X-1', { version: ready.version }, h.sup))).toBe(
      `refused:${PROBLEM_TYPES.qualityHold}`,
    );
  });

  it('refuses a close with no close guard wired (fail closed, L2)', async () => {
    const h = await harness('unguarded');
    const order = await completed(h, 'X-1', { blank: 'B1', kit: 'K1' });
    const bare = new Orders({
      db: h.db,
      ingest: h.ingest,
      masterData: new MasterData(h.db),
      tickMs: 0,
      erpPollMs: 0,
      erpPostMs: 0,
    });
    await bare.start();
    cleanups.push(() => bare.stop());
    expect(bare.closeGuarded).toBe(false);
    await expect(bare.close('X-1', { version: order.version }, h.sup)).rejects.toThrow(
      /no quality close guard/,
    );
    expect(h.orders.closeGuarded).toBe(true);
  });
});

describe('held-material-consumed by plant position (review of PR #222)', () => {
  it('without a plant clock the opening has no time: every consumption counts as after it (L6)', async () => {
    const h = await harness('noclock', { noClock: true });
    await dispatched(h, 'X-1', 1);
    const l = h.line;
    await send(h, [
      l.job('accepted', 'X-1', 1),
      l.job('started', 'X-1', 1),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
    ]);
    await settle(h);
    const hold = await h.holds.open(
      { subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' },
      h.qa,
    );
    expect(hold.openedPlantAt).toBeNull();
    await h.holds.tick();
    const detail = await h.holds.detail(hold.id);
    expect(detail?.incidents.map((i) => [i.partId, i.operation])).toEqual([[1, 'OP30']]);
    await postAll(h);
    const body = qualityNotificationRequestSchema.parse(
      h.erp.posts.find((p) => p.key === qualityNotificationKey(hold.id, 'opened', 1))?.body,
    );
    expect([body.scopeFinal, body.scopeAsOf]).toEqual([false, body.occurredAt]);
  });

  it('compares within the hold’s epoch by time; an older epoch is before the opening, a newer one after (L1)', async () => {
    const h = await harness('epochs');
    await dispatched(h, 'X-1', 3);
    const l = h.line;
    // Opened in epoch E2 at a plant time before every fact of this test.
    const hold = await h.holds.open(
      { subject: { kind: 'lot', id: 'K1' }, reason: 'SUSPECT-LOT' },
      h.qa,
      { plantAt: new Date(PLANT_T0), epoch: E1 + 500 },
    );
    // Epoch E1 (older), later plant times: before the opening by position.
    await send(h, [
      l.job('accepted', 'X-1', 3),
      l.job('started', 'X-1', 3),
      ...l.unit(1, { blank: 'B1', kit: 'K1' }),
    ]);
    await settle(h);
    expect((await h.holds.detail(hold.id))?.incidents).toEqual([]);
    // A newer epoch (E1 + 1000): after the opening whatever its time.
    l.epoch = E1 + 1000;
    await send(h, [...l.unit(7, { blank: 'B1', kit: 'K1' }), ...l.settleAll()]);
    await settle(h);
    const incidents = (await h.holds.detail(hold.id))?.incidents ?? [];
    expect(incidents.map((i) => [i.epoch, i.partId, i.operation])).toEqual([
      [E1 + 1000, 7, 'OP30'],
    ]);
  });
});
