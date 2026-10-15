# Golden scenarios

Each folder holds a scenario (`scenario.json`: seed, start, days, configuration) and its committed output: `summary.json` (the ground truth) and `events.sha256` (the SHA-256 and line count of the event log). `pnpm test:golden` reruns every scenario with the invariant checker on and fails on any byte difference; `pnpm test:golden --update` rewrites the files. Every regeneration needs a written reason here, in the changelog and in the phase log (plan section 9).

## Regenerations of `week-01`

- #117 (Phase 5): `summary.json` regenerated for the new summary format `sim-summary/2`, which adds the `oee` section (ground-truth OEE inputs per machine, shift bucket and UTC hour; results per machine and work center and shift bucket). 39,404 lines added; the schema line is the only changed line, and every earlier field is byte-identical. `events.sha256` unchanged (`e7c6973678bbda868839fb35850b1475072b561fd89cc286a4f0827c009b740b`, 35,764 lines): the simulation itself did not change.

Earlier changes are recorded in the changelog (#53, #73, #126).
