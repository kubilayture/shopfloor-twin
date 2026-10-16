# Golden scenarios

Each folder holds a scenario (`scenario.json`: seed, start, days, configuration and optionally `injections`) and its committed output: `summary.json` (the ground truth) and `events.sha256` (the SHA-256 and line count of the event log). `pnpm test:golden` reruns every scenario with the invariant checker on and fails on any byte difference; `pnpm test:golden --update` rewrites the files. Every regeneration needs a written reason here, in the changelog and in the phase log (plan section 9).

- `week-01`: the default plant, one production week from Monday 06:00 Istanbul (seed 20261012).
- `alarms-01` (#140): the same seed and start, two days, with 15 failure injections: a flood with a chattering point on Cell M1 from Monday 08:00, a fleeting alarm on LKT-01 and a standing alarm on PCK-01 (`docs/simulation-model.md`, "Invariants and golden scenarios"). Its event log equals `week-01`'s up to the first injection (695 events, tested); its header adds the injections.

## Regenerations of `week-01`

- #117 (Phase 5): `summary.json` regenerated for the new summary format `sim-summary/2`, which adds the `oee` section (ground-truth OEE inputs per machine, shift bucket and UTC hour; results per machine and work center and shift bucket). 39,404 lines added; the schema line is the only changed line, and every earlier field is byte-identical. `events.sha256` unchanged (`e7c6973678bbda868839fb35850b1475072b561fd89cc286a4f0827c009b740b`, 35,764 lines): the simulation itself did not change.
- #140 (Phase 6): `summary.json` regenerated for the summary format `sim-summary/3`, which adds the `alarms` section (the golden week's two alarm occurrences and the `alarm-core` KPIs per position and plant, per UTC hour and shift bucket, flood episodes and bad actors) and `analysisConfigSha256` (the hash of `oee.yaml`, `reasons.yaml` and `alarms.yaml`). 1,735 lines added; the schema line is the only changed line, and every earlier field is byte-identical. `events.sha256` unchanged (`e7c6973678bbda868839fb35850b1475072b561fd89cc286a4f0827c009b740b`, 35,764 lines): the simulation did not change, and a run header without injections has no `injections` field. A golden regeneration needs the owner's approval (master plan section 12); it is done under the owner's standing instruction of 2026-10-15 with this written reason, and the approval is recorded as deferred to the owner (Phase 6 plan).

## `alarms-01`

- #140: created (`events.sha256` `45e645695250f957742e50fed2c7af8131f831a158eded4aac2d7b6b9f4ab66a`, 5,332 lines).

Earlier changes are recorded in the changelog (#53, #73, #126).
