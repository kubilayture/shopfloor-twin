import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { createDatabase, type Database } from './database.ts';
import { migrate } from './migrate.ts';

export const DATA_MODEL_FILE = resolve(import.meta.dirname, '../../../../docs/data-model.md');
export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../db/migrations');

/** The MES schemas in the order the document lists them, with the module that owns each. */
const SCHEMAS: readonly { name: string; owner: string; about: string }[] = [
  {
    name: 'master_data',
    owner: 'master-data',
    about:
      'The ISA-95 equipment hierarchy, products, the shift pattern and the downtime reason tree, seeded from `config/plant`.',
  },
  {
    name: 'ingest',
    owner: 'ingest',
    about:
      'Every UNS message the MES receives, stored idempotently (ADR-0015, ADR-0017), with dedup state, data-quality incidents and rejected messages.',
  },
  {
    name: 'equipment',
    owner: 'equipment',
    about:
      'State intervals built from the state facts, cut at UTC hours and shift buckets (ADR-0018): the basis of OEE; and the downtime records derived from them (ADR-0021).',
  },
  {
    name: 'public',
    owner: 'the migration runner',
    about: 'Bookkeeping of the migration runner (ADR-0016).',
  },
];

/**
 * One short line per table and view. The migrations' SQL comments hold the detail; a table or view
 * missing here (or a stale entry) fails generation, so every new one gets a description.
 */
const TABLES: Readonly<Record<string, string>> = {
  'master_data.site': 'The site and its enterprise (ISA-95 levels 4 and 3).',
  'master_data.area': 'Areas of the site.',
  'master_data.work_center': 'Work centers (lines) of an area.',
  'master_data.equipment':
    'The machines, with their operation, interface and position in the line.',
  'master_data.product': 'Products and their ideal cycle time per operation.',
  'master_data.shift_pattern': 'The shift pattern: time zone, workdays and shifts.',
  'master_data.reason_code':
    'The downtime reason tree from reasons.yaml: id (its path), parent and name; inactive once the configuration drops it (#119).',
  'ingest.equipment_event':
    'Device facts (state changes, cycles, alarm transitions), one stream per equipment; deduplicated by the unique key.',
  'ingest.telemetry_sample': 'Sampled process values, one stream per telemetry topic.',
  'ingest.source_cursor':
    'Durable dedup and gap state per stream: current epoch, sequence ranges seen, gaps already reported.',
  'ingest.state_anchor':
    'Retained deliveries and state snapshots: the starting state of an (equipment, device epoch) when no fact gives one yet.',
  'ingest.data_quality_incident':
    'Sequence gaps found by the MES and incidents reported by the gateway.',
  'ingest.component_status': 'Latest online/offline status of each component (last will).',
  'ingest.rejected_message':
    'Messages that failed validation, came with a stale epoch or could not be stored: never dropped silently.',
  'equipment.equipment_state_interval':
    'State intervals cut into pieces inside one UTC hour and one shift bucket; the open interval is stored up to the plant watermark. A piece is provisional while it ends after the time its machine’s own facts have settled (#113).',
  'equipment.bucket_finality':
    'Per (equipment, epoch, UTC hour): when the hour became final, its revision (raised by each change after that) and the gap incidents over it.',
  'equipment.downtime_record':
    'Downtime records: one per availability-loss interval per scheduled shift bucket, keyed by its start in the bucket, with the auto reason; derived and rebuilt with the intervals (#119).',
  'equipment.interval_source':
    'What the stored intervals of each (equipment, epoch) were computed from, so start-up catch-up can recompute what differs.',
  'equipment.state_hourly':
    'Time per state (and its provisional part) per (equipment, epoch, UTC hour, shift bucket), from the pieces: an input of OEE (#118, ADR-0022).',
  'ingest.cycle_hourly':
    'Completed cycles per (equipment, epoch, UTC hour, product, result), from the cycle facts: an input of OEE (#118, ADR-0022).',
  'public.schema_migrations': 'Applied migrations and their checksums.',
};

interface TableRow {
  schema: string;
  name: string;
  comment: string | null;
}
interface ColumnRow {
  table: string;
  name: string;
  type: string;
  not_null: boolean;
  default_value: string | null;
  identity: string;
}
interface ConstraintRow {
  table: string;
  name: string;
  kind: string;
  definition: string;
  /** The constrained columns, in key order. */
  columns: string;
  /** Foreign keys: the referenced table, and whether every referencing column is NOT NULL. */
  ref_table: string | null;
  required: boolean;
}
interface IndexRow {
  table: string;
  name: string;
  definition: string;
}
interface ViewRow {
  schema: string;
  name: string;
  definition: string;
}
interface AggregateRow {
  view: string;
  hypertable: string;
  materialized_only: boolean;
  bucket_width: string | null;
  /** The aggregate's own query (the view itself is a union with its materialisation). */
  definition: string;
}
interface DimensionRow {
  table: string;
  column_name: string;
  dimension_type: string;
  time_interval: string | null;
  num_partitions: number | null;
}

