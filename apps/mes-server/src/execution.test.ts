/**
 * The `execution` module (#175) against a real database (as `mes_app`) and the real ingest store,
 * with the orders module, a fake ERP and a recording command sink: units from cycle facts and job
 * facts delivered out of order (a cycle before its job's `started` fact, rework passes reordered),
 * completion only when no unit can come back (H1), backflush at cycle completion (H2), final
 * confirmations, a late fact after a gap was written off making corrections, the ERP's 409 as an
 * incident, an epoch change mid-job (units lost, blanks counted exactly), routing violations judged
 * on final data, and scrap coding (version, reason tree, audit).
 */
import {
  statusKey,
  expandErpDataset,
  type FeedEntry,
  type MessageReceipt,
} from '@shopfloor/contracts/erp-api';
import {
  PROBLEM_TYPES,
  executionIncidentListSchema,
  orderDetailSchema,
  orderExecutionSchema,
  scrapReasonListSchema,
  scrapRecordListSchema,
  scrapRecordSchema,
  unitListSchema,
} from '@shopfloor/contracts/mes-api';
import type { EquipmentPath } from '@shopfloor/contracts';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import { PLANT_CONFIG, UnsFeed, freshDatabase } from './modules/equipment/test-support.ts';
import { Execution, ExecutionError } from './modules/execution/index.ts';
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

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const PLANT_T0 = Date.parse('2026-10-12T03:00:00.000Z');
const E1 = 1_760_000_000;
const E2 = 1_760_000_500;

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
  readonly posts: { kind: string; key: string; body: unknown }[] = [];
  answer: (kind: string, key: string) => PostOutcome = (kind, key) => ({
    kind: 'stored',
    status: 201,
    receipt: {
      idempotencyKey: key,
      kind: kind === 'status' ? 'status' : 'confirmation',
      orderNumber: key.split('~')[0] ?? '',
      receivedSeq: this.posts.length,
      receivedAt: new Date(T0).toISOString(),
    } satisfies MessageReceipt,
  });

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

  post(kind: 'status' | 'confirmation', key: string, body: unknown): Promise<PostOutcome> {
    this.posts.push({ kind, key, body });
    return Promise.resolve(this.answer(kind, key));
  }
}

class Sink implements CommandPublisher {
  readonly connected = true;
  publish(): Promise<void> {
    return Promise.resolve();
  }
}

interface Harness {
  readonly db: Kysely<Database>;
  readonly ingest: Ingest;
  readonly orders: Orders;
  readonly execution: Execution;
  readonly erp: FakeErp;
  readonly clock: { now: number };
  readonly line: Line;
  readonly by: {
    by: { userId: number; username: string; roles: ('supervisor' | 'operator')[] };
    requestId: string;
  };
  readonly operator: {
    by: { userId: number; username: string; roles: 'operator'[] };
    requestId: string;
  };
}

/** The facts of one simulator run, numbered per machine, at rising plant times. */
class Line {
  readonly #feed = new UnsFeed(new Map());
  readonly #seqs = new Map<string, number>();
  #at = PLANT_T0;
  readonly epoch: number;

  constructor(feed: UnsFeed, epoch: number) {
    this.#feed = feed;
    this.epoch = epoch;
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

  state(
    equipment: string,
    state: 'Idle' | 'Running' | 'Setup' | 'Starved',
    cause: string | null = null,
  ) {
    return this.#feed.state(
      equipment,
      this.epoch,
      this.#next(equipment),
      this.#time(),
      state,
      cause,
    );
  }

  cycle(
    equipment: string,
    partId: number,
    result: 'good' | 'scrap' | 'rework' = 'good',
    reason: string | null = null,
  ) {
    return this.#feed.cycle(equipment, this.epoch, this.#next(equipment), this.#time(), {
      product: 'VB-100',
      partId,
      serial: equipment.startsWith('cnc') ? `VB-100-${String(partId).padStart(6, '0')}` : '',
      result,
      reason,
    });
  }

  job(
    equipment: string,
    transition: 'accepted' | 'started' | 'completed',
    orderId: string,
    quantity: number,
  ) {
    return this.#feed.job(equipment, this.epoch, this.#next(equipment), this.#time(), {
      transition,
      commandId: `${orderId}~OP10~1`,
      orderId,
      product: 'VB-100',
      quantity,
    });
  }
}

