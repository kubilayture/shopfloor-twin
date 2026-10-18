/**
 * Test support for order OEE against the simulator's ground truth (#231, P9-04): a golden
 * scenario run headless as a process (apps never import each other), its event log as the UNS
 * facts the gateway would publish, and the MES modules order OEE reads (ingest, equipment, orders,
 * execution) over a fresh database. A golden log carries no MES dispatch, so the command state,
 * `notBefore` included, is seeded from the run header's `dispatches`: the MES imports the
 * scenario's ERP orders, releases them and dispatches them at the idle start, and the commands it
 * makes must equal the header's dispatches field for field (ADR-0036 amendment, conventions).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expandErpDataset } from '@shopfloor/contracts/erp-api';
import { HOUR } from '@shopfloor/oee-core';
import { idealCycleMs, type PlantConfig } from '@shopfloor/plant-config';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { Database } from './db/database.ts';
import { Equipment, downtimeRules } from './modules/equipment/index.ts';
import {
  CommandSink,
  GoldenErp,
  goldenUnsMessages,
  type SimEvent,
} from './modules/equipment/golden-feed.test-support.ts';
import { freshDatabase, type Delivery } from './modules/equipment/test-support.ts';
import { Execution } from './modules/execution/index.ts';
import { Identity } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData, erpMasterData } from './modules/master-data/index.ts';
import { OrderOee, type OrderOeeView } from './modules/oee/index.ts';
import { Orders } from './modules/orders/index.ts';
import { orderOeeDto } from './modules/realtime/index.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const HEADLESS = join(REPO, 'apps/simulator/src/headless/cli.ts');
export const GOLDENS = join(REPO, 'apps/simulator/golden');
export const EPOCH = 1_760_000_000;

/** One header dispatch (`dispatches` of the run header, ADR-0030). */
export interface HeaderDispatch {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: string;
}

/** One order of `line-oee.json` (`sim-line-oee/1`), the part P9-04 reconciles. */
export interface TruthOrder {
  readonly product: string;
  readonly jobs: readonly string[];
  readonly jobOee: Readonly<Record<string, unknown>>;
  readonly oee: unknown;
  readonly open: boolean;
  readonly pending: boolean;
  readonly headTimeUnknown: boolean;
  readonly endLost: boolean;
  readonly lost: boolean;
  readonly firstPassYield: unknown;
  readonly completedAt: string | null;
}

export interface GoldenRun {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly events: SimEvent[];
  readonly dispatches: readonly HeaderDispatch[];
  readonly orders: Readonly<Record<string, TruthOrder>>;
  readonly dir: string;
}

