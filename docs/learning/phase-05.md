# Phase 05 – OEE and downtime: learning notes

Phase 5 turned the stored state intervals into OEE and explained the losses. Its parts:

- `oee-core` computes availability, performance, quality and OEE exactly;
- the MES aggregates time and cycles per hour in TimescaleDB;
- downtime is classified automatically and can be recoded by an operator through guarded, audited writes;
- a dashboard shows it all live.

These notes explain the ideas and give a reading order, questions _with full answers_ and an exercise. They are reference material; the learning step is optional, as in earlier phases.

## 1. Concepts

### OEE and its three factors

**Overall equipment effectiveness** (OEE, ISO 22400-2) answers: of the time we planned to produce, how much produced good parts at ideal speed? It is the product of three factors:

- **Availability (A)** = actual production time (APT) / planned busy time (PBT). This is the share of planned time the machine was producing.
- **Performance (P)** = ideal time / APT. This is how fast it produced while producing. Ideal time is Σ over products of (ideal cycle time × produced count).
- **Quality (Q)** = good / produced: first-pass yield.

So OEE = A × P × Q. Written as one fraction, APT cancels: OEE = (ideal × good) / (PBT × produced).

In this plant (ADR-0021):

- PBT is the time in every state except PlannedStop, Maintenance and Off. The `no-shift` bucket is never scheduled, so its PBT is 0.
- Breaks are excluded by state, not by calendar. Machines go to PlannedStop for the break, except Setup, Down and Maintenance, which carry on. So a breakdown repaired during a break is still availability loss.

### The loss mapping

Each state inside PBT lands in exactly one loss:

| State                           | Counts as | Loss                                            |
| ------------------------------- | --------- | ----------------------------------------------- |
| Running                         | APT       | speed loss if slower than ideal                 |
| Stopped, whole interval < 120 s | APT       | performance: micro-stop                         |
| Stopped, whole interval ≥ 120 s | –         | availability, own                               |
| Down, Setup, Idle               | –         | availability, own                               |
| Starved, Blocked                | –         | availability, external (upstream or downstream) |
| PlannedStop, Maintenance, Off   | excluded  | none                                            |

Because each piece of time goes to exactly one place, the losses add up: PBT = APT + own + external, and APT = micro-stops + speed loss + ideal time. With quality loss = ideal × (1 − Q), the waterfall ends at OEE × PBT, the "fully productive time". This holds exactly, also with a product mix.

A worked hour (CNC, ideal cycle 240 s) shows it:

- **States:** Running 3,300 s, a 60-s Stopped interval, Down 240 s.
- **Cycles:** 12 good, 1 scrap.
- **Times:** PBT 3,600 s; APT = 3,300 + 60 = 3,360 s; ideal = 13 × 240 = 3,120 s.
- **Factors:** A = 3,360/3,600 = 14/15; P = 3,120/3,360 = 13/14; Q = 12/13.
- **OEE** = 14/15 × 13/14 × 12/13 = 4/5.
- **Waterfall:** 3,600 − 240 (own) = 3,360; − 60 (micro) − 180 (speed) = 3,120; − 240 (quality, 3,120 × 1/13) = 2,880 = 4/5 × 3,600.

### Exact arithmetic: integers, BigInt fractions, half-up rounding

The simulator and the MES must agree "exactly, and therefore to four decimals". Floating point can't promise that. Two programs that add the same values in a different order can differ in the last bit. A tie such as 0.80125 isn't representable in binary either, so rounding it can go either way.

`oee-core` therefore works like this:

- **Inputs:** only integers (milliseconds and counts).
- **Results:** reduced `{ num, den }` BigInt fractions.
- **Display values:** rounded with integer arithmetic only. To round to four places, compute num × 10⁴ ÷ den as an integer quotient and remainder. Round up when 2 × remainder ≥ den. The sign is applied afterwards, so a tie rounds away from zero ("half-up"). Example: 1/32 = 0.03125. 10,000 ÷ 32 = 312 remainder 16, and 2 × 16 = 32 ≥ 32, so the result is 0.0313.
- **No floating point at all:** an ESLint rule (`exactnessRules`) forbids `Math.*`, decimal literals, `/`, `parseFloat` and `toFixed` in `oee-core`. The one BigInt division sits behind a commented exemption.

