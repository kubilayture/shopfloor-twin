import { resolve } from 'node:path';
import { HOUR } from '@shopfloor/oee-core';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase } from '../testing.ts';
import { AggregateRefresher, type RefreshWindow } from './aggregate-refresh.ts';
import { stateHourly, stateHourlyRaw } from './aggregates.test-support.ts';
import { createDatabase, type Database } from './database.ts';
import { migrate } from './migrate.ts';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../db/migrations');
const VIEW = 'equipment.state_hourly';
const E1 = 1_760_000_000;
const E2 = 1_760_900_000;
const MINUTE = 60_000;
/** Monday 2026-10-12 00:00 UTC. */
const MONDAY = Date.parse('2026-10-12T00:00:00Z');

let container: StartedTestContainer;
let url: string;
const databases: Kysely<Database>[] = [];
const refreshers: AggregateRefresher[] = [];
let count = 0;

beforeAll(async () => {
  ({ url, container } = await startDatabase());
}, 180_000);

afterAll(async () => {
  for (const refresher of refreshers) await refresher.stop();
  for (const db of databases) await db.destroy();
  await container.stop();
});

async function freshDatabase(): Promise<Kysely<Database>> {
  const admin = createDatabase(url, 1);
  const name = `refresh_${String(++count)}`;
  await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
  await admin.destroy();
  const db = createDatabase(url.replace(/\/shopfloor$/, `/${name}`), 3);
  databases.push(db);
  await migrate(db, MIGRATIONS);
  return db;
}

function refresher(db: Kysely<Database>, debounceMs = 1_000): AggregateRefresher {
  const result = new AggregateRefresher(VIEW, db, debounceMs);
  refreshers.push(result);
  return result;
}

/**
 * Pieces of `step` ms for each machine over [from, to), cut at hours (the step divides an hour),
 * written straight into the table: Running and Idle in turn, the first hour's pieces provisional.
 */
async function insertPieces(
  db: Kysely<Database>,
  options: { machines: number; epoch: number; from: number; to: number; step: number },
): Promise<void> {
  await sql`
    INSERT INTO equipment.equipment_state_interval
      (equipment, epoch, start_time, end_time, state, cause, hour, shift_key, provisional,
       interval_start, start_seq)
    SELECT 'm-' || m, ${options.epoch}, t, t + ${`${String(options.step)} milliseconds`}::interval,
      CASE WHEN (extract(epoch FROM t)::bigint / 60) % 2 = 0 THEN 'Running' ELSE 'Idle' END, NULL,
      date_trunc('hour', t, 'UTC'), 'shift', t < ${new Date(options.from + HOUR)}, t, NULL
    FROM generate_series(1, ${options.machines}) AS m,
      generate_series(${new Date(options.from)}::timestamptz,
        ${new Date(options.to - options.step)}::timestamptz,
        ${`${String(options.step)} milliseconds`}::interval) AS t`.execute(db);
}

const hour = (n: number): number => MONDAY + n * HOUR;