/** The scenario run headless; its `line-oee.json` must be the committed one. */
export async function goldenRun(name: string, out: string[]): Promise<GoldenRun> {
  const dir = await mkdtemp(join(tmpdir(), 'order-oee-'));
  out.push(dir);
  await promisify(execFile)(process.execPath, [HEADLESS, '--scenario', name, '--out', dir], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const [lines, lineOee] = await Promise.all([
    readFile(join(dir, 'events.jsonl'), 'utf8'),
    readFile(join(dir, 'line-oee.json'), 'utf8'),
  ]);
  expect(lineOee).toBe(await readFile(join(GOLDENS, name, 'line-oee.json'), 'utf8'));
  const [headerLine, ...rest] = lines.trimEnd().split('\n');
  const header = JSON.parse(headerLine ?? '{}') as {
    start: string;
    end: string;
    dispatches?: HeaderDispatch[];
  };
  return {
    name,
    start: Date.parse(header.start),
    end: Date.parse(header.end),
    events: rest.map((line) => JSON.parse(line) as SimEvent),
    dispatches: header.dispatches ?? [],
    orders: (JSON.parse(lineOee) as { orders: Record<string, TruthOrder> }).orders,
    dir: join(GOLDENS, name),
  };
}

export async function removeAll(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}

/** The modules order OEE reads, over a fresh database (no broker; ticks by hand). */
export interface OrderOeeStack {
  readonly db: Kysely<Database>;
  readonly ingest: Ingest;
  readonly equipment: Equipment;
  readonly orders: Orders;
  readonly execution: Execution;
  readonly orderOee: OrderOee;
  send(deliveries: readonly Delivery[]): Promise<void>;
  /**
   * Brings the command state and the units up to date (as the modules' timers would); with
   * `execution: false` only the command state, so the units lag the facts (execution's timer
   * not run yet).
   */
  tick(options?: { readonly execution?: boolean }): Promise<void>;
  stop(): Promise<void>;
}

export async function orderOeeStack(
  serverUrl: string,
  plant: PlantConfig,
  run: GoldenRun,
  prefix: string,
): Promise<OrderOeeStack> {
  const db = await freshDatabase(serverUrl, prefix);
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    refresh: {},
    // Above the run's length: no gap of a reordered replay is written off.
    gapGraceMs: 3_600_000,
  });
  const equipment = new Equipment({
    db,
    source: ingest,
    shiftPattern: plant.shifts,
    provisionalStepMs: HOUR,
    refresh: {},
    downtime: downtimeRules(plant),
  });
  await equipment.start();
  const scenario = JSON.parse(await readFile(join(run.dir, 'scenario.json'), 'utf8')) as {
    erp: { dataset: string; release: string[] };
  };
  const dataset: unknown = JSON.parse(await readFile(join(run.dir, scenario.erp.dataset), 'utf8'));
  const expanded = expandErpDataset(dataset, erpMasterData(plant));
  if (!expanded.ok) throw new Error(expanded.issues.join('\n'));
  const erp = new GoldenErp(expanded.feed, expanded.lots);
  const clock = () => equipment.watermark(EPOCH) ?? new Date(run.start);
  const orders = new Orders({
    db,
    ingest,
    masterData,
    publisher: new CommandSink(),
    erp,
    clock,
    tickMs: 0,
    erpPollMs: 0,
    erpPostMs: 0,
    // Commands live for an hour of wall time: a slow replay never declares one failed.
    timings: { ttlMs: 3_600_000, failMarginMs: 3_600_000 },
  });
  await orders.start();
  const execution = new Execution({
    db,
    ingest,
    masterData,
    orders,
    rework: {
      test: plant.process.leakTest.operation,
      back: plant.process.leakTest.reworkOperation,
    },
    clock,
    tickMs: 0,
  });
  await execution.start();
  orders.useBlankCounter(execution);
  const orderOee = new OrderOee({
    orders,
    execution,
    equipment,
    ingest,
    masterData,
    shiftPattern: plant.shifts,
    config: plant.oee,
    idealCycleMs: idealCycleMs(plant),
    operations: plant.products.operations,
  });
  orderOee.start();
  return {
    db,
    ingest,
    equipment,
    orders,
    execution,
    orderOee,
    send: async (deliveries) => {
      for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
    },
    tick: async (options = {}) => {
      await orders.tick();
      if (options.execution === false) return;
      await execution.tick();
      await orders.tick();
    },
    stop: async () => {
      orderOee.stop();
      await execution.stop();
      await orders.stop();
      await equipment.stop();
      await ingest.stop();
      await db.destroy();
    },
  };
}

/**
 * The command state seeded from the run header (module comment): import, release and dispatch at
 * the idle start; the MES's commands equal the header's `dispatches`, `notBefore` included.
 */
