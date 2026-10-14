# Status — updated 2026-10-14

## Current phase: 01 – Simulation core (started 2026-10-14)

## Exit criteria progress: 0 / 5 met

## Done since last update

- #21 merged (PR #33): `plant-config` schema, loader and default plant files.
- #18 merged (PR #32): `sim-core` event queue and kernel, ADR-0006, determinism lint rule.
- Phase 0 closed and tagged [`phase-00`](https://github.com/kubilayture/shopfloor-twin/releases/tag/phase-00); learning step skipped by owner decision (phase report).
- #17 merged (PR #31): Phase 1 plan with issues #18–#30; plan rev. 5 (weekly production schedule file).

## In progress

- #22 Plant model: machine state machine (in review)

## Next up

- #19 random streams (in review, PR #34), then #20 distributions
- #23 Plant model: material flow (after #20, #21 and #22)

## Blockers and open questions for the owner

- Install the Renovate GitHub app for this repository (carried over from Phase 0).

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: green (`verify`, `stack smoke`).
- Coverage: `sim-core` floor 95% lines / 90% branches enforced; currently 98.9% / 97.3%.
- Open bugs: 0.
