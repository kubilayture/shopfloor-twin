import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';
import type { AlarmsTables } from '../modules/alarms/index.ts';
import type { EquipmentTables } from '../modules/equipment/index.ts';
import type { IngestTables } from '../modules/ingest/index.ts';
import type { MasterDataTables } from '../modules/master-data/index.ts';

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
export type Database = PublicTables &
  MasterDataTables &
  IngestTables &
  EquipmentTables &
  AlarmsTables;

/**
 * BIGINT columns (epochs, sequence numbers, ids, counts) are read as numbers, not strings: every
 * value the MES stores fits a safe integer (sequence numbers are capped at 2^53 - 1 by the UNS).
 */
const types = new pg.TypeOverrides();
types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
/** BIGINT[] (`_int8`, e.g. `equipment.bucket_finality.incident_ids`): numbers as well. */
const INT8_ARRAY = 1016;
types.setTypeParser(INT8_ARRAY, (value: string) =>
  value === '{}'
    ? []
    : value
        .slice(1, -1)
        .split(',')
        .map((item) => (item === 'NULL' ? null : Number(item))),
);

export interface PoolLimits {
  /** Server-side limit per statement (PostgreSQL `statement_timeout`, SQLSTATE 57014). */
  readonly statementTimeoutMs?: number;
  /** How long a query waits for a free connection of the pool. */
  readonly connectionTimeoutMs?: number;
}

export function createDatabase(
  url: string,
  maxConnections = 10,
  limits: PoolLimits = {},
): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: url,
    max: maxConnections,
    types,
    ...(limits.statementTimeoutMs === undefined
      ? {}
      : { statement_timeout: limits.statementTimeoutMs }),
    ...(limits.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: limits.connectionTimeoutMs }),
  });
  // An idle connection that the server closes (a database restart) is dropped from the pool; the
  // next query reconnects or fails where it is handled. Unhandled, the event would end the process.
  pool.on('error', () => undefined);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
