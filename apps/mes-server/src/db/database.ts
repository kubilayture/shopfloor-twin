import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';

/** Tables of `public` that the MES itself owns (module schemas add their own types). */
export interface SchemaMigrationsTable {
  name: string;
  checksum: string;
  applied_at: Generated<Date>;
}

export interface PublicTables {
  'public.schema_migrations': SchemaMigrationsTable;
}

/** The database as Kysely sees it; each module's tables join this type as the module arrives. */
export type Database = PublicTables;

export function createDatabase(url: string, maxConnections = 10): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url, max: maxConnections }),
    }),
  });
}
