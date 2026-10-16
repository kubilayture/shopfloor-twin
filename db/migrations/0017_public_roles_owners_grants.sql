-- public (Phase 7, #169, ADR-0027): database roles. The runner (`migrate`, connected as the image's
-- bootstrap superuser) has created the roles before this file runs:
--   mes_owner  NOLOGIN: owns every schema, table, view, function and trigger of the MES;
--   mes_cagg   NOLOGIN: owns only the two continuous aggregates, the one role that may refresh
--              them (TimescaleDB: "must be owner of continuous aggregate");
--   mes_app    LOGIN:   what the MES connects as; owns nothing, gets the grants below, and is a
--              member of mes_cagg WITH INHERIT FALSE, SET TRUE, so it has none of mes_cagg's
--              rights until the aggregate refresher runs SET ROLE mes_cagg (ADR-0022 amendment).
-- Every migration runs under SET LOCAL ROLE mes_owner. This one first takes the objects over, which
-- needs the superuser, so it resets the role.
RESET ROLE;

-- 1. Ownership (plan M1). A database migrated up to 0016 before #169 has everything owned by the
-- bootstrap user; REASSIGN OWNED can't move it ("required by the database system", 2BP01), so each
-- object is moved on its own: schemas, tables and views (a hypertable carries its chunks), sequences
-- that no column owns (an identity sequence follows its table), and functions. Objects that belong
-- to an extension (TimescaleDB's own in `public`) and the aggregates (step 2) are left alone. On a
-- fresh database (migrated as mes_owner from 0001) nothing but the runner's history table moves.
-- (BEGIN shares its line with DECLARE: the runner refuses a line that starts with BEGIN.)
DO $$ DECLARE item record; BEGIN
  FOR item IN
    SELECT n.nspname FROM pg_namespace n
    WHERE n.nspname IN ('master_data', 'ingest', 'equipment', 'alarms', 'shifts', 'identity')
      AND n.nspowner <> 'mes_owner'::regrole
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO mes_owner', item.nspname);
  END LOOP;
  FOR item IN
    SELECT c.oid::regclass AS name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relowner <> 'mes_owner'::regrole
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND (
        n.nspname IN ('master_data', 'ingest', 'equipment', 'alarms', 'shifts', 'identity')
        OR (n.nspname = 'public' AND c.relname = 'schema_migrations')
      )
      AND NOT EXISTS (
        SELECT 1 FROM _timescaledb_catalog.continuous_agg a
        WHERE a.user_view_schema = n.nspname AND a.user_view_name = c.relname
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
          AND (d.deptype = 'e' OR (c.relkind = 'S' AND d.deptype IN ('a', 'i')))
      )
    ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format(
      CASE item.relkind
        WHEN 'v' THEN 'ALTER VIEW %s OWNER TO mes_owner'
        WHEN 'm' THEN 'ALTER MATERIALIZED VIEW %s OWNER TO mes_owner'
        WHEN 'S' THEN 'ALTER SEQUENCE %s OWNER TO mes_owner'
        ELSE 'ALTER TABLE %s OWNER TO mes_owner'
      END,
      item.name
    );
  END LOOP;
  FOR item IN
    SELECT p.oid::regprocedure AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('master_data', 'ingest', 'equipment', 'alarms', 'shifts', 'identity')
      AND p.proowner <> 'mes_owner'::regrole
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO mes_owner', item.name);
  END LOOP;
END $$;

-- 2. The continuous aggregates (plan B1, probed on TimescaleDB 2.30.2-pg18): only an aggregate's
-- owner may refresh it, and no function, procedure or transaction can wrap the refresh, so they
-- belong to mes_cagg. Moved as superuser (mes_cagg has no CREATE on the schema, so it can't create
-- them itself); the materialisation hypertable and the internal views follow. After the move only
-- the new owner can grant on them, so mes_app's SELECT is granted as mes_cagg. mes_cagg reads the
-- sources (a refresh fails on the source without it) and has USAGE, never CREATE, on their schemas.
ALTER MATERIALIZED VIEW equipment.state_hourly OWNER TO mes_cagg;
ALTER MATERIALIZED VIEW ingest.cycle_hourly OWNER TO mes_cagg;
GRANT USAGE ON SCHEMA equipment, ingest TO mes_cagg;
GRANT SELECT ON equipment.equipment_state_interval, ingest.equipment_event TO mes_cagg;
SET ROLE mes_cagg;
GRANT SELECT ON equipment.state_hourly, ingest.cycle_hourly TO mes_app;
RESET ROLE;

-- 3. mes_app (the MES). USAGE on the module schemas, never CREATE: it can't add an object, and as
-- it owns none it can't alter, disable a trigger of or truncate one (42501). The table grants are
-- listed per role and object in DECLARED_GRANTS (apps/mes-server/src/db/grants.ts); a test compares
-- them with the database. From here on each migration grants what its own objects need.
GRANT USAGE ON SCHEMA master_data, ingest, equipment, alarms, shifts, identity TO mes_app;
-- Ordinary tables: read and write.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  master_data.site,
  master_data.area,
  master_data.work_center,
  master_data.equipment,
  master_data.product,
  master_data.shift_pattern,
  master_data.reason_code,
  master_data.alarm_position,
  master_data.alarm_position_work_center,
  master_data.alarm_definition,
  ingest.equipment_event,
  ingest.telemetry_sample,
  ingest.source_cursor,
  ingest.state_anchor,
  ingest.data_quality_incident,
  ingest.component_status,
  ingest.rejected_message,
  ingest.alarm_anchor,
  ingest.alarm_snapshot,
  equipment.bucket_finality,
  equipment.equipment_state_interval,
  equipment.interval_source,
  equipment.downtime_record,
  equipment.downtime_coding_set,
  equipment.downtime_coding,
  alarms.alarm_occurrence,
  alarms.occurrence_source,
  alarms.kpi_revision,
  alarms.alarm_shelf,
  shifts.shift_instance,
  identity.role,
  identity.user_account,
  identity.user_role,
  identity.session
TO mes_app;
-- Notes are retracted, never deleted (ADR-0025): no DELETE.
GRANT SELECT, INSERT, UPDATE ON shifts.handover_note TO mes_app;
-- Append-only (their triggers refuse UPDATE, DELETE and TRUNCATE for every role besides): read and
-- add. The two module audits are frozen by 0018 once their rows are in identity.audit_log.
GRANT SELECT, INSERT ON
  identity.audit_log,
  alarms.alarm_transition,
  alarms.occurrence_state,
  equipment.downtime_audit,
  shifts.handover_audit
TO mes_app;
-- The migration history: the MES is ready only once it equals the MES's own migrations.
GRANT SELECT ON public.schema_migrations TO mes_app;
