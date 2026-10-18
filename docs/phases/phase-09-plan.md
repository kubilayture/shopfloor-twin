# Phase 09 – Simulation console, scenarios and hardening: plan

Planned 2026-10-18. Plan reference:

- section 1: goal 5 ("a simulation console to change speed, inject faults, starve material, release orders and act as the operator") and success criterion 5 ("data survives a broker outage without loss");
- section 4: interactivity (time, faults, infrastructure, "mark an operator absent, block a component lot", "scenarios: YAML timelines of these actions … that play back identically every run");
- section 5: delivery guarantees, the `web` component ("simulation console"), data path 6 ("the simulation console talks only to the simulator's control API");
- section 6: metrics and tracing ("optional Grafana profile in Phase 9");
- section 7: `oee` "per order" (from Phase 9, rev. 8), OEE definitions and the state-to-loss table;
- section 8: `config/scenarios/`, `compose.observability.yml`, module and dependency rules;
- section 9: resilience ("broker restart, OPC UA server offline, Modbus device silent, MES restart mid-shift: no data loss, no duplicates, correct recovery") and performance ("ingest throughput at 60× simulation speed with all machines; UI update latency"; tool "decided in Phase 9");
- section 11 row 9;
- section 12: risks and the open decision "load-testing tool and performance targets (Phase 9)".

ADRs this phase builds on: 0009 (lossless OPC UA delivery; loss detected, not prevented, while a session is down), 0012 (`prom-client`; OpenTelemetry reconsidered in Phase 9), 0014 (store-and-forward), 0017 and 0018 (ingest, gaps, finality), 0019 (push backpressure), 0021 (OEE definitions; work-center option (c), line throughput, "waits for orders"), 0026 and 0027 (identity, roles, database roles; accepted risks "until Phase 9"), 0028 (ERP token "Phase 9 hardens transport"), 0029 and 0030 (command path; live reproducibility of dispatches "a Phase 9 scenario feature"), 0032 (SPC read path; incremental derivation "a Phase 9 item"), 0033 (`leak-drift` and the injection model), 0035 (hold scope "derived again every second … a Phase 9 item").

Size: M in the master plan; **L** here: three new capability areas (order and line OEE end to end, the console with scenario playback, security), and two proof suites (resilience, performance). Delivered in three waves with a checkpoint after wave A; master plan rev. 9 sets row 9 to L. Milestone: Phase 09 (created with the issues after this plan is approved).

## Goal

The owner can steer the plant the way a test engineer steers a real one, from a browser, and replay what he did; the MES reports OEE per order and per line as well as per machine; and the system is shown to survive infrastructure faults, to keep up at 60× with headroom, and to pass a written security review.

## Scope