async function harness(name: string, options: { gapGraceMs?: number } = {}): Promise<Harness> {
  const db = await freshDatabase(serverUrl, `execution_${name}`);
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
  const olga = await identity.createUser(
    {
      username: 'olga',
      roles: ['operator'],
      password: 'a-long-test-password',
      mustChangePassword: false,
    },
    { system: 'test' },
  );
  const clock = { now: T0 };
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'x',
    sweepIntervalMs: 0,
    gapGraceMs: options.gapGraceMs ?? 3_600_000,
    now: () => clock.now,
  });
  const erp = new FakeErp();
  const feed = new UnsFeed(paths);
  const line = new Line(feed, E1);
  const orders = new Orders({
    db,
    ingest,
    masterData,
    publisher: new Sink(),
    erp,
    clock: () => new Date(PLANT_T0),
    now: () => clock.now,
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
  return {
    db,
    ingest,
    orders,
    execution,
    erp,
    clock,
    line,
    by: { by: { userId: sam.id, username: 'sam', roles: ['supervisor'] }, requestId: 'req-s' },
    operator: {
      by: { userId: olga.id, username: 'olga', roles: ['operator'] },
      requestId: 'req-o',
    },
  };
}

/** Imports, releases and dispatches an order of `quantity` VB-100 to CNC-01. */
async function dispatched(h: Harness, number: string, quantity: number): Promise<void> {
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

const send = async (h: Harness, deliveries: readonly { topic: string; payload: string }[]) => {
  for (const d of deliveries) await h.ingest.deliver(d.topic, d.payload);
};

/** Commands, units, completion and confirmations up to date; then the ERP outbox posted. */
async function settle(h: Harness): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await h.orders.tick();
    await h.execution.tick();
  }
  while ((await h.orders.postNow()) > 0) {
    // until nothing is pending
  }
}

const confirmationsOf = async (h: Harness, id: string) =>
  (await h.orders.confirmations(id, h.db)).map((c) => ({
    operation: c.operation,
    n: c.n,
    kind: c.kind,
    yield: c.yield,
    scrap: c.scrap,
    reworkPasses: c.reworkPasses,
    material: c.material,
  }));

