-- quality, SPC (Phase 8, #200; plan "SPC", ADR-0032): the characteristics of quality.yaml, their
-- measurements from the leak tester's cycle facts, control limit versions (append-only) and the
-- signal episodes derived from the readings on final data. Points and subgroups are derived on
-- read (no continuous aggregate). Ids of other modules (equipment, units) are kept by value
-- (ADR-0016). Quality holds (#201) join this schema later.
CREATE SCHEMA quality;
GRANT USAGE ON SCHEMA quality TO mes_app;

-- A characteristic, seeded at start-up from quality.yaml (the specification limit and the
-- resolution from process.yaml's leak test). `version` rises with every limit write (409
-- limits-stale); the notice is a late reading inside limit version 1's window (from a written-off
-- gap): version 1 is never re-derived, a quality user decides on a new version.
CREATE TABLE quality.characteristic (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL,
  equipment TEXT NOT NULL,
  operation TEXT NOT NULL,
  unit TEXT NOT NULL,
  resolution DOUBLE PRECISION NOT NULL CHECK (resolution > 0),
  upper_spec DOUBLE PRECISION NOT NULL,
  subgroup_size INTEGER NOT NULL CHECK (subgroup_size BETWEEN 2 AND 10),
  baseline_subgroups INTEGER NOT NULL CHECK (baseline_subgroups >= 1),
  -- Nelson rules enabled per chart: {"I": [1, 2, 5], "MR": [], "Xbar": [1, 2, 5], "R": [1]}.
  rules JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  notice_kind TEXT CHECK (notice_kind IN ('baseline-changed')),
  notice_at TIMESTAMPTZ,
  notice_detail TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((notice_kind IS NULL) = (notice_at IS NULL)),
  CHECK ((notice_kind IS NULL) = (notice_detail IS NULL))
);

-- One reading per cycle fact of the characteristic's machine with a measurement, keyed by the
-- fact; derived and rebuilt per part (a late fact renumbers its part's passes). `steps`: the value
-- in whole steps of the resolution, what SPC charts (first passes only).
CREATE TABLE quality.measurement (
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  characteristic TEXT NOT NULL REFERENCES quality.characteristic (id),
  part_id BIGINT NOT NULL CHECK (part_id >= 1),
  -- 1 for a part's first test; 2 for the retest after a rework.
  pass INTEGER NOT NULL CHECK (pass >= 1),
  measured_at TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  steps BIGINT NOT NULL,
  unit TEXT NOT NULL,
  upper_limit DOUBLE PRECISION NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('good', 'scrap', 'rework')),
  PRIMARY KEY (equipment, epoch, seq),
  UNIQUE (characteristic, epoch, part_id, pass)
);
CREATE INDEX measurement_chart ON quality.measurement (characteristic, epoch, measured_at, seq);

-- Control limit versions as append-only events (ADR-0032): `created` (a version with its frozen
-- limits, window and the first position it applies to; version 1 by `system` at its baseline's
-- last reading) and `ended` (the first position it no longer applies to). Never updated or
-- deleted, whoever connects: a trigger refuses it.
CREATE TABLE quality.control_limit (
  characteristic TEXT NOT NULL REFERENCES quality.characteristic (id),
  -- The event's number per characteristic, from 1.
  n INTEGER NOT NULL CHECK (n >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('created', 'ended')),
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Plant time of the event: `createdAt` or `endedAt` of the version.
  plant_at TIMESTAMPTZ NOT NULL,
  -- `created`: the first position it applies to (null: from the first reading); `ended`: the
  -- first position it no longer applies to.
  position_epoch BIGINT,
  position_at TIMESTAMPTZ,
  position_seq BIGINT,
  -- `created` only: subgroup size, window, counts, statistics and limits per chart, exact
  -- fractions as text (spc-core's ChartLimits).
  limits JSONB,
  comment TEXT,
  actor TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (characteristic, n),
  CHECK ((kind = 'created') = (limits IS NOT NULL)),
  CHECK ((position_epoch IS NULL) = (position_at IS NULL)),
  CHECK ((position_epoch IS NULL) = (position_seq IS NULL)),
  CHECK (kind = 'created' OR position_epoch IS NOT NULL)
);
CREATE UNIQUE INDEX control_limit_version ON quality.control_limit (characteristic, version, kind);

CREATE FUNCTION quality.control_limit_append_only() RETURNS trigger
-- (BEGIN shares its line with AS: the runner refuses a line that starts with BEGIN.)
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'quality.control_limit is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER control_limit_no_update_delete
  BEFORE UPDATE OR DELETE ON quality.control_limit
  FOR EACH ROW EXECUTE FUNCTION quality.control_limit_append_only();
CREATE TRIGGER control_limit_no_truncate
  BEFORE TRUNCATE ON quality.control_limit
  FOR EACH STATEMENT EXECUTE FUNCTION quality.control_limit_append_only();

-- Signal episodes (ADR-0032), derived from the readings and the limit versions and rewritten as
-- they change; keyed by (characteristic, limit version, chart, rule, first triggering point). A
-- provisional episode that disappears is deleted unless acknowledged; a final one (or an
-- acknowledged one) is kept `withdrawn` with its reason, its acknowledgement shown as orphaned.
CREATE TABLE quality.spc_signal (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  characteristic TEXT NOT NULL REFERENCES quality.characteristic (id),
  limit_version INTEGER NOT NULL CHECK (limit_version >= 1),
  chart TEXT NOT NULL CHECK (chart IN ('I', 'MR', 'Xbar', 'R')),
  rule INTEGER NOT NULL CHECK (rule BETWEEN 1 AND 8),
  -- The first triggering point: its reading (I), the later reading (MR), the subgroup's last
  -- reading (X̄, R), as (epoch, part, pass) and its position.
  epoch BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  pass INTEGER NOT NULL,
  first_at TIMESTAMPTZ NOT NULL,
  first_seq BIGINT NOT NULL,
  last_epoch BIGINT NOT NULL,
  last_part_id BIGINT NOT NULL,
  last_pass INTEGER NOT NULL,
  last_at TIMESTAMPTZ NOT NULL,
  last_seq BIGINT NOT NULL,
  points INTEGER NOT NULL CHECK (points >= 1),
  closed_epoch BIGINT,
  closed_part_id BIGINT,
  closed_pass INTEGER,
  closed_at TIMESTAMPTZ,
  closed_seq BIGINT,
  baseline BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisional', 'final', 'withdrawn')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  detected_plant_at TIMESTAMPTZ,
  final_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  withdrawn_reason TEXT,
  ack_by TEXT,
  ack_at TIMESTAMPTZ,
  ack_plant_at TIMESTAMPTZ,
  ack_comment TEXT,
  -- Rises with each acknowledgement and status change (409 signal-stale), not with an open
  -- episode's growth.
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (characteristic, limit_version, chart, rule, epoch, part_id, pass),
  CHECK ((closed_epoch IS NULL) = (closed_at IS NULL)),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK ((ack_by IS NULL) = (ack_at IS NULL))
);
CREATE INDEX spc_signal_first ON quality.spc_signal (characteristic, first_at, id);

-- Measurements and signals are derived and rebuilt; characteristics are seeded and kept; limit
-- versions are append-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON quality.measurement, quality.spc_signal TO mes_app;
GRANT SELECT, INSERT, UPDATE ON quality.characteristic TO mes_app;
GRANT SELECT, INSERT ON quality.control_limit TO mes_app;
