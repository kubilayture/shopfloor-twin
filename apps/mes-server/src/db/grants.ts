import { sql, type Kysely } from 'kysely';
import { MES_SCHEMAS } from './columns.ts';
import type { Database } from './database.ts';

/** A table privilege as PostgreSQL names it. */
export type TablePrivilege =
  'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER';
/** A schema privilege. */
export type SchemaPrivilege = 'USAGE' | 'CREATE';

const ALL = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
/** Append-only tables (a trigger refuses the rest for every role besides). */
const APPEND = ['SELECT', 'INSERT'] as const;
const READ = ['SELECT'] as const;
/** Kept, never deleted. */
const KEEP = ['SELECT', 'INSERT', 'UPDATE'] as const;

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
      orders: ['USAGE'],
      execution: ['USAGE'],
      genealogy: ['USAGE'],
      quality: ['USAGE'],
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
      'master_data.routing': ALL,
      'master_data.routing_operation': ALL,
      'master_data.bom_item': ALL,
      'master_data.scrap_reason': ALL,
      'ingest.equipment_event': ALL,
      'ingest.telemetry_sample': ALL,
      'ingest.source_cursor': ALL,
      'ingest.state_anchor': ALL,
      'ingest.data_quality_incident': ALL,
      'ingest.component_status': ALL,
      'ingest.rejected_message': ALL,
      'ingest.alarm_anchor': ALL,
      'ingest.alarm_snapshot': ALL,
      'ingest.command_result': ALL,
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
      // Orders, commands, messages and incidents are kept, never deleted (#174).
      'orders.erp_cursor': KEEP,
      'orders.production_order': KEEP,
      // Replaced with a new revision of an order only imported.
      'orders.order_operation': ALL,
      'orders.dispatch_command': KEEP,
      // Every delivery; `published_at` set once acknowledged.
      'orders.command_attempt': KEEP,
      'orders.erp_message_log': KEEP,
      'orders.order_incident': KEEP,
      // Confirmations sent are never changed (#175).
      'orders.confirmation': APPEND,
      // Activity intervals are closed, never deleted (#177).
      'orders.operation_activity': KEEP,
      // Units and their records are derived and rebuilt; scrap records and incidents are kept (#175).
      'execution.unit': ALL,
      'execution.operation_record': ALL,
      'execution.scrap_record': KEEP,
      'execution.execution_incident': KEEP,
      // Lots and incidents are kept, never deleted (a lot no longer listed is retired; incidents
      // as execution's, #199 review L7); everything else of the genealogy is derived and rebuilt.
      'genealogy.material_lot': KEEP,
      'genealogy.serial_unit': ALL,
      'genealogy.unit_record': ALL,
      'genealogy.genealogy_link': ALL,
      'genealogy.carton': ALL,
      'genealogy.genealogy_incident': KEEP,
      // SPC (#200): characteristics are seeded and kept; measurements and signal episodes are
      // derived and rebuilt; limit versions are append-only (a trigger refuses the rest).
      'quality.characteristic': KEEP,
      'quality.measurement': ALL,
      'quality.control_limit': APPEND,
      'quality.spc_signal': ALL,
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
 * Every grant the database has on the MES's objects, to any role, PUBLIC included (grantee 0), from
 * the ACLs of the module schemas, of the tables, views, sequences and aggregates in them and in
 * `public` (outside extensions), and of the module schemas' functions where their ACL is not the
 * default; an owner's own rights are left out. TimescaleDB's `_timescaledb_internal` (chunks and
 * materialisation tables, which inherit and whose names aren't stable) is not compared here.
 */
export async function actualGrants(db: Kysely<Database>): Promise<Grant[]> {
  const schemas = [...MES_SCHEMAS];
  const modules = schemas.filter((schema) => schema !== 'public');
  const result = await sql<Grant>`
    SELECT coalesce(r.rolname, 'PUBLIC') AS role, n.nspname AS object,
      acl.privilege_type AS privilege
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(n.nspacl) AS acl
    LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname IN (${sql.join(modules)}) AND acl.grantee <> n.nspowner
    UNION ALL
    SELECT coalesce(r.rolname, 'PUBLIC'), n.nspname || '.' || c.relname, acl.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
    LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname IN (${sql.join(schemas)}) AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND acl.grantee <> c.relowner
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
    UNION ALL
    SELECT coalesce(r.rolname, 'PUBLIC'), p.oid::regprocedure::text, acl.privilege_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) AS acl
    LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname IN (${sql.join(modules)}) AND p.proacl IS NOT NULL
      AND acl.grantee <> p.proowner`.execute(db);
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
