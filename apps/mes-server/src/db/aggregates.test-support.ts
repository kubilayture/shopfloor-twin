/** Test support for the hourly aggregates (#118): their rows next to the same sums from raw rows. */
import { sql, type Kysely } from 'kysely';
import type { Database } from './database.ts';

export interface StateHourRow {
  equipment: string;
  epoch: number;
  hour: string;
  shift_key: string;
  state: string;
  ms: number;
  provisional_ms: number;
}

export interface CycleHourRow {
  equipment: string;
  epoch: number;
  hour: string;
  product: string;
  result: string;
  cycles: number;
}

const ORDER = sql`ORDER BY 1, 2, 3, 4, 5`;

/** Every row of `equipment.state_hourly`, as a reader sees it now. */
export async function stateHourly(db: Kysely<Database>): Promise<StateHourRow[]> {
  const result = await sql<StateHourRow>`
    SELECT equipment, epoch, to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS hour,
      shift_key, state, ms, provisional_ms
    FROM equipment.state_hourly ${ORDER}`.execute(db);
  return result.rows;
}

/** The same rows summed from the stored pieces. */
export async function stateHourlyRaw(db: Kysely<Database>): Promise<StateHourRow[]> {
  const result = await sql<StateHourRow>`
    SELECT equipment, epoch,
      to_char(time_bucket(INTERVAL '1 hour', start_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS hour,
      shift_key, state,
      sum((extract(epoch FROM end_time - start_time) * 1000)::bigint)::bigint AS ms,
      sum(CASE WHEN provisional THEN (extract(epoch FROM end_time - start_time) * 1000)::bigint
        ELSE 0 END)::bigint AS provisional_ms
    FROM equipment.equipment_state_interval
    GROUP BY 1, 2, 3, 4, 5 ${ORDER}`.execute(db);
  return result.rows;
}

/** Every row of `ingest.cycle_hourly`, as a reader sees it now. */
export async function cycleHourly(db: Kysely<Database>): Promise<CycleHourRow[]> {
  const result = await sql<CycleHourRow>`
    SELECT equipment, epoch, to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS hour,
      product, result, cycles
    FROM ingest.cycle_hourly ${ORDER}`.execute(db);
  return result.rows;
}

/** The same rows counted from the stored cycle facts. */
export async function cycleHourlyRaw(db: Kysely<Database>): Promise<CycleHourRow[]> {
  const result = await sql<CycleHourRow>`
    SELECT equipment, epoch,
      to_char(time_bucket(INTERVAL '1 hour', source_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS hour,
      payload -> 'value' ->> 'product' AS product, payload -> 'value' ->> 'result' AS result,
      count(*) AS cycles
    FROM ingest.equipment_event WHERE event_type = 'cycle'
    GROUP BY 1, 2, 3, 4, 5 ${ORDER}`.execute(db);
  return result.rows;
}

/** Pieces whose start or end is not a whole millisecond (none: the aggregate's ms are exact). */
export async function fractionalPieces(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*) AS n FROM equipment.equipment_state_interval
    WHERE date_trunc('milliseconds', start_time) <> start_time
      OR date_trunc('milliseconds', end_time) <> end_time`.execute(db);
  return result.rows[0]?.n ?? -1;
}
