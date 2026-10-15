# Status — updated 2026-10-15

## Current phase: 03 – Edge gateway and UNS (planning, started 2026-10-15)

## Exit criteria progress: 0 / 4 met

## Done since last update

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

- #74 Modbus server for WSH-01 (in review)

## Next up

- #75 gateway skeleton and broker security, #76 OPC UA collector

## Blockers and open questions for the owner

- Install the Renovate GitHub app for this repository (carried over from Phase 0).

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: green (`verify`, `stack smoke`).
- Coverage: `sim-core` about 99 / 98 (floor 95 / 90), `plant-config` 99 / 91 (floor 90 / 85), simulator 85 / 80 (floor 80 / 70; entry points run only as subprocesses or smoke runs and are not measured).
- Tests: 452.
- Golden scenario `week-01`: green in CI.
- Open bugs: 0.