/** A table cell: pipes and newlines would break the row. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const code = (text: string): string => `\`${cell(text)}\``;

const CONSTRAINT_KINDS: readonly [string, string][] = [
  ['p', 'Primary key'],
  ['u', 'Unique'],
  ['f', 'Foreign key'],
  ['c', 'Check'],
  ['x', 'Exclusion'],
];

/**
 * The data model of a migrated database as Markdown, from `pg_catalog` and TimescaleDB's
 * information views. Sorted throughout and free of names, times and versions that vary between
 * runs, so the committed file can be checked for drift.
 */
export async function generateDataModel(db: Kysely<Database>): Promise<string> {
  const schemas = SCHEMAS.map((s) => s.name);
  const tables = (
    await sql<TableRow>`
      SELECT n.nspname AS schema, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${sql.join(schemas)}) AND c.relkind IN ('r', 'p')
      ORDER BY n.nspname, c.relname`.execute(db)
  ).rows;
  const columns = (
    await sql<ColumnRow>`
      SELECT n.nspname || '.' || c.relname AS "table", a.attname AS name,
        format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
        pg_get_expr(d.adbin, d.adrelid) AS default_value, a.attidentity::text AS identity
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname IN (${sql.join(schemas)}) AND c.relkind IN ('r', 'p', 'v')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1, a.attnum`.execute(db)
  ).rows;
  const constraints = (
    await sql<ConstraintRow>`
      SELECT n.nspname || '.' || c.relname AS "table", k.conname AS name, k.contype::text AS kind,
        pg_get_constraintdef(k.oid) AS definition,
        (SELECT string_agg(a.attname, ', ' ORDER BY u.ord)
          FROM unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS columns,
        (SELECT rn.nspname || '.' || r.relname FROM pg_class r
          JOIN pg_namespace rn ON rn.oid = r.relnamespace WHERE r.oid = k.confrelid) AS ref_table,
        (SELECT coalesce(bool_and(a.attnotnull), false) FROM unnest(k.conkey) AS u(attnum)
          JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS required
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${sql.join(schemas)}) AND k.contype <> 'n'
      ORDER BY 1, 2`.execute(db)
  ).rows;
  // Indexes that back a primary key or unique constraint are listed with the constraint.
  const indexes = (
    await sql<IndexRow>`
      SELECT n.nspname || '.' || c.relname AS "table", i.relname AS name,
        pg_get_indexdef(x.indexrelid) AS definition
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${sql.join(schemas)})
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid)
      ORDER BY 1, 2`.execute(db)
  ).rows;
  const dimensions = (
    await sql<DimensionRow>`
      SELECT hypertable_schema || '.' || hypertable_name AS "table", column_name,
        dimension_type::text AS dimension_type, time_interval::text AS time_interval,
        num_partitions
      FROM timescaledb_information.dimensions
      WHERE hypertable_schema IN (${sql.join(schemas)})
      ORDER BY 1, dimension_number`.execute(db)
  ).rows;
  const views = (
    await sql<ViewRow>`
      SELECT n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid, true) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${sql.join(schemas)}) AND c.relkind = 'v'
      ORDER BY n.nspname, c.relname`.execute(db)
  ).rows;
  // TimescaleDB's own (materialisation) objects live in `_timescaledb_internal` and stay out.
  const aggregates = (
    await sql<AggregateRow>`
      SELECT a.view_schema || '.' || a.view_name AS view,
        a.hypertable_schema || '.' || a.hypertable_name AS hypertable,
        a.materialized_only, b.bucket_width::text AS bucket_width, a.view_definition AS definition
      FROM timescaledb_information.continuous_aggregates a
      JOIN _timescaledb_catalog.continuous_agg c
        ON c.user_view_schema = a.view_schema AND c.user_view_name = a.view_name
      LEFT JOIN _timescaledb_catalog.continuous_aggs_bucket_function b
        ON b.mat_hypertable_id = c.mat_hypertable_id
      WHERE a.view_schema IN (${sql.join(schemas)})
      ORDER BY 1`.execute(db)
  ).rows;

  const names = [...tables, ...views].map((t) => `${t.schema}.${t.name}`);
  const undescribed = names.filter((name) => !(name in TABLES));
  const stale = Object.keys(TABLES).filter((name) => !names.includes(name));
  if (undescribed.length > 0 || stale.length > 0) {
    throw new Error(
      `data-model.ts TABLES is out of step with the database: describe ${undescribed.join(', ') || '-'}; remove ${stale.join(', ') || '-'}`,
    );
  }

  const byTable = <T extends { table: string }>(rows: readonly T[], table: string): T[] =>
    rows.filter((row) => row.table === table);

  const out: string[] = [
    '# Data model',
    '',
    '<!-- Generated by apps/mes-server/src/db/data-model.ts; do not edit by hand. -->',
    '',
    'The MES database after all migrations in `db/migrations`, read from the database itself (`pg_catalog` and `timescaledb_information`). Regenerate with `pnpm --filter @shopfloor/mes-server data-model`; a test in `apps/mes-server/src/db/db.test.ts` fails when this file is out of date.',
    '',
    'Each schema belongs to exactly one module of `mes-server` (ADR-0016), and so do its views. Modules read each other only through their interfaces, so there are no foreign keys between schemas: a column named `equipment` holds a `master_data.equipment.id` by convention, and `ingest.state_anchor.arrival` is referenced from `equipment.interval_source.anchor_arrival` the same way, as are `ingest.data_quality_incident` ids from `equipment.bucket_finality.incident_ids`. Times are simulation time unless a column says otherwise (`received_at`, `ingested_at`, `recorded_at`, `updated_at`, `final_at`, `revised_at` and `applied_at` are wall time).',
    '',
    '## Contents',
    '',
  ];
  for (const schema of SCHEMAS) {
    out.push(`- [\`${schema.name}\`](#schema-${schema.name})`);
    for (const table of tables.filter((t) => t.schema === schema.name)) {
      out.push(`  - \`${schema.name}.${table.name}\``);
    }
    for (const view of views.filter((v) => v.schema === schema.name)) {
      out.push(`  - \`${schema.name}.${view.name}\` (view)`);
    }
  }
  out.push(
    '',
    '## Hypertables',
    '',
    '| Table | Partitioned by | Chunk interval |',
    '| --- | --- | --- |',
  );
  for (const d of dimensions) {
    out.push(
      `| ${code(d.table)} | ${code(d.column_name)} | ${d.dimension_type === 'Time' ? (d.time_interval ?? '') : `${String(d.num_partitions)} space partitions`} |`,
    );
  }
  out.push(
    '',
    'A unique key or primary key on a hypertable must include its partitioning column (a TimescaleDB rule), which is why the fact tables are unique on `(…, seq, source_time)`.',
    '',
    '## Continuous aggregates',
    '',
    '| View | Over | Bucket | Real-time |',
    '| --- | --- | --- | --- |',
  );
  for (const a of aggregates) {
    out.push(
      `| ${code(a.view)} | ${code(a.hypertable)} | ${a.bucket_width ?? ''} | ${a.materialized_only ? 'no (`materialized_only = true`)' : 'yes (`materialized_only = false`)'} |`,
    );
  }
  out.push(
    '',
    'Real-time: rows below the aggregate’s watermark come from its materialisation, rows above it from the table. There are no refresh policies: the owning module refreshes explicitly (ADR-0022).',
    '',
  );

  // Entity-relationship diagrams: one per schema that has foreign keys, with the key columns.
  const foreignKeys = constraints.filter((c) => c.kind === 'f');
  const entity = (table: string): string => table.split('.')[1] ?? table;
  const mermaidType = (type: string): string =>
    type.replace(/\[\]$/, '_array').replace(/\W+/g, '_');
  out.push('## Relationships', '');
  for (const schema of SCHEMAS) {
    const own = foreignKeys.filter((fk) => fk.table.startsWith(`${schema.name}.`));
    if (own.length === 0) continue;
    const related = [...new Set(own.flatMap((fk) => [fk.table, fk.ref_table ?? '']))].sort();
    out.push(`Schema ${schema.name}:`, '', '```mermaid', 'erDiagram');
    for (const table of related) {
      const keys = byTable(constraints, table).filter((c) => c.kind === 'p' || c.kind === 'f');
      const marks = new Map<string, string>();
      for (const key of keys) {
        for (const column of key.columns.split(', ')) {
          const mark = key.kind === 'p' ? 'PK' : 'FK';
          marks.set(column, marks.has(column) ? `${marks.get(column) ?? ''}, ${mark}` : mark);
        }
      }
      out.push(`  ${entity(table)} {`);
      for (const column of byTable(columns, table).filter((c) => marks.has(c.name))) {
        out.push(`    ${mermaidType(column.type)} ${column.name} ${marks.get(column.name) ?? ''}`);
      }
      out.push('  }');
    }
    for (const fk of own) {
      const parent = fk.ref_table ?? '';
      if (!parent.startsWith(`${schema.name}.`)) {
        throw new Error(`${fk.table}: foreign key into another module's schema (${parent})`);
      }
      out.push(
        `  ${entity(parent)} ${fk.required ? '||' : '|o'}--o{ ${entity(fk.table)} : "${fk.columns}"`,
      );
    }
    out.push('```', '');
  }
  out.push(
    'The other schemas have no foreign keys; their references are by value, as described above.',
    '',
  );

  for (const schema of SCHEMAS) {
    out.push(`## Schema ${schema.name}`, '', `Owner: ${schema.owner}. ${schema.about}`, '');
    for (const table of tables.filter((t) => t.schema === schema.name)) {
      const full = `${table.schema}.${table.name}`;
      out.push(`### ${full}`, '', TABLES[full] ?? '');
      if (table.comment) out.push('', `Comment: ${table.comment}`);
      const dims = byTable(dimensions, full);
      if (dims.length > 0) {
        const parts = dims.map((d) =>
          d.dimension_type === 'Time'
            ? `\`${d.column_name}\` in chunks of ${d.time_interval ?? '?'}`
            : `\`${d.column_name}\` in ${String(d.num_partitions)} space partitions`,
        );
        out.push('', `TimescaleDB hypertable, partitioned by ${parts.join(', ')}.`);
      }
      out.push('', '| Column | Type | Null | Default |', '| --- | --- | --- | --- |');
      for (const column of byTable(columns, full)) {
        const fallback =
          column.identity === 'a'
            ? 'generated always as identity'
            : column.identity === 'd'
              ? 'generated by default as identity'
              : '';
        const value = column.default_value ?? fallback;
        out.push(
          `| ${code(column.name)} | ${code(column.type)} | ${column.not_null ? 'not null' : 'null'} | ${value === '' ? '' : code(value)} |`,
        );
      }
      const own = byTable(constraints, full);
      const tableIndexes = byTable(indexes, full);
      if (own.length > 0 || tableIndexes.length > 0) {
        out.push('', '| Kind | Name | Definition |', '| --- | --- | --- |');
        for (const [kind, label] of CONSTRAINT_KINDS) {
          for (const c of own.filter((row) => row.kind === kind)) {
            out.push(`| ${label} | ${code(c.name)} | ${code(c.definition)} |`);
          }
        }
        for (const index of tableIndexes) {
          const definition = index.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, '');
          out.push(`| Index | ${code(index.name)} | ${code(definition)} |`);
        }
      }
      out.push('');
    }
    for (const view of views.filter((v) => v.schema === schema.name)) {
      const full = `${view.schema}.${view.name}`;
      const aggregate = aggregates.find((a) => a.view === full);
      out.push(`### ${full}`, '', TABLES[full] ?? '', '');
      out.push(
        aggregate
          ? `TimescaleDB continuous aggregate over \`${aggregate.hypertable}\`, in buckets of ${aggregate.bucket_width ?? '?'}, ${aggregate.materialized_only ? 'materialised rows only' : 'real-time'} (\`materialized_only = ${String(aggregate.materialized_only)}\`).`
          : 'View.',
      );
      out.push('', '| Column | Type |', '| --- | --- |');
      for (const column of byTable(columns, full)) {
        out.push(`| ${code(column.name)} | ${code(column.type)} |`);
      }
      out.push('', '```sql', (aggregate?.definition ?? view.definition).trim(), '```', '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

if (import.meta.main) {
  const { startDatabase } = await import('../testing.ts');
  const { url, container } = await startDatabase();
  const db = createDatabase(url, 1);
  try {
    await migrate(db, MIGRATIONS_DIR);
    const generated = await generateDataModel(db);
    if (process.argv.includes('--check')) {
      if ((await readFile(DATA_MODEL_FILE, 'utf8').catch(() => '')) !== generated) {
        console.error(
          `${DATA_MODEL_FILE} is out of date; run pnpm --filter @shopfloor/mes-server data-model`,
        );
        process.exitCode = 1;
      }
    } else {
      await writeFile(DATA_MODEL_FILE, generated);
      console.log(`wrote ${DATA_MODEL_FILE}`);
    }
  } finally {
    await db.destroy();
    await container.stop();
  }
}