### Undefined ratios are `null`, not 0

- **PBT = 0** (no-shift, or an hour of break and calibration): A, P, Q, OEE and every loss are `null`, because nothing was planned, so nothing was lost.
- **APT = 0:** P is `null`. If cycles were nevertheless counted, OEE is `null` too and `anomaly` is set.
- **Produced = 0 with PBT > 0:** Q is `null` but OEE is 0, because planned time produced nothing good.

The dashboard shows `n/a`, never 0, for `null`. A 0 would claim a loss that didn't happen.

### Micro-stop classification

A Stopped interval is a **micro-stop** (performance loss) when its **whole** length is below 120 s (`config/plant/oee.yaml`). Otherwise it is availability loss.

- The threshold applies to the interval, not to the piece in a bucket, so a 3-minute stop across an hour boundary isn't two "micro-stops". Each piece is still credited to its own hour.
- An open stop below the threshold counts as a micro-stop **provisionally**. It can only grow, so once it reaches 120 s it is a long stop for good.
- Down is never a micro-stop, however short.
- The stored aggregates hold no micro-stop column. The MES reads Stopped pieces with their whole interval's length, and `oee-core` classifies them. Changing the threshold therefore rewrites no stored row.

### Why performance is not clamped

A cycle is credited to the bucket that contains its completion time (`sourceTime`). In an hour where the machine ran only part of the time, a cycle that started in the previous hour still finishes in this one. So the ideal time credited can exceed APT, and P > 1. That is correct at hour granularity.

Clamping P to 1 would have three effects:

- it would drop real ideal time, so the hours would no longer sum to the shift;
- the waterfall would stop adding up (speed loss would have to be negative to close it);
- OEE would no longer equal the closed form (ideal × good) / (PBT × produced).

Over a whole shift the effect averages out. The plan's property is therefore "A and Q in [0, 1], P ≥ 0".

### TimescaleDB continuous aggregates

A **continuous aggregate** is a materialised view over a hypertable, grouped by `time_bucket`, that TimescaleDB keeps up to date incrementally. Phase 5 has two:

- `equipment.state_hourly`: ms per state per machine, epoch, UTC hour and shift bucket;
- `ingest.cycle_hourly`: cycles per machine, epoch, hour, product and result.

Four mechanisms matter:

- **Watermark.** Each aggregate has one watermark: the end of the last materialised bucket that had data. It never moves back.
- **Real-time aggregation** (`materialized_only = false`). A query reads materialised rows below the watermark and computes rows above it from the raw table, so the open hour is always current without a refresh.
- **Invalidation.** A change to the raw table below the _invalidation threshold_ (a value set by the refresh windows, separate from the watermark) is recorded in an invalidation log, but the view keeps showing the old materialised value until a refresh covers that range. A refresh then re-materialises the invalidated parts of its window below that threshold, and the part of its window above the threshold in full. A refresh after a new epoch five days back took 3 ms; materialising the whole week took 81 ms.
- **Refresh outside transactions.** `CALL refresh_continuous_aggregate(...)` commits internally, so it can't run inside a transaction block. The MES runs it on its own small pool, from a timer, never on ingest's acknowledgement path.

The trap the plan review found: refreshing a later hour moves the watermark past earlier hours that were never refreshed. Those hours then vanish from the view, because they are below the watermark and not materialised. So does any later change below it.

