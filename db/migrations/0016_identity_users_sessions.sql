-- identity (Phase 7, #168, ADR-0026): users with one or more roles, scrypt password hashes, server
-- side sessions (only a token's SHA-256 is stored), failed-login state, and the append-only audit
-- log that the module writes for every login, failure, lock and user change. #169 moves the other
-- modules' audits into the same log.
CREATE SCHEMA IF NOT EXISTS identity;

-- The roles of master plan section 7, as `ROLES` in @shopfloor/contracts (a test compares them).
-- What each role may do is `ROLE_PERMISSIONS` there, not a table: it changes with the code.
CREATE TABLE identity.role (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL
);
INSERT INTO identity.role (id, description) VALUES
  ('operator', 'Runs a work center: codes downtime and scrap, acknowledges alarms, operates the terminal'),
  ('maintenance', 'Maintains equipment: codes downtime, acknowledges and shelves alarms'),
  ('quality', 'Quality: acknowledges alarms, codes scrap, writes handover notes'),
  ('supervisor', 'Leads a shift: every operator write, alarm shelving and the order writes'),
  ('admin', 'Administers users and nothing else (separation of duties)');

CREATE TABLE identity.user_account (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  -- `scrypt$N$r$p$salt$hash` (salt and hash in base64): the parameters travel with the hash, so
  -- the cost can rise later with a rehash at login.
  password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- A temporary password (bootstrap, an admin's create or reset): only the session and password
  -- routes answer until it is changed.
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  -- Consecutive failed logins since the last success; a normal account locks at five for 15
  -- minutes, an admin is delayed instead (1 s doubling, at most 5 min between attempts).
  failed_logins INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE identity.user_role (
  user_id BIGINT NOT NULL REFERENCES identity.user_account (id),
  role_id TEXT NOT NULL REFERENCES identity.role (id),
  PRIMARY KEY (user_id, role_id)
);

-- A login session. The cookie holds a 256-bit random token; only its SHA-256 is stored, so a read
-- of this table can't be replayed as a cookie.
CREATE TABLE identity.session (
  token_hash BYTEA PRIMARY KEY CHECK (length(token_hash) = 32),
  user_id BIGINT NOT NULL REFERENCES identity.user_account (id),
  kind TEXT NOT NULL CHECK (kind IN ('desk', 'terminal')),
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  -- Ends unless used before `idle_expires_at` (60 min desk, 15 min terminal), and at the latest
  -- at `expires_at` (12 h after login).
  idle_expires_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set when it ended before expiring: logout, password change, user disabled, a new login.
  ended_at TIMESTAMPTZ,
  end_reason TEXT CHECK (
    end_reason IN ('logout', 'password-changed', 'password-reset', 'user-disabled', 'replaced')
  ),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (idle_expires_at <= expires_at)
);
CREATE INDEX session_by_user ON identity.session (user_id) WHERE ended_at IS NULL;
-- The sweep deletes sessions idle (idle_expires_at <= expires_at, so this covers expiry too) or
-- ended more than a day ago.
CREATE INDEX session_by_idle_expiry ON identity.session (idle_expires_at);
CREATE INDEX session_by_end ON identity.session (ended_at) WHERE ended_at IS NOT NULL;

-- The audit log: one row per audited action, append-only. Wall time, plant time when known, the
-- user and roles at that moment (null user for the system or an unknown name), `authenticated`,
-- the action (`session.login`, `session.login-failed`, `user.create`, …), the entity and its
-- state before and after (never a password or a token), the HTTP request's id. `legacy` marks the
-- rows #169 copies from the module audits.
CREATE TABLE identity.audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  plant_at TIMESTAMPTZ,
  user_id BIGINT REFERENCES identity.user_account (id),
  username TEXT NOT NULL,
  roles TEXT[] NOT NULL DEFAULT '{}',
  authenticated BOOLEAN NOT NULL,
  action TEXT NOT NULL CHECK (action ~ '^[a-z]+(-[a-z]+)*\.[a-z]+(-[a-z]+)*$'),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before JSONB,
  after JSONB,
  request_id TEXT,
  legacy BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX audit_log_entity ON identity.audit_log (entity_type, entity_id, id);
CREATE INDEX audit_log_user ON identity.audit_log (user_id, id);

-- Append-only: no UPDATE, DELETE or TRUNCATE, whoever connects (#169 adds the grants that bind
-- the MES's own role as well).
CREATE FUNCTION identity.audit_log_append_only() RETURNS trigger
-- (BEGIN shares its line with AS: the runner refuses a line that starts with BEGIN.)
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'identity.audit_log is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON identity.audit_log
  FOR EACH ROW EXECUTE FUNCTION identity.audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON identity.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION identity.audit_log_append_only();
