# ADR-0025: Shift instances, report finality, composite revision and handover notes

- Status: accepted
- Date: 2026-10-16
- Deciders: Claude (#144), within the Phase 6 plan ("Shifts", review fix 7, revision 2); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Phase 6 adds the `shifts` module (master plan section 7): shift instances as records, a shift report that composes OEE, downtime, production, alarms and handover notes, and the notes themselves. Until now a shift existed only as a calendar computation. `shiftBuckets` and `shiftInstances` sat in the `oee` module (`modules/oee/shifts.ts`), the API's `/shifts` routes called them from `realtime`, and the alarm KPIs and the simulator had their own copies of the hour helpers and of the `no-shift/{start}` key (ADR-0024).

The questions:

- where do the calendar functions live, so that `oee` and `shifts` use them without either module importing the other;
- what is stored for a shift, and per which epoch;
- when is a report final, and how does a reader see that a final report changed later, when its inputs (OEE, alarm KPIs) have their own revisions and notes and recodes change it too;
- how notes are written, versioned and audited before `identity` (Phase 7);
- how a client follows a report live.

## Considered options

1. **Calendar functions:** (a) keep them in `oee` and let `shifts` import `oee`'s; (b) move them into the pure `@shopfloor/shift-calendar`.
2. **Report:** (a) store the report when it becomes final (a snapshot); (b) compute it on read and store only its finality and revision.
3. **Revision:** (a) one number, the highest revision of the inputs; (b) one counter for everything; (c) a composite `{ inputs, content }` of two stored counters.
4. **Push:** (a) a paced `shift-report:<key>` topic with whole reports as deltas; (b) a `shifts` topic with instance and note upserts, the live numbers from the existing `oee:<id>` and `alarm-kpi:<scope>` topics.

## Decision outcome

Chosen: 1b, 2b, 3c and 4b.

### The calendar functions are pure (1b)

`hourStart`, `hourEnd`, `shiftBuckets`, `shiftInstances` (`ScheduledShift`, renamed from the `oee` module's `ShiftInstance`, which collided with the package's own `shiftAt` type), `shiftInstance`, `nextShift` and `noShiftKey` are in `@shopfloor/shift-calendar` (`src/instances.ts`). `oee` and `shifts` both call them; neither module imports the other (`shifts` reads `oee` through its `index.ts`, never the reverse). The alarm KPI buckets and the simulator's ground truth (`alarm-truth.ts`, `oee-truth.ts`) use the same `hourStart`, `hourEnd` and `noShiftKey` instead of their copies. The move is behaviour-neutral: the `oee` tests moved unchanged, a property test checks that the buckets tile a range in whole hours keyed as `shiftKeyAt` keys them and that the scheduled shifts are exactly the buckets that are not `no-shift`, the OpenAPI document only gained paths, and `pnpm test:golden` is byte-identical. The routes `/shifts`, `/shifts/current` and `/shifts/{date}/{shift}/oee` stay in `realtime` with the same responses.

### Shift instances are records per plant epoch

`shifts.shift_instance` is keyed (plant epoch, shift key). The plant epoch is the simulator's epoch, which every device shares (ADR-0015): a restarted simulator replays the same keys under a new epoch, and they get their own rows and notes. The API defaults to the newest epoch that has the key.

- A row holds the calendar's date, shift, start, end and breaks, and `status`: `running` while the epoch's plant clock is inside it, `ended` once the clock is at or past its end (or a newer epoch began), `final` when the report is final. `final` never goes back.
- Rows are created when the plant clock enters a shift: a shift starting at 06:00:00.000 has begun only once the clock is past that instant (the convention of `/shifts/current`). At start-up the module creates the missing rows from the epoch's first stored interval up to the clock. Creating is `INSERT … ON CONFLICT DO NOTHING`, so a restart creates nothing twice (tested; the golden reconciliation asserts 15 rows for `week-01` and 6 for `alarms-01`, with the calendar's start, end and breaks, before and after a restart).

### The report is computed on read; finality and revision are stored (2b)

`GET /shifts/{date}/{shift}/report` composes, in one read:

- **OEE:** exactly the body of `GET /shifts/{date}/{shift}/oee` (one DTO function builds both);
- **downtime:** the Pareto by reason of all work centers (it sums to the own and external availability loss), the ten longest records with the reasons in effect, the record count and the time still `UNCODED`;
- **production:** per machine produced, good, scrap and rework from the OEE inputs; finished parts are the good cycles of the line's last machine (PCK-01); total scrap;
- **alarms:** per position and the plant, the KPIs of the shift bucket (equal to `GET /alarms/kpi`: raises, rates, flood windows and episodes, standing and active at the end, chattering, fleeting), the top 5 bad actors, and the MES-only operator figures of the shift bucket from `Alarms.operatorMeasures` (#143, equal to `GET /alarms/operator-kpi`): shelved and annunciated raises, time to acknowledge (count, sum, longest), unacknowledged at the shift's end and shelved time per point. The ground truth knows no operator, so these are not reconciled, and they are no input of finality;
- **notes:** every note with its history;
- `generatedAt` (wall) and `asOf` (the epoch's plant clock), for a printout.

**Finality:** the report is final when the shift has ended, the OEE bucket of every machine and work center is final (Phase 5), no downtime record of the shift is provisional, and the alarm KPI shift bucket of the plant and every position is final (ADR-0024). A shift whose machines are not proved past its end stays `ended` (the golden week's Friday shift C, `alarms-01`'s last shift), as the buckets themselves do. When the module first sees all inputs final it stores `final_at` and the inputs' revisions at that moment (`final_inputs`).

### The composite revision (3c)

`revision: { inputs, content }`, both stored counters on `shift_instance`:

- **`inputs`** starts at 0 when the report becomes final and rises by one for every revision step of an input after that. An input is one OEE hour of one machine (its `bucket_finality` revision, read through `Equipment.stateHourly`) or one alarm KPI hour of one scope (`alarms.kpi_revision`, through `Alarms.kpis`). The module keeps the revisions it has counted (`seen_inputs`) and adds Σ max(0, now − seen) per input. It is a counter, not a maximum: two changes in different inputs, or two changes of one hour, never collapse into one. A revision an input already had when the report became final is the baseline, not a step.
- **`content`** rises by one for every handover note create or edit (in the note's transaction), and for every operator recode (`DowntimeCoding` change of kind `coded`) inside a shift whose report is final. A clip after a re-cut (`clipped`) is not a recode: the late fact behind it moves `inputs`.
- **Operator writes after final (#143).** An acknowledgement of an occurrence raised in a final shift changes that shift's time to acknowledge, so it is one `content` step (per occurrence acknowledged; a bulk acknowledgement of three raises of the shift is three). Unacknowledged-at-end can't change: it is taken at the shift's end. A shelve, an unshelve or a shelf's expiry happens at the plant clock, after every ended shift, so it can't change a final report's shelved raises or shelved time and is no step; nor is a comment, which the report does not show. Before final, operator writes count nothing: the report is not final yet.
- **OEE never changes through recoding** (ADR-0021: reasons move only the Pareto and the reason view). A recode changes the downtime section, which is why it counts in `content`, not `inputs`.

The counters move in the background and on every report read:

- **Background, bounded:** an alarm finality move (nearly every fact) marks only reports not final yet; a final report is evaluated again only when an input in its range may have changed (an OEE change carries its hours; an alarm occurrence change reaches from an hour before its raise to an hour after its end, or after the plant clock while it is open). Ended reports not final are also checked every 10 s. At start-up only reports not final are evaluated.
- **On read:** a read that finds the inputs final or revised further than stored brings the row up to date under its row lock (concurrent reads count a step once).
- **Read order: a revision may lag its content, never lead it.** A report reads the instance row (its `content` counter) first, then the input revisions, then the content (OEE, records, alarms, notes), and judges finality on that content. A note commits its `content` step with the note, and a recode is committed before its step, so the content read later includes every step already counted; an input revised between the revision read and the content read shows in the content now and is counted as a step of `inputs` on a later read, never lost in a baseline. The report serves the revision of its own early reads even when a concurrent read stored a higher one. The background evaluation reads the revisions before the finality likewise.
- **Push only forward:** an instance change is pushed only when status, `inputs` and `content` are each at least as high as the last pushed and one is higher, so interleaved writers can't leave a client on an older revision.

### Handover notes

`shifts.handover_note` belongs to a shift instance (epoch, key): category (`safety`, `quality`, `equipment`, `material`, `general`), text (1 to 4,000 characters), `created_by` and `author` (free text, unauthenticated), `retracted`, `version`, wall and plant times. At most 200 notes per instance (422 beyond).

- `POST /shifts/{date}/{shift}/notes[?epoch]` creates; `PUT …/notes/{noteId}` writes a new version with `version` (409 when stale). There is no delete: a wrong note is retracted (and can be restored) and stays in the history. A trigger refuses DELETE and TRUNCATE on the notes.
- **Handover window,** in plant time: from the shift's start until the end of the following shift (Friday's night shift until Monday's shift A ends). Outside it a write is 409 (`handover closed`); with no plant clock for the epoch too. A newer epoch closes the handover of every older one: the old epoch's clock stands still (and is unknown after a restart), so its notes would otherwise stay writable until the MES restarts.
- **Audit:** every create and edit is a row of `shifts.handover_audit` with before (null for a create), after, actor, `authenticated: false`, wall time, plant time, request id and the version after the change; append-only by trigger (UPDATE, DELETE and TRUNCATE refused), as `downtime_audit` (ADR-0023). `GET …/notes/{noteId}/audit` and the report's note history read it, newest first.
- Every write passes ADR-0023's guards unchanged (Host, `MES_WRITES`, `Origin`, `Sec-Fetch-Site`, JSON, 16 KiB, the global rate limit). Write routes may now declare query parameters (`?epoch`).

### Push (4b)

A `shifts` topic carries `{ type: 'shift', event: created | status | revised, shift }` keyed per (epoch, shift key) and `{ type: 'handover-note', event: created | edited, note }` keyed per note, coalesced per key like `alarms` and `downtime`. A client reads the report once and again when its instance's `status` or `revision` moves; while a shift runs, its live numbers come from `oee:<id>` and `alarm-kpi:<scope>`, which are already paced at one delta a second. A paced `shift-report:<key>` topic would recompute a whole report (eight module reads) every second for numbers those topics already push.

### Printing

The print view is the web page with a print stylesheet (#146). The API adds what a printout needs and the page can't know: `generatedAt` and `asOf`. The JSON download is the report as served.

### Consequences

- Good: no module cycle, and one calendar implementation for the MES and the ground truth. A report can't go stale, and whether it changed after it was final is visible, and by which kind of change.
- Good: notes per (epoch, key) keep a restarted simulator's replay apart; the window keeps notes about a shift with the people who worked it and the next crew.
- Bad: the report is eight reads (OEE, records, Pareto per work center, alarm KPIs and bad actors per scope, the input revisions); fine for a page, too heavy for a paced topic, hence 4b.
- Bad: an alarm KPI hour without activity is not listed by `Alarms.kpis`, so its revision is not seen; a late fact that changes an hour makes it active, so in practice none is missed.
- Bad: a report read may write (the counter catch-up), on the main pool.
- Good: the MES-only operator figures of #143 sit beside the reconciled KPIs without touching finality; only an acknowledgement after final moves the report, as `content`.