The MES therefore marks every change below the watermark dirty, including a new epoch whose simulation time lies earlier. Each refresh covers one contiguous window, from the earliest dirty hour to `max(latest dirty hour + 1 h, end of the latest final hour)`, debounced to 1 s. A one-time catch-up runs at start-up. There are no refresh policies: their windows follow wall-clock `now()`, while simulation time runs at 60× and goes back under a new epoch (ADR-0022).

### Finality and revisions

A bucket's OEE is only worth reconciling once it can't change any more. For each machine and device epoch, the MES keeps a **"final through"** time: the latest time of the machine's own device facts with no open sequence gap below them.

- A piece that ends at or before "final through" is final.
- A gap that was reported as an incident counts as closed.
- A closed epoch is final everywhere.

A bucket is `final` when four things hold:

- every piece in it is final;
- both aggregates have been refreshed through it;
- no open stop in it is still counted as a micro-stop;
- every member machine has reached its last hour.

A late fill can still arrive after an incident released finality, because ADR-0017 stores late facts. When such a fill changes an hour that was already final, the hour's **revision** goes up (`equipment.bucket_finality`). The API reports `revision` and `incidents`, so a report can tell a revised value from an unchanged one.

### Reason codes, auto-rules and the cause vocabulary

- **Causes.** The simulator gives each non-Running state a **cause**, such as `SPINDLE-OVERLOAD`, `MATERIAL:<id>` or `CHANGEOVER VB-100→VB-200`. All causes are defined in one **vocabulary** in `@shopfloor/contracts`, used by the simulator, the Modbus table and the checks.
- **Reasons.** `config/plant/reasons.yaml` holds a tree of **reasons** (BREAKDOWN, MINOR-STOP, SETUP, ORGANISATION, MATERIAL, STARVED, BLOCKED, PLANNED, UNCODED) and an ordered list of **rules**, (state, cause pattern) → reason.
- **Rule matching.** A pattern is exact, `{prefix}`, `null` (no cause) or `{any}`. The first match wins, and no match gives UNCODED, so an unknown cause is coded by a person rather than hidden in a fallback. Every loss state has a `null` fallback, because live OPC UA and Modbus snapshots open intervals without a cause.
- **Cross-check.** `plant-config` enumerates the vocabulary concretely (every changeover pair, every material) and refuses a configuration that leaves any pair UNCODED. A new failure code without a rule therefore fails at load, not in a week's data.
- **No loss category on reasons.** A reason names the cause; the loss category follows the state and the micro-stop rule. So coding never changes A, P or Q.

### Downtime records and operator coding

- **Records** (`equipment.downtime_record`). There is one record per availability-loss interval per scheduled shift bucket. It is keyed by (equipment, epoch, the later of the interval's start and the bucket's start), because Setup, Down and Maintenance can span a shift end. Records are derived from the same pieces, in the same statement, so they can't drift from the intervals.
- **Codings.** An operator's codings are time ranges [from, to) with a reason, stored by time, not by record identity. They survive when a late fact re-cuts the intervals and the records are rebuilt.
- **Re-cuts.** After a re-cut, codings are clipped to the loss time they still cover; the rest is kept as `orphaned` and audited.

### Optimistic concurrency and an append-only audit

**Optimistic concurrency.** Two screens may edit at once. Instead of locking while a person thinks, each write sends the `version` it read. The server compares it under a row lock and answers 409 if it changed. The version belongs to the coding set of an (equipment, epoch), not to a record, because records are rebuilt and would reset it. A clip raises it too, so a screen holding codings that no longer exist is refused instead of overwriting them blindly.

**The audit.** `equipment.downtime_audit` records action, before, after, actor, wall time and request id. A trigger refuses UPDATE, DELETE and TRUNCATE. A `REVOKE` wouldn't do, because the MES connects as the table's owner, and an owner can do anything to its table, including disabling the trigger. Separate roles come in Phases 7 and 9.

### Writes before identity: CSRF and DNS rebinding

Until users and login arrive (Phase 7), any page in a browser on the machine is a potential attacker. Two attacks matter:

