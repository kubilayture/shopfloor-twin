import { sql, type Kysely } from 'kysely';
import type { Database } from './database.ts';

/**
 * The database roles (#169, ADR-0027). The image's bootstrap superuser (`DB_USER`) only creates
 * them and runs the migrations; the MES connects as `app`.
 */
export const DB_ROLES = {
  /** NOLOGIN: owns every schema, table, view, function and trigger; migrations run as it. */
  owner: 'mes_owner',
  /** NOLOGIN: owns the two continuous aggregates, the one role that may refresh them. */
  aggregates: 'mes_cagg',
  /** LOGIN (`DB_APP_PASSWORD`): what the MES connects as; owns nothing. */
  app: 'mes_app',
} as const;

export interface RoleOptions {
  /** Sets `mes_app`'s password (the `migrate` step passes `DB_APP_PASSWORD`); kept otherwise. */
  readonly appPassword?: string | undefined;
}

/** A SQL string literal; standard_conforming_strings is on, so only quotes need doubling. */
function literal(value: string): string {
  if (value.includes('\0')) throw new Error('a password may not contain NUL');
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Creates or updates the roles and the database-level rights the migrations need: TimescaleDB
 * (an extension only a superuser may create), CREATE on the database for `mes_owner` (it creates
 * the schemas), and `mes_app`'s membership in `mes_cagg` WITH INHERIT FALSE, SET TRUE (PostgreSQL
 * 16+): none of `mes_cagg`'s rights until `SET ROLE mes_cagg` (the aggregate refresher). Idempotent;
 * runs as the bootstrap superuser under the migration lock. Roles are shared by every database of
 * the server, so a concurrent creation by another database's runner is tolerated.
 */
export async function ensureRoles(db: Kysely<Database>, options: RoleOptions = {}): Promise<void> {
  const { owner, aggregates, app } = DB_ROLES;
  await sql.raw('CREATE EXTENSION IF NOT EXISTS timescaledb').execute(db);
  // (A DO block: CREATE ROLE has no IF NOT EXISTS.)
  await sql
    .raw(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${owner}') THEN
          BEGIN CREATE ROLE ${owner} NOLOGIN;
          EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${aggregates}') THEN
          BEGIN CREATE ROLE ${aggregates} NOLOGIN;
          EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${app}') THEN
          BEGIN CREATE ROLE ${app} LOGIN;
          EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
        END IF;
      END $$`,
    )
    .execute(db);
  // The attributes, enforced when they differ (an ALTER of a role another runner alters at the
  // same moment could fail on the shared catalog row, so only when needed).
  const roles = await sql<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
  }>`
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
    FROM pg_roles WHERE rolname IN (${owner}, ${aggregates}, ${app})`.execute(db);
  for (const role of roles.rows) {
    const login = role.rolname === app;
    if (
      role.rolcanlogin !== login ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolbypassrls ||
      role.rolreplication
    ) {
      await sql
        .raw(
          `ALTER ROLE ${role.rolname} ${login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`,
        )
        .execute(db);
    }
  }
  const membership = await sql<{
    inherit_option: boolean;
    set_option: boolean;
    admin_option: boolean;
  }>`
    SELECT m.inherit_option, m.set_option, m.admin_option
    FROM pg_auth_members m
    WHERE m.roleid = ${aggregates}::regrole AND m.member = ${app}::regrole`.execute(db);
  const member = membership.rows[0];
  if (!member || member.inherit_option || !member.set_option || member.admin_option) {
    await sql
      .raw(`GRANT ${aggregates} TO ${app} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`)
      .execute(db);
  }
  await sql
    .raw(
      `DO $$ BEGIN
        EXECUTE format('GRANT CREATE ON DATABASE %I TO ${owner}', current_database());
      END $$`,
    )
    .execute(db);
  const password = options.appPassword;
  if (password !== undefined) {
    // Never into the server's log, not even with a failing statement.
    await db.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL log_statement = 'none'`).execute(trx);
      await sql.raw(`SET LOCAL log_min_error_statement = 'panic'`).execute(trx);
      await sql.raw(`ALTER ROLE ${app} PASSWORD ${literal(password)}`).execute(trx);
    });
  }
}
