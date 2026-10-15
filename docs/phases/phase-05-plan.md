# Phase 05 – OEE and downtime: plan

Planned 2026-10-16. Plan reference:

- section 1: v1 success criterion 3;
- section 4: ground truth computed with `oee-core`;
- section 5: data path 2;
- section 7: modules master-data, equipment, oee and realtime; OEE definitions; state-to-loss mapping; data model;
- section 8: module rules;
- section 9: tests and OEE reference cases;
- section 11 row 5;
- section 12: the open decision on the micro-stop threshold and auto-classification.

Size: L. Milestone: [Phase 05 – OEE and downtime](https://github.com/kubilayture/shopfloor-twin/milestone/6).

## Scope

The MES computes OEE and explains its losses:

- **`oee-core`**: availability, performance, quality and OEE per machine and per work center, over an hour or a shift bucket, in exact arithmetic. Hand-calculated reference cases in `docs/oee-reference-cases.md` drive its tests.
- **Interval finality** (#113): every piece knows whether it can still change, so a finished bucket's OEE is final.
- **Aggregates:** TimescaleDB continuous aggregates of state time and cycle counts per hour; shift totals come from them.
- **Downtime:** a reason-code tree in master data, automatic coding from the machine's cause, and operator coding with splits and an audit trail. These are the MES's first writes.
- **Ground truth:** the simulator computes the same OEE inputs with `oee-core` and the same configuration (plan section 4).
- **API, push and web:** OEE and downtime endpoints, live OEE updates, an OEE dashboard (work center and machine, shift and hour, loss waterfall, downtime Pareto) and a downtime coding screen.

Out of scope here:

- alarm lifecycle, shift reports and handover notes (Phase 6);
- orders, the order-based scheduled-time rule and per-order OEE (Phase 7);
- users, roles and login: `identity` comes in Phase 7 (plan section 11 row 7). The Phase 4 plan's "Phase 9 security" referred to the hardening in row 9; the master plan's row 7 governs. Until then writes are guarded, not authenticated;
- retention and compression (the ADR-0018 note) and the `prom-client` successor (the ADR-0012 follow-up), both carried.

## Decisions made in this plan

### OEE definitions (`oee-core`, ADR-0021)

- **Inputs per (equipment, device epoch, bucket):**
  - time per state, in integer ms;
  - Stopped intervals with their whole length;
  - cycle counts per (product, result);
  - the ideal cycle time per (product, operation), in integer ms. Plant-config refuses ideal times that aren't whole milliseconds.
- **Planned busy time (PBT):** time in a shift bucket in any state except PlannedStop, Maintenance and Off.
  - The `no-shift` bucket is never scheduled, so its PBT is 0. This is the plan's "every shift is scheduled" rule for Phases 1–6, written as one switch, `scheduledTime: shift-calendar`; Phase 7 switches it.
  - Breaks are excluded by state, not by calendar. The simulator puts every machine into PlannedStop for the break, except Setup, Down and Maintenance, which continue. So a breakdown repaired during a break is availability loss, as plan section 7 wants for Down.
  - All Maintenance is excluded. The only Maintenance in the plant is the planned leak-test calibration; unplanned work is Down.
- **Actual production time (APT):** Running, plus Stopped intervals shorter than the micro-stop threshold.
- **Losses:**
  - availability, own: Stopped at or above the threshold, Down, Setup, Idle;
  - availability, external: Starved and Blocked;
  - performance: micro-stops, plus speed loss (APT − micro-stops − ideal time; it can be negative);
  - quality: from counts.
- **Micro-stop threshold:** 120 s, set in `config/plant/oee.yaml`. The file is new; `plant-config` loads and validates it, and both the simulator and the MES read it. This closes the open decision in plan section 12.
  - The threshold applies to the whole Stopped interval, not to a piece. Each piece is still credited to its own hour.
  - An open Stopped interval counts as a micro-stop provisionally, until it reaches the threshold or closes.
  - Down is never a micro-stop.
- **Performance:** Σ over products of (ideal ms of the product at this equipment's operation × produced count), divided by APT.
  - Produced means good + scrap + rework cycles on that machine.
  - A cycle belongs to the bucket that contains its `sourceTime` (buckets are half-open).
  - Performance is **not clamped**. At hour granularity a cycle is credited when it completes, so P > 1 is possible and correct. Plan section 9's property therefore becomes: A and Q lie in [0, 1], and P ≥ 0.
- **Quality:** good / produced, as first-pass yield. A leak-test `rework` at LKT-01 is produced but not good. ASM-01's reassembly of a reworked part is a good cycle of ASM-01.
- **Exact arithmetic:**
  - All inputs are integers (ms and counts).
  - Results are reduced BigInt fractions `{ num, den }`.
  - OEE = A × P × Q = (ideal ms × good) / (PBT × produced); APT cancels.
  - Display values are rounded half-up to four decimals with integer arithmetic only.
  - No floating point is used anywhere, so "matches exactly" holds for both the fraction and its four-decimal string.
- **Edge cases:**
  - PBT = 0 (no-shift, or a whole break): A, P, Q and OEE are `null` ("not applicable"), never 0.
  - APT = 0: P is `null`.
  - Produced = 0: Q is `null`.
  - PBT > 0 and nothing produced: OEE is 0.
  - Counts > 0 with APT = 0: P is `null` and an `anomaly` flag is set.
- **Partial and provisional buckets:** a bucket in progress is computed up to the equipment's "final through" time (below) and returned with `final: false` and `provisionalMs`. A bucket is final when:
  - every member piece is final;
  - no Stopped interval in it is still being classified;
  - both aggregates have been refreshed through its end.
- **Work centers (Cell M1, Line A1):** computed from the sums of their machines' inputs: ΣAPT/ΣPBT, Σideal/ΣAPT and Σgood/Σproduced. That is exact, but it is a time-weighted aggregate, not a line-throughput OEE. The dashboard marks the bottleneck (ASM-01) beside it (plan section 7). A throughput-based line OEE waits for orders (Phase 7).
- **Epochs:** OEE is computed per device epoch, like the intervals. The API defaults to the newest epoch.
- **Reference cases:** `docs/oee-reference-cases.md` is a table of at least 12 cases: inputs, step-by-step arithmetic, and expected fractions and four-decimal values. The tests parse this same table. The cases cover:
  - mixed products;
  - a micro-stop exactly at the threshold, one ms below it, and one across an hour;
  - Down during a break;
  - rework;
  - zero PBT;
  - P > 1;
  - a work-center aggregate.

  Property tests with fast-check check that buckets sum to the shift, that A and Q lie in [0, 1], and that OEE = A·P·Q. Coverage floor: 95 / 90.

### Interval finality first (#113)

- **Equipment "final through":** per (equipment, device epoch), the latest `sourceTime` of a device fact whose `seq` has no open gap below it.
  - A gap already reported as an incident counts as resolved; the bucket then carries `incidents > 0`.
  - A closed epoch is final everywhere.
- **Finality per piece:** a piece is stored final when it ends at or before that time, or when its interval is closed. `shiftTotals` then reports `provisionalMs = 0` for completed buckets, and the reconciliation drops Phase 4's "totals stable" workaround.
- **Silent machines:** a machine that sends no facts (Off over the weekend) keeps its last bucket provisional until its next fact. Only `no-shift` buckets are affected, and their OEE is null anyway.
- This issue comes before any OEE code. ADR-0018 is updated.

### Storage and aggregation (ADR-0022)

- **Ownership (ADR-0016):** a module reads only its own schema, so each aggregate lives with its data.
  - `equipment.state_hourly`: a continuous aggregate over `equipment_state_interval`, grouped by (equipment, epoch, `time_bucket('1 hour', start_time)`, shift_key, state). It stores ms and provisional ms. Pieces are whole milliseconds, and a test asserts that.
  - `ingest.cycle_hourly`: a continuous aggregate over `ingest.equipment_event` where `event_type = 'cycle'`, grouped by (equipment, epoch, hour, product, result), with a count.
  - The `oee` module owns **no tables** in Phase 5. OEE is computed on read from these aggregates through the modules' interfaces. It is never stored, so it can't go stale.
  - This deviates from the names in master plan section 7 (`oee_hourly`/`oee_shift` and a `production_count` hypertable owned by `oee`): a shift can't be a `time_bucket`, and modules don't read other schemas.
- **Shift buckets:** shift totals are the hourly rows grouped by `shift_key`; there is no second aggregate. Cycles carry no `shift_key`, so plant-config requires shift starts and ends on whole hours. That holds for 06/14/22 in Istanbul (UTC+3), and it means each hour lies in one shift bucket. Breaks may still start at any minute.
- **Micro-stops** are not stored in the aggregate, because the threshold is OEE configuration. `Equipment.stopIntervals(range)` returns Stopped pieces with their interval's whole length (a few rows per hour), and `oee-core` classifies them. Changing the threshold rewrites no stored row.
- **Real-time, refreshed explicitly:**
  - Both aggregates use `materialized_only = false`, so the open hour is read from the raw pieces.
  - The OEE module calls `refresh_continuous_aggregate` for an hour when equipment reports it final, and again when a late fact or cycle changes an hour already refreshed. Equipment emits `piecesChanged`; ingest gets a new `cycle` notice.
  - Refreshes are debounced to 1 s of wall time. They run off ingest's acknowledgement path, on their own connection and outside a transaction, as TimescaleDB requires.
  - At start-up the MES does a one-time catch-up refresh.
  - **No refresh policies:** `add_continuous_aggregate_policy` windows are relative to wall-clock `now()`. Simulation time runs ahead of wall time (at 60×, a wall day is two simulated months) and moves back under a new epoch, so a policy would never materialise the right range.
- **Migrations:** the continuous aggregates are created `WITH NO DATA`, with `-- migrate:no-transaction` if TimescaleDB refuses them inside a transaction. Kysely types and `DECLARED_COLUMNS` include them.
- **Data model:** the generator (`apps/mes-server/src/db/data-model.ts`) learns views and continuous aggregates (definition, bucket, `materialized_only`), and its drift test covers them.

### Downtime reason coding (ADR-0021 for the rules, ADR-0023 for writes)

- **Reason tree:** `config/plant/reasons.yaml`, seeded into `master_data.reason_code`. Each code has an id, a parent, a name and a loss category: availability-own, availability-external, performance or planned. The groups are:
  - BREAKDOWN (one child per failure code);
  - MINOR-STOP (one per stop cause);
  - SETUP (CHANGEOVER, TOOL-CHANGE);
  - ORGANISATION (NO-OPERATOR, NO-SCHEDULE);
  - MATERIAL;
  - STARVED and BLOCKED;
  - PLANNED (BREAK, CALIBRATION, SHIFT-END);
  - UNCODED.
- **Auto-rules** live in the same file, as an ordered list of (state, cause exact or prefix) → reason. The first match wins, and no match gives UNCODED. Examples:
  - `Down` + `SPINDLE-OVERLOAD` → BREAKDOWN/SPINDLE-OVERLOAD;
  - `Setup` + prefix `CHANGEOVER ` → SETUP/CHANGEOVER;
  - `Starved` + prefix `MATERIAL:` → MATERIAL.

  A cross-check refuses rules that name unknown reasons, and every cause the simulator can produce (`failures.yaml`, the Modbus cause table) must be covered.

- **Downtime records** (`equipment.downtime_record`, derived and rebuilt together with the intervals):
  - one record per availability-loss interval in a shift bucket, keyed (equipment, epoch, interval_start);
  - each record holds its end (null while open), state, cause, auto reason and a `provisional` flag;
  - a Stopped interval becomes a record once it reaches the threshold;
  - micro-stops are not records; they appear in the loss view by cause.
- **Operator coding** (`equipment.downtime_coding`): time ranges [from, to) inside a record, each with a reason, comment, `coded_by` and version.
  - A split is simply two codings; time without a coding keeps the auto reason.
  - Codings are stored by time, not by interval identity, so they survive when a late fact re-cuts an interval.
  - A coding that no longer lies inside a loss interval is flagged `orphaned` and audited.
- **Audit:** `equipment.downtime_audit` is append-only, recording action, before, after, actor, wall time and request id. It moves to `identity`'s audit log when that module arrives in Phase 7.
- **Reason codes never change A, P or Q.** Whether availability loss is own or external follows the state (plan section 7), so coding can't break the reconciliation; it changes the Pareto and the reason view. Plan section 9's example e2e ("operator codes a downtime, supervisor sees OEE change") is therefore read as "sees the loss attribution change".
- **Writes before identity (ADR-0023):** every non-GET request under `/api/v1` needs:
  - an allowed `Host` (the existing check);
  - an `Origin` that is **present** and same-origin or allowlisted (browsers always send it on POST and PUT; tests and curl must set it);
  - `Sec-Fetch-Site: same-origin`, when that header is present;
  - `Content-Type: application/json`, otherwise 415. A cross-site form or other simple request therefore never reaches a handler.

  On top of that:
  - no CORS headers;
  - a 16 KiB body limit and a per-client rate limit;
  - optimistic concurrency: a `version` field, with 409 on conflict;
  - `coded_by` is free text, recorded as unauthenticated.

  Compose keeps MES and web on 127.0.0.1, and nginx passes only GET, POST, PUT and DELETE under `/api/`. `MES_WRITES=off` turns every write into a 405.

### Ground truth and reconciliation

- **Simulator:** `GroundTruth` computes, per machine and shift bucket, using `oee-core` and `config/plant/oee.yaml`:
  - PBT, APT and micro-stop ms;
  - own and external availability loss;
  - cycles per (product, result), and ideal ms;
  - the A, P, Q and OEE fractions.

  Cycles are bucketed by time with `shiftKeyAt`, not by the current shift event, so a cycle exactly at a boundary lands where the MES puts it. Stopped intervals are held until they close, then classified. The summary format becomes `sim-summary/2` and the control API 1.2 (`/ground-truth`). `golden/week-01/summary.json` is regenerated in that PR with a written reason. `events.sha256` must not change, which proves the simulation itself didn't.

  Known limit: ground truth and MES share `oee-core` and the calendar, so the reconciliation can't catch a definition bug. The reference cases cover that.

- **Golden week** (`end to end` job): for every machine and both work centers, in all 15 shifts, the OEE inputs (integer ms and counts) and the four fractions equal the ground truth exactly. This holds both in order and shuffled with 10 % duplicates. The `no-shift` bucket's OEE is null on both sides. For every bucket, Σ hours = shift, both from the aggregates and from the raw pieces.
- **Live** (`pnpm test:reconcile`, CI `reconcile`): after shift A, `GET /api/v1/shifts/2026-10-12/A/oee` equals the live ground truth exactly, with `final: true` and `provisionalMs: 0`.

### API, push and web

- **Read endpoints:**
  - `GET /oee?scope=equipment|work-center&id&bucket=hour|shift&from&to[&epoch]`: buckets with inputs, fractions, four-decimal strings, losses, `final`, `provisionalMs` and `incidents`;
  - `GET /shifts/{date}/{shift}/oee`;
  - `GET /shifts?from&to` and `GET /shifts/current`: shift instances are computed on the server, because the browser has no Temporal (a Phase 4 deviation);
  - `GET /reason-codes`;
  - `GET /downtime?equipment&from&to&uncoded`;
  - `GET /downtime/pareto?scope&id&from&to`.
- **Write endpoints:**
  - `PUT /downtime/{id}/coding`, with segments, comment, `codedBy` and `version`; the id is `{equipment}~{epoch}~{startMs}`;
  - `GET /downtime/{id}/audit`.
- The OpenAPI document is regenerated with its drift test, and the zod schemas live in `@shopfloor/contracts/mes-api`.
- **Push:**
  - a WebSocket channel `oee` sends the current hour and shift buckets per subscribed equipment or work center, at most one delta per key per second;
  - a `downtime` channel sends created, closed and coded records.
- **Web:**
  - **`/oee` dashboard:**
    - work-center cards: OEE, A, P and Q, availability split into own and external, with the bottleneck marked;
    - a machine table for the selected shift and an hourly bar chart;
    - a loss waterfall: PBT → own → external → APT → micro-stops → speed → quality → fully productive. With a product mix, the quality step is ideal ms × (1 − Q), so the bars add up to OEE × PBT exactly;
    - a downtime Pareto.
  - **`/downtime` coding screen:** uncoded records first, a reason picker over the tree, split at a time, and the history from the audit. The operator's name is kept in `localStorage`.
  - Charts use Apache ECharts (plan section 6), tree-shaken from `echarts/core`, with a line in `dependencies.md`. They are checked in a browser under the existing CSP, as #99 did for uPlot.

## Issues, in dependency order

| #                                                                | Task                                                                                                                                                                                                                             | Depends on       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| [#115](https://github.com/kubilayture/shopfloor-twin/issues/115) | Phase 5 plan (this document)                                                                                                                                                                                                     | –                |
| [#113](https://github.com/kubilayture/shopfloor-twin/issues/113) | Interval finality per piece and per-equipment "final through"; `provisionalMs = 0` for completed buckets; ADR-0018 and the shift reconciliation updated                                                                          | #115             |
| [#116](https://github.com/kubilayture/shopfloor-twin/issues/116) | `oee-core`: OEE, losses, exact fractions and four-decimal rounding; `config/plant/oee.yaml` in `plant-config` (threshold, scheduled-time rule, whole-hour shifts, whole-ms ideal times); `docs/oee-reference-cases.md`; ADR-0021 | #115             |
| [#117](https://github.com/kubilayture/shopfloor-twin/issues/117) | Simulator ground truth with `oee-core`: OEE inputs per machine and shift, cycles by time; `sim-summary/2`, control API 1.2; golden summary regenerated (events hash unchanged)                                                   | #116             |
| [#118](https://github.com/kubilayture/shopfloor-twin/issues/118) | Aggregates `equipment.state_hourly` and `ingest.cycle_hourly`; ingest `cycle` notice, `piecesChanged`, explicit refresh off the acknowledgement path; data-model generator for views and aggregates; ADR-0022                    | #113, #116       |
| [#119](https://github.com/kubilayture/shopfloor-twin/issues/119) | Reason codes and downtime records: `reasons.yaml` seeded into `master_data.reason_code`, auto-rules with a coverage cross-check, `equipment.downtime_record`                                                                     | #113, #116       |
| [#120](https://github.com/kubilayture/shopfloor-twin/issues/120) | `oee` module and read API: OEE per bucket, work centers, shifts list and current shift, downtime list and Pareto, WebSocket `oee` and `downtime`; golden-week OEE reconciliation                                                 | #117, #118, #119 |
| [#121](https://github.com/kubilayture/shopfloor-twin/issues/121) | Downtime coding writes: coding, splits, audit, write guards (Origin, content type, `Sec-Fetch-Site`, `MES_WRITES`), nginx methods; ADR-0023                                                                                      | #120             |
| [#122](https://github.com/kubilayture/shopfloor-twin/issues/122) | Web: OEE dashboard (cards, hourly bars, waterfall, Pareto) and downtime coding screen, live                                                                                                                                      | #120, #121       |
| [#123](https://github.com/kubilayture/shopfloor-twin/issues/123) | End to end: shift A OEE reconciled live and final; Playwright: dashboard equals API, updates within 2 s; a recode and split through the UI change the Pareto and the audit, not OEE                                              | #117, #120, #122 |
| [#124](https://github.com/kubilayture/shopfloor-twin/issues/124) | Close Phase 5: report, learning notes, data model, tag                                                                                                                                                                           | all              |

## Exit criteria (plan section 11)

1. **Reference cases:** every case in `docs/oee-reference-cases.md` passes, both as an exact fraction and as a four-decimal value. There are at least 12 cases, including mixed products, threshold ±1 ms, Down during a break, rework, zero PBT and P > 1. `oee-core` coverage is at least 95 / 90.
2. **Golden scenario:** for every machine and both work centers, in all 15 shifts of the golden week, the MES's OEE inputs and its A, P, Q and OEE equal the simulator's ground truth exactly, and therefore also to four decimals. This holds both in order and shuffled with duplicates. Hourly aggregate rows sum to the shift totals and equal the raw pieces.
3. **Live reconciliation:** shift A runs at 60× through simulator → gateway → broker → MES. It ends final (`provisionalMs = 0`), and its OEE equals the live ground truth exactly for all six machines. The CI job `reconcile` stays within its budget.
4. **Downtime coding:**
   - every availability-loss interval of the golden week has a record;
   - every simulator cause is matched by an auto-rule, so the golden week has no UNCODED record;
   - an operator recode and a split, through both the API and the UI, are audited, change the Pareto and leave OEE unchanged;
   - writes are refused with a foreign `Origin` (403), without an `Origin` (403) and with a form content type (415), in tests and in the stack smoke.
5. **Dashboard live:** Playwright sees the dashboard show the API's shift values, and sees an OEE change within 2 s at 60×.

## Risks for this phase

| Risk                                                                                                              | Response                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase size L, with the first writes and two new screens                                                           | #113 and `oee-core` first; strict dependency order; ECharts only for the Pareto and the waterfall                                             |
| Aggregates read stale after a late change (real-time aggregation adds raw data only above the materialised range) | Explicit refresh on `piecesChanged` and on cycle notices; `final` only after the refresh; tests with late and reordered facts after a refresh |
| Wall-clock refresh policies don't fit simulation time                                                             | No policies; refreshes driven by simulation-time finality; ADR-0022                                                                           |
| Ground truth and MES share `oee-core`, so the reconciliation can't catch a definition bug                         | Reference cases from a hand-written table, plus property tests                                                                                |
| The golden summary changes carelessly                                                                             | One PR regenerates it with a written reason; `events.sha256` must stay identical                                                              |
| Unauthenticated writes (CSRF, DNS rebinding) before identity (Phase 7)                                            | Host allowlist, Origin required, JSON only, no CORS, loopback ports, `MES_WRITES=off`; audited as unauthenticated                             |
| ECharts under the strict CSP                                                                                      | Checked in a browser in #122; uPlot or SVG as the fallback                                                                                    |
| With a product mix, the waterfall disagrees with OEE                                                              | Quality step = ideal × (1 − Q), so the bars sum exactly                                                                                       |
| BigInt and `numeric` values from PostgreSQL sums                                                                  | Parsed to BigInt at the module boundary; a test with week-sized sums                                                                          |

## Deviations from the master plan

- **Aggregate names and ownership** (section 7): there are no `oee_hourly`/`oee_shift` aggregates and no `production_count` hypertable owned by `oee`. The aggregates live in the schemas of their data, and OEE is computed on read (see Storage).
- **Section 9 OEE property:** only A and Q are bounded by 1; P ≥ 0, because cycles are credited when they complete.
- **Section 9 e2e example:** coding a downtime changes the loss attribution, not OEE.
- **Section 7 "Maintenance (planned)":** all Maintenance is planned in this plant; unplanned work is Down.