- **CSRF:** a page on `evil.example` submits a form, or calls `fetch`, to `http://localhost:8080/api/...`, and the browser sends it.
- **DNS rebinding:** `evil.example` resolves to 127.0.0.1 after loading, so its requests look same-origin.

The guards (ADR-0023), in order, are:

1. an allowed `Host` (stops rebinding, because the request still says `Host: evil.example`);
2. `MES_WRITES=off` → 405;
3. an `Origin` that is present and same host and port, or allowlisted, else 403. Browsers always send `Origin` on POST, PUT and DELETE, and a page can't remove or forge it;
4. `Sec-Fetch-Site: same-origin` when sent;
5. `application/json`, else 415.

For the coding route, which is a PUT, the method already forces a CORS preflight: an HTML form can't send PUT, and a cross-origin PUT is never a simple request. The 415 is defence in depth for POST (which nginx and the write guard allow) and for any future write a form could send: a cross-site form or `text/plain` fetch is a "simple request" that the browser sends without asking first, and with JSON required it never reaches a handler. A JSON request from another origin needs a CORS preflight, and the MES sends no CORS headers, so the browser never sends it.

Two further guards follow: a 16 KiB body limit and one global rate limit. The limit is global because behind nginx every request comes from nginx, and `X-Forwarded-For` can be forged.

### CSP and charting libraries

The web's Content Security Policy has `style-src 'self'`, with no `unsafe-inline`.

- **What CSP blocks.** It refuses inline `style="…"` attributes that arrive through HTML parsing (`innerHTML`), but not styles set through the CSSOM (`element.style.x = …`); `setAttribute('style', …)` is blocked like the parsed attribute.
- **ECharts.** Its HTML tooltip builds its markup as a string with `style` attributes and assigns it through `innerHTML`, so the CSP would refuse it. Its canvas tooltip (`renderMode: 'richText'`) draws on the canvas instead.
- **How to check a library.** Render it under the real header with a `securitypolicyviolation` listener and watch for violations, as #135 did. Reading the documentation isn't enough.
- **Bundle size.** ECharts is tree-shaken from `echarts/core` (bar, grid, legend, tooltip, canvas) and loaded lazily, so the overview doesn't pay for it.

### Reconciliation against an independent ground truth, and its blind spot

The simulator's ground truth computes the same OEE from its own events, so the reconciliation is one equality per bucket. This proves the whole data path: ingest, intervals, finality, aggregates, the read path and the API. Any lost, doubled or mis-bucketed millisecond or cycle shows.

It can't prove the **definitions**, because both sides call the same `oee-core` with the same configuration. A wrong formula would be wrong on both sides and still "equal". Three things guard the definitions instead:

- the hand-calculated reference cases in `docs/oee-reference-cases.md`, whose tables the tests parse;
- property tests (bounds, A·P·Q, loss identities);
- in reviews, Python recomputes from the raw event log that share no code with the project.

### Adversarial testing of a latency judge

The dashboard check judges each change of the API's shift OEE: within 2 s, the page must show that value or a later one. A judge that only ever sees honest pages proves little, so the review built pages designed to fool it. They included:

- a frozen page;
- pages updating every 1.9 s and every 3 s;
- pages lagging 2.1 s and 2.5 s;
- a page off by 0.0001;
- a page with five decimals.

One slipped through. The OEE changes about twice a second, but the push sends once a second, so the judge accepts page values the 100-ms polls never saw (`observed`). A page 4 s late that mixed in such unseen values passed. Value floors now bound the option: at most 5 % unseen values, 95 % agreement with API snapshots, and an agreeing snapshot per card. A minimum number of page transitions catches a frozen page.

## 2. Reading order

