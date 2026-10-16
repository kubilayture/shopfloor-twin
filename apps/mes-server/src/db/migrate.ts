import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { Database } from './database.ts';
import { DB_ROLES, ensureRoles, type RoleOptions } from './roles.ts';

/** `NNNN_<module>_<what>.sql`: ordered by the number, which must be unique. */
const MIGRATION = /^(\d{4})_[a-z0-9]+(?:[_-][a-z0-9]+)*\.sql$/;

/** An arbitrary constant: concurrent MES instances wait for each other instead of racing. */
const LOCK_ID = 7_004_001;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
  /** False for files marked `-- migrate:no-transaction` (CREATE INDEX CONCURRENTLY and the like). */
  readonly transactional: boolean;
}

/** Marks a migration that can't run in a transaction; it must then be safe to rerun. */
export const NO_TRANSACTION = '-- migrate:no-transaction';

/** How long a starting instance waits for another one's migrations. */
const LOCK_WAIT = '120s';

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
    // Line endings and a BOM don't count: a Windows checkout must not look like an edited file.
    const text = (await readFile(join(dir, name), 'utf8'))
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n');
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/im.test(text)) {
      throw new Error(
        `${name}: transaction control belongs to the runner (see -- migrate:no-transaction)`,
      );
    }
    migrations.push({
      name,
      sql: text,
      checksum: createHash('sha256').update(text).digest('hex'),
      transactional: !text.includes(NO_TRANSACTION),
    });
  }
  return migrations;
}

/**
 * Statements of a no-transaction file: split after every line that ends with `;`. Such files
 * hold simple DDL; dollar-quoted function bodies belong in transactional files.
 */
export function statementsOf(text: string): string[] {
  return text
    .split(/;[ \t]*(?:--[^\n]*)?$/m)
    .map((part) =>
      part
        .split('\n')
        .filter((line) => !/^\s*--/.test(line))
        .join('\n')
        .trim(),
    )
    .filter((part) => part !== '');
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: number;
}

/**
 * Applies pending migrations in order, each in its own transaction (ADR-0016). Refuses to run if a
 * migration that was already applied has changed, or if the database has migrations this code
 * doesn't know (a newer version ran against it).
 *
 * Runs as the bootstrap superuser (the `migrate` step, ADR-0027): first creates or updates the
 * database roles (`ensureRoles`), then runs every migration under `SET LOCAL ROLE mes_owner`, so
 * what it creates belongs to `mes_owner`; a migration that must act as the superuser (0017 takes
 * the objects of an older database over) resets the role itself. The history row is written as the
 * superuser after the migration's own statements, in the same transaction.
 */
export async function migrate(
  db: Kysely<Database>,
  dir: string,
  options: RoleOptions = {},
): Promise<MigrationResult> {
  const migrations = await readMigrations(dir);
  return db.connection().execute(async (connection) => {
    await sql.raw(`SET lock_timeout = '${LOCK_WAIT}'`).execute(connection);
    await sql`SELECT pg_advisory_lock(${LOCK_ID})`.execute(connection);
    await sql`RESET lock_timeout`.execute(connection);
    try {
      await ensureRoles(connection, options);
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
        if (migration.transactional) {
          await connection.transaction().execute(async (trx) => {
            await sql.raw(`SET LOCAL ROLE ${DB_ROLES.owner}`).execute(trx);
            await sql.raw(migration.sql).execute(trx);
            await sql`RESET ROLE`.execute(trx);
            await trx
              .insertInto('public.schema_migrations')
              .values({ name: migration.name, checksum: migration.checksum })
              .execute();
          });
        } else {
          // Several statements in one query would still form one implicit transaction.
          await sql.raw(`SET ROLE ${DB_ROLES.owner}`).execute(connection);
          try {
            for (const statement of statementsOf(migration.sql)) {
              await sql.raw(statement).execute(connection);
            }
          } finally {
            await sql`RESET ROLE`.execute(connection).catch(() => undefined);
          }
          await connection
            .insertInto('public.schema_migrations')
            .values({ name: migration.name, checksum: migration.checksum })
            .execute();
        }
        applied.push(migration.name);
      }
      return { applied, skipped: appliedNames.size };
    } finally {
      // A dead connection releases the lock by itself; its error must not mask the original one.
      await sql`SELECT pg_advisory_unlock(${LOCK_ID})`.execute(connection).catch(() => undefined);
    }
  });
}

/** How the database's migration history compares with this version's migrations. */
export interface MigrationStatus {
  /** The history equals the migrations: nothing pending, unknown or changed. */
  readonly current: boolean;
  /** Migrations this version has that the database has not applied. */
  readonly pending: readonly string[];
  /** Migrations the database has applied that this version doesn't know (a newer version ran). */
  readonly unknown: readonly string[];
  /** Applied migrations whose file changed since. */
  readonly changed: readonly string[];
}

/**
 * Reads the migration history without changing anything (#169): the MES, which no longer migrates
 * itself (ADR-0016 amendment), is not ready until this is `current`. A database without a history
 * has every migration pending.
 */
export async function migrationStatus(db: Kysely<Database>, dir: string): Promise<MigrationStatus> {
  const migrations = await readMigrations(dir);
  const exists = await sql<{ t: string | null }>`
    SELECT to_regclass('public.schema_migrations')::text AS t`.execute(db);
  const done =
    exists.rows[0]?.t === null || exists.rows[0] === undefined
      ? []
      : await db.selectFrom('public.schema_migrations').select(['name', 'checksum']).execute();
  const known = new Map(migrations.map((m) => [m.name, m.checksum]));
  const applied = new Set(done.map((row) => row.name));
  const pending = migrations.filter((m) => !applied.has(m.name)).map((m) => m.name);
  const unknown = done.filter((row) => !known.has(row.name)).map((row) => row.name);
  const changed = done
    .filter((row) => known.has(row.name) && known.get(row.name) !== row.checksum)
    .map((row) => row.name);
  return {
    current: pending.length === 0 && unknown.length === 0 && changed.length === 0,
    pending,
    unknown,
    changed,
  };
}
