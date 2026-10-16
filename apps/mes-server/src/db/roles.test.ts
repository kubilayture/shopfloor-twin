/**
 * Database roles and the one audit log (#169, ADR-0027): the `migrate` step's roles, owners and
 * grants (compared with DECLARED_GRANTS), what `mes_app` is refused (42501), the aggregate refresh
 * under `SET ROLE mes_cagg`, the ownership step and the audit backfill on a database migrated to
 * 0015 the way the MES did it before #169, and the migration status the MES waits for.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Identity } from '../modules/identity/index.ts';
import { TEST_DB, appUrl, databaseUrl, startDatabase } from '../testing.ts';
import { AggregateRefresher } from './aggregate-refresh.ts';
import { createDatabase, type Database } from './database.ts';
import { actualGrants, actualOwners, declaredGrants } from './grants.ts';
import { migrate, migrationStatus, readMigrations } from './migrate.ts';
import { DB_ROLES } from './roles.ts';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../db/migrations');
const AGGREGATES = ['equipment.state_hourly', 'ingest.cycle_hourly'];

let container: StartedTestContainer;
let serverUrl: string;
const pools: Kysely<Database>[] = [];
let databases = 0;

const pool = (url: string, size = 2): Kysely<Database> => {
  const db = createDatabase(url, size);
  pools.push(db);
  return db;
};

/** A new empty database: its name, a superuser pool and (once migrated) an `mes_app` pool. */
async function emptyDatabase(prefix: string) {
  databases++;
  const name = `${prefix}_${String(databases)}`;
  await sql.raw(`CREATE DATABASE ${name}`).execute(pool(serverUrl, 1));
  return {
    name,
    owner: pool(databaseUrl(serverUrl, name)),
    app: () => pool(appUrl(serverUrl, name)),
  };
}

/** SQLSTATE of a failed statement, or 'ok'. */
async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error instanceof Error ? error.message : 'failed';
  }
}

/**
 * Migrates as the MES did before #169 (ADR-0016 as first decided): as the bootstrap superuser, no
 * roles, no `SET ROLE`, each file in a transaction with its history row; files up to `upTo`.
 */
