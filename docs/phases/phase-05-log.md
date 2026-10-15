# Phase 05 – OEE and downtime: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-16

- Phase 5 planned: issues #113, #115–#124 and #126, milestone "Phase 05 – OEE and downtime".
- Merged #125 (#115): Phase 5 plan.
- #126: a CNC's changeover with no product loaded now gives cause `CHANGEOVER none→<product>`, not `CHANGEOVER undefined→<product>`; `none` is documented in `docs/simulation-model.md` and the OPC UA address-space contract. A unit test builds a CNC with an empty campaign list and loads a program.
  - Deviation: the plan expected the golden week to change. It doesn't: the schedule schema requires at least one campaign per CNC, and a CNC starts set up for its first one, so a validated plant never reaches the undefined path; the old cause only appeared with a hand-built config. The week's 35,764 event lines and `summary.json` are byte-identical (0 changed lines), so nothing was regenerated, and `events.sha256` `e7c6973678bbda868839fb35850b1475072b561fd89cc286a4f0827c009b740b` stays the baseline #117 must keep.
  - No other cause in the simulator is built from a possibly undefined value.
