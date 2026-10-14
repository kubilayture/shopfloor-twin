# Status — updated 2026-10-14

## Current phase: 01 – Simulation core (started 2026-10-14)

## Exit criteria progress: 4 / 5 met (criterion 5, the owner's realism check, is open)

## Done since last update

- #29 merged (PR #43): invariant checker (independent time tally, parts by identity, material per lot), golden scenario `week-01`, `pnpm test:golden` in CI; leak readings rounded to instrument resolution after the first CI golden run found a cross-platform float difference.
- #28 merged (PR #42, squash, merged by Claude after review agent and green CI): headless runner, event log, ground-truth summary.
- #27 merged (PR #41): material lots, consumption, genealogy events.
- Owner decision (2026-10-14): until Phase 1 is finished, Claude reviews and merges the Phase 1 pull requests itself (squash, CI green, separate review agent per PR); temporary override of ADR-0004.
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

- #30 Close Phase 1: report, realism check, learning notes (in review). The `phase-01` tag waits for the owner's realism answers.

## Next up

- Phase 02 – Device layer: OPC UA (planning), after Phase 1 is tagged

## Blockers and open questions for the owner

- **Realism check (Phase 1 exit criterion 5):** answer the 12 questions in `docs/phases/phase-01-realism-check.md`.
- Install the Renovate GitHub app for this repository (carried over from Phase 0).

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: green (`verify`, `stack smoke`).
- Coverage: `sim-core` about 99 / 98 (floor 95 / 90), `plant-config` 100 / 91 (floor 90 / 85), simulator about 96 / 89 (floor 80 / 70).
- Golden scenario `week-01`: green in CI.
- Open bugs: 0.