| #   | File                                                                                                     | Look for                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `docs/adr/0021-oee-definitions-exact-arithmetic-and-micro-stops.md`                                      | PBT, APT, the loss table, edge cases, the two amendments                       |
| 2   | `docs/oee-reference-cases.md`                                                                            | The three tables, and cases 3, 4, 8, 12 and 17 worked by hand                  |
| 3   | `packages/oee-core/src/fraction.ts`, then `oee.ts`                                                       | `roundHalfUp`; `bucketTotals`, `oeeFromTotals`, `workCenterOee`                |
| 4   | `config/plant/oee.yaml`, `config/plant/reasons.yaml`                                                     | The threshold; the reason tree and rules with their `null` fallbacks           |
| 5   | `db/migrations/0006_equipment_ingest_hourly_aggregates.sql`                                              | The two continuous aggregates, `WITH NO DATA`, `materialized_only = false`     |
| 6   | `docs/adr/0022-hourly-aggregates-refreshed-explicitly.md`, `apps/mes-server/src/db/aggregate-refresh.ts` | Dirty hours, the contiguous window, `isRefreshed`                              |
| 7   | `apps/mes-server/src/modules/equipment/downtime.ts`, `coding.ts`                                         | Records cut with the pieces; codings by time, clipping, the version, the audit |
| 8   | `apps/mes-server/src/modules/oee/oee.ts`                                                                 | One REPEATABLE READ snapshot, `final`, work centers, epochs                    |
| 9   | `docs/adr/0023-guarded-writes-before-identity.md`, `apps/mes-server/src/modules/realtime/realtime.ts`    | The guard order and its answers                                                |
| 10  | `apps/web/src/screens/downtime-coding.tsx`, `apps/web/src/chart/oee-options.ts`                          | The draft's starting version; the waterfall from exact fractions               |
| 11  | `e2e/src/latency.ts`, `e2e/browser/oee-live.spec.ts`                                                     | `judgeLatency` with `observed`, `pageValueProblems`                            |

## 3. Questions, with answers

**1. Why is OEE computed from integer milliseconds and BigInt fractions instead of doubles with a small tolerance?**

The criterion is equality to four decimals between two programs. With doubles, a different summation order can change the last bit. A value on a rounding tie (…5 exactly) may be stored just below or above it, so two programs can print different fourth decimals. A tolerance would also hide real errors of a millisecond or one cycle. With integer inputs and exact fractions, equality is decidable and the four-decimal string follows deterministically from the fraction.

**2. Round 0.80125 and −0.80125 to four decimals the way `oee-core` does.**

0.80125 = 641/800. Scaled: 641 × 10⁴ = 6,410,000, and 6,410,000 ÷ 800 = 8,012 remainder 400. Since 2 × 400 = 800 ≥ 800, it rounds up to 8,013, giving 0.8013. For −0.80125 the magnitude is rounded the same way and the sign applied afterwards, giving −0.8013. Half-up means a tie goes away from zero. (Losses such as speed loss can be negative, so the sign rule matters.)

**3. A machine is Stopped from 09:59:00 to 10:01:30. Is that a micro-stop, and where does its time go?**

Its whole length is 150 s, at or above the 120-s threshold, so it is availability loss (own), not a micro-stop. Its 60-s piece is credited to the 09:00 hour and its 90-s piece to the 10:00 hour, each as availability loss. Judged per piece, both would wrongly have been micro-stops.

**4. The same stop is still open at 10:00:30 when the dashboard reads. How is it shown?**

So far it is 90 s long, below the threshold, so it counts as a micro-stop **provisionally**. The bucket is not final, and the result carries `provisional`. At 10:01:00 it reaches 120 s and becomes a long stop for good, since an open stop can only grow.

**5. An hour shows P = 1.0667. Bug or not?**

Not necessarily. A cycle is credited to the bucket where it completes. If the machine was down for half the hour and then finished cycles that had started earlier, the ideal time credited can exceed the APT. Over the shift it evens out. Clamping would break Σ hours = shift, the waterfall and the closed form of OEE. A bug would show as P > 1 over a whole shift, or as an `anomaly`.

**6. Why is PBT = 0 reported as `null` OEE rather than 0, but "PBT > 0 and nothing produced" as 0?**

