# Phase 07 – Orders, ERP and execution: learning notes

Phase 7 made the plant run from orders and gave every MES write a known user. Its parts:

- `identity`: users, roles, a permission matrix, scrypt passwords, server-side sessions, one append-only audit log;
- database roles, so the MES connects as a role that owns nothing and can't switch off an audit trigger;
- an ERP mock with a change feed of orders and idempotent confirmations;
- an order-driven simulator with an idempotent OPC UA method `LoadOrder` and job facts in the device sequence;
- a command path MES → UNS → gateway → device that delivers at least once and executes exactly once;
- the `orders` and `execution` modules: import, dispatch, every part through OP10–OP50, completion and confirmations;
- the orders screens and an operator terminal.

These notes explain the ideas behind them and give a reading order, questions _with full answers_ and an exercise. They are reference material; the learning step is optional, as in earlier phases.

## 1. Concepts

### Exactly once from at least once: device dedup

No network can deliver a message exactly once. A sender that gets no answer can't tell "lost on the way" from "done, answer lost", so it must either give up (at most once: maybe never done) or try again (at least once: maybe done twice). MQTT QoS 1, the outbox resends and the gateway's retries are all at least once.

Exactly-once is therefore not a delivery property but an **effect** property: deliver at least once and make the effect idempotent where it happens. Here that place is the device:

- Every command has a deterministic id, `{orderId}~OP10~{n}` (`n` the dispatch number of that order), so a resend, a redelivery and a replay after a crash all carry the same id.
- `LoadOrder` keeps a dedup table of the commands it accepted in the current run (device epoch). The same id with the same job answers `Duplicate = true` with the original `AcceptedSeq` and `AcceptedAt` and adds nothing; the same id with another job is `command-conflict`.
- The table is on the device, not only in the gateway, because the gateway can crash between the call and recording its result. The plan's probe showed it: a call that timed out on the client after the server acted, then retried, made two jobs without device dedup and one with it.
- **The proof is a fact, not an answer.** The device writes a job `accepted` event into its own sequence. The MES marks a command `confirmed` only when that fact arrives; `cmd-res` is the fast path. Exit criterion 3 counts `accepted` facts per command id (exactly one) and accepted quantity per order (at most the order quantity).

Two more rules keep a resend from doing harm: one command in flight per CNC (a resend can never overtake the next command and swap two jobs in the queue), and a re-dispatch only from settled answers and only for the quantity not yet accepted.

### Settling unknown outcomes: expiry as a fence and `seqAfterExpiry`

Sometimes the gateway can't know what happened: its deadline passed, the TCP connection broke, the session dropped mid-call. Guessing either way is unsafe. Answering "failed" invites a re-dispatch that may double the job; answering "accepted" may count a job that doesn't exist.

The design makes the question decidable later by giving every command an **expiry**:

- Each delivery carries `expiresAt` (wall time) and `deviceEpoch`. On a dedup **miss**, the device refuses a command whose `ExpiresAt` has passed by its own clock (`expired`) or whose epoch isn't the current run (`epoch-mismatch`). So once the device's clock is past `expiresAt`, it can never accept that command id again.
- The device checks dedup **first**. A late call for a job it already accepted always answers `Duplicate`, even after the expiry. That order is the whole trick: after the expiry, one more call gives a definitive answer, `Duplicate` (it was accepted) or `expired` (it never was, and never will be).
- **Settling:** after `expiresAt` plus a 1 s allowance, with the session ready and the device's own `CurrentTime` past the expiry too, the gateway reads `ShopFloor.Sequence` and calls once more. The sequence number it read is `seqAfterExpiry`.
- **Why `seqAfterExpiry` matters:** if the settle call itself fails, the result is still `unknown`, but it carries `seqAfterExpiry`. Any acceptance of the command happened before the expiry, so its `accepted` fact has a sequence number at most `seqAfterExpiry`. Once the MES holds every fact of that CNC up to `seqAfterExpiry` and none of them is the command's `accepted` fact, the command was never accepted, and a re-dispatch is safe. The MES uses "received through" (every number up to it received), not final-through, so a fact lost in a written-off gap can never make a second job (ADR-0029 note).
- An accepted limit: a finished simulator run answers every call with a transient status, so an outcome unknown at the run's end stays `unknown` until the gateway sees a new epoch; the MES's `failed` incident and the epoch rule cover it.

