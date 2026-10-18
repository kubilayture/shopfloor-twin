/**
 * The trace-performance load (#204; Phase 8 plan "Genealogy", performance target, review round 3
 * LOW; exit criterion 6): the golden harness's in-order replay of `week-01` into the database of a
 * disposable Compose project, so that project's MES and web then answer trace queries over a week.
 *
 * Skipped unless `TRACE_PERF_DATABASE_URL` is set: `e2e/src/trace-perf.ts` (`pnpm test:trace-perf`)
 * runs it with `pnpm --filter @shopfloor/mes-server exec vitest run --config vitest.e2e.config.ts
 * src/trace-perf-load.e2e.test.ts`, after the project's `migrate` step, with the URL of `mes_app`
 * on the port its Compose override publishes for that run only (`e2e/compose.trace-perf.yml`).
 * It connects as `mes_app` (ADR-0027): it writes what the MES writes, through the MES's modules,
 * and nothing it may not.
 *
 * Schedule mode, as the golden genealogy reconciliation of `week-01` (#199): every unit without an
 * order or carton, the plant's lots (`stock.yaml`). The loaded genealogy is checked against
 * `trace.json` by its counts (units, lots and the largest lot), so the measurement runs on the
 * golden week, not on whatever arrived.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadPlantConfig } from '@shopfloor/plant-config';
import { HOUR } from '@shopfloor/oee-core';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/database.ts';
import { Equipment, downtimeRules } from './modules/equipment/index.ts';
import {
  CommandSink,
  GoldenErp,
  goldenUnsMessages,
  type SimEvent,
} from './modules/equipment/golden-feed.test-support.ts';
import { PLANT_CONFIG } from './modules/equipment/test-support.ts';
import { Execution } from './modules/execution/index.ts';
import { Genealogy } from './modules/genealogy/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData, erpMasterData } from './modules/master-data/index.ts';
import { Orders } from './modules/orders/index.ts';

const url = process.env.TRACE_PERF_DATABASE_URL;
const REPO = resolve(import.meta.dirname, '../../..');
const HEADLESS = join(REPO, 'apps/simulator/src/headless/cli.ts');
const GOLDEN = join(REPO, 'apps/simulator/golden/week-01');
/** The device epoch of the loaded run (the harness's; the stack's simulator never runs). */
const EPOCH = 1_760_000_000;

interface TraceJson {
  readonly units: { readonly count: number };
  readonly lots: readonly { readonly lot: string; readonly units: readonly number[] }[];
}

describe.skipIf(url === undefined)('trace-performance load (#204)', () => {
  it('replays week-01 in order through the MES modules into the stack database as mes_app', async () => {
    const started = performance.now();
    const loaded = await loadPlantConfig(PLANT_CONFIG);
    if (!loaded.ok) throw new Error('plant config');
    const plant = loaded.config;
    const out = await mkdtemp(join(tmpdir(), 'trace-perf-'));
    try {
      await promisify(execFile)(process.execPath, [
        HEADLESS,
        '--scenario',
        'week-01',
        '--out',
        out,
      ]);
      const [header, ...rest] = (await readFile(join(out, 'events.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n');
      const span = JSON.parse(header ?? '{}') as { start: string; end: string };
      const run = {
        start: Date.parse(span.start),
        end: Date.parse(span.end),
        events: rest.map((line) => JSON.parse(line) as SimEvent),
      };
      const { facts, anchors, end } = goldenUnsMessages(run, plant, EPOCH);

      const db = createDatabase(url ?? '', 4);
      try {
        const user = (
          await db.selectNoFrom((eb) => eb.fn<string>('current_user', []).as('u')).execute()
        )[0]?.u;
        expect(user).toBe('mes_app');
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
        });
        await genealogy.start();
        for (const d of [...anchors, ...facts, end]) await ingest.deliver(d.topic, d.payload);
        for (let round = 0; round < 2; round++) {
          await orders.tick();
          await execution.tick();
          await genealogy.tick();
        }
        expect(equipment.watermark(EPOCH)).toEqual(new Date(run.end));

        // The golden week, by its counts: every unit, every lot, the largest lot's units.
        const truth = JSON.parse(await readFile(join(GOLDEN, 'trace.json'), 'utf8')) as TraceJson;
        const largest = [...truth.lots].sort((a, b) => b.units.length - a.units.length)[0];
        if (!largest) throw new Error('trace.json lists no lot');
        const lot = await genealogy.lot(largest.lot);
        const units = await db
          .selectFrom('genealogy.serial_unit')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        expect([Number(units.n), lot?.units.length]).toEqual([
          truth.units.count,
          largest.units.length,
        ]);
        expect(await genealogy.incidents()).toEqual([]);
        console.log(
          `trace-perf load: week-01, ${String(facts.length)} facts, ${units.n} units, largest lot ${largest.lot} with ${String(largest.units.length)} units, in ${String(Math.round(performance.now() - started))} ms`,
        );
        await genealogy.stop();
        await execution.stop();
        await orders.stop();
        await equipment.stop();
      } finally {
        await db.destroy();
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 900_000);
});
