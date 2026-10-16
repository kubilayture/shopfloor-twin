import { sql, type Kysely } from 'kysely';
import { MES_SCHEMAS } from './columns.ts';
import type { Database } from './database.ts';
import { DB_ROLES } from './roles.ts';

/** A table privilege as PostgreSQL names it. */
export type TablePrivilege =
  'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER';
/** A schema privilege. */
export type SchemaPrivilege = 'USAGE' | 'CREATE';

const ALL = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
/** Append-only tables (a trigger refuses the rest for every role besides). */
const APPEND = ['SELECT', 'INSERT'] as const;
const READ = ['SELECT'] as const;

/**
 * Every grant of `mes_app` (#169, ADR-0027), per table and view: typed from `Database`, so a table
 * added to the types without its grants fails to compile. A test compares it with the database.
 */
export type AppGrants = { readonly [T in keyof Database]: readonly TablePrivilege[] };

export const DECLARED_GRANTS: {
  readonly schemas: Readonly<Record<string, Readonly<Record<string, readonly SchemaPrivilege[]>>>>;
  readonly tables: {
    readonly mes_app: AppGrants;
    readonly mes_cagg: Readonly<Partial<Record<keyof Database, readonly TablePrivilege[]>>>;
  };
} = {
  // USAGE, never CREATE: neither role can add an object to a module schema. The owner has the rest.
  schemas: {
    mes_app: {
      master_data: ['USAGE'],
      ingest: ['USAGE'],
      equipment: ['USAGE'],
      alarms: ['USAGE'],
      shifts: ['USAGE'],
      identity: ['USAGE'],
    },
    mes_cagg: { ingest: ['USAGE'], equipment: ['USAGE'] },
  },
  tables: {
    mes_app: {
      'public.schema_migrations': READ,
      'master_data.site': ALL,
      'master_data.area': ALL,
      'master_data.work_center': ALL,
      'master_data.equipment': ALL,
      'master_data.product': ALL,
      'master_data.shift_pattern': ALL,
      'master_data.reason_code': ALL,
      'master_data.alarm_position': ALL,
      'master_data.alarm_position_work_center': ALL,
      'master_data.alarm_definition': ALL,
      'ingest.equipment_event': ALL,
      'ingest.telemetry_sample': ALL,
      'ingest.source_cursor': ALL,
      'ingest.state_anchor': ALL,
      'ingest.data_quality_incident': ALL,
      'ingest.component_status': ALL,
      'ingest.rejected_message': ALL,
      'ingest.alarm_anchor': ALL,
      'ingest.alarm_snapshot': ALL,
      // Owned by mes_cagg, which granted it: without it a read is 42501.
      'ingest.cycle_hourly': READ,
      'equipment.bucket_finality': ALL,
      'equipment.equipment_state_interval': ALL,
      'equipment.interval_source': ALL,
      'equipment.downtime_record': ALL,
      'equipment.downtime_coding_set': ALL,
      'equipment.downtime_coding': ALL,
      // Frozen (0018): the audit is identity.audit_log.
      'equipment.downtime_audit': READ,
      'equipment.state_hourly': READ,
      'alarms.alarm_occurrence': ALL,
      'alarms.occurrence_source': ALL,
      'alarms.kpi_revision': ALL,
      'alarms.occurrence_state': APPEND,
      'alarms.alarm_shelf': ALL,
      'alarms.alarm_transition': APPEND,
      'shifts.shift_instance': ALL,
      // Retracted, never deleted (ADR-0025).
      'shifts.handover_note': ['SELECT', 'INSERT', 'UPDATE'],
      'shifts.handover_audit': READ,
      'shifts.crew_assignment': ALL,
      'identity.role': ALL,
      'identity.user_account': ALL,
      'identity.user_role': ALL,
      'identity.session': ALL,
      'identity.audit_log': APPEND,
    },
    // The aggregates' sources, which a refresh reads; the aggregates themselves it owns.
    mes_cagg: {
      'equipment.equipment_state_interval': READ,
      'ingest.equipment_event': READ,
    },
  },
};

/** One grant as the database has it: role, object (`schema` or `schema.table`), privilege. */
export interface Grant {
  readonly role: string;
  readonly object: string;
  readonly privilege: string;
}

const ROLES = [DB_ROLES.app, DB_ROLES.aggregates] as const;

/** Every declared grant as a sorted list. */
export function declaredGrants(): Grant[] {
  const grants: Grant[] = [];
  for (const [role, schemas] of Object.entries(DECLARED_GRANTS.schemas)) {
    for (const [object, privileges] of Object.entries(schemas)) {
      for (const privilege of privileges) grants.push({ role, object, privilege });
    }
  }
  for (const [role, tables] of Object.entries(DECLARED_GRANTS.tables)) {
    for (const [object, privileges] of Object.entries(tables) as [string, TablePrivilege[]][]) {
      for (const privilege of privileges) grants.push({ role, object, privilege });
    }
  }
  return sortGrants(grants);
}

const sortGrants = (grants: Grant[]): Grant[] =>
  grants.sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      a.object.localeCompare(b.object) ||
      a.privilege.localeCompare(b.privilege),
  );

/**
 * The grants to `mes_app` and `mes_cagg` the database has, from the ACLs of the MES schemas and of
 * their tables and views (the aggregates included), without an owner's own rights. TimescaleDB's `_timescaledb_internal` (chunks
 * and materialisation tables, which inherit and whose names aren't stable) is not a MES schema.
 */
export async function actualGrants(db: Kysely<Database>): Promise<Grant[]> {
  const schemas = [...MES_SCHEMAS];
  const roles = [...ROLES];
  const result = await sql<Grant>`
    SELECT r.rolname AS role, n.nspname AS object, acl.privilege_type AS privilege
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(n.nspacl) AS acl
    JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname IN (${sql.join(schemas)}) AND r.rolname IN (${sql.join(roles)})
      AND acl.grantee <> n.nspowner
    UNION ALL
    SELECT r.rolname, n.nspname || '.' || c.relname, acl.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
    JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname IN (${sql.join(schemas)}) AND c.relkind IN ('r', 'p', 'v', 'm')
      AND r.rolname IN (${sql.join(roles)}) AND acl.grantee <> c.relowner`.execute(db);
  return sortGrants(result.rows);
}

/** Owners of the MES's schemas, tables, views, sequences and functions, by object. */
export async function actualOwners(db: Kysely<Database>): Promise<Record<string, string>> {
  const schemas = [...MES_SCHEMAS].filter((s) => s !== 'public');
  const result = await sql<{ object: string; owner: string }>`
    SELECT n.nspname AS object, n.nspowner::regrole::text AS owner FROM pg_namespace n
    WHERE n.nspname IN (${sql.join(schemas)})
    UNION ALL
    SELECT n.nspname || '.' || c.relname, c.relowner::regrole::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE (n.nspname IN (${sql.join(schemas)}) OR (n.nspname = 'public' AND c.relname = 'schema_migrations'))
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    UNION ALL
    SELECT n.nspname || '.' || p.proname || '()', p.proowner::regrole::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN (${sql.join(schemas)})
    ORDER BY 1`.execute(db);
  return Object.fromEntries(result.rows.map((row) => [row.object, row.owner]));
}
