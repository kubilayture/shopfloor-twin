# Phase 08 – Traceability and quality: learning notes

Phase 8 made every packed part traceable and put the leak test under statistical control. Its parts:

- lots and the ASM-01 operator as fields of the existing cycle facts, from the simulator through the gateway and the UNS to the MES;
- two pure packages: `spc-core` (control charts, limits, Nelson rules, episodes) and `trace-core` (lot attribution, the packing rule, the trace tree, the time cut `traceAsOf`);
- a ground truth for genealogy and SPC (`trace.json`) with counterfactual readings, and a golden scenario `quality-01` with small lots and an injected drift;
- the MES modules `genealogy` (lots, serial units, links, cartons, trace queries) and `quality` (SPC with frozen limit versions and signal episodes; quality holds with a close guard and ERP notifications);
- traceability, SPC and holds screens, and quality banners on the operator terminal;
- a third live reconcile pass and a trace performance test.

These notes explain the ideas behind them and give a reading order, questions _with full answers_ and an exercise. They are reference material; the learning step is optional, as in earlier phases.

## 1. Concepts

### Genealogy and the trace tree

Genealogy answers two questions a plant must answer after a complaint or a bad lot:

- **Backward** ("what is this part made of?"): from a serial to its blank lot, the component lots of each assembly pass, the machine of every operation and pass, the operator at assembly, the leak-test reading, the order and the carton.
- **Forward** ("where did this lot go?"): from a lot to every unit that consumed it, their orders and their cartons. For a component lot, also the other lots of the same units ("where used with"), so a suspect blank lot can be checked against a suspect seal-kit lot.

The data is a small graph with typed edges, `genealogy.genealogy_link`:

- **`lot → unit`**, one edge per lot reference of a cycle fact, with the operation, pass, machine, the fact's (equipment, epoch, seq), its place in the fact's list and the time;
- **`unit → carton`**, once the unit is packed.

The tree is only two levels deep (lots → units → cartons), so a trace is plain SQL over the edge table with an index per direction; no recursive query is needed. Probe P2 measured 0.02 ms backward and 3.6 ms for the largest lot forward on 66,000 edges; the closing trace-performance run measured both through HTTP and nginx (see the report).

**A unit is not a serial.** Units are keyed (device epoch, `partId`), as in Phase 7. The serial text is indexed but not unique, because the simulator's counter restarts with every run, so serials repeat across runs. A real line never reuses a DMC. Here a repeat raises `serial-reused` (once per pair of epochs), and the screens ask which unit is meant (ADR-0034).

**"Shipped" means in a closed carton.** The plant has no shipping step. The MES forms cartons by a rule, `trace-core`'s packing rule with `config/plant/packing.yaml` (VB-100: 20 per carton, VB-200: 12). An order's PCK-01 good cycles fill its cartons in plant-time order, a carton closes when full, and the order's last carton closes at the order's completion, so a short order has a partial carton. The simulator's ground truth applies the same function, so a difference between them points to a lost or distorted fact, never to two definitions.

### Lot consumption attribution

The simulator writes `material-consumed` events (machine, part, material, lot) when a cycle starts, first in first out per material. The plan had two ways to get them to the MES:

- (a) a new device event in the sequence, which moves every sequence number after it and so changes every golden event log;
- (b) fields on the cycle event the part already produces: `lots: [{ material, lot }]` and `operator`.

Phase 8 chose (b). One pure fold, `attachConsumption(events)` in `trace-core`, defines the rule: the `material-consumed` events of a part on a machine come before that part's `cycle-complete` there and attach to it; ASM-01's operator is the one at the cycle's **start** (the instant of the part's first `material-consumed` there), not at its end. The machine server (through `ConsumptionTracker`) and the MES's golden harness both use it, so they can't differ. The review of PR #214 showed that sharing the function is not enough for a test: a check built on the same `attachConsumption` as the messages can't catch a bug in it. The harness now derives its expectations from the raw events independently, and a mutation that takes the operator at the cycle's end fails it.

**Three values, not two.** A cycle's lots can be:

- absent (not reported: the Modbus washer, a gateway older than UNS contract 1.4, or a field ingest dropped);
- `[]` (reported: nothing consumed);
- a list.

The operator is likewise absent, `null` or a name. The distinction survives to the API and the screens ("Not reported", "None"), because "the machine said nothing" and "the machine said none" mean different things in an investigation. Ingest never refuses a cycle over its trace fields: it stores the cycle without them and records `trace-dropped`, because refusing the cycle would leave a gap in the device sequence over auxiliary data.

### Control charts: I-MR and X̄-R

