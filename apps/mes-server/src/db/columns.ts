import { sql, type Kysely } from 'kysely';
import { ALARMS_COLUMNS } from '../modules/alarms/index.ts';
import { EQUIPMENT_COLUMNS } from '../modules/equipment/index.ts';
import { INGEST_COLUMNS } from '../modules/ingest/index.ts';
import { MASTER_DATA_COLUMNS } from '../modules/master-data/index.ts';
import type { Database } from './database.ts';

/**
 * Every table and view (the continuous aggregates, #118) of `Database` with its columns, in
 * `information_schema` order. Typed from `Database`,
 * so a table or column added to the types without being listed here fails to compile.
 */
export type ColumnSpec = {
  readonly [T in keyof Database]: readonly (keyof Database[T] & string)[];
};

/** Schemas the MES owns: every table in them must be declared. */
export const MES_SCHEMAS = ['public', 'master_data', 'ingest', 'equipment', 'alarms'] as const;

/** Tables and views that exist in the MES schemas, excluding TimescaleDB's own. */
export async function actualTables(db: Kysely<Database>): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
    WHERE table_schema IN (${sql.join([...MES_SCHEMAS])}) AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY name`.execute(db);
  return rows.rows.map((row) => row.name);
}

/** Columns of the given tables as the database has them: the check against type drift. */
export async function actualColumns(
  db: Kysely<Database>,
  tables: readonly string[],
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of tables) {
    const [schema = 'public', name = table] = table.includes('.')
      ? table.split('.')
      : ['public', table];
    const rows = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${name}
      ORDER BY ordinal_position`.execute(db);
    result[table] = rows.rows.map((row) => row.column_name);
  }
  return result;
}

/** The declared columns; every module adds its tables here as it adds them to `Database`. */
export const DECLARED_COLUMNS: ColumnSpec = {
  'public.schema_migrations': ['name', 'checksum', 'applied_at'],
  ...MASTER_DATA_COLUMNS,
  ...INGEST_COLUMNS,
  ...EQUIPMENT_COLUMNS,
  ...ALARMS_COLUMNS,
};