### Several answers for one command: `cmd-res` precedence

A command id can collect many `cmd-res` messages: one per delivery, a settle result, a redelivered answer from the gateway's result table. They can arrive in any order. ADR-0029 fixes how to read them, and the MES computes a command's state as a pure function of its deliveries, results and job facts, so the order of arrival doesn't matter (a property test shuffles them):

- `accepted` and `duplicate` are **sticky** per command id and device epoch: the job exists, and no later `expired`, `unknown` or `command-conflict` revokes it.
- `expired` and `unknown` hold only for the delivery they answer, named by its `expiresAt`. An `expired` for one delivery says nothing about a resend with a new `expiresAt`.
- `unknown` never overrides a definitive answer for the same `expiresAt`, and any definitive answer replaces it.
- `rejected` is final for the command id, except `command-conflict` after an acceptance (the device holds another job under the id: a defect, kept unsettled until its run ends).
- `failed` is not a gateway answer. It is the MES's own state for a command with no final result after the first unanswered delivery's `expiresAt` plus a margin: an incident for the supervisor, which settles nothing.

The gateway follows the same rule for what it stores: only definitive answers, keyed with the device epoch (a gateway file outlives a run, and command ids repeat across runs), `expired` also with its `expiresAt`, and never `unknown`.

### Database roles, `SET ROLE` and continuous-aggregate ownership

In PostgreSQL the **owner** of a table can do anything to it: `ALTER TABLE … DISABLE TRIGGER`, `TRUNCATE`, `DROP`. Until Phase 7 the MES connected as the image's bootstrap superuser and owned every table, so the append-only triggers of the audits protected against bugs, not against the application. ADR-0027 splits the roles:

| Role                  | Login | Owns                                      | Used by                                        |
| --------------------- | ----- | ----------------------------------------- | ---------------------------------------------- |
| `DB_USER` (superuser) | yes   | nothing it keeps                          | the one-shot `migrate` service only            |
| `mes_owner`           | no    | every schema, table, function and trigger | migrations, under `SET ROLE mes_owner`         |
| `mes_cagg`            | no    | the two continuous aggregates             | the MES's refresher, under `SET ROLE mes_cagg` |
| `mes_app`             | yes   | nothing                                   | the MES                                        |

- `mes_app` gets exactly the grants in `DECLARED_GRANTS`: DML on ordinary tables, `SELECT, INSERT` only on the append-only ones, `SELECT` only on the frozen legacy audits, no `DELETE` on handover notes. A test compares the declaration with the catalog.
- **`SET ROLE`** switches the current role inside a session to one the session's user is a member of; `RESET ROLE` switches back. `mes_app` is a member of `mes_cagg` with `INHERIT FALSE`: it has none of `mes_cagg`'s rights until it explicitly does `SET ROLE mes_cagg`.
- **Why the aggregates need their own owner:** TimescaleDB lets only an aggregate's owner refresh it, and `refresh_continuous_aggregate()` can't run inside a function, a `SECURITY DEFINER` procedure or a transaction block (all probed). So the usual trick, a definer function owned by a privileged role, is impossible. The refresher therefore runs `SET ROLE mes_cagg`, the `CALL`, `RESET ROLE` on its own connection, outside a transaction.
- **The accepted cost:** as `mes_cagg`, the MES could drop the two aggregates. They are derived data a refresh rebuilds. The audit tables belong to `mes_owner`, of which `mes_app` is not a member, so they stay out of reach. A test asserts both halves.
- **Older databases:** `REASSIGN OWNED BY postgres` fails (objects "required by the database system"), so `migrate` moves each object with its own `ALTER … OWNER TO`, once, recorded like a migration.

### Passwords with scrypt, and sessions in a cookie

