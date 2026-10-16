# Phase 06 – Alarms and shifts: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-16

- Phase 6 planned: issues #138–#148, milestone "Phase 06 – Alarms and shifts".
- Merged #149 (#138): Phase 6 plan, revised twice after review (failure injection only in `Running` and held otherwise, revisions over every hour a late fact can change, old-epoch anchors and snapshots, lost clears closed by resync snapshots).
- #139: `@shopfloor/alarm-core` and the alarm definitions (ADR-0024; ADR-0005 amended).
  - The KPIs per bucket and scope as the plan defines them, in integers and `oee-core`'s BigInt fractions; `exactnessRules` now covers `alarm-core`. A bucket is any range on whole UTC hours, so a shift or a `no-shift` stretch is computed directly or composed from its hours; a property test checks that both agree for every field.
  - `docs/alarm-kpi-reference-cases.md` has 20 cases covering every case in exit criterion 1, recomputed by an independent brute-force Python script (it counts the window at every candidate instant, without the sweep the code uses) before the TypeScript ran; both agreed on the first run. The tests parse the six tables (occurrences, horizons, buckets, episodes, bad actors, revised hours); changing one digit fails a test.
  - The purity rule now lets a pure package import another pure package by its exact name; `alarm-core` imports `oee-core`. A subpath, `plant-config`, `contracts`, an app or a Node.js built-in is still refused (tested).
  - `config/plant/alarms.yaml` is loaded by `plant-config` outside `SIMULATION_FILES`. The simulator's hash test changes thresholds, definitions and positions and still gets the golden summary's `configSha256`; `pnpm test:golden` is byte-identical.
  - `alarmVocabulary` in `@shopfloor/contracts` lists what the plant can raise; the simulator now imports its calibration alarm constants from there.
  - Deviation (strengthening): the plan's revision rule for a late raise is [t, t + max(window)] plus its active span. `revisionSpans` also covers an earlier open occurrence of the same point that the late raise now supersedes, and every flood episode in flood during [t, t + window] to its end, because a late raise can join two episodes and change the id and peak of every later hour of the joined one (reference case 20). For a late clear the span runs from the raise to the later of the two ends, so the hours after the clear that showed the occurrence active are revised too (case 19), not only the raise→clear span.
  - Deviation: a flood episode's id is `{startAt}~{equipment}~{seq}`; the plan's (start, seq) needs the equipment because `seq` is per device. Raises in one millisecond on different devices are ordered by `seq`, then equipment and code.
  - Decisions the plan left open, recorded in ADR-0024: at one instant the raises that leave the window go before the raises that arrive, and the flood state is the count after both, so an episode goes on when its last counted raise leaves as another arrives; a superseded or epoch-ended occurrence is never fleeting; an open raise is undecided while raise + `fleetingMs` − 1 > `asOf`; in a closed epoch a running flood ends at the close.
  - `analysisConfigSha256` belongs to #140 (`sim-summary/3`), not here.
