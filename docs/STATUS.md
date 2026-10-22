# Status — updated 2026-10-22

## Current phase: 10 – Release 1.0 (started 2026-10-21): complete; signed off under the owner's delegation

**Release 1.0 signed off under the owner's delegation of 2026-10-22 (P10-11, #286).** On 2026-10-22 the owner wrote to the coordinator in chat, "kontrolleri ve onayları da sen devir alabilirsin benim onayım gerekmiyor" ("you can take over the checks and the approvals as well; my approval is not needed"), and then "sen devam et" ("you continue"). Under it the coordinator signed off Phases 2–10 and decided all 71 register items (all accepted); the owner did not review the items individually, and no item is recorded as his approval. **The tag:** `v1.0.0` and `phase-10` go on the sign-off pull request's merge commit, which is docs-only relative to the release candidate **`8aaf608`** (PR #304's merge, P10-F4; runbook, "Releasing"), after the docs-only check passes on it. The closing gate ran on `a32d71a`; `8aaf608` changes only the demo recording harness and the README's screenshot captions, so it was not rerun (R10-17). No version tag exists yet. Report: `docs/phases/phase-10-report.md`; final report: `docs/final-report.md` ("Register", "Sign-off", SC6).

**P10-F4 (#303, PR #304, `8aaf608`) moved the candidate:** the P10-11 sign-off review found that the demo recording never showed scene 5's OEE content. The fix changed `e2e/src/demo*` and `e2e/browser/demo/` and remade the recording, so the candidate is #303's merge commit `8aaf608`; the rerun table's rows for `e2e/src/demo*` (`verify`, `pnpm demo`, `pnpm demo:record`) passed on its branch (`docs/phases/phase-10-log.md`, "P10-F4 / #303").

## Exit criteria progress: 8 / 8 met (success criterion 6 met under the owner's delegation of 2026-10-22)

Proved by local runs on `a32d71a` (`docs/phases/phase-10-report.md`, "Outcome against exit criteria"). A first closing run on `dd78dcd` found `pnpm audit --prod` failing (two moderate advisories through `@shopfloor/fc-seed`'s production dependencies); P10-F3 (#300) fixed it and moved the candidate.

- **1, fresh clone:** `FRESH-CLONE-OK` on `a32d71a` with `FRESH_CLONE_NO_CACHE=1`, contained in `origin/main`.
- **2, SC2 to SC5:** every suite of the closing gate passed on `a32d71a`, and the five falsifiability probes failed as required; SC2 by the local gate, not CI; the regenerations #140 and #172 accepted under the owner's delegation (G-1, G-2).
- **3, SC6:** met under the owner's delegation of 2026-10-22: the coordinator signed off Phases 2–10 and answered the register (71 items, all accepted; P10-11, #286); the owner did not review items individually.
- **4, seeds:** three uncached `verify` runs, nine seeds each, recorded in the final report.
- **5, documentation:** `check-architecture: OK` in every run; the README's block is the one the fresh clone ran; no document marked stale.
- **6, demo:** `DEMO-OK` twice on #281, once in the closing gate and once on #303; the recording within the limits (6 min 41.3 s under R10-11, remade by #303 with every asserted view held at least 1 s); D-1 accepted under the owner's delegation.
- **7, release:** CHANGELOG `[1.0.0] - 2026-10-22`, version 1.0.0, the runbook's "Releasing" (#284); the final report complete, its P10-11 fields decided under the owner's delegation; ADR-0041.
- **8, no regression:** every closing suite passed; goldens byte-identical, none regenerated in Phase 10; `pnpm audit --prod` clean on `a32d71a`.

## Done since last update

Since the Phase 9 close (#246, PR #274, `d589ef7`, tag `phase-09`). Each entry is in `docs/phases/phase-10-log.md` with its gates; earlier phases are in their logs and reports (`docs/phases/`).

- Phase 10 plan (PR #275, `8129355`): Release 1.0 in four waves, issues #276–#286; master plan rev. 10.
- #276 (P10-01, PR #287, `13f8faf`): property seeds recorded: the leaf package `@shopfloor/fc-seed`, one `fast-check seed <workspace>: <seed>` line per workspace and run, `FC_SEED` reproduces. Full gate `GATE-OK`.
- #281 (P10-06, PR #290, `0fdf488`): the demo scenario: probe D1 (`pnpm demo:probe`), `config/scenarios/demo-v1.yaml` with its ERP dataset, `pnpm demo` (eight scenes, each asserting what it shows), `docs/demo.md`. Gate `verify,golden,e2e,reconcile` `GATE-OK`; `pnpm demo` `DEMO-OK` twice in a row.
- #279 (P10-04, PR #291, `80d670f`): `docs/api/realtime.md` fixed, `docs/api/erp-mock.md` with its drift test, the glossary (63 terms), the documentation index `docs/README.md` with its audit, ADR-0011's note, master plan sections 5, 10 and 13. Gate `verify,smoke,reconcile` `GATE-OK`.
- #277 (P10-02, PR #289, `464b75b`): the fresh-clone start: probe F1 (the old quick start failed), `scripts/stack-init.sh` and `pnpm stack:init`, the OPC UA and Modbus host ports as variables, `pnpm test:fresh-clone`, the README's quick-start block. Gate `verify,smoke,reconcile` and `verify,smoke` `GATE-OK`; `FRESH-CLONE-OK` cached and uncached.
- #288 (P10-F1, PR #292, `af9e7a4`): explicit timeouts for the tests slow under the default `verify` concurrency (`spc-core`'s incremental property 30 s, `shift-calendar`'s buckets property and the `pki` step's tests 15 s, `requireOwnMaterial` 10 s); `pnpm verify` passes at the default concurrency; the timeout rule in the runbook. Full gate `GATE-OK` and `RESILIENCE-OK`.
- #278 (P10-03, PR #294, `081d7c8`): README (run, screens, develop, documentation), the runbook restructured (a commands table, the current procedure first, the upgrade notes in one section, the CI section, the CA export without Node), this STATUS trimmed to the fixed layout.
- #280 (P10-05, PR #293, `6f345bf`): `docs/architecture.md` as C4-style Mermaid views, `scripts/check-architecture.ts` in `pnpm verify`.
- #295 (P10-F2, PR #297, `29321ea`): measured values at the characteristic's precision, plant time on the console, wall times labelled.
- #282 (P10-07, PR #296, `f8768d9`): `pnpm demo:record`; `docs/demo/` (video 4.79 MiB, 6 min 35.0 s, 960 × 540, recorded on `da16fbb`; screenshots 0.93 MiB); the README's screenshots.
- #283 (P10-08, PR #299, `3c1e18c`): `docs/final-report.md` with its evidence fields named and the register of 69 decisions awaiting the owner; ADR-0041 (no Sparkplug B in v1.x).
- #284 (P10-09, PR #298, `dd78dcd`): one product version 1.0.0, the OpenAPI regenerated, CHANGELOG `[1.0.0]`, the runbook's "Releasing". The first candidate.
- #300 (P10-F3, PR #301, `a32d71a`): `@shopfloor/fc-seed` takes `vitest` and `fast-check` as peer and development dependencies; Vitest 4.1.12; `pnpm audit --prod` clean. **The candidate.**
- #285 (P10-10, PR #302, `a1f3cbd`): the closing gate on `dd78dcd` (first run, its audit finding) and on `a32d71a` (of record), the falsifiability probes, the final report's evidence, the phase report, the learning notes.
- #303 (P10-F4, PR #304, `8aaf608`): `pnpm demo:record` holds every view a scene asserts (scene 5's OEE dashboard and its order's OEE section among them) and refuses a recording with one held under 1 s; `docs/demo/` remade on `62f5b0a` (video 5.44 MiB, 6 min 41.3 s, SHA-256 `5f9ce088…`; screenshots 0.95 MiB). Gate `verify` `GATE-OK`, `pnpm demo` `DEMO-OK`, `pnpm demo:record` `RECORD-OK`. Moves the candidate.
- #286 (P10-11, branch `docs/286-sign-off`): the sign-off record, decided by the coordinator under the owner's delegation of 2026-10-22: Phases 2–10 signed off, all 71 register items accepted (R10-17 and R10-18 added for P10-F4); CHANGELOG `[1.0.0] - 2026-10-22`. Docs only against `8aaf608`.

## In progress

- #286 (P10-11): the docs-only sign-off pull request.

## Next up

- Merge the docs-only sign-off pull request, run the docs-only check against `8aaf608` on its merge commit and set `v1.0.0` and `phase-10` there (runbook, "Releasing"), under the owner's delegation. Claude still doesn't comment on, edit or tick #286.

## Blockers and open questions for the owner

The sign-offs, the tags `phase-02` to `phase-09` (kept), the golden regenerations #140 and #172 (accepted), the Phase 9 and Phase 10 coordinator decisions and the rest of the register were decided on 2026-10-22 by the coordinator under the owner's delegation, not by the owner (`docs/final-report.md`, "Register" and "Sign-off"); D-1, the demo recording, was accepted after #303 remade it. What stays with the owner:

- **Install the Renovate GitHub app** for this repository (carried over from Phase 0).
- **GitHub Actions** is disabled by the account's spending limit: every run since PR #149's merge fails at the billing check before any job starts. Merges are gated locally (`pnpm gate`, runbook "Continuous integration"). Raise the limit or keep the local gate; if Actions returns before the tag, one CI run on the candidate is added to the final report.
- **Existing dev stack: add the secrets to `.env`** (the repository's `.env` is the owner's; no check read it). Compose refuses to start without each required one (runbook, "Upgrading a stack from before 1.0"):
  - `OPCUA_GATEWAY_PASSWORD` and `OPCUA_READER_PASSWORD` (#239): `printf 'OPCUA_GATEWAY_PASSWORD=%s\nOPCUA_READER_PASSWORD=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" >> .env`; the first `up` runs the `pki` step, which replaces the simulator's node-opcua certificates;
  - `SIM_CONTROL_TOKEN` (#237): `printf 'SIM_CONTROL_TOKEN=%s\n' "$(openssl rand -hex 16)" >> .env`;
  - if not yet done (#169, #170, #171): `ERP_API_TOKEN`, `DB_APP_PASSWORD` (e.g. `printf 'DB_APP_PASSWORD=%s\n' "$(openssl rand -hex 16)" >> .env`) and `MES_BOOTSTRAP_ADMIN_PASSWORD` (12–128 characters), and remove a leftover `MES_AUTH=off`; then `pnpm stack:up` (the `migrate` service moves the objects to the new roles, backfills the audit log and applies `0028`–`0033`; existing login locks are released by `0033`), log in as `admin` and change the password when asked (runbook, "Identity" and "Database roles"); `pnpm stack:reset` is the fallback;
  - optional: `GRAFANA_ADMIN_PASSWORD`, needed only to load `compose.observability.yml`.
  - `sh scripts/stack-init.sh` on the existing `.env` names any required key still missing, empty or `change-me`, by name only, and changes nothing.
- **Trust the dev CA** (#241): the web is at **<https://localhost:8443>** (HTTPS only; `http://localhost:8080` no longer answers). After `pnpm stack:up`, run `pnpm stack:ca` (or, without Node, `docker compose exec -T web cat /etc/nginx/tls/ca.pem > dev-ca.pem`) and trust the dev CA for SSL only (macOS: `security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db dev-ca.pem`, or in Keychain Access only "Secure Sockets Layer (SSL)" to Always Trust; Firefox: import under Authorities), then log in again; remove the trust when the project isn't in use. The MES (4700), the gateway (4900) and the database (5442) are published only by `pnpm stack:up:dev`. Optional new variables: `WEB_HTTPS_PORT` (8443, replaces `WEB_PORT`) and `MES_COOKIE_SECURE` (`on`; `off` only for the Vite dev server on plain HTTP). Runbook, "HTTPS and the dev CA" and "Upgrading a stack from before 1.0".
- **Read the broker as `mosquitto_sub -i dev`** (#240): every broker user is bound to its client id, so `dev` connects only under the id `dev`, one session at a time.
- **Publish GitHub releases for `phase-02` to `phase-09`** (optional; only `phase-00` and `phase-01` have one): publishing is the owner's; the runbook's "Releasing" ("Earlier phase releases") says how.
- Optional: run `pnpm stack:up`, log in (above) and look at the plant at <https://localhost:8443>: the console at `/console` (admin), the order detail's OEE under `/orders`, the OEE dashboard's line card at `/oee`, and the other screens (README, "Screens"); or watch the demo's recording (`docs/demo/shopfloor-twin-v1.webm`), or play the demo by hand (`docs/demo.md`, "Running it by hand"). No exit criterion depends on it (orders and cartons run only with `SIM_PRODUCTION=orders`). Codings, acknowledgements, shelves, comments and notes saved there are audited permanently. The default dev database already holds one smoke coding and its clear from #121's first local smoke run (Phase 5 report, Known issues).

The Docker VM item of earlier phases (raise Colima to 4 GiB) is done: every Phase 9 suite ran on 4 CPUs and 3.81 GiB visible to Docker (Phase 9 report, "Owner items"), and #277's fresh-clone runs recorded the same VM (4 CPUs, 3.8 GiB; phase log).

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: not running. GitHub Actions jobs fail at the billing check (spending limit) on every run since `ed8783b` (the merge of #149); the last green CI on `main` is `cfed3a0`, the Phase 5 close. Merges are gated locally by `pnpm gate` (runbook, "Merge gate" and "Continuous integration"), the other suites (`pnpm test:resilience`, `pnpm test:perf`, `pnpm test:trace-perf`, `pnpm test:console`, `pnpm demo`, `pnpm test:fresh-clone`) as their own commands. Every Phase 10 pull request passed its gate steps (phase log), and the closing gate passed in full on `a32d71a` (`docs/phases/phase-10-report.md`).
- Tests: 2,804 in `pnpm verify` uncached on `a32d71a` (the closing gate, four runs; 55 turbo tasks, 0 cached; Phase 9 close: 2,654); Phase 10 added `@shopfloor/fc-seed`'s suite, the init and fresh-clone checks and the architecture check's tests in `e2e`, the ERP mock's API document test, the demo's scene-log and recording checks, the version tests and the display tests. Beyond `verify`: `pnpm test:golden` (`week-01`, `alarms-01`, `orders-01`, `quality-01`, `line-oee.json` included), `pnpm test:e2e`, `pnpm test:reconcile` (live `alarms`, `orders` and `quality` passes), `pnpm test:console`, `pnpm test:resilience` (R1–R3), `pnpm test:perf` (P1–P3), `pnpm test:trace-perf`, `pnpm demo` and `pnpm test:fresh-clone`.
- Coverage (lines / branches) on `a32d71a` (the closing gate): `sim-core` 99.4 / 98.4 (floor 95 / 90), `oee-core` 100 / 98.4 (floor 95 / 90), `alarm-core` 100 / 96.4 (floor 95 / 90), `spc-core` 99.6 / 94.0 (floor 95 / 90), `trace-core` 100 / 93.4 (floor 95 / 90), `shift-calendar` 100 / 91.4, `plant-config` 99.5 / 95.9 (floor 90 / 85), `pki` 97.3 / 86.7, simulator 88.5 / 82.4, `edge-gateway` 93.8 / 82.7, `mes-server` 95.6 / 85.3, `erp-mock` 98.1 / 91.6 and web 95.4 / 86.1 (floor 80 / 70; entry points run as processes in tests and smoke runs and are not measured).
- Golden scenarios `week-01`, `alarms-01`, `orders-01` and `quality-01`: green locally (`pnpm test:golden`, `pnpm test:e2e` in the Phase 10 gates and the closing gate on `a32d71a`); no regeneration in Phases 9 and 10.
- Open bugs: 0 (P10-F1 #288, P10-F2 #295, P10-F3 #300 and P10-F4 #303 fixed). `pnpm audit --prod`: no known vulnerabilities on `a32d71a`. Flakes to watch: the ERP mock's readiness in the smoke and the `opcua-tools` S1 step once on `lkt-01` (from Phase 9); neither recurred in either closing run.
