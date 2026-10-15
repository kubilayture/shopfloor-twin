# Status — updated 2026-10-15

## Current phase: 02 – Device layer: OPC UA (planning, started 2026-10-14)

## Exit criteria progress: 0 / 5 met

## Done since last update

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

- #56 integration tests and contract check (in review)

## Next up

- #57 Phase 2 close (report, learning notes, tag `phase-02`)

## Blockers and open questions for the owner

- Install the Renovate GitHub app for this repository (carried over from Phase 0).

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: green (`verify`, `stack smoke`).
- Coverage: `sim-core` about 99 / 98 (floor 95 / 90), `plant-config` 99 / 90 (floor 90 / 85), simulator 87 / 83 (floor 80 / 70; `cli.ts` runs only as a subprocess in tests and is not measured).
- Golden scenario `week-01`: green in CI.
- Open bugs: 0.