With PBT = 0 nothing was planned, so there is nothing to measure and no loss: "not applicable". With PBT > 0 and nothing produced, planned time existed and produced nothing good. That is a real total loss, so OEE is 0. Q alone is `null` there, because good/produced is 0/0.

**7. Why do work centers use the sums of their machines' inputs instead of the average of their OEE?**

An average gives a machine with one hour of PBT the same weight as one with eight. Summing PBT, APT, ideal time, good and produced gives a time-weighted, exact aggregate. It is still not line-throughput OEE, which would compare output with the bottleneck's ideal rate and needs orders (Phase 7). That is why the dashboard marks the bottleneck beside it.

**8. What is a continuous aggregate's watermark, and why did "just refresh the latest hour" lose data?**

The watermark is the end of the last materialised bucket with data. Below it, real-time queries read only materialised rows. Refreshing hour 14 when hours 10–13 were never materialised moves the watermark past them. A query then reads 10–13 from the (empty) materialisation instead of the raw table, so they disappear. A late change to hour 12 after a refresh is likewise invisible until a refresh covers hour 12. Hence the dirty hours and the contiguous window starting at the earliest dirty hour.

**9. Why are there no `add_continuous_aggregate_policy` refresh policies?**

A policy's window is relative to wall-clock `now()`, for example "from 3 hours ago to 1 hour ago". Simulation time runs 60 times faster than wall time and starts over at an earlier time under a new epoch, so the window would never sit on the hours that changed. The MES refreshes from its own knowledge of what changed and what is final.

**10. Why must the refresh run off ingest's acknowledgement path and outside a transaction?**

`refresh_continuous_aggregate` is a procedure that commits internally, so TimescaleDB refuses it inside a transaction block. It also takes time and locks. On the acknowledgement path it would delay every PUBACK and let the broker's queue grow. So it runs debounced, from a timer, on its own two-connection pool. Ingest only marks hours dirty, which is a set update.

**11. A gap was reported as an incident, the hour became final, and then the missing fact arrives. What happens?**

ADR-0017 stores the late fact; the window is recomputed, and the aggregates are marked dirty and refreshed. If the hour's pieces or a settled stop's class (micro or long) changed, its `revision` in `equipment.bucket_finality` goes up. The API reports the new revision with the incident, so a consumer knows the final value was revised. A fill that arrives within the grace period, before the hour was final, raises no revision.

**12. Why does the plant-config cross-check enumerate every changeover pair and material instead of trusting the `{prefix}` rules?**

A prefix rule can look complete and still miss a cause: a new cause family, or a typo in one rule. Enumerating the concrete vocabulary of the actual configuration and classifying each pair proves that none ends UNCODED. Changing the plant's products or failures without updating `reasons.yaml` then fails at load, not after a week of production.

**13. Why are codings stored by time instead of pointing at a downtime record's id?**

Records are derived data, rebuilt whenever a late fact re-cuts the intervals. An id-based coding would vanish or point at the wrong record after a rebuild. A time range stays meaningful: after the re-cut it is clipped to the loss time it still covers, and anything left over is kept as `orphaned` and audited.

**14. Two operators code different records of the same machine at the same moment. What do they see, and why is that acceptable?**

The version belongs to the (equipment, epoch) coding set, so the second write gets 409. The screen rereads the list and resets the form, and the operator saves again. It is acceptable because codings arrive at a few per minute, and a per-record version would reset on every rebuild of the records.

**15. Why does `Content-Type: application/json` (415 otherwise) matter as much as the Origin check?**

