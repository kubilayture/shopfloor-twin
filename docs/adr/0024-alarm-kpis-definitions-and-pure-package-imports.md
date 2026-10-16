# ADR-0024: Alarm KPI definitions, exact arithmetic and pure-package imports

- Status: accepted (KPI part and purity amendment, #139; occurrences, #142); the lifecycle part follows with #143
- Date: 2026-10-16
- Deciders: Claude (#139), within the Phase 6 plan; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Phase 6 must show alarm KPIs (ISA-18.2, EEMUA 191) that equal the simulator's ground truth exactly, per operator position and for the plant, per UTC hour and per shift bucket (Phase 6 exit criteria 1–3). ISA-18.2 names the measures (average and peak rate per 10 minutes, floods, standing, chattering and fleeting alarms, bad actors) but leaves open:

- what counts (a raise, an annunciated alarm, an acknowledged one) and where a measure belongs when it spans a bucket boundary;
- how a sliding flood is cut into hours and shifts while it is still running, so that a bucket can be final before the episode ends;
- the exact window convention, ties in one millisecond, and what an open occurrence counts;
- which hours a late fact can change (Phase 5 showed that revising only the fact's own hour misses buckets);
- where the code lives: both the simulator and the MES need it, it must not use floating point, and `oee-core`'s exact fractions should not be copied;
- where the thresholds and the alarm definitions live without changing the simulator's golden event log.

## Considered options

Package: (a) extend `oee-core`; (b) a new pure package `alarm-core` that copies `oee-core`'s fractions; (c) a new pure package that imports `oee-core`, which needs the purity rule (plan section 8, ADR-0005) amended.

What counts: (a) every device raise; (b) annunciated raises (not shelved); (c) acknowledged alarms.

Flood: (a) fixed 10-minute windows only; (b) sliding episodes only; (c) both: fixed windows for the rate and peak, sliding episodes for floods.

Configuration: (a) thresholds in `failures.yaml`; (b) a new `config/plant/alarms.yaml`, loaded by `plant-config` and kept out of the simulator's config hash.

## Decision outcome

**Package: (c).** `@shopfloor/alarm-core` is pure (no I/O, no Node.js built-ins, no third-party packages) and joins `PURE_PACKAGES`. Ratios are `oee-core`'s reduced BigInt fractions with half-up rounding; `exactnessRules` covers `alarm-core` too (no `Math`, `/`, decimal literals or `parseFloat`).

**Purity rule amended.** A pure package may import, besides relative paths, another pure package by its exact name (`@shopfloor/oee-core`, `@shopfloor/shift-calendar`, `@shopfloor/sim-core`, `@shopfloor/alarm-core`), and nothing else: not a subpath, not a non-pure workspace package (`contracts`, `plant-config`), not an app. Purity stays transitive, because every allowed import is itself pure. `dependency-rules.test.ts` shows `alarm-core` → `oee-core` allowed and `alarm-core` → `plant-config`, `node:fs` and an `oee-core` subpath refused. This amends ADR-0005's allowlist.

**What counts: (a), raises.** Every device `active` transition is one occurrence, shelved or not. Shelving is an operator action the ground truth can't know, so counting raises keeps every reconciled KPI independent of operators; the MES reports shelved and annunciated raises beside them, not reconciled.

**Inputs.** Occurrences `{ equipment, code, priority, seq, raisedAt, clearedAt | null, clearKind? }` in integer ms, for one scope (a position or the plant) and one epoch, and a horizon: `asOf`, the time through which every fact is known (the MES's "final through", the simulator's snapshot time), and `closedAt` once the epoch has ended. Raises after `asOf` are unknown and ignored; a clear after `asOf` is open. `prepare` normalises them:

- **Order:** time, then equipment, then `seq`, then code. `seq` orders one device's raises in one millisecond; sequence numbers are per device, so they never order raises of two devices (equipment does). Only the order of `seq` within a device matters, and that is the device's emission order: the OPC UA machine server numbers every event it emits in order (`#next` in `apps/simulator/src/opcua/machine-server.ts`), and so does the washer's Modbus event ring (`washer-server.ts`). The simulator's ground truth (#140) can therefore use any number that rises with the machine's event order, such as its per-machine event index, and gets the same order as the MES with the device `seq`.
- **Superseded:** an occurrence still open at its point's next raise ends there (a lost clear).
- **Epoch ended:** in a closed epoch, what is still open ends at `closedAt`, and so does a running flood episode.

**Buckets.** Half-open ranges on whole UTC hours: hours, shifts and `no-shift` stretches. A raise belongs to the bucket that contains its `raisedAt`; time measures are clipped to the bucket and, while it is not over, to `asOf`. Shifts start and end on whole hours (ADR-0021), so `composeBuckets` builds a shift from its hours exactly; a property test checks that a multi-hour bucket computed directly equals the composition of its hours, for every field.

**Shift bucket keys (#140, binding for #142).** Shift instances are keyed `2026-10-12/A`. A `no-shift` stretch is its own bucket, keyed `no-shift/{start}` with the stretch's start by the calendar (the last shift end at or before it, looked up within 7 days; if no shift ended in those 7 days, the stretch's start in the run), for example `no-shift/2026-10-17T03:00:00.000Z`. Standing and `activeAtEnd` are taken at a bucket's end, so the bucket must be contiguous; this differs on purpose from the OEE buckets and `/ground-truth`'s `buckets`, which collect every gap in one plain `no-shift`. Hours are listed when something happened in them, and the hour in progress always (provisional); any other hour is the empty bucket.

**Window convention.** The window ending at t is (t − window, t]: a raise exactly one window earlier has left it. Several raises in one millisecond all count, in raise order, so the second of three already sees two.

**Measures per bucket:**

- `raises` and `byPriority`;
- `averageRate` = raises × `windowMs` / bucket length, an exact fraction over the whole bucket (48 windows in an 8-hour shift);
- fixed windows aligned on the hour: `peak10`, the most raises in one, and `floodWindows`, those with more than `floodThreshold` (11 is a flood, 10 is not);
- **flood episodes, sliding:** the count at instant t is the raises in (t − `windowMs`, t]. An episode starts at the raise that makes it exceed the threshold and ends at the first instant where it is back at the threshold or below, which is when its oldest counted raise leaves. At one instant the raises that leave go first, then that instant's raises arrive; the flood state is the count after all of them, so an episode whose last counted raise leaves exactly when another arrives goes on. An episode covers [start, end): a raise that arrives at its end instant was never in flood and is not one of its raises. The id is `{startAt}~{equipment}~{code}` of the starting raise, and the MES adds the scope. Episodes of one scope never overlap, so the start alone is unique; the id needs no device `seq` (the plan said start and seq), so the ground truth and the MES agree on it by construction.
  - **Per bucket,** each episode in flood at a known instant of the bucket is listed (an open one only once the bucket has begun by `asOf`, so a bucket after `asOf` lists none) with `floodMs` clipped to the bucket, its peak from its start to the bucket's end, and `open` when it is still in flood at the bucket's end. The final attributes (end, peak, raises from the starting raise) belong to the bucket where it ends; one that ends exactly at a boundary ends in the earlier bucket and the later one doesn't list it.
  - The flood state at t depends only on raises up to t, so these values are final with the bucket, whether or not the episode has ended.
- **standing:** active at the bucket's end and raised at least `standingMs` before it; `activeAtEnd` counts every active one;
- **chattering:** a raise whose point raised at least `chatterCount` times in (t − `chatterWindowMs`, t], itself included; `chatteringRaises` and the distinct `chatteringPoints`;
- **fleeting:** a device clear less than `fleetingMs` after the raise, in the raise's bucket. A superseded or epoch-ended occurrence is not fleeting (it didn't clear), and neither is a lost clear (`clearKind: 'lost'`, end reason `lost`): a resync snapshot's time is not the device's clear time. An open occurrence is `undecided` while a clear could still come in time (raise + `fleetingMs` − 1 > `asOf`), and its bucket is provisional;
- `activeMs`: active time clipped to the bucket, an open occurrence up to `asOf`;
- `provisional`: the bucket is not over at `asOf` (in an open epoch), or a fleeting raise is undecided.

**Bad actors.** Per scope and range, the points with raises in the range, ranked by raises descending, then `activeMs` descending, then equipment and code ascending; the top 10 with raises, share of the scope's raises (exact fraction), `activeMs` and chattering raises.

**Revisions (`revisionSpans`, `revisedHours`).** A late fact revises every hour it can change, given the scope after the fact; the caller intersects the result with its final hours. Pass the plant scope: every position's flood lies inside one of the plant's episodes, because the plant's count is never lower. Floods are scope-wide, so a late fact on one machine revises the hours of its position and of the plant, not only that machine's; the MES (#142) records revisions per position and plant hour accordingly, and a shift's revision follows from its revised hours. A property test replays random late raises and moved ends and checks that every hour (and bad-actor range) whose KPIs change, in the plant and each position, is among the revised hours.

- **A late raise at t:** [t, t + max(`windowMs`, `chatterWindowMs`)] (windows, floods and the chattering of later raises); its active span to its clear, or to the limit while open; the span of an earlier open occurrence of its point that it now supersedes; and every flood episode in flood during [t, t + `windowMs`], to its end. The last two go beyond the plan's rule: a late raise can end an earlier occurrence (superseded), and it can join two episodes into one, which changes the id and peak of every later hour of the joined episode, however far after t (reference case 20).
- **A moved end** (a late clear, a resync snapshot closing a lost clear, or a real clear replacing the snapshot's end): from the raise to the later of the two ends, an open end counting as the limit. This includes the plan's raise→clear span and its "hours between the two ends", and also the hours after a late clear that showed the occurrence active (reference case 19).
- Spans are closed: a fact whose span ends exactly on an hour boundary revises that hour too, as the plan states.

**Configuration: (b).** `config/plant/alarms.yaml` holds the KPI thresholds (`floodThreshold` 10, `windowMs` 600 000, `chatterCount` 3, `chatterWindowMs` 60 000, `fleetingMs` 1 000, `standingMs` 86 400 000), `maxShelveMs` (8 hours), benchmarks for colouring (integers), the operator positions (work centers) and one definition per (equipment, code) with priority, text, consequence and response. `plant-config` loads it beside `oee.yaml` and `reasons.yaml`, outside `SIMULATION_FILES`, so `configSha256` and `events.sha256` don't change; the simulator's test asserts that changing it leaves the hash equal to the golden summary's. The cross-check refuses: a window that doesn't divide an hour, a shelving limit under a minute, positions over unknown work centers or with a work center twice or not at all, `plant` as a position id, duplicate definitions, definitions on unknown equipment, and any alarm the plant can raise without a definition. That vocabulary is `alarmVocabulary` in `@shopfloor/contracts`: every failure-mode code per equipment (severity 700) and `CALIBRATION-DUE` (severity 300) on the leak tester; the simulator now takes its calibration alarm constants from there. A code without a definition (another device, new firmware) is still stored by the MES and gets its priority from its severity with `priorityFromSeverity` (≥ 667 high, ≥ 334 medium, else low).

**Reference cases.** `docs/alarm-kpi-reference-cases.md` holds 22 hand-calculated cases (occurrences, horizons, buckets, episodes, bad actors, revised hours), recomputed independently by a brute-force Python script that counts the window at every instant; `alarm-core`'s tests parse that file, so the documentation and the tests can't disagree. A property test checks the flood episodes against the same brute-force count.

### Consequences

- Good: the simulator and the MES share one pure implementation and one configuration, so a difference between them can only come from data; results are exact.
- Good: a bucket's flood values are final with the bucket, so finality never waits for a long flood.
- Good: pure packages can share code without copying it, and purity is still checked by the linter.
- Bad: the reconciliation can't catch a definition bug that both sides share; the reference cases and the independent recomputation are the guard.
- Bad: revisions over flood episodes can reach many hours for a long flood; that is correct, and late facts are rare.
- Revisit if operators log in (Phase 7): positions then follow crews, not work centers.

## Occurrences in the MES (#142)

Implementing the plan's "Occurrences in the MES" left open where the pairing runs, how far a stored occurrence reflects anchors and snapshots that later become stale, what is stored for finality and revisions, which horizon the KPIs on read use, and how the API lists buckets.

### Decision

- **Derivation, pure and per (equipment, epoch):** the alarm facts by `seq`, the retained anchors whose `seq` has no stored fact, the latest snapshot (only once the device stream is settled up to its `asOfSeq`, ADR-0017 amendment) and the epoch's close go through one pure function (`deriveOccurrences`): per code a raise opens an occurrence and ends an open one (`superseded`), a clear ends the open one (`cleared`), a clear with nothing open is ignored; a snapshot ends an occurrence raised below `asOfSeq` that is open (or only superseded later) and whose code it shows inactive (`lost`, a device clear wins); a closed epoch ends the rest (`epoch-ended`). The module keeps each open epoch's facts in memory, so a reordered fact re-derives without reading ingest's tables; it compares the result with the stored rows and writes only the difference, with the source row, in one transaction.
- **Used anchors and snapshots stay used:** `alarms.occurrence_source` records the anchors and the snapshot an epoch was derived from while they were not stale. When a newer epoch makes them stale later, they stay part of the old epoch's history (its anchor occurrence ends `epoch-ended`, a lost clear stays closed); one that arrives stale is never used. The close time is the equipment module's (`Equipment.epochEnd`, `interval_source.closed_at`), else the old epoch's watermark, else the latest time the epoch knows. Since ingest awaits its listeners in order and `Alarms` starts after `Equipment`, the equipment module has closed the epoch before the alarms module hears of the newer one.
- **Finality computed, revisions stored (deviation):** the plan's `kpi_finality` held, per (equipment, epoch, hour), when the hour became final with its raise and clear counts. Instead, final through per (equipment, epoch) is tracked exactly as in equipment (ADR-0018 amendment: `settledSeq` of the state, cycle and alarm notices, `Ingest.settled` on a jump, and after a jump ingest's alarm facts are compared with the applied ones before anything counts as final), and a bucket of a scope is final when every equipment of the scope is final through its end plus `fleetingMs` (or its epoch is closed). Only revisions are stored: `alarms.kpi_revision` per (scope, epoch, hour), scope `plant`, `position:<id>` or `equipment:<id>`; no row is revision 0. `occurrence_source.final_through` keeps what was final when last written (about once an hour per equipment), so a late fact found at start-up revises by what was final before the restart.
- **Which changes are late:** a stored change can only alter buckets that contain instants at or after its earliest effect (a raise's time; for a moved end the earlier of the two ends, or the raise when it turns fleeting or stops being so). Only a change whose earliest effect lies before the end of some scope's last final hour is late; it then goes through `revisionSpans`/`revisedHours` over the plant scope, and the result is intersected with each scope's final hours. A fact above final through never is (the in-order path reads nothing for revisions), and neither is an epoch's close, which lies at or after everything final. Without that guard the flood rule (an episode in flood during [t, t + window], from its start) revised final hours on every in-order raise that joined a running episode begun before them.
- **Horizon on read:** `asOf` is the epoch's watermark (the plant clock, or the latest stored time if later); `closedAt` once every member's epoch is closed. This is the ground truth's `now` at the end of a run, so the reconciled KPIs (including `provisional` and the hour in progress) are equal; `final` is the MES's own answer.
- **Reading a range:** occurrences raised from a cut before the range, and those still active at the cut; the cut starts 2 h (at least two windows) before and moves back until no flood episode is in flood one window after it. The flood state at an instant depends only on the raises in the window before it, so from there on every episode, window and chattering flag equals what all of the epoch's raises give. Stored ends are passed to `alarm-core` as clears, a non-device end (`lost`, `superseded`, `epoch-ended`) with `clearKind: 'lost'`, so it is never fleeting.
- **Buckets listed:** hours where something happened and the hour in progress; shift buckets are every shift instance and `no-shift/{start}` stretch overlapping the range that has begun by the plant clock, `no-shift` stretches clipped to the range (as the ground truth clips them to its run). Scopes are the plant, the positions and, beyond the plan, each equipment.
- **Known limit:** a bucket whose machines all fall silent at or before its end plus `fleetingMs` stays provisional until one of them reports again (a fact at the boundary instant itself, or within a second after it, could still change open floods, active-at-end and fleeting). In the golden week that is Friday's shift C (every machine shuts down exactly at its end) and the weekend; in `alarms-01`, which ends with machines running, Tuesday's shift C.

### Consequences

- Good: an occurrence's key and content depend only on the device's facts, anchors and snapshots, so in-order, shuffled and duplicated deliveries store identical rows (the golden reconciliations compare them).
- Good: the in-order path costs one write transaction per alarm fact and nothing per state or cycle fact, apart from about one source write per hour per equipment.
- Bad: finality is not stored, so the moment an hour became final is not recorded (the plan's `final_at`); a revision is raised only for hours final at the late fact's arrival.
- Bad: reading a scope's KPIs reads its occurrences from two hours before the range (more during a long flood); fine for the plant's alarm rates, to be bounded if alarm volume grows by orders of magnitude.
