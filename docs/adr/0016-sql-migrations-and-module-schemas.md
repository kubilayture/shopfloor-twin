# ADR-0016: Plain SQL migrations, one PostgreSQL schema per MES module

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (#93), from the Phase 4 plan; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

The MES needs a database schema that evolves safely over ten phases. Plan section 6 chooses Kysely with SQL migrations, and section 7 a modular monolith whose modules own their tables. How are migrations written and applied, and how is table ownership made visible?

## Considered options

1. Kysely's built-in migrator, with migrations written in TypeScript.
2. A migration tool (node-pg-migrate, dbmate, Flyway).
3. Plain SQL files in `db/migrations/`, applied by a small runner in `mes-server`.

## Decision outcome

Chosen option: 3.

- **Files:** `db/migrations/NNNN_<module>_<what>.sql` (plan section 8), applied in number order. A name that breaks the pattern, or a number used twice, stops the runner.
- **Each migration runs in its own transaction**, so a failing one leaves no half-built schema. A file may not contain `BEGIN` or `COMMIT`. A file marked `-- migrate:no-transaction` (for `CREATE INDEX CONCURRENTLY` and the like) runs outside a transaction, statement by statement (split after lines ending with `;`, so no dollar-quoted bodies), and must be written so that it can be rerun.
- **Checksums** are taken over the text with LF line endings and without a BOM, and `.gitattributes` keeps migrations LF, so a Windows checkout doesn't look like an edited file.
- **History:** `public.schema_migrations` records each file's name and SHA-256. The runner refuses to start if an applied file has changed (fix forward with a new migration instead), or if the database knows a migration the code doesn't (an older version against a newer database).
- **One runner at a time:** a PostgreSQL advisory lock makes concurrent MES instances wait for each other, up to 120 s, instead of racing.
- **Automatic:** `mes-server` migrates at start-up and reports ready only afterwards. `pnpm --filter @shopfloor/mes-server migrate` runs the same migrations by hand.
- **Module schemas:** `master_data`, `ingest` and `equipment` (Phase 4), with more as modules arrive. A module's tables live only in its schema, and the migration's file name names the module. Kysely table types are written by hand per module. A column list typed from them (`DECLARED_COLUMNS`) must name every table and column, or `tsc` fails. A test compares it with `information_schema` and flags tables in the module schemas that aren't declared. Column _types_ are not compared.

Option 1 puts SQL inside TypeScript strings and hides TimescaleDB DDL (hypertables, continuous aggregates) behind a builder that doesn't support it. Option 2 adds a dependency, or a JVM, for what is about 80 lines here.

### Consequences

- Good: migrations are plain SQL, readable and reviewable like the schema itself, with TimescaleDB features used directly; schemas make module ownership visible in every query.
- Good: a changed migration or a version mismatch stops the start instead of corrupting data.
- Bad: no down-migrations. Rolling back means a new forward migration, the usual practice for production databases anyway.
- Bad: types are maintained by hand, and the drift checks catch missing or extra tables and columns, not column types.
