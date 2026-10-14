# Phase 01 – Simulation core (headless): plan

Planned 2026-10-12. Plan reference: section 4 (simulation engine), section 3 (the plant), section 11 row 1. Size: L. Milestone: [Phase 01 – Simulation core](https://github.com/kubilayture/shopfloor-twin/milestone/2).

## Scope

A deterministic, headless discrete-event simulation of the Orbis Components plant from plan section 3. It runs as fast as possible and writes:

- a JSON Lines event log;
- a ground-truth summary of raw state durations and counts. OEE itself comes in Phase 5 (plan rev. 2).

There are no network servers in this phase; OPC UA and live pacing come in Phase 2. What the plant runs comes from two files in `config/plant/`: an initial stock file and a weekly production schedule (plan rev. 5).

## Where the code lives

| Location                      | Contents                                                                                     | Rules                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/sim-core`           | Generic kernel: event queue, simulation clock, random streams, distributions                 | Pure: relative imports only (ADR-0005); 95% line / 90% branch coverage                      |
| `packages/plant-config`       | Zod schema and YAML loader for `config/plant/*.yaml`                                         | Reads files; 90% / 85% coverage                                                             |
| `packages/test-kit`           | Statistical test helpers (Kolmogorov–Smirnov, chi-square), builders                          | Test-only                                                                                   |
| `apps/simulator/src/plant`    | The plant model: machines, buffers, routing, failures, quality, shifts, operators, materials | Deterministic: no `Math.random`, `Date.now` or `new Date()` (lint rule); 80% / 70% coverage |
| `apps/simulator/src/headless` | CLI, event log writer, ground-truth summary                                                  |                                                                                             |

## Issues, in dependency order

| #                                                              | Task                                                                                                                                                                 | Depends on         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| [#17](https://github.com/kubilayture/shopfloor-twin/issues/17) | Phase 1 plan (this document) and plan rev. 5                                                                                                                         | –                  |
| [#18](https://github.com/kubilayture/shopfloor-twin/issues/18) | `sim-core`: event queue and simulation kernel; ADR on time representation; coverage thresholds; lint rule banning wall-clock and `Math.random` in deterministic code | #17                |
| [#19](https://github.com/kubilayture/shopfloor-twin/issues/19) | `sim-core`: deterministic random streams; ADR on the random generator and stream derivation                                                                          | #18                |
| [#20](https://github.com/kubilayture/shopfloor-twin/issues/20) | `sim-core`: distributions (uniform, exponential, normal, log-normal, Weibull, Poisson arrivals); `test-kit` goodness-of-fit helpers                                  | #19                |
| [#21](https://github.com/kubilayture/shopfloor-twin/issues/21) | `plant-config`: schema, YAML loader, default plant files (equipment, products, routings, buffers, shifts, operators, failure and quality models, stock, schedule)    | #17                |
| [#22](https://github.com/kubilayture/shopfloor-twin/issues/22) | Plant model: machine state machine with the full state set and exhaustive transition table; time-in-state accounting                                                 | #18                |
| [#23](https://github.com/kubilayture/shopfloor-twin/issues/23) | Plant model: material flow (parts, serials at OP10, finite buffers, blocking and starving, parallel CNCs, cycle times, changeovers from the schedule)                | #20, #21, #22      |
| [#24](https://github.com/kubilayture/shopfloor-twin/issues/24) | Plant model: breakdowns, minor stops (`Stopped`), repairs with a technician pool                                                                                     | #23                |
| [#25](https://github.com/kubilayture/shopfloor-twin/issues/25) | Plant model: tool wear and OP10 scrap; leak-test readings with drift and calibration; rework loop                                                                    | #23                |
| [#26](https://github.com/kubilayture/shopfloor-twin/issues/26) | Plant model: shift calendar, breaks and weekends; operators (presence, absence, skills, speed factor)                                                                | #23                |
| [#27](https://github.com/kubilayture/shopfloor-twin/issues/27) | Plant model: material lots, consumption at OP10 and OP30, starvation on missing lots, serial-to-lot links                                                            | #23                |
| [#28](https://github.com/kubilayture/shopfloor-twin/issues/28) | Headless runner: CLI, versioned JSONL event log, ground-truth summary                                                                                                | #24, #25, #26, #27 |
| [#29](https://github.com/kubilayture/shopfloor-twin/issues/29) | Invariants and golden scenario: conservation and time accounting over a 5-day week, byte-identical runs, `pnpm test:golden`, CI job                                  | #28                |
| [#30](https://github.com/kubilayture/shopfloor-twin/issues/30) | Close Phase 1: report, learning notes, tag                                                                                                                           | all                |

Issues #24–#27 are independent of each other once #23 is merged. They are still opened one or two at a time, to stay within the review limit. Each model issue adds its section to `docs/simulation-model.md`: the model, its parameters, its default values and how it is validated.

## Exit criteria (plan section 11)

1. Two headless runs with the same seed, plant configuration and schedule produce byte-identical event logs and summaries.
2. Over a simulated 5-day week (Monday 06:00 to Saturday 06:00), at every event:
   - parts in = parts out + work in progress + scrap;
   - for every machine, the time in all states sums to the elapsed calendar time.
3. Statistical tests pass: every distribution matches its parameters (goodness-of-fit within tolerance, fixed seeds), and long-run breakdown and repair times match the configured MTBF and MTTR.
4. `docs/simulation-model.md` documents every model with parameters and validation.
5. The owner has checked the simulated behaviour against factory experience (plan section 12, realism risk), for example from a summary of one simulated week.

## Decisions made in this plan

- **Native `Temporal`** (built into Node.js 26) for calendar logic: shifts, breaks and the production week in Europe/Istanbul time. Simulation time itself is an integer count of milliseconds; issue 2's ADR records this.
- **A fixed weekly production schedule** in `config/plant/schedule.yaml` decides which variant each CNC runs. A variant change triggers a changeover (plan rev. 5). Until Phase 7, every shift in the calendar counts as scheduled (plan rev. 2).
- **The plant model lives in `apps/simulator`, not in `sim-core`.** `sim-core` stays a generic kernel that knows nothing about CNCs or valves. The plant model must be just as deterministic, so a lint rule bans wall-clock time and `Math.random` there too.
- **New dependencies,** each recorded in `docs/dependencies.md` by the issue that adds it:
  - `zod` and `yaml` for configuration;
  - `fast-check` for property tests;
  - `@vitest/coverage-v8` 4.x to enforce the coverage floors.

## Risks for this phase

| Risk                                                                                           | Response                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Plausible but unrealistic behaviour                                                            | Every default value is marked as a simulation assumption in `simulation-model.md`; owner reviews a simulated week (exit criterion 5) |
| Hidden non-determinism (iteration order of `Map`/`Set`, floating-point formatting, time zones) | Byte-identical double-run test from issue 2 onward, not only at the end; one serialization function for the event log                |
| Phase is large (L) and review pace is the constraint                                           | Issues kept under ~400 changed lines; at most two PRs waiting for review                                                             |
