import { sql, type Kysely } from 'kysely';
import type { Database } from './database.ts';

/** Declared columns of a table, in the same order as `information_schema` lists them. */
export type ColumnSpec = Readonly<Record<string, readonly string[]>>;

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

/** Columns declared for the tables in this file's sibling types; extended by every module. */
export const DECLARED_COLUMNS: ColumnSpec = {
  'public.schema_migrations': ['name', 'checksum', 'applied_at'],
};
