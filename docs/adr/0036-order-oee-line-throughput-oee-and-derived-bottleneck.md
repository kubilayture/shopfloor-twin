# ADR-0036: Order OEE over job windows, line throughput OEE and a derived bottleneck

- Status: accepted
- Date: 2026-10-18
- Deciders: Claude (#229), within the Phase 9 plan ("Order and line OEE", open decisions, review rounds 1–3 and the final check); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Master plan section 7 asks for OEE "per order" from Phase 9, and ADR-0021 left the line-throughput OEE, its option (c), "until orders". Until now OEE exists per machine and per work center (time-weighted sums, ADR-0021 (b)); the bottleneck exists only as a web constant (`DESIGNED_BOTTLENECK = 'asm-01'`). The simulator's ground truth and the MES must compute order and line OEE identically from the same facts, so the definitions belong in `oee-core`, the pure, exact package both use. The questions:

- where the bottleneck comes from, without changing a golden: `oee.yaml` is hashed into every summary's `analysisConfigSha256`, the plant configuration into `configSha256` and every event log;
- what time an order owns, given that the CNC runs one job at a time but the downstream machines interleave both CNCs' orders;
- where a job's time starts, given that its changeover lies before its `started` fact (ADR-0030), and what happens when the fact that would say so is lost;
- how a line OEE is defined, and what happens when it exceeds 1;
- what quality an order reports, given that OP10's Q hides OP40's leak scrap.

## Considered options

1. **Bottleneck source:** (a) a key in `oee.yaml`; (b) a new configuration file; (c) derived in `oee-core` from the effective cycle (ideal cycle ÷ machines on the operation).
2. **Order OEE scope:** (a) every machine's time split between orders by their units; (b) the order's job windows on its CNCs from `started`; (c) the job windows from head time.
3. **Line OEE:** (a) ADR-0021's time-weighted sums; (b) good output against the bottleneck's ideal rate.
4. **Line OEE above 1:** (a) cap at 1; (b) report it with a flag.

## Decision outcome

Chosen: 1c, 2c, 3b and 4b.

### Bottleneck, derived (1c)

`deriveBottlenecks({ operations, equipment, idealCycleMs })` picks per product the operation with the largest **effective cycle**, its ideal cycle (`products.yaml`) ÷ the number of machines that run it (`plant.yaml`), ties to the earlier operation of the routing; the effective cycle is an exact fraction. OP10 runs on two CNCs: VB-100 OP10 240 s ÷ 2 = 120 s against OP30 150 s; VB-200 330 s ÷ 2 = 165 s against 210 s. So **ASM-01 for both products**, although OP10 has the largest raw cycle. It is the **designed** bottleneck and holds whatever the plant does: when only one CNC has work, the CNC is the actual constraint, and that shows as a lower line OEE, never as another bottleneck, so a bucket's ratio never changes what its numerator means (reference case L9). (a) changes `analysisConfigSha256` of every golden, (b) adds a file both sides must read for one fact the routing already implies. `apps/simulator/src/headless/config-hashes.test.ts` asserts both hashes unchanged for the four goldens (against the committed summaries and the pre-Phase-9 values) and that the derivation gives ASM-01 from each golden's configuration.

### Head time and job windows (2c)

- A job is the **head** of its CNC's queue from `max(its accepted fact, the previous job's completed fact on that CNC)` (`headTimes`, queue in acceptance order); both are job facts (ADR-0030) the ground truth and the MES see alike. The head time lies before the job's changeover and its `started` fact, so the changeover counts against the order that caused it. Idle `NO-ORDER` while a head job waits for its `notBefore` stays excluded from planned busy time (ADR-0021, `orders` rule).
- A lost `accepted` fact is replaced by the command result's `acceptedAt` (`uns.cmd-res/1`, the plant time of that same fact): the head time stays exact and the order can be final. If neither is known, or the previous job's `completed` fact is lost (or missing while this job has already started), the head time is **unknown** (`headTimeUnknown`): the window starts at the job's `started` fact, which leaves the changeover out, and the order's OEE is provisional and never final. A job whose predecessor has not completed and which has not started is `waiting` and has no window.
- The **job window** (`jobWindow`) runs from the head time to the job's `completed` fact, or to the caller's cut-off while open (`open`, provisional): final-through on the MES side, the snapshot time in the ground truth. A job whose own `completed` fact is lost stays open.
- **Why job windows:** the only time the plant attributes to one order without a rule of thumb. The CNC runs one job at a time; ASM-01's time split between two orders by units would need an allocation key the ground truth would have to invent. (b) would drop the changeover, which the order caused.

### Order OEE

`orderOee` applies the equipment rules (ADR-0021: loss table, whole-interval micro-stop threshold, `scheduledTime`) to the CNC's state intervals inside each window (`windowInputs` cuts them into a scheduled part, the shift buckets, and an unscheduled part, each an ordinary `BucketInput`; a Stopped interval keeps its whole length where the window cuts it) and sums the jobs' totals, time-weighted as a work center. Produced and good are the job's OP10 cycles, attributed by unit by the caller (ADR-0031); ideal time is the product's OP10 ideal cycle. A, P, Q and OEE are exact fractions with ADR-0021's edge cases; the result carries `open` and `headTimeUnknown`, and `provisional` is set by either or by a provisional micro-stop. Finality beyond that (every job fact, unit and machine final) is the caller's (ADR-0018, ADR-0031).

**First-pass yield across the routing** (`firstPassYield`) is reported beside it, never multiplied in: units packed good at the last operation with every record good (no rework, no retest) ÷ units started. The order OEE's Q sees only OP10; FPY shows OP40's leak scrap and rework.

### Line throughput OEE (3b, 4b)

- **Line OEE** = Σ good packed units × the bottleneck's effective cycle per product ÷ line planned busy time (`lineOee`), per hour, shift bucket or order. One ratio, no A × P × Q split; the dashboard keeps the per-machine waterfall beside it. Null when the planned busy time is 0.
- **Line planned busy time** (`linePlannedBusyMs`): the bucket's scheduled time (the shift buckets) minus planned stops (the calendar's breaks and planned maintenance on the bottleneck, given by the caller as ranges); in orders mode only where at least one order is **in progress**, from its first job's head time (so its changeover counts) to its completion (ADR-0031): the line's counterpart of Idle `NO-ORDER`. Overlapping orders count once.
- **Per order:** the same ratio over the order's in-progress time with its own good units. Orders overlap, so per-order line OEE is **not additive** (reference cases L3 and L4); screens and the API say so.
- **Above 1, not capped (4b):** a fast operator (`op-b1`, speed factor 0.95) or WIP drained from the buffers into a short bucket packs more than the bottleneck's ideal rate allows for the bucket's time. The value is reported as computed, flagged `aboveOne` (exactly 1 is not flagged). A cap would make the hours' sums disagree with their shift; a property test asserts that hours' planned busy time and ideal time sum to the shift's.
- ADR-0021's work-center OEE (a) stays as it is, beside the line OEE.

### Exactness and reference cases

Integers in, reduced BigInt fractions out, no floating point (the `exactnessRules` lint covers the new files). `docs/oee-reference-cases.md` gains cases B1–B4 (bottleneck: parallel machines, a tie, a fractional effective cycle), H1–H8 (head times and windows, including `acceptedAt`, a lost `completed` and `waiting`), O1–O9 (order OEE: one job, a changeover before `started`, two jobs on two CNCs, a shift boundary and a break, a micro-stop and a breakdown, a short order, `acceptedAt`, unknown head time, an open window), F1 (first-pass yield) and L1–L11 (line OEE: no order in progress, overlapping orders, per order not additive, rework packed in a later bucket, above 1 from a fast operator and from buffer drain, exactly 1, one CNC working, planned maintenance, outside the schedule), hand-calculated to four decimals; `order-line-reference-cases.test.ts` parses them.

### Consequences

- Good: the ground truth (P9-03) and the MES (P9-04, P9-05) share one definition, so a difference can only come from data; no golden event log, summary or configuration hash changes.
- Good: the changeover is charged to the order that caused it, from facts both sides see; a lost acceptance is recovered from the command path, and what can't be recovered is flagged, never guessed.
- Good: line OEE above 1 is explained rather than hidden, and buckets add up to their shift.
- Bad: an order whose head time stays unknown is never final; its OEE leaves out the changeover and looks better than it is (flagged).
- Bad: per-order line OEE is not additive across orders, and the order OEE covers only the CNC's time: downstream losses show in the line OEE and in first-pass yield, not in the order's A, P and Q.
- Bad: the designed bottleneck can understate a CNC-constrained bucket's performance against the CNC's own rate (by design: it is a lower line OEE, case L9).
- Bad: callers must pass planned stops (breaks and the bottleneck's planned maintenance) and in-progress ranges as ranges; both sides must derive them the same way, which the golden reconciliations (P9-04, P9-05) check.
