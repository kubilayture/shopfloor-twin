-- equipment (Phase 5, #121): operator coding of downtime, the MES's first writes (ADR-0021,
-- ADR-0023). Codings are stored by time, not by record identity: downtime records are derived and
-- rebuilt with the intervals (0008), and a coding must survive a late fact that re-cuts them.

-- The coding set of one (equipment, epoch): its version is the optimistic-concurrency token of
-- every write to that set (PUT /downtime/{id}/coding answers 409 on a mismatch). A rebuild of the
-- records never resets it; clipping after a re-cut raises it like any other change.
CREATE TABLE equipment.downtime_coding_set (
  equipment TEXT NOT NULL,
  -- The device epoch (ADR-0015).
  epoch BIGINT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (version >= 0),
  PRIMARY KEY (equipment, epoch)
);

-- One coded time range [from_time, to_time) inside a record's loss time. A split is two codings;
-- time without one keeps the record's auto reason. Codings of one (equipment, epoch) that are not
-- orphaned never overlap (the writer holds the coding set's row lock).
CREATE TABLE equipment.downtime_coding (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  from_time TIMESTAMPTZ NOT NULL,
  to_time TIMESTAMPTZ NOT NULL,
  -- An active master_data.reason_code id other than UNCODED, checked when written (no foreign
  -- key: modules own their schemas, ADR-0016).
  reason TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  -- Free text typed by the operator: recorded as unauthenticated until identity (Phase 7).
  coded_by TEXT NOT NULL,
  coded_at TIMESTAMPTZ NOT NULL,
  -- The coding set's version this row was written at.
  version BIGINT NOT NULL,
  -- Set when a re-cut left this time outside every loss interval: kept for the history, never
  -- an effective reason again.
  orphaned BOOLEAN NOT NULL DEFAULT false,
  orphaned_at TIMESTAMPTZ,
  CHECK (to_time > from_time),
  CHECK (length(comment) <= 500),
  CHECK (length(coded_by) BETWEEN 1 AND 100),
  CHECK (orphaned = (orphaned_at IS NOT NULL)),
  FOREIGN KEY (equipment, epoch) REFERENCES equipment.downtime_coding_set (equipment, epoch)
);
-- The codings of a time range of one (equipment, epoch): records, the Pareto and clipping.
CREATE INDEX downtime_coding_range ON equipment.downtime_coding (equipment, epoch, from_time)
  WHERE NOT orphaned;

-- Every write to the codings and every clip after a re-cut, append-only (it moves to identity's
-- audit log in Phase 7). `before` and `after` are the codings of the affected range as JSON.
CREATE TABLE equipment.downtime_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  -- The record written to ('{equipment}~{epoch}~{startMs}'), or the record a clipped coding lay
  -- in, when known.
  record_id TEXT,
  -- The time range the action concerns: the record's, or the clipped coding's.
  from_time TIMESTAMPTZ NOT NULL,
  to_time TIMESTAMPTZ,
  action TEXT NOT NULL,
  before JSONB NOT NULL,
  after JSONB NOT NULL,
  -- `coded_by` as typed (unauthenticated), or 'system' for clipping after a re-cut.
  actor TEXT NOT NULL,
  authenticated BOOLEAN NOT NULL DEFAULT false,
  -- Wall time of the change, not simulation time.
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- The HTTP request's id (X-Request-Id of the answer); null for system actions.
  request_id TEXT,
  -- The coding set's version after the change.
  version BIGINT NOT NULL,
  CHECK (action IN ('coded', 'cleared', 'orphaned'))
);
CREATE INDEX downtime_audit_range ON equipment.downtime_audit (equipment, epoch, from_time);

-- Append-only: no UPDATE, DELETE or TRUNCATE, whoever connects. A REVOKE would not bind the MES,
-- which owns the table; a trigger does.
CREATE FUNCTION equipment.downtime_audit_append_only() RETURNS trigger
-- (BEGIN shares its line with AS: the runner refuses a line that starts with BEGIN.)
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'equipment.downtime_audit is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER downtime_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON equipment.downtime_audit
  FOR EACH ROW EXECUTE FUNCTION equipment.downtime_audit_append_only();
CREATE TRIGGER downtime_audit_no_truncate
  BEFORE TRUNCATE ON equipment.downtime_audit
  FOR EACH STATEMENT EXECUTE FUNCTION equipment.downtime_audit_append_only();
