import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
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
  // same moment could fail on the shared catalog row, so only when needed): no superuser or other
  // power, no connection limit, no expiry.
  const roles = await sql<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
    rolconnlimit: number;
    forever: boolean;
  }>`
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
      rolreplication, rolconnlimit,
      (rolvaliduntil IS NULL OR rolvaliduntil = 'infinity') AS forever
    FROM pg_roles WHERE rolname IN (${owner}, ${aggregates}, ${app})`.execute(db);
  for (const role of roles.rows) {
    const login = role.rolname === app;
    if (
      role.rolcanlogin !== login ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolbypassrls ||
      role.rolreplication ||
      role.rolconnlimit !== -1 ||
      !role.forever
    ) {
      await sql
        .raw(
          `ALTER ROLE ${role.rolname} ${login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB ` +
            `NOCREATEROLE NOBYPASSRLS NOREPLICATION CONNECTION LIMIT -1 VALID UNTIL 'infinity'`,
        )
        .execute(db);
    }
  }
  await ensureMemberships(db);
  // CONNECT only for the MES's role (the owner and the superuser connect as owner and superuser),
  // no temporary tables for anyone else (#185 review, L3).
  await sql
    .raw(
      `DO $$ BEGIN
        EXECUTE format('GRANT CREATE ON DATABASE %I TO ${owner}', current_database());
        EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${app}', current_database());
      END $$`,
    )
    .execute(db);
  const password = options.appPassword;
  if (password !== undefined) {
    // Only a SCRAM verifier made here reaches the server, never the password, and the statement
    // is logged nowhere, not even when it fails or is slow (#185 review, L2).
    const verifier = scramVerifier(password);
    await db.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL log_statement = 'none'`).execute(trx);
      await sql.raw(`SET LOCAL log_min_error_statement = 'panic'`).execute(trx);
      await sql.raw(`SET LOCAL log_min_duration_statement = -1`).execute(trx);
      await sql.raw(`ALTER ROLE ${app} PASSWORD '${verifier}'`).execute(trx);
    });
  }
}

/** A membership row of one of the MES's roles. */
interface Membership {
  role: string;
  member: string;
  grantor: string;
  inherit_option: boolean;
  set_option: boolean;
  admin_option: boolean;
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Leaves exactly one membership of the MES's roles (#185 review, M3): `mes_app` in `mes_cagg`
 * WITH ADMIN FALSE, INHERIT FALSE, SET TRUE. Every other row where one of them is the member
 * (`mes_owner` for `mes_app`, `pg_write_all_data`, a second grant of `mes_cagg` by another
 * grantor, ...) is revoked, by its grantor.
 */
async function ensureMemberships(db: Kysely<Database>): Promise<void> {
  const { owner, aggregates, app } = DB_ROLES;
  const rows = await sql<Membership>`
    SELECT m.roleid::regrole::text AS role, m.member::regrole::text AS member,
      m.grantor::regrole::text AS grantor, m.inherit_option, m.set_option, m.admin_option
    FROM pg_auth_members m
    WHERE m.member::regrole::text IN (${owner}, ${aggregates}, ${app})
    ORDER BY m.oid`.execute(db);
  let kept = false;
  for (const row of rows.rows) {
    const wanted =
      row.role === aggregates &&
      row.member === app &&
      !row.inherit_option &&
      row.set_option &&
      !row.admin_option;
    if (wanted && !kept) {
      kept = true;
      continue;
    }
    await sql
      .raw(
        `REVOKE ${ident(row.role)} FROM ${ident(row.member)} GRANTED BY ${ident(row.grantor)} CASCADE`,
      )
      .execute(db);
  }
  if (!kept) {
    await sql
      .raw(`GRANT ${aggregates} TO ${app} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`)
      .execute(db);
  }
}

/** SCRAM-SHA-256 iterations, PostgreSQL's default (`scram_iterations`). */
const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802, 7677), made with
 * node:crypto. Printable ASCII only: SASLprep leaves it unchanged, so the server and libpq-style
 * clients derive the same key without a SASLprep implementation here.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (password.length === 0 || !/^[\x20-\x7e]+$/.test(password)) {
    throw new Error('DB_APP_PASSWORD must be printable ASCII (letters, digits, punctuation)');
  }
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(SCRAM_ITERATIONS)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
