/**
 * Golden order and line OEE reconciliation (#231 P9-04, #232 P9-05; Phase 9 plan exit criterion
 * 1): the headless simulator runs each golden as a process; its event log becomes the UNS facts
 * the gateway would publish and goes through ingest's store path into TimescaleDB, where the
 * equipment, orders and execution modules keep the machines' states, the command state and the
 * units, and the `oee` module derives every order's OEE, job breakdown and first-pass yield, and
 * the line throughput OEE per hour, shift bucket and order. They must equal `line-oee.json`,
 * delivered three ways (in order, in bounded disorder, shuffled with 10 % duplicates), judged on
 * partial data all along: whatever the MES calls final must already be the truth's and stay final
 * and unchanged (`Judge`, `LineJudge`), finals must appear before the last delivery, and with
 * every fact in, every bucket and every order the truth completed is final and equal, the one
 * still open is open.
 *
 * `orders-01` and `quality-01` run in orders mode: the command state, `notBefore` included, is
 * seeded from the run header's `dispatches` (a golden log carries no MES dispatch), dispatched at
 * the idle start after the machines' first facts. `week-01` and `alarms-01` run in schedule mode:
 * no orders, hours and shift buckets only.
 */
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase } from './testing.ts';
import { PLANT_CONFIG, random, shuffle, type Delivery } from './modules/equipment/test-support.ts';
import {
  Judge,
  LineJudge,
  goldenFacts,
  goldenRun,
  orderOeeStack,
  removeAll,
  seedDispatches,
  type GoldenRun,
  type OrderOeeStack,
} from './order-oee.test-support.ts';

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
const dirs: string[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
}, 180_000);

afterAll(async () => {
  await removeAll(dirs);
  await container.stop();
});

interface Pins {
  /** Order OEE (orders mode): orders the truth completed, final in the MES and equal. */
  readonly orders?: {
    readonly final: number;
    /** Orders still open at the run's end. */
    readonly open: number;
    /** Jobs of the completed orders. */
    readonly jobs: number;
  };
  /**
   * Line OEE: hours and shift buckets equal (and final up to the line's settled end, the earliest
   * last fact of the machines it reads); orders' line OEE final and equal, open and equal.
   */
  readonly line: {
    readonly hours: number;
    readonly shifts: number;
    readonly finalHours: number;
    readonly finalShifts: number;
    readonly orders: number;
    readonly open: number;
  };
}

/** Both judges, the order one only in orders mode. */
class Judges {
  readonly order: Judge | undefined;
  readonly line: LineJudge;

  constructor(run: GoldenRun) {
    this.order = run.productionMode === 'orders' ? new Judge(run) : undefined;
    this.line = new LineJudge(run);
  }

  async check(stack: OrderOeeStack): Promise<void> {
    await this.order?.check(stack);
    await this.line.check(stack);
  }

  /** Finals called so far: orders (OEE) and line buckets and orders' line values. */
  get finals(): { orders: number; line: number } {
    return { orders: this.order?.finals ?? 0, line: this.line.finals };
  }

  async expectEnd(stack: OrderOeeStack): Promise<Pins> {
    const orders = this.order ? await this.order.expectEnd(stack) : undefined;
    const line = await this.line.expectEnd(stack);
    return { ...(orders ? { orders } : {}), line };
  }

  report(): string {
    const order = this.order
      ? `order reads p95 ${this.order.p95.toFixed(1)} ms over ${String(this.order.reads.length)}, `
      : '';
    return `${order}line reads p95 ${this.line.p95.toFixed(1)} ms over ${String(this.line.reads.length)}`;
  }
}

/** A stack with the machines' first facts and the seeded dispatches, ready for the rest. */
async function prepared(
  run: GoldenRun,
  label: string,
): Promise<{
  stack: OrderOeeStack;
  after: Delivery[];
  end: Delivery;
}> {
  const { anchors, before, after, end } = goldenFacts(run, plant);
  const stack = await orderOeeStack(serverUrl, plant, run, `oee_${label}`);
  await stack.send([...anchors, ...before]);
  await seedDispatches(stack, run);
  return { stack, after, end };
}

