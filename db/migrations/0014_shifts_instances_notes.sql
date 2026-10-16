-- shifts (Phase 6, #144, ADR-0025): shift instances as records, per plant epoch, with the shift
-- report's finality and its composite revision; handover notes, versioned and never deleted, with
-- an append-only audit (ADR-0023 write guards). The report itself is computed on read.
CREATE SCHEMA IF NOT EXISTS shifts;

-- One scheduled shift the plant clock has entered, keyed (plant epoch, shift key). The plant epoch
-- is the simulator's epoch, which every device shares (ADR-0015): a restarted simulator replays
-- the same shift keys under a new epoch, and they get their own rows (and notes).
CREATE TABLE shifts.shift_instance (
  epoch BIGINT NOT NULL,
  -- `{date}/{shift}`, as shift buckets are keyed.
  shift_key TEXT NOT NULL,
  -- The day the shift starts, in the plant's time zone (YYYY-MM-DD), and the shift id.
  shift_date TEXT NOT NULL CHECK (shift_date ~ '^\d{4}-\d{2}-\d{2}$'),
  shift_id TEXT NOT NULL,
  -- From the shift calendar: [start_time, end_time) and the breaks as [{start, end}] (ISO 8601).
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  breaks JSONB NOT NULL,
  -- running: the plant clock is inside it; ended: past its end (or a newer epoch began); final:
  -- the report's inputs are final (OEE, downtime records, alarm KPIs). Final never goes back.
  status TEXT NOT NULL CHECK (status IN ('running', 'ended', 'final')),
  -- Wall time the report became final, and the inputs' revisions at that moment (per OEE hour of
  -- each machine and per alarm KPI hour of each scope).
  final_at TIMESTAMPTZ,
  final_inputs JSONB,
  -- The inputs' revisions as last counted into `inputs_revision`.
  seen_inputs JSONB,
  -- The composite revision (ADR-0025): `inputs` is 0 when the report becomes final and rises by
  -- one per revision of an input after that; `content` rises by one per handover note create or
  -- edit and per operator recode inside the shift once it is final. Counters, never maxima.
  inputs_revision BIGINT NOT NULL DEFAULT 0,
  content_revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK ((status = 'final') = (final_at IS NOT NULL)),
  CHECK (inputs_revision >= 0 AND content_revision >= 0),
  PRIMARY KEY (epoch, shift_key)
);
-- The newest epoch of a shift key (the API's default), and the instances of a time range.
CREATE INDEX shift_instance_key ON shifts.shift_instance (shift_key, epoch DESC);
CREATE INDEX shift_instance_range ON shifts.shift_instance (epoch, start_time);

-- A handover note of one shift instance: the current version. Never deleted (a wrong note is
-- retracted and stays in the history); every version is in the audit.
CREATE TABLE shifts.handover_note (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch BIGINT NOT NULL,
  shift_key TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('safety', 'quality', 'equipment', 'material', 'general')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  -- Free text, as typed (unauthenticated until identity, Phase 7): who wrote it first, and who
  -- wrote the current version.
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100),
  retracted BOOLEAN NOT NULL DEFAULT false,
  -- Optimistic concurrency: 1 when created, +1 per edit (a stale version is 409).
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Wall time and plant time (the epoch's clock) of the create and of the latest edit.
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_plant_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_plant_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (epoch, shift_key) REFERENCES shifts.shift_instance (epoch, shift_key)
);
CREATE INDEX handover_note_instance ON shifts.handover_note (epoch, shift_key, id);

-- Notes are never deleted, whoever connects (updates are the edits).
CREATE FUNCTION shifts.handover_note_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'shifts.handover_note is never deleted (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER handover_note_no_delete
  BEFORE DELETE ON shifts.handover_note
  FOR EACH ROW EXECUTE FUNCTION shifts.handover_note_no_delete();
CREATE TRIGGER handover_note_no_truncate
  BEFORE TRUNCATE ON shifts.handover_note
  FOR EACH STATEMENT EXECUTE FUNCTION shifts.handover_note_no_delete();

-- Every create and edit of a note, append-only (it moves to identity's audit log in Phase 7).
-- `before` and `after` are the note's content ({category, text, retracted}); `before` is null for
-- a create.
CREATE TABLE shifts.handover_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id BIGINT NOT NULL REFERENCES shifts.handover_note (id),
  epoch BIGINT NOT NULL,
  shift_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'edited')),
  before JSONB,
  after JSONB NOT NULL,
  -- `author` as typed (unauthenticated).
  actor TEXT NOT NULL,
  authenticated BOOLEAN NOT NULL DEFAULT false,
  -- Wall time of the change, and the plant time (the epoch's clock) at it.
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  plant_at TIMESTAMPTZ NOT NULL,
  -- The HTTP request's id (X-Request-Id of the answer).
  request_id TEXT,
  -- The note's version after the change.
  version BIGINT NOT NULL,
  CHECK ((action = 'created') = (before IS NULL))
);
CREATE INDEX handover_audit_note ON shifts.handover_audit (note_id, id);

-- Append-only: no UPDATE, DELETE or TRUNCATE, whoever connects. A REVOKE would not bind the MES,
-- which owns the table; a trigger does.
CREATE FUNCTION shifts.handover_audit_append_only() RETURNS trigger
-- (BEGIN shares its line with AS: the runner refuses a line that starts with BEGIN.)
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'shifts.handover_audit is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER handover_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON shifts.handover_audit
  FOR EACH ROW EXECUTE FUNCTION shifts.handover_audit_append_only();
CREATE TRIGGER handover_audit_no_truncate
  BEFORE TRUNCATE ON shifts.handover_audit
  FOR EACH STATEMENT EXECUTE FUNCTION shifts.handover_audit_append_only();
