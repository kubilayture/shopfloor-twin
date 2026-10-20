/**
 * The resilience suite's replay (#243; Phase 9 plan "Resilience suite", run R3, exit criterion 5):
 * after a detected loss, the MES's answers must equal the golden harness's answers on the facts the
 * MES stored, so the recovery is deterministic and nothing is corrupt.
 *
 * Skipped unless `RESILIENCE_REPLAY_DIR` is set: `e2e/src/resilience.ts` (`pnpm test:resilience`)
 * runs it with `pnpm --filter @shopfloor/mes-server exec vitest run --config
 * vitest.e2e.config.ts src/resilience-replay.e2e.test.ts` once its R3 stack is gone, with a
 * directory holding what the live MES stored and answered:
 *
 * - `facts.json`: every device fact of the run's epoch (`ingest.equipment_event`: topic, payload),
 *   in fact time and then (equipment, seq) order;
 * - `anchors.json`: every state anchor of that epoch (`ingest.state_anchor`), in arrival order, with
 *   its equipment's state topic and whether it came retained;
 * - `live.json`: the epoch, shift A's key, and the live MES's `GET /shifts/{date}/A/oee` and
 *   `GET /shifts/{date}/A/totals` answers (time per state, OEE per machine and work center with
 *   `final`, `provisionalMs`, `revision` and `incidents`).
 *
 * The golden harness's modules (ingest without a broker, equipment and OEE, as
 * `modules/equipment/reconcile.test-support.ts` wires them) take the anchors and then the facts on
 * a fresh Testcontainers database; a sweep with no grace writes off every hole, as the live MES's
 * did after its grace period; then shift A's OEE and totals must equal the live answers, field for
 * field. The comparison is written to `replay.json` in the same directory.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPlantConfig, idealCycleMs } from '@shopfloor/plant-config';
import { HOUR } from '@shopfloor/oee-core';
import { shiftInstance } from '@shopfloor/shift-calendar';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from './db/database.ts';
import { Equipment, downtimeRules } from './modules/equipment/index.ts';
import { PLANT_CONFIG, freshDatabase } from './modules/equipment/test-support.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import { Oee } from './modules/oee/index.ts';
import { shiftOeeDto } from './modules/realtime/index.ts';
import { startDatabase } from './testing.ts';

const dir = process.env.RESILIENCE_REPLAY_DIR;

interface Stored {
  readonly topic: string;
  readonly payload: string;
  readonly retained?: boolean;
}

interface Live {
  readonly epoch: number;
  /** `2026-10-12/A`. */
  readonly shiftKey: string;
  readonly oee: unknown;
  readonly totals: { readonly totals: readonly Record<string, unknown>[] };
}

const read = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(dir ?? '', name), 'utf8')) as T;

let container: StartedTestContainer | undefined;
let db: Kysely<Database> | undefined;

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

describe.skipIf(dir === undefined)('resilience replay (#243, run R3)', () => {
  it('answers on the facts the live MES stored exactly as the live MES did', async () => {
    const loaded = await loadPlantConfig(PLANT_CONFIG);
    if (!loaded.ok) throw new Error('plant config');
    const plant = loaded.config;
    const [facts, anchors, live] = await Promise.all([
      read<Stored[]>('facts.json'),
      read<Stored[]>('anchors.json'),
      read<Live>('live.json'),
    ]);
    expect(facts.length).toBeGreaterThan(0);
    expect(anchors.length).toBeGreaterThan(0);

    const started = await startDatabase();
    container = started.container;
    db = await freshDatabase(started.url, 'resilience');
    const masterData = new MasterData(db);
    await masterData.seed(plant);
    const ingest = new Ingest({
      db,
      url: 'mqtt://127.0.0.1:1',
      username: 'mes',
      password: 'unused',
      refresh: {},
      // Holes are written off by the explicit sweep below, once everything is delivered.
      gapGraceMs: 3_600_000,
      sweepIntervalMs: 0,
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
    for (const anchor of anchors) {
      await ingest.deliver(anchor.topic, anchor.payload, anchor.retained ?? false);
    }
    for (const fact of facts) await ingest.deliver(fact.topic, fact.payload);
    const recorded = await ingest.sweep(0);
    await equipment.refreshAggregates();
    await ingest.refreshAggregates();
    const oee = new Oee({
      equipment,
      ingest,
      masterData,
      shiftPattern: plant.shifts,
      config: plant.oee,
      idealCycleMs: idealCycleMs(plant),
    });
    await oee.start();

    const [date = '', shift = ''] = live.shiftKey.split('/');
    const instance = shiftInstance(plant.shifts, date, shift);
    if (!instance) throw new Error(`no shift ${live.shiftKey}`);
    const replayed = JSON.parse(
      JSON.stringify(shiftOeeDto(instance, await oee.shift(instance, live.epoch))),
    ) as unknown;
    const totals = (await equipment.shiftTotals(live.shiftKey, { epoch: live.epoch })).map(
      (row) => ({ ...row }),
    );
    const byKey = (rows: readonly Record<string, unknown>[]) =>
      [...rows]
        .map((row) => JSON.stringify(row, Object.keys(row).sort()))
        .sort()
        .map((text) => JSON.parse(text) as unknown);
    const result = {
      facts: facts.length,
      anchors: anchors.length,
      incidentsRecorded: recorded,
      oeeEqual: JSON.stringify(replayed) === JSON.stringify(live.oee),
      totalsRows: totals.length,
    };
    await writeFile(
      join(dir ?? '', 'replay.json'),
      `${JSON.stringify({ ...result, replayed, totals }, null, 2)}\n`,
    );
    expect(replayed).toEqual(live.oee);
    expect(byKey(totals)).toEqual(byKey(live.totals.totals));
  });
});
