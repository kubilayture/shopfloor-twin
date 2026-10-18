# ADR-0021: OEE definitions, exact arithmetic and the micro-stop threshold

- Status: accepted; amended 2026-10-16 by #119 (automatic classification), #121 (operator coding) and #172 (the `orders` scheduled-time rule), below
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

**Unplanned cycles.** Cycles in an unscheduled bucket (`no-shift`) don't count towards the ideal time, good and produced totals that feed P and Q; they are reported apart as `unplanned` good, produced and ideal ms. So a sum over shift and no-shift buckets (a day, a week) keeps the shifts' P, Q, OEE and losses, and still shows that parts were made off shift. Cycles in a scheduled bucket whose PBT happens to be 0 (an hour of planned stop and calibration) stay planned, because they belong to the shift and its sum. At hour level they show in no ratio or loss (all are `null` there); they count in the shift's P and Q, like cycles that finish during a break.

Speed loss = APT − micro-stops − ideal time; it may be negative (P > 1). Quality loss = ideal time × (1 − Q), in ideal ms. So, in every bucket with PBT > 0, PBT = APT + own + external, APT = micro-stops + speed loss + ideal time, and ideal time − quality loss = OEE × PBT: a waterfall adds up exactly, also with a product mix.

**Work centers: (b).** ΣAPT/ΣPBT, Σideal/ΣAPT, Σgood/Σproduced: exact, time-weighted, each machine's ideal time from its own operation. It is not a line-throughput OEE; the dashboard marks the bottleneck (ASM-01) beside it. (c) waits for orders (Phase 7).

**Configuration: (b).** `config/plant/oee.yaml` holds `microStopThresholdMs` and `scheduledTime`; `plant-config` validates it (positive integer; `shift-calendar` was the only rule until Phase 7, which adds `orders`, see the amendment below) and cross-checks that shifts start and end on whole hours in a zone whose UTC offsets are whole hours (cycles carry no shift key, so each UTC hour must lie in one shift bucket). `plant-config` now separates `SIMULATION_FILES` from the full `PLANT_FILES`; the simulator's run header hashes `simulationSections(config)` only, so `configSha256` and `events.sha256` of the golden week are unchanged, and a test asserts that the hash ignores `oee`.

