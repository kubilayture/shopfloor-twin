import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../env.ts';
import { buildMesHttp } from '../http.ts';
import { startDatabase } from '../testing.ts';
import { DECLARED_COLUMNS, actualColumns, actualTables } from './columns.ts';
import { DATA_MODEL_FILE, generateDataModel } from './data-model.ts';
import { createDatabase, type Database } from './database.ts';
import { migrate, readMigrations } from './migrate.ts';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../db/migrations');
let container: StartedTestContainer;
let url: string;
const databases: Kysely<Database>[] = [];

function database(): Kysely<Database> {
  const db = createDatabase(url, 3);
  databases.push(db);
  return db;
}

let admin: Kysely<Database> | undefined;

/** A fresh database on the same server, so tests don't share migration state. */
async function freshDatabase(name: string): Promise<Kysely<Database>> {
  // One pool creates them all: the server allows only so many connections.
  admin ??= database();
  await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
  const db = createDatabase(url.replace(/\/shopfloor$/, `/${name}`), 3);
  databases.push(db);
  return db;
}

/** A copy of the migrations, those numbered up to `upTo` only when given. */
async function copyOfMigrations(upTo = Infinity): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
  for (const name of await readdir(MIGRATIONS)) {
    if (Number(name.slice(0, 4)) <= upTo) await copyFile(join(MIGRATIONS, name), join(dir, name));
  }
  return dir;
}

beforeAll(async () => {
  ({ url, container } = await startDatabase());
}, 180_000);

afterAll(async () => {
  for (const db of databases) await db.destroy();
  await container.stop();
});

