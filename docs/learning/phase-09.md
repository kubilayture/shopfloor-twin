# Phase 09 – Simulation console, scenarios and hardening: learning notes

Phase 9 made the plant steerable from a browser, measured OEE per order and per line, hardened every protocol of the stack, and then tried to break it on purpose. Its parts:

- order OEE over job windows and a throughput line OEE against a derived bottleneck, in `oee-core`, in the simulator's ground truth (`line-oee.json`) and in the MES, on the order detail and the OEE dashboard;
- console actions in the simulator (lot block and release, operators absent, tool breakage), YAML scenario timelines played headless and live, and the recording and headless replay of a live run's dispatches;
- a simulation console in the web app behind an allowlisting nginx proxy;
- incremental SPC derivation and hold scopes rebuilt on change;
- OPC UA SignAndEncrypt with pinned certificates and named users, MQTT dynamic security with every user bound to one client id, an HTTPS-only front with a per-stack dev CA, and login throttling per (account, address);
- a resilience suite (runs R1–R3) and a performance suite (runs P1–P3, targets T1–T6), and a written security review.

These notes explain the ideas behind them as questions with full answers, give a reading order and one exercise. They are reference material: nothing here waits for an answer, and the learning step stays optional, as in earlier phases.

## 1. Concepts in one page