async function legacyMigrate(db: Kysely<Database>, upTo: number): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`.execute(
    db,
  );
  const applied: string[] = [];
  for (const migration of await readMigrations(MIGRATIONS)) {
    if (Number(migration.name.slice(0, 4)) > upTo) continue;
    await db.transaction().execute(async (trx) => {
      await sql.raw(migration.sql).execute(trx);
      await trx
        .insertInto('public.schema_migrations')
        .values({ name: migration.name, checksum: migration.checksum })
        .execute();
    });
    applied.push(migration.name);
  }
  return applied;
}

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
}, 180_000);

afterAll(async () => {
  for (const db of pools) await db.destroy();
  await container.stop();
});

describe('roles, owners and grants (#169, ADR-0027)', () => {
  let app: Kysely<Database>;
  let owner: Kysely<Database>;

  beforeAll(async () => {
    const fresh = await emptyDatabase('roles');
    owner = fresh.owner;
    await migrate(owner, MIGRATIONS, { appPassword: TEST_DB.appPassword });
    app = fresh.app();
  });

  it('creates the roles: two without login, mes_app a member of mes_cagg that inherits nothing', async () => {
    const roles = await sql<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean }>`
      SELECT rolname, rolcanlogin, rolsuper FROM pg_roles
      WHERE rolname IN ('mes_owner', 'mes_cagg', 'mes_app') ORDER BY rolname`.execute(owner);
    expect(roles.rows).toEqual([
      { rolname: 'mes_app', rolcanlogin: true, rolsuper: false },
      { rolname: 'mes_cagg', rolcanlogin: false, rolsuper: false },
      { rolname: 'mes_owner', rolcanlogin: false, rolsuper: false },
    ]);
    const members = await sql<{ role: string; member: string; inherit: boolean; set: boolean }>`
      SELECT m.roleid::regrole::text AS role, m.member::regrole::text AS member,
        m.inherit_option AS inherit, m.set_option AS set
      FROM pg_auth_members m
      WHERE m.roleid::regrole::text IN ('mes_owner', 'mes_cagg', 'mes_app')
        OR m.member::regrole::text IN ('mes_owner', 'mes_cagg', 'mes_app')`.execute(owner);
    expect(members.rows).toEqual([
      { role: 'mes_cagg', member: 'mes_app', inherit: false, set: true },
    ]);
  });

  it('gives every object to mes_owner, the aggregates to mes_cagg', async () => {
    const owners = await actualOwners(owner);
    expect(Object.keys(owners).length).toBeGreaterThan(60);
    const wrong = Object.entries(owners).filter(
      ([object, role]) => role !== (AGGREGATES.includes(object) ? 'mes_cagg' : 'mes_owner'),
    );
    expect(wrong).toEqual([]);
    for (const view of AGGREGATES) expect(owners[view]).toBe('mes_cagg');
  });

  it('grants exactly DECLARED_GRANTS (aggregates included, _timescaledb_internal excluded)', async () => {
    const declared = declaredGrants();
    expect(declared.length).toBeGreaterThan(100);
    expect(await actualGrants(owner)).toEqual(declared);
  });

  it('refuses mes_app every change to an object and every rewrite of the audit trail (42501)', async () => {
    const refused = async (statement: string) =>
      sqlState(() =>
        app.transaction().execute(async (trx) => {
          await sql.raw(statement).execute(trx);
        }),
      );
    const statements = [
      'ALTER TABLE identity.audit_log DISABLE TRIGGER audit_log_no_update_delete',
      'ALTER TABLE alarms.alarm_transition DISABLE TRIGGER ALL',
      'TRUNCATE identity.audit_log',
      'TRUNCATE alarms.alarm_transition',
      'UPDATE identity.audit_log SET username = username',
      'DELETE FROM identity.audit_log',
      'UPDATE alarms.alarm_transition SET actor = actor',
      'DELETE FROM alarms.alarm_transition',
      'UPDATE alarms.occurrence_state SET comment = comment',
      'DELETE FROM alarms.occurrence_state',
      "INSERT INTO equipment.downtime_audit (equipment, epoch, from_time, action, before, after, actor, version) VALUES ('x', 1, now(), 'coded', '[]', '[]', 'x', 1)",
      'DELETE FROM shifts.handover_note',
      'CREATE TABLE identity.mine (x int)',
      'CREATE TABLE equipment.mine (x int)',
      'CREATE SCHEMA mine',
      'DROP TABLE identity.audit_log',
      'ALTER TABLE identity.audit_log OWNER TO mes_app',
    ];
    for (const statement of statements) {
      expect(await refused(statement), statement).toBe('42501');
      // Also after taking mes_cagg's rights: it owns only the aggregates.
      expect(await refused(`SET LOCAL ROLE mes_cagg; ${statement}`), statement).toBe('42501');
    }
    // What it may do: read and add to the audit log, read the frozen audits.
    await app.transaction().execute(async (trx) => {
      await Identity.audit(trx, {
        actor: { system: 'test' },
        authenticated: false,
        action: 'test.write',
        entityType: 'test',
        entityId: '1',
      });
      await sql`SELECT count(*) FROM equipment.downtime_audit`.execute(trx);
      await sql`SELECT count(*) FROM shifts.handover_audit`.execute(trx);
    });
    // Frozen for every role, the owner included.
    expect(
      await sqlState(() =>
        sql`INSERT INTO shifts.handover_audit (note_id, epoch, shift_key, action, after, actor,
          plant_at, version) VALUES (1, 1, 'k', 'created', '{}', 'x', now(), 1)`.execute(owner),
      ),
    ).toBe('42501');
  });

  it('refreshes an aggregate only as mes_cagg, and cagg_watermark moves (B1)', async () => {
    // A cycle fact written as the MES writes it (a new chunk of the hypertable, as mes_app).
    await sql`INSERT INTO ingest.equipment_event (equipment, epoch, seq, source_time, event_type,
        topic, quality, source_protocol, received_at, payload)
      VALUES ('cnc-01', 1, 1, '2026-10-12T03:10:00Z', 'cycle', 't', 'good', 'opcua', now(),
        '{"value": {"product": "VB-100", "result": "good"}}')`.execute(app);
    const watermark = async () =>
      (
        await sql<{ micros: number }>`
          SELECT _timescaledb_functions.cagg_watermark(mat_hypertable_id) AS micros
          FROM _timescaledb_catalog.continuous_agg
          WHERE user_view_schema = 'ingest' AND user_view_name = 'cycle_hourly'`.execute(app)
      ).rows[0]?.micros;
    const before = await watermark();
    // Without SET ROLE: refused, whoever the MES is.
    const direct = await sqlState(() =>
      sql`CALL refresh_continuous_aggregate('ingest.cycle_hourly', NULL, '2026-10-13T00:00:00Z')`.execute(
        app,
      ),
    );
    expect(direct).toBe('42501');
    expect(await watermark()).toBe(before);
    // The refresher's way: SET ROLE mes_cagg, the CALL, RESET ROLE.
    const refresher = new AggregateRefresher('ingest.cycle_hourly', app, 0);
    refresher.through(Date.parse('2026-10-12T04:00:00Z'));
    await refresher.flush();
    const after = await watermark();
    expect(after).toBe(Date.parse('2026-10-12T04:00:00Z') * 1000);
    expect(after).not.toBe(before);
    const rows = await sql<{ cycles: number }>`SELECT cycles FROM ingest.cycle_hourly`.execute(app);
    expect(rows.rows).toEqual([{ cycles: 1 }]);
    // The connection went back to mes_app.
    const role = await sql<{ r: string }>`SELECT current_user AS r`.execute(app);
    expect(role.rows[0]?.r).toBe('mes_app');
  });

  it('accepts the cost: as mes_cagg the MES could drop an aggregate (derived data), never an audit table', async () => {
    const dropped = await sqlState(() =>
      app.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE mes_cagg`.execute(trx);
        await sql`DROP MATERIALIZED VIEW equipment.state_hourly`.execute(trx);
        throw new Error('rolled back');
      }),
    );
    expect(dropped).toBe('rolled back');
    const view = await sql<{ t: string | null }>`
      SELECT to_regclass('equipment.state_hourly')::text AS t`.execute(app);
    expect(view.rows[0]?.t).toBe('equipment.state_hourly');
  });

  it('reports the migration history the MES waits for', async () => {
    const names = (await readMigrations(MIGRATIONS)).map((m) => m.name);
    expect(await migrationStatus(app, MIGRATIONS)).toEqual({
      current: true,
      pending: [],
      unknown: [],
      changed: [],
    });
    const empty = await emptyDatabase('status');
    expect(await migrationStatus(empty.owner, MIGRATIONS)).toEqual({
      current: false,
      pending: names,
      unknown: [],
      changed: [],
    });
    const dir = await mkdtemp(join(tmpdir(), 'migrations-status-'));
    try {
      // A newer database (a migration this version lacks) is not current either.
      const status = await migrationStatus(app, dir);
      expect(status.current).toBe(false);
      expect(status.unknown).toEqual(names);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sets mes_app’s password only when given, never into the server log', async () => {
    const other = await emptyDatabase('password');
    // The role exists (shared by the server); without a password the old one stays.
    await migrate(other.owner, MIGRATIONS);
    const login = await sqlState(() => sql`SELECT 1`.execute(other.app()));
    expect(login).toBe('ok');
    const changed = createHash('sha256').update('x').digest('hex');
    await migrate(other.owner, MIGRATIONS, { appPassword: changed });
    expect(await sqlState(() => sql`SELECT 1`.execute(other.app()))).not.toBe('ok');
    await migrate(other.owner, MIGRATIONS, { appPassword: TEST_DB.appPassword });
    expect(await sqlState(() => sql`SELECT 1`.execute(other.app()))).toBe('ok');
  });
});

