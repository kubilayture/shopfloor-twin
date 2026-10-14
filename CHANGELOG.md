# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) from `v1.0.0`.

## [Unreleased]

### Changed

- `products.yaml` gains `componentsOperation` and per-product `reworkComponents` (#27).
- Leak-test defaults widened (sigma 0.45, limit 3.2) so that failures and rework actually occur; `leakTest.operation` and `reworkOperation` added to `process.yaml` (#25).
- Default weekly schedule raised to 1,500 VB-100 and 700 VB-200 and stock to match, so the program fills the week; shift breaks optional in the schema (#26).
- Plan rev. 5: Phases 1–6 run from a weekly production schedule file; Phase 1 plan with issues #18–#30 (#17).

### Added

- Material lots with FIFO consumption: blanks at OP10, components at OP30, a new seal kit on rework; `MATERIAL:<code>` starvation; blocking and releasing lots; `material-consumed` events for genealogy (#27).
- Tool wear with OP10 dimensional scrap and tool changes; leak-test readings with drift and weekly calibration (`Maintenance`); rework loop through a rework queue at OP30, scrap on a second failure; `result`, `reason` and `measurement` on `cycle-complete` events (#25).
- Shift calendar (Temporal, DST-safe, handovers, weekend), breaks and shift ends as `PlannedStop` / `Off` with exact resume; operators with absences, skills and speed factors; ASM-01 needs a qualified operator; `shift` and `operator` events (#26).
- Plant model breakdowns (Weibull in running hours, one per failure mode), minor stops (Poisson arrivals, exponential durations) and repairs by a limited technician pool; running-time clocks so interrupted cycles resume; `repair-start` / `repair-end` events (#24).
- Plant model material flow: stations, finite buffers with blocking and starving, parallel CNCs, log-normal cycle times, serials at OP10, changeovers from the weekly schedule; transitions Running→Setup, Blocked→Starved and Blocked→Setup added (#23).
- `sim-core` distributions: uniform, Bernoulli, exponential, Poisson arrivals, normal, log-normal (three parameterizations), Weibull, each with a fixed draw count; `@shopfloor/test-kit` with Kolmogorov–Smirnov and chi-square helpers; statistical tests with fixed seeds (#20).
- `sim-core` random streams: xoshiro128** generator verified against the reference C implementation, one stream per entity key derived from the master seed; ADR-0007 (#19).
- `apps/simulator` with the machine state machine: ten states, exhaustive transition table, time-in-state accounting; `docs/simulation-model.md` with the state diagram, checked against the code by a test (#22).
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
