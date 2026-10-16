import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cycleHourly,
  cycleHourlyRaw,
  stateHourly,
  stateHourlyRaw,
} from '../../db/aggregates.test-support.ts';
import type { Database } from '../../db/database.ts';
import { startDatabase } from '../../testing.ts';
import { Ingest, type IngestNotice } from '../ingest/index.ts';
import { MasterData } from '../master-data/index.ts';
import { Equipment, type PiecesChanged } from './index.ts';
import { PLANT_CONFIG, UnsFeed, freshDatabase, type Delivery } from './test-support.ts';

const E1 = 1_760_000_000;
const E2 = 1_760_003_600;
/** Refreshes run only when a test asks (`refreshAggregates`); the debounce has its own test. */
const MANUAL = { debounceMs: 600_000 };

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
}, 180_000);

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

afterAll(async () => {
  await container.stop();
});

/** Monday 2026-10-12 at a UTC time; Istanbul is UTC+3. */
const at = (time: string): number => Date.parse(`2026-10-12T${time}:00.000Z`);
const hour = (time: string): Date => new Date(at(time));
const feed = new UnsFeed(new Map());

async function setup() {
  const db = await freshDatabase(serverUrl, 'aggregates');
  cleanup.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const shiftPattern = await masterData.shiftPattern();
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    refresh: MANUAL,
  });
  cleanup.push(() => ingest.stop());
  const start = async (): Promise<Equipment> => {
    const equipment = new Equipment({
      db,
      source: ingest,
      shiftPattern,
      provisionalStepMs: 0,
      refresh: MANUAL,
    });
    await equipment.start();
    cleanup.push(() => equipment.stop());
    // The start-up catch-up refresh runs in the background: done before the test goes on.
    await equipment.refreshAggregates();
    return equipment;
  };
  const send = async (...deliveries: Delivery[]): Promise<void> => {
    for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
  };
  return { db, ingest, start, send };
}

/** Both aggregates read exactly what the raw rows say. */
async function expectCurrent(db: Kysely<Database>): Promise<void> {
  expect(await stateHourly(db)).toEqual(await stateHourlyRaw(db));
  expect(await cycleHourly(db)).toEqual(await cycleHourlyRaw(db));
}

/** `stateHourly` of one equipment, compactly: [hour, state, minutes, final, revision]. */
async function hoursOf(equipment: Equipment, id: string, epoch = E1) {
  const rows = await equipment.stateHourly(hour('00:00'), hour('23:00'), { equipment: id, epoch });
  return rows.map((r) => [
    r.hour.toISOString().slice(11, 16),
    r.state,
    r.ms / 60_000,
    r.final,
    r.revision,
  ]);
}