- **Order and line OEE** (deferred from Phases 7 and 8): `oee-core` gains an order OEE (the order's OP10 job windows on its CNCs) and a throughput-based line OEE (good packed output against the bottleneck's ideal rate, ADR-0021 option (c)), with hand-calculated reference cases; the simulator writes their truth in a sidecar `line-oee.json` beside each golden summary; the MES computes, serves and pushes them; the order screens and the OEE dashboard show them.
- **Console actions in the simulator:** block and release a component lot, mark an operator absent for a shift, force a tool breakage; each a new event variant written only when used, so no existing event log changes.
- **Scenario playback:** YAML timelines in `config/scenarios/` of every console action (failures, drifts, infrastructure faults, lot blocks, absences, tool breakages, speed, pause), loaded headless or live, with the same event log both ways; dispatches recorded in a live orders run can be replayed headless (ADR-0030's open point).
- **Simulation console** in the web app (`/console`): time, speed, faults, drifts, lots, operators, infrastructure, scenario load and progress, reached through nginx with a `sim:control` permission.
- **Derived-work costs:** incremental SPC derivation from the earliest changed point (ADR-0032), and hold scopes rebuilt on change, not every second (ADR-0035).
- **Security:** OPC UA SignAndEncrypt with certificates and an authenticated gateway user; MQTT client ids bound to users (dynamic security); a token on the simulator's control API; TLS at the nginx front with `Secure` cookies by default; login throttling per client address; a written security review with a checklist whose every item has evidence or an accepted risk.
- **Resilience suite** (`pnpm test:resilience`): broker, gateway, MES, database and ERP restarts or outages, OPC UA servers offline, the washer silent, during a live shift at 60×.
- **Performance:** a Node load tool (`pnpm test:perf`), targets set in this plan and met at 60×, plus a 3× headroom replay; an optional Prometheus and Grafana Compose profile.
- **Test hygiene:** a host-wide lock so only one heavy suite runs at a time, ephemeral host ports for the gate's stacks, and disk cleanup per run.

Out of scope here:

- a release step, a demo recording, the documentation pass and the `v1.0.0` tag (Phase 10);
- OpenTelemetry tracing and moving metrics off `prom-client` (decided here: not in v1; ADR-0012 amended in P9-13);
- retention and compression policies on the hypertables; the O(hours × occurrences) alarm KPI read (carried, ADR-0024); an inbound ERP lot block; automatic holds from SPC signals (carried from Phase 8);
- manual physical scrap of a part from the console (needs a new path for a unit the machines didn't scrap, and every quantity rule of ADR-0031 to follow it; after v1.0);
- serials unique across simulator runs (ADR-0034's recorded limit stays);
- an OPC UA history service to replay facts raised while a session was down (ADR-0009's known limit stays; the resilience suite proves it is **detected** exactly);
- Sparkplug B (decided in the Phase 10 report), SSO, cloud deployment (master plan non-goals).

## Decisions made in this plan

### What the code does today

- **OEE:** per equipment and work center (time-weighted sums, ADR-0021 (b)), per hour and shift, `scheduledTime: orders` in orders mode (Idle `NO-ORDER` excluded on the CNCs). No order or line OEE anywhere; the ground truth (`sim-summary/4`) has per-order quantities and completion times but no OEE per order.
- **Control API 1.6:** time (pause, resume, step, speed 0.5–60), infrastructure faults (OPC UA server offline per machine, Modbus silent), failure injection (1.3), `leak-drift` (1.5), ground truth with `?asOf` (1.6). No authentication; published on `127.0.0.1` only. `ProductionLine.blockLot` exists in the model (a blocked lot is skipped as if empty) but no route reaches it. Operator absence is a random draw per operator and shift; no forced absence. No tool breakage injection.
- **Scenarios:** golden `scenario.json` files carry `injections` (failures and drifts) and `dispatches`; no `config/scenarios/` folder, no YAML timelines, no live playback; a live run that received dispatches mid-run can't be replayed headless (ADR-0030).
- **Web:** no console route; nginx proxies `/api/` to the MES only.
- **Security:** OPC UA security mode None, anonymous, `LoadOrder` callable by any client; the simulator already keeps a PKI volume (`simulator-pki`), node-opcua's default certificates. Mosquitto with a plain ACL file (client-id takeover an accepted risk since Phase 3). Plain HTTP at nginx; `MES_COOKIE_SECURE` off; per-account lockout (a denial of service accepted on loopback "until Phase 9", ADR-0026). The ERP mock's bearer token is one shared secret.
- **Derived work:** SPC re-derives the whole chart per new reading (p95 13–14 ms idle on `week-01`; a late reading 23–45 ms, over the 20 ms budget; a month of readings would need incremental derivation or a window, ADR-0032); hold scopes rebuilt every second while open or rejected (ADR-0035).
- **Resilience:** proven per component in Phases 3–7 (gateway broker outage with no loss and no duplicates, OPC UA reconnect with gap detection, MES persistent session, outboxes). No whole-system suite.
- **Performance:** measured piecemeal: ingest about 1,000 stored messages/s (runbook), push latency budgets of Phases 4–8 (overview, OEE 2 s, SPC 2 s, terminal), trace performance (p95 2.9 ms backward, 29 ms forward through nginx). No load tool, no stated targets.
- **Gate:** `pnpm gate` (verify, golden, e2e, smoke, reconcile with three passes; about 45 minutes at #204: verify 282 s, e2e 718 s, smoke 86 s, reconcile 1,646 s). The smoke uses the default host ports, so a dev stack must be stopped. Nothing stops two agents' heavy suites from running at once on the one machine; the Phase 8 log records flakes and timeouts from exactly that (#212, #216, #218).
- **CI:** GitHub Actions still stopped by the spending limit; every criterion below is proven by local runs.

### Phase size and waves

- **Wave A, truth, world and hygiene** (P9-01, P9-02, P9-03, P9-06, P9-07): the gate lock and ports first (it protects every later heavy run), the OEE definitions and their truth, the simulator's console actions and scenario playback. No MES change. **Checkpoint** (entry in `docs/phases/phase-09-log.md`): `line-oee.json` committed for the four goldens; `week-01`, `alarms-01`, `orders-01` and `quality-01` keep `events.sha256`, `summary.json` and `trace.json` byte-identical; a timeline with every action kind gives the same event log headless and live.
- **Wave B, MES and screens** (P9-04, P9-05, P9-08, P9-09): order and line OEE in the MES and on screen, the console, the derived-work costs.
- **Wave C, hardening and proof** (P9-10 to P9-13): security, then the resilience and performance runs on the hardened stack (a measurement before SignAndEncrypt and TLS would not hold after them), then the close (P9-14).
- **At most two pull requests open at a time** (master plan section 12), and **at most one heavy suite running at a time on the machine** (below, "Local gate").
- **Cut line**, in this order, each recorded as a deviation if used: the Grafana dashboards (the Prometheus profile stays), MQTT TLS (dynamic security stays), the console's scenario editor (loading a committed timeline stays), the order OEE column on the orders list (the order detail stays).
- **The phase log is kept from the first merge** (Phase 7 lesson): the plan's merge starts `docs/phases/phase-09-log.md`, and every pull request appends its entry.

### Order and line OEE (`oee-core`, ADR-0036)

- **Order OEE:** an order's OEE is its CNC work: for every accepted job of the order (a command id), the window on its CNC from the job's `started` fact to its `completed` fact (ADR-0030; a job still running is open, provisional). Inside the windows, the CNC's states give planned busy time and actual production time by the equipment rules (ADR-0021, `scheduledTime: orders`, micro-stop threshold); produced and good are the order's OP10 cycles (by unit, ADR-0031); ideal time is the product's OP10 ideal cycle. A, P, Q and OEE as exact fractions, summed over the order's jobs (time-weighted, as work centers in ADR-0021 (b)). Beside it, not multiplied in: the order's **first-pass yield across the routing** (units packed good on their first pass / units started), because OP10 quality alone hides OP40's leak scrap.
- **Why OP10 job windows:** a job window is the only time the plant attributes to one order without a rule of thumb: the CNC runs one job at a time, and downstream machines interleave both CNCs' orders. Splitting ASM-01's time between two orders by its units would need an allocation key the ground truth would have to invent.
- **Line OEE (throughput):** for Line A1 fed by Cell M1, per hour, shift bucket and order: **good packed units × the bottleneck's ideal cycle per product ÷ line planned busy time**. The bottleneck is ASM-01 (the configuration's `bottleneck`, already marked on the dashboard). **Line planned busy time:** shift calendar time minus planned stops (breaks, planned maintenance on the bottleneck); in orders mode, only the time at least one order is **in progress** (from its first job's `started` to its completion time, ADR-0031), the line's counterpart of `NO-ORDER`. Per order, the same ratio over the order's in-progress time with its own good units; orders overlap, so per-order line OEE is **not additive** (stated on screen and in the ADR). No A × P × Q split: a throughput OEE has one ratio; the dashboard keeps the per-machine waterfall beside it.
- **Exactness and finality:** fractions as in `oee-core` today; a bucket is final when every machine it reads is final through its end (ADR-0018); an order's OEE is final when its jobs' windows and its units are final (its completion final, ADR-0031).
- **Reference cases:** `docs/oee-reference-cases.md` gains cases for both (at least: one job; two jobs on two CNCs; a job across a shift boundary and a break; a job with a micro-stop and a breakdown; a short order; a line bucket with no order in progress; two overlapping orders; a rework that packs in a later bucket), hand-calculated to four decimals, driving the unit tests. Coverage floors as the other pure packages (95 / 90).

### Order and line OEE truth (simulator)

- **A sidecar, not a summary version:** `line-oee.json` (`sim-line-oee/1`) next to `summary.json` for all four goldens (line OEE for each; order OEE for `orders-01` and `quality-01`, empty `orders` in schedule mode), computed with `oee-core` from the same configuration as the MES; `GET /ground-truth` gains `lineOee` (control API 1.7), cut by `?asOf` like `trace`. **`summary.json`, `events.sha256` and `trace.json` of every golden stay byte-identical**; adding a file to a golden folder is not a regeneration (#208's precedent), recorded in `apps/simulator/golden/README.md`. Once committed, a change to a `line-oee.json` is a golden regeneration (written reason, owner approval).

### MES `oee` module (order and line)

- Order OEE per order (and per job), line OEE per hour, shift bucket and order, from the equipment pieces, execution's units and the orders module's job facts, through their modules' `index.ts`; derived and rebuilt like the existing buckets (a late fact rebuilds the affected windows, never patches). API: `GET /oee/orders/{id}`, `GET /oee/line?from&to&bucket=hour|shift`; push on the existing `oee` topic (`order` and `line` deltas, paced like the buckets). No new table if the reads are within budget (computed from the hourly aggregates and the pieces, as the work-center OEE is); a cache table only if the API misses 100 ms p95, recorded in the issue.
- **Web:** the order detail shows the order's OEE (A, P, Q, OEE, provisional marked) and its first-pass yield; the OEE dashboard gains a line card per shift with the bottleneck named and "not additive across orders" for per-order line OEE.

### Console actions (simulator, ADR-0037)

- **Lot block and release:** `POST /api/v1/lots/{lot}/block` and `/release` reach `ProductionLine.blockLot`; a blocked lot is skipped (the consuming station starves with cause `MATERIAL:<material>` once no other lot remains), written as a `lot` event variant (`blocked | released`). This is the physical counterpart of an MES hold, never triggered by the MES (ADR-0035 stays: the MES doesn't command the simulator for quality).
- **Operator absence:** `POST /api/v1/operators/{id}/absent` with a shift (the next shift start at the earliest, so no running shift's staffing changes mid-cycle), forcing the roster draw's outcome without consuming a different number of draws (the operator's absence stream still draws, so other shifts are unchanged); written as an `absence` event variant.
- **Tool breakage:** `POST /api/v1/faults/tool/{machine}` (CNCs only) at a time: the tool's wear jumps to its life, the next OP10 cycle's defect probability follows the existing wear curve and the tool change follows the existing rule; written as a `tool-breakage` variant. The draws stay the same count (the defect draw still happens; only its probability changes), so the run before `at` is identical.
- **Rule for every action:** a new variant of the event union, written only by runs that use it; the run header lists the action only then; same calendar-boundary refusal as failure injections. So `week-01`, `alarms-01`, `orders-01` and `quality-01` keep every byte (asserted).

### Scenario playback (simulator, ADR-0037)

- **Timelines:** `config/scenarios/<name>.yaml`, one Zod schema in `plant-config` shared with the golden `scenario.json` (whose `injections` and `dispatches` become the same entries): entries `{ at, action, … }` for `failure`, `leak-drift`, `opcua-offline`, `modbus-silent`, `lot-block`, `lot-release`, `operator-absent`, `tool-breakage`, `dispatch`, `speed`, `pause`. Headless (`pnpm sim:headless --timeline config/scenarios/x.yaml`) and live (`SIM_TIMELINE` at start, or `POST /api/v1/scenario` while idle) read the same file. Infrastructure entries (`opcua-offline`, `modbus-silent`, `speed`, `pause`) don't touch the plant model, so headless ignores them and the event log is the same.
- **Live recording:** a live run can write its event log (`SIM_EVENT_LOG`), so live and headless are compared byte for byte. **Dispatch replay:** in live orders mode the simulator records each accepted job with the simulation time of its acceptance (`GET /api/v1/scenario/recorded`), a timeline of `dispatch` entries that reproduces the run headless (ADR-0030's limit closed). Probe Q2 confirms that acceptance at the recorded time gives the same event order.
- **Example timelines** committed: `monday-breakdown-and-recovery.yaml` (failure, repair, a lot block and release, a tool breakage) and `resilience-01.yaml` (the infrastructure faults the resilience suite plays).

### Simulation console (web, ADR-0037)

- **Route `/console`:** run status (sim time, speed, paused, epoch), pause, resume, single step, speed slider (0.5–60); failure injection per machine and code; `leak-drift`; OPC UA offline per machine and Modbus silent; lot list (the ERP lot master as the simulator stocks it) with block and release; operators with "absent next shift"; tool breakage; scenario load from the committed timelines with a progress list; the recorded dispatches as a downloadable timeline. Live through the control API's WebSocket (plant events) and a 1 s status poll.
- **Access:** nginx proxies `/sim/` to the simulator's control API only after `auth_request` to the MES (`GET /api/v1/session/permission/sim:control`, 204 or 401/403), and adds the control API's token (P9-11) itself, so the browser never holds it. New permission `sim:control`, **held by `admin` only**: the console is the physical world, not a plant role, and an MES user acting on the world under test would blur the two (ADR-0026's separation of duties). The MES never calls the control API (master plan section 5 stays true).

### Derived-work costs (MES)

- **Incremental SPC:** `spc-core` gains a derivation that resumes from the earliest changed point (moving ranges, subgroups, rule windows and episodes from there on), with a property test that it equals the whole derivation on random sequences with late inserts, duplicates and epoch changes; the `quality` module uses it. Targets: a new reading p95 ≤ 10 ms and a late reading p95 ≤ 20 ms on `week-01`; on a synthetic month (about 9,000 first-pass readings) the same budgets and the default chart read (last 500 readings) p50 ≤ 10 ms.
- **Hold scopes on change:** `hold_unit` rebuilt on genealogy's `onChange` and on hold transitions, not on a 1 s timer; with 200 open holds a genealogy round adds ≤ 50 ms p95 (measured).

### OPC UA security (ADR-0038)

- **Endpoints:** every machine server offers **SignAndEncrypt only** with `Basic256Sha256` and `Aes128_Sha256_RsaOaep` (mode None off in Compose; `OPCUA_SECURITY=none` kept for unit tests that don't test security). Server certificates per machine in the `simulator-pki` volume; the gateway's client certificate in its own volume; trust is explicit: each side trusts the other's certificate through a dev CA made once per stack (a `pki` step in Compose, before both); **no automatic acceptance** of an unknown certificate.
- **User:** the gateway authenticates with a user name and password (`OPCUA_GATEWAY_PASSWORD`, random per stack like the other secrets); anonymous sessions are refused; `LoadOrder` is executable only by that user (address space 1.3).
- **Probe Q1** (first commit of P9-10): ADR-0009's lossless delivery at 60× with SignAndEncrypt (five servers, two clients each, a scripted shift, gap-free `Sequence`), and the CPU cost per message against mode None. If delivery fails, the issue stops and reports before anything else changes.

### Access hardening (ADR-0039)

- **MQTT:** Mosquitto's dynamic-security plugin replaces the plain ACL file; each client id bound to its user (`gw-01`, `gw-01-cmd`, `mes-server`, `dev`), so a takeover with another user's id is refused; every ACL refusal of ADRs 0015 and 0029 kept and tested (PUBACK 0x87). TLS on the broker listener with the dev CA (on the cut line).
- **Simulator control API:** a bearer token (`SIM_CONTROL_TOKEN`) on every route but `/health/*` and `/metrics`; 401 without it; nginx adds it for `/sim/`; the reconcile, resilience and perf harnesses send it.
- **Web front:** nginx serves HTTPS with a certificate from the dev CA (HTTP redirects); `MES_COOKIE_SECURE=on` by default in Compose, so the cookie is `__Host-sft_session; Secure` (ADR-0026's plan for TLS); the Playwright and smoke clients trust the dev CA.
- **Login throttling:** the per-account lock is kept but keyed (account, client address), with the address taken only from nginx's `X-Real-IP` (the MES trusts that header from the web container's network only); a global per-account delay stays, so a distributed guess is still slowed. Closes ADR-0026's accepted denial of service.
- **ERP token:** compared in constant time (checked), rotated by restarting with a new value (runbook); one shared secret stays an accepted risk on a loopback network.
- **Security review:** `docs/security-review.md`: a threat model per component (STRIDE, one table), the checklist below with evidence per item, `pnpm audit --prod` with every high or critical finding fixed or answered, container users and published ports listed.

### Security review checklist

Every item ends with evidence (a test, a command's output or a file) or an accepted risk with its reason, in `docs/security-review.md` (written in P9-11, completed at the close):

| #   | Item                                                                                                                            | Proved in    |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| S1  | OPC UA: SignAndEncrypt only; an untrusted client certificate refused; anonymous refused; `LoadOrder` refused for any other user | P9-10        |
| S2  | MQTT: client-id takeover refused; every ACL refusal kept (0x87); passwords random per stack                                     | P9-11        |
| S3  | Simulator control API: 401 without the token; `/sim/` 401 anonymous and 403 without `sim:control`                               | P9-08, P9-11 |
| S4  | Web: HTTPS with redirect; `__Host-` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`; the security headers served            | P9-11        |
| S5  | Login: a lock from one address doesn't lock the account from another; the global delay applies                                  | P9-11        |
| S6  | Database roles: grants equal `DECLARED_GRANTS`; append-only tables refuse `UPDATE`, `DELETE`, `TRUNCATE` (existing tests rerun) | P9-11        |
| S7  | Secrets: none in the repository, images or logs (a grep test over images and the gate's logs); `.env.example` without values    | P9-11        |
| S8  | Containers: non-root users, published ports only on `127.0.0.1`, resource limits, no Docker socket mounted                      | P9-11        |
| S9  | Dependencies: `pnpm audit --prod` without unanswered high or critical; node-opcua at or above the CVE-fixed version (section 6) | P9-11        |
| S10 | Route matrix: every route answered for anonymous and the five roles (count equals the OpenAPI document), `sim:control` included | P9-08        |

### Resilience suite (`pnpm test:resilience`)

- **Stack:** a disposable Compose project with no fixed host ports (P9-01), hardened (P9-10, P9-11), running `orders-01`'s Monday shift A at 60× in orders mode with the `resilience-01` timeline (P9-07) for the infrastructure faults; process faults are driven by the test through `docker compose` at simulated times read from the control API.
- **No-loss class** (the design promises no loss): broker restart (`docker compose restart broker`); MES stopped with SIGTERM and later with SIGKILL, each for 2 minutes of wall time (2 simulated hours); database restart; ERP mock down for 5 minutes; WSH-01 silent for less than its ring's capacity. After the drain: states, OEE (equipment, work center, order, line), alarms, shift reports, units, quantities, confirmations and the trace at the end of shift A equal the live truth and are final; no duplicate fact stored (dedup counters), no `sequence-gap` incident, the ERP holds each message once.
- **Detected-loss class** (ADR-0009: OPC UA has no history): CNC-01's OPC UA server offline for 60 s and the gateway killed and restarted. The `sequence-gap` incidents name **exactly** the device sequence numbers the simulator raised while the session was down (read from the simulator), the state resyncs from the anchors within 10 s of the session's return, nothing is duplicated, every machine is final once the gaps are written off, and the MES's answers equal the golden harness's answers on the facts the MES stored (recovery is deterministic, not corrupt).
- **Recovery checks:** readiness returns within 30 s of each restart; the web reconnects its WebSocket and the overview is current within 2 s (Playwright); metrics show the outage (`mes_ingest_suspensions_total`, gateway buffer depth).

### Performance (`pnpm test:perf`, ADR-0040)

- **Tool, decided here:** a Node script (`e2e/src/perf.ts`), Node's built-in `fetch` and `WebSocket` and the repo's MQTT.js, no new dependency, as `pnpm test:trace-perf`. k6 was considered: a new binary or image, MQTT only through an extension, and the plant itself is the main load, which the script reads through the MES's metrics anyway.
- **Targets** (exit criterion 6), on the hardened stack, `orders-01` shift A at 60× in orders mode:
  - **T1 ingest lag:** gateway `receivedAt` → MES commit, p95 ≤ 250 ms, p99 ≤ 1 s, max ≤ 5 s over the whole shift; the MES's broker session queue ≤ 100 messages at every simulated hour boundary.
  - **T2 backlog drain:** after the MES is stopped for 5 minutes of wall time, the queued messages are stored at ≥ 800 messages/s and every machine is final again within 3 minutes of the restart.
  - **T3 push latency:** overview state ≤ 1 s p95; OEE dashboard, SPC page and terminal ≤ 2 s p95 (the existing budgets), with the latency judge of Phases 4–8.
  - **T4 reads under load:** 20 concurrent virtual users (10 desks polling overview, OEE and orders at their screens' rates, 5 terminals over WebSocket, 5 trace searches with backward traces): reads p95 ≤ 200 ms, backward traces p95 ≤ 100 ms, no 5xx, no WebSocket closed but by a session end.
  - **T5 resources:** MES CPU ≤ 1 core averaged over the shift and RSS ≤ 400 MiB peak; no container above its Compose limit; the gateway's buffer empty at the end.
  - **T6 headroom:** `week-01`'s Monday UNS messages (the golden feed of #204) replayed into a stack without simulator at three times the 60× rate: T1's lag p95 ≤ 1 s, every machine final within 30 s of the last message, Monday's OEE equal to the truth.
- **Probe Q3** (first commit of P9-13): the same measurements on today's `main` as a baseline; a target missed by the baseline is fixed in the issue or raised to the owner with the numbers, never quietly relaxed.
- **Observability profile:** `compose.observability.yml` (profile `observability`, off by default): Prometheus scraping every `/metrics`, Grafana with provisioned dashboards (ingest rate and lag, gateway buffer, push queue, SPC tick, HTTP latency), both on `127.0.0.1`; the perf run can use it but doesn't need it. ADR-0012 amended: `prom-client` stays, OpenTelemetry tracing not in v1.

### Identity and permissions

- New permission `sim:control` (admin). No other role change. The route matrix grows with the new routes (order and line OEE reads, the permission check route), each answered for anonymous and the five roles; the count compared with the OpenAPI document.

### Local gate

- `pnpm gate` stays the merge gate and runs locally (GitHub Actions unavailable): verify, golden, e2e, smoke, reconcile. `pnpm test:resilience`, `pnpm test:perf` and `pnpm test:trace-perf` are commands of their own, run by the pull requests whose paths the rerun table names, and all three by the closing gate (P9-14).
- **One heavy suite at a time** (disk space and the Phase 8 flakes): P9-01 makes every heavy command (`gate`, `test:e2e`, `test:reconcile`, `test:resilience`, `test:perf`, `test:trace-perf`, Playwright) take a host-wide lock (a lock directory in the OS temp folder with the holder's PID and command, stale when that PID is gone); a second one waits and says who holds it. Until P9-01 merges, the coordinator runs heavy suites one at a time by hand. `pnpm verify --concurrency=1` as today.
- **Ephemeral ports:** tests bind runtime ports (`@shopfloor/test-kit/ports`, #212, #216); P9-01 moves the smoke's Compose project to ephemeral host ports (published as `127.0.0.1::<port>`, read back with `docker compose port`), so a dev stack can stay up during the gate; the resilience and perf projects (P9-12, P9-13) do the same. No test may assume a fixed host port.
- **Disk:** every gate project removes its volumes and its `GATE_TAG` images at the end (also on failure), and the gate refuses to start below 15 GiB free in Docker's data root, saying so.
- **Process hygiene:** a harness stops what it started by PID or process group, never by name (no unscoped `pkill`).
- **Rerun table** (runbook "Merge gate") gains: `packages/oee-core` → `verify,golden,e2e,smoke,reconcile` (shapes `line-oee.json`); `config/scenarios/` → `verify,golden,e2e`; `config/mosquitto/`, nginx and the PKI step → `verify,e2e,smoke,reconcile` and `pnpm test:resilience`; `e2e/src/resilience*` → `verify` and `pnpm test:resilience`; `e2e/src/perf*`, `compose.observability.yml` → `verify` and `pnpm test:perf`.

## Probes before code

- **Q1, OPC UA SignAndEncrypt at 60×** (P9-10, first commit): lossless delivery as ADR-0009's spike, and the CPU cost per message; result in ADR-0038.
- **Q2, dispatch replay** (P9-07, first commit): a live orders run with dispatches given mid-run, its recorded acceptances replayed headless; the two event logs equal byte for byte, or the recorded shape changes (acceptance time plus device sequence) before the issue goes on.
- **Q3, performance baseline** (P9-13, first commit): T1–T6 on `main` before any tuning.

## Issues, in dependency order

GitHub issue numbers are assigned when the issues are opened after this plan is approved; the table then gains the links. "Gate" names the gate steps each pull request records on its final commit (`GATE_STEPS`, runbook rerun table); "full" is `pnpm gate` with all five steps.

| #     | Task                                                                                                                                                                                                                                                                                                        | Depends on                 | Gate                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| –     | Phase 9 plan (this document); master plan rev. 9                                                                                                                                                                                                                                                            | –                          | `verify` (formatting)                                    |
| P9-01 | Gate and test hygiene: host-wide heavy-suite lock for every heavy command, the smoke on ephemeral host ports, volumes and images removed per project (also on failure), the free-disk check, the Phase 9 rows of the rerun table; runbook                                                                   | plan                       | `verify,smoke`, then one full gate with a dev stack up   |
| P9-02 | `oee-core`: order OEE over job windows, line throughput OEE (bucket and order), first-pass yield across the routing, finality inputs; reference cases in `docs/oee-reference-cases.md`; ADR-0036                                                                                                            | plan                       | full                                                     |
| P9-03 | Simulator: `line-oee.json` (`sim-line-oee/1`) for the four goldens, `GET /ground-truth` `lineOee` with `?asOf` (control API 1.7); every `summary.json`, `events.sha256` and `trace.json` byte-identical; golden README                                                                                      | P9-02                      | full                                                     |
| P9-04 | MES `oee`: order OEE per order and job, line OEE per hour, shift and order, API and push, route matrix; golden reconciliation of `orders-01`, `quality-01` (orders) and all four (line) in order, in bounded disorder and shuffled with 10 % duplicates, judged on partial data                             | P9-02, P9-03               | `verify,e2e,smoke,reconcile`                             |
| P9-05 | Web: order OEE and first-pass yield on the order detail (and the orders list, on the cut line), line OEE on the dashboard, live; the `orders` reconcile pass compares every order completed in shift A and shift A's line OEE with the live truth                                                           | P9-04                      | `verify,smoke,reconcile`                                 |
| P9-06 | Simulator: lot block and release, forced operator absence, tool breakage, each a new event variant written only when used (control API 1.8); the four goldens byte-identical and the run before `at` identical; `docs/simulation-model.md`; ADR-0037                                                        | plan                       | full                                                     |
| P9-07 | Simulator: scenario timelines (`config/scenarios/*.yaml`, schema in `plant-config` shared with `scenario.json`), headless and live playback (`SIM_TIMELINE`, `POST /scenario`, control API 1.9), live event log (`SIM_EVENT_LOG`), recorded dispatches; probe Q2; two example timelines; ADR-0037 amendment | P9-06                      | full                                                     |
| P9-08 | Web: `/console` with every action of P9-06 and P9-07, the nginx `/sim/` proxy with `auth_request`, permission `sim:control` (admin), route matrix; Playwright: each action's effect seen in the simulator's status or the MES (a lot block starving OP10, a failure as an alarm), refusals for other roles  | P9-06, P9-07               | `verify,smoke,reconcile` and the console Playwright run  |
| P9-09 | MES derived work: incremental SPC derivation in `spc-core` (property test against the whole derivation) used by `quality`; hold scopes rebuilt on change; budgets measured on `week-01` and a synthetic month and with 200 open holds; ADR-0032 and ADR-0035 amendments                                     | plan                       | full (`spc-core` shapes `trace.json`)                    |
| P9-10 | OPC UA SignAndEncrypt: probe Q1, dev CA and PKI step in Compose, server and gateway certificates with explicit trust, gateway user, anonymous refused, `LoadOrder` restricted (address space 1.3); integration tests for an untrusted certificate and a wrong user; ADR-0038                                | P9-07                      | full                                                     |
| P9-11 | Access hardening: Mosquitto dynamic security (client-id binding, ACL parity, TLS on the cut line), control API token, HTTPS at nginx with `Secure` cookies by default, login throttling per (account, address), ERP token check; `docs/security-review.md` with the checklist S1–S10; ADR-0039              | P9-08, P9-10               | full and `pnpm test:trace-perf` (TLS on its path)        |
| P9-12 | Resilience suite `pnpm test:resilience` (`e2e/src/resilience.ts`): the no-loss and detected-loss classes on the hardened stack with `resilience-01`, recovery checks with Playwright; runbook                                                                                                               | P9-01, P9-07, P9-10, P9-11 | `verify` and `pnpm test:resilience` twice in a row; full |
| P9-13 | Performance: probe Q3, `pnpm test:perf` (`e2e/src/perf.ts`) with T1–T6 recorded in a results file, fixes for any missed target, `compose.observability.yml` with Prometheus and Grafana (dashboards on the cut line); ADR-0040; ADR-0012 amendment; runbook                                                 | P9-01, P9-09, P9-10, P9-11 | `verify`, `pnpm test:perf`, `pnpm test:trace-perf`; full |
| P9-14 | Close Phase 9: report, learning notes, data model, security review completed, tag `phase-09`                                                                                                                                                                                                                | all                        | closing gate (below)                                     |

Wave A is P9-01, P9-02, P9-03, P9-06 and P9-07 (checkpoint after it); wave B P9-04, P9-05, P9-08 and P9-09; wave C P9-10 to P9-13, then P9-14. P9-01 merges first if it can (it protects every later heavy run); P9-02 and P9-06 can start beside it. The control API's minor versions are numbered in merge order (1.7, 1.8, 1.9 as listed if they merge in that order).

**Closing gate (P9-14):** `pnpm gate` (all five steps), then `pnpm test:resilience`, `pnpm test:perf` and `pnpm test:trace-perf`, one after the other on the same commit, each record kept; `pnpm verify` uncached three times in a row with random property seeds.

## Exit criteria (plan section 11)

Row 9: "Resilience suite passes; performance at 60× meets the targets set in the phase plan; security review checklist complete", plus its deliverables. Every criterion is proven by local runs on the final commits; the CI jobs exist but don't run.

1. **Order and line OEE, golden:** the new `oee-core` reference cases pass (hand arithmetic to four decimals); in `orders-01` and `quality-01` every order's OEE (A, P, Q, OEE, exact inputs) and first-pass yield, and in all four goldens the line OEE per hour, shift bucket and order, equal `line-oee.json`, in order, in bounded disorder and shuffled with 10 % duplicates, with the comparison counts asserted; the equipment and work-center OEE reconciliations of Phases 5–8 pass unchanged.
2. **Order and line OEE, live:** in the `orders` reconcile pass, every order completed in shift A has a final order OEE equal to the live truth's, shift A's line OEE is final and equal, and the order detail and the dashboard show them (Playwright, values read from the page).
3. **Scenario playback:** a timeline with every action kind (P9-06's three, failures, a drift, the infrastructure faults, speed changes and pauses) played live at speeds between 1× and 60× gives an event log byte-identical to the headless run of the same timeline; a live orders run's recorded dispatches replayed headless give its event log byte for byte; `week-01`, `alarms-01`, `orders-01` and `quality-01` keep `events.sha256`, `summary.json` and `trace.json` byte-identical.
4. **Simulation console:** through `/console` as `admin`, each action of the console reaches the simulator and its effect is seen (status, the plant event stream, or the MES: a blocked lot starves OP10 with cause `MATERIAL:`, a failure raises its alarm, an absent operator leaves ASM-01 unstaffed at the next shift start); `/sim/` answers 401 anonymous and 403 to the other five roles; the control API answers 401 without its token.
5. **Resilience:** `pnpm test:resilience` passes twice in a row: the no-loss class (broker, MES SIGTERM and SIGKILL, database, ERP mock, washer silence) ends with every listed answer equal to the live truth and final, no duplicate stored, no gap incident, each ERP message once; the detected-loss class (OPC UA server offline, gateway restart) ends with gap incidents naming exactly the device numbers raised while the session was down, state resynced within 10 s, every machine final after the write-off, and the MES's answers equal to the golden harness's on the stored facts.
6. **Performance at 60×:** `pnpm test:perf` meets T1–T6 on the hardened stack, the figures (with p50, p95, max, message counts and the machine's load) recorded in the phase log and ADR-0040; `pnpm test:trace-perf` still meets Phase 8's 100 ms p95 through HTTPS.
7. **Security review:** `docs/security-review.md` has every checklist item S1–S10 with its evidence or an accepted risk with a reason, and the threat model; the tests behind S1–S5 and S10 are part of `pnpm verify`, `pnpm test:e2e` or the smoke.
8. **Derived work:** the incremental SPC derivation equals the whole derivation in the property test and on the three SPC goldens; on `week-01` a new reading p95 ≤ 10 ms and a late reading p95 ≤ 20 ms; on the synthetic month the same and the default chart read p50 ≤ 10 ms; with 200 open holds a genealogy round adds ≤ 50 ms p95.
9. **No regression:** the golden reconciliations of Phases 4–8 and the `alarms`, `orders` and `quality` reconcile passes keep their checks; every OPC UA event of a scripted shift keeps its (machine, `seq`, type) under SignAndEncrypt; `pnpm verify` passes uncached three times in a row with random property seeds.

## Risks for this phase

| Risk                                                                                                  | Response                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new action or the OEE truth changes an existing golden                                              | New event variants written only when used; truth in a sidecar; byte-identity of `events.sha256`, `summary.json` and `trace.json` asserted for all four goldens in every simulator PR                      |
| Order or line OEE needs an allocation rule the truth would have to invent                             | Order OEE on OP10 job windows only (the plant's own attribution); line OEE by throughput against the bottleneck; per-order line OEE stated as not additive                                                |
| Order OEE judged on partial data (a job window or a unit still moving)                                | Finality from the job facts, the units and the machines' final-through; bounded disorder in the goldens (Phase 8 lesson: ordered or fully shuffled replays never move the final/provisional boundary)     |
| Live playback differs from headless (wall-clock pacing, a dispatch mid-run)                           | Pacing decides only when a step runs (simulation model, "Live mode"); infrastructure entries outside the model; probe Q2 before the dispatch replay is built                                              |
| SignAndEncrypt costs CPU or drops events at 60×                                                       | Probe Q1 before anything else in P9-10; ADR-0009's spike repeated; the perf run on the hardened stack                                                                                                     |
| Certificates and trust make the stack fragile to start (expired, mismatched SAN, a new volume)        | One dev CA per stack made by a Compose step, explicit trust, stable host names in the SAN (already the simulator's rule); a runbook section to reset the PKI volumes; the smoke starts from empty volumes |
| TLS and the token break the harnesses and Playwright                                                  | One client helper per harness trusts the dev CA and sends the token; the smoke, reconcile, resilience and perf runs all go through it                                                                     |
| The console becomes a back door into the MES or the world under test                                  | `/sim/` only after `auth_request` with `sim:control` (admin only); the browser never holds the control API token; the MES never calls the control API                                                     |
| Resilience runs flake on a loaded machine and hide real failures                                      | One heavy suite at a time (P9-01); count-based waits and measured lag (#212); two consecutive passes required; the detected-loss class compares exact numbers, not tolerances                             |
| Performance targets met only on an idle machine                                                       | Q3 baseline first; the run records the load average; a target is never relaxed silently; T6 headroom shows the margin                                                                                     |
| Two agents' heavy suites at once fill the disk or time each other out (Phase 8: #212, #216, #218)     | The host-wide lock, the free-disk check, volumes and images removed per project, ephemeral host ports                                                                                                     |
| The gate grows past an hour                                                                           | Resilience and perf are their own commands, run by the PRs whose paths need them and at the close; `RECONCILE_PASSES` for reruns that touch one pass                                                      |
| Scope grows past L                                                                                    | Waves with a checkpoint; the cut line named in advance; manual scrap, retention and OpenTelemetry out of scope                                                                                            |
| No CI: evidence lives in PR text                                                                      | `pnpm gate` records per commit; the phase log from the first merge; one full closing gate with the three extra commands                                                                                   |
| Colima's VM (2 GiB unless the owner raised it) under the hardened stack and the observability profile | The profile off by default; the resilience and perf projects run alone; the owner item to raise it to 4 GiB repeated                                                                                      |

## Open decisions, decided here

The owner asked for decisions, not questions. Each is recorded in the ADR named and can be reversed in review.

| Decision                        | Options                                                                                                       | Chosen and why                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order OEE scope                 | (a) every machine's time split by units; (b) the order's OP10 job windows on its CNCs                         | (b): the only time the plant attributes to one order; (a) needs an allocation key the truth would invent (ADR-0036)                                            |
| Line OEE                        | (a) ADR-0021's time-weighted sums; (b) throughput against the bottleneck's ideal rate                         | (b), as ADR-0021 deferred "until orders"; (a) stays as the work-center OEE (ADR-0036)                                                                          |
| Where the OEE truth lives       | (a) `sim-summary/5`; (b) a sidecar `line-oee.json`                                                            | (b): no golden regeneration, no owner approval pending, as `trace.json` in Phase 8                                                                             |
| Timeline format                 | (a) JSON as `scenario.json`; (b) YAML in `config/scenarios/` with one schema for both                         | (b): the master plan names YAML timelines; the golden `scenario.json` parses to the same entries (ADR-0037)                                                    |
| Console access                  | (a) the control API with its own login; (b) nginx `auth_request` to the MES session, permission `sim:control` | (b): one login, the token stays on the server side; the MES only answers a permission check (ADR-0037, ADR-0039)                                               |
| Who holds `sim:control`         | supervisor; admin; a sixth role                                                                               | admin: the console is the physical world, not a plant role; no sixth role for one permission                                                                   |
| OPC UA user                     | anonymous over SignAndEncrypt; a user name and password; X.509 user tokens                                    | User name and password over the encrypted channel: the method's caller is named and the gateway's certificate already authenticates the application (ADR-0038) |
| MQTT client binding             | keep the plain ACL; dynamic-security plugin                                                                   | Dynamic security: closes the client-id takeover risk carried since Phase 3 (ADR-0039)                                                                          |
| Login lockout                   | per account; per (account, address); no lock, delay only                                                      | Per (account, address) with a global per-account delay: closes the accepted denial of service and still slows a distributed guess (ADR-0039)                   |
| Load-testing tool               | k6; a Node script                                                                                             | A Node script: no new dependency, MQTT and WebSocket natively, same shape as `test:trace-perf` (ADR-0040)                                                      |
| Tracing                         | OpenTelemetry SDK; keep `prom-client` only                                                                    | `prom-client` only in v1; the Grafana profile reads Prometheus (ADR-0012 amended)                                                                              |
| SPC derivation                  | whole chart per reading; from the earliest changed point; a window                                            | From the earliest changed point, proven equal by property test; the default read window of 500 points stays (ADR-0032 amended)                                 |
| Resilience and perf in the gate | always; their own commands                                                                                    | Their own commands, run by the PRs whose paths need them and at the close: the gate already takes about 45 minutes                                             |

## Review decisions

(None yet. The review of this plan's pull request records its rounds here.)

## Deviations from the master plan

Master plan rev. 9, in the same pull request as this plan, takes over the items marked "(rev. 9)", so the plan and this list don't disagree.

- **Section 11 row 9, size:** L, in three waves, instead of M (rev. 9).
- **Section 9, resilience and performance:** run locally as their own commands (`pnpm test:resilience`, `pnpm test:perf`), not nightly in CI, while GitHub Actions is unavailable; the closing gate runs both.
- **Section 6, metrics and tracing:** `prom-client` stays and OpenTelemetry tracing is not adopted in v1 (ADR-0012 amended in P9-13).
- **Section 4, interactivity:** "act as the operator" stays the operator terminal (Phase 7); the console doesn't impersonate MES users. Manual scrap from the console is after v1.0.

## Master plan rev. 9

Applied to `docs/project-plan.md` in the same pull request as this plan (change note rev. 9): row 9's size is L in three waves (section 11), and the open decision on the load-testing tool and performance targets points to this plan and ADR-0040 (section 12). Nothing else in the master plan changes: order OEE "from Phase 9" (section 7), the console, scenario YAML timelines, the resilience cases and the Grafana profile are already there.
