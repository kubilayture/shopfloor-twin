-- alarms (Phase 6, #143, ADR-0023, ADR-0024 "Operator lifecycle"): the operator's side of an alarm
-- (ISA-18.2): acknowledgement per occurrence, shelving per alarm point, comments, and the
-- append-only audit of every MES transition. The device owns active and cleared
-- (alarm_occurrence, 0012); nothing here is ever touched by a rebuild of the occurrences, and no
-- KPI reads it (every raise counts, shelved or not).

-- Acknowledgement per occurrence, keyed like alarms.alarm_occurrence (its API id
-- `{equipment}~{epoch}~{seq}`). Monotonic: a row is only ever inserted (INSERT ... ON CONFLICT DO
-- NOTHING), never updated or deleted, so acknowledging needs no version. No foreign key: the
-- occurrence rows are derived and may be rewritten; the key is stable (ADR-0024).
CREATE TABLE alarms.occurrence_state (
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  -- Free text typed by the operator: unauthenticated until identity (Phase 7).
  acknowledged_by TEXT NOT NULL,
  -- Wall time of the acknowledgement.
  acknowledged_at TIMESTAMPTZ NOT NULL,
  -- The plant clock (the newest epoch's watermark) at that moment, and its epoch; null without a
  -- clock.
  plant_at TIMESTAMPTZ,
  plant_epoch BIGINT,
  comment TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  CHECK (length(acknowledged_by) BETWEEN 1 AND 100),
  CHECK (length(comment) <= 500),
  CHECK ((plant_at IS NULL) = (plant_epoch IS NULL)),
  PRIMARY KEY (equipment, epoch, seq)
);

-- Monotonic by a trigger too: an acknowledgement is never changed or taken back.
CREATE FUNCTION alarms.occurrence_state_insert_only() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'alarms.occurrence_state is insert-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER occurrence_state_no_update_delete
  BEFORE UPDATE OR DELETE ON alarms.occurrence_state
  FOR EACH ROW EXECUTE FUNCTION alarms.occurrence_state_insert_only();
CREATE TRIGGER occurrence_state_no_truncate
  BEFORE TRUNCATE ON alarms.occurrence_state
  FOR EACH STATEMENT EXECUTE FUNCTION alarms.occurrence_state_insert_only();

-- The shelf of one alarm point (equipment, code), as ISA-18.2 shelves a point, not an occurrence.
-- One row per point ever shelved; `version` is the optimistic-concurrency token of every write to
-- it (shelve, unshelve) and rises with the module's own changes too (expiry, epoch end), so a
-- screen holding an old shelf is refused (409). A point without a row is unshelved at version 0.
CREATE TABLE alarms.alarm_shelf (
  equipment TEXT NOT NULL,
  code TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  shelved BOOLEAN NOT NULL DEFAULT false,
  -- While shelved: who, why, the wall time of the write, the plant clock's epoch and time at the
  -- write, and `until` = that plant time plus the duration (at most maxShelveMs, alarms.yaml). The
  -- module unshelves the point itself once the plant clock of that epoch passes `until`, or when
  -- a newer plant epoch starts (plant time starts over).
  shelved_by TEXT,
  reason TEXT,
  shelved_at TIMESTAMPTZ,
  plant_epoch BIGINT,
  plant_at TIMESTAMPTZ,
  until TIMESTAMPTZ,
  duration_ms BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (version >= 0),
  CHECK (
    shelved = (
      shelved_by IS NOT NULL AND reason IS NOT NULL AND shelved_at IS NOT NULL
      AND plant_epoch IS NOT NULL AND plant_at IS NOT NULL AND until IS NOT NULL
      AND duration_ms IS NOT NULL
    )
  ),
  CHECK (duration_ms IS NULL OR duration_ms > 0),
  CHECK (until IS NULL OR until > plant_at),
  CHECK (length(shelved_by) BETWEEN 1 AND 100),
  CHECK (length(reason) BETWEEN 1 AND 200),
  PRIMARY KEY (equipment, code)
);
-- The shelved points, for the expiry check at start-up and the shelved list.
CREATE INDEX alarm_shelf_shelved ON alarms.alarm_shelf (plant_epoch, until) WHERE shelved;

-- Every MES transition of an alarm, append-only (the master plan's alarm_transition; device raises
-- and clears stay in ingest.equipment_event). It moves to identity's audit log in Phase 7.
--   ack:         an occurrence acknowledged (seq set);
--   comment:     a comment on an occurrence (seq set; the text in `after`);
--   shelve:      a point shelved, or its shelf changed (seq null);
--   unshelve:    a point unshelved by an operator;
--   expire:      a shelf's plant-time limit passed (actor 'system');
--   epoch-ended: a newer plant epoch ended the shelf (actor 'system').
CREATE TABLE alarms.alarm_transition (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  equipment TEXT NOT NULL,
  code TEXT NOT NULL,
  -- The occurrence (its device epoch and raise seq) for ack and comment; null for a point action.
  epoch BIGINT,
  seq BIGINT,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  -- As typed (unauthenticated), or 'system' for expiry and epoch end.
  actor TEXT NOT NULL,
  authenticated BOOLEAN NOT NULL DEFAULT false,
  -- Wall time of the change, not simulation time.
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- The plant clock at the change (for an expiry: the shelf's `until`), and its epoch.
  plant_at TIMESTAMPTZ,
  plant_epoch BIGINT,
  -- The HTTP request's id (X-Request-Id of the answer); null for system actions.
  request_id TEXT,
  -- The shelf's version after a point action; null for ack and comment.
  version BIGINT,
  CHECK (action IN ('ack', 'comment', 'shelve', 'unshelve', 'expire', 'epoch-ended')),
  CHECK ((seq IS NULL) = (epoch IS NULL)),
  CHECK ((seq IS NOT NULL) = (action IN ('ack', 'comment'))),
  CHECK ((version IS NULL) = (action IN ('ack', 'comment'))),
  CHECK (length(actor) BETWEEN 1 AND 100)
);
-- An occurrence's transitions (its history, comment counts) and a point's (its audit).
CREATE INDEX alarm_transition_occurrence ON alarms.alarm_transition (equipment, epoch, seq)
WHERE seq IS NOT NULL;
CREATE INDEX alarm_transition_point ON alarms.alarm_transition (equipment, code, id);

-- Append-only: no UPDATE, DELETE or TRUNCATE, whoever connects (ADR-0023: the MES owns the table,
-- so a REVOKE would not bind it; a trigger does).
CREATE FUNCTION alarms.alarm_transition_append_only() RETURNS trigger
-- (BEGIN shares its line with AS: the runner refuses a line that starts with BEGIN.)
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'alarms.alarm_transition is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER alarm_transition_no_update_delete
  BEFORE UPDATE OR DELETE ON alarms.alarm_transition
  FOR EACH ROW EXECUTE FUNCTION alarms.alarm_transition_append_only();
CREATE TRIGGER alarm_transition_no_truncate
  BEFORE TRUNCATE ON alarms.alarm_transition
  FOR EACH STATEMENT EXECUTE FUNCTION alarms.alarm_transition_append_only();
