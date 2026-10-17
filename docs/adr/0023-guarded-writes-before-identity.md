# ADR-0023: Guarded, audited writes before identity

- Status: accepted
- Date: 2026-10-16
- Deciders: Claude (#121), within the Phase 5 plan ("Writes before identity"); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Downtime coding (#121) is the MES's first write: an operator gives a downtime record a reason, splits it, or clears the coding again. Users, roles and login arrive with `identity` in Phase 7 (master plan section 11, row 7). Until then the API is unauthenticated and bound to loopback (ADR-0019), with nginx in front in Compose (#99). A read-only API only had to keep other sites from reading plant data; a write must also keep other sites from changing it:

- **Cross-site request forgery.** Any page the operator has open can send a form POST, or a `fetch` with a "simple" content type, to `http://localhost:8080/api/...` without a CORS preflight. The browser sends it; only the answer is hidden.
- **DNS rebinding.** A site's own name resolving to 127.0.0.1 makes its page same-origin with the MES. The `Host` allowlist of ADR-0019 already refuses it.
- **Lost updates.** Two screens may code the same machine at once.
- **No user.** The audit can only record who the operator said they were.
- **One client address.** Behind nginx every request comes from nginx, and `X-Forwarded-For` can be forged.

The question: what must a non-GET request under `/api/v1` carry, what do nginx and the Vite proxy pass on, and how can writes be turned off?

## Considered options

1. A CSRF token: a cookie or an endpoint hands out a token, and every write echoes it in a header.
2. Origin-based checks: every write must carry an `Origin` of the MES's own host (or an allowlisted one), a JSON content type, and `Sec-Fetch-Site: same-origin` when the browser sends that header; no CORS headers.
3. Wait for `identity` and keep the MES read-only until Phase 7.

## Decision outcome

Chosen option: 2. Browsers always send `Origin` on POST, PUT and DELETE (also same-origin), and a page can't set or remove it. Without CORS headers, no other origin can send a non-simple request (a JSON body), and a simple one (form, `text/plain`) is refused by the content-type check before any handler runs. Option 1 adds state, a token endpoint and a header to every client for no gain against these threats on loopback; option 3 would postpone exit criterion 4 to Phase 7.

**Guards on every non-GET (and non-HEAD) request under `/api/v1`, in this order:**

1. `Host` in `HTTP_ALLOWED_HOSTS` (the existing check of ADR-0019), else 403. `HTTP_ALLOWED_HOSTS=*` turns that check off, so the MES refuses to start with it while `MES_WRITES=on`.
2. `MES_WRITES=off` answers 405 with `Allow: GET, HEAD`.
3. `Origin` present, else 403 (`a write needs an Origin header`). Tests and `curl` must set it.
4. `Origin` same-origin with the request's `Host`, or listed in `HTTP_ALLOWED_ORIGINS`, else 403. Only an exact origin string counts (`scheme://host[:port]`, as browsers send it; no path, no user info). **Same-origin compares host and port, not the scheme**: the MES itself speaks plain HTTP, and a TLS front (a later phase) would make the browser's origin `https://` while the MES sees `Host` only. That is acceptable on loopback, where no network attacker can downgrade the scheme; a deployment beyond loopback needs identity (Phase 7) and hardening (Phase 9) first.
5. `Sec-Fetch-Site`, when present, must be `same-origin`, else 403. Browsers send it on every request; a `same-site` page (another port on localhost) or a `cross-site` one is refused even before the Origin check could be fooled. Non-browser clients don't send it.
6. `Content-Type: application/json` (parameters such as `charset` allowed), else 415. So a cross-site form or other simple request never reaches a handler.
7. A **global** write rate limit, a token bucket for all clients together (10 per second, bursts of 20), else 429 with `Retry-After`. A per-client limit means nothing behind nginx.

The answer to a write carries `X-Request-Id` (a UUID per request, Fastify's request id), which the audit records. The body is at most 16 KiB (413), parsed strictly by zod (400). No route sends CORS headers, also not to a preflight (`OPTIONS` is a non-GET request and meets the same guards). WebSockets carry no writes: their only client messages are subscriptions.

**Optimistic concurrency.** A write sends the `version` it read; the version belongs to the coding set of one (equipment, epoch), not to a record (records are rebuilt, ADR-0021). A mismatch is 409. Clipping codings after a re-cut raises the version too, so a screen holding codings that no longer exist is refused rather than overwriting them blindly.

**Unauthenticated actor.** `codedBy` is free text (1–100 characters), stored as typed and audited with `authenticated: false`. The audit (`equipment.downtime_audit`) is append-only by a trigger that refuses UPDATE, DELETE and TRUNCATE: the MES owns the table, so a REVOKE would not bind it. It records the action, the codings before and after, the actor, the wall time and the request id, and moves to `identity`'s audit log in Phase 7.

**Proxies.**

- nginx passes only GET (with HEAD), POST, PUT and DELETE under `/api/` (`limit_except`; others get nginx's 403) and caps bodies at 16 KiB. It forwards the browser's `Host` (with the port), so the page's origin is same-origin for the MES and `HTTP_ALLOWED_ORIGINS` stays empty.
- The Vite dev and preview proxy rewrites `Origin` on HTTP requests by the rule it already applies to WebSocket upgrades (ADR-0019, #98): a page served under a loopback name (`localhost`, `127.0.0.1`, `[::1]`) whose `Origin` names the dev server is presented as the MES's own origin (`changeOrigin` sends the MES's host). Any other `Origin` is passed on unchanged and refused by the MES. Without this every write from `pnpm dev` would be a 403. Vite's own host check refuses rebound names on HTTP requests; the upgrade listener refuses them itself.

**Off switch.** `MES_WRITES=off` (environment, Compose `MES_WRITES`) answers every write with 405, so the MES can run read-only (a demo, an incident) without a new build.

### Consequences

- Good: no other page can write, also not through DNS rebinding or a form; no token to hand out, store or rotate.
- Good: every write is audited with a request id that also appears in the MES log; the audit can't be edited from the MES's connection.
- Good: concurrent screens can't silently overwrite each other's codings.
- Bad: the trigger binds the MES's connection, not the database owner: the role the MES connects as owns the table and could `ALTER TABLE … DISABLE TRIGGER`. Separate roles (the MES writing as a role that doesn't own its tables) come with identity and hardening (Phases 7 and 9).
- Bad: anyone with a browser on the machine can write under any name. That is the accepted risk until identity (Phase 7); the audit marks every entry unauthenticated.
- Bad: the same-origin check ignores the scheme; acceptable on loopback only (see above).
- Bad: one global rate limit lets one noisy client slow everyone's writes; at plant-floor rates (a few codings a minute) it never triggers.
- Bad: a version per (equipment, epoch) makes two operators coding different records of the same machine conflict; the second one reads again and retries.
- Bad: an allowlisted origin on another port still sends `Sec-Fetch-Site: same-site` from a browser and is refused; the allowlist serves proxies and non-browser clients.

## Note: alarm writes (#143)

The alarm writes (acknowledge, bulk acknowledge, comment, shelve, unshelve) pass the same guards, unchanged and in the same order, and use only `POST`, which nginx already passes. A bulk acknowledgement of up to 100 occurrences is one request and so one token of the global rate limit. Acknowledgement is monotonic and needs no version; a shelf has its own version per alarm point (not per equipment and epoch), raised also by the MES's own expiry. Their audit, `alarms.alarm_transition`, follows `downtime_audit`'s pattern (a trigger refuses UPDATE, DELETE and TRUNCATE; actor free text, `authenticated: false`, wall time, request id), and `alarms.occurrence_state` is insert-only by the same kind of trigger. Both move to `identity`'s audit log with the downtime audit in Phase 7.

## Note: problem types (#163)

Until #163 every problem answer was `type: about:blank`, and the web told the handover 409s apart by the prose prefix of `detail` (`handover closed`, `handover not open`, shared as `HANDOVER_PROBLEM`). Prose is not a contract: a reworded message would silently turn a closed window into a "stale version" on the screen. The answers a client must tell apart now carry stable `type` URIs, defined once in `@shopfloor/contracts` (`PROBLEM_TYPES`) and listed in the `Problem` schema of the OpenAPI document:

| Status | `type`                            | When                                                                                 |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------ |
| 409    | `urn:shopfloor:handover-closed`   | a note write after the handover window, for an older epoch, or without a plant clock |
| 409    | `urn:shopfloor:handover-not-open` | a note write before its shift began                                                  |
| 409    | `urn:shopfloor:note-stale`        | a note edit with a `version` that moved on                                           |
| 422    | `urn:shopfloor:note-limit`        | the 201st note of a shift instance                                                   |
| 409    | `urn:shopfloor:coding-stale`      | a coding write with a coding set `version` that moved on                             |
| 409    | `urn:shopfloor:shelf-stale`       | a shelve or unshelve with a shelf `version` that moved on                            |
| 403    | `urn:shopfloor:host-not-allowed`  | guard 1, the `Host` check (reads too)                                                |
| 403    | `urn:shopfloor:write-origin`      | guards 3 to 5: no `Origin`, a foreign one, `Sec-Fetch-Site` not same-origin          |
| 405    | `urn:shopfloor:writes-off`        | guard 2, `MES_WRITES=off`                                                            |
| 415    | `urn:shopfloor:write-not-json`    | guard 6                                                                              |
| 429    | `urn:shopfloor:write-rate`        | guard 7, with `Retry-After`                                                          |

Decision on the scope: the four handover types were asked for; the other write conflicts and the guard refusals got types too, because it cost one argument per place that already builds the problem (the module errors `CodingError`, `AlarmWriteError` and `ShiftError` carry an optional `type`, `HttpProblem` passes it on, the guard refusals name theirs) and keeps every write refusal on one rule. Everything else stays `about:blank`: 400 (validation), 404, 413, a read refused for its `Origin`, 422s other than the note limit (a coding outside its record, a shelf beyond `maxShelveMs`, an unshelve of a point not shelved), 503 and 500, where the status says enough or the client only shows `detail`. `urn:` names identify and are not meant to be dereferenced; RFC 9457 allows that, and there is no documentation host to point at.

The `detail` texts are unchanged (`handover closed: …`, `note 1 changed: version is 2, not 1`), so logs and people read the same; `HANDOVER_PROBLEM` is gone from contracts, since no client matches on prose any more. The web's note editor matches on `type` only; its other write screens keep mapping by status (`writeFailure`), which already distinguishes them, and a 409 or 422 without a known type falls back to that general mapping. A new client should match on `type` first, then status.

## Note: identity (#168)

Identity arrives as ADR-0026. What changes for writes, and what stays:

- **The guards stay the CSRF defence**, unchanged and in the same order: `Host`, `MES_WRITES`, `Origin`, `Sec-Fetch-Site`, JSON. No CSRF token is added; the session cookie is `SameSite=Strict` as a second layer. The login (`POST /api/v1/session`) passes the same guards, so a cross-site page can't log a browser in under another account (login CSRF).
- **Authentication and permission come after them** (with `MES_AUTH=on`): 401 `urn:shopfloor:unauthenticated` without a live session, 403 `urn:shopfloor:forbidden` when the session's roles lack the route's permission (`downtime:code`, `alarm:ack`, `alarm:comment`, `alarm:shelve`, `note:write`), 403 `urn:shopfloor:password-change-required` for a temporary password. A cross-site request is refused for its origin before anything reveals whether a session exists.
- **The rate limits move last**, after authentication, so an anonymous request spends no token. Guard 7, the global bucket, stays; each user gets a bucket of its own besides (5 per second, bursts of 10), checked first. Both answer 429 `urn:shopfloor:write-rate`. The login and logout are not writes for these buckets: logins have buckets of their own (per user name and all together, 429 `urn:shopfloor:login-rate`), so anonymous login attempts can't starve plant writes.
- **`MES_WRITES=off` exempts the login, logout and password change** (the other guards still apply), so a read-only MES with `MES_AUTH=on` still lets people log in.
- **The actor**: in #168 the writes still take `codedBy`, `actor` and `author` as typed and audit them as unauthenticated. #169 takes the user from the session when `MES_AUTH=on`, writes `identity.audit_log`, and moves the three module audits there; #170 removes the free-text fields.
- **Separate database roles** (the "Bad" consequence above, the MES owning its audit tables) follow in #169 (ADR-0027).

## Note: database roles and one audit log (#169)

The promise above is kept (ADR-0027): the MES connects as `mes_app`, which owns no table, so it can no longer disable an audit trigger, truncate an audit or change the schema (42501), and the append-only triggers still refuse everyone else. Writes take their actor from the session with `MES_AUTH=on` (the typed field is ignored) and from the typed field with `off` (then required, 422 without it); every write is audited in `identity.audit_log` in its own transaction, and the downtime and note audits are frozen legacy, copied into it.

## Note: actor from the session (#170)

The free-text `codedBy`, `actor` and `author` are removed from the requests (sending one is 400): every write takes its actor from the session, also with `MES_AUTH=off`, which now only opens reads and the WebSocket (ADR-0026, notes). `MES_AUTH=on` is the default.
