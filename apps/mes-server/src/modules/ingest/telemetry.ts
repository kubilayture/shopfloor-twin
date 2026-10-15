import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/database.ts';

/** A metric of one equipment's telemetry, with its latest stored sample. */
export interface TelemetryMetric {
  readonly metric: string;
  readonly unit: string;
  readonly latest: { readonly sourceTime: Date; readonly value: number };
}

/** One time bucket of a decimated series: [start, start + bucketMs). */
export interface TelemetryBucket {
  readonly start: Date;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly count: number;
}

export interface TelemetrySeries {
  readonly metric: string;
  readonly buckets: readonly TelemetryBucket[];
}

/**
 * The metrics of one equipment with the latest sample of each, by `sourceTime`. A loose index
 * scan (recursive CTE) over `telemetry_sample_series` visits one row per metric instead of
 * every stored sample.
 */
export async function telemetryMetrics(
  db: Kysely<Database>,
  equipment: string,
): Promise<TelemetryMetric[]> {
  const rows = await sql<{ name: string; unit: string; value: number; source_time: Date }>`
    WITH RECURSIVE names(name) AS (
      (SELECT name FROM ingest.telemetry_sample WHERE equipment = ${equipment}
        ORDER BY name LIMIT 1)
      UNION ALL
      SELECT (SELECT t.name FROM ingest.telemetry_sample t
              WHERE t.equipment = ${equipment} AND t.name > names.name
              ORDER BY t.name LIMIT 1)
      FROM names WHERE names.name IS NOT NULL
    )
    SELECT n.name, l.unit, l.value, l.source_time
    FROM names n
    CROSS JOIN LATERAL (
      SELECT unit, value, source_time FROM ingest.telemetry_sample t
      WHERE t.equipment = ${equipment} AND t.name = n.name
      ORDER BY source_time DESC LIMIT 1
    ) l
    WHERE n.name IS NOT NULL
    ORDER BY n.name`.execute(db);
  return rows.rows.map((row) => ({
    metric: row.name,
    unit: row.unit,
    latest: { sourceTime: row.source_time, value: row.value },
  }));
}

/**
 * Samples of the given metrics in [from, to), decimated server-side: TimescaleDB `time_bucket`
 * with buckets of `bucketMs` aligned on `from`, each with min, max, average and count. Empty
 * buckets are left out.
 */
export async function telemetrySeries(
  db: Kysely<Database>,
  equipment: string,
  metrics: readonly string[],
  from: Date,
  to: Date,
  bucketMs: number,
): Promise<TelemetrySeries[]> {
  if (metrics.length === 0) return [];
  const width = sql`${bucketMs} * interval '1 millisecond'`;
  const rows = await sql<{
    name: string;
    bucket: Date;
    min: number;
    max: number;
    avg: number;
    count: number;
  }>`
    SELECT name, time_bucket(${width}, source_time, origin => ${from}::timestamptz) AS bucket,
      min(value) AS min, max(value) AS max, avg(value) AS avg, count(*) AS count
    FROM ingest.telemetry_sample
    WHERE equipment = ${equipment} AND name IN (${sql.join([...metrics])})
      AND source_time >= ${from} AND source_time < ${to}
    GROUP BY name, bucket
    ORDER BY name, bucket`.execute(db);
  const byMetric = new Map<string, TelemetryBucket[]>(metrics.map((metric) => [metric, []]));
  for (const row of rows.rows) {
    byMetric.get(row.name)?.push({
      start: row.bucket,
      min: row.min,
      max: row.max,
      avg: row.avg,
      count: row.count,
    });
  }
  return [...byMetric].map(([metric, buckets]) => ({ metric, buckets }));
}
