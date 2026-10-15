# ADR-0021: OEE definitions, exact arithmetic and the micro-stop threshold

- Status: accepted
- Date: 2026-10-16
- Deciders: Claude (#116), within the Phase 5 plan; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Phase 5 must show OEE that equals the simulator's ground truth "exactly, and therefore also to four decimals" (Phase 5 exit criteria 1–3), per machine and per work center, per hour and per shift. Plan section 7 gives the ISO 22400-2 terms and a state-to-loss table, but leaves open:

- the micro-stop threshold (plan section 12, open decision), and whether it applies to a piece of a Stopped interval or to the whole interval;
- what "scheduled" means before orders exist, and what to do with breaks, Maintenance and the `no-shift` bucket;
- how to compute so that two programs (simulator and MES) agree to the last digit, and what to return where a ratio is undefined;
- how a work center is aggregated, and how losses are split so that a waterfall adds up;
- how the threshold reaches both programs without changing the simulator's golden event log.

## Considered options

Arithmetic: (a) IEEE doubles, compared with a tolerance; (b) a decimal library; (c) integer inputs and reduced BigInt fractions, rounded with integer arithmetic.

Threshold scope: (a) per piece in the bucket; (b) per whole Stopped interval.

Undefined ratios: (a) 0; (b) `null` ("not applicable"), with a flag where the inputs contradict each other.

Work centers: (a) the mean of the machines' OEE; (b) the sums of the machines' inputs; (c) line throughput against the bottleneck's ideal rate.

Configuration: (a) the threshold in `products.yaml` or `process.yaml`; (b) a new `config/plant/oee.yaml`, loaded by `plant-config` but kept out of the simulator's config hash.

## Decision outcome

**Arithmetic: (c).** Every input is an integer: milliseconds per state, Stopped pieces with their whole length, cycle counts per (product, result) and ideal cycle times per (product, operation) in whole ms (`plant-config` refuses ideal times with more than three decimals of a second). Results are reduced `{ num, den }` BigInt fractions. Four-decimal values are rounded half-up (a tie away from zero) with integer arithmetic. `oee-core` uses no floating point: an ESLint rule (`exactnessRules`) forbids `Math.*`, number literals with a decimal point or exponent, `parseFloat`, `toFixed`, negative powers and the `/` operator in `packages/oee-core/src`; the one bigint division sits in `fraction.ts` behind a commented exemption. (a) can't promise equal four-decimal strings across two programs; (b) adds a dependency to a pure package for no gain.

**Definitions** (per equipment, device epoch and bucket):

- **Planned busy time (PBT):** time in every state except PlannedStop, Maintenance and Off, under `scheduledTime: shift-calendar` (Phases 1–6: every shift bucket is scheduled, `no-shift` never is, so its PBT is 0). Breaks are excluded by state, not by calendar: the simulator puts machines into PlannedStop for the break except Setup, Down and Maintenance, which continue, so a breakdown repaired during a break stays availability loss. All Maintenance is the planned leak-test calibration; unplanned work is Down.
- **Actual production time (APT):** Running + Stopped intervals below the threshold.
- **Ideal time:** Σ over products of (ideal ms at the machine's operation × produced count); produced = good + scrap + rework.
- **A** = APT / PBT; **P** = ideal time / APT, not clamped (cycles are credited to the bucket containing their `sourceTime`, so P > 1 is possible and correct at hour granularity); **Q** = good / produced (first-pass yield: a leak-test rework is produced but not good, a retest is a produced cycle like any other).
- **OEE** = (ideal × good) / (PBT × produced): A × P × Q with APT cancelled, one exact fraction.
- **Edge cases: (b).** PBT = 0: A, P, Q, OEE and every loss are `null`: nothing was planned, so nothing was lost. APT = 0: P is `null`; if cycles were counted, OEE is `null` too and `anomaly` is set (the closed form would give a number, but A·P·Q is undefined). Produced = 0 with PBT > 0: Q is `null` and OEE is 0, because nothing good was made in planned time. The property OEE = A·P·Q is tested where all three are defined.

**Micro-stop threshold: 120 000 ms, scope (b).** A Stopped interval is a micro-stop when its whole length is below the threshold; each of its pieces is still credited to its own hour. An open interval below the threshold counts as a micro-stop provisionally (`provisional`), until it reaches the threshold (then final: it can only grow) or closes. Down is never a micro-stop, however short. Two minutes is the plan's default; the simulator's minor stops are exponential and not truncated, so some exceed it, as in a real plant. (a) would turn a 3-minute stop that crosses an hour into two "micro-stops".

**Loss mapping** (plan section 7):

| State, inside PBT                   | Counts as | Loss                                             |
| ----------------------------------- | --------- | ------------------------------------------------ |
| Running                             | APT       | speed loss if slower than ideal                  |
| Stopped, whole interval < threshold | APT       | performance: micro-stop                          |
| Stopped, whole interval ≥ threshold | –         | availability, own                                |
| Down, Setup, Idle                   | –         | availability, own                                |
| Starved, Blocked                    | –         | availability, external (not the machine's fault) |
| PlannedStop, Maintenance, Off       | excluded  | none                                             |

**Unplanned cycles.** Cycles in an unscheduled bucket (`no-shift`) don't count towards the ideal time, good and produced totals that feed P and Q; they are reported apart as `unplanned` good, produced and ideal ms. So a sum over shift and no-shift buckets (a day, a week) keeps the shifts' P, Q, OEE and losses, and still shows that parts were made off shift. Cycles in a scheduled bucket whose PBT happens to be 0 (an hour of planned stop and calibration) stay planned, because they belong to the shift and its sum.

Speed loss = APT − micro-stops − ideal time; it may be negative (P > 1). Quality loss = ideal time × (1 − Q), in ideal ms. So, in every bucket with PBT > 0, PBT = APT + own + external, APT = micro-stops + speed loss + ideal time, and ideal time − quality loss = OEE × PBT: a waterfall adds up exactly, also with a product mix.

**Work centers: (b).** ΣAPT/ΣPBT, Σideal/ΣAPT, Σgood/Σproduced: exact, time-weighted, each machine's ideal time from its own operation. It is not a line-throughput OEE; the dashboard marks the bottleneck (ASM-01) beside it. (c) waits for orders (Phase 7).

**Configuration: (b).** `config/plant/oee.yaml` holds `microStopThresholdMs` and `scheduledTime`; `plant-config` validates it (positive integer; `shift-calendar` is the only rule until Phase 7) and cross-checks that shifts start and end on whole hours in a zone whose UTC offsets are whole hours (cycles carry no shift key, so each UTC hour must lie in one shift bucket). `plant-config` now separates `SIMULATION_FILES` from the full `PLANT_FILES`; the simulator's run header hashes `simulationSections(config)` only, so `configSha256` and `events.sha256` of the golden week are unchanged, and a test asserts that the hash ignores `oee`.

**Conventions for the two callers** (#117 simulator ground truth, #120 MES):

- **`StopPiece.wholeMs` of an open stop** is the interval's length up to the caller's cut-off: on the MES side the equipment's "final through" time, on the simulator side the ground-truth snapshot time. The two cut-offs differ, so a provisional bucket (an open stop below the threshold, or a bucket not yet final) may differ between the two sides; only final buckets are reconciled.
- **One consistent read on the MES side.** `bucketTotals` refuses inputs whose stop pieces don't sum to the Stopped time. The MES must therefore read `stateMs` and the stop pieces from one snapshot (one `REPEATABLE READ` transaction), or derive Stopped ms from the pieces it read; otherwise a concurrent interval update between two reads can make the check throw.

**Reference cases.** `docs/oee-reference-cases.md` holds hand-calculated cases (inputs, step-by-step arithmetic, exact fractions and four-decimal values); `oee-core`'s tests parse that file, so the documentation and the tests can't disagree.

This closes the micro-stop part of the plan section 12 open decision. The automatic downtime classification rules are added to this ADR by #119.

### Consequences

- Good: the simulator and the MES share one pure implementation and one configuration, so a difference between them can only come from data; results are exact and reproducible to the last digit.
- Good: changing the threshold rewrites no stored row and leaves golden event logs untouched.
- Bad: callers convert fractions for display themselves; BigInt values need care at JSON and SQL boundaries (sums arrive as `numeric` and are parsed to BigInt).
- Bad: hourly P > 1 and negative speed loss look odd on a dashboard; the UI must explain them (cycles credited at completion).
- Bad: shared definitions mean the reconciliation can't catch a definition bug; the hand-calculated reference cases and the property tests are the guard.
