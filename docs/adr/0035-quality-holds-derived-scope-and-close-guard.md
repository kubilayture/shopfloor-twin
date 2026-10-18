# ADR-0035: Quality holds: a scope derived from the genealogy, append-only transitions and a close guard on one advisory lock

- Status: accepted (#201)
- Date: 2026-10-18
- Deciders: Claude (#201), within the Phase 8 plan ("Quality holds", review rounds 1–3); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

A quality user must be able to stop suspect goods: a lot of blanks or seal kits, a serial, a carton or a whole order. The plant has no physical block the MES can command (the MES never commands the simulator for quality; `blockLot` stays a Phase 9 console action), so a hold is a record with consequences in the MES and the ERP only. Open questions:

- **What a hold covers.** The goods a lot went into are known only through the genealogy (ADR-0034), and facts keep arriving: a unit may consume a held lot after the hold, or its fact may arrive late.
- **What a hold does.** Which MES actions it refuses, and what "rejected" means when quantities change only from machine facts (ADR-0031).
- **The close race.** Probe P2 (review of PR #207) reproduced an order closed beside an open hold: a close guard reading a derived hold-to-unit table at READ COMMITTED saw nothing while a hold committed.
- **Genealogy lag.** Genealogy processes facts a round behind execution (ADR-0034); a close checked before genealogy has written a link could miss a held lot in the order.
- **The module cycle.** `orders` must ask `quality` before closing; `quality` writes ERP notifications through `orders`' outbox; genealogy reads execution.
- **The ERP.** The ERP mock receives quality notifications idempotently (ADR-0028 amendment, #198).

## Considered options

1. **Scope:** (a) a list of units fixed at the opening; (b) derived from the subject through the genealogy, growing with facts.
2. **Close guard:** (a) read the derived scope (`hold_unit`); (b) derive at check time, with row locks on `production_order`; (c) derive at check time, one transaction-level advisory lock shared by hold opening and close.
3. **Guard lag:** (a) none; (b) require genealogy's processed watermark over every fact of the order's units, else a retryable refusal.
4. **Outcomes:** (a) release only; (b) release or reject, quantities unchanged; (c) reject with quantity corrections.
5. **Composition:** (a) `orders` imports `quality`; (b) a `CloseGuard` injected into `orders` at composition.

## Decision outcome

Chosen: 1b, 2c, 3b, 4b, 5b.

### Subjects and scope (1b)

A hold is on a lot, a serial (every unit with it: serials repeat across runs, ADR-0034), a carton or an order (its ERP order number, the MES's order id). Its scope is never listed by hand: `Genealogy.scope(subject)` answers the units the subject covers now (a lot: every unit with a `lot-unit` link to it at any operation and pass; a serial: its units; a carton: its members; an order: its units), each with its order and carton. A unit that consumes a held lot after the opening, or whose fact arrives late, joins the scope as soon as genealogy has its link.

`quality.hold_unit` is a copy of the scope for reads (detail pages, trace answers, a carton's `held` flag): rebuilt every round (1 s) while the hold is open or rejected, kept as it stood once released, each unit with the wall time it joined. **No decision reads it**: the close guard derives the scope itself (below).

Each hold stores `opened_plant_at`, the plant clock (the newest epoch's watermark) at the opening, and that epoch, `opened_epoch` (review round 1, MEDIUM 9; scripted golden holds pass both explicitly). "After the opening" compares positions, not bare times (review of PR #222, L1): a consumption in a newer device epoch is after it, one in an older epoch before it, one in the same epoch after it when its plant time is later; a release keeps its `decided_epoch` the same way. A consumption of a held lot after it (and before a release; a rejected lot stays blocked) raises `held-material-consumed` (`quality.hold_incident`, one per fact, lot and hold): the line kept using a held lot, which the MES can see but not stop. A released hold is still checked for consumptions before its release, so a late fact of that span is recorded too. Without a plant clock (no fact yet) `opened_plant_at` is null and every consumption counts as after it.

### Lifecycle (4b)

`open → released | rejected`, with a reason from `quality.yaml`'s `holdReasons` (each listed for an opening, a release or a rejection) and an optional comment; comments in any state. `quality.hold` holds the current state and a `version` (409 `urn:shopfloor:hold-stale`); a second decision is 409 `urn:shopfloor:hold-decided`; a subject the MES doesn't know is 404 (a lot not imported from the ERP's lot list, a serial or carton genealogy has not seen, an unknown order), a reason not listed for the transition 422. `quality.hold_transition` is append-only: numbered from 1 (`opened`), every comment and decision appended with its user, wall and plant time and the scope counts its notification carried; a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` to every role (as `control_limit`, ADR-0032), and `mes_app` has `SELECT, INSERT` only. Every transition and comment is audited (`hold.open`, `hold.comment`, `hold.release`, `hold.reject`, entity `quality_hold`).

- **Released** means use as is: the hold no longer blocks anything.
- **Rejected** records that quality wants the units scrapped or reworked outside the MES. **No quantity or confirmation changes**: they change only from machine facts (ADR-0031). The units' cartons stay `held`, the ERP is told. A rejected hold does not block the order's close (the plan blocks a close only while a hold is open): the order's goods are then accounted for by the ERP's decision on the notification, not by keeping the order open.
- **Permissions:** `quality:hold` (open, comment) for quality and supervisor (a supervisor must be able to stop shipment at night), `quality:release` (release, reject) for quality only. Admin holds neither (ADR-0026).

### Consequences in the MES

- **Cartons:** a carton is `held` while any member is in an open or rejected hold (by the scope copy); trace answers list the open and rejected holds on their nodes (a serial's units, a lot or its units, a carton or its members).
- **Close:** `Orders.close` is refused (409 `urn:shopfloor:quality-hold`) while an open hold covers a unit of the order, or is on the order itself (also before any unit of it exists). Sign-off at the terminal is not blocked: it states the operation is done, not that the goods are good.

### The close guard (2c, 3b, 5b)

`Holds.closeGuard()` is injected into the orders module at composition (`Orders.useCloseGuard`, the pattern of `BlankCounter`), so `orders` imports nothing of `quality`:

1. **One lock, one order.** Opening a hold and closing an order serialize on one transaction-level advisory lock (`pg_advisory_xact_lock(8201001)`), taken **first** in both transactions: a hold's transaction takes it before anything else; `Orders.close` takes it inside `#write`'s transaction before `#lock` reads and locks the order row. Under READ COMMITTED every statement after the lock sees every hold committed before it. Row locks on `production_order` (option 2b) would need the affected orders before the scope is derived, and both writes are rare human actions.
2. **Genealogy has processed the order's facts** (review round 2, HIGH C; review of PR #222, H1). The guard takes the order's units from execution (`Execution.orderUnits`), from genealogy, and from ingest itself: every part of a cycle fact on the order's CNC inside one of its jobs (after the job's `started` fact, before the CNC's next `started` of another command, the attribution rule of ADR-0031), so a unit **neither module has built yet** (all its facts late, the gaps written off) is counted too. It takes every cycle fact of those units **from ingest** (by epoch and part: a fact not yet in a record is exactly the one the watermark must cover, ADR-0034's note), and requires `Genealogy.covers` of them: genealogy's contiguous processed-through sequence (`settledSeq` as the execution round it caught up with read it, never the highest number seen) at or above each fact's sequence on its machine and epoch. **And** it requires each of those facts to be in genealogy's records of its unit (`Genealogy.unrecorded`: a `genealogy.unit_record` with the fact's (equipment, epoch, seq) and part). The watermark alone is not enough: `settledSeq` counts a written-off number as settled, so a late fact of a written-off gap is below the watermark as soon as ingest stores it, before genealogy has rebuilt its unit (probe PD of the review: the order closed beside a hold on the lot that fact carried). Otherwise it refuses with a retryable 409 `urn:shopfloor:genealogy-pending` (the API adds `Retry-After: 2`), whether or not a hold is open: a link not written yet could put a held lot in the order. A late fact of an **ended run** never joins an order: ingest refuses an older epoch as stale (ADR-0015; probe PA). A poison unit that keeps failing its rebuild holds the watermark (ADR-0034), so a close of its order stays pending and visible, never wrong.
3. **Scope at check time** (review round 1, HIGH 1). Then, in the same transaction, it reads the open holds and asks `Genealogy.scope(subject, { orderId, db: trx })` for each: a hold covering any unit of the order refuses the close. `hold_unit` is never read (probe P2).
4. **Fail closed** (review of PR #222, L2). `Orders.close` with no guard wired is refused; only a module test of orders alone passes `unguardedClose`. The MES asserts at start that the guard is wired (`Orders.closeGuarded`).
5. **No deadlock with the orders queue** (review round 2, MEDIUM D). The close holds the orders module's in-process `#serial` queue while it waits for the advisory lock; a hold's transaction holds the lock while it writes its ERP notification through `Orders.enqueueErpMessage(trx, …)`, which **never takes `#serial` and touches no `production_order` row** (an insert into `orders.erp_message_log` in the caller's transaction), so it never waits on the close. The guard itself never waits on an in-process queue and reads through the close's transaction (no second pool connection held while the lock is).

Tests (`quality-holds.test.ts`): two connections in both orders of arrival (a hold opening while a close is between its check and its commit waits for the close and then opens; a close while a hold's transaction is open waits for it and is refused), both proven blocked on the other's backend (`pg_blocking_pids`) and failing without the lock; a hold and a close at once in one process both finish within a timeout, in either order, while the orders queue is busy; `genealogy-pending` while genealogy has not processed an order's facts, then the close succeeds once it has; a late fact of a written-off gap carrying a held lot (PD) and a unit built by neither module inside the order's job, both pending until genealogy records them (each killed when its check is removed); a poison unit (PB); a held lot consumed at a rework pass (PC, M1); a close with no guard; and a guard that ignores an emptied `hold_unit`.

### Quality notifications to the ERP

Opening, releasing and rejecting a hold write a notification in the transition's transaction into the orders module's outbox (`orders.erp_message_log`, kind `quality-notification`, migration `0032`: `order_id` and `revision` null only for that kind, a `CHECK` per kind, `subject_kind` `hold` and `subject_id`, the id null whenever the kind is: review of PR #222, L5), so one publisher, one backoff and one incident path serve every ERP message (review round 1, MEDIUM 5). As ADR-0028's amendment requires: the key is `qualityNotificationKey` (`{holdId}~{transition}~{n}`, n the transition's number within the hold, comments counted); hold ids are UUIDs, unique forever (the ERP's store outlives the MES's database); an order subject is the ERP order number; the scope counts (units, cartons, orders) are those of the transaction with `scopeAsOf` (the plant clock) and `scopeFinal` (every machine final through it in the scope's epochs, by genealogy's processed progress), since the scope can still grow; a comment is not notified; a 409 is an `erp-conflict` incident and never retried. A notification is never listed under an order's ERP messages; a hold's detail shows each transition's notification state.

### A signal's suggested scope

`GET /quality/signals/{id}/hold-suggestion` answers the units tested since the last in-control point before an SPC episode (ADR-0032, "Signals and people"): every reading, retests included, after the episode chart's last point that fired no rule before it (in its segment) through its last triggering point, with their orders and cartons, and `final` equal to the episode's `extentFinal`. No hold opens by itself: a quality user decides, and holds serials, cartons or orders from it (the screens are #203's). The window starts just after that in-control point, or at the first reading of the episode's segment (its device epoch) when there is none (`from`; review of PR #222, L3: a pure `windowOf`, unit-tested on segment boundaries).

### Positive consequences

- A hold's scope can't be stale where it matters: the close guard derives it under the lock, after genealogy has caught up; the shuffled and late-fact cases of the genealogy carry over.
- One outbox and one lock order: no second ERP publisher, no deadlock between the in-process queue and the database lock.
- The golden hold cases (`quality-01`, scripted at Monday 14:00, in order and on the shuffled replay) compare each hold's scope with the truth's units of its subject, including the lot's units reported after the hold and a rework pass's seal-kit lot, and `held-material-consumed` with the truth's consumptions after it; a completed order's close is refused by a lot hold's derived scope alone.

### Negative consequences

- A close may be refused as `genealogy-pending` for about a second after the last facts of an order arrive (genealogy's round), and as long as a unit of the order keeps failing its rebuild.
- `hold_unit` lags genealogy by a round: a carton's `held` flag and a trace's holds can show a unit one second late (decisions never use it).
- Every open, rejected and lot hold is derived again every second; fine for a handful of holds, a Phase 9 item if holds number in the hundreds.
- The scope of a lot hold keeps growing while the line uses the lot: the ERP's counts are provisional by design (`scopeFinal`).