A control chart separates **common-cause** variation (the process's own noise) from **special-cause** variation (something changed). It plots a statistic over time against a centre line and control limits about 3σ away. Control limits come from the process's own data; specification limits (here the leak test's 3.2 Pa/min) come from the customer. The two are unrelated: a process can be in control and still make bad parts.

- **I-MR (individuals and moving range)**, for one reading at a time: the moving range is |xᵢ − xᵢ₋₁|. The centre is the mean X̄ and the limits X̄ ± 2.66 · M̄R. 2.66 is 3/d₂, with d₂ = 1.128 for ranges of two. The MR chart's upper limit is 3.267 · M̄R (D₄ for n = 2).
- **X̄-R**, for subgroups of n = 5 consecutive readings: X̄̄ ± A₂ · R̄ with A₂ = 0.577, the R chart from D₃ · R̄ = 0 to D₄ · R̄ = 2.114 · R̄. σ is estimated as R̄ / d₂, d₂ = 2.326.

Why estimate σ from ranges and not from the standard deviation of all readings? A drift inflates the overall standard deviation and so widens the limits around itself. Short-term ranges measure only the noise between neighbours.

`spc-core` works in exact fractions on whole resolution steps (0.001 Pa/min). Floating point would let the simulator and the MES disagree in the last digit about a point lying exactly on a limit. `quality-01`'s version 1 shows this: the I chart's centre is `204799/100` steps (2.048 Pa/min) and its upper limit `6596597/1980` steps (3.332 Pa/min).

**SPC uses first-pass readings only.** A retest after rework comes from another population (a repaired part), and mixing the two inflates the variation. Retests are drawn on the chart as separate marks, never as points.

### Nelson rules and the false-alarm run length

Rule 1 alone (a point beyond 3σ) misses small shifts. Nelson's rules add patterns that are unlikely under pure noise:

| Rule | Pattern                                                    | Finds                       |
| ---- | ---------------------------------------------------------- | --------------------------- |
| 1    | one point beyond 3σ                                        | a large shift or an outlier |
| 2    | nine in a row on one side of the centre                    | a sustained small shift     |
| 3    | six in a row steadily rising or falling (ties end the run) | a trend                     |
| 4    | fourteen in a row alternating up and down                  | over-adjustment, two feeds  |
| 5    | two of three beyond 2σ on the same side                    | a medium shift              |
| 6    | four of five beyond 1σ on the same side                    | a small shift               |
| 7    | fifteen in a row within 1σ                                 | stratification              |
| 8    | eight in a row beyond 1σ on either side, none within       | a mixture                   |

Every rule added catches more real changes and raises more **false alarms**. The number that matters is the **run length**: how many readings a stable process produces before the first signal. For a normal process with rule 1 alone the probability per point is about 0.0027, so the average run length (ARL) is about 370 readings. With rules 2 and 5 added it is much shorter.

The phase measured it instead of assuming it (`pnpm --filter @shopfloor/spc-core false-alarm`, 4,000 simulated in-control runs, each with limits estimated from its own baseline). With the final defaults (rules 1, 2 and 5 on I and X̄, rule 1 on R, none on MR):

- about 13 new episodes per 1,000 readings, about 29 a week;
- a mean run length of about 125 readings after the baseline (median 76);
- a clean 60-reading window with probability 0.57;
- a +0.6 Pa/min drift detected within 20 readings with probability 0.99.

The run length varies widely because each run estimates its own limits: a tight baseline gives many signals, a wide one few. The plan's first defaults also had rule 1 on MR. The measurement showed that it nearly doubled the false episodes (22.9 per 1,000) and added nothing to detecting a mean shift, which moves I and X̄ but not the moving range, so PR #210 dropped it (ADR-0032).

### Signals as episodes, and their finality

A drift makes many consecutive points fire the same rule. Alarming on every point would bury the user. A signal is therefore an **episode**: it opens at the first point that triggers a rule on a chart, stays open while consecutive points keep triggering the same rule on the same chart, and closes at the chart's next point that doesn't continue it. It is keyed (characteristic, limit version, chart, rule, first triggering fact), pushed and acknowledged once.

The Phase 5–7 defect class applies here too: a point is placed by plant time, and a late reading inserts a point and moves every later moving range, subgroup and run. So points, subgroups and episodes are **derived** from the readings and re-derived when one arrives, never patched. An episode is:

- **provisional** until LKT-01 is final through its triggering point (every reading before it has arrived, or its gap was written off);
- **final in identity** after that, with respect to ordinary late facts: no reading that arrives in the normal way can change which chart, rule and first point it is. There are two exceptions: a late fact from a written-off gap (the reading the gap was assumed never to hold), and a limit version created or ended (the points are judged against other limits). In both cases the episode is **withdrawn** with its reason, never re-keyed, and whatever the re-derivation finds instead is a new episode;
- **final in extent** only with `extentFinal`: its last point and length still follow the readings until the tester is final through its closing point.

When a re-derivation no longer produces an episode, a provisional, unacknowledged one is removed; a final or acknowledged one is kept as `withdrawn` with the reason (in `derive.ts`'s `planSignals`: `WITHDRAWN_FINAL` for a late reading from a written-off gap, `WITHDRAWN_VERSION` for a limit version created or ended). An acknowledgement stays on its episode by key and is shown as orphaned if the episode is withdrawn. Nothing that a person has seen or acted on disappears silently.

The review of PR #220 found that the golden replays never exercised this. In order, nothing is ever missing; fully shuffled, the baseline stays open until the end. Two mutants ("every episode is final" and "final through final-through + 10") passed. A third replay with **bounded disorder** (windows of 30–60 facts shuffled and ticked in chunks, blocks held back) produced provisional episodes on many ticks (`week-01`: 168 of 525), and both mutants failed it.

### Frozen, versioned limits

Limits come from a **baseline**: the first 20 complete subgroups of 5 final first-pass readings (100 readings). Version 1 is estimated automatically (user `system`, audited) and then **frozen**. It is never re-derived, however many readings follow.

Recomputing limits on a rolling window seems more accurate, but it lets a drift hide in its own limits: as the mean moves up, the limits follow and the points stay inside. Frozen limits make a drift visible as it starts. Changing them is a person's decision:

- a `quality` user estimates a new version from a chosen window, or ends a version (`spc:limits`, audited, 409 on a stale version);
- a late reading inside version 1's baseline window doesn't touch version 1; it raises a `baseline-changed` notice, and quality decides whether to create version 2. The notice carries the SHA-256 of the re-estimate, so it doesn't come back after a restart once it was dealt with (review of PR #220, H1).

`quality.control_limit` is append-only: versions are `created` and `ended` events, folded into versions on read, because an end date can't be written into an append-only row. Baseline points are judged retroactively against version 1, and their episodes, the **baseline episodes**, appear when version 1 is created. They are shown but not latency-judged, since they can't exist before the limits do.

`quality-01`'s version 1 also shows the difference between control and specification: the I chart's upper control limit (3.332 Pa/min) lies above the specification limit (3.2). With σ = R̄/d₂ ≈ 0.432 Pa/min, Cpu = (3.2 − 2.048) / (3 · 0.432) ≈ 0.89, below the usual 1.33: the process is in control but not capable, which is why it scraps a part now and then.

### Counterfactual testing of a drift detector

Exit criterion 3 asked for more than "SPC signals after the drift". With about 13 false episodes per 1,000 readings, the probability of some signal within 20 readings with no drift at all is about 0.18. A test that only waits for a signal could pass on a false alarm.

The criterion asks that the drift, **and only the drift**, made the signal. The simulator can answer that because it knows the counterfactual. The drift adds `shift` to the reading in whole resolution steps after the random draw, so the reading without the drift is exactly the logged steps minus `shift/resolution`, for the readings between the `leak-drift` `applied` and `ended` lines. `trace.json` records, for 40 first-pass readings before the start and 20 after, both values. The test then requires:

1. the drifted readings open an episode within 20 readings of the start, equal to the truth's (point, chart, rule);
2. the counterfactual readings, with the same limits and the baseline points judged retroactively, open none in the 60-reading window. #208 made "clean" stricter: no rule fires on any chart at any counterfactual point.

In `quality-01` the drift (+0.6 Pa/min from 08:25Z to 10:50Z) starts at part 105; part 106 reads 3.381 Pa/min, beyond the I chart's 3.332 (rule 1, latency 2), while its counterfactual reading is 2.781, well inside. A search over drift starts (`drift-search.ts`) chose a start whose window is clean; the review added a negative case (a drift from 10:31Z has a counterfactual signal in its window). This is the same idea as a controlled experiment: same random draws, one change, compare.

### The contiguous processed watermark: `settledSeq`, not `receivedThrough`

The close guard of #201 must know that genealogy has processed every fact of an order's units; otherwise a link not yet written could hide a held lot in the order. It asks genealogy's **processed watermark** per machine and epoch: a sequence number such that every fact up to it has been handled.

Three candidates, from the device stream's progress:

- **The highest number seen.** Wrong: number 41 can arrive before 40, and 40 is not processed.
- **`receivedThrough`**: every number up to it has arrived. Safe, but a gap that is never filled (the fact is lost, and the sweep writes the gap off as an incident) stops it for the rest of the epoch. Every later close of an order on that machine would then be refused as `genealogy-pending` for ever. The first version of #199 did this (review of PR #219, H1).
- **`settledSeq`** (ADR-0018's final-through): contiguous over the numbers received **and the gaps written off**. It moves past a lost fact, as interval finality does.

Genealogy uses `settledSeq`. It is the progress that the execution round genealogy caught up with read before taking its facts, so it is contiguous by construction. Two corrections were needed on top:

- **A written-off number counts as settled, so a late fact of that gap is "covered" the moment ingest stores it,** before genealogy has rebuilt its unit. The reviewer of PR #222 reproduced an order closing beside a hold on the lot such a fact carried (probe PD). The guard now also requires every cycle fact of the order's units to be in genealogy's records (`Genealogy.unrecorded`).
- **A unit whose rebuild keeps failing** (a "poison" unit) must not let the watermark pass its facts. It goes to a retry set with backoff, and the watermark stays below its facts on each machine. Its order's close stays pending and visible (`rebuild-failed`), never wrong.

The command path of Phase 7 made the opposite choice, and for the opposite reason. Settling a command by `seqAfterExpiry` uses `receivedThrough`, because there the question is "is there **no** acceptance fact?", and a fact lost in a written-off gap might be exactly that acceptance. Genealogy's question is "has everything that arrived been processed?", which a lost fact can't falsify, and a late one is caught by `unrecorded`. Pick the watermark by what a missing fact would mean for the decision.

### The close-guard race: one advisory lock, scope at check time, unrecorded facts

A quality hold must stop its order from closing. Probe P2 reproduced the race of the obvious design. The close reads the derived `quality.hold_unit` at READ COMMITTED and sees no hold. A hold commits meanwhile. The order closes with a unit in an open hold. The final design has three parts (ADR-0035):

1. **One lock, taken first.** Opening a hold and closing an order both take one transaction-level advisory lock (`pg_advisory_xact_lock` on a fixed key) as the first thing in their transactions. Under READ COMMITTED every statement after the lock sees every hold committed before it. Row locks on `production_order` were rejected: a hold doesn't know which orders it affects until its scope is derived. Both writes are rare human actions, so one global lock costs nothing.
2. **Scope derived at check time.** After the lock, the guard derives each open hold's scope from its subject and the genealogy links in the close's own transaction. It never reads `hold_unit`, which is a read copy rebuilt every second and may lag.
3. **Genealogy has caught up.** Before that, the guard requires the processed watermark over every cycle fact of the order's units, taken from ingest (not from execution's records: a fact not yet in a record is exactly the one that matters), and each of those facts recorded by genealogy. Units neither module has built yet are found from the order's CNC job ranges. Otherwise it answers a retryable 409 `genealogy-pending` with `Retry-After`.

**Lock order and the in-process queue.** The orders module serializes its writes in an in-process queue (`#serial`). A close holds `#serial` and waits for the advisory lock; a hold's transaction holds the lock and writes its ERP notification through `Orders.enqueueErpMessage(trx, …)`. If that call took `#serial`, the two would deadlock across the database and the process. It doesn't: it only inserts into the outbox in the caller's transaction. A same-process test with a timeout pins this. The race itself is pinned by two-connection tests in both orders of arrival; each proves, through `pg_blocking_pids`, that one transaction really waited on the other, and each fails with the lock removed.

The guard **fails closed**: an orders module with no guard wired refuses every close, and the MES asserts at start that one is wired.

### Read progress before facts (#218)

A stress run of `orders.e2e` raised a `duplicate-job` incident once in eight runs under load. It was a real MES race. `Orders.#evaluate` read a command's job facts, then the CNC's progress, in two READ COMMITTED statements. Ingest commits a fact and its stream cursor in one transaction. When the acceptance fact committed between the two reads, the facts read missed it but the progress already counted its number as received. `#evaluate` concluded "received through `seqAfterExpiry`, no acceptance", settled the command `not-accepted` and persisted it; the next tick found the fact and raised `duplicate-job`. In production the same race could, run twice, allow a second job.

The fix reads **progress first, then facts**. Because a fact and its cursor commit together, every number the progress counts is visible to the later facts read. A late fact can then only make the progress look older than the facts, which is the safe direction: the judgement waits a tick.

The general rule, which Phases 5 to 7 kept relearning: **a judgement over several stores is only as consistent as the order of its reads. Read the bound (what settles) before the data it is checked against.** The race can't be caught reliably by an end-to-end test, since it needs a commit to land between two statements, so the regression test wraps ingest to store the fact inside the progress read. It fails with the old order and passes with the new one. After the fix the module audit found no other "facts, then progress" read.

### Mutation testing to find vacuous tests

A test passing shows the code does something the test accepts, not that the test would notice the code being wrong. Phase 7 learned to mutate the code under test; Phase 8's reviewers did it in almost every pull request:

- **#197:** an operator taken at the cycle's end passed the golden check, because the check reused the code under test. Fixed by deriving expectations from the raw events.
- **#200:** "every episode final" and "final-through + 10" survived the golden SPC replays, because neither replay put a final/provisional boundary under test. Fixed with bounded disorder.
- **#199:** removing the carton placement's sort, or the condition that a unit's order be final, must fail a test; both now do.
- **#201:** a scope that only looked at first passes passed until a test held a lot consumed at a rework pass (PC).
- **#212:** the widened terminal timing bound let the restored #190 stale-memo bug pass. Under load no end-to-end run could tell, so a clock-free test now pins the `onChange → memoized.clear()` wiring.
- **#204:** a lot answer with its `orders` emptied passed the live comparison. The reviewer's fake-MES harness now shows every new comparison failing on a wrong answer.

The practical rule: for each property a test claims to prove, name the smallest code change that breaks the property, make it, and watch the test fail. If it doesn't, the test is not evidence yet.

### Ephemeral test ports

Phase 8 ran many agents and worktrees on one machine, and their suites ran at the same time. The recurring gateway "flakes" (#212) and the simulator's (#216) were not timing noise but shared resources: fixed ports (control 7900, poller 8000, proxies 8291–8295, OPC UA offsets), fixed certificate folders that one suite wiped while another used them, and a readiness check that a foreign process on the same port could pass.

The fixes are general:

- **Bind what you need at run time.** `freePort` (listen on port 0, read the port, close) or, for the simulator's five OPC UA servers, a free block checked as a whole (`freeOffset`). The small window between choosing and binding is closed by retrying on `EADDRINUSE` with new ports.
- **Own your temporary state:** a `mkdtemp` folder per suite, removed in `finally`.
- **Ready means "my process said so":** the child's own log line plus its health answer, not "something answers on that port". For Mosquitto, a real MQTT CONNECT, because Docker's port forward accepts connections before the broker behind it does.
- **Wait for counts, not for time.** Replace fixed sleeps with waits on the event the test needs, and bound them by a deadline plus measured event-loop lag, never by a tighter constant.

Measured afterwards: the gateway suite passed 10 of 10 beside a looping MES e2e and 10 of 10 under eight busy processes, and the simulator suite 10 of 10 beside the MES e2e.

## 2. Reading order

| #   | File                                                                                                                                         | Look for                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `docs/phases/phase-08-plan.md`                                                                                                               | "Decisions made in this plan", exit criteria, the three review rounds          |
| 2   | `docs/adr/0033-traceability-facts-leak-drift-and-scenario-stock.md`, `packages/trace-core/src/consumption.ts`                                | Fields not events; the operator at the cycle's start; the drift in exact steps |
| 3   | `docs/spc-reference-cases.md`, `packages/spc-core/src/limits.ts`, `rules.ts`, `chart.ts`                                                     | Constants, limits by hand, every rule with its ties, episodes                  |
| 4   | `docs/adr/0032-spc-charts-frozen-limits-nelson-rules-and-episodes.md`                                                                        | The run-length table, the MR deviation, the MES amendment and probe P3         |
| 5   | `packages/trace-core/src/packing.ts`, `trace.ts`                                                                                             | The packing rule, backward and forward traces, `traceAsOf`                     |
| 6   | `apps/simulator/golden/README.md` (the #208 entry), `apps/simulator/golden/quality-01/trace.json` (`drifts`), `src/headless/drift-search.ts` | The counterfactual window and the search for a drift start                     |
| 7   | `docs/adr/0034-genealogy-serial-identity-cartons-by-rule-and-trace-finality.md`, `apps/mes-server/src/modules/genealogy/genealogy.ts`        | Units followed from execution, the retry set, the processed watermark, `final` |
| 8   | `apps/mes-server/src/modules/quality/quality.ts`, `derive.ts`                                                                                | Versions as events, provisional and final episodes, withdrawal, the ETag       |
| 9   | `docs/adr/0035-quality-holds-derived-scope-and-close-guard.md`, `apps/mes-server/src/modules/quality/holds.ts`                               | The close guard's three steps and the lock order                               |
| 10  | `apps/mes-server/src/quality-holds.test.ts`                                                                                                  | The two-connection race tests, the same-process test, PD and the poison unit   |
| 11  | `docs/adr/0029-command-path-at-least-once-with-device-dedup-and-settled-outcomes.md` ("Progress before facts"), `orders.test.ts` (#218 case) | Why the read order matters, and how the test forces the interleaving           |
| 12  | `packages/test-kit/src/ports.ts`, `apps/simulator/src/testing.ts`                                                                            | Runtime ports, the retry on `EADDRINUSE`, per-suite folders                    |
| 13  | `e2e/src/quality-pass.ts`, `e2e/src/trace-perf.ts`                                                                                           | The three-way comparison at 14:00; how the performance numbers are taken       |

## 3. Questions, with answers

**1. Why do lots travel as fields of the cycle event and not as a new `material-consumed` event in the device sequence?**

A new event in the sequence would take a sequence number, so every later number of that machine would move, every golden event log would change, and the golden snapshots of three earlier phases would need regeneration and the owner's approval. A field on the cycle event changes no number. It is also what a real station reports: "this part, at this station, consumed these lots". The (machine, `seq`, type) digest of a scripted shift, recorded before the change, proves no number moved.

**2. Why is ASM-01's operator taken at the cycle's start, not when the cycle completes?**

The person who assembled the part is the one at the station while the part was assembled. An operator change during a cycle (a shift change at 14:00 with a part in the station) would otherwise attribute the part to the incoming operator, who never touched it. The start is the instant of the part's first `material-consumed` at ASM-01, which the event stream has; a scripted collector test covers exactly that 14:00 shift change.

**3. A lot field is absent on a washer cycle, and `[]` on a packing cycle. Why keep both instead of treating both as "no lots"?**

They mean different things. `[]` says the machine reported and consumed nothing. Absent says nothing is known: the washer speaks Modbus and can't report lots, or the gateway is older than UNS 1.4, or ingest dropped a malformed field. A recall investigation that reads "absent" as "none" would wrongly clear a part. The screens show "None" and "Not reported".

**4. Why does ingest store a cycle without its malformed trace fields instead of refusing the whole cycle?**

The cycle is a fact in the device sequence. Refusing it leaves a hole that the sweep eventually writes off, and every module downstream (intervals, OEE, execution) then loses a real cycle over auxiliary data. Keeping the cycle and recording `trace-dropped` (with a metric) loses only what was wrong, keeps the sequence whole, and leaves the lots "not reported", which is the truth.

**5. What are the I chart's limits for readings with mean 2.048 and average moving range 0.4826 (Pa/min)? And why is 2.66 the factor?**

X̄ ± 2.66 · M̄R = 2.048 ± 1.284, so 0.764 to 3.332 Pa/min (these are `quality-01`'s version 1 values). The factor is 3/d₂ with d₂ = 1.128, the expected range of two independent normal readings in units of σ. M̄R/1.128 estimates σ, and three of those are 2.66 · M̄R.

**6. Why estimate σ from moving ranges or subgroup ranges rather than from the standard deviation of all baseline readings?**

The overall standard deviation includes every shift and trend in the window, so a process that drifted during its baseline gets wide limits that hide the drift. Ranges between neighbours measure only short-term noise, the common-cause variation the chart is meant to compare against.

**7. Why does SPC use first-pass readings only?**

A retest follows a rework: the part was opened and resealed. Its reading belongs to another population, and mixing the populations inflates the variation and moves the mean, so limits widen and signals weaken. Retests are shown as separate marks, so nothing is hidden.

**8. With rule 1 alone, about how many in-control readings pass before a false alarm? Why did the defaults with rules 1, 2 and 5 measure about 125, and why is it not a fixed number?**

For a normal process a point falls beyond 3σ with probability about 0.0027, so the average run length is about 370. Rules 2 and 5 each add their own chance of firing on noise, so the run is shorter. The measured mean of about 125 readings (median 76) also includes the effect of estimated limits: each simulated run estimates its own limits from 100 readings, so some runs get tight limits and signal often, others wide ones and signal rarely. That spread (10 % at 12 readings, 90 % at 302) is why ADR-0032 reports a distribution, not one number.

**9. Why was rule 1 on the MR chart dropped from the defaults?**

It nearly doubled the in-control episodes (22.9 against 13.0 per 1,000 readings) and added nothing to detecting the drift: a shift of the mean moves every reading by the same amount, so the difference between neighbours, the moving range, doesn't change. A rule that raises the false-alarm cost without catching the failure the plant cares about is a bad default. It stays available per characteristic.

**10. Why is a signal an episode and not a flag on each point?**

A drift makes many consecutive points fire the same rule. A flag per point produces dozens of alarms for one cause, and people learn to ignore them. An episode is one thing to see, push and acknowledge per cause. It opens at the first triggering point, stays open while consecutive points keep firing the same rule on the same chart, and closes at the first point that doesn't.

**11. A late leak reading arrives with a plant time before the last ten points. What changes, and why can't the module patch the affected point?**

The late reading becomes a new point in time order. The moving range after it changes, every later subgroup of five shifts by one reading, and every run-based rule (nine on one side, two of three) is re-evaluated over a new sequence. Episodes can split, join or vanish. Patching one point can't express that, so the module re-derives the chart and its episodes from the readings and writes the changed episode rows. Probe P3 measured this at 23–25 ms on a week of readings, over the 20 ms budget for that rare case; per new reading it stays at p95 13–14 ms.

**12. When is an episode final, and why separate "identity final" from "extent final"?**

Its identity (chart, rule, first triggering point) is final once LKT-01 is final through the triggering point: every earlier reading has arrived or been written off, so no ordinary late reading can insert a point before it. Two things can still undo it: a late fact from a written-off gap, and a limit version created or ended. Either one makes the module withdraw the episode with its reason (`WITHDRAWN_FINAL`, `WITHDRAWN_VERSION`); it never re-keys it (question 13). Its extent (last point, length) can still grow while later readings arrive, so it is final only with `extentFinal`, when the tester is final through its closing point. Separating them lets the MES push and acknowledge a final episode while it is still running.

**13. A final episode is re-derived away by a late reading from a written-off gap. What happens to it, and to its acknowledgement?**

It is kept as `withdrawn` with the reason ("a late reading from a written-off gap"), never deleted, and its acknowledgement stays on it, shown as orphaned. Someone may have acted on that signal (opened a hold, adjusted the tester); deleting it would erase the reason for their action. Only a provisional, unacknowledged episode is removed outright (pushed as `removed`).

**14. Why are control limits frozen after version 1, instead of recomputed on a rolling window?**

A rolling window follows the process. As a drift moves the mean up, the limits move up with it, and the drift never crosses them: it hides in its own limits. Frozen limits make the drift visible from its start. New limits are a person's decision (`spc:limits`, audited), typically after a known process change, and a late reading inside the baseline raises a `baseline-changed` notice rather than silently re-estimating.

**15. `quality-01`'s upper control limit (3.332) is above the specification limit (3.2). Is the process in control? Is it capable?**

These are separate questions. In control means its variation is stable and predictable, which limits from its own data describe. Capable means that variation fits inside the specification. Cpu = (3.2 − 2.048) / (3 · 0.432) ≈ 0.89, under the usual target of 1.33, so a stable process will still put a part above 3.2 now and then, as the leak scrap in `quality-01` shows. SPC tells you when the process changes; it doesn't make an incapable process capable.

**16. Why was "SPC signals within 20 readings of the drift" not enough as an exit criterion?**

With the default rules a process with no drift at all signals within 20 readings with probability about 0.18, so such a test passes almost one time in five by chance, and it can't tell a working detector from a noisy one. The counterfactual check removes the chance: the same draws without the drift must open no episode in the window, so only the drift can explain the signal.

**17. How can the simulator know the reading "without the drift" exactly?**

The drift is added after the random draw, as a whole number of resolution steps (`shift` must be a multiple of 0.001 Pa/min, or the injection is refused). No random number is drawn differently. For readings between the `leak-drift` `applied` and `ended` lines the counterfactual is the logged steps minus `shift/resolution`; outside that span it is the logged value. In `quality-01` part 106 read 3,381 steps with the drift and 2,781 without it; only the first crosses the 3,332 limit.

**18. Why does genealogy's processed watermark use `settledSeq` and not `receivedThrough`?**

`receivedThrough` stops at the first number that never arrived. A lost fact whose gap was written off would stop it for the rest of the device epoch, and every later order on that machine could never close (`genealogy-pending` for ever). `settledSeq` also passes written-off gaps, so it keeps moving. That is safe for genealogy because a lost fact can't be "processed" anyway, and a late one is caught by the second check (`unrecorded`).

**19. Then why does the command path use `receivedThrough` for `seqAfterExpiry`?**

Its question is "is there no acceptance fact up to this number?". A fact lost in a written-off gap might be exactly the acceptance, so counting the gap as settled could conclude "never accepted" while the job exists, and a re-dispatch would make a second job. There, being stuck is the safe failure. For genealogy, being stuck would block every later close for good (a liveness failure), while moving on is still safe because `unrecorded` catches a late fact. The choice follows from what a missing fact would mean for the decision.

**20. The guard checked the watermark, yet the reviewer closed an order beside a hold on its lot (probe PD). How?**

A fact from a gap that had been written off arrived late. Its number was already counted as settled, so the watermark covered it as soon as ingest stored it, before genealogy rebuilt its unit and wrote the link to the held lot. The scope derived at check time didn't include the unit, and the close went through. The fix adds `Genealogy.unrecorded`: every cycle fact of the order's units, read from ingest, must be in a genealogy record of its unit.

**21. Why does the close guard derive the hold scope at check time instead of reading `quality.hold_unit`?**

`hold_unit` is a copy rebuilt every second, so it can lag a hold that has just been opened or a link that has just been written. Probe P2 reproduced exactly that: the close read `hold_unit`, saw nothing, and closed beside an open hold. Deriving the scope from the open holds' subjects and the genealogy links, inside the close's transaction after the lock, uses the current data.

**22. Why one global advisory lock rather than `SELECT … FOR UPDATE` on the order row?**

To lock order rows, a hold must know which orders it affects, but a lot hold's orders are known only after its scope is derived, and the scope can grow. A fixed advisory key needs no such knowledge: both transactions take it first, and every statement after it sees every hold committed before. Holds and closes are rare human actions, so serializing all of them costs nothing measurable.

**23. Where could the advisory lock deadlock, and how is that ruled out?**

With the orders module's in-process queue `#serial`. A close holds `#serial` and waits for the lock. A hold's transaction holds the lock and writes an ERP notification through the orders module. If that write waited for `#serial`, each would wait on the other, one in the database and one in the process, and no database deadlock detector would see it. `Orders.enqueueErpMessage(trx, …)` never takes `#serial` and touches no order row (an insert in the caller's transaction). A same-process test runs a hold and a close at once, in both orders, under a timeout.

**24. #218: why does reading progress before facts make the judgement safe, and not just differently racy?**

Ingest commits each fact together with its stream cursor. If the progress is read first, every number it counts was committed before that read, so a later read of the facts sees it. Facts arriving between the reads can only make the progress look older than the facts. The worst case is that the command waits one more tick, never a wrong `not-accepted`. Read the other way round, a fact committed in between was counted as received but missing from the facts, which is a false absence.

**25. Why couldn't the end-to-end test prove the #218 fix, and what proves it?**

The race needs a commit to land between two statements a few milliseconds apart. Under load the e2e hit it once in eight runs; passing five more runs makes it unlikely, not impossible. The proof is a scripted interleaving in `orders.test.ts`: ingest is wrapped so that the acceptance is stored inside the progress read. It fails with the old read order and passes with the new one, every time.

**26. A reviewer says a test is vacuous. How do you check, and what do you do?**

Make the smallest change to the code that breaks the property the test claims, run the test alone, and see whether it fails. If it passes, the test doesn't constrain that behaviour. Usually it is fed data that never reaches the risky path (Phase 8: replays without a final/provisional boundary), or its expectation comes from the code under test (the operator check), or an earlier test prepared its state. Change the data or the oracle until the mutant fails, then keep the mutant's description in the PR as evidence.

**27. Why did fixed test ports cause failures that looked like timing flakes?**

Two suites bound the same port, or one wiped a certificate folder another was using, and the symptoms were timeouts, refused connections or a health check answered by the wrong process. They appeared only when other worktrees ran at the same time, which looks like load. Choosing ports at run time, retrying on `EADDRINUSE`, a folder per suite and readiness from the child's own log line removed the shared resource, and with it the failures.

**28. Why is `pnpm test:trace-perf` measured through nginx with a session, not by timing the SQL?**

The exit criterion is what a user waits for. Probe P2 timed the queries at 0.02 ms and 3.6 ms, but an answer also pays for the HTTP stack, authentication, JSON serialization of up to 159 kB and nginx. Through the real path the backward trace measured p95 about 3 ms and the forward trace of a 1,493-unit lot about 29–34 ms: the payload, not the query, dominates.

## 4. Hands-on exercise

Look at the drift, its counterfactual and a mutant, without a stack and without touching any database you keep.

1. Run the shift-A reference of `quality-01` into a scratch folder: `pnpm sim:headless --scenario quality-01 --end 2026-10-12T14:00:00+03:00 --out runs/q01-a`. The command runs in the simulator's package, so it writes to `apps/simulator/runs/q01-a`. Open `apps/simulator/runs/q01-a/trace.json` and find `drifts[0]`: `start` (part 105), `firstEpisode` (chart, rule, latency) and `window.readings`. For parts 105–110, compare `value` with `counterfactual` and with the I chart's upper limit in `spc.limits[0].limits.charts.I.upper` (a fraction in 0.001 steps).
2. By hand, from `spc.limits[0].limits.statistics`, compute X̄ ± 2.66 · M̄R and check that it equals the stored I limits. Then compute Cpu = (3,200 − X̄) / (3 · R̄ / 2.326).
3. Measure the false-alarm run length yourself: `pnpm --filter @shopfloor/spc-core false-alarm` (about 45 s) and compare with the table in ADR-0032.
4. Mutate and watch a test fail. In `apps/mes-server/src/modules/orders/orders.ts`, in `#evaluate`, move the progress read after the facts read (the order before #218). Run `pnpm --filter @shopfloor/mes-server exec vitest run src/orders.test.ts -t "#218"` (it needs Docker for its database container). It fails. Restore the file (`git checkout -- apps/mes-server/src/modules/orders/orders.ts`) and run it again: it passes.
5. Remove `apps/simulator/runs/q01-a`.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
