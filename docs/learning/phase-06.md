# Phase 06 – Alarms and shifts: learning notes

Phase 6 turned the device's alarm facts into an operator's alarm system and gave shifts a report. Its parts:

- `alarm-core` computes the ISA-18.2 and EEMUA 191 alarm KPIs exactly;
- the simulator can inject a failure, and a second golden scenario, `alarms-01`, gives the KPIs a flood, a chattering point, a fleeting and a standing alarm to reconcile;
- the MES derives alarm occurrences from raises, clears, retained anchors and resync snapshots, with finality and revisions;
- operators acknowledge, shelve and comment through guarded, audited writes;
- the `shifts` module stores shift instances and composes a shift report with handover notes, final when its inputs are;
- the web shows the alarm list, the alarm KPIs and a printable shift report, all live.

These notes explain the ideas and give a reading order, questions _with full answers_ and an exercise. They are reference material; the learning step is optional, as in earlier phases.

## 1. Concepts

### The ISA-18.2 alarm lifecycle

ANSI/ISA-18.2 (IEC 62682 is its international twin) separates two things that are easy to mix up:

- the **process condition**, which the device owns: the alarm is _active_ while the condition holds and _returns to normal_ (RTN, "cleared") when it stops;
- the **operator's response**, which the alarm system owns: an alarm is _unacknowledged_ until an operator acknowledges it.

Combining the two gives the standard's states. This project implements four of them plus shelving (ADR-0024):

| State (`state` in the API)             | Condition | Acknowledged | Where it is listed                   |
| -------------------------------------- | --------- | ------------ | ------------------------------------ |
| `unacked-active`                       | active    | no           | Active                               |
| `acked-active`                         | active    | yes          | Acknowledged                         |
| `unacked-cleared` (RTN unacknowledged) | cleared   | no           | Active: a clear does not acknowledge |
| `closed`                               | cleared   | yes          | History                              |

- **RTN unacknowledged** is the state people forget. A fault that came and went while nobody looked must still be seen, so it stays in the active list until someone acknowledges it. Only then is it `closed`.
- One project-specific rule: an occurrence ended by a newer epoch (`epoch-ended`, a restarted simulator) is `closed` without acknowledgement. The run it belonged to no longer exists.
- **Shelving** is the operator's temporary suppression of an alarm _point_ (equipment and code), not of one occurrence, always with a time limit. ISA-18.2 treats it as a controlled action with a time limit, after which the alarm is unshelved automatically. A shelved point's alarms are not annunciated: they leave the Active and Acknowledged lists for a separate Shelved tab. In this project they are still raised, stored and counted in the KPIs, and every shelve and unshelve is audited. Here the limit runs in **plant time** (`until` = plant clock + duration, at most `maxShelveMs`, 8 h), and the MES unshelves the point itself when the plant clock passes `until` (`expire`) or a newer epoch begins (`epoch-ended`), both audited with actor `system`.
- Not implemented (out of scope): suppression by design, out of service, and latching.

The device owns active and cleared, and the MES owns acknowledged and shelved (ADR-0010). The UNS carries only `active` and `cleared`; nothing the operator does is published back.

### EEMUA 191 and ISA-18.2 alarm KPIs

The KPIs measure the load on one operator, so they are computed per **operator position** (here a configured set of work centers: `cell-m1`, `line-a1`) and for the plant. The benchmarks come from EEMUA 191 and ISA-18.2: about one alarm per 10 minutes per operator is very likely acceptable, about two is the most manageable; more than 10 in 10 minutes is a flood; under about 1 % of 10-minute windows in flood; no chattering or fleeting alarms; few standing alarms; the top 10 alarms under a few percent of the load.

Definitions in this project (`config/plant/alarms.yaml`, ADR-0024):

