-- shifts (Phase 7, #169; written from #177): who is signed on at a work center during a shift
-- instance. Signing on at a terminal opens a row; signing off, the end of the terminal session or
-- the end of the shift closes it. The shift report's crew section reads it. The first migration
-- that runs as mes_owner from the start: it grants the MES what it needs itself (ADR-0027).
CREATE TABLE shifts.crew_assignment (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The user (an identity.user_account id, by value: no key across module schemas, ADR-0016) and
  -- its name at sign-on.
  user_id BIGINT NOT NULL,
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
  -- A master_data.work_center id, by value.
  work_center TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  shift_key TEXT NOT NULL,
  -- The terminal session that signed on (the SHA-256 of its token in hex, as the API names it),
  -- so its end closes the row.
  session_id TEXT CHECK (session_id ~ '^[0-9a-f]{64}$'),
  -- Wall time and plant time (the epoch's clock) of sign-on and of the end.
  from_at TIMESTAMPTZ NOT NULL,
  from_plant_at TIMESTAMPTZ NOT NULL,
  to_at TIMESTAMPTZ,
  to_plant_at TIMESTAMPTZ,
  end_reason TEXT CHECK (end_reason IN ('sign-off', 'session-ended', 'shift-ended')),
  CHECK ((to_at IS NULL) = (end_reason IS NULL)),
  CHECK ((to_at IS NULL) = (to_plant_at IS NULL)),
  CHECK (to_at IS NULL OR to_at >= from_at),
  FOREIGN KEY (epoch, shift_key) REFERENCES shifts.shift_instance (epoch, shift_key)
);
-- At most one open row per user and work center.
CREATE UNIQUE INDEX crew_assignment_open ON shifts.crew_assignment (user_id, work_center)
  WHERE to_at IS NULL;
-- The crew of a shift instance (the report).
CREATE INDEX crew_assignment_instance ON shifts.crew_assignment (epoch, shift_key, work_center);

GRANT SELECT, INSERT, UPDATE, DELETE ON shifts.crew_assignment TO mes_app;
