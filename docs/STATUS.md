# Status — updated 2026-10-21

## Current phase: 10 – Release 1.0 (started 2026-10-21)

## Exit criteria progress: 0 / 8 met

Phase 10's eight exit criteria (`docs/phases/phase-10-plan.md`, "Exit criteria") are proved on the release candidate by the closing gate (P10-10, #285), so none is met before it. Where the work stands:

- **1, fresh clone:** `pnpm test:fresh-clone` and the README's quick-start block in place (#277); `FRESH-CLONE-OK` on the PR's commits, cached and with `FRESH_CLONE_NO_CACHE=1`, not yet of record (the closing run must be on a commit in `origin/main`).
- **2, SC2 to SC5:** the suites exist and passed at the Phase 9 close; their records on the candidate and the falsifiability probes come with P10-10.
- **3, SC6:** not met, and not claimable by Claude: the owner's sign-off of Phases 4–10 (P10-11, #286).
- **4, seeds:** every `pnpm verify` prints one seed per fast-check workspace (#276); the three uncached runs of record come with P10-10.
- **5, documentation:** the API references, glossary and documentation index (#279), README, runbook and STATUS (#278) done; the architecture views and `scripts/check-architecture.ts` (#280) in progress.
- **6, demo:** `pnpm demo` passed twice in a row (#281); the recording (#282) is next.
- **7, release:** P10-08 and P10-09 (#283, #284) not started.
- **8, no regression:** the closing gate; no golden regenerated in Phase 10 so far.

## Done since last update

Since the Phase 9 close (#246, PR #274, `d589ef7`, tag `phase-09`). Each entry is in `docs/phases/phase-10-log.md` with its gates; earlier phases are in their logs and reports (`docs/phases/`).

- Phase 10 plan (PR #275, `8129355`): Release 1.0 in four waves, issues #276–#286; master plan rev. 10.
- #276 (P10-01, PR #287, `13f8faf`): property seeds recorded: the leaf package `@shopfloor/fc-seed`, one `fast-check seed <workspace>: <seed>` line per workspace and run, `FC_SEED` reproduces. Full gate `GATE-OK`.
- #281 (P10-06, PR #290, `0fdf488`): the demo scenario: probe D1 (`pnpm demo:probe`), `config/scenarios/demo-v1.yaml` with its ERP dataset, `pnpm demo` (eight scenes, each asserting what it shows), `docs/demo.md`. Gate `verify,golden,e2e,reconcile` `GATE-OK`; `pnpm demo` `DEMO-OK` twice in a row.
- #279 (P10-04, PR #291, `80d670f`): `docs/api/realtime.md` fixed, `docs/api/erp-mock.md` with its drift test, the glossary (63 terms), the documentation index `docs/README.md` with its audit, ADR-0011's note, master plan sections 5, 10 and 13. Gate `verify,smoke,reconcile` `GATE-OK`.
- #277 (P10-02, PR #289, `464b75b`): the fresh-clone start: probe F1 (the old quick start failed), `scripts/stack-init.sh` and `pnpm stack:init`, the OPC UA and Modbus host ports as variables, `pnpm test:fresh-clone`, the README's quick-start block. Gate `verify,smoke,reconcile` and `verify,smoke` `GATE-OK`; `FRESH-CLONE-OK` cached and uncached.
- #278 (P10-03, branch `docs/278-docs-pass-1`): README (run, screens, develop, documentation), the runbook restructured (a commands table, the current procedure first, the upgrade notes in one section, the CI section, the CA export without Node), this STATUS trimmed to the fixed layout.

## In progress

- #278 (P10-03) documentation pass 1: this branch, in review.
- #280 (P10-05) architecture views and `scripts/check-architecture.ts`.
- #288 (P10-F1, PR #292): explicit timeouts for tests slow under the default `verify` concurrency (`spc-core`'s incremental property test timed out in probe F1's fresh clone).

## Next up

- #282 (P10-07) the demo recording (after #278): `pnpm demo:record`, `docs/demo/`, the README's screenshots.
- #283 (P10-08) the final report `docs/final-report.md` and ADR-0041 (Sparkplug B).
- #284 (P10-09) release mechanics: version 1.0.0, CHANGELOG, the runbook's "Releasing". Its merge commit is the release candidate.
- #285 (P10-10) Phase 10 close: the closing gate on the candidate, the final report's evidence; Phase 10 then "complete, pending the owner's sign-off".
- #286 (P10-11) the owner's sign-off and the `v1.0.0` tag: the owner acts, Claude only records.

## Blockers and open questions for the owner

None of these is claimed as met. `v1.0.0` is tagged only after the owner's sign-off (P10-11, #286); Claude sets no version tag.

- **Sign off Phases 4, 5, 6, 7, 8 and 9** (v1 success criterion 6): Claude closed each under the standing instruction of 2026-10-15 without the owner's review; reports in `docs/phases/phase-NN-report.md`. Phase 9 is complete with 9 of 9 exit criteria met by local runs on `1cecd17`; its tag `phase-09` is set on `d589ef7`. Phase 10 will need the same sign-off (P10-11).
- **Approve or reject the two golden-summary regenerations** made under the standing instruction (master plan section 12 requires the owner's approval; reasons in `apps/simulator/golden/README.md`):
  - #172: `week-01` and `alarms-01` to `sim-summary/4`: only the schema line, an empty `orders` section, `analysisConfigSha256` and `oee.config.scheduledTime` changed, `events.sha256` unchanged;
  - #140: `week-01` to `sim-summary/3`: only the new `alarms` section, `analysisConfigSha256` and the schema line changed, `events.sha256` unchanged.
  - Phases 9 and 10 made none; a change to a committed `trace.json` or `line-oee.json` needs the owner's approval.
- **Review the coordinator decisions of Phase 9** (report, "Coordinator decisions awaiting the owner's review"):
  - the R3 schedule moved to CNC-01 offline 07:00–08:30 and the gateway killed 10:45–10:50, R3 failing unless it loses a fact (ADR-0009 amendment, #243);
  - the five performance-method decisions on PR #269 (ADR-0040 "Coordinator decisions"): T6's offered load ≥ 3 × P1's measured live rate with telemetry added; T2 as min(median 100 ms slope, mean) with a 15-minute stop instead of 5; the pending check as the oldest pending delivery's age ≤ 1 s; "gateway buffer 0" judged as the broker session up, the depth within one live window and nothing dropped; T5 over every container's lifecycle;
  - the login-ceiling accepted risk: two attacker addresses at their 5/s caps fill the shared ceiling and a fresh-address login then gets through about 15–37 % of the time (ADR-0039 "Login throttling", #264 round 3);
  - every MQTT user bound to its client id, reversing round 1 finding 20 (ADR-0039 MQTT); `/scenario/recorded` kept off the console (ADR-0037); `notBefore` in the head time (ADR-0036 amendment); each golden's open order asserted open, not compared, in criterion 1 (PR #252);
  - the residual security risks listed apart in `docs/security-review.md`.
- **Review the coordinator decisions of Phase 10 so far** (they go into the final report's register, P10-08):
  - the plan's decisions marked † (`docs/phases/phase-10-plan.md`, "Open decisions, decided here"): SC1's "one command" as a one-time init and `docker compose up -d --wait` in one command line, a deviation from the letter of section 1 ("`docker compose up` on a fresh clone"); SC2 proved by the local gate, not CI; SC6 and the tag only after the owner's sign-off, no version tag by Claude; Phase 10 started before Phase 9's sign-off; Sparkplug B not in v1.x (ADR-0041, P10-08); ADR-0011 amended by a dated note rather than left silent;
  - ADR-0011's note of 2026-10-21 (#279): the local gate in place of green CI since PR #149, as practised;
  - #276: `pnpm verify` prints ten seed lines, the nine fast-check workspaces plus `@shopfloor/fc-seed`'s own suite (P10-10 records the nine); and the rerun after PR #287's review was `GATE_STEPS=verify` instead of a second full gate (the review's changes touched only `fc-seed`'s own tests, config and parsing);
  - #281's demo deviations: (1) the demo's own ERP dataset `config/erp/demo-v1.yaml` through `compose.demo.yml` (the default feed has exactly the SPC baseline's 100 units before shift B, so no drift could show an episode); (2) the planned start 06:15 and a timeline pause at 06:14 make production independent of when the walkthrough dispatches (inside the envelope), where the plan expected it to vary; (3) "by about 09:30" holds for the alarm, the first completed order and scene 8's carton, not for the SPC episode (11:51, after the baseline's 100 readings), so the walkthrough runs to about 12:30, 6.5 minutes of wall time;
  - #277's deviations: the fresh clone under `~/.cache/shopfloor-twin/fresh-clone/` instead of the OS temporary directory (Colima shares only the home directory with its VM); the harness reads the clone's `.env` in memory (for the admin's login and the S7 search), never prints or stores it.
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
- **Publish GitHub releases for `phase-02` to `phase-09`** (optional; only `phase-00` and `phase-01` have one): publishing is the owner's; the runbook's "Releasing" (P10-09) will say how.
- Optional: run `pnpm stack:up`, log in (above) and look at the plant at <https://localhost:8443>: the console at `/console` (admin), the order detail's OEE under `/orders`, the OEE dashboard's line card at `/oee`, and the other screens (README, "Screens"); or play the demo by hand (`docs/demo.md`, "Running it by hand"). No exit criterion depends on it (orders and cartons run only with `SIM_PRODUCTION=orders`). Codings, acknowledgements, shelves, comments and notes saved there are audited permanently. The default dev database already holds one smoke coding and its clear from #121's first local smoke run (Phase 5 report, Known issues).

The Docker VM item of earlier phases (raise Colima to 4 GiB) is done: every Phase 9 and Phase 10 suite ran on 4 CPUs and about 3.8 GiB visible to Docker.

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: not running. GitHub Actions jobs fail at the billing check (spending limit) on every run since `ed8783b` (the merge of #149); the last green CI on `main` is `cfed3a0`, the Phase 5 close. Merges are gated locally by `pnpm gate` (runbook, "Merge gate" and "Continuous integration"), the other suites (`pnpm test:resilience`, `pnpm test:perf`, `pnpm test:trace-perf`, `pnpm test:console`, `pnpm demo`, `pnpm test:fresh-clone`) as their own commands. Every Phase 10 pull request so far passed its gate steps (phase log).
- Tests: 2,654 in `pnpm verify` uncached at the Phase 9 close (`1cecd17`); Phase 10 adds `@shopfloor/fc-seed`'s suite, the init and fresh-clone checks in `e2e`, the ERP mock's API document test and the demo's scene-log check. Beyond `verify`: `pnpm test:golden` (`week-01`, `alarms-01`, `orders-01`, `quality-01`, `line-oee.json` included), `pnpm test:e2e`, `pnpm test:reconcile` (live `alarms`, `orders` and `quality` passes), `pnpm test:console`, `pnpm test:resilience` (R1–R3), `pnpm test:perf` (P1–P3), `pnpm test:trace-perf`, `pnpm demo` and `pnpm test:fresh-clone`.
- Coverage (lines / branches) at the Phase 9 close: `sim-core` 99.4 / 98.4 (floor 95 / 90), `oee-core` 100 / 98.4 (floor 95 / 90), `alarm-core` 100 / 96.4 (floor 95 / 90), `spc-core` 99.6 / 94.0 (floor 95 / 90), `trace-core` 100 / 93.4 (floor 95 / 90), `shift-calendar` 100 / 91.4, `plant-config` 99.5 / 95.9 (floor 90 / 85), `pki` 97.3 / 86.7, simulator 88.5 / 82.4, `edge-gateway` 93.7 / 82.3, `mes-server` 95.7 / 85.3, `erp-mock` 98.1 / 91.6 and web 95.3 / 85.8 (floor 80 / 70; entry points run as processes in tests and smoke runs and are not measured).
- Golden scenarios `week-01`, `alarms-01`, `orders-01` and `quality-01`: green locally (`pnpm test:golden`, `pnpm test:e2e` in the Phase 10 gates); no regeneration in Phases 9 and 10.
- Open bugs: 1, #288 (P10-F1, PR #292 open): `spc-core`'s incremental property test times out at Vitest's 5 s under the default `pnpm verify` concurrency, a test timing, not a product defect; the gate runs `verify --concurrency=1` and never saw it. Flakes to watch: the ERP mock's readiness in the smoke and the `opcua-tools` S1 step once on `lkt-01` (from Phase 9).