export async function seedDispatches(stack: OrderOeeStack, run: GoldenRun): Promise<void> {
  const identity = new Identity({ db: stack.db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
  const user = await identity.createUser(
    {
      username: 'supervisor',
      roles: ['supervisor'],
      password: 'a-long-test-password',
      mustChangePassword: false,
    },
    { system: 'test' },
  );
  const by = {
    by: { userId: user.id, username: 'supervisor', roles: ['supervisor' as const] },
    requestId: 'order-oee',
  };
  const scenario = JSON.parse(await readFile(join(run.dir, 'scenario.json'), 'utf8')) as {
    erp: { release: string[] };
  };
  await stack.orders.importNow();
  const all = (await stack.orders.list()).orders;
  expect(all.filter((o) => o.status === 'rejected')).toEqual([]);
  for (const id of scenario.erp.release) {
    const found = all.find((o) => o.id === id);
    await stack.orders.release(id, { version: found?.version ?? 0 }, by);
  }
  for (const order of (await stack.orders.list({ status: ['released'] })).orders) {
    await stack.orders.dispatch(order.id, { version: order.version }, by);
  }
  expect(run.dispatches.length).toBeGreaterThan(0);
  expect(
    (await stack.orders.commands()).map((c) => ({
      commandId: c.commandId,
      machine: c.equipment,
      orderId: c.orderId,
      product: c.product,
      quantity: c.quantity,
      notBefore: c.notBefore.toISOString(),
    })),
  ).toEqual(run.dispatches);
  identity.stop();
}

/** The run's UNS messages: anchors, the facts before the first job fact, and the rest. */
export function goldenFacts(
  run: GoldenRun,
  plant: PlantConfig,
): { anchors: Delivery[]; before: Delivery[]; after: Delivery[]; end: Delivery } {
  const { facts, anchors, end } = goldenUnsMessages(run, plant, EPOCH);
  const at = facts.findIndex((d) => d.topic.endsWith('/events/job'));
  return {
    anchors,
    before: at < 0 ? facts : facts.slice(0, at),
    after: at < 0 ? [] : facts.slice(at),
    end,
  };
}

const HEAD_SOURCES_IN_TRUTH = new Set(['accepted', 'previous-completed', 'notBefore']);

/** The MES's order OEE in the shape of `line-oee.json`'s order (without its line part). */
export function oeeShape(view: OrderOeeView): Omit<TruthOrder, 'firstPassYield' | 'completedAt'> {
  const dto = orderOeeDto(view);
  return {
    product: dto.product,
    jobs: dto.jobs.map((job) => job.commandId),
    jobOee: Object.fromEntries(
      dto.jobs
        .map((job): [string, unknown] => [
          job.commandId,
          {
            machine: job.machine,
            headTime: job.head.at,
            headSource:
              job.head.source !== null && HEAD_SOURCES_IN_TRUTH.has(job.head.source)
                ? job.head.source
                : null,
            window:
              job.window === null
                ? null
                : { from: job.window.from, to: job.window.to, open: job.window.open },
            cycles: job.cycles,
            oee: job.oee,
          },
        ])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    oee: dto.oee,
    open: dto.open,
    pending: dto.pending,
    headTimeUnknown: dto.headTimeUnknown,
    endLost: dto.endLost,
    lost: dto.lost,
  };
}

/** The truth's order OEE part (without first-pass yield, completion and line). */
export function truthOeeShape(
  truth: TruthOrder,
): Omit<TruthOrder, 'firstPassYield' | 'completedAt'> {
  return {
    product: truth.product,
    jobs: truth.jobs,
    jobOee: truth.jobOee,
    oee: truth.oee,
    open: truth.open,
    pending: truth.pending,
    headTimeUnknown: truth.headTimeUnknown,
    endLost: truth.endLost,
    lost: truth.lost,
  };
}

/** The first-pass yield and completion in the truth's shape. */
export function yieldShape(view: OrderOeeView): {
  firstPassYield: unknown;
  completedAt: string | null;
} {
  const dto = orderOeeDto(view);
  const { firstPassGood, started, yield: ratio } = dto.firstPassYield;
  return { firstPassYield: { firstPassGood, started, yield: ratio }, completedAt: dto.completedAt };
}

/**
 * Judging on partial data (#231, the Phase 8 lesson): whatever the MES calls final must already be
 * the truth's, and stay final and unchanged; provisional values may be anything. Counts what was
 * seen, so a replay that never put a final/provisional boundary under test shows it.
 */
export class Judge {
  readonly #run: GoldenRun;
  readonly #finalOee = new Map<string, string>();
  readonly #finalYield = new Map<string, string>();
  readonly #jobFinal = new Map<string, string>();
  /** Judgements with at least one provisional order whose truth is final. */
  provisionalTicks = 0;
  /** Most orders provisional at once while some others were final. */
  mixedTicks = 0;
  ticks = 0;
  /** Wall ms of each read of an order not final yet (derived, not from memory). */
  readonly reads: number[] = [];

  constructor(run: GoldenRun) {
    this.#run = run;
  }

  /** The 95th percentile of `reads`, ms. */
  get p95(): number {
    const sorted = [...this.reads].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  }

  get finals(): number {
    return this.#finalOee.size;
  }

  async check(stack: OrderOeeStack): Promise<void> {
    this.ticks++;
    let provisional = 0;
    let final = 0;
    for (const [id, truth] of Object.entries(this.#run.orders)) {
      const started = performance.now();
      const view = await stack.orderOee.order(id);
      if (!(this.#finalOee.has(id) && this.#finalYield.has(id))) {
        this.reads.push(performance.now() - started);
      }
      if (!view) {
        // Not imported yet: nothing to judge.
        continue;
      }
      const oee = JSON.stringify(oeeShape(view));
      const was = this.#finalOee.get(id);
      if (was !== undefined) {
        expect([id, view.final, oee]).toEqual([id, true, was]);
      } else if (view.final) {
        expect([id, oeeShape(view)]).toEqual([id, truthOeeShape(truth)]);
        this.#finalOee.set(id, oee);
      }
      if (view.final) final++;
      else if (truth.completedAt !== null) provisional++;
      // A job final on its own must be the truth's job already.
      for (const job of view.jobs) {
        if (!job.final) continue;
        const shape = JSON.stringify(oeeShape(view).jobOee[job.commandId]);
        const before = this.#jobFinal.get(job.commandId);
        if (before === undefined) {
          expect([job.commandId, oeeShape(view).jobOee[job.commandId]]).toEqual([
            job.commandId,
            truth.jobOee[job.commandId],
          ]);
          this.#jobFinal.set(job.commandId, shape);
        } else {
          expect([job.commandId, shape]).toEqual([job.commandId, before]);
        }
      }
      const fpy = JSON.stringify(yieldShape(view));
      const fpyWas = this.#finalYield.get(id);
      if (fpyWas !== undefined) {
        expect([id, view.firstPassYield.final, fpy]).toEqual([id, true, fpyWas]);
      } else if (view.firstPassYield.final) {
        expect([id, yieldShape(view)]).toEqual([
          id,
          { firstPassYield: truth.firstPassYield, completedAt: truth.completedAt },
        ]);
        this.#finalYield.set(id, fpy);
      }
    }
    if (provisional > 0) this.provisionalTicks++;
    if (provisional > 0 && final > 0) this.mixedTicks++;
  }

  /**
   * At the end, with every fact in: every order the truth completed is final in the MES (its OEE,
   * jobs, first-pass yield and completion equal to the truth's); an order still open in the truth
   * is open and not final in the MES. Returns the counts compared.
   */
  async expectEnd(stack: OrderOeeStack): Promise<{ final: number; open: number; jobs: number }> {
    await this.check(stack);
    let final = 0;
    let open = 0;
    let jobs = 0;
    for (const [id, truth] of Object.entries(this.#run.orders)) {
      const view = await stack.orderOee.order(id);
      if (!view) throw new Error(`no order ${id} in the MES`);
      if (truth.completedAt !== null) {
        expect([id, view.final, view.firstPassYield.final]).toEqual([id, true, true]);
        expect([id, oeeShape(view)]).toEqual([id, truthOeeShape(truth)]);
        expect([id, yieldShape(view)]).toEqual([
          id,
          { firstPassYield: truth.firstPassYield, completedAt: truth.completedAt },
        ]);
        final++;
        jobs += view.jobs.length;
      } else {
        expect([id, truth.open, view.final, view.result.open, view.completedAt]).toEqual([
          id,
          true,
          false,
          true,
          null,
        ]);
        open++;
      }
    }
    return { final, open, jobs };
  }
}