**Conventions for the two callers** (#117 simulator ground truth, #120 MES):

- **`StopPiece.wholeMs` of an open stop** is the interval's length up to the caller's cut-off: on the MES side the equipment's "final through" time, on the simulator side the ground-truth snapshot time. The two cut-offs differ, so a provisional bucket (an open stop below the threshold, or a bucket not yet final) may differ between the two sides; only final buckets are reconciled.
  - _Note (#120, after review):_ on the MES side a Stopped interval is open while it is its epoch's last, or while its end lies after "final through" (a later fact arrived before a missing one, so the end may still move earlier). Its `wholeMs` then runs to the earlier of its end and "final through", but never short of the piece itself (`bucketTotals` refuses a piece longer than its interval): a lower bound, so "long" is certain and "micro-stop" provisional, and a bucket holding such a provisional micro-stop is not final. When a late fill (after a gap incident released finality) moves a settled stop's end so that its class changes, the equipment module raises the revision of every final hour the stop touches, also hours before the late fact whose pieces stay the same. Only a class settled before the late fact arrived counts (its end at or before "final through" as it was then): a fill within the grace period completes a stop that was still provisional, so it revises nothing.
- **One consistent read on the MES side.** `bucketTotals` refuses inputs whose stop pieces don't sum to the Stopped time. The MES must therefore read `stateMs` and the stop pieces from one snapshot (one `REPEATABLE READ` transaction), or derive Stopped ms from the pieces it read; otherwise a concurrent interval update between two reads can make the check throw. _Note (#120):_ the MES does both: `Equipment.oeeInputs` reads the hourly rows and the stop pieces in one REPEATABLE READ snapshot, and the `oee` module takes each hour's Stopped time from the pieces it read, which also covers a materialised row that is stale until its refresh (such an hour is not final).

**Reference cases.** `docs/oee-reference-cases.md` holds hand-calculated cases (inputs, step-by-step arithmetic, exact fractions and four-decimal values); `oee-core`'s tests parse that file, so the documentation and the tests can't disagree.

This closes the micro-stop part of the plan section 12 open decision. The automatic downtime classification rules are added below (#119), which closes the rest of that decision.

### Consequences

- Good: the simulator and the MES share one pure implementation and one configuration, so a difference between them can only come from data; results are exact and reproducible to the last digit.
- Good: changing the threshold rewrites no stored row and leaves golden event logs untouched.
- Bad: callers convert fractions for display themselves; BigInt values need care at JSON and SQL boundaries (sums arrive as `numeric` and are parsed to BigInt).
- Bad: hourly P > 1 and negative speed loss look odd on a dashboard; the UI must explain them (cycles credited at completion).
- Bad: shared definitions mean the reconciliation can't catch a definition bug; the hand-calculated reference cases and the property tests are the guard.

## Amendment (#119): automatic classification and downtime records

The Phase 5 plan ("Downtime reason coding") fixes the reason tree, the rule form and the record key. Implementing it left these questions open: where the causes are defined, how the rules are written and checked, which time makes a record, and how records stay consistent with the intervals when those are recomputed.

### Decision

- **Cause vocabulary.** All causes are defined in `@shopfloor/contracts` (`causes.ts`): the fixed causes (`TOOL-CHANGE`, `CALIBRATION`, `SCHEDULE-COMPLETE`, `NO-OPERATOR`, `BREAK`, `SHIFT-END`) and the two parameterised forms (`MATERIAL:<id>` and `CHANGEOVER <from>→<to>`, with `none`). Failure codes and minor-stop causes still come from `failures.yaml`. The simulator emits these values, and its golden event log is byte-identical. `causeVocabulary` lists every (state, cause) pair a configuration can emit. The Modbus cause table uses the same constants.
- **Reasons** (`config/plant/reasons.yaml`, seeded into `master_data.reason_code`).
  - A reason's id is its path in the tree (`BREAKDOWN/SPINDLE-OVERLOAD`), and its parent is the path before the last `/`. Parents are listed first.
  - The groups are BREAKDOWN, MINOR-STOP, SETUP, ORGANISATION, MATERIAL, STARVED, BLOCKED, PLANNED and UNCODED. The first four each have an `UNSPECIFIED` child for a missing cause.
  - A reason has no loss category.
  - A reason the configuration drops stays in the table, marked inactive.
- **Rules.** The rules are an ordered list of `{ state, cause, reason }`. The cause pattern takes one of four forms:
  - a string, which matches that cause exactly;
  - `null`, which matches no cause;
  - `{ prefix }`;
  - `{ any: true }`.

  The first match wins, and no match gives UNCODED. A cause the plant does not know therefore stays UNCODED, so that someone codes it; it is not hidden in a fallback.

- **Cross-check** (`plant-config`). The cross-check refuses a configuration in these cases:
  - an id is duplicated;
  - a parent is not listed before its child;
  - UNCODED is missing;
  - a rule names an unknown reason;
  - a loss state (Stopped, Down, Setup, Idle, Starved, Blocked) has no rule for `null`, which live snapshots need;
  - a pair of the cause vocabulary would be UNCODED.

  A simulator test runs the golden week and checks that every emitted cause is in the vocabulary and every non-Running pair has a reason. `reasons.yaml` is not part of the simulator's config hash.

- **Records** (`equipment.downtime_record`).
  - There is one record per availability-loss interval per scheduled shift bucket. It is keyed by (equipment, epoch, start), where the start is the later of the interval's start and the bucket's start.
  - A record holds:
    - its end, which is null while the interval is open and this is the last stored bucket;
    - the interval's start and the bucket;
    - the state and cause;
    - the auto reason;
    - `provisional`.
  - Availability loss follows the loss table above. A Stopped interval counts from the threshold on, measured over its whole length (so far, if it is open). Because an open stop can only grow, a record made for it stays. Micro-stops, planned states and the `no-shift` bucket make no record, because nothing is planned there and so nothing is lost.
- **Derived with the intervals.**
  - Records are cut from the same pieces, in the same statement that stores those pieces. Each path stores the records of the whole intervals it replaces:
    - an in-order fact;
    - a window recompute after a late fact;
    - a tail rewrite as the watermark moves;
    - closing an epoch;
    - a full rebuild.

    The same paths delete the records of those intervals that no longer exist.

  - A record is provisional while it is open or while any of its pieces is (#113). It becomes final in the same statement that promotes its pieces, and start-up sets its flag together with theirs.
  - `interval_source.downtime_threshold_ms` records the threshold the records were derived with. Catch-up recomputes an (equipment, epoch) whose threshold differs, including every one stored before #119.
  - At start-up, records whose (state, cause) gets a different reason under the current rules are recoded in place.
- **Interface for #120.** `Equipment.downtimeRecords({ from, to, equipment?, epoch?, uncodedFirst?, limit? })` returns the records overlapping a range, each with its `loss` (own or external). `MasterData.reasonCodes()` returns the reason tree.

### Consequences

- Good: one definition of loss is shared by OEE and records (`availabilityLoss` in `oee-core`), so the downtime Pareto sums to the availability loss of OEE.
- Good: records cannot drift from the intervals. Reordering, duplicates, late facts and restarts give the same records, and the golden-week reconciliation checks this both in order and shuffled.
- Good: a new failure code, stop cause, product or material without a rule fails at configuration load, not in a week's data.
- Bad: an open stop becomes a record only at the next tail rewrite after it reaches the threshold, which is at most `provisionalStepMs` late.
- Bad: a breakdown on the weekend (`no-shift`) makes no record. It shows in the intervals only, until Phase 7 changes the scheduled-time rule.
- Bad: changing the threshold recomputes every (equipment, epoch) at the next start-up. That costs one pass over ingest's state facts.

## Amendment (#121): operator coding

The Phase 5 plan ("Downtime reason coding") fixes that codings are time ranges stored by time, that a split is two codings, and that a re-cut clips them. The writes themselves (guards, concurrency, audit) are ADR-0023. Implementing the rules left open how a coding relates to the records, what a record's reason is when it is split, and when clipping runs.

### Decision

- **Codings** (`equipment.downtime_coding`, migration `0009`) are ranges [from, to) of one (equipment, epoch), each with a reason (an active master-data reason, never UNCODED), a comment, `coded_by` and the coding set's version it was written at. A write names one record and replaces the codings inside it; every segment must lie in the record (an open record: up to its epoch's watermark), and segments must not overlap. Codings that are not orphaned never overlap, so every kept coding lies in exactly one record.
- **Reasons in effect.** Over a record, a coding's reason applies where a coding lies, the auto reason elsewhere. The record's `reason` is the one covering most of its time (the earliest on a tie); `segments` lists the reasons in effect by time. A record has "uncoded time" when its auto reason is UNCODED and codings don't cover it all; an open record never counts as covered, because it keeps growing under its auto reason. `uncoded=true` and the UNCODED-first order use this.
- **Pareto.** `Equipment.downtimeLoss` sums coded time under the coding's reason and the rest of each record under its auto reason, in SQL, still without a row limit; `records` counts the records with time under a reason, so a split record counts once under each of its reasons. The sums per own and external loss are unchanged by coding.
- **OEE never reads codings.** Availability, performance and quality follow the states (the loss table above), so a recode or a split changes the Pareto and the reason view and leaves every OEE input, ratio and loss as it was. A test checks the OEE answers byte for byte before and after.
- **Clipping after a re-cut.** The coding module follows `Equipment.onPiecesChanged`. About 100 ms after a change it locks the coding set of that (equipment, epoch), reads the codings within a day of the changed hours and the records they overlap, and cuts each coding by the records: the parts inside a record are kept (one coding per record), the rest is stored with `orphaned = true` and never applies again. Each clip is audited (`orphaned`, actor `system`) and raises the set's version. At start-up every coding set is clipped once, because the records may have changed while the MES was away. Between a re-cut and its clip, readers clip codings to the record they read, so no time is counted twice. A write reads its record `FOR SHARE`: a rebuild that re-cuts the record waits for the write to commit, so its clip always sees the new codings. A clip that fails is retried with exponential backoff (0.2 s doubling, at most 30 s).

### Consequences

- Good: codings survive every rebuild of the records (late facts, restarts, a threshold change), because nothing about them depends on a record's identity.
- Good: the Pareto and the coding screen read the same reasons in effect; OEE can't drift from the ground truth by coding.
- Bad: a re-cut that moves a loss interval later leaves the moved-in time under the auto reason, and the moved-out time orphaned; the operator codes it again (the audit shows what was lost).
- Bad: a clip may run up to about 100 ms after the re-cut; the audit's wall time shows the order.

## Amendment (#172): the `orders` scheduled-time rule

Master plan section 7 says that from Phase 7 "Idle without a dispatched order is excluded" from planned busy time. Phase 7 expresses this on device facts, so the ground truth and the MES apply it to the same intervals:

- **`scheduledTime: orders`** in `oee-core` (`SCHEDULED_TIME_RULES`) and `config/plant/oee.yaml`, which switches to it. Inside a scheduled bucket, the part of Idle with cause `NO-ORDER` (an orders-mode CNC with no startable job, ADR-0030) is excluded from planned busy time, like a planned stop: `BucketInput.noOrderIdleMs` (at most `stateMs.Idle`, 0 when left out) is subtracted from the planned Idle time. Everything else is as `shift-calendar`: `no-shift` is never scheduled, and `shift-calendar` ignores `noOrderIdleMs`.
- **Schedule-mode causes keep their meaning:** `SCHEDULE-COMPLETE` and `NO-OPERATOR` stay own availability loss. A schedule-mode run emits no `NO-ORDER`, so `week-01`'s and `alarms-01`'s OEE don't move (asserted: their summaries under both rules are equal but for the rule's name and `analysisConfigSha256`).
- **Downstream machines get no dispatch:** their `Starved` while no order runs stays an external availability loss (the dashboard's own/external split); per-order and throughput line OEE are Phase 8's. A known limit.
- **Ground truth:** the simulator keeps the `NO-ORDER` time per UTC hour and shift bucket from the state events' causes, as `noOrderIdleMs` of the bucket inputs (only when above 0, so schedule-mode summaries keep their bytes but for the rule's name).
- **MES:** its hourly aggregate `equipment.state_hourly` has no cause, so the MES passes no `noOrderIdleMs` yet and applies the rule from #175, where `orders-01`'s OEE is reconciled; until then only schedule-mode runs reach it, which have no `NO-ORDER` time, so its results are unchanged.
- **Reference cases** 20–25 in `docs/oee-reference-cases.md`: `NO-ORDER` inside a shift (and the same hour under `shift-calendar`), across an hour boundary, in `no-shift`, and `SCHEDULE-COMPLETE` and `NO-OPERATOR` unchanged.

### Note (#175): the MES applies the `orders` rule

- **OEE:** `Equipment.oeeInputs` also reads the Idle `NO-ORDER` milliseconds per (equipment, epoch, hour) from the stored pieces (which keep the cause; the hourly aggregate does not), in the same snapshot as the hourly rows, and the `oee` module passes them as `noOrderIdleMs` (at most the hour's Idle). `orders-01`'s OEE equals the ground truth per machine and work center, shift and hour (golden reconciliation).
- **Downtime records:** under `scheduledTime: orders` an Idle `NO-ORDER` interval is outside planned busy time, so it is no availability loss and makes no downtime record (`DowntimeRules.unplanned`); the Pareto of a shift still sums to its availability losses. Under `shift-calendar` it would be a `PLANNED/NO-ORDER` record as before. Schedule-mode runs have no `NO-ORDER`, so nothing changes for them.

## Note (#229): option (c) decided

The line-throughput OEE, option (c) of "Work centers", is decided in ADR-0036: good packed units × the bottleneck's effective cycle ÷ line planned busy time, with the bottleneck derived from the routing and an order OEE over job windows beside it. The work-center OEE of (b) stays as it is.