A cross-site `<form>` or a `text/plain` fetch is a "simple request": the browser sends it without a preflight, cookies and all, and only hides the response. Refusing any non-JSON write means such a request never reaches a handler. (The coding route is a PUT, which a form can't send and which always needs a preflight cross-origin; the 415 covers POST and future routes.) A JSON request from another origin needs a CORS preflight, which the MES never approves (no CORS headers), so the browser never sends it.

**16. The audit table has a trigger refusing UPDATE and DELETE. Why isn't that tamper-proof yet?**

The MES connects as the role that owns the table, and an owner can `ALTER TABLE … DISABLE TRIGGER`. The trigger only protects against the application's own code paths and mistakes. Tamper resistance needs the MES to write as a role that doesn't own its tables, which comes with identity and hardening (Phases 7 and 9).

**17. The golden week and the live shift equal the ground truth exactly. What kind of bug could still be in the OEE?**

A definition bug in `oee-core` or in shared configuration: for example a wrong state-to-loss mapping, or quality counting rework as good. Both sides use the same code and config, so both are equally wrong. The reference cases (hand calculation, checked with Python) and the property tests catch those. The reconciliation catches data-path bugs.

**18. Why did ECharts' default tooltip need replacing, while uPlot and React worked under the same CSP?**

The CSP forbids inline style attributes from parsed HTML. uPlot and React set styles through the DOM (`element.style`), which CSP allows. ECharts' HTML tooltip builds a string with `style="…"` and assigns it via `innerHTML`, which CSP refuses. The canvas tooltip (`renderMode: 'richText'`) avoids HTML entirely.

**19. How could a latency judge pass a dashboard that is 4 s behind, and what stops it now?**

The judge accepts a page value the API polls never saw, if the page took it after the change. That is needed because the page shows values the 100-ms polls miss. A lagging page that showed such unseen values could match changes it was really late for. Now the value floors fail it: at most 5 % of page values may be unseen (real runs: about 1 %), at least 95 % of 2-s snapshots must equal the API, and every card needs an agreeing snapshot. A frozen page fails the transition minimum.

**20. Why does the coding check in the reconcile run compare `GET /shifts/2026-10-12/A/oee` byte for byte, and only after the drain?**

Coding must never change OEE, and byte equality is the strongest form of "unchanged": every fraction, string, loss and flag. During the shift OEE changes by itself every second, so a before/after comparison would be meaningless. After the drain, with the simulator paused, the shift is final and fixed, so any difference can only come from the coding.

## 4. Hands-on exercise

Watch micro-stops, coding and the audit at work, on a disposable stack so that nothing is written into a database you keep.

1. Start a separate project: `COMPOSE_PROJECT_NAME=shopfloor-learn pnpm stack:up` (stop your normal stack first: the ports are the same). Open <http://localhost:8080/oee>.
2. Watch a work-center card for a minute. Note `Provisional` on the current shift, and how OEE moves about once a second.
3. See the reference cases drive the tests: in `docs/oee-reference-cases.md`, change one digit of case 4's expected OEE in the "Expected results" table and run `pnpm --filter @shopfloor/oee-core test`. Exactly that case fails, because the tests parse the document. Revert the change.
4. Open <http://localhost:8080/downtime>, pick a closed record, split it at a time and give the halves two reasons. Save. Open the dashboard's Pareto for that machine: the record's time moved to the new reasons, and OEE is unchanged.
5. Open a database shell: `docker compose -p shopfloor-learn exec db psql -U shopfloor shopfloor` (or `DB_USER` and `DB_NAME` from `.env`, if set). Run `SELECT action, actor, authenticated, request_id, at FROM equipment.downtime_audit ORDER BY id;`. Then try `DELETE FROM equipment.downtime_audit;`: the trigger refuses it.
6. Try a forged write: `curl -i -X PUT -H 'Origin: http://evil.example' -H 'Content-Type: application/json' -d '{}' http://localhost:8080/api/v1/downtime/x/coding` gives 403. Then drop the `Origin` header (403), and finally send `-H 'Origin: http://localhost:8080' -H 'Content-Type: application/x-www-form-urlencoded'` (415).
7. Remove everything: `COMPOSE_PROJECT_NAME=shopfloor-learn docker compose down --volumes`.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