- **Order OEE** is the OEE of the time the plant gave one order: each of its jobs' windows on its CNC, from the job's **head time** (when it reached the front of the CNC's queue) to its `completed` fact. Inside the windows the usual equipment rules apply (ADR-0021). Its first-pass yield across the whole routing is shown beside it, never multiplied in.
- **Line OEE** is a throughput ratio: good packed units × the bottleneck's effective ideal cycle ÷ the line's planned busy time. One number, no A × P × Q split, and it may exceed 1.
- **The bottleneck is derived**, not configured: per product, the operation with the largest ideal cycle ÷ number of machines running it. Here ASM-01 for both products.
- **Finality** (ADR-0018) is the promise that a number will never change. Every Phase 9 number has a rule for when it becomes final, and a rule for when it never can.
- **A console action is a new event variant**, written only by runs that use it, so the golden event logs keep every byte.
- **Replaying a live run** needs the point of every input in the event stream (`acceptedAt` and `afterEvents`), not only its time.
- **Trust is pinned where it can be** (OPC UA leaf certificates, Chromium's SPKI list) and **scoped where it must be shared** (a name-constrained dev CA for HTTPS).
- **Identity is bound to the transport where the protocol lets it**: an MQTT user to one client id, a session cookie to one host and HTTPS, a client address to the network nginx is on.
- **A test that cannot fail proves nothing.** Phase 9's proof suites spent as much effort on making their judges fail on purpose as on passing them.

## 2. Reading order

| #   | File                                                                                                                                                  | Look for                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | `docs/phases/phase-09-plan.md`                                                                                                                        | "Decisions made in this plan", the exit criteria, the three review rounds                                  |
| 2   | `docs/adr/0036-order-oee-line-throughput-oee-and-derived-bottleneck.md`, `docs/oee-reference-cases.md` (B, H, O, F, L cases)                          | Head time, job windows, the queue contract, `aboveOne`, the amendments for `notBefore`, P9-04/05 and P9-F1 |
| 3   | `packages/oee-core/src/` (`bottleneck`, head times, `jobWindows`, `orderOee`, `lineOee`)                                                              | Exact fractions; how a lost fact makes a value provisional or never final                                  |
| 4   | `apps/mes-server/src/modules/oee/order-oee.ts`, `order-queue.ts`, `line-oee.ts`, `line-inputs.ts`                                                     | Derived on read; finality per job, order and bucket; the newest-epoch rule                                 |
| 5   | `docs/adr/0037-console-actions-as-new-event-variants.md`, `apps/simulator/src/plant/console-actions.test.ts`                                          | Draws kept; the external lane; Q2 and `afterEvents`; the `/sim/` proxy                                     |
| 6   | `config/scenarios/monday-breakdown-and-recovery.yaml`, `packages/plant-config` (`scenarioSchema`)                                                     | One schema for timelines and golden `scenario.json`                                                        |
| 7   | `apps/web/nginx/default.conf.template`, `apps/mes-server/src/edge.ts`                                                                                 | The exact-route allowlist, `auth_request`, the Origin check, the `edge` CIDR                               |
| 8   | `packages/spc-core` (`SpcDerivation`, `incremental.test.ts`), ADR-0032 and ADR-0035 amendments                                                        | Resuming from the earliest changed reading; the property test against `spcChart`                           |
| 9   | `docs/adr/0038-opcua-signandencrypt-pinned-certificates-and-users.md`, `packages/pki`, `apps/simulator/src/opcua/security.test.ts`                    | Probe Q1, pinning versus a CA, the writable-variables finding, the pin race                                |
| 10  | `docs/adr/0039-mqtt-dynamic-security-https-front-and-login-throttling.md`, `config/mosquitto/`, `apps/edge-gateway/src/broker-security.test.ts`       | Binding, the takeover Mosquitto allows, the ACL parity test                                                |
| 11  | ADR-0039 "HTTPS" and "Login throttling", `apps/mes-server/src/modules/identity/`, `apps/mes-server/src/identity.test.ts`                              | `__Host-`, the Chromium SPKI pin, the reservation under the row lock, the burst test                       |
| 12  | `docs/adr/0009-lossless-opcua-delivery.md` (amendment), `e2e/src/resilience.ts`                                                                       | Settled checks, the ε window in simulated time, `exercised`                                                |
| 13  | `docs/adr/0040-load-testing-with-a-node-script-and-measured-targets.md`, `docs/phases/phase-09-perf-results.md`, `e2e/src/perf.ts`, `perf-metrics.ts` | How each target is judged; the coordinator decisions                                                       |
| 14  | `docs/security-review.md`                                                                                                                             | The STRIDE table and the evidence per item                                                                 |

## 3. Questions, with answers

### OEE per order and per line

**1. Why does an order's OEE start at the job's head time and not at its `started` fact?**

Because the changeover belongs to the order that caused it. A CNC sets up for a job (`Setup`, cause changeover) before it takes the first blank, and the `started` fact is written only at that first blank. A window that started at `started` would hand the changeover's minutes to nobody, and the order that needed a different program would look better than it was. The head time is the moment the job reached the front of its CNC's queue: `max(its accepted fact, the previous job's completed fact on that CNC, its dispatch's notBefore)`. All three are facts or command data the ground truth and the MES see alike, so both sides compute the same instant. `notBefore` joined the rule after review (#251): a job held back by its dispatch waits for demand, not for the machine, and charging that wait to the order would be wrong.

**2. Why not split every machine's time between orders by the units each order had there?**

Because the plant doesn't attribute that time to orders; a rule would. A CNC runs one job at a time, so its time in a job window belongs to that job without any key. ASM-01, the washer, the leak tester and the packer interleave units of both CNCs' orders, and dividing their idle and down time by units would be an allocation key the ground truth would have to invent and the MES copy. Two systems agreeing on an invented key prove nothing about the plant. So the order OEE is the OP10 time only, and the rest of the routing appears where it is factual: in the first-pass yield (units packed good on their first pass ÷ units started) and in the line OEE.

**3. How is the bottleneck found, and why is it ASM-01 although OP10 has the longest cycle?**

Per product, the operation with the largest **effective** cycle, its ideal cycle ÷ the number of machines that run it, ties to the earlier operation. VB-100: OP10 240 s on two CNCs is 120 s, OP30 on ASM-01 150 s. VB-200: 330 s ÷ 2 = 165 s against 210 s. So ASM-01 for both. The first draft of the plan picked the raw cycle and would have named OP10; review round 2 caught it. The bottleneck is derived in `oee-core` rather than written into `oee.yaml` because that file is hashed into every golden summary's `analysisConfigSha256`: a new key would have regenerated four goldens to state a fact the routing already implies.

**4. When only one CNC has work, the CNC is the real constraint. Why does the bottleneck stay ASM-01?**

So that a bucket's ratio always means the same thing. Line OEE compares good output with what the designed bottleneck could have done in the planned time. If the bottleneck moved with the day's dispatch, the numerator's ideal cycle would change between buckets, and a shift's value would no longer be the sum of its hours. With the bottleneck fixed, an idle CNC shows as what it is: fewer good packs, a lower line OEE (reference case "one CNC working").

**5. Why can line OEE exceed 1, and why is it not capped?**

The ratio uses the bottleneck's ideal cycle, but a bucket is a slice of time and the line has buffers. An operator faster than ideal (`op-b1`, speed factor 0.95) or units already in the buffers draining into a short bucket can pack more than the ideal rate allows for that bucket's time. `week-01`, Monday 10:00–11:00 Istanbul, packed 13 units where the bucket's planned time allowed 12 at ASM-01's ideal cycle: 13/12 = 1.0833, flagged `aboveOne`. A cap at 1 would make the hours stop summing to the shift, and the screen would hide the very effect a supervisor should see. The dashboard says why instead.

**6. Why is per-order line OEE "not additive"?**

Orders overlap in time. Each order's line OEE divides its own good packs by its own in-progress time, and two orders in progress at once both count the overlapping minutes. Summing their numerators and denominators double-counts the overlap, so the per-order values neither add up to the line's nor average to it. The API and the screen say so next to the value.

**7. When is an order's OEE final, and when can it never be?**

Final when nothing can still change it: every job's window is closed with a known head time, every command of the order is settled, the CNC's pieces cover each window and none is provisional, exactly `quantity` cycles lie inside each window, and the execution module has processed the CNC through each window's end. The first-pass yield becomes final when the order is complete (ADR-0031). **Never final** on a lost path: if a written-off gap swallowed both the `accepted` fact and the command result's `acceptedAt`, or the previous job's `completed` that can't be recovered from its last cycle (ADR-0036: `previous-completed-lost`), the head time is unknown for good (`headTimeUnknown`, `lost`). The value is still shown, marked provisional; claiming it final would promise something the data can't support.

**8. Why does the MES's job queue include commands whose acceptance it never saw?**

Because a queue built from job facts alone can be wrong in a way that looks right. One written-off gap can cover J1's last cycle, J1's `completed`, and J2's `accepted` and `started`. Cycles belong to the job whose `started` fact is the latest before them (ADR-0031), so with J2's `started` missing, J2's cycles would be attributed to J1, giving J1 a too-long window that could then be finalised (reference case H16). Keeping every dispatched command whose acceptance isn't refuted holds J1's attribution boundary open, so J1 stays provisional. This is the "queue contract" of ADR-0036.

**9. A simulator restart starts a new device epoch over the same plant time. What did P9-F1 change about line OEE finality?**

Two runs over the same hours must never both count. The rule since P9-05 is that per bucket and machine only the newest epoch with data counts; P9-F1 (#257, PR #266) closed what that rule missed. A bucket is final only with one run across all its machines (the review found PCK-01's run-1 packs over ASM-01's run-2 pieces called final); a machine counts toward the line's final-through only once its stream is in the plant clock's epoch; and every line bucket carries the epoch it was derived under, so the web takes the newer epoch's answer over an older final. A restart over the same plant time therefore **withdraws** finals of the re-lived hours. That sounds like breaking ADR-0018's promise, and it is a qualified one: no final differs from a recomputation over the runs seen so far, and a run not started yet can't be foreseen. The ADR and the API description now say "final within an epoch".

### Console, timelines and dispatch replay

**10. Why is every console action a new event variant written only when used?**

Because the four goldens are byte-identical event logs. Adding a field or an event every run writes would change every log, every `events.sha256` and every summary, and need the owner's approval to regenerate. A variant written only by runs that use it, listed under a new header key `actions` only when present, leaves every existing run untouched; `pnpm test:golden` asserts it.

**11. Marking an operator absent and breaking a tool: why must they keep the random draws exactly?**

Each random stream (ADR-0007) is a sequence; if an action skips or adds one draw, every later value of that stream shifts, and the run after the action differs everywhere, not just where the action acts. So forced absence still draws the roster for every operator and shift (and then overrides the result for the listed ones), and a tool breakage sets the wear to 1.0 instead of inventing a breakdown: the cycle in progress still makes its one defect draw, at the end-of-life probability, and the tool change that follows draws nothing. The run before the action is identical, and every other stream draws the same sequence. Tests count the draws per stream.

**12. Why must both ASM-01 operators be marked absent to see `NO-OPERATOR`?**

Every shift has two operators qualified for ASM-01, and the first present one takes the station. Marking one absent changes nothing visible. The plan's first draft marked one; review round 1 checked `operators.yaml` and changed the example and the test to mark both, so the test can fail.

**13. How can a timeline played live at any speed give the same event log byte for byte as headless?**

By keeping pacing out of the model. The wall clock decides only when a step runs, never what it does. Plant entries of the timeline (failures, drifts, lot actions, absences, tool breakage) are all accepted at the start in the headless order, so the event queue equals the headless run's before the first step. Infrastructure entries (OPC UA offline, Modbus silent, speed, pause) don't touch the plant model; they are pacer cues applied once every event up to their time is processed, and headless ignores them. One subtlety needed a new mechanism: a console post made mid-run for a later time must land where the headless run would put it, even on a millisecond that already holds a model event. `sim-core` gained an **external lane**: accepted inputs run before the model's events of their millisecond, in acceptance order.

**14. Why are `dispatch` entries refused in a live timeline?**

In a live orders run the MES dispatches jobs through OPC UA `LoadOrder`. A timeline that also dispatched would make two sources of jobs, and neither run could then be reproduced. Live, the MES's dispatches are recorded instead (next question) and replayed headless.

**15. What does a recorded dispatch carry, and why not the device's sequence number?**

Its simulation time (`acceptedAt`) and the number of events the simulation had processed when the call arrived (`afterEvents`). Probe Q2 tried the alternatives: the time alone, pre-scheduled, lands differently at 1× (the pacer's timer fires at the next event's time) and after a single step that left an event of that millisecond. The device's `AcceptedSeq` counts one machine's OPC UA facts and can't place a call among other machines' events or the model's silent ones, and a headless run has no OPC UA at all. Stepping the headless run to exactly `afterEvents` events and giving the job at `acceptedAt` reproduced all three cases byte for byte, also through the real `LoadOrder` method. The review added `inputOrder` (one acceptance order across injections and actions), `endAfterEvents` and `stopAt` (so the replay stops exactly where the live run stopped).

**16. Why is `GET /scenario/recorded` not reachable from the console?**

It carries the run's seed and configuration hash, so whoever reads it can compute the run's future. That makes it an oracle like `/ground-truth`, which the console must not expose: the console is the physical world, and a user of the world under test should not be able to read its script. It stays a tool behind the control token.

**17. How does the console reach the simulator without the browser ever holding the control token?**

nginx proxies `/sim/` for an exact-route allowlist only, each route with its methods; everything else is 404. Each request first goes through `auth_request` to the MES (`GET /api/v1/session/permission/sim:control`: 204, 401 or 403), and only then does nginx add `SIM_CONTROL_TOKEN` itself. Because `auth_request` is a GET, the MES's Origin guard never sees the console's writes, so nginx checks `Origin` on every non-GET and on the event-stream upgrade. The MES trusts `X-Original-Method` (to count a console write as session use, but not the 1 s status poll) and later `X-Real-IP` only from the `edge` network, which only nginx and the MES are on. The MES learns that network's CIDR at start from its own alias `mes-edge`; a fixed subnet would collide between parallel Compose projects. The review then found Docker's bridge gateway inside the trusted subnet, so the network sets `inhibit_ipv4`, and the event stream outlived a logout, so it now closes after 5 minutes and must reconnect through `auth_request`.

### OPC UA SignAndEncrypt and PKI pinning

**18. What does SignAndEncrypt protect, and what does it cost here?**

Every message between the gateway and a machine server is signed (tampering detected) and encrypted (not readable), with `Basic256Sha256` or `Aes128_Sha256_RsaOaep`; mode None is off in Compose. Probe Q1 measured about 0.11 ms of extra CPU per delivered notification (both ends) in a 1-CPU container, about 1.3 % of a core for the whole plant at 60×, and a few milliseconds of latency against a 100 ms publishing interval. Delivery stayed gap-free. The cost was small enough to go on.

**19. Why pin leaf certificates instead of trusting a CA?**

Trust in a CA means "anything this CA signed". The stack also has a dev CA for HTTPS, and a certificate it issued for nginx must never open an OPC UA session. Probe Q1 also showed node-opcua refusing a CA-issued certificate without a CRL (`BadCertificateRevocationUnknown`), so a CA would need a CRL per CA kept current. Pinning trusts exactly the seven certificates the `pki` step made (five servers, the gateway, the tools client): each server's `trusted/certs` holds exactly the gateway's and the tools client's, the gateway's the five servers'. No CA can sign its way in. The `applicationUri` in the certificate must match the client's, and a server requires `clientAuth` in a client certificate.

**20. Why does a one-shot `pki` service generate the keys instead of letting node-opcua do it at start?**

node-opcua creates a self-signed certificate on a server's or client's first start. That is too late for an exchange step that must copy each certificate into its peers' trust folders before they start, and it gives each certificate both EKUs. So Compose runs `pki` first; the simulator and gateway start only after it exits 0 and refuse to start without their material. It is the only service that mounts every PKI volume, and only while it runs, so each component can read only its own private key.

**21. What did the security review of the OPC UA work find that the tests had missed?**

Every variable a server added was writable by any session: node-opcua's `addVariable` defaults to CurrentRead | CurrentWrite, and the reviewer wrote `State`, `Sequence` and the counters as `opcua-reader`. Now every variable is `CurrentRead`, and a probe crawls each machine and tries to write every variable its own value (118 variables, every Write refused). The review also found trust material left from before pinning (old auto-accepted pins in a persisted volume), so the step now makes each `trusted/certs` exactly its pins and empties the CRL and issuer folders. Later, the security review of the login work found a race (P9-F2, #265): a `pki` rerun rewrote unchanged pins through temporary files in the watched folder, and node-opcua's file watcher, on unlinking the temp file, deleted the fingerprint the real pin shared, leaving it untrusted until a restart. Fixed by not rewriting unchanged pins and staging writes outside the watched folders; the smoke reruns the step against the running stack and checks every pin.

### MQTT dynamic security

**22. What is a client-id takeover, and why did binding have to cover every user?**

MQTT allows one session per client id; a second connection with the same id ends the first. With a plain ACL file any user who knew `mes-server` could connect under that id and take the MES's persistent session and its queued messages. Mosquitto's dynamic-security plugin binds a user to one client id, so `mes` may connect only as `mes-server`. The plan left `dev` and `healthcheck` unbound for convenience. The work then found that Mosquitto checks no user name when a connection takes over a session, and that dynamic security binds a user to an id, not an id to a user: an unbound user could still take a bound id's session. So the coordinator reversed the plan: every user is bound, `dev` only as `dev` (hence `mosquitto_sub -i dev`, one `dev` session at a time), and the smoke reads as a separate `smoke-reader`. Each bound connection needs its own user, so the gateway and the MES got second users for their command connections.

**23. How was "every ACL refusal kept" proven rather than asserted?**

By running the Phase 8 broker, its ACL file and entrypoint frozen in a test fixture, beside the new one and comparing each user's publishes, subscriptions, deliveries and unsubscribes on both. The first draft refused subscriptions outside a role's reads; the parity test caught that the old broker granted every subscription and filtered on delivery, so the new template keeps that behaviour. A refusal you only assert is a refusal you might have changed.

### HTTPS, the dev CA and `__Host-` cookies

**24. Why HTTPS only, with no redirect and no HSTS?**

A redirect from HTTP must name a port, and gate projects publish on ephemeral ports, so any fixed redirect target would be wrong. Without an HTTP listener nothing can be read or rewritten in plain text; plain HTTP to the port gets nginx's 400. HSTS on `localhost` would pin every local port of that name to HTTPS in the owner's browser, breaking unrelated development servers.

**25. What does the dev CA's name constraint buy, and what risk remains?**

The CA can only issue certificates for `localhost` and `127.0.0.1`; a certificate it signs for another name fails verification (tested in a real handshake). It is valid for one year, carries the `serverAuth` EKU, and the owner trusts it for SSL only. So a leaked CA key can't impersonate the bank. What remains: `localhost` covers every port and every `*.localhost` name, so while the owner trusts the CA, whoever can read the `pki-ca` volume could impersonate any local HTTPS service. Recorded as a residual risk (ADR-0039; `docs/security-review.md`), awaiting the owner's review, with the advice to remove the trust when the project isn't in use.

**26. What does the `__Host-` prefix guarantee for the session cookie?**

A browser accepts a cookie named `__Host-…` only if it is `Secure`, has `Path=/` and no `Domain` attribute. So it is sent only over HTTPS, only to the exact host that set it, and a subdomain or a plain-HTTP page can't overwrite it. With `HttpOnly` (no script can read it) and `SameSite=Strict` (no cross-site request carries it), `__Host-sft_session` is about as tight as a cookie gets. One limit is accepted: cookies don't isolate ports, so other HTTPS services on `localhost` would receive it.

**27. How do the test harnesses trust the stack's certificate without trusting everything?**

Node clients read the stack's CA from the web container, check that the server presents exactly the `pki` step's certificate over TLS 1.3, and then trust that CA in their own process and give children `NODE_EXTRA_CA_CERTS`. Chromium doesn't read that variable, and Playwright's `ignoreHTTPSErrors` would accept any certificate, so Chromium starts with `--ignore-certificate-errors-spki-list=<the SPKI hash of this stack's nginx key>`: it accepts that one key and no other. A test shows the same browser refusing a certificate of another key, including one from the stack's own CA.

### Login throttling

**28. Why move the lock from the account to the pair (account, address)?**

A per-account lock lets anyone who can reach the login page lock a known user out with five wrong passwords (ADR-0026 accepted that on loopback "until Phase 9"). Keyed by (account, address), five failures lock only the attacker's address for that account; the user's own address stays open. The address must come from somewhere the attacker can't forge: nginx overwrites `X-Real-IP` with the connection's address, and the MES believes it only from the `edge` network.

**29. Then what stops an attacker who has many addresses?**

A global delay per account that never becomes a lock. Let n be the account's judged failures in the last 15 minutes, from all addresses. From n = 10, an attempt made less than `min(2^(n − 10) s, 30 s)` after the last failure is refused with 429 and `Retry-After`, without hashing. A 429 is not a judged attempt and doesn't raise n. The decision is taken in the same transaction as ADR-0026's reserve-before-hash, under `SELECT … FOR UPDATE` on the user's row, so concurrent attempts are serialised and at most one per wait is judged: a delay applied before the decision would let a parallel burst through. The S5 test drives n to 15 from three addresses, lets the 30 s wait expire, then sends 20 concurrent attempts from a fresh fourth address: exactly one is judged, nineteen get 429 with `Retry-After: 30`. The first gate of P9-15 found that `Retry-After` said 31: the attempt read the clock before waiting for the row lock. The clock is now read after the lock.

**30. The review found the throttling itself could be used for a denial of service. How, and what was accepted?**

Three ways. A login flood filled the MES's two database connections, so authenticated reads slowed from 3 ms to over 50 ms: logins now use a pool of their own, and a known wait is answered from memory. Unkeyed rate buckets let one address keep everyone out: buckets are now per address and per (name, address), with a shared ceiling. And every admitted attempt costs a scrypt hash, so a queue of them pushed a victim's login past 37 s: an attempt now needs one of 10 hash slots (3 per address), else a quick 429. What remains, accepted and awaiting the owner's review: two attacker addresses at their 5/s caps fill the shared ceiling of 10/s, after which a login from a fresh address gets through only about 15–37 % of the time (each refusal a quick 429). An address that logged in as the user in the last 15 minutes skips the ceiling, so a browser in use keeps working; an admin's password reset clears every failure. And through Colima's port forwarding every host client is one address, so on a developer machine the browser and an attacker on the host share one key; the plan says "reduces", not "solves".

### Incremental SPC

**31. What does "incremental derivation from the earliest changed point" mean, and how is it shown correct?**

The whole-chart derivation recomputes moving ranges, subgroups, rule windows and episodes for every reading, every time one arrives: fine for a week, too slow for a month (a late reading took 23–45 ms against a 20 ms budget). `SpcDerivation` keeps the previous result and recomputes only from the earliest reading that changed (from the start of its subgroup, and from the first rule window and episode that reaches it); the unchanged prefix is reused. It is proven by a property test: random sequences with late inserts, duplicates, removals, value changes, retests and epoch changes, and after every operation `chart()` must equal `spcChart` (the definition) exactly. The reviewer added about 8,000 cases of their own fuzzer on top. They found no difference in the charts, but they did find that a retest was counted as `late` and recomputed its part from the start; that is fixed and tested. Budgets in #259's gate: on `week-01` a new reading p95 1.8 ms, a late one 4.2 ms; on a synthetic month 2.6 and 10.0 ms.

### Resilience

**32. What do runs R1, R2 and R3 each prove?**

- **R1, no loss, infrastructure:** the broker restarted at 07:00, the database at 08:30, the ERP mock stopped 09:45–10:45, the washer silent 11:45–12:00. Afterwards every answer (states, OEE at every level, alarms, shift reports, units, quantities, confirmations, the trace at 14:00) equals the live truth and is final, nothing is stored twice, no gap incident, each ERP message held once.
- **R2, no loss, MES:** the MES stopped with SIGTERM 07:00–08:00 and killed with SIGKILL 10:00–11:00, same assertions. The broker's persistent session and the gateway's outbox carry the data across.
- **R3, detected loss:** CNC-01's OPC UA server offline 07:00–08:30 and the gateway killed 10:45–10:50. Here loss is expected (ADR-0009: a new OPC UA session starts at the current `Sequence`), and the assertion is that it is **detected exactly**: per machine, the numbers in the MES's `sequence-gap` incidents equal (numbers the simulator raised) − (numbers the MES stored), every lost fact lies inside the outage window, the state resyncs within 10 s, and the MES's answers equal the golden harness's on the facts it did store.

**33. Why is the R3 window judged in simulated time, and what is ε?**

The outage start is the simulated time the test read from the control API when it acted, and the end is the resync, from the gateway's own record. Converting wall clocks to simulated time at 60× would multiply every scheduling jitter by 60. ε = 2 simulated minutes (2 s of wall time) covers facts in flight when the session dropped and the 250 ms polling of the control API; the test records the largest lead it saw (0 ms in every run so far), so ε can be tightened from evidence.

**34. Why was R3's schedule moved, and why is that a decision the owner should look at?**

On the plan's schedule R3 lost nothing: CNC-01 offline kept its OPC UA session, which republished on reconnect, and the gateway kill at 10:00–10:05 fell in shift A's break, when no machine raises a fact. The detected-loss assertions then held on empty sets, a pass that proves nothing. The coordinator moved the outage to 07:00–08:30 and the kill to 10:45–10:50, while the line runs, and made R3 fail unless at least one fact is lost (`exercised: true`). That changes a schedule the plan's review had approved, so it is recorded in ADR-0009's amendment and listed for the owner. The finding about where loss really happens (new sessions, not outages of a live session) is itself a result.

**35. What real defect did the resilience suite find?**

A database restart killed the MES. pg-pool listens for errors only on idle clients; a connection held between two queries, when the database ended it, emitted `error` with no listener, which ends a Node process. Every client now gets a listener on connect, the holder's next query fails cleanly and the broken client is dropped. It had passed twice before by timing; a regression test terminates a held backend.

**36. After the simulator was recreated, the gateway stopped polling the washer for good (P9-F4, #272). Why did `close()` never return, why was nothing logged, and how does the test prove it?**

When the old simulator process ended, it destroyed its Modbus sockets, so the gateway's next read failed. The poller's failure path then awaited the reader's `close()` before reconnecting. `modbus-serial` 8.0.25's `close(cb)` ends the socket and calls `cb` only from the socket's next `close` event, but a socket the peer has already closed has emitted that event already and never emits it again; even if one arrived, the callback is gated on the port's `openFlag`, which the peer's close had cleared. So the awaited promise never settled, `poll()` never returned, and the scheduler's `finally`, which arms the next poll, never ran: polling stopped until the gateway restarted.

Nothing was logged because everything that would have reported it came **after** that `await`: `onError`, the silence count that raises `device-silent`, and dropping the reader. The reader was still set, so `gateway_device_connected` stayed 1, and the MES saw no incident; WSH-01 simply stayed in the old epoch. The Modbus `silent` fault of the resilience suite never triggered it, because a silent server keeps its socket open and `close()` then completes normally.

The fix drops a failed connection at once without waiting for its close, closes with `destroy()` (which calls back immediately), and destroys the socket of a failed connect. The tests prove it at three levels, each failing on the old code: `connectModbus` against a TCP server that closed the connection must reject the read and settle `close()` within 1 s; the poller against a connection whose close never settles must settle every poll within 1 s, report itself disconnected and publish the new epoch's snapshot on reconnect; and a real simulator child process stopped and started on the same ports must have its new-epoch snapshot published within 2 s of being ready (`main`'s poller times out after 7 s). The console run now also waits for every machine, WSH-01 included, in the new epoch.

**37. What is the general lesson of P9-F4?**

Never await a library's close, or any cleanup, without a bound. Cleanup paths are the least tested code in a library and run exactly when the other side has already gone away. An unbounded `await` there turns a recoverable fault into a silent, permanent stop, and silence is the worst failure mode for a monitoring system: no error, no incident, a gauge still saying "connected". Destroy instead of closing gracefully when the peer is gone, or race the close against a timeout, and put the reporting (`onError`, counters) before any step that can hang.

**38. Why must the system be "settled" before each fault?**

Two overlapping recoveries can hide each other: a second fault during the first one's catch-up could be blamed for the first's loss, or its own loss masked by the first's backlog. So at each fault's time the test asserts readiness back, the gateway's buffer empty, ingest caught up and every machine final through the previous fault's end, and the run fails, naming the condition, if not. The schedules leave at least one simulated hour (one wall minute) between a fault's end and the next.

### Performance testing method

**39. Why judge a percentile on bucket edges rather than on the printed p95?**

A Prometheus histogram stores counts per bucket, not the observations. A p95 read from it is interpolated inside a bucket, so a printed "46 ms" may stand for anything between two edges. The suite instead judges what the histogram can say exactly: T1's "p95 ≤ 250 ms" is "at least 95 % of observations at or below the 0.25 s edge", which is why the plan chose targets that are bucket edges. The interpolated p50, p95 and p99 are printed beside it as information, labelled interpolated; Prometheus's own `histogram_quantile` agreed with the suite to 0.1 ms.

**40. Why is the drain rate in P2 the lower of the median slope and the mean?**

The first method divided the messages stored by the time until catch-up, measured across a slower polling loop, which biased the rate upward over a 4 s drain. Now a sampler reads only `/metrics` every 100 ms, the rate between each pair of samples is a slope, and over the steady part of the drain (first and last second dropped) the median of those slopes is robust to a pause or a burst, while the mean counts everything stored. Either alone could be carried by a few outliers in one direction, so the judge takes the lower. The MES was stopped for 15 minutes instead of 5 so the drain is long enough for about 90 slopes. Final run: min(987.7, 974.8) = 974.8 msg/s against ≥ 800 (#269; 938.2 at the final close on `1cecd17`).

**41. What is a vacuous judge, and which ones did Phase 9 find in its own suites?**

A check that cannot fail whatever the system does. Phase 9 found several in its own work, each by asking "what would make this fail?":

- `mes_ingest_pending_messages` ≤ 100 at each hour: the gauge is bounded by the MQTT receive maximum of 100, so it can never exceed it. Replaced by the age of the oldest pending delivery (≤ 1 s), which grows with any backlog.
- T5 "no OOM, no restart" passed on a container that had died: a dead container neither restarts nor runs out of memory. Now every container of the project must be present, running (or, for the one-shots, exited 0).
- T6's "three times the live rate" replayed at 180× offered about 1× the live rate, because the golden feed has no telemetry. Now the offered rate is measured and must be ≥ 3 × P1's measured live rate.
- R3 on the plan's schedule lost nothing, so "gaps equal raised − stored" held on empty sets. Now R3 must lose at least one fact.
- In the other direction, an over-strict judge: "gateway buffer 0 at every sample" failed on live traffic, since every message passes through the outbox. Judged instead as the broker session up, the depth within one live window and nothing dropped.
- Earlier, unit tests that passed with their behaviour removed were found by mutation in almost every PR's review.

The lesson is the same as Phase 8's counterfactual for SPC: a test is only evidence if it was shown to fail on the wrong answer.

**42. Why are these method changes listed for the owner's review rather than simply adopted?**

Because they change how a target is judged after the plan fixed it, and "a target is never relaxed silently" was a plan rule. Each change is argued in ADR-0040 ("Coordinator decisions") with the number that motivated it: some made a judge stricter (T5, T6, T2), one replaced a check that couldn't fail (pending), one replaced a check that failed on correct behaviour (the buffer). The coordinator took them so the work didn't stop; the owner can reverse any of them.

## 4. Hands-on exercise

See the derived bottleneck and an order's OEE by hand, without a stack.

1. Open `apps/simulator/golden/orders-01/line-oee.json`. `bottlenecks` names OP30 on `asm-01` for both products (effective cycles 150 s and 210 s). From `config/plant/products.yaml` and `config/plant/plant.yaml`, compute OP10's effective cycle per product (its ideal cycle ÷ the two CNCs) and check that it is smaller, although OP10's raw cycle is the largest.
2. In the same file, find `orders["PO-2610-001"]` and its single job. From its window (03:00:00Z to 04:13:44.974Z, `plannedBusyMs` 4,424,974) and its 12 good OP10 cycles at 240,000 ms ideal, compute OEE = 12 × 240,000 ÷ 4,424,974 and compare with the stored fraction (1440000/2212487 ≈ 0.6509); the 1,500,000 ms of `setup` in its losses is the changeover the head time charges to it. Then compute the order's line OEE, 12 × 150,000 ÷ its in-progress time (`line.plannedBusyMs`, 5,531,237 ms to its completion at 04:32:11.237Z), and compare with `line.oee` (≈ 0.3254).
3. In `apps/simulator/golden/week-01/line-oee.json`, find an hour under `line.hours` with `aboveOne: true` and, from its `good`, `idealMs` and `plannedBusyMs`, say how many units the bottleneck's ideal rate allowed in it.
4. Run `pnpm sim:headless --timeline monday-breakdown-and-recovery --out runs/mbr` (it writes to `apps/simulator/runs/mbr`). In `events.jsonl` find the `lot`, `absence` and `tool-breakage` events and the run header's `actions`. Then find ASM-01's `Idle` with cause `NO-OPERATOR` at the start of shift B. Remove `apps/simulator/runs/mbr`.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