describe('migrations (ADR-0016)', () => {
  it('applies every migration once, in order, and nothing on a second run', async () => {
    const db = await freshDatabase('m_once');
    const names = (await readMigrations(MIGRATIONS)).map((m) => m.name);
    expect(await migrate(db, MIGRATIONS)).toEqual({ applied: names, skipped: 0 });
    expect(await migrate(db, MIGRATIONS)).toEqual({ applied: [], skipped: names.length });
    const schemas = await sql<{ nspname: string }>`
      SELECT nspname FROM pg_namespace WHERE nspname IN ('master_data', 'ingest', 'equipment')
      ORDER BY nspname`.execute(db);
    expect(schemas.rows.map((r) => r.nspname)).toEqual(['equipment', 'ingest', 'master_data']);
    const extension = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension WHERE extname = 'timescaledb'`.execute(db);
    expect(extension.rows).toHaveLength(1);
  });

  it('lets concurrent instances race safely: each migration is applied exactly once', async () => {
    const name = 'm_race';
    await freshDatabase(name);
    const target = url.replace(/\/shopfloor$/, `/${name}`);
    const results = await Promise.all(
      [1, 2, 3].map(() => {
        const db = createDatabase(target, 2);
        databases.push(db);
        return migrate(db, MIGRATIONS);
      }),
    );
    const applied = results.flatMap((r) => r.applied);
    expect(applied.sort()).toEqual((await readMigrations(MIGRATIONS)).map((m) => m.name).sort());
  });

  it('refuses to start when an applied migration changed, or when the database is newer', async () => {
    const db = await freshDatabase('m_changed');
    const dir = await copyOfMigrations();
    try {
      await migrate(db, dir);
      const [first] = (await readdir(dir)).sort();
      if (!first) throw new Error('no migration');
      await writeFile(join(dir, first), '-- edited after the fact\n', { flag: 'a' });
      await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/);
      await rm(join(dir, first));
      await expect(migrate(db, dir)).rejects.toThrow(/which this version doesn't know/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects badly named or duplicate-numbered migration files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-bad-'));
    try {
      await writeFile(join(dir, '1_too_short.sql'), 'SELECT 1;');
      await expect(readMigrations(dir)).rejects.toThrow(/not allowed/);
      await rm(join(dir, '1_too_short.sql'));
      await writeFile(join(dir, '0001_a.sql'), 'SELECT 1;');
      await writeFile(join(dir, '0001_b.sql'), 'SELECT 1;');
      await expect(readMigrations(dir)).rejects.toThrow(/two migrations numbered 0001/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs a file marked no-transaction outside a transaction, and refuses transaction control in files', async () => {
    const db = await freshDatabase('m_notx');
    const dir = await copyOfMigrations();
    try {
      await writeFile(
        join(dir, '9000_ingest_index.sql'),
        '-- migrate:no-transaction\nCREATE TABLE IF NOT EXISTS ingest.t (x int);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_x ON ingest.t (x);\n',
      );
      const result = await migrate(db, dir);
      expect(result.applied).toContain('9000_ingest_index.sql');
      await writeFile(
        join(dir, '9001_public_sneaky.sql'),
        'COMMIT;\nCREATE TABLE public.u (x int);\n',
      );
      await expect(migrate(db, dir)).rejects.toThrow(/transaction control belongs to the runner/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes the checksum over LF text, so a CRLF checkout is not an edited file', async () => {
    const db = await freshDatabase('m_crlf');
    const dir = await copyOfMigrations();
    try {
      await migrate(db, dir);
      for (const name of await readdir(dir)) {
        const text = await readFile(join(dir, name), 'utf8');
        await writeFile(join(dir, name), `\uFEFF${text.replace(/\n/g, '\r\n')}`);
      }
      expect((await migrate(db, dir)).applied).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills content_at_final of reports already final from the note audit (0015, #163)', async () => {
    const db = await freshDatabase('m_content_at_final');
    // Up to 0014: the note audit is still written then (0018 freezes it).
    const dir = await copyOfMigrations(14);
    const file = '0015_shifts_content_at_final.sql';
    try {
      const text = await readFile(join(MIGRATIONS, file), 'utf8');
      await migrate(db, dir);
      const instance = (key: string, status: string, finalAt: string | null, content: number) =>
        sql`INSERT INTO shifts.shift_instance (epoch, shift_key, shift_date, shift_id, start_time,
              end_time, breaks, status, final_at, content_revision)
            VALUES (1, ${key}, '2026-10-12', ${key.slice(-1)}, '2026-10-12T03:00Z',
              '2026-10-12T11:00Z', '[]', ${status}, ${finalAt}, ${content})`.execute(db);
      // A: final at 12:00 with two note writes before and one after (content 3, a recode too: 4).
      await instance('2026-10-12/A', 'final', '2026-10-12T12:00Z', 4);
      // B: not final.
      await instance('2026-10-12/B', 'ended', null, 1);
      const note = await sql<{ id: number }>`
        INSERT INTO shifts.handover_note (epoch, shift_key, category, text, created_by, author,
          created_plant_at, updated_plant_at)
        VALUES (1, '2026-10-12/A', 'general', 'x', 'a', 'a', '2026-10-12T11:00Z',
          '2026-10-12T11:00Z')
        RETURNING id`.execute(db);
      const id = note.rows[0]?.id ?? 0;
      for (const [at, version] of [
        ['2026-10-12T11:10Z', 1],
        ['2026-10-12T11:20Z', 2],
        ['2026-10-12T12:10Z', 3],
      ] as const) {
        await sql`INSERT INTO shifts.handover_audit (note_id, epoch, shift_key, action, before,
            after, actor, at, plant_at, version)
          VALUES (${id}, 1, '2026-10-12/A', ${version === 1 ? 'created' : 'edited'},
            ${version === 1 ? null : '{}'}, '{}', 'a', ${at}, '2026-10-12T11:00Z', ${version})`.execute(
          db,
        );
      }
      await writeFile(join(dir, file), text);
      expect((await migrate(db, dir)).applied).toEqual([file]);
      const rows = await db
        .selectFrom('shifts.shift_instance')
        .select(['shift_key', 'content_revision', 'content_at_final'])
        .orderBy('shift_key')
        .execute();
      expect(rows).toEqual([
        { shift_key: '2026-10-12/A', content_revision: 4, content_at_final: 2 },
        { shift_key: '2026-10-12/B', content_revision: 1, content_at_final: null },
      ]);
      // Final and content_at_final go together.
      await expect(
        sql`UPDATE shifts.shift_instance SET content_at_final = NULL
            WHERE shift_key = '2026-10-12/A'`.execute(db),
      ).rejects.toThrow(/content_at_final/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls a failing migration back completely, so it can be fixed and rerun', async () => {
    const db = await freshDatabase('m_rollback');
    const dir = await copyOfMigrations();
    try {
      await writeFile(
        join(dir, '9999_public_broken.sql'),
        'CREATE TABLE ingest.half_done (x int);\nSELECT broken;',
      );
      await expect(migrate(db, dir)).rejects.toThrow();
      const table = await sql`SELECT to_regclass('ingest.half_done') AS t`.execute(db);
      expect(table.rows).toEqual([{ t: null }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('declares exactly the columns the migrations create (no type drift)', async () => {
    const db = await freshDatabase('m_columns');
    await migrate(db, MIGRATIONS);
    expect(await actualColumns(db, Object.keys(DECLARED_COLUMNS))).toEqual(DECLARED_COLUMNS);
    // And no table in a module schema is left undeclared.
    expect(await actualTables(db)).toEqual(Object.keys(DECLARED_COLUMNS).sort());
  });

  it('keeps the committed docs/data-model.md in step with the migrations', async () => {
    const db = await freshDatabase('m_data_model');
    await migrate(db, MIGRATIONS);
    const generated = await generateDataModel(db);
    // Deterministic: a second run over the same database gives the same text.
    expect(await generateDataModel(db)).toBe(generated);
    // On a difference: pnpm --filter @shopfloor/mes-server data-model
    expect(await readFile(DATA_MODEL_FILE, 'utf8')).toBe(generated);
  });

  it('refuses to document a table without a description', async () => {
    const db = await freshDatabase('m_data_model_new');
    await migrate(db, MIGRATIONS);
    await sql`CREATE TABLE ingest.undescribed (id INT)`.execute(db);
    await expect(generateDataModel(db)).rejects.toThrow(/describe ingest\.undescribed/);
  });

  it('documents the continuous aggregates, and refuses a view without a description (#118)', async () => {
    const db = await freshDatabase('m_data_model_views');
    await migrate(db, MIGRATIONS);
    const generated = await generateDataModel(db);
    expect(generated).toContain(
      '| `equipment.state_hourly` | `equipment.equipment_state_interval` | 01:00:00 | yes (`materialized_only = false`) |',
    );
    expect(generated).toContain(
      '| `ingest.cycle_hourly` | `ingest.equipment_event` | 01:00:00 | yes (`materialized_only = false`) |',
    );
    // A materialisation hypertable is TimescaleDB's own, never listed.
    expect(generated).not.toMatch(/_materialized_hypertable/);
    await sql`CREATE VIEW equipment.undescribed AS SELECT 1 AS one`.execute(db);
    await expect(generateDataModel(db)).rejects.toThrow(/describe equipment\.undescribed/);
  });
});

describe('MES server basics (#93)', () => {
  it('reports ready only once the database answers and is migrated', async () => {
    let migrated = false;
    const db = await freshDatabase('m_ready');
    const { app } = await buildMesHttp({
      ready: async () =>
        migrated &&
        (await sql`SELECT 1`.execute(db).then(
          () => true,
          () => false,
        )),
    });
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(503);
    await migrate(db, MIGRATIONS);
    migrated = true;
    expect((await app.inject({ url: '/health/ready' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/metrics' })).body).toMatch(/^mes_up 1$/m);
    await app.close();
  });

  it('validates the environment and never echoes secrets or URLs that may carry them', () => {
    const ok = parseEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5442/shopfloor',
      MQTT_PASSWORD: 'pw',
    });
    expect(ok.ok && [ok.env.HTTP_PORT, ok.env.MQTT_USERNAME, ok.env.MQTT_CLIENT_ID]).toEqual([
      4700,
      'mes',
      'mes-server',
    ]);
    const bad = parseEnv({
      DATABASE_URL: 'mysql://u:secret@x/y',
      HTTP_PORT: 'eighty',
      MQTT_URL: 'http://u:secret2@broker',
      MQTT_SESSION_EXPIRY_S: '5',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.map((i) => i.split(':')[0]).sort()).toEqual([
        'DATABASE_URL',
        'HTTP_PORT',
        'MQTT_PASSWORD',
        'MQTT_SESSION_EXPIRY_S',
        'MQTT_URL',
      ]);
      expect(bad.issues.join('\n')).not.toMatch(/secret/);
    }
  });

  it('reads MES_WRITES: on by default, off turns writes off, nothing else (#121)', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost:5442/shopfloor', MQTT_PASSWORD: 'pw' };
    const on = parseEnv(base);
    expect(on.ok && on.env.MES_WRITES).toBe('on');
    const off = parseEnv({ ...base, MES_WRITES: 'off' });
    expect(off.ok && off.env.MES_WRITES).toBe('off');
    const bad = parseEnv({ ...base, MES_WRITES: 'false' });
    expect(!bad.ok && bad.issues.map((i) => i.split(':')[0])).toEqual(['MES_WRITES']);
    // Any Host (`*`) would let a rebound name write: refused unless writes are off.
    const anyHost = parseEnv({ ...base, HTTP_ALLOWED_HOSTS: 'localhost, *' });
    expect(!anyHost.ok && anyHost.issues).toEqual([
      expect.stringMatching(/^HTTP_ALLOWED_HOSTS: .*MES_WRITES=on/),
    ]);
    const readOnly = parseEnv({ ...base, HTTP_ALLOWED_HOSTS: '*', MES_WRITES: 'off' });
    expect(readOnly.ok && readOnly.env.HTTP_ALLOWED_HOSTS).toBe('*');
  });
});
