# Phase 00 – Foundations: plan

Started 2026-10-10. Plan reference: section 11, row 0. Milestone: [Phase 00 – Foundations](https://github.com/kubilayture/shopfloor-twin/milestone/1).

## Scope

Repository, monorepo tooling, TypeScript and lint configuration, CI, issue and PR templates, documentation skeleton, the first ADRs, and a Compose stack with TimescaleDB and Mosquitto. No application code yet.

## Issues

| #                                                            | Task                                                                                   | Depends on |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------- |
| [#1](https://github.com/kubilayture/shopfloor-twin/issues/1) | Docs skeleton, STATUS, Phase 0 plan, ADR-0001 and ADR-0004                             | –          |
| [#2](https://github.com/kubilayture/shopfloor-twin/issues/2) | pnpm + Turborepo monorepo with strict TypeScript and `pnpm verify`; ADR-0002, ADR-0003 | #1         |
| [#3](https://github.com/kubilayture/shopfloor-twin/issues/3) | ESLint type-checked config, dependency rules, Prettier, pre-commit hook                | #2         |
| [#4](https://github.com/kubilayture/shopfloor-twin/issues/4) | CI workflow, issue and PR templates, CODEOWNERS, Renovate                              | #3         |
| [#5](https://github.com/kubilayture/shopfloor-twin/issues/5) | Docker Compose with TimescaleDB and Mosquitto                                          | #1         |
| [#6](https://github.com/kubilayture/shopfloor-twin/issues/6) | Close Phase 0: report, learning notes, tag                                             | all        |

## Exit criteria

1. Fresh clone: `pnpm install && pnpm verify` passes.
2. CI green on `main`.
3. `docker compose up` shows a healthy database and broker.
4. `docs/STATUS.md` in place.

## Decisions taken at phase start

- Repository is private on GitHub Free; branch protection is unavailable, so merge rules are working rules (ADR-0004).
- Learning files and PR "Concepts" notes are written in Turkish.
- The GitHub Project board needs the `project` token scope; it is set up once the owner grants it (see STATUS blockers).
