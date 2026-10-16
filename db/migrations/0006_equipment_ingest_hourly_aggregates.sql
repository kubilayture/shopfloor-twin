-- Phase 5 (#118): hourly continuous aggregates, the inputs of OEE (ADR-0022). Each lives in the
-- schema of the module that owns its data (ADR-0016), so this one migration touches two schemas:
-- equipment.state_hourly over equipment's pieces, ingest.cycle_hourly over ingest's cycle facts.
--
-- Both are real-time (materialized_only = false): rows below an aggregate's watermark come from
-- its materialisation, rows above it from the raw table, so the open hour is always read raw.
-- There are no refresh policies (their windows follow wall-clock now(), but simulation time runs
-- ahead of wall time and goes back under a new epoch). The owning module refreshes explicitly,
-- off ingest's acknowledgement path: every change below the watermark marks its hour dirty, and
-- a refresh covers [earliest dirty hour, max(latest dirty hour, latest final hour) + 1 h), plus a
-- catch-up refresh at start-up. Created WITH NO DATA, which TimescaleDB allows in the runner's
-- transaction.

-- Time per state per (equipment, device epoch, UTC hour, shift bucket). Pieces never cross an
-- hour or a shift bucket and their ends are whole milliseconds, so `ms` is exact.
CREATE MATERIALIZED VIEW equipment.state_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  equipment,
  epoch,
  time_bucket(INTERVAL '1 hour', start_time) AS hour,
  shift_key,
  state,
  sum((extract(epoch FROM end_time - start_time) * 1000)::bigint)::bigint AS ms,
  -- The part of `ms` in provisional pieces: what may still change (#113).
  sum(
    CASE WHEN provisional THEN (extract(epoch FROM end_time - start_time) * 1000)::bigint ELSE 0 END
  )::bigint AS provisional_ms
FROM equipment.equipment_state_interval
GROUP BY equipment, epoch, time_bucket(INTERVAL '1 hour', start_time), shift_key, state
WITH NO DATA;

-- Completed cycles per (equipment, device epoch, UTC hour, product, result). Cycles carry no
-- shift bucket: shifts start and end on whole hours (plant-config), so the hour names it.
CREATE MATERIALIZED VIEW ingest.cycle_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  equipment,
  epoch,
  time_bucket(INTERVAL '1 hour', source_time) AS hour,
  payload -> 'value' ->> 'product' AS product,
  payload -> 'value' ->> 'result' AS result,
  count(*) AS cycles
FROM ingest.equipment_event
WHERE event_type = 'cycle'
GROUP BY
  equipment,
  epoch,
  time_bucket(INTERVAL '1 hour', source_time),
  payload -> 'value' ->> 'product',
  payload -> 'value' ->> 'result'
WITH NO DATA;

-- The hour's cycle count when it became final, kept up to date by later cycles the module hears
-- of (each raises the revision). At start-up the module compares it with ingest.cycle_hourly
-- (through ingest's interface) and raises the revision of an hour whose count changed unheard: a
-- cycle whose notice was missed. Null for hours recorded before this migration: filled in at the
-- next start-up without a revision.
ALTER TABLE equipment.bucket_finality ADD COLUMN cycles BIGINT CHECK (cycles >= 0);
