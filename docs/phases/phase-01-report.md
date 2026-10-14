# Phase 01 – Simulation core (headless): report

Period: 2026-10-14. Milestone: [Phase 01 – Simulation core](https://github.com/kubilayture/shopfloor-twin/milestone/2).

## Outcome against exit criteria

| #   | Exit criterion                                                                    | Result   | Evidence                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Two runs with the same seed, plant configuration and schedule are byte-identical  | Met      | `headless.test.ts`: two CLI processes with different `TZ` produce identical `events.jsonl` and `summary.json`. The golden scenario `week-01` pins the bytes (SHA-256 of 35,760 lines), and CI (Linux x86) reproduces them exactly as on macOS ARM                                                                          |
| 2   | Conservation and time-accounting invariants hold at every event over a 5-day week | Met      | `InvariantChecker` after every simulation step: three 5-day weeks in the test suite, and about 12,600 checks per golden run. Parts are checked by identity; time is checked against an independent tally from the event log; material per lot                                                                              |
| 3   | Statistical tests pass, and long-run MTBF and MTTR match the configuration        | Met      | KS and chi-square tests with fixed seeds for every distribution (`distributions.test.ts`) and in the running plant: time to failure in running hours, repair times, minor stops (`reliability.test.ts`), scrap rate and leak readings (`quality.test.ts`). Mutation checks showed the tests detect 10–20% parameter errors |
| 4   | `docs/simulation-model.md` documents every model with parameters and validation   | Met      | Sections: machine states, material flow, breakdowns, shifts and operators, quality, materials, headless output, invariants, distributions                                                                                                                                                                                  |
| 5   | The owner has checked the simulated behaviour against factory experience          | **Open** | `docs/phases/phase-01-realism-check.md`: the golden week in numbers and 12 questions. The `phase-01` tag waits for the answers                                                                                                                                                                                             |

## Delivered

| Issue | Pull request | What                                                                                          |
| ----- | ------------ | --------------------------------------------------------------------------------------------- |
| #17   | #31          | Phase 1 plan, plan rev. 5 (weekly production schedule)                                        |
| #18   | #32          | `sim-core` event queue and kernel, ADR-0006 (integer-millisecond time), determinism lint rule |
| #21   | #33          | `plant-config` schema, loader, default plant files                                            |
| #19   | #34          | Random streams (xoshiro128**, per-entity keys), ADR-0007                                      |
| #22   | #35          | Machine state machine, `docs/simulation-model.md`                                             |
| #20   | #36          | Distributions, `test-kit` goodness-of-fit helpers                                             |
| #23   | #37          | Material flow, buffers, blocking and starving, changeovers                                    |
| #24   | #38          | Breakdowns, minor stops, repairs, running-time clocks                                         |
| #26   | #39          | Shift calendar (Temporal, DST-safe), breaks, operators                                        |
| #25   | #40          | Tool wear, OP10 scrap, leak test, rework                                                      |
| #27   | #41          | Material lots, consumption, genealogy events                                                  |
| #28   | #42          | Headless runner, JSONL event log, ground-truth summary                                        |
| #29   | #43          | Invariant checker, golden scenario, `pnpm test:golden` in CI                                  |
| #30   | this PR      | Phase report, realism check, learning notes                                                   |

## Metrics

- Packages and apps: `sim-core`, `plant-config`, `test-kit`, `apps/simulator` (plus Phase 0 packages).
- Tests: 376 in total (simulator 215, `sim-core` 67, `plant-config` 27, `test-kit` 28, `eslint-config` 30, `contracts` 9).
- Coverage: `sim-core` about 99% lines and 98% branches (floor 95 / 90); `plant-config` 99 / 90 (floor 90 / 85); simulator 87 / 83 (floor 80 / 70). The plant model alone is about 97 / 91; the headless CLI is tested as a subprocess, which coverage doesn't measure.
- Performance: one simulated week (about 35,800 events) in about 0.2 s; with invariant checks after every step, about 0.5 s.
- ADRs: 0006 (simulation time), 0007 (random streams).

## Deviations from the plan

| Deviation                                               | Reason                                                                  | Recorded in                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| Phase 0 closed without the learning step                | Owner decision                                                          | Phase 0 report              |
| Weekly production schedule file added                   | The plan defined stock but not what to make in Phases 1–6               | Plan rev. 5                 |
| Default schedule raised from 1,200 + 500 to 1,500 + 700 | The first reference week finished the program by Thursday               | PR #39                      |
| Leak-test defaults widened (sigma 0.45, limit 3.2)      | With the old values the rework loop would almost never run              | PR #40                      |
| Breaks optional in the shift schema                     | Tests of single models need continuous operation                        | PR #39                      |
| Rework via a separate queue at ASM-01                   | Sending parts back into a full buffer can deadlock the line             | PR #40, realism question 12 |
| Claude reviewed and merged #42 and #43 itself           | Owner decision for the rest of Phase 1 (temporary override of ADR-0004) | Phase log, STATUS           |

## Known issues and carry-overs

- **The realism answers (exit criterion 5) are pending.** They may change defaults, and then the golden snapshot.
- The ideal cycle time is currently the _mean_ of the cycle-time distribution (realism question 8). The Phase 5 OEE definitions depend on this choice.
- No control API or live pacing yet: Phase 2.
- KPIs in the ground truth (OEE) arrive with `oee-core` in Phase 5 (plan rev. 2); the summary has raw state times and counts.
- Renovate is still not installed (Phase 0 carry-over).

## Lessons

- **Independent review agents found real issues** in both PRs they reviewed:
  - an invariant that could never fail, and a test that only appeared to prove it worked;
  - output that depended on the machine's time zone;
  - a CLI that reported success after a failed write.

  Self-review didn't catch these.

- **Determinism must hold across platforms, not just across runs.** The first golden run in CI (Linux x86) differed from local runs (macOS ARM) in the last bits of unrounded leak readings. Rule since then: no raw float leaves the model. Durations are rounded to milliseconds, measurements to instrument resolution. Without the golden step in CI this would have surfaced much later, in the MES reconciliation.
- **Statistical tests need power.** At realistic rates (0.6% scrap) a week of data can't detect a 20% error, so tests use amplified parameters to check the mechanism. Mutation checks (deliberately wrong parameters) are a cheap way to prove a statistical test actually tests something.
- **Doing #24 and #26 one after the other** instead of in parallel was right: both changed how a machine's running is interrupted, and the interplay (a breakdown during a break) was designed once instead of being merged twice.
- **Reference runs** after each model exposed configuration problems that tests didn't: a schedule that ended on Thursday, and a leak limit that never triggered.