- **Why a slow hash.** A stolen password table is attacked offline with fast hardware. A password hash should cost the attacker as much as possible per guess while costing the server an acceptable amount per login. **scrypt** is memory-hard: each hash needs N × r × 128 bytes of memory (here N = 2^15, r = 8: 32 MiB), which GPUs and ASICs can't parallelise cheaply. p = 3 repeats the work.
- **Details that matter:**
  - Node's default `maxmem` is 32 MiB, which these parameters just exceed, so every call passes `maxmem: 64 MiB` explicitly (the plan's probe found the failure);
  - at most two hashes run at once, so a login burst stays inside a 512 MiB container;
  - the stored string `scrypt$N$r$p$salt$hash` names its own parameters, so the cost can rise later and old hashes are rehashed at the next successful login;
  - a 16-byte random salt per password defeats precomputed tables;
  - an unknown username still costs one dummy hash, and the 401 text is the same in every case, so timing and wording don't reveal which usernames exist.
- **Sessions, not JWTs.** The login sets an opaque 256-bit random token in the cookie `sft_session` (`HttpOnly`: no script can read it; `SameSite=Strict`: not sent on cross-site requests). The MES stores only the token's SHA-256, so a database leak gives no usable session. Logout, a password change or disabling a user ends sessions at once, which a self-contained JWT can't do without a server-side revocation table anyway.
- **Expiry:** idle (60 min on a desk, 15 min on a terminal) and absolute (12 h). Pushed WebSocket messages don't count as use; a person's input does.
- **Lockout:** five failures lock a normal account for 15 minutes. `admin` gets a doubling delay instead, so an attacker can't lock out the one account able to unlock the others. Per-account lockout lets anyone keep a known user locked: accepted on a loopback plant network until Phase 9.
- **Order of the checks:** `Host`, `Origin` and `Sec-Fetch-Site` (the CSRF defence of ADR-0023) come first, then 401 and 403. A cross-site request never learns whether a session exists.

### ERP idempotency keys and feed identity

- **Inbound: a change feed with a cursor.** `GET /orders?after={cursor}` returns order versions in feed order. The MES commits the cursor in the same transaction as the orders of that page, so a crash never skips a page or half-imports it; a repeat imports nothing new because imports are keyed (order number, revision).
- **Feed identity.** A cursor is a position in one particular feed. If the ERP's dataset is replaced or its store deleted, position 37 means something else. Each page carries `feedId`, a hash of the expanded dataset and of a store id created once with the store. When it changes, or the ERP answers 409 `erp-cursor-ahead`, the MES raises an `erp-feed-changed` incident and restarts from 0, which is safe because imports are idempotent.
- **Outbound: keys built from the message.** Every confirmation and status message carries an `Idempotency-Key` computed from its content: `{order}~{operation}~conf~{n}` (n = 1 the final confirmation, 2, 3, … corrections) and `{order}~r{revision}~status~{status}`. The ERP:
  - answers 201 the first time and 200 with the stored answer for the same key and body (a replay after an MES crash between the ERP's answer and the MES's commit);
  - refuses with 422 a key that is not the one built from the body;
  - answers 409 for a known key with a different body.
- A 409 is not retried. The MES itself built two different messages under one key, which is a defect for a person to look at, so it becomes an `erp-conflict` incident. Retrying would only repeat the conflict.
- The closing proof (criterion 4): the live run resets the MES's outbox and posts every message again; the ERP's counters show 63 replays and 0 creations, and its totals stay byte-identical.

### Units and attribution

- **A unit** is one physical part, keyed (device epoch, `partId`). `partId` is the simulator run's counter, unique within a run and restarting with it; serials are given at OP10 and repeat across runs. Real serial identity is Phase 8's genealogy.
- **Attribution by job facts.** An OP10 cycle belongs to the job whose `started` fact is the latest one below it in that CNC's sequence. A CNC machines one part at a time, so this is exact, and because it uses sequence numbers, not arrival order, it survives reordering. Every later record of the unit inherits the order.
- **Rebuild, never patch.** A unit is rebuilt from all its cycle facts whenever one arrives, and OP10 cycles after a new `started` fact are rebuilt with their units. A late fact renumbers passes and re-attributes units by recomputing, the same principle as Phase 4's intervals and Phase 6's occurrences.
- **Passes and routing breaks.** A leak-test `rework` opens pass 2 at OP30 and OP40. A record where another operation was expected is a **suspect** until the expected operation's machines are final through its time; only then is it a `routing-violation` incident. Facts are never refused.
- **Backflush at cycle completion (H2).** Material is booked from the BOM per completed cycle, because the MES knows a cycle only from its completion fact. The ground truth books it at the same point, so they reconcile; material taken for a cycle still running is reported separately and not compared.

