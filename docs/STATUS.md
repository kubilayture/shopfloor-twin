# Status — updated 2026-10-16

## Current phase: 06 – Alarms and shifts (planning; Phase 5 closed 2026-10-16)

## Exit criteria progress: Phase 6: 0 / 5 met (plan in review)

## Done since last update

- Phase 6 plan with issues #138–#148 under milestone "Phase 06 – Alarms and shifts"; revised after the review of PR #149 (injection only in `Running`, revisions over every affected hour, old-epoch anchors, lost clears via resync snapshots).
- #124 merged (PR #137): Phase 5 closed, tagged `phase-05`.
- **Phase 5 closed**: all 5 exit criteria met; tag `phase-05` after #124 merges (report: `docs/phases/phase-05-report.md`; learning notes: `docs/learning/phase-05.md`; data model: `docs/data-model.md`, confirmed current with both continuous aggregates and the new tables).
- Phase 5 pull requests merged: #125 (plan), #127 (#126), #128 (#116), #129 (#113), #130 (#117), #131 (#119), #132 (#118), #133 (#120), #134 (#121), #135 (#122), #136 (#123); CI's `reconcile` job passed in 10.8 min on the final commit of #136.
- #123 done (branch `test/123-e2e-oee`): end-to-end evidence for Phase 5 exit criteria 3, 4 and 5 in `pnpm test:reconcile`. Live OEE: shift A final and exactly equal to the live ground truth for all six machines and both work centers, 8 buckets compared (asserted). Dashboard: Playwright judges 874–890 OEE changes on both cards and six machine rows in 90 s, none later than 2 s (p95 about 0.9 s, max 1.2 s), and the page's values agree with the API (349–351 of 352 snapshots). Coding through the UI after the drain: a split and a recode audited, the Pareto moved exactly by the record, shift A's OEE byte-identical, 403/403/415 refusals. Two local runs RECONCILE-OK, 8 min 41 s each with cached images (CI before: 10.7 min of 30).
- #122 done (branch `feat/122-web-oee`): web OEE dashboard (`/oee`: work-center cards, machine table, hourly bars, loss waterfall, downtime Pareto, shift picker; live from `oee:<id>`) and downtime coding screen (`/downtime`: uncoded first, reason tree, splits, comment, `codedBy`, 409 and write errors handled, audit history; live from `downtime`). ECharts 6.1.0 under the strict CSP (canvas tooltip), checked in a browser against a disposable Compose stack: no CSP violation, OEE updates about once a second, a recode and a split saved and audited, no horizontal scroll at 375 px.
- #121 done (branch `feat/121-coding-writes`): downtime coding, the MES's first writes. Codings by time with splits, optimistic concurrency per (equipment, epoch) (409), clipping and orphaning after a re-cut, an append-only audit; the Pareto and the records' reason view use the reasons in effect, OEE is unchanged (tested); `PUT /api/v1/downtime/{id}/coding`, `GET /api/v1/downtime/{id}/audit`, `recoded` push. Write guards (ADR-0023): Origin required and same-origin, `Sec-Fetch-Site`, JSON only (415), 16 KiB, a global rate limit, `MES_WRITES=off` (405); nginx passes only GET, POST, PUT and DELETE; the Vite proxy rewrites `Origin` for HTTP too. Stack smoke writes and clears a coding through nginx and checks the 403/415 refusals (exit criterion 4, API and smoke parts; the UI part follows in #122 and #123).
- #120 done (branch `feat/120-oee-module`): the `oee` module computes OEE on read per equipment and work center, per hour and shift bucket; REST (`/oee`, `/shifts/{date}/{shift}/oee`, `/shifts`, `/shifts/current`, `/reason-codes`, `/downtime`, `/downtime/pareto`) and WebSocket topics `oee:<id>` and `downtime`. The golden week's OEE equals the ground truth exactly for every machine and both work centers in all shift buckets, in order and shuffled (exit criterion 2); the live reconciliation also requires shift A's OEE final and equal to the live ground truth (exit criterion 3 groundwork).
- #118 done (branch `feat/118-aggregates`): hourly continuous aggregates `equipment.state_hourly` and `ingest.cycle_hourly`, refreshed explicitly by their owning modules (ADR-0022); `piecesChanged`, `cycle` and `epoch` notices; cycle counts kept with the final hours and checked at start-up; golden week equal to the raw rows and to the ground truth's hourly OEE inputs for every machine and hour.
- #119 done (branch `feat/119-reason-codes`): reason codes and downtime records. The cause vocabulary is in `@shopfloor/contracts`, and the simulator uses it (golden week byte-identical). `config/plant/reasons.yaml` holds the reason tree and the auto-rules, with a cross-check, and is seeded into `master_data.reason_code`. `equipment.downtime_record` is derived and rebuilt with the intervals. In the golden week no record is UNCODED (exit criterion 4, first two points). ADR-0021 is amended, and the master plan's section 12 decision is closed.
- #117 done (branch `feat/117-ground-truth-oee`): the simulator's ground truth computes OEE with `oee-core`: per machine the inputs per shift bucket and UTC hour, `bucketOee` per shift bucket and `workCenterOee` for Cell M1 and Line A1; summary `sim-summary/2`, control API 1.2. Golden `summary.json` regenerated (OEE section added, every earlier field byte-identical); `events.sha256` unchanged.
- #126 done: first changeover with nothing loaded reads `CHANGEOVER none→…`; golden week byte-identical (the path is unreachable with a validated schedule), `events.sha256` unchanged as the baseline for #117.
- #115 merged (PR #125): Phase 5 plan.
- Phase 5 plan with issues #113, #115–#124 and #126 under milestone "Phase 05 – OEE and downtime".
- #101 merged (PR #114): Phase 4 closed, tagged `phase-04`.
- **Phase 4 closed**: all 4 exit criteria met; tag `phase-04` (report: `docs/phases/phase-04-report.md`; learning notes: `docs/learning/phase-04.md`; data model: `docs/data-model.md`, generated from the database with a drift test).
- #100 merged (PR #112): full-shift reconciliation through the whole chain, Playwright on the live overview, CI job `reconcile` (10.7 min).
- #99 merged (PR #111): `mes` and `web` in Compose.
- #98 merged (PR #110): `apps/web`, ADR-0020.
- #97 merged (PR #109): REST API and WebSocket push, ADR-0019.
- #96 merged (PR #106): equipment state intervals, ADR-0018.
- #95 merged (PR #105): ingest, ADR-0017.
- #94 merged (PR #104): shared shift calendar, `oee-core` intervals, master data.
- #93 merged (PR #103): `mes-server` skeleton, migrations (ADR-0016); end-to-end tests have their own CI job.
- #92 merged (PR #102): Phase 4 plan, revised after review.
- Phase 4 plan with issues #92–#101 under milestone "Phase 04 – MES foundation".
- #80 merged (PR #91): Phase 3 closed, tagged `phase-03`.
- **Phase 3 closed**: all 4 exit criteria met; tag `phase-03` (report: `docs/phases/phase-03-report.md`; learning notes: `docs/learning/phase-03.md`).
- #79 merged (PR #90): gateway container and end-to-end test.
- #78 merged (PR #89): store-and-forward outbox.
- #77 merged (PR #88): WSH-01 Modbus poller.
- #76 merged (PR #87): OPC UA collector.
- #75 merged (PR #86): gateway skeleton, broker users and ACL.
- #74 merged (PR #85): WSH-01 Modbus TCP server.
- #73 merged (PR #84): washer process values, run epoch.
- #72 merged (PR #83): UNS contracts, ADR-0015.
- #71 merged (PR #82): `modbus-serial` (ADR-0013), store-and-forward in SQLite (ADR-0014).
- #70 merged (PR #81): Phase 3 plan, revised after review (event ring buffer for WSH-01, epochs in sequence spaces, fault controls).
- Phase 3 plan with issues #70–#80 under milestone "Phase 03 – Edge gateway and UNS".
- **Phase 2 closed** and tagged `phase-02`: all 5 exit criteria met (report: `docs/phases/phase-02-report.md`; learning notes: `docs/learning/phase-02.md`).
- #56 merged (PR #68): OPC UA integration and contract tests.
- #55 merged (PR #67): simulator container and Compose service.
- #54 merged (PR #66): control API.
- #53 merged (PR #65): alarms.
- #52 merged (PR #64): LoadProgram on the CNCs.
- #51 merged (PR #63): OPC UA server per machine.
- #50 merged (PR #62): process values.
- Owner's standing instruction (2026-10-15): continue through all phases without stopping or asking. Owner-only exit criteria are recorded as deferred to the owner, never as met.
- #49 merged (PR #61): live run mode.
- #48 merged (PR #60): alarm spike, ADR-0010.
- #47 merged (PR #59): OPC UA spike, ADR-0008, ADR-0009.
- #46 merged (PR #58): Phase 2 plan, ADR-0011.
- Owner decision (2026-10-15): Claude merges from now on, after an independent review agent and a green CI (ADR-0011, plan rev. 6).
- Phase 2 plan with issues #46–#57 under milestone "Phase 02 – Device layer: OPC UA".
- **Phase 1 closed** and tagged `phase-01`: all 5 exit criteria met; the owner accepted the realism check as is.
- #30 merged (PR #44 and the sign-off PR #45).
- #29 merged (PR #43): invariant checker (independent time tally, parts by identity, material per lot), golden scenario `week-01`, `pnpm test:golden` in CI; leak readings rounded to instrument resolution after the first CI golden run found a cross-platform float difference.
- #28 merged (PR #42, squash, merged by Claude after review agent and green CI): headless runner, event log, ground-truth summary.
- #27 merged (PR #41): material lots, consumption, genealogy events.
- #25 merged (PR #40): tool wear, OP10 scrap, leak test, rework loop.
- #26 merged (PR #39): shift calendar, breaks, operators; default schedule raised to fill the week.
- #24 merged (PR #38): breakdowns, minor stops, repairs, running-time clocks.
- #23 merged (PR #37): material flow, buffers, blocking and starving, changeovers.
- #20 merged (PR #36): `sim-core` distributions, `test-kit` goodness-of-fit helpers.
- #22 merged (PR #35): machine state machine, `docs/simulation-model.md`.
- #19 merged (PR #34): `sim-core` random streams (xoshiro128**), ADR-0007.
- #21 merged (PR #33): `plant-config` schema, loader and default plant files.
- #18 merged (PR #32): `sim-core` event queue and kernel, ADR-0006, determinism lint rule.
- Phase 0 closed and tagged [`phase-00`](https://github.com/kubilayture/shopfloor-twin/releases/tag/phase-00); learning step skipped by owner decision (phase report).
- #17 merged (PR #31): Phase 1 plan with issues #18–#30; plan rev. 5 (weekly production schedule file).

## In progress

- #138 Phase 6 plan (in review)

## Next up

- #139 `alarm-core`, then #140–#148 in the plan's order. Carry-overs are in the Phase 5 report: the audit trigger and role separation (Phases 7 and 9), the global write rate limit, retention with continuous aggregates, and `prom-client` (ADR-0012).

## Blockers and open questions for the owner

- Sign off Phase 5 (v1 success criterion 6); Claude closed it under the standing instruction without the owner's review.
- Sign off Phase 4 (v1 success criterion 6); Claude closed it under the standing instruction without the owner's review.
- Install the Renovate GitHub app for this repository (carried over from Phase 0).
- Optional: run `pnpm stack:up` and look at the plant overview at <http://localhost:8080>, the OEE dashboard at `/oee` and the coding screen at `/downtime` (no exit criterion depends on it). A coding saved there is audited permanently. The default dev database already holds one smoke coding and its clear from #121's first local smoke run (Phase 5 report, Known issues).
- Raise the Docker VM's memory to 4 GiB (now 2 GiB on Colima): the full stack uses about 440 MiB at 60×, but its limits add up to about 2 GiB and the Testcontainers suites run beside it (runbook, "Full stack", Memory).

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: green (`verify`, `end to end`, `stack smoke`, `reconcile`) on `92efe6a`, the merge of #136.
- Tests: 988 (plus the `end to end` job: gateway, golden-week reconciliation of intervals, aggregates, records and 128 OEE buckets; and the `reconcile` job: live shift A, dashboard latency, UI coding).
- Coverage (lines / branches): `sim-core` 99 / 98 (floor 95 / 90), `oee-core` 100 / 99 (floor 95 / 90), `plant-config` 99 / 93 (floor 90 / 85), simulator 85 / 79, `edge-gateway` 91 / 78, `mes-server` 96 / 87 and web 96 / 86 (floor 80 / 70; entry points run as processes in tests and smoke runs and are not measured).
- Golden scenario `week-01`: green in CI.
- Open bugs: 0.
