# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) from `v1.0.0`.

## [Unreleased]

### Changed

- Plan rev. 6 and ADR-0011: Claude merges after an independent review agent and a green CI; ADR-0004's merge rule superseded; PR template checklist updated (#46).
- `products.yaml` gains `componentsOperation` and per-product `reworkComponents` (#27).
- Leak-test defaults widened (sigma 0.45, limit 3.2) so that failures and rework actually occur; `leakTest.operation` and `reworkOperation` added to `process.yaml` (#25).
- Default weekly schedule raised to 1,500 VB-100 and 700 VB-200 and stock to match, so the program fills the week; shift breaks optional in the schema (#26).
- Plan rev. 5: Phases 1–6 run from a weekly production schedule file; Phase 1 plan with issues #18–#30 (#17).

### Added

- Phase 2 closed: report and learning notes; all 5 exit criteria met; tag `phase-02` (#57).
- OPC UA integration and contract tests: the address-space contract is parsed and checked against the code and all five live servers; a generic client finds every machine under Machinery/Machines; telemetry follows the chosen speed; a scripted shift reaches two clients per server with no sequence gaps; a deliberately small queue shows its gaps in `Sequence`. Contract and ADR-0009 note node-opcua's event-queue bounds of 100–5000 (#56).
- Simulator container: `apps/simulator/Dockerfile` (Node 26 Alpine, production dependencies only, non-root, healthcheck on `/health/ready`) and a Compose service `simulator` with the control API and OPC UA ports on loopback, resource limits and a certificate volume; stack smoke test checks it (#55).
- Simulator control API (Fastify): pause, resume, step, speed and status under `/api/v1`; plant events over WebSocket in the event-log format; `/health/live`, `/health/ready`, Prometheus `/metrics` (ADR-0012); environment configuration validated at start-up; graceful SIGTERM shutdown; generated OpenAPI in `docs/api/` with a drift test; contract `docs/contracts/simulator-control-api.md`. `pnpm sim:serve` is now configured through environment variables instead of flags (#54).
- Alarms: failure codes active while a machine is down, `CALIBRATION-DUE` on LKT-01; `alarm` events; per-machine `ShopFloor.Alarms.<CODE>.Active` and `ActiveCount` on OPC UA with a `ShopFloorAlarmEventType` event per transition; alarm invariants. Golden `week-01` updated: 4 new alarm events, all other values unchanged (#53).
- `LoadProgram(Product, Quantity)` on the CNCs: campaign at the front of the queue, changeover at the next cycle boundary; `program-loaded` event (#52).
- One OPC UA server per machine (ports 4841–4845): companion model, project namespace, state and cycle events with sequence numbers, simulation-time timestamps, telemetry; contract in `@shopfloor/contracts` and `docs/contracts/opcua-address-space.md`; `pnpm sim:serve` (#51).
- Process values for the CNCs (spindle load, coolant temperature) as pure functions of simulation time; `hashedStandardNormal` in `sim-core`; `processValues` in `process.yaml` (#50).
- Live run mode: `LivePacer` paces simulation time to wall time × speed (0.5–60×) with pause, resume, step and speed changes, and produces exactly the headless event stream; `pnpm sim:live`; `Simulation.nextEventTime` (#49).
- Spike #48: Alarms & Conditions in node-opcua evaluated; ADR-0010 (alarms as state variables plus project events; lifecycle in the MES) (#48).
- Spike #47: node-opcua servers, companion model and lossless delivery measured; ADR-0008 (address space) and ADR-0009 (lossless delivery); `node-opcua` 2.187.3 (#47).
- Phase 2 plan with issues #46–#57 (#46).
- Phase 1 sign-off: owner's realism check recorded; exit criteria 5 / 5 (#30).
- Phase 1 report, realism check of the golden week with 12 questions for the owner, learning notes (#30).
- Invariant checker (part conservation, time accounting, material conservation) after every simulation step; golden scenario `week-01` with committed summary and event-log hash; `pnpm test:golden` (`--update` to rewrite) and a CI step (#29).
- Headless runner: `pnpm sim:headless` writes a versioned JSONL event log with a run header and a ground-truth summary (state time per machine in total and per shift, cycles, production, lots); deterministic, byte-stable serialization (#28).
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
