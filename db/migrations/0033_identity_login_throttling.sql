-- identity, login throttling (Phase 9, #242, P9-15; plan "Login throttling", ADR-0039 amendment).
-- The lock of five failures moves from the account to the pair (account, address): an attacker on
-- one address no longer locks the account for its users on other addresses. Beside it, every
-- judged failure of an account is kept for 15 minutes, from all addresses together, for the global
-- delay: once the account has ten or more, an attempt within min(2^(n - 10) s, 30 s) of its last
-- failure is refused with 429 before any hash, except from an address that logged in to the
-- account within those 15 minutes. Both are written in ADR-0026's reserve-before-hash transaction,
-- under the user's row lock. The address is the client's: nginx's `X-Real-IP` when the request came
-- over the `edge` network, else the connection's (`apps/mes-server/src/edge.ts`).
--
-- **Existing locks are released:** `user_account.locked_until` is dropped below, so an account
-- locked when this migration runs is open again; its pairs start empty.

-- One row per (account, address) that failed or succeeded there: consecutive failures since the
-- last success from that address, the lock the fifth sets for 15 minutes (never for an admin,
-- which keeps its account-wide delay on `user_account`), and the last success (which exempts the
-- address from the global delay for 15 minutes). A success from that address resets its count and
-- lock; an admin's password reset or the bootstrap deletes the account's rows; the sweep deletes
-- rows a day after their last failure or success once unlocked.
CREATE TABLE identity.login_address (
  user_id BIGINT NOT NULL REFERENCES identity.user_account (id),
  -- An IPv4 or IPv6 address as text (IPv4-mapped IPv6 normalised to IPv4), or `unknown` when the
  -- request had none.
  address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 64),
  failed_logins INTEGER NOT NULL CHECK (failed_logins >= 0),
  locked_until TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  CHECK (last_failure_at IS NOT NULL OR last_success_at IS NOT NULL),
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
-- stay for an admin's doubling delay, which is account-wide as before; they are counted for admins
-- only (#264 review, F7) and reset with a role change, so a normal account's old count never
-- becomes an admin's delay. Normal accounts' counts are reset here.
ALTER TABLE identity.user_account DROP COLUMN locked_until;
UPDATE identity.user_account u SET failed_logins = 0, next_attempt_at = NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM identity.user_role r WHERE r.user_id = u.id AND r.role_id = 'admin'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.login_address TO mes_app;
GRANT SELECT, INSERT, DELETE ON identity.login_failure TO mes_app;
