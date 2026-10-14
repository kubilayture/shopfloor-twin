# Status — updated 2026-10-12

## Current phase: 00 – Foundations (started 2026-10-10)

## Exit criteria progress: 4 / 4 met

## Done since last update

- PR #16 merged: squash-merge decision recorded.
- PR #15 merged: Phase 0 report and learning notes.
- Owner decision: pull requests are merged with "Squash and merge" from now on, as plan section 8 says.
- #4 merged (PR #14): CI (`verify`, `stack smoke`), PR template, issue forms, CODEOWNERS, Renovate config. First CI run on `main` green.
- #5 merged (PR #11): Docker Compose with TimescaleDB 2.30 / PostgreSQL 18 and Mosquitto 2.1, `pnpm stack:*`, smoke test.
- #3 merged (PR #10): type-checked ESLint, dependency rules with tests, pre-commit hook, ADR-0005.
- #12 merged (PR #13): all documentation in English (plan rev. 4).
- #2 merged (PR #9): pnpm + Turborepo monorepo, strict TypeScript, `pnpm verify`, ADR-0002, ADR-0003.
- Repository created; plan rev. 2 on `main`.
- Labels, milestone "Phase 00 – Foundations" and issues #1–#6 created.
- #1 merged (PR #7): docs skeleton, ADR-0001, ADR-0004.
- GitHub Project board with Status (Backlog → Done) and Phase fields; Phase 0 issues added.

## In progress

- #6 Phase 0 close: waiting for the owner's review answers and exercise PR, then the `phase-00` tag.
- #17 Phase 1 plan and plan rev. 5 (in review). Phase 1 issues #18–#30 created under milestone "Phase 01 – Simulation core".

## Next up

- #18 `sim-core`: event queue and simulation kernel
- #21 `plant-config`: schema, loader and default plant files (independent of #18)

## Blockers and open questions for the owner

- Answer the review questions and complete the exercise in `docs/learning/phase-00.md` (closes Phase 0).
- Install the Renovate GitHub app for this repository.

Project board: https://github.com/users/kubilayture/projects/1

## Health: CI on main, coverage, open bugs

- CI on `main`: green (`verify`, `stack smoke`).
- Coverage: thresholds start in Phase 1.
- Open bugs: 0.
