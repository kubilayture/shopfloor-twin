# Phase 05 – OEE and downtime: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-16

- Phase 5 planned: issues #113, #115–#124 and #126, milestone "Phase 05 – OEE and downtime".
- Merged #125 (#115): Phase 5 plan.
- #126: a CNC's changeover with no product loaded now gives cause `CHANGEOVER none→<product>`, not `CHANGEOVER undefined→<product>`; `none` is documented in `docs/simulation-model.md` and the OPC UA address-space contract. A unit test builds a CNC with an empty campaign list and loads a program.
  - Deviation: the plan expected the golden week to change. It doesn't: the schedule schema requires at least one campaign per CNC, and a CNC starts set up for its first one, so a validated plant never reaches the undefined path; the old cause only appeared with a hand-built config. The week's 35,764 event lines and `summary.json` are byte-identical (0 changed lines), so nothing was regenerated, and `events.sha256` `e7c6973678bbda868839fb35850b1475072b561fd89cc286a4f0827c009b740b` stays the baseline #117 must keep.
  - No other cause in the simulator is built from a possibly undefined value.
- #116: `oee-core` computes A, P, Q, OEE and their losses for a machine bucket and for a work center (sums of its machines' inputs), in reduced BigInt fractions with half-up four-decimal rounding in integers (ADR-0021).
  - `docs/oee-reference-cases.md` has 17 hand-calculated cases, also checked independently with Python's `fractions` before the code ran. The tests parse its three tables (inputs, totals, results); changing one digit in the document fails a test.
  - An ESLint rule (`exactnessRules`) keeps floating point out of `oee-core`: no `Math.*`, decimal or exponent literals, `/`, `parseFloat`, `toFixed` or negative powers. `hourCuts` lost its `Math.floor` for a floored remainder; the only bigint division is exempted in `fraction.ts`.
  - `config/plant/oee.yaml` (threshold 120 000 ms, `scheduledTime: shift-calendar`) is loaded by `plant-config`. The simulator's `configHash` now hashes `simulationSections(config)`, the eight files it hashed before, so the golden week's `configSha256` and `events.sha256` are unchanged; a test compares the hash with the golden summary's.
  - New cross-checks: shifts on whole hours, time zones with whole-hour offsets (checked over every transition from 1970 to 2100), ideal cycle times in whole milliseconds.
  - Beyond the issue: loss totals satisfy PBT = APT + own + external and APT = micro-stops + speed + ideal in every bucket (property-tested), and the quality loss closes the waterfall (ideal − quality loss = OEE × PBT). In an unscheduled bucket speed loss is −ideal, so the identities and the hour-to-shift sums hold there too.
  - Deviation: the plan's section 12 item named the threshold and the auto-classification rules together; only the threshold is closed here, the rules follow in #119.
