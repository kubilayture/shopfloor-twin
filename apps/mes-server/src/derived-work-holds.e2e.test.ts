/**
 * The hold-scope budget (#238, Phase 9 plan "Derived-work costs", exit criterion 8): with 200 open
 * holds, a genealogy round's p95 plus a scope rebuild's p95 (`mes_genealogy_round_seconds`,
 * `mes_quality_hold_scope_seconds`) exceeds the round's p95 with no hold by at most 50 ms. The
 * percentiles come from the raw timings of the modules' timing hooks, not from the buckets.
 *
 * `week-01` replayed in order through ingest, equipment, orders, execution and genealogy (schedule
 * mode, as the trace-performance load), twice with the very same deliveries: once with no hold,
 * once with 200 open holds opened halfway through the week, one on every lot of the plant's
 * stock (whose scopes grow as the line consumes the lots) and the rest on serials already built
 * (spread over the units). Over the second half, delivered in chunks of 100 facts, each chunk is
 * followed by an orders, an execution and a genealogy round (timed), and in the run with holds by
 * one rebuild of every scope (timed): the MES rebuilds on a genealogy change, which a round that
 * rebuilt no unit and placed no carton doesn't raise, so a rebuild after every round is the upper
 * bound. A listener on the holds' changes, as the realtime module in the MES, keeps the cost of
 * reading the changed holds' records in the rebuild (#399). At the end every hold's copy equals its
 * scope derived from the genealogy.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HOUR } from '@shopfloor/oee-core';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase } from './testing.ts';
import { Equipment, downtimeRules } from './modules/equipment/index.ts';
import {
  CommandSink,
  GoldenErp,
  goldenUnsMessages,
  type SimEvent,
} from './modules/equipment/golden-feed.test-support.ts';
import { PLANT_CONFIG, freshDatabase, type Delivery } from './modules/equipment/test-support.ts';
import { Execution } from './modules/execution/index.ts';
import { Genealogy } from './modules/genealogy/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData, erpMasterData } from './modules/master-data/index.ts';
import { Orders } from './modules/orders/index.ts';
import { Holds } from './modules/quality/index.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const HEADLESS = join(REPO, 'apps/simulator/src/headless/cli.ts');
const EPOCH = 1_760_000_000;
const HOLDS = 200;
const CHUNK = 100;
const BUDGET_MS = 50;

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
let out: string;

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  out = await mkdtemp(join(tmpdir(), 'holds-budget-'));
}, 180_000);

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
  await container.stop();
});

const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const ms = (value: number): string => value.toFixed(1);

interface Replay {
  readonly rounds: number[];
  readonly scopes: number[];
  readonly holds: number;
  readonly units: number;
  /** Scope changes the listener heard of. */
  readonly scopeChanges: number;
}

