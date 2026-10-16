# Phase 06 – Alarms and shifts: plan

Planned 2026-10-16. Plan reference:

- section 3: shifts, breaks and the production week;
- section 4: the control API's fault injection, scenarios and ground truth;
- section 5: the UNS `alarms` class and data paths 1, 2 and 5;
- section 7: modules `alarms`, `shifts`, `master-data` and `realtime`; data model (`alarm_definition`, `alarm_occurrence`, `alarm_transition`, `shift_instance`, `crew_assignment`, `handover_note`);
- section 8: module rules;
- section 9: tests, golden scenario and reference cases;
- section 11 row 6;
- section 13 references: ISA-18.2 (alarm management).

ADRs this phase builds on: 0010 (alarms on the device; lifecycle in the MES), 0015 (identity, epochs), 0016–0023.

Size: M in the master plan; with two new modules, a new pure package and two screens it is closer to L (see Risks). Milestone: [Phase 06 – Alarms and shifts](https://github.com/kubilayture/shopfloor-twin/milestone/7).

## Scope

The MES manages alarms and shifts:

- **`alarm-core`**: a new pure package with the alarm KPIs (rates per 10 minutes, peak, floods, standing, chattering, fleeting, bad actors), in exact integer arithmetic. Hand-calculated reference cases in `docs/alarm-kpi-reference-cases.md` drive its tests.
- **Alarm definitions:** `config/plant/alarms.yaml` (code, equipment, priority, text, KPI thresholds, operator positions), seeded into `master_data.alarm_definition` and cross-checked against the alarm codes the plant can raise.
- **`alarms` module:** occurrences derived from the device's raise and clear facts (ADR-0010), with finality and revisions as for intervals; the operator lifecycle (acknowledge, shelve with a time limit, unshelve, comment) as guarded, audited writes (ADR-0023); KPIs computed on read.
- **Fault injection:** the simulator injects a named failure mode on a machine, from the control API and from a golden scenario's timeline. The injected breakdown raises its alarm like any other.
- **Ground truth:** the simulator records every alarm occurrence and computes the same KPIs with `alarm-core` (`sim-summary/3`). A second golden scenario with injected faults gives floods, chattering, fleeting and standing alarms something to reconcile.
- **`shifts` module:** shift instances as records (deferred from Phase 4), handover notes with an audit trail, and a shift report that composes OEE, downtime, production counts, alarms and notes.
- **API, push and web:** alarm list and actions, alarm KPIs, the shift report page (printable) and the handover note editor, all live.

Out of scope here:

- alarms the MES raises itself from states (`NO-OPERATOR`, material shortages; ADR-0010 allows it). Only device alarms in Phase 6;
- suppression by design, out-of-service alarms, alarm rationalisation workflows and an audible annunciator;
- publishing the MES lifecycle back to the UNS (`mes` class) or to an OPC UA A&C view (ADR-0010 option 3);
- users, roles and login: `identity` comes in Phase 7. Writes stay guarded, not authenticated, and actors are free text;
- crews from login (`crew_assignment`): actual presence needs operator login, so it waits for Phase 7;
- other injections of plan section 4 (tool breakage, sensor drift, operator absence, lot blocking), general YAML scenario playback and the console UI (Phase 9);
- retention and compression, and the `prom-client` successor (both carried).

## Decisions made in this plan

### What the plant sends today

- **Sources (ADR-0010):** every breakdown failure mode raises its code (severity 700) when the machine goes `Down` and clears it when the repair ends; LKT-01 raises `CALIBRATION-DUE` (severity 300) when calibration falls due and clears it when calibration ends.
- **UNS:** `…/{equipment}/alarms/{code}`, schema `uns.alarms/1`, value `{ code, transition: active | cleared, severity }`, retained, `scope: device`, sharing the machine's sequence with state and cycles (ADR-0015). There is no acknowledged state and no text on the wire; the OPC UA `Message` is dropped by the gateway. WSH-01's alarms come through the Modbus event ring with the same payload.
- **MES today:** ingest stores alarm facts in `ingest.equipment_event` (`event_type = 'alarm'`) and drops retained alarm deliveries (`kind: 'retained'`). The gateway's resync republishes the state, not the alarms. So an MES started on an empty database while an alarm is active never learns of it, and a clear lost in a gap leaves an occurrence open for good. Both are fixed below (anchors and the resync alarm snapshot).
- **The golden week has two alarms:** CNC-01 `COOLANT-PRESSURE` (Tue 15:34:47.821Z → 16:02:29.720Z) and `SPINDLE-OVERLOAD` (Wed 14:38:37.501Z → 15:08:42.755Z). `CALIBRATION-DUE` never falls due inside the week (interval 7 days), and shift A of Monday, the live reconciliation's shift, has none. An exact reconciliation on the golden week alone would therefore be almost vacuous; hence the injected scenario below.

### Alarm definitions and KPI configuration (`alarms.yaml`, ADR-0024)

- **Definitions:** one per (equipment, code): priority (`high`, `medium`, `low`), text and an optional consequence and response for the operator. Defaults: `SPINDLE-OVERLOAD` and `HEATER-FAULT` high, the other failure codes medium, `CALIBRATION-DUE` low. The wire severity is kept and shown, but the priority comes from the definition.
- **Vocabulary:** `alarmVocabulary` in `@shopfloor/contracts` lists every (equipment, code) a configuration can raise (failure codes from `failures.yaml`, plus `CALIBRATION-DUE` on a leak tester), as `causeVocabulary` does for causes. The cross-check in `plant-config` refuses a configuration where a raisable code has no definition, or a definition names an unknown equipment. A code that arrives without a definition (another device, a new firmware) is still stored, gets its priority from its severity (≥ 667 high, ≥ 334 medium, else low) and is flagged `undefined`.
- **Operator positions:** EEMUA 191 and ISA-18.2 measure the load per operator. There is no operator login before Phase 7, so a position is a configured set of work centers. Default: two positions, `cell-m1` and `line-a1`, one per work center, plus the plant total.
- **Thresholds**, all integers in ms or counts: `floodThreshold: 10` (a flood is more than 10 raises in 10 minutes), `windowMs: 600000`, `chatterCount: 3`, `chatterWindowMs: 60000`, `fleetingMs: 1000`, `standingMs: 86400000`, `maxShelveMs: 28800000` (8 hours, one shift). Benchmarks for colouring only (ISA-18.2 and EEMUA 191: on average about one raise per 10 minutes is acceptable and two is the most manageable, under 1 % of windows in flood, no chattering or fleeting alarms, the top 10 under 5 % of the load).
- `alarms.yaml` is loaded by `plant-config` beside `oee.yaml` and kept out of `SIMULATION_FILES`, so the run header's `configSha256` and `events.sha256` don't change; a test asserts that the hash ignores it.

### Alarm KPIs (`alarm-core`, ADR-0024)

- **Inputs:** occurrences `{ equipment, code, priority, raisedAt, clearedAt | null }` in integer ms, for one position and one epoch, and a cut-off (the caller's "final through" or snapshot time). Pure functions, no I/O. Fractions reuse `oee-core`'s exact BigInt fractions and half-up rounding; the `exactnessRules` lint applies to the package.
- **Purity rule amended (ADR-0024):** today a package in `PURE_PACKAGES` (`packages/eslint-config/src/dependency-rules.ts`) may import only relative paths. The rule is amended so that a pure package may also import another pure package by name (`@shopfloor/oee-core`, `@shopfloor/shift-calendar`), and nothing else; `alarm-core` joins `PURE_PACKAGES`. A lint test shows the import allowed from `alarm-core` to `oee-core` and still refused to any app, module or non-pure package.
- **What counts is a raise.** Every device `active` transition is one alarm, whether its point is shelved or not. Shelving is an operator action the ground truth can't know, so counting raises keeps every reconciled KPI independent of operator actions. The MES reports `shelvedRaises` and `annunciated` (raises minus shelved) beside them, not reconciled.
- **Buckets:** UTC hours and shift buckets (including `no-shift`), half-open. A raise belongs to the bucket that contains its `raisedAt`. Shifts start and end on whole hours (ADR-0021), so every shift measure is composed from its hours exactly.
- **Measures per (position or plant, bucket):**
  - `raises`, per priority;
  - **average rate per 10 minutes** = raises × `windowMs` / bucket length, an exact fraction (a shift of 8 h has 48 windows);
  - **windows:** fixed 10-minute windows aligned on the hour (:00, :10, …). `peak10` is the most raises in one window; `floodWindows` is the number of windows with more than `floodThreshold` raises. Per shift: the maximum and the sum of the hours';
  - **flood episodes** (sliding): a flood starts at the raise that makes the count in (t − 600 000, t] exceed the threshold and ends when that count drops back to the threshold, which happens exactly when the oldest counted raise leaves the window. An episode's id is (position, start time, seq of the starting raise). The flood state at t depends only on raises up to t.
    - **Per bucket,** each bucket reports what is known at its end, for every episode that overlaps it: the episode id, `floodMs` clipped to the bucket, the peak count so far (from the episode's start to the bucket's end) and `open: true` when the episode is still running at the bucket's end.
    - **Final attributes** (end, peak, raise count) belong to the bucket where the episode ends; an episode that ends exactly at a bucket boundary ends in the earlier bucket's end and the later bucket doesn't list it.
    - **Finality doesn't wait for an open episode:** the clipped `floodMs`, the peak so far and `open` at the bucket's end depend only on raises up to that end, so they are final with the bucket. A shift's `floodMs` is the sum of its hours'; its peak so far is the maximum of its hours'.
  - **standing:** occurrences still active at the bucket's end and raised at least `standingMs` before it, and `activeAtEnd` (all active at the end);
  - **chattering:** a raise at t is chattering when the raises of the same (equipment, code) in (t − 60 000, t] (`chatterWindowMs`), counting itself, number at least `chatterCount`. `chatteringRaises` and the distinct points that chattered;
  - **fleeting:** an occurrence that clears less than `fleetingMs` after its raise. It belongs to the bucket of its raise; while it is open and younger than `fleetingMs` it is undecided, so the bucket is provisional;
  - `activeMs`: the occurrences' active time clipped to the bucket.
- **Bad actors:** per scope and range, points ranked by raises descending, then `activeMs` descending, then equipment and code ascending; the top 10 with raises, share of the scope's raises (exact fraction), `activeMs` and chattering raises.
- **Window convention** (chattering and floods alike): the window ending at a raise at t is (t − window, t], so a raise exactly `window` ms earlier has left it. Several raises in the same millisecond are ordered by `seq` and all count: the second of three raises at the same t already sees two.
- **Edge cases:** a raise exactly at a window or bucket boundary belongs to the later one; a flood window needs 11 raises, 10 is not a flood; an open occurrence counts its `activeMs` up to the cut-off; a superseded occurrence (below) ends at its successor's raise.
- **Reference cases:** at least 14 hand-calculated cases in `docs/alarm-kpi-reference-cases.md`, parsed by the tests: 10 and 11 raises in a window; a sliding flood that starts in one window and ends in the next, and one across an hour and a shift boundary; chattering at 3 raises in 60,000 ms and in 60,001 ms; fleeting at 999 and 1,000 ms; standing at 24 h ± 1 ms; an alarm open at a bucket end; a flood episode open at an hour's end (clipped `floodMs`, peak so far, `open`) and its final attributes in the hour where it ends; three raises in the same millisecond; a `no-shift` bucket; a bad-actor tie on raises; a superseded occurrence; an epoch end; a lost clear closed by a resync snapshot; a late raise and a late clear with the hours whose revisions rise (below). Property tests (fast-check): Σ hours = shift for every additive measure, `peak10` ≥ any window, flood time ≤ bucket length. Coverage floor 95 / 90, as for `oee-core`.
- **Not reconciled, MES only:** time to acknowledge (plant time from raise to acknowledgement; median and 90th percentile), unacknowledged at the end, shelved points and shelved time. The ground truth knows no operator.

### Occurrences in the MES (`alarms` module, ADR-0024)

- **Ownership (ADR-0016):** schema `alarms`, migrations `NNNN_alarms_*.sql`. The module reads facts only through `Ingest`'s interface and definitions through `MasterData`'s.
- **What ingest adds** (ADR-0017 amendment):
  - an `alarm` notice after each stored alarm fact (equipment, epoch, seq, code, transition, severity, `sourceTime`, `settledSeq`), beside the existing `sample`;
  - `Ingest.alarmFacts(equipment, epoch, { code?, from?, to? })` by `seq`, for rebuilds and catch-up;
  - **alarm anchors:** a retained alarm delivery is the device's own last fact for that code, with its true `epoch`, `seq` and `sourceTime`. Ingest stores it in `ingest.alarm_anchor` (keyed equipment, epoch, code; the highest `seq` wins) instead of dropping it, sends an `alarm-anchor` notice and lists them with `Ingest.alarmAnchors()`. It still never enters the stream's dedup or gap checks (ADR-0015).
  - **alarm snapshots on resync** (gateway and ingest, #141): on every resync the gateway publishes, per equipment, an alarm snapshot `{ epoch, seq, sourceTime, active: [code…] }` (schema `uns.alarm-snapshot/1`, not retained). Over OPC UA it reads every `ShopFloor.Alarms.<CODE>.Active` (ADR-0010) in one read with the session's current `seq`; for WSH-01 it reads the equivalent active-alarm state over Modbus (the active-alarm bits beside the event ring) at the ring's current head `seq`. Ingest stores the latest snapshot per (equipment, epoch) in `ingest.alarm_snapshot`, sends an `alarm-snapshot` notice and lists them with `Ingest.alarmSnapshots()`.
  - **Old epochs:** an anchor or snapshot whose epoch is older than the newest epoch ingest knows for that equipment (from any fact, anchor or snapshot) is stored but marked stale and never used. When a newer epoch arrives later, the anchors and snapshots of the old epoch become stale at that moment.
- **Occurrence:** one per raise, keyed (equipment, epoch, raise `seq`); the API id is `{equipment}~{epoch}~{seq}`. A device sequence number never changes, so the id is stable under reordering, duplicates, rebuilds and restarts, and operator actions can be stored by it. A clear closes the open occurrence of the same (equipment, epoch, code) with the highest raise `seq` below the clear's `seq`.
- **Reordering:** facts of one (equipment, epoch, code) are few (two in the golden week), so a fact out of order rebuilds that code's occurrences from `alarmFacts` in one statement; an in-order fact appends. A clear that arrives before its raise waits in the rebuild until the raise comes.
- **Lost transitions:**
  - a raise while an occurrence of the same code is open means a clear was lost: the open one ends at the new raise, `endReason: superseded`;
  - a new epoch of the equipment ends its open occurrences at the old epoch's closing time (`interval_source.closed_at`, through `Equipment`'s interface), `endReason: epoch-ended`;
  - an anchor whose `seq` has no fact opens an occurrence from the anchor (`source: anchor`); the fact, if it arrives, has the same key and replaces it. Only anchors of the newest epoch known for the equipment are used: an anchor of an older epoch (a simulator restarted while the broker kept the old retained alarms) is ignored, and when the newer epoch arrives after the anchor was used, the anchor's occurrence ends at the old epoch's close (`epoch-ended`), like any other open occurrence of that epoch. A test starts the MES after a simulator restart with old-epoch alarms still retained and asserts that none of them is listed as active;
  - **lost clears:** an occurrence that is open while a snapshot of the same (equipment, epoch) with a higher `seq` shows its code inactive is closed at the snapshot's `sourceTime`, `endReason: lost`. A stale snapshot (older epoch) closes nothing, by the same rule as anchors. If the real clear arrives later, it replaces the snapshot's end (the occurrence's key doesn't change) and the affected hours get a revision.
- **Finality,** per (equipment, epoch): the same "final through" as equipment (ADR-0018 amendment), taken from `settledSeq` in the notices and `Ingest.settled`. An occurrence's raise is final when its time is at or below final through; its clear likewise. A KPI bucket is final when every equipment of its position has final through at or past the bucket's end plus `fleetingMs` (or its epoch is closed). Silent machines delay finality exactly as in Phase 5.
- **Revisions:** `alarms.kpi_finality` holds, per (equipment, epoch, UTC hour), when the hour became final for alarms, its raise count and clear count at that moment, and a `revision`. A late fact that changes a final hour (a gap filled after its incident) raises the revision and records the incidents, the same rule as `bucket_finality` (ADR-0018 amendment). The API reports `final`, `revision` and `incidents` per bucket.
  - **Every affected hour, not only the fact's own.** The windowed KPIs reach past the hour of the fact, so a late fact raises the revision of every final hour it can change:
    - a late raise at t: every final hour that overlaps [t, t + max(`windowMs`, `chatterWindowMs`)] (flood episodes, `peak10` and chattering of later raises), plus the hours of the occurrence's active span when it is already cleared;
    - a late clear: every final hour in its raise→clear span (`activeMs`, standing and `activeAtEnd` all change there), and the hour of the clear;
    - a lost clear closed by a snapshot, or a real clear replacing it: the hours between the two ends.
  - This is the alarm counterpart of the gaps #129 and #133 closed in Phase 5, where a late fact revised only part of the buckets it changed. Reference cases cover a late raise whose window spans an hour boundary and a late clear spanning three hours, each listing exactly which hours' revisions rise; the module test replays both after finality.
- **Derived, never edited:** `alarms.alarm_occurrence` is rebuilt from facts; nothing an operator does is stored in it. Catch-up at start-up compares, per (equipment, epoch), ingest's alarm fact count with the count the occurrences were derived from, and rebuilds what differs.

### Operator lifecycle (writes, ADR-0023 and ADR-0024)

- **States (ISA-18.2):** the device owns `active`/`cleared`, the operator owns `acknowledged` and the point's `shelved`. The list state is derived:
  - `unacked-active` and `acked-active`;
  - `unacked-cleared` (returned to normal, not acknowledged): a clear does not acknowledge, so the occurrence stays in the active list until someone does;
  - `closed`: cleared and acknowledged; it moves to history;
  - shelved: an overlay on the point; its occurrences leave the active list but keep their states.
- **Acknowledge:** `POST /alarms/{id}/ack` with `actor` and an optional `comment`; `POST /alarms/ack` acknowledges up to 100 ids in one transaction (an unknown id is 404 and nothing changes). Acknowledgement is monotonic, so it needs no version:
  - the write is one `INSERT … ON CONFLICT DO NOTHING RETURNING` into `occurrence_state`, and the audit rows are written only for the rows actually inserted, in the same transaction;
  - an id already acknowledged, or acknowledged concurrently by another request, is skipped without an audit row; the response lists per id `changed: true | false`, and the single route answers 200 with `changed: false`. The acknowledgement records wall time and the plant time (the plant clock) at that moment.
- **Shelve and unshelve,** per alarm point (equipment, code), as ISA-18.2 shelves a point, not one occurrence: `POST /alarm-points/{equipment}/{code}/shelve` with `actor`, `reason` (required), `durationMs` (1 minute to `maxShelveMs`) and `version`; `POST …/unshelve` with `actor` and `version`. Stale `version` is 409. The time limit runs in **plant time**: `until` = the plant clock at the write + duration; when the plant clock passes `until`, the module unshelves the point itself and audits it with actor `system`. A new epoch ends every shelf of the old one (`epoch-ended`), because plant time starts over.
- **Comment:** `POST /alarms/{id}/comments` with `actor` and `text` (1–500 characters); append-only, no version.
- **Storage:**
  - `alarms.occurrence_state`: acknowledgement per occurrence id, never touched by rebuilds;
  - `alarms.alarm_shelf`: the current shelf per point, with its version;
  - `alarms.alarm_transition`: the master plan's table, here the append-only audit of every MES transition (ack, shelve, unshelve, expire, epoch-ended, comment) with before, after, actor, `authenticated: false`, wall time, plant time and request id. A trigger refuses UPDATE, DELETE and TRUNCATE, as for `downtime_audit`.
- **History of an occurrence** (`GET /alarms/{id}/history`): the device raise and clear (from ingest's facts: `seq`, `sourceTime`, `receivedAt`, protocol) merged with its MES transitions, by time. This is the "complete audit trail" of the exit criteria.
- **Guards:** every write passes ADR-0023's guards unchanged (Host, `MES_WRITES`, Origin present and same-origin, `Sec-Fetch-Site`, JSON content type, 16 KiB, global rate limit). Bulk acknowledgement counts as one write for the rate limit.

### Fault injection (simulator)

- **Line:** a new `inject-failure` event `{ machine, code, repairMs? }` drives the existing breakdown path, so the machine goes `Down` with the code as its cause, raises the alarm, queues for a technician and clears on repair end.
  - **Only in `Running`:** an injected failure takes effect only when the machine is `Running`: the line halts the cycle, cancels the machine's pending clock event (cycle end) and calls `#breakDown`, exactly the order of a natural failure.
  - **Held otherwise:** in any other state the injection is held on the machine (`injection-held` event) and applied deterministically the next time the machine enters `Running`, before any other event at that time. Several held injections apply in their order, one per entry to `Running`.
  - **Guards:** a held or pending `failure` must not be lost or doubled by the paths that bypass a natural failure today, so #140 adds `failure` guards to `#tryStart`, the `stop-end` handler and `#releaseUpstream`, and an invariant test per state (Stopped, Starved, Blocked, Running, Setup, Down, PlannedStop): injected in that state, the machine breaks down exactly once, at the first entry to `Running`, and the state machine's invariants hold.
  - The earlier claim that "all invariants still hold" without changes was wrong: the breakdown path assumes a running machine, and these guards are what make it true.
  - With `repairMs` the repair takes exactly that long (at least 1 ms); without it, it is drawn from the mode's repair stream like a natural one.
  - It doesn't redraw the mode's natural time to failure.
- **Control API 1.3:** `POST /api/v1/faults/failure/{machine}` with `{ code, at?, repairMs? }`. Without `at` it applies at the next step; with `at` (simulation time, not in the past) it is scheduled as a simulation event, so a live run with scheduled injections reproduces a headless run with the same timeline. Unknown machine or code is 404; `at` in the past is 409. `GET /api/v1/faults/injections` lists them with their outcome. The route exists in every live run, like the infrastructure faults.
- **Headless:** a golden scenario's `scenario.json` may carry `injections: [{ at, machine, code, repairMs? }]`. The run header includes them only when there are any, so `week-01`'s header, and with it `events.sha256`, is byte-identical.
- **Determinism, headless and live alike:**
  - headless schedules the injections after `line.start`, in list order, exactly as the live API does when the test posts them in that order, so both put the same events in the queue with the same tie-breaking sequence;
  - an injection's `at` must not coincide with a calendar boundary (shift start or end, break start or end, planned stop); `plant-config`'s cross-check refuses such a scenario, and the control API answers 409;
  - a headless test asserts that `alarms-01`'s event log is byte-identical to `week-01`'s up to the first injection, so week-01's live evidence carries over when the live check moves to `alarms-01`.
- **Golden scenario `alarms-01`:** the week-01 seed and start, two days (Monday 06:00 to Wednesday 06:00 Istanbul), with an injected timeline that produces, by construction:
  - in shift A, from 08:00 local on Cell M1: at least 12 raises within 10 minutes across CNC-01, CNC-02 and WSH-01, with repairs of a few seconds (a flood), including three raises of CNC-01 `COOLANT-PRESSURE` within 60 s (chattering);
  - in shift A on LKT-01: one `FIXTURE-SEAL` with `repairMs: 500` (fleeting);
  - on PCK-01: one `PRINTER-FAULT` at a pinned time, Monday 16:30 local (13:30Z, inside shift B and off every calendar boundary), with `repairMs` of 33 hours (24 h plus a shift, plus margin), so it is still active at the end of Tuesday's shift B (Tue 22:00 local, 29.5 h after the raise) and standing there. Since PCK-01 is `Running` most of the time the injection is held at most briefly; the test asserts the actual raise time.
    - It occupies one of the two technicians for the whole repair, so every later breakdown in `alarms-01`, natural or injected, has one technician until Wednesday 01:30 local; and PCK-01, the end of Line A1, blocks the line upstream for 33 hours, which lowers Line A1's OEE on Monday and Tuesday. Both effects are part of the ground truth, and the shift A flood (Monday 08:00) lies before it.

  The exact times are fixed in the issue; its test asserts that the ground truth really holds at least one flood episode, one chattering point, one fleeting and one standing alarm, so the reconciliation can't pass vacuously.

### Ground truth and reconciliation

- **Simulator:** `GroundTruth` records alarm events: per machine and code, the occurrences with raise and clear times and severity. With `alarm-core` and `alarms.yaml` it computes the KPIs per position and the plant, per shift bucket and UTC hour, flood episodes, and the top 10 bad actors per shift bucket and for the run. The summary becomes `sim-summary/3` and the control API 1.3 (`/ground-truth` gains `alarms`).
  - `sim-summary/3` records `analysisConfigSha256`, a hash over `oee.yaml`, `reasons.yaml` and `alarms.yaml`: the files that shape the analysis but not the simulation, so a summary says which analysis configuration produced it while `configSha256` and `events.sha256` stay as they are.
  - `week-01/summary.json` is regenerated in that PR with a written reason: the new `alarms` section and `analysisConfigSha256` are the only changes, and `events.sha256` stays `e7c6973678bbda868839fb35850b1475072b561fd89cc286a4f0827c009b740b` (35,764 lines). A golden regeneration needs owner approval (master plan section 12); under the owner's standing instruction it is done with the written reason, and the phase report records that the approval is deferred to the owner.
  - `alarms-01` is committed with its own `summary.json` and `events.sha256`.
  - Known limit: ground truth and MES share `alarm-core`, so the reconciliation can't catch a definition bug; the reference cases are the guard, checked independently (for example with Python) in review.
- **Golden reconciliation** (`end to end` job), for `week-01` and `alarms-01`, in order and shuffled with 10 % duplicates:
  - every occurrence equals the ground truth: equipment, code, raise and clear time to the millisecond, end reason;
  - every KPI per position and plant, per hour and shift bucket, equals the ground truth exactly (counts, fractions, four-decimal strings), and so do flood episodes and bad actors;
  - every bucket is final with `revision = 0` and `incidents = 0`, with the gap grace above the replay's length;
  - the Phase 5 OEE checks run on `alarms-01` too, since injected breakdowns change availability.
- **Live** (`pnpm test:reconcile`, CI `reconcile`): before resuming the simulator, the test schedules `alarms-01`'s shift A injections through the control API with their `at` times. So the live run is `alarms-01`, not `week-01`, and the check "the live ground truth equals the golden shift A" now compares with `alarms-01`. After shift A the alarm KPIs of both positions and the plant are final and equal the live ground truth exactly. The live e2e keeps comparing states and OEE against the live ground truth, as in Phase 5; the headless prefix test above is what ties it back to `week-01`.

### Shifts (`shifts` module, ADR-0025)

- **Shift instances as records:** `shifts.shift_instance`, keyed (plant epoch, shift key). The plant epoch is the simulator's epoch, which every simulated device shares (ADR-0015); a restarted simulator replays the same shift keys under a new epoch, and the API defaults to the newest, as for OEE.
  - A row holds date, shift, start, end, breaks (from the calendar), `status` and finality: `running` while the plant clock is inside it, `ended` once past its end, `final` when the report is final.
  - Rows are created when the plant clock enters a shift; at start-up the module creates any missing rows between the epoch's first fact and the plant clock. Creating is idempotent.
  - **Shift functions:** `shiftBuckets` and `shiftInstances` move from `apps/mes-server/src/modules/oee/shifts.ts` into the pure `@shopfloor/shift-calendar`. The `shifts` module stores the instances; `oee` and `shifts` both call the pure functions, so neither module imports the other and there is no cycle. The simulator's ground truth uses the same functions.
  - The routes `/shifts` and `/shifts/current` stay where they are (`realtime`), so the API, the OpenAPI document and the web are unchanged.
- **Report finality:** the report is final when the shift's OEE bucket is final for every machine (Phase 5), every downtime record in it is not provisional, and the alarm KPI buckets of both positions are final. `final_at` and the inputs' revisions at that moment are stored. The report itself is computed on read, never stored, so it can't go stale.
- **Report revision:** a composite `{ inputs, content }`, with `revision` = inputs + content for sorting:
  - `inputs` is the maximum revision of its inputs (the shift's OEE buckets and alarm KPI buckets);
  - `content` is the report's own content version in `shift_instance`, which rises with every handover note create or edit and with every downtime recode inside the shift after the report became `final`;
  - so a revised report is visible as such, whichever part changed. The OEE numbers in a report never change through recoding (ADR-0021: recoding moves only the Pareto and the reasons); a recode changes the downtime section only.
- **Report contents** (`GET /shifts/{date}/{shift}/report[?epoch]`):
  - header: key, start, end, breaks, status, `final`, `revision`, `incidents`;
  - OEE: exactly the body of `GET /shifts/{date}/{shift}/oee` (work centers and machines);
  - downtime: the Pareto by reason for the shift, total own and external availability loss, the ten longest records with their reasons in effect, and uncoded time;
  - production: per machine produced, good, scrap and rework cycles, from the OEE inputs; finished parts (PCK-01 good) and scrap per machine;
  - alarms: per position the reconciled KPIs (raises by priority, average and peak per 10 minutes, flood windows, flood episodes, standing at the end, chattering, fleeting), the top 5 bad actors, and the MES-only figures (unacknowledged at the end, shelved points, time to acknowledge);
  - handover notes, with their edit history.
- **Handover notes** belong to a `shift_instance`, keyed (plant epoch, shift key), so a restarted simulator's replay of the same shift key gets its own notes. `POST /shifts/{date}/{shift}/notes[?epoch]` (`author`, `text` up to 4,000 characters, `category`: `safety`, `quality`, `equipment`, `material`, `general`) and `PUT …/notes/{noteId}` (`author`, `text`, `category`, `retracted`, `version`; 409 when stale). No delete: a wrong note is retracted and stays in the history. Notes can be written from the shift's start until the end of the following shift (plant time); afterwards a write is 409 (`handover closed`). Every create and edit is audited in `shifts.handover_audit`, append-only by trigger, with before, after, author, `authenticated: false`, wall and plant time and request id.
- **Format:** a web page; the browser's print view is the printable report (a print stylesheet, no server-side PDF), and the JSON is downloadable from the page.

### API, push and web

- **Read endpoints:**
  - `GET /alarms?view=active|acknowledged|shelved|history&position&equipment&priority&from&to&limit[&cursor]` (history needs a range, at most 7 days);
  - `GET /alarms/{id}` and `GET /alarms/{id}/history`;
  - `GET /alarm-points` (definitions, current shelf, active occurrence);
  - `GET /alarms/kpi?scope=plant|position&id&bucket=hour|shift&from&to[&epoch]`, with `final`, `revision` and `incidents`;
  - `GET /alarms/floods?from&to` and `GET /alarms/bad-actors?scope&id&from&to&limit` (at most 10 by default);
  - `GET /shifts/{date}/{shift}` (instance) and `GET /shifts/{date}/{shift}/report`.
- **Write endpoints** (all under ADR-0023's guards): acknowledge (single and bulk), shelve, unshelve, comment, and handover note create and edit.
- **Push:**
  - `alarms`: occurrence upserts (raised, cleared, acknowledged, superseded, shelved state) and point shelf changes; clients read `GET /alarms` first, then apply upserts by id, like `downtime`;
  - `alarm-kpi:<scope>`: the current hour and shift buckets and the flood state, at most one delta per key per second;
  - `shifts`: instance status changes and note upserts.
- **Web:**
  - **`/alarms`:** tabs Active, Acknowledged, Shelved and History; priority shown by text and colour; acknowledge one or all selected; shelve with presets (15 min, 1 h, 4 h, 8 h) and a reason; comments; the occurrence's history; a flood banner per position while the sliding count is over the threshold. The actor name is kept in `localStorage`, as on `/downtime`.
  - **`/alarms/kpi`:** cards per position (average and peak per 10 minutes, flood windows, standing, chattering, fleeting, against the benchmarks), hourly raises against the threshold line, flood episodes, top 10 bad actors.
  - **`/shifts/:date/:shift`:** the report, with the handover note editor and a print view. The shift picker is shared with `/oee`.
  - Same patterns as Phase 5 (ADR-0020 notes): shared zod schemas from `@shopfloor/contracts/mes-api`, drafts that keep the version they started from, ECharts under the CSP, no recomputation in floating point. Seven routes still fit one route file.

## Issues, in dependency order

| #                                                                | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Depends on       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| [#138](https://github.com/kubilayture/shopfloor-twin/issues/138) | Phase 6 plan (this document)                                                                                                                                                                                                                                                                                                                                                                                                                                          | –                |
| [#139](https://github.com/kubilayture/shopfloor-twin/issues/139) | `alarm-core` and alarm definitions: KPIs in exact arithmetic, `docs/alarm-kpi-reference-cases.md`; `config/plant/alarms.yaml` in `plant-config` with the cross-check against `alarmVocabulary` (contracts), out of the config hash; `PURE_PACKAGES` rule amended for pure-to-pure imports; ADR-0024 (KPI part, purity amendment)                                                                                                                                      | #138             |
| [#140](https://github.com/kubilayture/shopfloor-twin/issues/140) | Simulator: failure injection only in `Running`, held otherwise (line event with `failure` guards and per-state invariant tests, control API 1.3 `faults/failure`, scenario `injections`, calendar-boundary cross-check, prefix test against `week-01`), alarm ground truth with `alarm-core` (`sim-summary/3` with `analysisConfigSha256`), `week-01` summary regenerated with `events.sha256` unchanged, new golden scenario `alarms-01`; `docs/simulation-model.md` | #139             |
| [#141](https://github.com/kubilayture/shopfloor-twin/issues/141) | Ingest, gateway and master data for alarms: `alarm`, `alarm-anchor` and `alarm-snapshot` notices, `alarmFacts`, `ingest.alarm_anchor` for retained deliveries, stale old-epoch anchors and snapshots; gateway alarm snapshot on resync (OPC UA `Alarms.<CODE>.Active`, Modbus active-alarm state); `master_data.alarm_definition` seeded; ADR-0017 amendment                                                                                                          | #139             |
| [#142](https://github.com/kubilayture/shopfloor-twin/issues/142) | `alarms` module: occurrences from facts (pairing, reordering, superseded, epoch end, anchors, lost clears from snapshots), finality and `kpi_finality` revisions over every affected hour, KPIs on read; read API and push `alarms`, `alarm-kpi:<scope>`; golden reconciliation of `week-01` and `alarms-01`, in order and shuffled; ADR-0024 (occurrences)                                                                                                           | #140, #141       |
| [#143](https://github.com/kubilayture/shopfloor-twin/issues/143) | Alarm writes: acknowledge (single and bulk), shelve and unshelve with a plant-time limit and expiry, comments; `occurrence_state`, `alarm_shelf`, append-only `alarm_transition`; occurrence history; ADR-0024 (lifecycle), ADR-0023 note                                                                                                                                                                                                                             | #142             |
| [#144](https://github.com/kubilayture/shopfloor-twin/issues/144) | `shifts` module: shift instances as records per plant epoch, shift functions moved from `oee` into `@shopfloor/shift-calendar`, report finality and composite revisions, shift report API, handover notes with audit and the handover window; push `shifts`; ADR-0025                                                                                                                                                                                                 | #142, #143       |
| [#145](https://github.com/kubilayture/shopfloor-twin/issues/145) | Web: alarm list (tabs, acknowledge, bulk acknowledge, shelve, comments, history, flood banner) and alarm KPI page, live                                                                                                                                                                                                                                                                                                                                               | #143             |
| [#146](https://github.com/kubilayture/shopfloor-twin/issues/146) | Web: shift report page with print view and handover note editor, live                                                                                                                                                                                                                                                                                                                                                                                                 | #144, #145       |
| [#147](https://github.com/kubilayture/shopfloor-twin/issues/147) | End to end: live run of `alarms-01` shift A with scheduled injections; alarms reconciled and final; Playwright: injected alarms on `/alarms` within 2 s, acknowledged and shelved through the UI, history complete; shift A report reconciled with OEE and ground truth; write refusals                                                                                                                                                                               | #140, #145, #146 |
| [#148](https://github.com/kubilayture/shopfloor-twin/issues/148) | Close Phase 6: report, learning notes, data model, tag                                                                                                                                                                                                                                                                                                                                                                                                                | all              |

## Exit criteria (plan section 11)

1. **Reference cases:** every case in `docs/alarm-kpi-reference-cases.md` passes, as an exact count or fraction and as a display string. There are at least 14 cases, including 10 and 11 raises in a window, chattering at the window ± 1 ms, fleeting at the threshold ± 1 ms, standing at 24 h ± 1 ms, a flood across an hour and a shift boundary, a flood open at an hour's end, a superseded occurrence, a lost clear, and a late raise and a late clear with the hours they revise. `alarm-core` coverage is at least 95 / 90.
2. **Golden scenarios:** for `week-01` and `alarms-01`, in order and shuffled with duplicates, every MES occurrence equals the ground truth (equipment, code, raise and clear to the ms, end reason), and every alarm KPI per position and plant, per hour and shift bucket, equals the ground truth exactly, as do flood episodes and the top 10 bad actors. Every bucket is final with no revision and no incident. `alarms-01`'s ground truth holds at least one flood episode, one chattering point, one fleeting and one standing alarm (asserted). Its OEE also equals the ground truth, as in Phase 5.
3. **Injected faults, live:** in `pnpm test:reconcile` (shift A at 60×, the CI job `reconcile`):
   - every injected alarm appears on `/alarms` within 2 s of wall time (Playwright latency judge with its value floors), and the flood banner of Cell M1 shows;
   - the alarms are acknowledged through the UI (one singly, the rest in bulk), one point is shelved and unshelved, one gets a comment, and all clear on repair;
   - each occurrence's history holds its raise and clear (with `seq`, `sourceTime`, `receivedAt`) and every MES transition with actor and request id; nothing is missing, and the audit refuses UPDATE and DELETE;
   - after the drain, shift A's alarm KPIs for both positions and the plant are final (`revision = 0`, `incidents = 0`) and equal the live ground truth, which equals `alarms-01`'s shift A.
4. **Shift report reconciles with OEE data,** for shift A live, all 15 shifts of `week-01` and the 6 shifts of `alarms-01`:
   - the report's OEE section equals `GET /shifts/{date}/{shift}/oee` byte for byte;
   - per machine, produced, good, scrap and rework equal the OEE inputs and the ground truth;
   - the downtime Pareto sums to the own plus external availability loss;
   - finished parts equal PCK-01's good cycles; the alarm section equals `GET /alarms/kpi` for the shift;
   - the report is `final` with `revision = 0` once its inputs are, and there is one `shift_instance` per scheduled shift (15 per production week), with the calendar's start, end and breaks, also after an MES restart.
5. **Writes:** acknowledgement, shelving, comments and handover notes are audited; a stale version is 409; a note outside the handover window is 409; writes are refused with a foreign `Origin` (403), without an `Origin` (403), with a form content type (415) and with `MES_WRITES=off` (405), in tests and in the stack smoke. A note created and edited through the UI shows both versions in its history.

## Risks for this phase

| Risk                                                                                                          | Response                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope larger than the master plan's M: two modules, a package, injection, two screens                         | Strict dependency order; `alarm-core` and the injected scenario first; crews, MES-raised alarms and CSV export left out                            |
| The golden week has two alarms, so an exact reconciliation proves little                                      | `alarms-01` with injected floods, chattering, fleeting and standing alarms; its test asserts they exist                                            |
| Ground truth and MES share `alarm-core`, so a definition bug can't show in the reconciliation                 | Hand-calculated reference cases, property tests, an independent recompute in review                                                                |
| Changing the live run from `week-01` to `alarms-01` hides a regression in the Phase 5 reconciliation          | `alarms-01` keeps the Phase 5 OEE checks; `week-01` stays in the golden-week job unchanged                                                         |
| `events.sha256` changes when `alarms.yaml` or `injections` are added                                          | `alarms.yaml` out of the config hash, `injections` in the header only when present; a test asserts both                                            |
| Late facts make a final alarm hour change without a revision (Phase 5's most frequent defect)                 | `kpi_finality` per hour with counts and revisions; tests with a late fill after an incident and within the grace period, as #129 and #133 needed   |
| Occurrence pairing breaks under reordering or a lost clear                                                    | Keys by raise `seq`; rebuild per (equipment, epoch, code); `superseded` and `epoch-ended` ends; shuffled golden runs                               |
| An MES started on an empty database misses alarms already active                                              | Retained alarm deliveries stored as anchors; a test starts the MES after a raise                                                                   |
| Shelving in plant time behaves oddly when the plant clock jumps or a new epoch starts                         | Expiry checked against the plant clock; a new epoch ends every shelf, audited                                                                      |
| A silent machine (a 33-hour repair) keeps alarm buckets provisional                                           | Same bounded wait as Phase 5; the standing injection lies outside the live shift A                                                                 |
| An injection in a state other than `Running` breaks the state machine or is lost or doubled                   | Injections take effect only in `Running` and are held otherwise; `failure` guards in `#tryStart`, `stop-end`, `#releaseUpstream`; a test per state |
| A late fact changes windowed KPIs in later hours whose revision doesn't rise                                  | Revisions over [t, t + max(window)] and the raise→clear span; reference cases list the revised hours                                               |
| Retained alarms of an old epoch show as active after a simulator restart                                      | Anchors and snapshots older than the newest epoch are ignored, and end at the old epoch's close when the new one arrives later; a restart test     |
| A clear lost in a gap leaves an occurrence open for good                                                      | Gateway alarm snapshot on resync; the MES closes what it shows inactive with `endReason: lost`; same epoch rule                                    |
| Injected breakdowns queue for one of two technicians, so a repair may start late and a planned flood thin out | Fixed `repairMs` and spacing chosen against the technicians; deterministic, checked once in the headless scenario                                  |
| Unauthenticated writes before identity                                                                        | ADR-0023's guards unchanged; actors free text and audited as unauthenticated                                                                       |
| The alarm list at 60× during a flood updates faster than a person can read                                    | Upserts by id with per-key coalescing (ADR-0019); the latency judge's value floors from #123                                                       |

## Deviations from the master plan

- **New package `alarm-core`** (section 8's package list): the alarm KPIs are pure functions that both the simulator and the MES need, like `oee-core`, and they don't belong in a package named for OEE. Section 8's rule that a pure package imports nothing is amended: a pure package may import other pure packages by name (ADR-0024).
- **Section 5, UNS:** a new non-retained `alarm-snapshot` message from the gateway on resync, so the MES can close occurrences whose clear was lost.
- **Section 5, UNS `alarms` class:** the UNS carries `active` and `cleared` only; `acknowledged` and `shelved` live in the MES and are not published back in this phase (ADR-0010).
- **Section 7, `alarm_transition`:** device raises and clears stay in `ingest.equipment_event`; `alarms.alarm_transition` is the append-only log of MES transitions. The module adds `occurrence_state`, `alarm_shelf` and `kpi_finality`, and ingest adds `alarm_anchor`.
- **Section 7, "alarms per operator":** an operator position is a configured set of work centers until operators log in (Phase 7).
- **Section 7, `crew_assignment`:** deferred to Phase 7; actual presence needs login. `shifts.handover_audit` is a module-local audit until `identity`'s audit log arrives, as `downtime_audit` is.
- **Section 4, control API and scenarios:** failure-mode injection arrives in Phase 6, ahead of the Phase 9 console, and only that kind; a golden scenario's timeline is a JSON `injections` list, not general YAML scenario playback.
- **The live reconciliation** runs `alarms-01` (the golden seed with injected faults) instead of the plain week, so its shift A has alarms to reconcile.
