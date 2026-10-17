# ADR-0031: Execution: units from cycle facts, completion when no unit can return, confirmations from final data

- Status: accepted
- Date: 2026-10-17
- Deciders: Claude (#175), within the Phase 7 plan ("Routing execution per part", "Completion (H1)", "Confirmations to the ERP", review decisions H1 and H2); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

From Phase 7 the MES runs orders (ADR-0028 to ADR-0030): it dispatches jobs to the CNCs and proves them by the device's job facts. It must now follow every part through OP10–OP50, know per order and operation what was produced, scrapped, reworked and consumed, decide when an order operation is complete, and tell the ERP once, with corrections when a late fact changes what it said. The facts are the only source: cycle facts carry the part (`partId`, the serial once OP10 set it, none at WSH-01), the result and its completion time, never a start; facts arrive reordered and duplicated, and a gap can be written off as an incident and filled later (ADR-0017, ADR-0018).

The questions:

- what identifies a part, and how a part is attributed to an order;
- how passes, rework and routing breaks are read without refusing a fact;
- when an order operation is complete, given that a leak-test failure sends a unit back to OP30;
- what is backflushed and when;
- what a confirmation carries, and how a late fact changes it;
- what the MES's WIP is, given that no fact says a part left a buffer.

## Considered options

1. **Identity:** (a) the serial; (b) (device epoch, `partId`), the serial an attribute.
2. **Attribution:** (a) the job active at the cycle's time; (b) the job whose `started` fact is the latest below the OP10 cycle in the CNC's device sequence.
3. **Storage:** (a) incremental counters per order operation; (b) units and one record per cycle fact, rebuilt from facts per unit; quantities on read.
4. **Routing breaks:** (a) refuse or repair the fact; (b) keep every fact and flag the unit, judged once the facts that could explain it are final.
5. **Completion:** (a) per operation when its units passed it; (b) H1: an operation is complete only when no unit can still come back to it, on final data.
6. **Confirmations:** (a) per shift; (b) one final confirmation per order operation once complete, corrections with deltas judged against the sum of what was sent.

## Decision outcome

Chosen: 1b, 2b, 3b, 4b, 5b and 6b.

### Units and attribution (1b, 2b)

A unit is keyed (device epoch, `partId`): `partId` is the simulator run's counter shared by every machine (ADR-0030), so it is unique within an epoch and restarts with the simulator; serials repeat across runs, and Phase 8's genealogy owns serial identity. WSH-01 is followed by `partId` alone. A unit's OP10 cycle belongs to the job whose `started` fact is the latest one below it in that CNC's sequence: one part at a time on a CNC, so the rule is exact and independent of arrival order. Every later record of the unit inherits the order. A unit whose OP10 cycle or job fact has not arrived yet has no order and counts nowhere.

### Records, passes and routing breaks (3b, 4b)

`execution.operation_record` holds one row per cycle fact of a unit, keyed by the fact (equipment, epoch, seq): operation, pass, completion time (the fact's `sourceTime`), result, reason, order. Passes are counted in plant-time order: a leak-test `rework` opens pass 2 at OP30 and OP40. A unit is rebuilt from all of its cycle facts whenever one of them arrives, and the OP10 cycles after a new `started` fact are rebuilt with their units, so a reordered fact renumbers passes and re-attributes units by rebuilding, never by patching.

Facts are never refused. A record after the unit was packed or scrapped is an `after-terminal` violation at once. A record where another operation was expected is a suspect: `missing-predecessor` (later in the routing) or `repeated` (earlier, such as a second OP30 pass without a leak-test failure before it). A suspect becomes a violation, with an incident (`execution.execution_incident`, `routing-violation`), only once every machine of the expected operation is final through the record's time (ADR-0018), because until then the fact that makes the routing whole may still arrive. A late fact that resolves it closes the incident.

### Quantities and backflush (H2)

Per order operation, on read: `in` (completed cycles, every pass) = `good` + `scrap` + `rework`, scrap per reason, rework (results that sent a unit back), and material backflushed from the order's BOM per completed cycle: the operation's `standard` lines on a first pass, its `rework` lines on a later one. So a blank is booked with each OP10 cycle whatever its result, components with each OP30 cycle of that pass, which is the ground truth's consumption booked at cycle completion. Material taken for a cycle still running is invisible to the MES and not reconciled (`materialInProcess`).

### Completion (5b, H1)

- **OP10** when the order's jobs are done: every command settled, every job `completed` with its CNC final through the `completed` fact, and each OP10 cycle between the job's `started` and `completed` facts a unit of it. A job lost with its run counts only once a later command (a re-dispatch) exists, an abandoned command always: a lost job alone keeps the order open for the supervisor (ADR-0029).
- **OP20** when every unit passed it for good or was scrapped.
- **OP30 and OP40** only when every unit passed OP40 for good or was scrapped: a unit with one leak failure can still come back to both.
- **OP50** when every unit is packed or scrapped; a unit lost with its device run counts as done for every operation.
- Every record an operation's completion rests on is at or below its machine's final-through. The completion time is the operation's latest record (OP30 and OP40 together), never before the previous operation's. The order is completed (`Orders.complete`, `completed` posted, `short` when packed good < quantity) when OP50 is.

### Confirmations (6b)

When an order operation is complete, `Orders.confirm` writes, in one transaction with its outbound message (`orders.erp_message_log`, key `confirmationKey`), a final confirmation (n = 1): yield (good), scrap per reason, rework passes (rework results at the operation), material backflushed at it, `confirmedAt` the completion time. Each confirmation stores the totals it sums to (`orders.confirmation.totals`, append-only by grants). Whenever the totals computed from the facts differ from the last stored totals, a correction (n + 1) carries the signed deltas. Completion rests on final data, so a correction can only come from a fact the final-through had written off (a gap closed as an incident) and that arrived later. The outbox posts them in order; a 409 is an `erp-conflict` incident, never retried (ADR-0028). Corrections are allowed after `completed` and `closed`.

### WIP

A unit in WIP has a routing position from its records: `after:OPxx` after a good cycle, `rework:OP30` after a leak failure. No fact says whether such a unit waits in a buffer or is in the next machine's cycle, so the position is the routing segment, refined only where a fact tells: `at:{machine}` when the machine of its last cycle ends `Blocked` with it (its last cycle there, no later cycle). A blank a CNC holds whose OP10 cycle has not completed is no unit yet; the MES counts it per job (`inMachine`) from the CNC's states after the job's last OP10 cycle (`holdsBlank`): `Running` holds one; `Starved`, `Blocked`, a changeover `Setup` and `Idle NO-ORDER` hold none; breaks, shift ends, stops, failures and a missing operator keep what the machine held. With no decisive state the CNC was running at its last cycle's end and took the next blank without a state change.

The same count replaces #174's conservative lost-job count (ADR-0029 note): a lost job's blanks are its OP10 units plus the blank `holdsBlank` finds, once every OP10 cycle of the job is a unit (`BlankCounter`, injected into the orders module); until then the conservative count stays.

### Scrap records

Every machine scrap (OP10 `DIMENSIONAL`, OP40 second `LEAK`) is an `execution.scrap_record` keyed by its fact; its derived columns follow the unit's rebuild, the coding columns only a person's write. A coding (`scrap:code`: operator, quality, supervisor) names the record's machine reason or a reason below it in the scrap tree (`config/plant/scrap.yaml`, seeded into `master_data.scrap_reason`), with the record's version (409 `urn:shopfloor:scrap-stale`), audited in `identity.audit_log` (`scrap.code`). Coding never changes a quantity or a confirmation. The tree has its own file because `reasons.yaml` is hashed into every golden summary's `analysisConfigSha256` (plan: "a new `scrap` tree in `reasons.yaml`", a recorded deviation).

### Reconciliation

The golden `orders-01` (`reconciliation-orders.e2e.test.ts`), in order and shuffled with 10 % duplicates and every step judged on partial data: the dispatch equals the scenario's `dispatches`; every command has exactly one `accepted` fact and no incident of either module is raised; the unit list derived from the event log hashes to the ground truth's `units.sha256`, and the MES's units equal it but for blanks still in a CNC; per order and operation the quantities, scrap by reason, rework passes, packed good, backflushed material, completion time and WIP (count, `inMachine` per CNC, positions as the event log places each unit) equal the ground truth; the confirmations equal those computed from it (7 orders × 5 operations), none a correction; OEE under `scheduledTime: orders`, alarms and shift reports as for the other goldens.

### Consequences

- Good: every number the MES confirms is computed from device facts that are final, so the ERP gets one final confirmation per operation in the normal case, and a correction only for a fact that arrived after its gap was written off, with the delta judged against what was sent.
- Good: units, records and confirmations are the same whatever the delivery order (tested shuffled, with ticks on partial data).
- Good: a lost job's blanks are counted from its units, closing #174's "+1 while unknown" limit.
- Bad: WIP is a routing segment, not a buffer slot: the facts can't tell a buffer from the next machine's cycle. A suspect on a machine that stops reporting stays a suspect (its final-through never passes the record).
- Bad: rebuilding a unit replaces its records; a part with very many facts (none in this plant) would cost more per fact.
- Bad: an existing database that recorded Idle `NO-ORDER` downtime records before #175 keeps them until those intervals are recomputed (only orders-mode runs have them; `pnpm stack:reset` as for any derived data).