describe('execution: units, completion and confirmations (#175)', () => {
  it('attributes cycles delivered before their job fact, numbers reordered rework passes, completes only when no unit can come back and confirms once', async () => {
    const h = await harness('flow');
    const l = h.line;
    await send(h, [l.state('cnc-01', 'Idle', 'NO-ORDER')]);
    await dispatched(h, 'X-1', 2);
    // The run's facts, numbered in plant order …
    const cnc = [
      l.job('cnc-01', 'accepted', 'X-1', 2),
      l.state('cnc-01', 'Setup', 'CHANGEOVER none→VB-100'),
      l.job('cnc-01', 'started', 'X-1', 2),
      l.state('cnc-01', 'Running'),
      l.cycle('cnc-01', 1),
    ];
    const wsh = [l.cycle('wsh-01', 1)];
    const cnc2 = [
      l.cycle('cnc-01', 2, 'scrap', 'DIMENSIONAL'),
      l.job('cnc-01', 'completed', 'X-1', 2),
    ];
    const asm1 = [l.cycle('asm-01', 1)];
    const lkt1 = [l.cycle('lkt-01', 1, 'rework', 'LEAK')];
    const asm2 = [l.cycle('asm-01', 1)];
    const lkt2 = [l.cycle('lkt-01', 1)];
    const pck = [l.cycle('pck-01', 1)];
    // … delivered out of order: the OP10 cycles before their job's `started` fact, the second
    // OP30 pass and its test before the first failure; every step judged on what has arrived.
    const order = [
      cnc[4],
      cnc2[0],
      cnc[0],
      wsh[0],
      lkt2[0],
      asm2[0],
      asm1[0],
      pck[0],
      cnc[1],
      cnc[2],
      cnc[3],
      cnc2[1],
    ];
    for (const delivery of order) {
      if (!delivery) throw new Error('fact');
      await send(h, [delivery]);
      await settle(h);
      // OP30 to OP50 are not confirmed while the first leak failure is missing (lkt-01 is not
      // final through its records), nor anything before cnc-01's `completed` fact.
      const confirmed = (await confirmationsOf(h, 'X-1')).map((c) => c.operation);
      expect(confirmed.filter((op) => !['OP10', 'OP20'].includes(op))).toEqual([]);
      expect((await h.orders.order('X-1'))?.status).not.toBe('completed');
    }
    // OP10 (its job completed, cnc-01 final through it) and OP20 (every unit passed or was
    // scrapped at OP10) are complete already, each confirmed on its own.
    expect((await confirmationsOf(h, 'X-1')).map((c) => c.operation)).toEqual(['OP10', 'OP20']);
    await send(h, lkt1);
    await settle(h);
    const unit = (await h.execution.units({ orderId: 'X-1' })).units;
    expect(
      unit.map((u) => [
        u.partId,
        u.status,
        u.records.map((r) => `${r.operation}/${String(r.pass)}/${r.result}`),
      ]),
    ).toEqual([
      [
        1,
        'packed',
        [
          'OP10/1/good',
          'OP20/1/good',
          'OP30/1/good',
          'OP40/1/rework',
          'OP30/2/good',
          'OP40/2/good',
          'OP50/1/good',
        ],
      ],
      [2, 'scrapped', ['OP10/1/scrap']],
    ]);
    const order1 = await h.orders.order('X-1');
    expect([order1?.status, order1?.short]).toEqual(['completed', true]);
    expect(await confirmationsOf(h, 'X-1')).toEqual([
      {
        operation: 'OP10',
        n: 1,
        kind: 'final',
        yield: 1,
        scrap: { DIMENSIONAL: 1 },
        reworkPasses: 0,
        material: { 'BLANK-100': 2 },
      },
      {
        operation: 'OP20',
        n: 1,
        kind: 'final',
        yield: 1,
        scrap: {},
        reworkPasses: 0,
        material: {},
      },
      {
        operation: 'OP30',
        n: 1,
        kind: 'final',
        yield: 2,
        scrap: {},
        reworkPasses: 0,
        material: { 'SK-1': 2, 'SP-100': 1 },
      },
      {
        operation: 'OP40',
        n: 1,
        kind: 'final',
        yield: 1,
        scrap: {},
        reworkPasses: 1,
        material: {},
      },
      {
        operation: 'OP50',
        n: 1,
        kind: 'final',
        yield: 1,
        scrap: {},
        reworkPasses: 0,
        material: {},
      },
    ]);
    // The ERP got each once (the outbox, keyed), and the completed status with `short`.
    expect(h.erp.posts.filter((p) => p.kind === 'confirmation').map((p) => p.key)).toEqual(
      ['OP10', 'OP20', 'OP30', 'OP40', 'OP50'].map((op) => `X-1~${op}~conf~1`),
    );
    expect(h.erp.posts.find((p) => p.key === statusKey('X-1', 1, 'completed'))?.body).toMatchObject(
      { short: true },
    );
    // The order's execution: WIP empty, completed at the packing.
    const execution = await h.execution.orderExecution('X-1');
    expect(execution?.units).toEqual({ total: 2, wip: 0, packed: 1, scrapped: 1, lost: 0 });
    expect(execution?.completedAt?.getTime()).toBe(unit[0]?.records.at(-1)?.at.getTime());
    // Settling again changes nothing (no second message under any key).
    await settle(h);
    expect(h.erp.posts.filter((p) => p.kind === 'confirmation')).toHaveLength(5);
    expect(await h.orders.incidents()).toEqual([]);
    expect(await h.execution.incidents()).toEqual([]);
    // The order's detail carries the confirmations.
    expect((await h.orders.detail('X-1'))?.confirmations.map((c) => c.messageStatus)).toEqual(
      Array(5).fill('sent'),
    );
  });

  it('confirms from final data, and a late fact filling a written-off gap makes corrections with deltas', async () => {
    const h = await harness('late', { gapGraceMs: 0 });
    const l = h.line;
    await send(h, [l.state('cnc-01', 'Idle', 'NO-ORDER')]);
    await dispatched(h, 'X-2', 1);
    const run = [
      l.job('cnc-01', 'accepted', 'X-2', 1),
      l.job('cnc-01', 'started', 'X-2', 1),
      l.cycle('cnc-01', 1),
      l.job('cnc-01', 'completed', 'X-2', 1),
      l.cycle('wsh-01', 1),
      l.cycle('asm-01', 1),
      l.cycle('lkt-01', 1, 'rework', 'LEAK'),
      l.cycle('asm-01', 1),
      l.cycle('lkt-01', 1),
      l.cycle('pck-01', 1),
    ];
    // The leak test's rework (lkt-01 seq 1) is lost on the way: a gap.
    const [rework] = run.splice(6, 1);
    if (!rework) throw new Error('fact');
    await send(h, run);
    await h.ingest.sweep();
    await settle(h);
    // Written off, the gap counts as closed: the order completes on what arrived.
    expect((await h.orders.order('X-2'))?.status).toBe('completed');
    const before = await confirmationsOf(h, 'X-2');
    expect(before.find((c) => c.operation === 'OP30')).toMatchObject({
      yield: 2,
      material: { 'SK-1': 2, 'SP-100': 2 },
    });
    // Two OP30 passes with no rework between: a routing violation, judged on final data.
    expect((await h.execution.incidents({ open: true })).map((i) => i.message)).toEqual([
      expect.stringContaining('repeated'),
    ]);
    // The lost fact arrives late: the unit rebuilds, corrections go with the deltas.
    await send(h, [rework]);
    await settle(h);
    const after = await confirmationsOf(h, 'X-2');
    expect(after.filter((c) => c.kind === 'correction')).toEqual([
      {
        operation: 'OP30',
        n: 2,
        kind: 'correction',
        yield: 0,
        scrap: {},
        reworkPasses: 0,
        material: { 'SP-100': -1 },
      },
      {
        operation: 'OP40',
        n: 2,
        kind: 'correction',
        yield: 0,
        scrap: {},
        reworkPasses: 1,
        material: {},
      },
    ]);
    const conf = await h.orders.confirmations('X-2', h.db);
    expect(conf.find((c) => c.operation === 'OP30' && c.n === 2)?.totals).toEqual({
      yield: 2,
      scrap: {},
      reworkPasses: 0,
      material: { 'SK-1': 2, 'SP-100': 1 },
    });
    expect(h.erp.posts.map((p) => p.key)).toContain('X-2~OP40~conf~2');
    // The violation is resolved by the late fact.
    expect(await h.execution.incidents({ open: true })).toEqual([]);
  });

  it("records the ERP's 409 on a confirmation as an incident, never retried", async () => {
    const h = await harness('conflict');
    const l = h.line;
    h.erp.answer = (kind, key) =>
      kind === 'confirmation'
        ? { kind: 'conflict', status: 409, detail: 'another body' }
        : {
            kind: 'stored',
            status: 201,
            receipt: {
              idempotencyKey: key,
              kind: 'status',
              orderNumber: 'X-3',
              receivedSeq: 1,
              receivedAt: new Date(T0).toISOString(),
            },
          };
    await send(h, [l.state('cnc-01', 'Idle', 'NO-ORDER')]);
    await dispatched(h, 'X-3', 1);
    await send(h, [
      l.job('cnc-01', 'accepted', 'X-3', 1),
      l.job('cnc-01', 'started', 'X-3', 1),
      l.cycle('cnc-01', 1, 'scrap', 'DIMENSIONAL'),
      l.job('cnc-01', 'completed', 'X-3', 1),
    ]);
    await settle(h);
    const types = (await h.orders.incidents()).map((i) => i.type);
    expect(types.filter((t) => t === 'erp-conflict')).toHaveLength(5);
    const posted = h.erp.posts.filter((p) => p.kind === 'confirmation').length;
    await settle(h);
    expect(h.erp.posts.filter((p) => p.kind === 'confirmation')).toHaveLength(posted);
    expect((await h.orders.confirmations('X-3', h.db)).map((c) => c.messageStatus)).toEqual(
      Array(5).fill('conflict'),
    );
  });

  it('marks units of an ended run lost and counts a lost job’s blanks exactly from its units and states', async () => {
    const h = await harness('epoch');
    const l = h.line;
    await send(h, [l.state('cnc-01', 'Idle', 'NO-ORDER')]);
    await dispatched(h, 'X-4', 5);
    await send(h, [
      l.job('cnc-01', 'accepted', 'X-4', 5),
      l.job('cnc-01', 'started', 'X-4', 5),
      l.state('cnc-01', 'Running'),
      l.cycle('cnc-01', 1),
      // No blank after it: the CNC ran out of material, then the simulator restarted.
      l.state('cnc-01', 'Starved', 'MATERIAL-BLANK-100'),
    ]);
    await settle(h);
    const next = new Line(new UnsFeed(paths), E2);
    await send(h, [next.state('cnc-01', 'Idle', 'NO-ORDER')]);
    await settle(h);
    const command = (await h.orders.commands({ orderId: 'X-4' }))[0];
    // The conservative count would be 2 (one more possibly in the machine); the units and the
    // Starved state say 1.
    expect([command?.job, command?.lostStarted]).toEqual(['lost', 1]);
    expect((await h.orders.order('X-4'))?.dispatched).toBe(1);
    expect((await h.execution.units({ orderId: 'X-4' })).units.map((u) => u.status)).toEqual([
      'lost',
    ]);
    expect((await h.orders.order('X-4'))?.status).toBe('in-progress');
  });

  it('judges a missing predecessor a routing violation only once that machine is final through it', async () => {
    const h = await harness('violation');
    const l = h.line;
    await send(h, [l.cycle('cnc-01', 9), l.cycle('asm-01', 9)]);
    await settle(h);
    // wsh-01 has reported nothing of this run: its OP20 cycle may still be on its way.
    expect(await h.execution.incidents()).toEqual([]);
    expect((await h.execution.units()).units[0]?.violation).toBeNull();
    await send(h, [l.state('wsh-01', 'Starved')]);
    await settle(h);
    const [incident] = await h.execution.incidents();
    expect(incident).toMatchObject({ type: 'routing-violation', partId: 9, closedAt: null });
    expect(incident?.message).toContain('OP20');
    expect((await h.execution.units()).units[0]?.violation).toBe('missing-predecessor');
  });
});