function suite(name: string, pins: Pins): void {
  describe(`golden order and line OEE: ${name} (#231, #232)`, () => {
    let run: GoldenRun | undefined;
    const label = name.replace('-', '_');

    it('in order, judged every 150 facts: finals equal line-oee.json', async () => {
      run = await goldenRun(name, dirs);
      expect(run.productionMode).toBe(pins.orders ? 'orders' : 'schedule');
      if (pins.orders) {
        expect(Object.keys(run.orders).length).toBe(pins.orders.final + pins.orders.open);
      } else {
        expect(run.orders).toEqual({});
      }
      const { stack, after, end } = await prepared(run, `${label}_order`);
      const judges = new Judges(run);
      let early = { orders: 0, line: 0 };
      for (let i = 0; i < after.length; i += 150) {
        await stack.send(after.slice(i, i + 150));
        await stack.tick();
        await judges.check(stack);
        early = judges.finals;
      }
      await stack.send([end]);
      await stack.tick();
      expect(await judges.expectEnd(stack)).toEqual(pins);
      // In order, finality follows the facts: orders and buckets are final long before the end.
      expect(early.line).toBeGreaterThan(0);
      expect(judges.line.mixedTicks).toBeGreaterThan(0);
      if (judges.order) {
        expect(early.orders).toBeGreaterThan(0);
        expect(judges.order.mixedTicks).toBeGreaterThan(0);
      }
      console.log(
        `${name}: in order, ${String(judges.line.ticks)} judgements; before the end ${String(early.orders)} orders and ${String(early.line)} line values final; at the end ${JSON.stringify(pins)} final and equal to line-oee.json; ${judges.report()}`,
      );
      await stack.stop();
    }, 900_000);

    it('bounded disorder, blocks held back: provisional on partial data, no final changed', async () => {
      // As the SPC replay (#200 review H2): windows of 120–240 facts, each shuffled and delivered
      // in chunks of 40–80 with a judgement after each; now and then a block of 40–80 held back
      // for 2–5 windows and single facts for 1–3, so gaps keep later facts provisional while
      // orders complete on either side of them. A third of the judgements run before the
      // execution module's round, so the units (the OP10 cycles' attribution) lag the facts.
      run ??= await goldenRun(name, dirs);
      const truth = run;
      const { stack, after, end } = await prepared(truth, `${label}_bounded`);
      const judges = new Judges(truth);
      const next = random(2_310);
      const held: { block: Delivery[]; release: number }[] = [];
      let heldBlocks = 0;
      let windows = 0;
      let early = { orders: 0, line: 0 };
      for (let i = 0; i < after.length || held.length > 0; windows++) {
        const size = 120 + Math.floor(next() * 121);
        let window = after.slice(i, i + size);
        i += size;
        if (window.length > 120 && next() < 0.3) {
          const length = 40 + Math.floor(next() * 41);
          held.push({
            block: window.slice(0, length),
            release: windows + 2 + Math.floor(next() * 4),
          });
          window = window.slice(length);
          heldBlocks++;
        }
        if (window.length > 4 && next() < 0.5) {
          const count = 1 + Math.floor(next() * 4);
          for (let k = 0; k < count; k++) {
            const at = Math.floor(next() * window.length);
            held.push({
              block: window.splice(at, 1),
              release: windows + 1 + Math.floor(next() * 3),
            });
          }
        }
        for (let h = held.length - 1; h >= 0; h--) {
          const entry = held[h];
          if (entry && (entry.release <= windows || i >= after.length)) {
            window = [...window, ...entry.block];
            held.splice(h, 1);
          }
        }
        const mixed = shuffle(window, next);
        for (let c = 0; c < mixed.length;) {
          const chunk = 40 + Math.floor(next() * 41);
          await stack.send(mixed.slice(c, c + chunk));
          c += chunk;
          // Now and then the units lag the facts (execution's round not run yet).
          await stack.tick({ execution: next() >= 0.3 });
          await judges.check(stack);
        }
        if (i < after.length || held.length > 0) early = judges.finals;
      }
      await stack.send([end]);
      await stack.tick();
      expect(heldBlocks).toBeGreaterThan(0);
      expect(judges.line.provisionalTicks).toBeGreaterThan(0);
      expect(judges.line.mixedTicks).toBeGreaterThan(0);
      expect(early.line).toBeGreaterThan(0);
      if (judges.order) {
        expect(judges.order.provisionalTicks).toBeGreaterThan(0);
        expect(judges.order.mixedTicks).toBeGreaterThan(0);
        expect(early.orders).toBeGreaterThan(0);
      }
      expect(await judges.expectEnd(stack)).toEqual(pins);
      console.log(
        `${name}: bounded disorder, ${String(judges.line.ticks)} judgements, ${String(heldBlocks)} blocks held back; line buckets provisional on ${String(judges.line.provisionalTicks)} judgements (${String(judges.line.mixedTicks)} beside final ones); before the last window ${String(early.orders)} orders and ${String(early.line)} line values final; no final changed; equal to line-oee.json; ${judges.report()}`,
      );
      await stack.stop();
    }, 1_800_000);

    it('shuffled with 10 % duplicates, judged every 400 deliveries (every 25 over the last 1,000): equal to line-oee.json', async () => {
      run ??= await goldenRun(name, dirs);
      const { stack, after, end } = await prepared(run, `${label}_shuffled`);
      const judges = new Judges(run);
      const next = random(231);
      const mixed = shuffle([...after, ...after.filter(() => next() < 0.1)], next);
      // Finals seen before the last delivery: the partial judging is not vacuous. Fully shuffled,
      // facts complete only near the end, so the last 1,000 are judged every 25.
      let early = { orders: 0, line: 0 };
      for (let i = 0; i < mixed.length;) {
        const step = mixed.length - i > 1_000 ? 400 : 25;
        await stack.send(mixed.slice(i, i + step));
        i += step;
        await stack.tick();
        await judges.check(stack);
        if (i < mixed.length) early = judges.finals;
      }
      expect(early.line).toBeGreaterThan(0);
      if (judges.order) expect(early.orders).toBeGreaterThan(0);
      await stack.send([end, ...mixed.slice(0, 500)]);
      await stack.tick();
      expect(await judges.expectEnd(stack)).toEqual(pins);
      console.log(
        `${name}: shuffled with 10 % duplicates, ${String(judges.line.ticks)} judgements; before the last delivery ${String(early.orders)} orders and ${String(early.line)} line values final; equal to line-oee.json; ${judges.report()}`,
      );
      await stack.stop();
    }, 1_800_000);
  });
}

// orders-01: 8 orders, 7 complete (PO-2610-009 still runs at the end), one job each; 48 hours and
// 6 shift buckets, final up to CNC-02's last fact (02:56:59Z; CNC-01 has no open job).
suite('orders-01', {
  orders: { final: 7, open: 1, jobs: 7 },
  line: { hours: 48, shifts: 6, finalHours: 47, finalShifts: 5, orders: 7, open: 1 },
});
suite('quality-01', {
  orders: { final: 6, open: 1, jobs: 6 },
  line: { hours: 48, shifts: 6, finalHours: 47, finalShifts: 5, orders: 6, open: 1 },
});
// Schedule mode: hours and shift buckets only. week-01: a week, 15 shift buckets Monday to Friday,
// final up to Saturday 03:00Z (the weekend after has no fact); alarms-01 stops mid-hour at PCK-01.
suite('week-01', {
  line: { hours: 168, shifts: 15, finalHours: 120, finalShifts: 15, orders: 0, open: 0 },
});
suite('alarms-01', {
  line: { hours: 48, shifts: 6, finalHours: 47, finalShifts: 5, orders: 0, open: 0 },
});