describe('hourly aggregates (#118)', () => {
  it('stays equal to the raw rows through a late fact, an unrefreshed earlier hour and an earlier epoch', async () => {
    const { db, ingest, start, send } = await setup();
    const equipment = await start();
    const changes: PiecesChanged[] = [];
    equipment.onPiecesChanged((change) => changes.push(change));
    const notices: IngestNotice['type'][] = [];
    ingest.onStored((notice) => {
      notices.push(notice.type);
    });
    await send(
      // cnc-a misses seq 2: none of its hours is final yet.
      feed.state('cnc-a', E1, 1, at('10:10'), 'Running'),
      feed.state('cnc-a', E1, 3, at('11:20'), 'Idle'),
      feed.cycle('cnc-a', E1, 4, at('12:30')),
      // cnc-b reports through 13:10: its hours 10 to 12 are final.
      feed.state('cnc-b', E1, 1, at('10:00'), 'Running'),
      feed.cycle('cnc-b', E1, 2, at('10:30')),
      feed.cycle('cnc-b', E1, 3, at('11:30'), {
        product: 'VB-200',
        partId: 3,
        serial: 'S-3',
        result: 'scrap',
      }),
      feed.cycle('cnc-b', E1, 4, at('12:30')),
      feed.cycle('cnc-b', E1, 5, at('13:10')),
    );
    expect(notices.filter((type) => type === 'cycle')).toHaveLength(5);
    expect(notices.filter((type) => type === 'epoch')).toHaveLength(2);
    expect(changes.length).toBeGreaterThan(0);
    // Pieces are written as they come; nothing is refreshed on the acknowledgement path.
    expect(equipment.stateAggregate()).toEqual({ refreshedThrough: null, dirty: [], refreshes: 0 });
    // Unrefreshed, the aggregates read everything raw.
    await expectCurrent(db);
    await equipment.refreshAggregates();
    await ingest.refreshAggregates();
    // Refreshed up to the latest final hour: 13:00 is cnc-b's open hour, read raw.
    expect(equipment.stateAggregate()).toMatchObject({ refreshedThrough: hour('13:00') });
    expect(ingest.cycleAggregate()).toMatchObject({ refreshedThrough: hour('13:00') });
    await expectCurrent(db);
    expect(await hoursOf(equipment, 'cnc-b')).toEqual([
      ['10:00', 'Running', 60, true, 0],
      ['11:00', 'Running', 60, true, 0],
      ['12:00', 'Running', 60, true, 0],
      ['13:00', 'Running', 10, false, 0],
    ]);
    expect([hour('12:00'), hour('13:00')].map((h) => ingest.cyclesRefreshed(h))).toEqual([
      true,
      false,
    ]);
    expect(
      (await ingest.cycleHourly(hour('11:00'), hour('12:00'), { equipment: 'cnc-b' })).map(
        (row) => [row.product, row.result, row.count],
      ),
    ).toEqual([['VB-200', 'scrap', 1]]);
    expect((await hoursOf(equipment, 'cnc-a')).every(([, , , final]) => final === false)).toBe(
      true,
    );

    // The late seq 2 changes cnc-a's materialised hours 10 and 11 (below the watermark): they are
    // dirty, and stale until the next refresh.
    await send(feed.state('cnc-a', E1, 2, at('10:40'), 'Down', 'X'));
    expect(equipment.stateAggregate()?.dirty).toEqual([hour('10:00'), hour('11:00')]);
    expect(await stateHourly(db)).not.toEqual(await stateHourlyRaw(db));
    expect((await hoursOf(equipment, 'cnc-a')).slice(0, 2)).toEqual([
      ['10:00', 'Running', 50, false, 0],
      ['11:00', 'Idle', 40, false, 0],
    ]);
    await equipment.refreshAggregates();
    await expectCurrent(db);
    expect(await hoursOf(equipment, 'cnc-a')).toEqual([
      ['10:00', 'Down', 20, true, 0],
      ['10:00', 'Running', 30, true, 0],
      ['11:00', 'Down', 20, true, 0],
      ['11:00', 'Idle', 40, true, 0],
      ['12:00', 'Idle', 60, false, 0],
      ['13:00', 'Idle', 10, false, 0],
    ]);

    // A new run whose clock lies below the watermark: its hours were never refreshed, so the
    // aggregate doesn't show them until a refresh covers them.
    await send(
      feed.state('cnc-c', E2, 1, at('07:00'), 'Running'),
      feed.cycle('cnc-c', E2, 2, at('07:30')),
      feed.cycle('cnc-c', E2, 3, at('08:15')),
    );
    expect(equipment.stateAggregate()?.dirty).toEqual([hour('07:00'), hour('08:00')]);
    expect(ingest.cycleAggregate()?.dirty).toEqual([hour('07:00'), hour('08:00')]);
    expect((await stateHourly(db)).filter((row) => row.equipment === 'cnc-c')).toEqual([]);
    await equipment.refreshAggregates();
    await ingest.refreshAggregates();
    await expectCurrent(db);
    expect(await hoursOf(equipment, 'cnc-c', E2)).toEqual([
      ['07:00', 'Running', 60, true, 0],
      ['08:00', 'Running', 15, false, 0],
    ]);

    // The open hour above the watermark is read raw, with no refresh.
    await send(feed.cycle('cnc-b', E1, 6, at('13:40')));
    expect(equipment.stateAggregate()?.dirty).toEqual([]);
    expect(ingest.cycleAggregate()?.dirty).toEqual([]);
    await expectCurrent(db);
    expect((await hoursOf(equipment, 'cnc-b')).at(-1)).toEqual(['13:00', 'Running', 40, false, 0]);

    // Σ hours = shift, per (equipment, epoch, state), for every shift bucket.
    const rows = await equipment.stateHourly(hour('00:00'), hour('23:00'));
    for (const shiftKey of new Set(rows.map((row) => row.shiftKey))) {
      const sums = new Map<string, number>();
      for (const row of rows.filter((r) => r.shiftKey === shiftKey)) {
        const key = `${row.equipment} ${String(row.epoch)} ${row.state}`;
        sums.set(key, (sums.get(key) ?? 0) + row.ms);
      }
      const totals = await equipment.shiftTotals(shiftKey);
      expect(Object.fromEntries(sums)).toEqual(
        Object.fromEntries(
          totals.map((t) => [`${t.equipment} ${String(t.epoch)} ${t.state}`, t.ms]),
        ),
      );
    }
  });

  it('catches up at a restart and revises a final hour whose cycle count changed unheard', async () => {
    const { db, ingest, start, send } = await setup();
    let equipment = await start();
    await send(
      feed.state('cnc-a', E1, 1, at('10:10'), 'Running'),
      feed.cycle('cnc-a', E1, 2, at('10:30')),
      feed.cycle('cnc-a', E1, 3, at('11:20')),
    );
    await equipment.refreshAggregates();
    await ingest.refreshAggregates();
    const finality = () =>
      db
        .selectFrom('equipment.bucket_finality')
        .select(['hour', 'cycles', 'revision'])
        .where('equipment', '=', 'cnc-a')
        .orderBy('hour')
        .execute();
    expect(await finality()).toMatchObject([{ hour: hour('10:00'), cycles: 1, revision: 0 }]);
    // A cycle the module hears of in a final hour revises it and is counted.
    await send(feed.cycle('cnc-a', E1, 4, at('10:40')));
    expect(await finality()).toMatchObject([{ hour: hour('10:00'), cycles: 2, revision: 1 }]);

    // While the module is down, a late cycle and a late state fact are stored unheard (a notice
    // missed: the case ADR-0018's amendment leaves to #118).
    await equipment.stop();
    await send(
      feed.cycle('cnc-a', E1, 5, at('10:50')),
      feed.state('cnc-a', E1, 6, at('11:40'), 'Idle'),
    );
    expect(await finality()).toMatchObject([{ cycles: 2, revision: 1 }]);
    equipment = await start();
    // Start-up compares the counts with cycle_hourly: hour 10 changed, so its revision goes up.
    expect(await finality()).toMatchObject([{ hour: hour('10:00'), cycles: 3, revision: 2 }]);
    // The catch-up refresh also covers the pieces the restart recomputed.
    await equipment.refreshAggregates();
    await ingest.refreshAggregates();
    await expectCurrent(db);
    expect(equipment.stateAggregate()).toMatchObject({ dirty: [] });
    // A further restart finds nothing to revise.
    await equipment.stop();
    equipment = await start();
    expect(await finality()).toMatchObject([{ cycles: 3, revision: 2 }]);
    // Hours recorded before migration 0006 (no count) get theirs, without a revision.
    await equipment.stop();
    await db.updateTable('equipment.bucket_finality').set({ cycles: null }).execute();
    await start();
    expect(await finality()).toMatchObject([{ cycles: 3, revision: 2 }]);
  });
});
