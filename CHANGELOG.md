# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) from `v1.0.0`.

## [Unreleased]

### Changed

- Plan rev. 5: Phases 1–6 run from a weekly production schedule file; Phase 1 plan with issues #18–#30 (#17).

### Added

- `@shopfloor/sim-core`: event queue ordered by (time, sequence), simulation kernel with schedule, cancel, step, run and run-until; property tests; 95/90 coverage floor (#18).
- Lint rule banning wall-clock reads and unseeded randomness in deterministic code (#18).
- ADR-0006: simulation time as integer milliseconds (#18).
- `@shopfloor/plant-config`: Zod schema, YAML loader with cross-file checks and errors by file and path; default plant files in `config/plant/` from plan section 3, assumptions marked (#21).
- Project plan (rev. 3), documentation skeleton, `docs/STATUS.md`, Phase 0 plan and log (#1).
- ADR-0001: record architecture decisions in MADR format (#1).
- ADR-0004: review and merge policy without branch protection (#1).
- pnpm workspace with version catalog, Turborepo, strict shared TypeScript config, Prettier and `pnpm verify` (#2).
- `@shopfloor/contracts` with the UNS equipment-topic builder (#2).
- ADR-0002: stack and versions; ADR-0003: monorepo layout and TypeScript without a build step (#2).
- `@shopfloor/eslint-config`: type-checked ESLint rules, Prettier compatibility and the plan's dependency rules with tests; `pnpm verify` now lints (#3).
- Pre-commit hook (lefthook) that formats and lints staged files (#3).
- ADR-0005: enforce dependency rules with `no-restricted-imports` (#3).
- Phase 0 report and learning notes (#6).
- GitHub Actions CI (`verify` and `stack smoke` jobs) on every pull request and on `main`; PR template with the Definition of Done; issue forms for task, bug, spike and ADR proposal; CODEOWNERS; Renovate config (#4).
- Docker Compose stack with PostgreSQL 18 + TimescaleDB 2.30 and Mosquitto 2.1 (authentication on, persistence, healthchecks), `pnpm stack:*` commands and a smoke test (#5).