describe('an existing database: ownership step and audit backfill (M1, #169)', () => {
  it('migrates a 0015 database with old audit rows to the roles, every row in identity.audit_log', async () => {
    const old = await emptyDatabase('legacy');
    const db = old.owner;
    expect(await legacyMigrate(db, 15)).toHaveLength(15);
    // Everything belongs to the bootstrap user, as on a database the MES migrated itself.
    const before = await actualOwners(db);
    expect(new Set(Object.values(before))).toEqual(new Set([TEST_DB.user]));

    // A fact (a chunk of a hypertable owned by the bootstrap user).
    await sql`INSERT INTO ingest.equipment_event (equipment, epoch, seq, source_time, event_type,
        topic, quality, source_protocol, received_at, payload)
      VALUES ('cnc-01', 7, 1, '2026-10-12T03:10:00Z', 'cycle', 't', 'good', 'opcua', now(),
        '{"value": {"product": "VB-100", "result": "good"}}')`.execute(db);
    // Rows as the Phase 5 and 6 code paths wrote them: codings (coded, cleared, a clip by the
    // system), alarm transitions (ack, comment, shelve, unshelve, expire, epoch-ended) and notes.
    await sql`INSERT INTO equipment.downtime_audit (equipment, epoch, record_id, from_time, to_time,
        action, before, after, actor, at, request_id, version) VALUES
      ('cnc-01', 7, 'cnc-01~7~1760245200000', '2026-10-12T05:00:00Z', '2026-10-12T05:30:00Z',
        'coded', '[]',
        '[{"from":"2026-10-12T05:00:00.000Z","to":"2026-10-12T05:10:00.000Z","reason":"MATERIAL","comment":"no blanks","codedBy":"Ayşe","codedAt":"2026-10-15T08:00:00.000Z"}]',
        'Ayşe', '2026-10-15T08:00:00.123Z', 'req-1', 1),
      ('cnc-01', 7, 'cnc-01~7~1760245200000', '2026-10-12T05:00:00Z', NULL, 'cleared',
        '[{"from":"2026-10-12T05:00:00.000Z","to":"2026-10-12T05:10:00.000Z","reason":"MATERIAL","comment":"no blanks","codedBy":"Ayşe","codedAt":"2026-10-15T08:00:00.000Z"}]',
        '[]', 'Mehmet', '2026-10-15T08:05:00Z', 'req-2', 2),
      ('cnc-02', 7, NULL, '2026-10-12T06:00:00Z', '2026-10-12T06:20:00Z', 'orphaned',
        '[{"from":"2026-10-12T06:00:00.000Z","to":"2026-10-12T06:20:00.000Z","reason":"TOOLING","comment":"","codedBy":"Can","codedAt":"2026-10-15T07:00:00.000Z"}]',
        '[{"from":"2026-10-12T06:00:00.000Z","to":"2026-10-12T06:20:00.000Z","reason":"TOOLING","comment":"","codedBy":"Can","codedAt":"2026-10-15T07:00:00.000Z","orphaned":true}]',
        'system', '2026-10-15T08:10:00Z', NULL, 3)`.execute(db);
    await sql`INSERT INTO alarms.alarm_transition (equipment, code, epoch, seq, action, before,
        after, actor, at, plant_at, plant_epoch, request_id, version) VALUES
      ('cnc-01', 'SPINDLE-OVERLOAD', 7, 12, 'ack', '{"acknowledged":false}',
        '{"acknowledged":true,"by":"Ayşe","comment":""}', 'Ayşe', '2026-10-15T08:01:00Z',
        '2026-10-12T05:01:00Z', 7, 'req-3', NULL),
      ('cnc-01', 'SPINDLE-OVERLOAD', 7, 12, 'comment', NULL, '{"text":"checked"}', 'Ayşe',
        '2026-10-15T08:02:00Z', '2026-10-12T05:02:00Z', 7, 'req-4', NULL),
      ('cnc-01', 'COOLANT-LOW', NULL, NULL, 'shelve', '{"shelved":false,"version":0}',
        '{"shelved":true,"version":1,"by":"Mehmet","reason":"sensor"}', 'Mehmet',
        '2026-10-15T08:03:00Z', '2026-10-12T05:03:00Z', 7, 'req-5', 1),
      ('cnc-01', 'COOLANT-LOW', NULL, NULL, 'unshelve', '{"shelved":true,"version":1}',
        '{"shelved":false,"version":2}', 'Mehmet', '2026-10-15T08:04:00Z',
        '2026-10-12T05:04:00Z', 7, 'req-6', 2),
      ('cnc-02', 'DOOR-OPEN', NULL, NULL, 'expire', '{"shelved":true,"version":1}',
        '{"shelved":false,"version":2}', 'system', '2026-10-15T08:06:00Z',
        '2026-10-12T05:30:00Z', 7, NULL, 2),
      ('cnc-02', 'AIR-LOW', NULL, NULL, 'epoch-ended', '{"shelved":true,"version":4}', NULL,
        'system', '2026-10-15T08:07:00Z', NULL, NULL, NULL, 5)`.execute(db);
    await sql`INSERT INTO shifts.shift_instance (epoch, shift_key, shift_date, shift_id,
        start_time, end_time, breaks, status)
      VALUES (7, '2026-10-12/A', '2026-10-12', 'A', '2026-10-12T03:00:00Z',
        '2026-10-12T11:00:00Z', '[]', 'running')`.execute(db);
    const note = await sql<{ id: number }>`
      INSERT INTO shifts.handover_note (epoch, shift_key, category, text, created_by, author,
        created_plant_at, updated_plant_at)
      VALUES (7, '2026-10-12/A', 'safety', 'second', 'Ayşe', 'Mehmet', '2026-10-12T05:00:00Z',
        '2026-10-12T05:20:00Z') RETURNING id`.execute(db);
    const noteId = note.rows[0]?.id ?? 0;
    await sql`INSERT INTO shifts.handover_audit (note_id, epoch, shift_key, action, before, after,
        actor, at, plant_at, request_id, version) VALUES
      (${noteId}, 7, '2026-10-12/A', 'created', NULL,
        '{"category":"safety","text":"first","retracted":false}', 'Ayşe',
        '2026-10-15T08:00:30Z', '2026-10-12T05:00:00Z', 'req-7', 1),
      (${noteId}, 7, '2026-10-12/A', 'edited',
        '{"category":"safety","text":"first","retracted":false}',
        '{"category":"safety","text":"second","retracted":false}', 'Mehmet',
        '2026-10-15T08:20:00Z', '2026-10-12T05:20:00Z', NULL, 2)`.execute(db);

    // The source rows as stored, for the expected audit rows.
    const codings = (
      await sql<{
        id: number;
        equipment: string;
        epoch: number;
        record_id: string | null;
        from_time: Date;
        to_time: Date | null;
        action: string;
        before: unknown;
        after: unknown;
        actor: string;
        at: Date;
        request_id: string | null;
        version: number;
      }>`SELECT * FROM equipment.downtime_audit`.execute(db)
    ).rows;
    const transitions = (
      await sql<{
        id: number;
        equipment: string;
        code: string;
        epoch: number | null;
        seq: number | null;
        action: string;
        before: unknown;
        after: Record<string, unknown> | null;
        actor: string;
        at: Date;
        plant_at: Date | null;
        request_id: string | null;
        version: number | null;
      }>`SELECT * FROM alarms.alarm_transition`.execute(db)
    ).rows;
    const notes = (
      await sql<{
        id: number;
        note_id: number;
        action: string;
        before: unknown;
        after: Record<string, unknown>;
        actor: string;
        at: Date;
        plant_at: Date;
        request_id: string | null;
        version: number;
      }>`SELECT * FROM shifts.handover_audit`.execute(db)
    ).rows;
    const legacyRow = { userId: null, roles: [], authenticated: false, legacy: true };
    const expected = [
      ...codings.map((row) => ({
        source: 1,
        sourceId: row.id,
        at: row.at,
        plantAt: null,
        username: row.actor,
        action:
          { coded: 'downtime.code', cleared: 'downtime.clear' }[row.action] ?? 'downtime.orphan',
        entityType: 'downtime-coding-set',
        entityId: `${row.equipment}~${String(row.epoch)}`,
        before: { codings: row.before },
        after: {
          recordId: row.record_id,
          from: row.from_time.toISOString(),
          to: row.to_time?.toISOString() ?? null,
          version: row.version,
          codings: row.after,
        },
        requestId: row.request_id,
      })),
      ...transitions.map((row) => ({
        source: 2,
        sourceId: row.id,
        at: row.at,
        plantAt: row.plant_at,
        username: row.actor,
        action: `alarm.${row.action}`,
        entityType: row.seq === null ? 'alarm-point' : 'alarm-occurrence',
        entityId:
          row.seq === null
            ? `${row.equipment}/${row.code}`
            : `${row.equipment}~${String(row.epoch)}~${String(row.seq)}`,
        before: row.before,
        after: row.version === null ? row.after : { ...row.after, version: row.version },
        requestId: row.request_id,
      })),
      ...notes.map((row) => ({
        source: 3,
        sourceId: row.id,
        at: row.at,
        plantAt: row.plant_at,
        username: row.actor,
        action: row.action === 'created' ? 'note.create' : 'note.edit',
        entityType: 'handover-note',
        entityId: String(row.note_id),
        before: row.before,
        after: { ...row.after, version: row.version },
        requestId: row.request_id,
      })),
    ]
      .sort(
        (a, b) => a.at.getTime() - b.at.getTime() || a.source - b.source || a.sourceId - b.sourceId,
      )
      .map((row) => {
        const copy: Partial<typeof row> = { ...row };
        delete copy.source;
        delete copy.sourceId;
        return { ...copy, ...legacyRow };
      });
    expect(expected).toHaveLength(3 + 6 + 2);

    // The migrate step: roles, the ownership step and the new migrations.
    const result = await migrate(db, MIGRATIONS, { appPassword: TEST_DB.appPassword });
    expect(result.skipped).toBe(15);
    expect(result.applied).toEqual(
      (await readdir(MIGRATIONS)).filter((name) => Number(name.slice(0, 4)) > 15).sort(),
    );

    const app = old.app();
    const backfilled = (
      await app
        .selectFrom('identity.audit_log')
        .selectAll()
        .where('legacy', '=', true)
        .orderBy('id')
        .execute()
    ).map((row) => ({
      at: row.at,
      plantAt: row.plant_at,
      username: row.username,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: row.before,
      after: row.after,
      requestId: row.request_id,
      userId: row.user_id,
      roles: row.roles,
      authenticated: row.authenticated,
      legacy: row.legacy,
    }));
    expect(backfilled).toEqual(expected);
    // The counts per module audit, and the module audits kept as they were (frozen).
    for (const [prefix, table, count] of [
      ['downtime.%', 'equipment.downtime_audit', 3],
      ['alarm.%', 'alarms.alarm_transition', 6],
      ['note.%', 'shifts.handover_audit', 2],
    ] as const) {
      const copied = await sql<{ n: number }>`
        SELECT count(*) AS n FROM identity.audit_log WHERE legacy AND action LIKE ${prefix}`.execute(
        app,
      );
      const source = await sql<{
        n: number;
      }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(app);
      expect([copied.rows[0]?.n, source.rows[0]?.n]).toEqual([count, count]);
    }

    // Owners moved object by object (REASSIGN OWNED can't), the aggregates to mes_cagg; the
    // grants are the declared ones, as on a fresh database.
    const owners = await actualOwners(db);
    expect(
      Object.entries(owners).filter(
        ([object, role]) => role !== (AGGREGATES.includes(object) ? 'mes_cagg' : 'mes_owner'),
      ),
    ).toEqual([]);
    expect(await actualGrants(db)).toEqual(declaredGrants());
    // Chunks moved with their hypertables, and mes_app reads and writes them.
    await sql`INSERT INTO ingest.equipment_event (equipment, epoch, seq, source_time, event_type,
        topic, quality, source_protocol, received_at, payload)
      VALUES ('cnc-01', 7, 2, '2026-11-20T03:10:00Z', 'cycle', 't', 'good', 'opcua', now(),
        '{"value": {"product": "VB-100", "result": "good"}}')`.execute(app);
    const chunks = await sql<{ owner: string; n: number }>`
      SELECT c.relowner::regrole::text AS owner, count(*) AS n
      FROM timescaledb_information.chunks k
      JOIN pg_namespace n ON n.nspname = k.chunk_schema
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = k.chunk_name
      WHERE k.hypertable_schema = 'ingest' AND k.hypertable_name = 'equipment_event'
      GROUP BY 1`.execute(db);
    // The chunk made before the migration and the one mes_app's insert made: both mes_owner's.
    expect(chunks.rows).toEqual([{ owner: 'mes_owner', n: 2 }]);
    const facts = await sql<{ n: number }>`
      SELECT count(*) AS n FROM ingest.equipment_event`.execute(app);
    expect(facts.rows[0]?.n).toBe(2);

    // And the history endpoints' reader gets the legacy rows back.
    const history = await Identity.auditEntries(app, 'handover-note', [String(noteId)]);
    expect(history.map((row) => [row.action, row.username, row.legacy])).toEqual([
      ['note.edit', 'Mehmet', true],
      ['note.create', 'Ayşe', true],
    ]);
    // A second run changes nothing.
    expect((await migrate(db, MIGRATIONS)).applied).toEqual([]);
  });

  it('keeps the migration files of #169 numbered after every file a pre-#169 database has', async () => {
    const files = await readdir(MIGRATIONS);
    expect(files).toContain('0017_public_roles_owners_grants.sql');
    const text = await readFile(join(MIGRATIONS, '0017_public_roles_owners_grants.sql'), 'utf8');
    // The ownership step needs the superuser: it resets the runner's SET LOCAL ROLE first.
    expect(text).toMatch(/^RESET ROLE;$/m);
    expect(DB_ROLES).toEqual({ owner: 'mes_owner', aggregates: 'mes_cagg', app: 'mes_app' });
  });
});
