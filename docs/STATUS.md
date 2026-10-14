# Status — updated 2026-10-14

## Current phase: 01 – Simulation core (started 2026-10-14)

## Exit criteria progress: 0 / 5 met

## Done since last update

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

- #25 Plant model: tool wear, OP10 scrap, leak test and rework (in review)

## Next up

- #27 material lots and consumption
- #28 headless runner, event log and ground-truth summary
- #29 invariants, determinism and golden scenario

## Blockers and open questions for the owner

- Install the Renovate GitHub app for this repository (carried over from Phase 0).

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: green (`verify`, `stack smoke`).
- Coverage: `sim-core` floor 95% lines / 90% branches enforced; currently 98.9% / 97.3%.
- Open bugs: 0.
