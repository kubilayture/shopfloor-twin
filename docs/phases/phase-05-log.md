# Phase 05 – OEE and downtime: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-16

- Phase 5 planned: issues #113, #115–#124 and #126, milestone "Phase 05 – OEE and downtime".
- Merged #125 (#115): Phase 5 plan.
- #126: a CNC's changeover with no product loaded now gives cause `CHANGEOVER none→<product>`, not `CHANGEOVER undefined→<product>`; `none` is documented in `docs/simulation-model.md` and the OPC UA address-space contract. A unit test builds a CNC with an empty campaign list and loads a program.
  - Deviation: the plan expected the golden week to change. It doesn't: the schedule schema requires at least one campaign per CNC, and a CNC starts set up for its first one, so a validated plant never reaches the undefined path; the old cause only appeared with a hand-built config. The week's 35,764 event lines and `summary.json` are byte-identical (0 changed lines), so nothing was regenerated, and `events.sha256` `e7c6973678bbda868839fb35850b1475072b561fd89cc286a4f0827c009b740b` stays the baseline #117 must keep.
  - No other cause in the simulator is built from a possibly undefined value.
- #116: `oee-core` computes A, P, Q, OEE and their losses for a machine bucket and for a work center (sums of its machines' inputs), in reduced BigInt fractions with half-up four-decimal rounding in integers (ADR-0021).
  - `docs/oee-reference-cases.md` has 19 hand-calculated cases, also checked independently with Python's `fractions` before the code ran. The tests parse its three tables (inputs, totals, results); changing one digit in the document fails a test.
  - An ESLint rule (`exactnessRules`) keeps floating point out of `oee-core`: no `Math.*`, decimal or exponent literals, `/`, `parseFloat`, `toFixed` or negative powers. `hourCuts` lost its `Math.floor` for a floored remainder; the only bigint division is exempted in `fraction.ts`.
  - `config/plant/oee.yaml` (threshold 120 000 ms, `scheduledTime: shift-calendar`) is loaded by `plant-config`. The simulator's `configHash` now hashes `simulationSections(config)`, the eight files it hashed before, so the golden week's `configSha256` and `events.sha256` are unchanged; a test compares the hash with the golden summary's.
  - New cross-checks: shifts on whole hours, time zones with whole-hour offsets (checked over every transition from 1970 to 2100), ideal cycle times in whole milliseconds.
  - Beyond the issue: in every bucket with PBT > 0 the losses satisfy PBT = APT + own + external and APT = micro-stops + speed + ideal (property-tested), and the quality loss closes the waterfall (ideal − quality loss = OEE × PBT).
  - Review (PR #128), adopted: cycles in an unscheduled bucket counted towards ideal, good and produced, so its speed and quality losses were non-zero while A, P, Q and OEE were null, and a day sum over shift and no-shift buckets would inflate P and OEE. Now every loss is `null` when PBT = 0, and off-shift cycles are reported apart as `unplanned` (good, produced, ideal ms), outside P and Q. Two reference cases added (cycles in a no-shift bucket; an open stop past the threshold that runs into the next hour). ADR-0021 also records, for #117 and #120, what `wholeMs` of an open stop means on each side and that the MES must read states and stop pieces from one snapshot.
  - Deviation: the plan's section 12 item named the threshold and the auto-classification rules together; only the threshold is closed here, the rules follow in #119.