describe('explicit refresh of an hourly aggregate (#118, ADR-0022)', () => {
  it('debounces: a burst of changes is one refresh, a second of wall time after the first', async () => {
    const db = await freshDatabase();
    const r = refresher(db);
    await r.catchUp();
    const windows: RefreshWindow[] = [];
    r.onRefresh((window) => windows.push(window));
    await insertPieces(db, { machines: 2, epoch: E1, from: hour(10), to: hour(12), step: MINUTE });
    const began = Date.now();
    for (let i = 0; i < 50; i++) {
      r.changed(hour(10) + i * MINUTE, hour(10) + i * MINUTE + 1);
      r.through(hour(11));
    }
    // Nothing runs on the caller's path.
    expect(r.status()).toMatchObject({ refreshes: 0 });
    for (let waited = 0; windows.length === 0 && waited < 30_000; waited += 20) {
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(Date.now() - began).toBeGreaterThanOrEqual(950);
    await new Promise((done) => setTimeout(done, 400));
    expect(windows.map((w) => [w.start, w.end])).toEqual([[null, new Date(hour(11))]]);
    // Hour 10 is materialised, hour 11 (the open hour, above the watermark) read raw.
    expect(r.isRefreshed(hour(10))).toBe(true);
    expect(r.isRefreshed(hour(11))).toBe(false);
    expect(await stateHourly(db)).toEqual(await stateHourlyRaw(db));
  });

  it('marks a change below the watermark dirty: a never-refreshed earlier hour would vanish', async () => {
    const db = await freshDatabase();
    const r = refresher(db, 60_000);
    await insertPieces(db, { machines: 2, epoch: E1, from: hour(10), to: hour(13), step: MINUTE });
    r.through(hour(12));
    await r.flush();
    expect(r.status()).toMatchObject({ refreshedThrough: new Date(hour(12)), dirty: [] });
    expect(await stateHourly(db)).toEqual(await stateHourlyRaw(db));

    // A machine whose first pieces lie below the watermark (hour 8, never refreshed): TimescaleDB
    // reads that hour from the materialisation only, where it isn't, so it is missing.
    await insertPieces(db, { machines: 1, epoch: E1, from: hour(8), to: hour(9), step: MINUTE });
    const hidden = await stateHourly(db);
    expect(hidden.some((row) => row.hour.startsWith('2026-10-12T08'))).toBe(false);
    r.changed(hour(8), hour(9));
    expect(r.status().dirty).toEqual([new Date(hour(8))]);
    expect(r.isRefreshed(hour(8))).toBe(false);
    await r.flush();
    expect(await stateHourly(db)).toEqual(await stateHourlyRaw(db));
    expect(r.isRefreshed(hour(8))).toBe(true);

    // A late change of a materialised hour (pieces made final) is stale until refreshed.
    await db
      .updateTable('equipment.equipment_state_interval')
      .set({ provisional: false })
      .where('hour', '=', new Date(hour(10)))
      .execute();
    expect(await stateHourly(db)).not.toEqual(await stateHourlyRaw(db));
    r.changed(hour(10), hour(11));
    // A change above the watermark (the open hour) is read raw: nothing to refresh.
    r.changed(hour(12), hour(13));
    expect(r.status().dirty).toEqual([new Date(hour(10))]);
    await r.flush();
    expect(await stateHourly(db)).toEqual(await stateHourlyRaw(db));
    expect(r.status()).toMatchObject({ refreshedThrough: new Date(hour(12)), dirty: [] });
  });

  it('catches up at start-up: changes made before a restart, never reported, are materialised', async () => {
    const db = await freshDatabase();
    const before = refresher(db, 60_000);
    await insertPieces(db, { machines: 3, epoch: E1, from: hour(5), to: hour(15), step: MINUTE });
    before.through(hour(14));
    await before.flush();
    await before.stop();
    // Written while no refresher listened (a crash between the commit and the refresh).
    await db
      .deleteFrom('equipment.equipment_state_interval')
      .where('equipment', '=', 'm-2')
      .where('hour', '<', new Date(hour(9)))
      .execute();
    await insertPieces(db, { machines: 1, epoch: E2, from: hour(2), to: hour(4), step: MINUTE });
    expect(await stateHourly(db)).not.toEqual(await stateHourlyRaw(db));

    const after = refresher(db, 60_000);
    expect(after.status().refreshedThrough).toBeNull();
    expect(after.isRefreshed(hour(6))).toBe(false);
    await after.catchUp();
    expect(await stateHourly(db)).toEqual(await stateHourlyRaw(db));
    expect(after.status()).toMatchObject({ refreshedThrough: new Date(hour(14)), dirty: [] });
    expect(after.isRefreshed(hour(6))).toBe(true);
  });

  it('retries a failing refresh with backoff; flush gives up after five attempts, then recovers', async () => {
    const admin = createDatabase(url, 1);
    const name = `refresh_${String(++count)}`;
    await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
    await admin.destroy();
    // Not migrated yet: the aggregate doesn't exist, as during a failed deploy.
    const db = createDatabase(url.replace(/\/shopfloor$/, `/${name}`), 3);
    databases.push(db);
    const r = refresher(db, 60_000);
    await expect(r.flush()).rejects.toThrow(/no continuous aggregate|does not exist/);
    expect(r.status()).toMatchObject({ refreshedThrough: null, failures: 5 });
    await migrate(db, MIGRATIONS);
    await r.flush();
    expect(r.status()).toMatchObject({ failures: 0 });
  });

  it('refreshes quickly after an epoch that starts days below the watermark', async () => {
    const db = await freshDatabase();
    const r = refresher(db, 60_000);
    const windows: RefreshWindow[] = [];
    r.onRefresh((window) => windows.push(window));
    // A week of six machines, a piece every minute (60,480 pieces), materialised once.
    const end = MONDAY + 7 * 24 * HOUR;
    await insertPieces(db, { machines: 6, epoch: E1, from: MONDAY, to: end, step: MINUTE });
    r.through(end);
    await r.flush();
    // A new run whose clock lies five days back: its first hour is far below the watermark.
    const start = end - 5 * 24 * HOUR;
    await insertPieces(db, { machines: 6, epoch: E2, from: start, to: start + HOUR, step: MINUTE });
    r.changed(start, start + HOUR);
    await r.flush();
    const [full, incremental] = windows;
    // The window spans five days, but only the invalidated hour is materialised again.
    expect([incremental?.start, incremental?.end]).toEqual([new Date(start), new Date(end)]);
    console.info(
      `state_hourly refresh: whole week ${String(full?.ms)} ms; after a new epoch 5 days below the watermark ${String(incremental?.ms)} ms`,
    );
    expect(incremental?.ms).toBeLessThan(Math.max(1_000, (full?.ms ?? 0) / 4));
    expect(await stateHourly(db)).toEqual(await stateHourlyRaw(db));
  });
});
