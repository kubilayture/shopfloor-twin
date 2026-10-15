import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { Database } from './database.ts';

/** `NNNN_<module>_<what>.sql`: ordered by the number, which must be unique. */
const MIGRATION = /^(\d{4})_[a-z0-9]+(?:[_-][a-z0-9]+)*\.sql$/;

/** An arbitrary constant: concurrent MES instances wait for each other instead of racing. */
const LOCK_ID = 7_004_001;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export async function readMigrations(dir: string): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const migrations: Migration[] = [];
  for (const name of names) {
    const match = MIGRATION.exec(name);
    if (!match) throw new Error(`migration file name not allowed: ${name}`);
    const number = match[1] ?? '';
    if (seen.has(number)) throw new Error(`two migrations numbered ${number}`);
    seen.add(number);
    const text = await readFile(join(dir, name), 'utf8');
    migrations.push({ name, sql: text, checksum: createHash('sha256').update(text).digest('hex') });
  }
  return migrations;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: number;
}

/**
 * Applies pending migrations in order, each in its own transaction (ADR-0016). Refuses to run if a
 * migration that was already applied has changed, or if the database has migrations this code
 * doesn't know (a newer version ran against it).
 */
export async function migrate(db: Kysely<Database>, dir: string): Promise<MigrationResult> {
  const migrations = await readMigrations(dir);
  return db.connection().execute(async (connection) => {
    await sql`SELECT pg_advisory_lock(${LOCK_ID})`.execute(connection);
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          name TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.execute(connection);
      const done = await connection
        .selectFrom('public.schema_migrations')
        .select(['name', 'checksum'])
        .execute();
      const known = new Map(migrations.map((m) => [m.name, m]));
      for (const row of done) {
        const migration = known.get(row.name);
        if (!migration)
          throw new Error(`database has migration ${row.name}, which this version doesn't know`);
        if (migration.checksum !== row.checksum) {
          throw new Error(
            `migration ${row.name} changed after it was applied; add a new migration instead`,
          );
        }
      }
      const appliedNames = new Set(done.map((row) => row.name));
      const applied: string[] = [];
      for (const migration of migrations) {
        if (appliedNames.has(migration.name)) continue;
        await connection.transaction().execute(async (trx) => {
          await sql.raw(migration.sql).execute(trx);
          await trx
            .insertInto('public.schema_migrations')
            .values({ name: migration.name, checksum: migration.checksum })
            .execute();
        });
        applied.push(migration.name);
      }
      return { applied, skipped: appliedNames.size };
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_ID})`.execute(connection);
    }
  });
}