- **What counts is a raise.** Every device `active` transition is one alarm, shelved or not. Shelving is an operator action the ground truth can't know, so counting raises keeps every reconciled KPI independent of operators. Shelved and annunciated raises are reported apart (`/alarms/operator-kpi`), not reconciled.
- **Average rate** = raises × `windowMs` / bucket length, an exact fraction: 13 raises in an 8-hour shift are 13 × 600,000 / 28,800,000 = 13/48 ≈ 0.2708 per 10 minutes.
- **Peak and flood windows:** fixed 10-minute windows aligned on the hour. `peak10` is the most raises in one; a **flood window** has more than `floodThreshold` (10), so 11 is a flood and 10 is not.
- **Flood episodes** are sliding: the count at instant t is the raises in (t − 600,000, t]. An episode starts at the raise that makes the count exceed 10 and ends when its oldest counted raise leaves the window and the count is back at 10.
- **Chattering:** a raise is chattering when its point raised at least 3 times in (t − 60,000, t], itself included.
- **Fleeting:** a device clear less than 1,000 ms after the raise. 999 ms is fleeting, 1,000 ms is not. A superseded, epoch-ended or lost-clear end is never fleeting: it is not a device clear.
- **Standing** (ISA-18.2's "stale"): active at the bucket's end and raised at least 24 h (`standingMs`) before it.
- **Bad actors:** points ranked by raises, then active time, then equipment and code; the top 10 with their share of the scope's raises.

A worked example from `alarms-01`'s shift A on Cell M1 (13 injected raises from 05:00:05Z):

- the 11th raise, CNC-02 `SPINDLE-OVERLOAD` at 05:03:15Z, makes the window count 11: a flood starts, with id `1791781395000~cnc-02~SPINDLE-OVERLOAD`;
- the 13th raise makes the peak 13;
- the 1st, 2nd and 3rd raises (05:00:05, :15, :25) leave the window at 05:10:05, :15 and :25, so the count falls 13 → 12 → 11 → 10. The episode ends at 05:10:25Z;
- CNC-01 `COOLANT-PRESSURE` raised at 05:00:05, :25 and :45. The third raise sees three raises in (04:59:45, 05:00:45], so it is chattering;
- all 13 raises lie in the fixed window 05:00–05:10, so `peak10` is 13 and the hour has one flood window.

### Window conventions

The **sliding** windows (chattering and flood episodes) use one convention: **the window ending at t is (t − window, t]**, open on the left, closed on the right. The **fixed** windows behind `peak10` and flood windows are half-open like the buckets, **[start, start + window)**, aligned on the hour.

- A raise exactly one window earlier has left the window. Chattering at 60,000 ms is therefore not chattering (the first raise has left), while 59,999 ms is.
- Several raises in one millisecond all count, in raise order: the second of three already sees two. Raise order is time, then equipment, then the device's `seq`, then code. `seq` is per device, so it never orders raises of two devices.
- **At one instant, leaving goes before arriving.** The raises that leave the window at t go first, then the raises at t arrive. So an episode whose last counted raise leaves exactly when another arrives goes on.
- **An episode covers [start, end).** A raise that arrives at the end instant was never in flood (reference case 21).
- **Buckets** are half-open [from, to) on whole UTC hours. A raise belongs to the bucket that contains its `raisedAt`; one exactly on a boundary belongs to the later bucket.

Writing the convention down once, and testing every boundary ± 1 ms, is what made the simulator and the MES agree exactly.

### Exact arithmetic, reused

`alarm-core` imports `oee-core`'s reduced BigInt fractions and half-up rounding instead of copying them. That needed the purity rule changed (ADR-0024 amends ADR-0005):

- a package in `PURE_PACKAGES` may import another pure package **by its exact name**, and nothing else: not a subpath, not `contracts` or `plant-config`, not an app, not a Node.js built-in;
- purity stays transitive, because everything a pure package may import is itself pure;
- `exactnessRules` (no `Math`, decimal literals, `/`, `parseFloat`) covers `alarm-core` too.

So "equal to four decimals" is again an equality: 13/48 is stored as a fraction and printed as 0.2708 by the same integer rounding as OEE.

### Revision spans for windowed KPIs

Phase 5 revised an OEE hour when a late fact changed it. Alarm KPIs reach across hours, so a late fact can change hours it doesn't lie in:

- **A late raise at t** changes the windows, floods and chattering of later raises in [t, t + max(`windowMs`, `chatterWindowMs`)] = [t, t + 10 min]; its own active span; an earlier open occurrence of its point that it now supersedes; and every flood episode in flood during [t, t + 10 min], to the episode's end. A late raise can join two episodes into one, which changes the id and peak of every later hour of the joined episode (reference case 20).
- **A moved end** (a late clear, a snapshot closing a lost clear, a real clear replacing the snapshot's end) changes every hour from the raise to the later of the two ends. An open end counts as the horizon `asOf`, because until the clear arrived those hours showed the occurrence active (case 19).
- Floods are **scope-wide**: a late fact on one machine changes its position's and the plant's floods. So revisions are stored per scope and hour (`alarms.kpi_revision`), and a fact revises its equipment, its position and the plant.
- Only a change whose earliest effect lies before the end of some final hour is late. An in-order raise that joins a flood begun in a final hour revises nothing.

Reference case 18 shows the boundary effect: a late raise at 10:55:00 revises hours 10:00 **and** 11:00, because [10:55, 11:05] crosses the hour.

### Fault injection and state-machine guards

`POST /api/v1/faults/failure/{machine}` (control API 1.3) and a golden scenario's `injections` list drive the simulator's existing breakdown path:

- **Only in `Running`.** The line halts the cycle, cancels the machine's pending clock event and calls `#breakDown`, in the order of a natural failure.
- **Held otherwise.** In any other state the injection waits on the machine (`injection-held`) and applies where the machine would next enter `Running`, in `#run`, which every path into `Running` passes. The machine goes straight to `Down`, so there is never a zero-length `Running` interval.
- **Guards.** Paths that bypass a natural failure (`#tryStart`, `stop-end`, `#releaseUpstream`) gained `failure` guards, so a held failure is neither lost nor doubled. The state table gained the edges this needs: `Off`, `PlannedStop`, `Maintenance` → `Down`, and `Down → Down` (an injection held while down applies when the repair ends, with the new code).
- **Tests.** For each of nine states, an injection mid-interval is compared with the same run without it: identical event logs up to the instant the plain run first enters `Running`, exactly one breakdown there, no zero-length `Running`, and the invariant checker after every step. The review fuzzed about 6,500 random injections.

The plan's first idea, injecting a breakdown in any state, would have broken the line model: Stopped, Starved and Blocked had no path to `Down`. The plan review caught it before any code.

### Golden scenarios and prefix equality

The golden week has only two alarms, so an exact reconciliation on it alone proves little. `alarms-01` is `week-01`'s seed and start with injections, and it reaches back to `week-01` through **prefix equality**:

- the simulation is deterministic: same seed, same configuration, same event queue with the same tie-breaking sequence;
- injections are scheduled after `line.start`, in list order, the same way headless and live, and never on a calendar boundary (`checkInjections` refuses it);
- so `alarms-01`'s event log is byte-identical to `week-01`'s for its first 695 events, up to the first injection (a headless test asserts it).

That lets the live run move from `week-01` to `alarms-01` without losing Phase 4 and 5 evidence: up to 08:00 Istanbul the two are the same run. `alarms.yaml` is kept out of the simulator's config hash, and the run header lists `injections` only when there are any, so `week-01`'s `events.sha256` didn't change (its `summary.json` gained only the new `alarms` section).

### Resync snapshots and lost clears

A clear lost in a sequence gap would leave an occurrence open for good. On every resync the gateway publishes, per equipment, a retained **alarm snapshot** (`uns.alarm-snapshot/1`, topic `…/alarms/_snapshot`):

- **atomic:** over OPC UA, one Read of `Epoch`, `Sequence` and every `Alarms.<CODE>.Active`; over Modbus, one register read of the event counter and register 17 `activeAlarms`. So `asOfSeq` (the device sequence the snapshot is consistent with) and the active bits belong together;
- **outside dedup and gaps:** it is topic-scoped with the gateway's own epoch and seq, and its `deviceEpoch` and `asOfSeq` only order it against the device's facts;
- **applied only once the stream is settled up to `asOfSeq`:** until every fact below `asOfSeq` is known, the MES can't tell which raise the snapshot speaks about;
- **effect:** an occurrence raised below `asOfSeq`, still open, whose code the snapshot shows inactive, ends `lost` at the snapshot's `sourceTime` (the time of fact `asOfSeq`, so never later than the snapshot proves). If the real clear arrives later, it replaces that end, and the hours between the two ends are revised.

**Anchors** are the retained alarm deliveries: the device's own last fact per code, with its true epoch and seq. They let an MES that starts while an alarm is active learn of it. Anchors and snapshots of an epoch older than the newest one known for the equipment are stored as stale and never used, so a restarted simulator's old alarms never show as active.

### Deadlocks and lock ordering

A **deadlock** is a cycle of waits: transaction A holds row 1 and wants row 2, while B holds row 2 and wants row 1. PostgreSQL detects it after `deadlock_timeout` (1 s by default) and aborts one of them with SQLSTATE `40P01`.

The #143 review's probe A found one. A bulk acknowledgement locked occurrences `FOR SHARE` in (equipment, epoch, seq) order. A rebuild of the same machine's occurrences updated a higher `seq`, then deleted a lower one. The orders crossed, and the acknowledgement failed with a 500. The fix has two parts:

- **one global lock order:** the rebuild (`#rederive`) now locks the rows it changes `FOR UPDATE` in `seq` order before writing. Sorting the bulk request's ids had only ordered acknowledgements among themselves; every writer of the table must follow the same order;
- **retry:** acknowledgements and comments retry their whole transaction on `40P01` and `40001` (serialization failure), up to 3 tries after a short random pause. A retry sees the rebuild's result, so an occurrence it deleted is then 404.

### Optimistic concurrency versus monotonic writes

Two kinds of write, two rules:

- **Shelving is not monotonic.** A point goes shelved → unshelved → shelved, so two screens can overwrite each other. Each shelve or unshelve sends the point's `version` and gets 409 if it moved, as codings did in Phase 5. The MES's own expiry and epoch end raise the version too, so a screen holding an ended shelf is refused.
- **Acknowledgement is monotonic.** It only goes from no to yes, so two acknowledgements can't conflict. No version is needed. One `INSERT … ON CONFLICT DO NOTHING RETURNING` into `alarms.occurrence_state` writes it; `RETURNING` yields only the rows actually inserted, and audit rows are written only for those, in the same transaction. A concurrent insert of the same key waits for the first transaction and then does nothing. Four overlapping bulk requests therefore acknowledge and audit each occurrence once, and an already acknowledged one answers `changed: false`.

A trigger makes `occurrence_state` insert-only, so monotonicity doesn't rest on the code alone.

### Append-only audits

Phase 6 adds two audits in the Phase 5 pattern: `alarms.alarm_transition` (ack, comment, shelve, unshelve, expire, epoch-ended) and `shifts.handover_audit` (note create and edit). Each row holds before, after, actor, `authenticated: false`, wall time, plant time and request id.

- A row-level `BEFORE UPDATE OR DELETE` trigger raises an exception for every affected row; a statement-level `BEFORE TRUNCATE` trigger covers TRUNCATE, which row triggers never see.
- A row trigger fires only for rows the statement touches: `DELETE … WHERE false` succeeds, because there is nothing to refuse. The live check therefore runs a real `UPDATE` and `DELETE` over the 17 and 2 rows, inside `BEGIN … ROLLBACK`.
- As in Phase 5, the MES owns these tables and could `ALTER TABLE … DISABLE TRIGGER`. Real tamper resistance needs separate roles (Phases 7 and 9).

### Composite revisions

A shift report is computed on read, so it can't go stale, but a reader must still see that a final report changed. Two kinds of change happen for different reasons, so the revision has two stored counters (ADR-0025):

- **`inputs`** starts at 0 when the report becomes final and rises by one for every revision step of an input after that: one OEE hour of one machine, or one alarm KPI hour of one scope. It is a counter of steps, not a maximum of revisions, so two changes never collapse into one.
- **`content`** rises with every handover note create or edit, and, after final, with every operator recode in the shift and every acknowledgement of a raise in it (time to acknowledge changes).
- **`contentAtFinal`** is `content` at the moment of finality, stored in the same locked update. "Changed after final" is `content − contentAtFinal`, with no clocks compared.

Two rules keep the counters honest:

- **read order:** instance row, then input revisions, then content, so a revision can lag its content but never lead it;
- **push only forward:** an instance is pushed only when status, `inputs` and `content` are each at least as high as before and one is higher.

### Problem types (RFC 9457)

RFC 9457 ("Problem Details for HTTP APIs", which replaced RFC 7807) defines an error body (`application/problem+json`) with `type`, `title`, `status`, `detail` and `instance`.

- **`type`** is a URI that identifies the kind of problem; it is the field a client branches on. The default `about:blank` means "nothing beyond the status code". A `type` need not be dereferenceable, so this project uses `urn:shopfloor:*` names.
- **`detail`** is prose for people. Until #163, the web told a closed handover window from a stale note by the prefix of `detail`, so rewording a message would silently have changed the screen's behaviour.
- Now every write conflict and refusal carries a stable type from `PROBLEM_TYPES` in `@shopfloor/contracts`: `handover-closed`, `handover-not-open`, `note-stale`, `note-limit`, `coding-stale`, `shelf-stale`, `host-not-allowed`, `write-origin`, `writes-off`, `write-not-json`, `write-rate`. Everything else stays `about:blank` (ADR-0023 note).

### The print stylesheet

The shift report prints from the browser (#146); there is no server-side PDF.

- `@page { size: A4; margin: 12mm }` sets the paper. `@media print` rules lay the page out for it: no background, wide tables in full instead of in scroll boxes, `break-inside: avoid` on sections and rows, headings kept with what follows.
- Navigation, forms and live marks carry Tailwind's `print:hidden`.
- **Charts.** A canvas is resized and redrawn while the page is laid out for paper, so the live ECharts canvas is hidden in print. On `beforeprint` (the **Print** button or Ctrl+P), the chart is drawn once more without animation and copied to an `<img>` as a PNG `data:` URL (`getDataURL`, `pixelRatio` 3). The CSP's `img-src 'self' data:` allows it, and the table beside every chart carries the values anyway.
- The API adds `generatedAt` (the MES's wall clock) and `asOf` (the plant clock), which a printout needs and the page can't know.

### The adversarial latency judge

Phase 5's judge checks that a page shows each API change within 2 s, with value floors against lagging pages. Phase 6 extended it to the alarm list, the flood banner and the KPI cards, and found a flaw in the judge itself.

- **The symptom.** When the alarm check ran first, the OEE check sampled later in the shift, and its maximum latency rose to 1.9 s, failing 2 runs of 9.
- **Three hypotheses refuted by measurement:** shared push pacing (no alarm topic was computed meanwhile), read-pool contention (a waiting query in 4 of 372 samples) and the browser (11–13 ms from WebSocket to DOM).
- **The cause:** the judge accepted a page value only if the 100-ms polls had never seen it anywhere in the run. A real work-center OEE dip lasting less than one poll, whose four decimals the polls had seen 18 s earlier, was taken for a stale value. Later in the shift values repeat more often (49.5 % against 17.1 %).
- **The fix:** `seenWithin`: a value counts as seen only if the API held it within ±5 s of the sample. Unit tests built pages to fool it: lagging 2.5 s and 4.5 s still fail; lagging 8 s passes most changes but fails the snapshot agreement; a frozen page fails; the brief repeated value passes.

The same review found that the audit check could never fail: an accepted `UPDATE` made `JSON.parse` throw, which was counted as a refusal. A check has to be shown failing before its passes mean anything.

## 2. Reading order

| #   | File                                                                                                  | Look for                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `docs/adr/0024-alarm-kpis-definitions-and-pure-package-imports.md`                                    | What counts, the window convention, revision spans; "Occurrences in the MES"; the lifecycle |
| 2   | `docs/alarm-kpi-reference-cases.md`                                                                   | Definitions; cases 2, 16, 18, 19, 20 and 21 worked by hand                                  |
| 3   | `packages/alarm-core/src/occurrences.ts`, `floods.ts`, `buckets.ts`, `revisions.ts`                   | `prepare` (order, superseded, chattering), the sweep, `kpisOfBucket`, `revisionSpans`       |
| 4   | `config/plant/alarms.yaml`                                                                            | Thresholds, positions, definitions                                                          |
| 5   | `apps/simulator/src/plant/line.ts`, `apps/simulator/golden/alarms-01/scenario.json`                   | Held injections in `#run`, the `failure` guards; the injection timeline                     |
| 6   | `apps/mes-server/src/modules/alarms/derive.ts`, then `alarms.ts`                                      | `deriveOccurrences`; finality, revisions judged by the old bound, `#rederive`'s lock order  |
| 7   | `db/migrations/0013_alarms_operator_lifecycle.sql`, `apps/mes-server/src/modules/alarms/lifecycle.ts` | The insert-only and append-only triggers; acknowledge, shelve, expiry                       |
| 8   | `docs/adr/0025-shift-instances-report-finality-and-handover-notes.md`, `modules/shifts/shifts.ts`     | Finality, the composite revision, the read order, the handover window                       |
| 9   | `docs/adr/0023-guarded-writes-before-identity.md` (notes), `packages/contracts/src/mes-api.ts`        | The problem types table and `PROBLEM_TYPES`                                                 |
| 10  | `apps/web/src/index.css`, `apps/web/src/chart/echarts-view.tsx`                                       | The print rules and the `beforeprint` snapshot                                              |
| 11  | `e2e/src/latency.ts`, `e2e/browser/2-alarms-live.spec.ts`, `e2e/src/reconcile.ts`                     | `seenWithin`, the alarm judgements, the audit refusal check                                 |

## 3. Questions, with answers

**1. An alarm raises and clears while nobody is looking. Where does it appear, and why?**

In the Active list, as `unacked-cleared` ("RTN unacknowledged"). A clear changes the process condition, not the operator's response. ISA-18.2 keeps an unacknowledged alarm in front of the operator even after it returned to normal, so a transient fault is not missed. Once someone acknowledges it, it is `closed` and moves to History.

**2. Why does shelving apply to a point (equipment and code) rather than to one occurrence, and why in plant time?**

Shelving answers "stop bothering me with this alarm for a while", typically a point that keeps re-raising. Shelving one occurrence would do nothing about the next raise of the same point. The limit runs in plant time because the plant may run at 60× or be paused: "shelved for 1 hour" means one hour of the plant's life, so a paused plant keeps the shelf, and a new epoch (plant time starting over) ends it.

**3. Why do the reconciled KPIs count raises, including those of shelved points?**

The ground truth knows nothing about operators, so any KPI that depends on shelving couldn't be reconciled. Counting every device raise keeps `/alarms/kpi` a pure function of the device's facts; the reconciliation and the live check even assert it is byte-identical after acknowledging, shelving and commenting. The operator's view (annunciated and shelved raises, time to acknowledge) is reported separately and not reconciled.

**4. Raises of one point come at 10:00:00.000, 10:00:30.000 and 10:01:00.000. Is the third raise chattering? What if the third came at 10:00:59.999?**

At 10:01:00.000 the window is (10:00:00.000, 10:01:00.000]. The first raise is exactly one window earlier and has left it, so only two raises count: not chattering. At 10:00:59.999 the window is (09:59:59.999, 10:00:59.999], which holds all three: chattering.

**5. Ten raises fall in the fixed window 10:00–10:10 and one more at 10:10:05. Is there a flood window? A flood episode?**

No flood window: 10:00–10:10 holds 10 raises (not more than 10), and 10:10–10:20 holds 1. Whether there is an episode depends on timing: at 10:10:05 the sliding window is (10:00:05, 10:10:05]. If all ten earlier raises were after 10:00:05, the count is 11 and an episode starts; if any was at or before 10:00:05, it has left. That is why the KPIs have both: fixed windows for rates and peaks, comparable across hours, and sliding episodes for floods, which don't depend on where the clock's ten-minute marks fall (reference case 3 has a sliding flood with no flood window).

**6. A flood episode is still running at the end of an hour. Can that hour be final?**

Yes. The flood state at an instant depends only on raises up to that instant. The hour reports the episode's `floodMs` clipped to the hour, its peak so far and `open: true`, and none of these can change by anything after the hour's end. The final attributes (end, peak, raise count) belong to the hour where the episode ends. Waiting for the episode to end would have kept every bucket of a long flood provisional.

**7. A late raise arrives at 10:55:00 for an hour that was final. Which hours are revised, and why not only 10:00?**

Its span is [10:55, 11:05] plus its active span, so hours 10:00 and 11:00 (reference case 18). Windows, floods and chattering of raises up to 10 minutes later count the late raise, and those raises can lie in the next hour. If the late raise joins a running flood, every hour of that episode up to its end is revised too. The revision is raised in the equipment's, the position's and the plant's scope, because floods are scope-wide.

**8. A clear arrives late for an occurrence that showed as open from 10:40 until 13:30 (as of). The clear says 12:20. Which hours change?**

From the raise to the later of the two ends, with the open end counting as `asOf`: 10:00, 11:00, 12:00 and 13:00 (reference case 19). Until the clear arrived, the occurrence was active in 12:20–13:30 too, contributing active time and active-at-end. Revising only the raise→clear span would leave hour 13:00 changed without a revision.

**9. Why must an injected failure wait until the machine is `Running`?**

The breakdown path assumes a running machine: it halts the cycle and cancels the pending cycle-end event. In Stopped, Starved or Blocked there is no cycle to halt, and other paths (`#tryStart`, `stop-end`, `#releaseUpstream`) could start the machine and lose or double the failure. Holding the injection and applying it where the machine would enter `Running`, straight to `Down`, uses only the path that already works and never creates a zero-length `Running` interval.

**10. How can the live reconcile run `alarms-01` and still count as evidence for Phases 4 and 5, which were about `week-01`?**

Prefix equality. `alarms-01` uses `week-01`'s seed, start and configuration, and its injections are scheduled after `line.start` in list order, off every calendar boundary. A headless test asserts that its event log equals `week-01`'s for the first 695 events, up to the first injection. So up to 08:00 Istanbul both are the same run, and after it the live run is compared with its own live ground truth.

**11. Why does the MES apply an alarm snapshot only once the stream is settled up to its `asOfSeq`?**

The snapshot says which codes were active as of fact `asOfSeq`. If facts below that are still missing, the MES doesn't know which raise is the open one, or whether a missing raise and clear lie between. Closing an occurrence as `lost` then could close the wrong one. Once all facts up to `asOfSeq` are known, an occurrence still open there whose code the snapshot shows inactive must have had its clear lost.

**12. The simulator restarts while the broker still holds the old run's retained alarms. What stops the MES showing them as active?**

Epochs. Each retained alarm (anchor) and snapshot carries its device epoch. One older than the newest epoch ingest knows for the equipment is stored as stale and never used. If the anchor arrived first and was used, the new epoch's arrival ends the old epoch's occurrences (`epoch-ended`), and those are `closed` without acknowledgement.

**13. A bulk acknowledgement sorted its ids, yet deadlocked. How?**

Sorting orders the acknowledgements among themselves, but a deadlock needs only two transactions taking the same rows in different orders. The occurrence rebuild updated a higher `seq` before deleting a lower one, while the acknowledgement locked in ascending `seq`. The fix gives every writer the same order (`#rederive` locks its changed rows `FOR UPDATE` in `seq` order first) and retries on `40P01` and `40001`, because a database may still abort a transaction for reasons the code can't rule out.

**14. Why does shelving carry a version but acknowledgement not?**

Shelving changes state back and forth, so a stale screen could undo someone else's shelve or unshelve: a lost update. The version turns that into a 409. Acknowledgement is monotonic: once true it stays true, and two acknowledgements mean the same thing. `INSERT … ON CONFLICT DO NOTHING RETURNING` makes it idempotent and reports per id whether this request changed anything.

**15. How would you prove that the audit trigger refuses UPDATE, and what was wrong with the first check?**

Run a real `UPDATE` over existing rows inside `BEGIN … ROLLBACK` with `ON_ERROR_STOP`, and require the trigger's own message (`alarms.alarm_transition is append-only (UPDATE refused)`). The first check treated any failure as a refusal: psql's output of an accepted `UPDATE 17` went to `JSON.parse`, which threw, and that counted as "refused". A missing trigger would have passed. Also note that a row trigger fires only on affected rows, so `UPDATE … WHERE false` proves nothing.

**16. A shift report is final. Then a late fact revises one OEE hour of CNC-01 twice, and an operator edits a note. What does `revision` show?**

`inputs` 2, because each revision step of an input counts (a counter, not the highest revision). `content` rises by one for the note edit. `contentAtFinal` stays what it was at finality, so "changed after final" is `content − contentAtFinal`, which includes the note edit. The OEE numbers moved only through the late fact, never through notes or recodes.

**17. Why is the report read in the order instance row, input revisions, content?**

So that a revision can lag its content but never lead it. A note commits its `content` step with the note, and a late input revision is recorded before its effect is read. Reading the counters first means everything they count is already in the content read afterwards. An input revised between the two reads shows up in the content now and is counted as a step on a later read; it is never folded into a baseline and lost.

**18. Why replace the `detail` prefix check with problem types?**

`detail` is for people and may be reworded or translated. A client that branches on it breaks silently: a reworded "handover closed" would have been shown as a stale version. RFC 9457's `type` is the machine-readable identifier, stable by contract and listed in the OpenAPI document; the web now matches only on `type`.

**19. How does the shift report print its chart under a CSP that forbids inline styles?**

It doesn't print the canvas. On `beforeprint` the chart is drawn once without animation and exported with `getDataURL` as a PNG `data:` URL into an `<img>`, which `img-src 'self' data:` allows; the print stylesheet hides the canvas and shows the image. No inline style or script is needed, and an image doesn't reflow when the page is laid out for A4.

**20. The OEE check's latency rose to 1.9 s when the alarm check ran first. Why was this not a product defect?**

Measurements ruled out the MES and the page: no alarm topic computed during the OEE sampling, the read pool almost never waited, and the page rendered a pushed value in 11–13 ms. Full traces showed the push on time. The judge read a brief real value as stale whenever its four decimals had appeared anywhere earlier in the run, which happens more often later in the shift. Limiting "seen" to ±5 s of the sample (`seenWithin`) fixed the judge; its unit tests show lagging and frozen pages still fail.

## 4. Hands-on exercise

Raise a flood, acknowledge and shelve, and print a shift report, on a disposable stack so that nothing is written into a database you keep.

1. Start a separate project: `COMPOSE_PROJECT_NAME=shopfloor-learn pnpm stack:up` (stop your normal stack first: the ports are the same). Open <http://localhost:8080/alarms> and, in a second tab, `/alarms/kpi`.
2. See the reference cases drive the tests: in `docs/alarm-kpi-reference-cases.md`, change one digit of case 2's expected `Peak 10` and run `pnpm --filter @shopfloor/alarm-core test`. Exactly that case fails, because the tests parse the document. Revert the change.
3. Inject 12 failures on Cell M1 within 10 minutes of plant time, which is 10 s of wall time at 60×, so use a loop (during a shift, while the machines run; since #237 the control API needs its token: `export SIM_CONTROL_TOKEN=…`, the value from your `.env`):

   ```sh
   for i in 1 2 3 4; do
     for p in cnc-01:COOLANT-PRESSURE cnc-02:SPINDLE-OVERLOAD wsh-01:HEATER-FAULT; do
       curl -s -o /dev/null -X POST -H 'Content-Type: application/json' \
         -H "Authorization: Bearer $SIM_CONTROL_TOKEN" \
         -d "{\"code\":\"${p#*:}\",\"repairMs\":3000}" \
         "http://127.0.0.1:4800/api/v1/faults/failure/${p%%:*}"
     done
     sleep 0.3
   done
   ```

   Watch the rows appear, Cell M1's flood banner show and go away, and the KPI card's raises and peak rise. A machine that is not `Running` holds its injection and breaks down when it would next run, so a few raises may come a little later. The loop raises `cnc-01/COOLANT-PRESSURE` four times within about a minute of plant time (0.3 s of wall time is 18 s of plant time), so that point chatters.

4. Acknowledge one alarm from its row, select the rest and acknowledge them in bulk. Shelve one point for 15 minutes and watch it expire by itself after about 15 s of wall time (audited as `expire` by `system`); shelve another for 1 hour and unshelve it. Open an occurrence and read its history: the device raise and clear, and your audited actions.
5. Open a database shell: `docker compose -p shopfloor-learn exec db psql -U shopfloor shopfloor` (or `DB_USER` and `DB_NAME` from `.env`, if set). Run `SELECT action, actor, authenticated, plant_at, request_id FROM alarms.alarm_transition ORDER BY id;`. Then try `BEGIN; DELETE FROM alarms.alarm_transition; ROLLBACK;`: the trigger refuses it.
6. Open `/shifts`, choose the current shift, add a handover note, then edit it: its history shows both versions. Press **Print** and look at the preview: no navigation, tables in full, the chart as an image.
7. Remove everything: `COMPOSE_PROJECT_NAME=shopfloor-learn docker compose down --volumes`.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
