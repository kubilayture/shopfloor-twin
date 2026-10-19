/**
 * Golden order OEE reconciliation (#231, P9-04; Phase 9 plan exit criterion 1): the headless
 * simulator runs `orders-01` and `quality-01` as a process; its event log becomes the UNS facts the
 * gateway would publish and goes through ingest's store path into TimescaleDB, where the equipment,
 * orders and execution modules keep the CNCs' states, the command state and the units, and the
 * `oee` module derives every order's OEE, job breakdown and first-pass yield. They must equal
 * `line-oee.json`'s orders section, delivered three ways (in order, in bounded disorder, shuffled
 * with 10 % duplicates), judged on partial data all along: whatever the MES calls final must
 * already be the truth's and stay final and unchanged (`Judge`), and with every fact in, every
 * order the truth completed is final and equal, the one still open is open.
 *
 * The command state, `notBefore` included, is seeded from the run header's `dispatches` (a golden
 * log carries no MES dispatch): dispatched at the idle start, after the machines' first facts.
 */
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase } from './testing.ts';
import { PLANT_CONFIG, random, shuffle, type Delivery } from './modules/equipment/test-support.ts';
import {
  Judge,
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
  /** Orders the truth completed: final in the MES and equal. */
  readonly final: number;
  /** Orders still open at the run's end. */
  readonly open: number;
  /** Jobs of the completed orders. */
  readonly jobs: number;
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
  describe(`golden order OEE: ${name} (#231)`, () => {
    let run: GoldenRun | undefined;
    const label = name.replace('-', '_');

    it('in order, judged every 150 facts: final orders equal line-oee.json', async () => {
      run = await goldenRun(name, dirs);
      expect(Object.keys(run.orders).length).toBe(pins.final + pins.open);
      const { stack, after, end } = await prepared(run, `${label}_order`);
      const judge = new Judge(run);
      for (let i = 0; i < after.length; i += 150) {
        await stack.send(after.slice(i, i + 150));
        await stack.tick();
        await judge.check(stack);
      }
      await stack.send([end]);
      await stack.tick();
      expect(await judge.expectEnd(stack)).toEqual(pins);
      // In order, finality follows the facts: orders are final long before the end.
      expect(judge.mixedTicks).toBeGreaterThan(0);
      console.log(
        `${name}: in order, ${String(judge.ticks)} judgements (${String(judge.mixedTicks)} with final and provisional orders side by side); ${String(pins.final)} orders and ${String(pins.jobs)} jobs final and equal to line-oee.json, ${String(pins.open)} open; derived reads p95 ${judge.p95.toFixed(1)} ms over ${String(judge.reads.length)}`,
      );
      await stack.stop();
    }, 600_000);

    it('bounded disorder, blocks held back: provisional on partial data, no final order changed', async () => {
      // As the SPC replay (#200 review H2): windows of 120–240 facts, each shuffled and delivered
      // in chunks of 40–80 with a judgement after each; now and then a block of 40–80 held back
      // for 2–5 windows and single facts for 1–3, so gaps keep later facts provisional while
      // orders complete on either side of them. A third of the judgements run before the
      // execution module's round, so the units (the OP10 cycles' attribution) lag the facts.
      run ??= await goldenRun(name, dirs);
      const truth = run;
      const { stack, after, end } = await prepared(truth, `${label}_bounded`);
      const judge = new Judge(truth);
      const next = random(2_310);
      const held: { block: Delivery[]; release: number }[] = [];
      let heldBlocks = 0;
      let windows = 0;
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
          await judge.check(stack);
        }
      }
      await stack.send([end]);
      await stack.tick();
      expect(heldBlocks).toBeGreaterThan(0);
      expect(judge.provisionalTicks).toBeGreaterThan(0);
      expect(judge.mixedTicks).toBeGreaterThan(0);
      expect(await judge.expectEnd(stack)).toEqual(pins);
      console.log(
        `${name}: bounded disorder, ${String(judge.ticks)} judgements, ${String(heldBlocks)} blocks held back; provisional orders on ${String(judge.provisionalTicks)} judgements (${String(judge.mixedTicks)} beside final ones), no final order changed; equal to line-oee.json`,
      );
      await stack.stop();
    }, 900_000);

    it('shuffled with 10 % duplicates, judged every 400 deliveries (every 25 over the last 1,000): equal to line-oee.json', async () => {
      run ??= await goldenRun(name, dirs);
      const { stack, after, end } = await prepared(run, `${label}_shuffled`);
      const judge = new Judge(run);
      const next = random(231);
      const mixed = shuffle([...after, ...after.filter(() => next() < 0.1)], next);
      // Finals seen before the last delivery: the partial judging is not vacuous. Fully shuffled,
      // an order's facts complete only near the end, so the last 1,000 are judged every 25.
      let earlyFinals = 0;
      for (let i = 0; i < mixed.length;) {
        const step = mixed.length - i > 1_000 ? 400 : 25;
        await stack.send(mixed.slice(i, i + step));
        i += step;
        await stack.tick();
        await judge.check(stack);
        if (i < mixed.length) earlyFinals = judge.finals;
      }
      expect(earlyFinals).toBeGreaterThan(0);
      await stack.send([end, ...mixed.slice(0, 500)]);
      await stack.tick();
      expect(await judge.expectEnd(stack)).toEqual(pins);
      console.log(
        `${name}: shuffled with 10 % duplicates, ${String(judge.ticks)} judgements, ${String(earlyFinals)} orders final before the last delivery; equal to line-oee.json`,
      );
      await stack.stop();
    }, 900_000);
  });
}

// orders-01: 8 orders, 7 complete (PO-2610-009 still runs at the end), one job each.
suite('orders-01', { final: 7, open: 1, jobs: 7 });
suite('quality-01', { final: 6, open: 1, jobs: 6 });