describe('the execution API (#175)', () => {
  it('serves units, an order’s execution, scrap records, reasons, incidents and the confirmations; codes scrap with the session’s user', async () => {
    const h = await harness('api');
    const l = h.line;
    await send(h, [l.state('cnc-01', 'Idle', 'NO-ORDER')]);
    await dispatched(h, 'A-1', 1);
    await send(h, [
      l.job('cnc-01', 'accepted', 'A-1', 1),
      l.job('cnc-01', 'started', 'A-1', 1),
      l.cycle('cnc-01', 1, 'scrap', 'DIMENSIONAL'),
      l.job('cnc-01', 'completed', 'A-1', 1),
    ]);
    await settle(h);
    const identity = new Identity({ db: h.db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
    await identity.start();
    cleanups.push(() => {
      identity.stop();
      return Promise.resolve();
    });
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
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
      execution: h.execution,
    } as unknown as ApiSources);
    const HOST = 'localhost:4700';
    const headers = { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' };
    const login = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: { username: 'olga', password: 'a-long-test-password' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const get = async (url: string) => {
      const response = await http.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, cookie },
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      return response.json<unknown>();
    };
    const execution = orderExecutionSchema.parse(await get('/api/v1/orders/A-1/execution'));
    expect(execution).toMatchObject({
      orderId: 'A-1',
      units: { total: 1, scrapped: 1 },
      scrap: { OP10: { DIMENSIONAL: 1 } },
    });
    expect(execution.operations.map((o) => [o.operation, o.completedAt !== null])).toEqual([
      ['OP10', true],
      ['OP20', true],
      ['OP30', true],
      ['OP40', true],
      ['OP50', true],
    ]);
    const units = unitListSchema.parse(
      await get('/api/v1/execution/units?orderId=A-1&status=scrapped'),
    );
    expect(units.units.map((u) => [u.partId, u.serial, u.status])).toEqual([
      [1, 'VB-100-000001', 'scrapped'],
    ]);
    const detail = orderDetailSchema.parse(await get('/api/v1/orders/A-1'));
    expect(detail.confirmations.map((c) => c.idempotencyKey)).toEqual(
      ['OP10', 'OP20', 'OP30', 'OP40', 'OP50'].map((op) => `A-1~${op}~conf~1`),
    );
    expect(scrapReasonListSchema.parse(await get('/api/v1/scrap-reasons')).reasons[0]?.id).toBe(
      'DIMENSIONAL',
    );
    expect(
      executionIncidentListSchema.parse(await get('/api/v1/execution-incidents?open=true'))
        .incidents,
    ).toEqual([]);
    const [record] = scrapRecordListSchema.parse(
      await get('/api/v1/scrap-records?uncoded=true'),
    ).records;
    const code = (body: unknown) =>
      http.app.inject({
        method: 'PUT',
        url: `/api/v1/scrap-records/${String(record?.id ?? 0)}/coding`,
        headers: { ...headers, cookie },
        payload: JSON.stringify(body),
      });
    const coded = await code({ version: 1, reason: 'DIMENSIONAL/TOOL-WEAR' });
    expect(coded.statusCode, coded.body).toBe(200);
    expect(scrapRecordSchema.parse(coded.json())).toMatchObject({ codedBy: 'olga', version: 2 });
    const stale = await code({ version: 1, reason: 'DIMENSIONAL/OTHER' });
    expect([stale.statusCode, stale.json<{ type: string }>().type]).toEqual([
      409,
      PROBLEM_TYPES.scrapStale,
    ]);
    expect((await code({ version: 2, reason: 'LEAK/SEAL' })).statusCode).toBe(422);
    expect((await code({ version: 2, reason: 'DIMENSIONAL', extra: 1 })).statusCode).toBe(400);
    const [audit] = await Identity.auditEntries(h.db, 'scrap_record', [String(record?.id ?? 0)]);
    expect(audit).toMatchObject({ action: 'scrap.code', username: 'olga', authenticated: true });
    expect(audit?.requestId).toBe(coded.headers['x-request-id']);
    expect(
      (
        await http.app.inject({
          method: 'GET',
          url: '/api/v1/orders/NOPE/execution',
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('scrap records and coding (#175)', () => {
  it('records every machine scrap; a coding names a reason under the machine’s, with the version read, audited, quantities unchanged', async () => {
    const h = await harness('scrap');
    const l = h.line;
    await send(h, [l.cycle('cnc-01', 3, 'scrap', 'DIMENSIONAL')]);
    await settle(h);
    const { records } = await h.execution.scrapRecords();
    expect(
      records.map((r) => [r.partId, r.operation, r.machineReason, r.codedReason, r.version]),
    ).toEqual([[3, 'OP10', 'DIMENSIONAL', null, 1]]);
    const id = records[0]?.id ?? 0;
    expect((await h.execution.scrapRecords({ uncoded: true })).records).toHaveLength(1);
    // Not under the machine's reason, not in the tree, a stale version, an unknown record.
    await expect(
      h.execution.codeScrap(id, { version: 1, reason: 'LEAK/SEAL' }, h.operator),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(
      h.execution.codeScrap(id, { version: 1, reason: 'DIMENSIONAL/NOPE' }, h.operator),
    ).rejects.toBeInstanceOf(ExecutionError);
    const coded = await h.execution.codeScrap(
      id,
      { version: 1, reason: 'DIMENSIONAL/OVERSIZE', comment: ' bore ' },
      h.operator,
    );
    expect([coded.codedReason, coded.comment, coded.codedBy, coded.version]).toEqual([
      'DIMENSIONAL/OVERSIZE',
      'bore',
      'olga',
      2,
    ]);
    await expect(
      h.execution.codeScrap(id, { version: 1, reason: 'DIMENSIONAL/SURFACE' }, h.operator),
    ).rejects.toMatchObject({ kind: 'conflict', type: PROBLEM_TYPES.scrapStale });
    await expect(
      h.execution.codeScrap(999, { version: 1, reason: 'DIMENSIONAL' }, h.operator),
    ).rejects.toMatchObject({ kind: 'not-found' });
    const [audit] = await h.execution.scrapAudit(id);
    expect(audit).toMatchObject({
      action: 'scrap.code',
      username: 'olga',
      authenticated: true,
      requestId: 'req-o',
      after: { codedReason: 'DIMENSIONAL/OVERSIZE', version: 2 },
    });
    // A rebuild of the unit keeps the coding.
    await send(h, [l.cycle('wsh-01', 3)]);
    await settle(h);
    expect((await h.execution.scrapRecords()).records[0]?.codedReason).toBe('DIMENSIONAL/OVERSIZE');
    expect((await h.execution.scrapReasons()).map((r) => r.id)).toContain('LEAK/POROSITY');
  });
});
