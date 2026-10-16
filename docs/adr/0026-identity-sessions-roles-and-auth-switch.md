# ADR-0026: Identity: local users with roles, cookie sessions, scrypt and an enforcement switch

- Status: accepted
- Date: 2026-10-16
- Deciders: Claude (#168), within the Phase 7 plan ("Identity"); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Until Phase 7 the MES has no users: reads are open on loopback (ADR-0019) and writes are guarded by origin checks and audited under a name the operator types (ADR-0023). Phase 7 adds order writes that only a supervisor may make, and the master plan's exit criterion "role permissions tested". The Phase 7 plan decides the shape of identity; implementing it (#168) left these questions:

- How does a browser prove who it is: tokens or sessions, and where are they kept?
- How are passwords stored without a new dependency, and how does a burst of logins stay inside the MES container's 512 MiB?
- What happens on repeated failures, when nginx hides every client address?
- Where are roles and permissions defined so the MES and the web can't disagree?
- How does the first admin come to exist without a password in the repository?
- How can identity merge without breaking the web, the e2e tests, the stack smoke and the reconciliation, none of which can log in yet (#170)?

## Considered options

Credentials: (a) JWTs in `localStorage` or a header; (b) an opaque random token in an `HttpOnly` cookie, its hash stored server-side.

Password hashing: (a) bcrypt or argon2 from npm; (b) `node:crypto` scrypt.

Repeated failures: (a) no limit; (b) lock every account after N failures; (c) lock normal accounts, delay admins.

Rollout: (a) enforce authentication in the same PR; (b) build it behind a switch, `MES_AUTH=off` by default, and turn it on with the login screen (#170).

## Decision outcome

Credentials (b), hashing (b), failures (c), rollout (b).

**Roles and permissions.** The five roles of master plan section 7 (`operator`, `maintenance`, `quality`, `supervisor`, `admin`) and fourteen permissions (`read` and one per kind of write) are defined once in `@shopfloor/contracts/identity` as `ROLES`, `PERMISSIONS` and `ROLE_PERMISSIONS`, the plan's matrix cell by cell (a test compares them). A user has one or more roles. `admin` holds only `read` and `user:admin`: separation of duties, and a person who needs both gets both roles. The roles are also rows of `identity.role` (seeded by migration `0016`, checked against contracts at start-up); permissions are code, not data.

**Sessions.** `POST /api/v1/session` (user name, password, `kind` `desk` or `terminal`) sets the cookie `sft_session` to 32 random bytes in base64url, `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, with `Secure` and the name `__Host-sft_session` when `MES_COOKIE_SECURE=on` (behind TLS, Phase 9). Only the token's SHA-256 is stored (`identity.session`), so a read of the table can't be replayed. A session ends when idle (60 min desk, 15 min terminal; the last use is written at most once a minute and moves the idle expiry), 12 h after login whatever the use, on logout (`DELETE /api/v1/session`, body `{}` because every write is JSON), when the user changes the password (the other sessions), when an admin resets it or disables the user (all of them), and when a login presents it (a login always gets a new token). JWTs were rejected: revocation needs a server table anyway, and a token a script can read is worse than an `HttpOnly` cookie. The cookie's scope on `localhost` (every port, not `127.0.0.1`) is in the runbook.

**Passwords.** `scrypt` from `node:crypto` with N = 2^15, r = 8, p = 3 (32 MiB, an OWASP-listed setting), a 16-byte salt and a 32-byte key, stored as `scrypt$N$r$p$salt$hash` so the cost can rise later; a login with a hash of other parameters rehashes it. Every call passes `maxmem: 64 MiB`: Node's default of 32 MiB is just below what these parameters need and the call would fail (a test shows both). At most two hashes run at a time (a semaphore), so 512 MiB hold a burst of logins. A password has 12–128 characters (code points) and no composition rule (NIST SP 800-63B). An unknown user name costs one hash of a dummy, a known one one real hash: the answer and its time don't tell them apart. Every failure (unknown or disabled user, wrong password, a lock, an admin's delay) is the same 401 `urn:shopfloor:unauthenticated` with the same text.

**Failures.** Five consecutive failures lock a normal account for 15 minutes; the right password is refused while it is locked, and a failure after the lock ran out starts the count anew. Users with the `admin` role are never locked, so that an attacker can't lock out the one account that can unlock the others: from the fifth failure on, the next attempt is refused for 1 s, doubling with each failure, at most 5 min. The lock is per account, because behind nginx there is no client address: anyone who can reach the login page can keep a known user locked out. That denial of service is accepted on a loopback plant network until Phase 9. Every failure, lock, login, logout and user change is a row of the append-only `identity.audit_log` (a trigger refuses UPDATE, DELETE and TRUNCATE); #169 moves the module audits into it.

**Bootstrap.** `MES_BOOTSTRAP_ADMIN_PASSWORD` (optional, 12–128 characters, never echoed) creates the user `admin` with the admin role and a password it must change, only when no enabled admin exists; an existing `admin` account is restored that way. Without it the MES starts, logs a warning and has no admin until the variable is set and the MES restarted, or `pnpm --filter @shopfloor/mes-server user:create --username <name> --role admin` creates one (password from stdin, so it is in no process list or shell history). The last enabled admin can't be disabled or lose the role (409). A user with a temporary password (bootstrap, an admin's create or reset) gets 403 `urn:shopfloor:password-change-required` on every route but the session and password routes until it changes it.

**Enforcement.** Each route declares its access: a permission, `session` (the session and password routes) or `public` (the login). With `MES_AUTH=on` the `/api/v1` hook checks, in this order: `Host` (403), `MES_WRITES` (405), `Origin` and `Sec-Fetch-Site` (403), JSON (415), as ADR-0023, then the session (401 `urn:shopfloor:unauthenticated`), the temporary password and the permission (403 `urn:shopfloor:password-change-required`, `urn:shopfloor:forbidden`), and last the rate limits (429): a cross-site request never learns whether a session exists, and an anonymous one never spends a token. Unknown routes need a session too, so they don't reveal which exist. `/health/*` and `/metrics` stay open. The WebSocket upgrade passes the Host and Origin checks first; its session is checked in the same hook, and a socket without one is accepted and closed at once with code 4401 (`WS_CLOSE_UNAUTHENTICATED`), because a browser can't read the status of a refused upgrade. A socket's session is closed with 4401 as soon as the session ends (logout, password change, disabled user) and, for expiry, within the next check (every 15 s). Pushed messages don't count as use; a screen that only listens ends after the idle timeout. Session lookups use a pool of their own (two connections), never one that ingest's acknowledgement path waits for.

**Rate limits.** The global write bucket of ADR-0023 stays; each user gets a bucket of its own (5 per second, bursts of 10), checked first, both answering 429 `urn:shopfloor:write-rate`.

**Rollout.** `MES_AUTH` defaults to `off` in #168: the session routes need a session, and everything else behaves exactly as before (no session, no permission, the old actor fields), so the web, the end-to-end tests, the stack smoke and the reconciliation stay green. The tests run both settings. #170 changes the default to `on` together with the login screen and the tests' logins; after that, `off` is only for diagnosis and the MES logs a warning at start (it does already).

### Consequences

- Good: one permission table for the MES and the web; a route without a declared access can't exist (the type requires it for writes, reads default to `read`), and a test compares every route of the OpenAPI document with the matrix for anonymous and each role.
- Good: no new dependency; tokens and passwords never reach a log (a test captures Fastify's and the module's log lines through logins, failures and a lockout).
- Good: every merge stays green while identity grows (H4 in the plan).
- Bad: per-account lockout is a denial of service for anyone who can reach the login page (accepted until Phase 9); an admin under attack waits up to 5 minutes between attempts.
- Bad: until #170 the switch is off in Compose: identity exists but protects nothing on the stack.
- Bad: a session's last use is written at most once a minute, so the idle expiry is exact to a minute; an expired socket closes up to 15 s late.
- Bad: plain HTTP means no `Secure` cookie and the cookie goes to every `localhost` port; TLS is Phase 9.
