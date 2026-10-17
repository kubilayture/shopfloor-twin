# ADR-0034: Genealogy: units keyed by run with serial-reuse incidents, cartons by a shared packing rule, links rebuilt from facts, answers that say whether they are final

- Status: accepted (#199; `trace-core`'s packing rule and trace tree from #195, `trace.json` from #208)
- Date: 2026-10-17
- Deciders: Claude (#199), within the Phase 8 plan ("Serial identity", "Genealogy", review rounds 1–3); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Phase 8 must trace every packed part back to its blank lot, component lots, machines, operators and test values, and every lot forward to the cartons it went into (master plan section 11, row 8). The device facts carry what is needed since #197 (lots and ASM-01's operator on the cycle facts, the leak reading as before); the execution module keys units by (device epoch, `partId`) and attributes them to orders (ADR-0031). Open questions:

- **Serial identity:** the simulator's serial counter restarts with every run, so a serial repeats across runs; a real line never reuses a DMC.
- **Cartons:** PCK-01 has no carton fact; the plant has no shipping step.
- **Where lots come from:** the ERP mock lists them (`GET /api/v1/lots`, #198); `config/plant/stock.yaml` is the default of only one dataset, and `quality-01` has its own stock.
- **Partial data:** facts arrive reordered, duplicated and late (ADR-0017, ADR-0018). A carton's membership depends on the order of packs; a unit's order can change when a late job fact arrives (ADR-0031); a forward trace taken while facts are arriving is incomplete.
- **The close guard of #201** needs to know that genealogy has processed every fact of an order's units (plan review round 2, HIGH C).

## Considered options

1. **Serial identity:** (a) serial unique in the MES, a repeat refused or held; (b) units keyed (epoch, `partId`) as execution keys them, `serial` indexed and not unique, a repeat across runs a data-quality incident; (c) unique serials from the simulator (a run prefix).
2. **Cartons:** (a) the simulator models cartons and emits carton facts; (b) the MES forms cartons by a rule that the ground truth applies too.
3. **Lots:** (a) master data from `stock.yaml`; (b) the ERP's lot list, imported on the ERP poll.
4. **Links:** (a) appended as facts arrive; (b) derived and rebuilt per unit from its execution records and cycle facts, as execution's records are.
5. **Following execution:** (a) genealogy derives units itself from cycle facts; (b) genealogy follows execution's units (`onUnits`) and reads them through `Execution`'s interface.
6. **Finality of a trace answer:** (a) none; (b) `final` and the machines not final through the answer's latest record.

## Decision outcome

Chosen: 1b, 2b, 3b, 4b, 5b, 6b.

### Units and serials (1b)

`genealogy.serial_unit` has one row per unit (epoch, `partId`) with its serial, product, order, status (as execution has them) and carton. A serial seen in a second device epoch raises one `serial-reused` incident per pair of epochs, however many serials repeat; a lookup by serial lists every unit with it, newest epoch first. (a) would hold or refuse every part after any restart of a dev stack; (c) changes every event log and `unitsSha256` for nothing a test needs. The repeat is a recorded simulator limit, invisible in the goldens and the reconcile passes (one run each on a fresh database).

### Cartons by the packing rule (2b)

Cartons are per order and product, capacity per product in `config/plant/packing.yaml` (not a simulation input). An order's good packing cycles fill its cartons in plant-time order (ties by epoch, sequence, part); a carton closes when full, at its last member's time; the order's last carton closes at the order's completion (ADR-0031), so a short order has a partial carton. Ids are `{orderId}-C{nn}` (at least two digits, growing past 99). The rule is `trace-core`'s `packCartons`, which the simulator's `trace.json` uses too, so the truth and the MES can't disagree on the definition. In a real plant the MES usually creates the handling unit; (a) needs a new event kind that only a new mode could emit, and its reconciliation would test a fact path, not genealogy.

**On final data only:** an order's packs are placed in the rule's order up to the first one that is not final, because a late earlier pack would shift every later unit by one place; the last carton closes at the order's completion only once every pack is placed. A pack is final when its machine is final through it (ADR-0018) **and its unit's order is final**: the unit's first-operation record is final on its machine, so no job fact on its way can move the unit to another order (review of PR #219, H2: a late `started` fact moved two packs out of a carton already closed). Moreover no order's pack is placed at or after the earliest good packing cycle, of any order or none, whose unit's order is not final yet (review round 2: an order dispatched to two CNCs, the second behind, could otherwise gain a unit that packs before a placed one). So a closed carton keeps its members, their order and its closing time but for a fact of a written-off gap; the shuffled goldens assert it after every round. An order with a pack not placed or an open carton is placed again every round; its cartons and links are rewritten only when the placement differs from the stored one, and a start re-places only such unsettled orders (review M5). Schedule-mode units have no order and no carton. "Shipped" means in a closed carton (the plant has no shipping step).

### Lots from the ERP (3b)

The module imports the ERP's lot list on the ERP poll (`ERP_POLL_MS`), upserting by lot id in one transaction (material, quantity and status follow the list; a changed material is logged once, when it changes, and the lot's units are judged again against it); a lot no longer listed is kept as `retired`. A cycle fact naming a lot the MES has not imported is kept and raises `unknown-lot`, closed when an import lists it (its units are then rebuilt, so the lot's listed material is checked). `stock.yaml` is never read: a scenario's lots are its ERP dataset's (#198 review note on #199).

### Links rebuilt from facts (4b, 5b)

Genealogy follows the execution module: `Execution.onUnits` announces units stored or marked lost (after the commit), and each round rebuilds those units from `Execution.units({ epoch, partIds })` (records with pass numbers and the unit's order) and `Ingest.cycleFacts({ epoch, partIds })` (lots, operator, measurement). Per record, `genealogy.unit_record` keeps what the fact reported: whether it carried `lots` at all (absent on WSH-01 over Modbus, on a gateway before UNS 1.4, or when ingest dropped the field, #197) apart from `[]` (consumed nothing), the operator with whether it was reported (absent apart from null), and the measurement. Each lot reference is a `lot-unit` edge with the unit, operation, pass, machine, the fact's (equipment, epoch, seq), its place in the fact's list and the time. Genealogy never reads execution's tables (ADR-0016).

`material-mismatch`: a lot of a material that the order's BOM doesn't list for that operation and pass (standard lines on a first pass, rework lines on a later one, as execution backflushes), or the product's BOM when the unit has no order (schedule mode), or a lot the ERP lists with another material. It is judged only once the unit's attribution is final: its first operation's machine final through that record, so no job fact on its way can still attribute it to another order (the golden `orders-01` raised transient mismatches on shuffled data before this rule); a unit with no first-operation record (its fact lost, the gap written off) has no order for good once every machine of its records is final through them, and is judged with the product's BOM (review M3). A mismatch a rebuild no longer shows is closed.

A unit whose rebuild fails on its own (its chunk retried unit by unit) keeps its rows as they were and goes to a retry set: rebuilt again next round, then after 1, 3, 7, … rounds (at most 31); a second failure in a row raises `rebuild-failed` (closed when it is rebuilt), so a transient failure leaves no incident. While a unit is in the retry set, the processed watermark stays below its facts: on each machine of the unit's facts, the final-through just below its first fact there and the final-through time just before it (a failing unit of an older epoch keeps that machine's previous processed progress). A unit that keeps failing therefore shows as #201's retryable `genealogy-pending` and an open incident, never as links that miss it (review round 2, HIGH). When every unit of a chunk of several fails, the cause is not the units (a lost connection, a deadlock), and the round fails and is retried with everything it took.

**Following from the start (review M4):** the MES calls `Genealogy.follow()` before `Execution.start()`, so the units execution's catch-up rebuilds are announced to genealogy too; and genealogy's own catch-up rebuilds every unit whose order or status differs from execution's (`Execution.unitStates()`), besides the newest run's units and those of runs whose records lag their facts.

### The processed watermark

`Execution.processedThrough()` is every machine's progress (ADR-0018 `deviceProgress`) as the execution round that last completed read it before taking its facts: every fact received by then was handled, and every unit it changed announced. A genealogy round reads it before taking the announced units, and on success makes it its own. `Genealogy.processedThrough(equipment, epoch)` is that progress's **`settledSeq`**: contiguous over the numbers seen and the gaps written off (a reported gap counts, its facts are not coming), not the highest number seen. Every fact up to it that arrived is reflected in the links. A written-off gap doesn't stop it for the rest of the epoch (review of PR #219, H1: `receivedThrough` did); a fact of that gap that arrives after all is a late fact, as for intervals (ADR-0018), and moves nothing back. An older epoch than the machine's newest counts as processed through every number. `covers(facts)` is what #201's close guard asks.

**For #201:** the guard must take the facts of the order's units from ingest (every cycle fact of the units, by epoch and part), not from execution's records: a fact not yet in a record is exactly the one the watermark must cover.

### Trace answers and their finality (6b)

`GET /trace/serials/{serial}` (backward: per unit its records with machine, time, result, lots, device operator and the MES crew signed on to the work center during the cycle, reading, order, carton), `GET /trace/lots/{lot}` (forward: units, orders, cartons, pieces consumed, the lot as imported, and every other lot of the same units), `GET /trace/cartons/{carton}`, `GET /trace/search?q=` (serials, imported lots, cartons and orders by prefix: a range in byte order, `COLLATE "C"`, served by an index on each id; a `q` with U+0000, which no id can hold, is refused with 400), `GET /genealogy-incidents`. Plain SQL over the edge table, an index per edge direction. Every trace answer carries `final`: every machine of the plant is in a newer epoch, or final through the answer's latest record, by the progress genealogy has processed; `notFinal` names the others. A machine that has not reported since the latest record is not final through it (nothing proves the gap empty), as ADR-0018 judges intervals.

The crew is shown, not reconciled (no ground truth for MES users). The cycle fact carries no start, so the crew rows shown are those signed on to the machine's work center during the cycle as approximated by the product's ideal cycle before its completion; the device operator is the one at the cycle's start (ADR-0033). An answer reads only the crew rows of its own time span, once per work center.

Incidents are kept, never deleted (`SELECT, INSERT, UPDATE` for `mes_app`, as execution's): a deviation from the plan's grant list, which counted them among the derived tables (review L7).

### Reconciliation

The golden harness compares `quality-01`, `orders-01` and `week-01` with `trace.json`, in order and shuffled with 10 % duplicates and ticks on partial data. The expected trace is derived from the event log alone (lots and operators written out from the raw events) and built by `trace-core`'s `buildTrace`; it hashes to `unitsTraceSha256` and its lots and cartons equal `trace.json`'s. The MES side is read as the API answers it: a forward trace of every lot of the ERP's list, then a backward trace of every serial. Every unit (serial, product, order, status, carton, records with lots, operator and reading), every consumed lot (material, pieces, units, orders, cartons) and every carton (members in order, status, closing time) must equal it, with no incident; at a cut (Monday 14:00 for `quality-01` and `orders-01`, Wednesday for `week-01`) the MES with only the facts before it equals `traceAsOf(truth, cut)`.

### Consequences

- Good: one packing rule for the truth and the MES; cartons and incidents are judged on final data, so the shuffled goldens equal the in-order runs row for row and raise nothing.
- Good: the absent / `[]` / null distinction survives to the API, so a trace says "not reported" where a machine or a gateway could not report, never "none".
- Good: the processed watermark is exact without a sequence bookkeeping of its own: it is the execution round's.
- Bad: genealogy lags execution by one round (about a second in production) and rebuilds a unit whenever execution does; a forward trace of a large lot reads its units' rows per answer.
- Bad: serials repeat across simulator runs; screens must ask which unit is meant.
- Bad: an order whose packing machine stops reporting keeps its last carton open, and an answer stays not final, until a fact proves the gap empty.
- Bad: the crew shown is approximate (the fact has no start time).