### Completion: "no unit can still come back" (H1)

An order operation is complete when its quantities can no longer change, not when the expected count is reached:

- **OP10** when every command is settled and every job `completed`, with its CNC final through the `completed` fact.
- **OP20** when every unit passed it for good or was scrapped.
- **OP30 and OP40 together**, only when every unit passed OP40 for good or was scrapped: a unit with one leak failure goes back to OP30 for a second pass, so neither operation is done while it is open.
- **OP50** when every unit is packed or scrapped.
- Everything is judged on **final data** (each record at or below its machine's final-through) and with open routing suspects blocking: a suspect may be explained by a fact still in an open gap.
- One final confirmation per operation follows completion. A fact that arrives after its gap was written off can still change totals; then a **correction** carries the signed deltas, judged against what was confirmed before (the Phase 6 rule: judge against the old bound).

The review of PR #188 found both failure modes of a weaker rule: an order completing early while a fact was still in a gap, and an order never completing after a gap was written off.

### Mutation testing as a review tool

A test passing tells you the code does something the test accepts, not that the test would notice the code being wrong. **Mutation testing** checks the test: change the code under test on purpose (a mutant: drop a condition, ignore a message, flip a comparison) and run the test. If the test still passes, it doesn't protect that behaviour.

The review of PR #191 used it on exit criterion 3's hardest case: a job executed on the device whose fact and answer are held in the gateway's outbox past the MES's failure margin.

- Mutant 1 made the MES ignore a `duplicate` answer. Case (a) still passed, because the held fact was released before the assertion and settled the job by itself. The fix injects the `duplicate` while the fact is still held, so the answer alone must settle it.
- Case (b) passed only because an earlier test had prepared its state; run alone it was vacuous. It now seeds its own precondition.
- After the fix the reviewer's mutants fail both tests, each run alone.

Full mutation tools (Stryker, for example) generate mutants automatically. In review, a few hand-made mutants aimed at the property a test claims to prove are often enough.

## 2. Reading order

| #   | File                                                                                                                              | Look for                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `docs/phases/phase-07-plan.md`                                                                                                    | "Command path", the results table, exit criterion 3                      |
| 2   | `docs/adr/0029-command-path-at-least-once-with-device-dedup-and-settled-outcomes.md`                                              | Settling, result memory, how a consumer reads several results            |
| 3   | `docs/adr/0030-order-driven-simulator-loadorder-and-job-facts.md`, `apps/simulator/src/opcua/`                                    | `LoadOrder`'s order of checks: dedup, epoch, expiry                      |
| 4   | `apps/edge-gateway/src/commands/executor.ts`, `load-order.ts`, `store.ts`                                                         | One call at a time, the deadline, the epoch re-read, the settle call     |
| 5   | `apps/mes-server/src/modules/orders/command-state.ts`, `dispatch-rule.ts`, `publisher.ts`                                         | The pure command state, the dispatch rule, the outbox                    |
| 6   | `docs/adr/0027-database-roles-and-one-audit-log.md`, `apps/mes-server/src/db/roles.ts`, `grants.ts`, `aggregate-refresh.ts`       | The roles, `DECLARED_GRANTS`, the `SET ROLE` refresh                     |
| 7   | `docs/adr/0026-identity-sessions-roles-and-auth-switch.md`, `apps/mes-server/src/modules/identity/password.ts`                    | scrypt parameters, the semaphore, sessions, lockout                      |
| 8   | `packages/contracts/src/identity.ts`, `apps/mes-server/src/identity.test.ts`                                                      | `ROLE_PERMISSIONS`; the route matrix compared with the OpenAPI document  |
| 9   | `docs/adr/0028-erp-mock-rest-feed-and-idempotent-messages.md`, `packages/contracts/src/erp-api.ts`, `apps/erp-mock/src/server.ts` | `confirmationKey`, `statusKey`, `feedId`; 201, 200, 409, 422             |
| 10  | `docs/adr/0031-execution-units-completion-and-confirmations.md`, `apps/mes-server/src/modules/execution/derive.ts`                | Attribution, passes, suspects, completion, corrections; the note of #178 |
| 11  | `apps/mes-server/src/orders.e2e.test.ts`                                                                                          | The exactly-once cases; (a) and (b) of the held fact                     |
| 12  | `e2e/src/orders-pass.ts`, `e2e/browser/orders/`                                                                                   | The live order path, the terminal judgement, the re-post check           |

## 3. Questions, with answers

**1. MQTT QoS 2 promises "exactly once". Why doesn't the command path rely on it?**

QoS 2 is exactly once only between one client and the broker, and only while both keep their session state. The path has more hops: MES outbox → broker → gateway → OPC UA call → device. The gateway can crash after the call and before recording the answer, the OPC UA call can time out after the device acted, and the MES can restart between its commit and the publish. None of these is covered by any MQTT QoS. Idempotent execution on the device, with a deterministic command id, covers all of them, so QoS 1 is enough.

**2. Why is the command id deterministic (`{orderId}~OP10~{n}`) and not a random UUID?**

So that every retry, at any layer, carries the same id. A random id generated at publish time would differ after an MES crash between the outbox commit and the publish, and the device would see a new command. The deterministic id also lets the golden scenario name the ids the MES will generate, so the headless run and the live run produce the same job facts.

**3. Why must `LoadOrder` check its dedup table before the expiry and the epoch?**

Because the settle call depends on it. After the expiry the gateway calls once more to learn the outcome. If the device checked the expiry first, it would answer `expired` even for a job it had accepted, and the gateway would wrongly conclude "never accepted". With dedup first, an accepted job always answers `Duplicate`, and only a miss can answer `expired`, which then really means "never accepted, and never will be".

**4. A gateway call times out. Why doesn't the gateway answer `failed` or `expired` at once?**

It doesn't know the outcome: the device may have accepted the job after the client stopped waiting. `failed` would invite a re-dispatch and a second job; `expired` would claim the device refused it. The gateway retries until `expiresAt` (each retry is safe because of dedup), then settles with one call after the expiry. Only the device's own answer decides. If even that is impossible, it says `unknown` and carries `seqAfterExpiry`.

**5. What exactly does `seqAfterExpiry` prove, and when may the MES re-dispatch because of it?**

It is a device sequence number read after the device's clock passed the command's expiry. The device can't accept the command after the expiry, so any `accepted` fact of that command has a number at or below `seqAfterExpiry`. Once the MES has received every fact of the CNC up to that number and none of them is the command's `accepted` fact, the command was never accepted. Only then, with every earlier command settled and within the quantity not yet accepted, may the supervisor re-dispatch.

**6. Why does the settle call wait for the device's own clock, not only the gateway's?**

The device decides `ExpiresAt` by its own clock. If the gateway's clock runs ahead, the gateway could read `seqAfterExpiry` while the device still accepts the command; a fact numbered above that `seqAfterExpiry` would break the proof. Reading `Server_ServerStatus_CurrentTime` and requiring it past the expiry plus 1 s makes the bound hold whatever the two clocks say (review of PR #184).

**7. A command has results `accepted` (first delivery), then `expired` (a resend), then `unknown` (a settle). What is its state?**

Accepted. `accepted` is sticky per command id and device epoch: the job exists. The `expired` refers only to the resend's `expiresAt` and can't be true for a job the device holds (a resend of an accepted id would have answered `Duplicate`), and an `unknown` never overrides a definitive answer. The command becomes `confirmed` when the device's `accepted` job fact arrives.

**8. Why is one command in flight per CNC necessary if the device deduplicates?**

Dedup prevents doubles, not reordering. If commands A and B were both in flight and A's first delivery was lost, B would be queued first and A's resend second: the CNC would run them in the wrong order, against the dispatch rule's plan. Publishing the next command only after the previous one has a final result keeps the queue in dispatch order.

**9. Why is the MES's `failed` an incident and not a final result?**

`failed` means "no answer within the margin", which is ignorance, not knowledge. The job may exist on the device with its fact held in a gateway outbox (exit criterion 3's hardest case). Treating `failed` as "no job" would allow a re-dispatch and a second job. So `failed` alerts the supervisor and blocks the CNC, and the command is settled only by a definitive answer, by received-through passing `seqAfterExpiry`, or by its run ending.

**10. The MES owned its tables and had append-only triggers. What was wrong with that?**

A table's owner can disable its triggers (`ALTER TABLE … DISABLE TRIGGER`) or `TRUNCATE` it. The audit's protection was therefore only as strong as the application's own code. A bug or a compromised MES could rewrite history. With `mes_owner` owning the tables and the MES connecting as `mes_app`, the database refuses these statements with 42501, and the triggers fire for every insert, update and delete `mes_app` attempts.

**11. Why can't a `SECURITY DEFINER` function owned by `mes_cagg` refresh the aggregates, and what replaced it?**

TimescaleDB refuses to run `refresh_continuous_aggregate()` inside a function, procedure or transaction block (SQLSTATE 25001), because the refresh manages its own transactions. So `mes_app` is a member of `mes_cagg` with `INHERIT FALSE`, and the refresher runs `SET ROLE mes_cagg`, the `CALL`, `RESET ROLE` on its own connection, outside any transaction. Without `SET ROLE` it has none of `mes_cagg`'s rights.

**12. What does the MES give up by being able to `SET ROLE mes_cagg`?**

As `mes_cagg` it owns the two aggregates, so it could drop or alter them. That was accepted because they are derived data, rebuilt by a refresh from the raw tables. The raw tables and every audit belong to `mes_owner`, of which `mes_app` is not a member, so they stay protected. A test asserts both: a `DROP` of an aggregate succeeds under `SET ROLE mes_cagg` (rolled back), and `ALTER TABLE identity.audit_log DISABLE TRIGGER` fails with or without it.

**13. Why scrypt with a 32 MiB cost, and why does the code pass `maxmem` and limit concurrency?**

A memory-hard hash makes each offline guess cost memory as well as time, which specialised hardware can't parallelise cheaply. 32 MiB per hash is an OWASP-listed setting. Node refuses parameters needing more than its default `maxmem` of 32 MiB, and these need just over it, so `maxmem: 64 MiB` is passed explicitly. Two hashes at a time cap a login burst at about 64 MiB, well inside the MES's 512 MiB container.

**14. Why does the MES store only the SHA-256 of the session token, and why is a fast hash fine here?**

So that a copy of the database contains no usable session: presenting the hash as a cookie doesn't work. A fast hash is fine because the token is 256 random bits, not a human password: there is nothing to guess, so slowing down guesses adds nothing.

**15. Why are 401 and 403 checked after the `Origin` checks?**

A cross-site page can make the browser send a request, but it can't read the answer. If the session check came first, the difference between 401 and 403 (or 403 and success) would tell a hostile page, through timing or side effects, whether the user is logged in. With the origin checks first, every cross-site request gets the same 403, whatever the session.

**16. The ERP answers 409 for a confirmation. Why does the MES not retry it?**

409 means the ERP already holds a different message under the same `Idempotency-Key`. Keys are built from the message (order, operation, confirmation number), so this can only happen if the MES built two different messages for the same slot, which is a defect. A retry would get the same 409 for ever. The MES records an `erp-conflict` incident for a person to investigate. Transient failures (5xx, timeouts) are retried with backoff, and a replay of the same body gets 200.

**17. Why does the MES commit its ERP cursor in the same transaction as the imported orders?**

Otherwise a crash between the two leaves them out of step. Cursor first: the page's orders were never imported and are skipped for good. Orders first: they are imported again, which is harmless only because imports are idempotent by (order, revision). One transaction makes "imported" and "cursor moved" a single fact.

**18. An OP10 cycle arrives before the job's `started` fact. To which order does the unit belong?**

To none yet. Attribution is by the latest `started` fact below the cycle in the CNC's sequence, and until that fact arrives the unit counts nowhere. When it arrives, the OP10 cycles after it are rebuilt with their units and attributed. That is why the golden reconciliation shuffles deliveries and judges every step on partial data: the end result must not depend on arrival order.

**19. All 12 units of an order have passed OP40 except one, which failed the leak test once and went back to OP30. Is OP30 complete? Is OP40?**

Neither. The unit will do a second pass at OP30 and OP40, so both can still change. They become complete when that unit passes OP40 for good or is scrapped (a second leak failure scraps it). A rule that compares good parts with the order quantity would have confirmed OP30 too early and then had to correct it.

**20. When can a correction be sent after a final confirmation, and what does it carry?**

Completion is judged on final data, so the normal case has no correction. One is possible only when a fact that had been written off in a gap incident arrives later and changes the totals. The correction carries the signed difference against the totals last confirmed (stored with each confirmation), as confirmation n + 1. It is judged against what was sent, not against a recomputation of the past.

**21. Exit criterion 3's last case passed. How did the reviewer show it wasn't evidence yet?**

By mutation. The reviewer changed the MES to ignore `duplicate` answers, and the test still passed, because the held job fact was released before the assertion and settled the job by itself. The other variant passed only when run after a test that had set up its state. A test that passes with the behaviour removed proves nothing about the behaviour. The fixed tests inject the `duplicate` while the fact is still held and seed their own preconditions, and the mutants now fail them.

**22. The live run raised a false `routing-violation` once in several runs. What was the bug, and which earlier lesson does it repeat?**

The execution module rebuilt its units and then read each machine's final-through. A washer cycle stored between the two reads was counted as final but wasn't in the rebuilt units, so its unit's OP30 record looked like a skipped OP20. It is the Phase 5 and 6 bug class: a bound read after the work it judges. The fix reads the progress first, through ingest's queue, so every fact it counts is already in the round's pending set or an earlier round.

## 4. Hands-on exercise

Run an order end to end on a disposable stack, in orders mode, and look at the command path and the roles. Nothing is written into a database you keep.

1. Your `.env` needs `DB_APP_PASSWORD`, `ERP_API_TOKEN` and `MES_BOOTSTRAP_ADMIN_PASSWORD` (runbook, "Identity"). Stop your normal stack (same ports), then start a separate project in orders mode: `COMPOSE_PROJECT_NAME=shopfloor-learn SIM_PRODUCTION=orders pnpm stack:up`.
2. Log in at <http://localhost:8080/login> as `admin` with the bootstrap password and choose a new one. In `/admin/users` create a supervisor and an operator (note the temporary passwords). Try `/orders` as admin: you see the orders but no release or dispatch control.
3. Log out and log in as the supervisor (change the temporary password). Open an order in `/orders`, release it, then dispatch it. Watch the command on the order's page: its delivery, the gateway's `cmd-res` (`accepted`, with `acceptedSeq`), then `confirmed` when the device's job fact arrives. The simulator's first job starts with a changeover `CHANGEOVER none→…`.
4. In a private window (cookies are per browser profile), open `/terminal`, choose Line A1 and sign on as the operator. Start, pause with a reason and resume work on the order's operation, and watch the counts follow the cycles.
5. Open a database shell: `docker compose -p shopfloor-learn exec db psql -U shopfloor shopfloor` (or `DB_USER` and `DB_NAME` from `.env`, if set). Then:
   - `SELECT action, username, roles, authenticated, request_id FROM identity.audit_log ORDER BY id DESC LIMIT 10;` shows your release, dispatch and terminal actions with their users;
   - `SET ROLE mes_app; ALTER TABLE identity.audit_log DISABLE TRIGGER ALL;` is refused with 42501, and so is `TRUNCATE identity.audit_log;`;
   - `RESET ROLE;` returns to the superuser.
6. See dedup at work in the tests: run `pnpm --filter @shopfloor/edge-gateway exec vitest run src/commands/executor.test.ts` and read the case "retries a call that timed out after the device acted, and learns Duplicate (one job)".
7. Remove everything: `COMPOSE_PROJECT_NAME=shopfloor-learn docker compose down --volumes`.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