/** The week replayed as described above; with `holds`, 200 opened halfway. */
async function replay(
  run: { start: number; end: number; events: SimEvent[] },
  withHolds: boolean,
): Promise<Replay> {
  const { facts, anchors, end } = goldenUnsMessages(run, plant, EPOCH);
  const db = await freshDatabase(serverUrl, withHolds ? 'holds_budget_200' : 'holds_budget_0');
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    refresh: {},
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
  const erp = new GoldenErp([], erpMasterData(plant).lots);
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
  let measuring = false;
  const rounds: number[] = [];
  const scopes: number[] = [];
  const genealogy = new Genealogy({
    db,
    ingest,
    execution,
    orders,
    masterData,
    erp,
    packing: plant.packing,
    tickMs: 0,
    lotPollMs: 0,
    onTiming: (t) => {
      if (measuring) rounds.push(t.seconds * 1_000);
    },
  });
  await genealogy.start();
  const holds = new Holds({
    db,
    genealogy,
    ingest,
    execution,
    orders,
    reasons: plant.quality.holdReasons,
    clock,
    epoch: () => EPOCH,
    follow: false,
    onTiming: (t) => {
      if (measuring) scopes.push(t.seconds * 1_000);
    },
  });
  await holds.start();
  // As the realtime module does in the MES: a rebuild reads the changed holds' records for it.
  let scopeChanges = 0;
  holds.onChange((change) => {
    if (change.event === 'scope') scopeChanges += 1;
  });
  orders.useCloseGuard(holds.closeGuard());
  const round = async (deliveries: readonly Delivery[]): Promise<void> => {
    for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
    await orders.tick();
    await execution.tick();
    await genealogy.tick();
    if (withHolds) await holds.tick();
  };
  try {
    for (const d of anchors) await ingest.deliver(d.topic, d.payload);
    const half = Math.floor(facts.length / 2);
    for (let i = 0; i < half; i += 2_000) await round(facts.slice(i, Math.min(i + 2_000, half)));
    if (withHolds) {
      // Every stock lot, then serials spread over the units built so far.
      const lots = erpMasterData(plant).lots.map((l) => l.id);
      const units = await db
        .selectFrom('genealogy.serial_unit')
        .select('serial')
        .where('serial', 'is not', null)
        .orderBy('epoch')
        .orderBy('part_id')
        .execute();
      const serials = units.map((u) => u.serial).filter((s): s is string => s !== null);
      const wanted = HOLDS - lots.length;
      expect(serials.length).toBeGreaterThan(wanted);
      const every = Math.floor(serials.length / wanted);
      const subjects = [
        ...lots.map((id) => ({ kind: 'lot' as const, id })),
        ...Array.from({ length: wanted }, (_, k) => ({
          kind: 'serial' as const,
          id: serials[k * every] ?? '',
        })),
      ];
      const reason = plant.quality.holdReasons.find((r) => r.for.includes('open'))?.id ?? '';
      const openedAt = clock();
      await db
        .insertInto('quality.hold')
        .values(
          subjects.map((subject) => ({
            id: randomUUID(),
            subject_kind: subject.kind,
            subject_id: subject.id,
            state: 'open' as const,
            reason,
            opened_by: 'budget',
            opened_plant_at: openedAt,
            opened_epoch: EPOCH,
            decided_by: null,
            decided_at: null,
            decided_plant_at: null,
            decided_epoch: null,
            decision_reason: null,
          })),
        )
        .execute();
      // The first rebuild fills every copy: an opening's cost, not a round's.
      await holds.tick();
    }
    measuring = true;
    for (let i = half; i < facts.length; i += CHUNK) await round(facts.slice(i, i + CHUNK));
    measuring = false;
    await round([end]);
    // Every copy equals its scope derived from the genealogy now.
    const open = await db.selectFrom('quality.hold').selectAll().execute();
    let held = 0;
    for (const hold of open) {
      const scope = await genealogy.scope({ kind: hold.subject_kind, id: hold.subject_id });
      const copy = await db
        .selectFrom('quality.hold_unit')
        .select(['epoch', 'part_id', 'serial', 'order_id', 'carton_id'])
        .where('hold_id', '=', hold.id)
        .orderBy('epoch')
        .orderBy('part_id')
        .execute();
      expect(copy.map((u) => [u.epoch, u.part_id, u.serial, u.order_id, u.carton_id])).toEqual(
        scope.map((u) => [u.epoch, u.partId, u.serial, u.orderId, u.carton]),
      );
      held += copy.length;
    }
    return { rounds, scopes, holds: open.length, units: held, scopeChanges };
  } finally {
    await holds.stop();
    await genealogy.stop();
    await execution.stop();
    await orders.stop();
    await equipment.stop();
    await ingest.stop();
    await db.destroy();
  }
}

describe('derived-work budgets: hold scopes on change (#238)', () => {
  it(`with ${String(HOLDS)} open holds a genealogy round adds ≤ ${String(BUDGET_MS)} ms (round p95 + scope rebuild p95 against the round p95 with no hold)`, async () => {
    await promisify(execFile)(process.execPath, [HEADLESS, '--scenario', 'week-01', '--out', out]);
    const [header, ...rest] = (await readFile(join(out, 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n');
    const span = JSON.parse(header ?? '{}') as { start: string; end: string };
    const run = {
      start: Date.parse(span.start),
      end: Date.parse(span.end),
      events: rest.map((line) => JSON.parse(line) as SimEvent),
    };
    const none = await replay(run, false);
    const some = await replay(run, true);
    expect(some.holds).toBe(HOLDS);
    expect(some.rounds).toHaveLength(none.rounds.length);
    expect(some.scopes).toHaveLength(some.rounds.length);
    expect(some.scopeChanges).toBeGreaterThan(0);
    const base = quantile(none.rounds, 0.95);
    const round = quantile(some.rounds, 0.95);
    const scope = quantile(some.scopes, 0.95);
    const added = round + scope - base;
    console.log(
      `#238 holds: ${String(none.rounds.length)} rounds over the second half of week-01; no hold: mes_genealogy_round_seconds p50 ${ms(quantile(none.rounds, 0.5))} ms, p95 ${ms(base)} ms; ` +
        `${String(HOLDS)} open holds (${String(some.units)} units held at the end): round p50 ${ms(quantile(some.rounds, 0.5))} ms, p95 ${ms(round)} ms, ` +
        `mes_quality_hold_scope_seconds p50 ${ms(quantile(some.scopes, 0.5))} ms, p95 ${ms(scope)} ms, max ${ms(Math.max(...some.scopes))} ms (${String(some.scopeChanges)} scope changes heard); added ${ms(added)} ms (budget ${String(BUDGET_MS)} ms)`,
    );
    expect(added).toBeLessThanOrEqual(BUDGET_MS);
  }, 1_800_000);
});
