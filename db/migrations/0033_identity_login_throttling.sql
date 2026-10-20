-- identity, login throttling (Phase 9, #242, P9-15; plan "Login throttling", ADR-0039 amendment).
-- The lock of five failures moves from the account to the pair (account, address): an attacker on
-- one address no longer locks the account for its users on other addresses. Beside it, every
-- judged failure of an account is kept for 15 minutes, from all addresses together, for the global
-- delay: once the account has ten or more, an attempt within min(2^(n - 10) s, 30 s) of its last
-- failure is refused with 429 before any hash. Both are written in ADR-0026's reserve-before-hash
-- transaction, under the user's row lock. The address is the client's: nginx's `X-Real-IP` when the
-- request came over the `edge` network, else the socket's (`apps/mes-server/src/edge.ts`).

-- One row per (account, address) that failed since its last success there: consecutive failures,
-- and the lock the fifth sets for 15 minutes (never for an admin, which keeps its account-wide
-- delay on `user_account`). A success from that address deletes the row; an admin's reset or an
-- enable deletes the account's rows; the sweep deletes rows a day after their last failure once
-- unlocked.
CREATE TABLE identity.login_address (
  user_id BIGINT NOT NULL REFERENCES identity.user_account (id),
  -- An IPv4 or IPv6 address as text (IPv4-mapped IPv6 normalised to IPv4), or `unknown` when the
  -- request had none.
  address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 64),
  failed_logins INTEGER NOT NULL CHECK (failed_logins > 0),
  locked_until TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, address)
);

-- Every judged failed attempt of an account (wrong password, reserved before its hash), whatever
-- the address: n is the count of these in the last 15 minutes. A refusal (a lock, an admin's delay,
-- a 429) is not judged and never lands here. A success deletes the account's rows (n resets); the
-- sweep deletes rows older than the window.
CREATE TABLE identity.login_failure (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES identity.user_account (id),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 64),
  at TIMESTAMPTZ NOT NULL
);
CREATE INDEX login_failure_by_user ON identity.login_failure (user_id, at);
CREATE INDEX login_failure_by_time ON identity.login_failure (at);

-- The account-wide lock is gone (its pairs hold it now). `failed_logins` and `next_attempt_at`
-- stay: an admin's doubling delay is account-wide, as before.
ALTER TABLE identity.user_account DROP COLUMN locked_until;

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.login_address TO mes_app;
GRANT SELECT, INSERT, DELETE ON identity.login_failure TO mes_app;
