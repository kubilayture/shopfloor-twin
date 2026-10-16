# ADR-0030: Order-driven simulator: production mode `orders`, idempotent `LoadOrder` and job facts

- Status: accepted
- Date: 2026-10-16
- Deciders: Claude (#172), within the Phase 7 plan ("Order-driven simulator", review decisions B3, H1, H2, M3, M4 and M6); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

From Phase 7 the plant runs from orders (master plan section 4: the production schedule is "replaced by released orders"). Until now the simulator decided its own production: each CNC worked through `schedule.yaml`'s campaigns, and `LoadProgram(Product, Quantity)` (Phase 2) put a campaign at the _front_ of a CNC's queue, with no order or command id and no idempotency, so a retried call made a second campaign. The command path of #173 (MES → UNS `cmd/load-order` → gateway → OPC UA) is at-least-once, so the device itself must make execution exactly-once, and the MES must be able to prove from device facts which jobs exist. At the same time `week-01` and `alarms-01`, the golden scenarios every Phase 4–6 reconciliation rests on, must keep their event logs byte for byte.

The questions:

- how the simulator switches between the schedule and orders without touching the schedule-mode runs;
- what the device's command looks like, and in which order it checks a call, so that a retry, a late call or a call for a run that ended can never make a second job or a job nobody can account for;
- which facts the device publishes about jobs, and how a part is attributed to an order;
- how a headless run reproduces a live run whose jobs came through OPC UA;
- what the ground truth records per order and per part, and when material counts as consumed.

## Considered options

1. **Mode:** (a) replace the schedule; (b) a production mode `schedule | orders`, `schedule` the default.
2. **Method:** (a) extend `LoadProgram` with ids; (b) a new method `LoadOrder` that appends and is idempotent by command id.
3. **Dedup:** (a) in the gateway only; (b) on the device, keyed by command id within the device epoch, checked before any other check.
4. **Stale commands:** (a) the gateway drops expired commands; (b) the device refuses a command for another epoch or past its expiry, but only on a dedup miss.
5. **Proof of execution:** (a) the method's answer; (b) job facts (`accepted`, `started`, `completed`) in the device sequence.
6. **Headless jobs:** (a) the headless run calls the MES's dispatch rule; (b) the scenario lists its `dispatches`, applied after `line.start` and before the injections; the MES's rule is tested to reproduce them.

## Decision outcome

Chosen: 1b, 2b, 3b, 4b, 5b and 6b.

### Production mode (1b)

`production: schedule | orders` in `scenario.json` and `SIM_PRODUCTION` in live mode; `schedule` stays the default, also in Compose. In `orders` mode:

- every first-operation machine (the CNCs) gets `campaigns: []`, not none (the line tells a CNC from other stations by its campaign list), and `schedule.yaml` is not used;
- nothing is loaded at the start, so a CNC's first job begins with `CHANGEOVER none→<product>` (the path of #126), which the dispatch rule counts; `plant-servers` skips the initial `Program`, so it starts empty;
- `LoadProgram` is refused (`BadInvalidState`); in schedule mode `LoadOrder` is refused the same way.

The run header records `production: "orders"` and the `dispatches` only in orders mode, so schedule-mode headers and `events.sha256` are unchanged. The event schema stays `sim-event/1`: `job` is a new event type only orders-mode runs write, as `injection-held` and `injection-applied` events appear only in runs with injections.

### `LoadOrder` (2b, 3b, 4b)

In `CommandId`, `OrderId`, `Product`, `Quantity` (blanks to machine), `NotBefore` (plant time), `DeviceEpoch` and `ExpiresAt` (wall time); out `Position`, `Duplicate`, `AcceptedSeq` and `AcceptedAt` (the device sequence number and plant time of the job's `accepted` event). The job is appended; the CNC runs its queue FIFO (at most 50 not completed), and the head waits for its `NotBefore`.

The device checks a call in this order:

1. **Dedup first.** The command id is looked up in the run's table of accepted commands. The same job (`OrderId`, `Product`, `Quantity`, `NotBefore`) answers `Duplicate = true` with the original outputs, whatever `ExpiresAt` and `DeviceEpoch` say: a late call for an accepted job always learns that it was. Another job is `BadInvalidArgument` (`command-conflict`).
2. **Only on a miss:** a `DeviceEpoch` other than this run's is `BadInvalidState` (`epoch-mismatch`), an `ExpiresAt` before the simulator's wall clock is `BadInvalidState` (`expired`). So a command not accepted before its expiry is never accepted later, whatever the gateway does, and an `expired` answer proves that it never was.
3. Then the job's arguments (`invalid-product`, `invalid-quantity`, empty or over-long ids: `BadInvalidArgument`) and the queue's room (`BadResourceUnavailable`).

A refusal flags the offending argument in `inputArgumentResults` (its index in `LOAD_ORDER_INPUTS`), which is how a client tells `epoch-mismatch` (DeviceEpoch) from `expired` (ExpiresAt): both are `BadInvalidState`, as the plan specifies. The line holds the dedup table and does the checks (`ProductionLine.loadOrder` with a guard of the run's epoch and the wall clock, which only the OPC UA server knows); the server adds `AcceptedSeq` from the sequence number it gave the `accepted` event, which is raised before the call returns. The call is refused (`BadInvalidState`) until every server has started and replayed the events it missed, so that number always exists.

### Job facts (5b)

`PlantEvent` `job` with `transition` `accepted | started | completed`, `commandId`, `orderId`, `product`, `quantity`; on OPC UA the event type `ShopFloorJobEventType` with the same fields, in the shared per-machine `Sequence` (ADR-0009). `started` is the job's first blank taken (after any changeover); `completed` the end of its last OP10 cycle, whatever the result. Variables `ShopFloor.ActiveOrder` and `ShopFloor.QueuedJobs` show the queue. A part belongs to the job whose `started` fact is the latest on its CNC before the part's OP10 cycle: one part at a time on a CNC, so this is exact and survives reordering, and every later cycle of the part inherits the order.

The gateway sees job events from now on but publishes them only with #173 (`events/job`, UNS contract 1.3); until then an orders-mode run's job events take sequence numbers the UNS doesn't carry. No reconcile pass runs orders mode before #178, so nothing observes it.

### `NO-ORDER` and wake-ups

An `Idle` CNC whose queue has no startable job has cause `NO-ORDER` (in `CAUSES` and `causeVocabulary`; `reasons.yaml` maps it to `PLANNED/NO-ORDER`, "No order"). Accepting a job with a later `NotBefore` schedules a wake-up event then. The wake-up calls the normal start path only while the CNC is `Idle` inside a shift and outside its break (checked against the calendar, not the line's last processed boundary): calendar boundaries are scheduled a week at a time, so a wake-up exactly on a boundary more than a week ahead is processed before that boundary, and must not start a job that the boundary would then carry into the break. A wake-up in a break, a planned stop or outside a shift starts nothing; the job starts when the machine next leaves that state.

### Dispatches (6b, B3)

`scenario.json` may carry `dispatches: [{ commandId, machine, orderId, product, quantity, notBefore }]`. Headless applies them after `line.start` and before the injections, in list order, at the start time. That is the live order: the simulator is attached and idle at its start time (`SIM_AUTOSTART=false`), the test dispatches through `LoadOrder`, waits until every command is confirmed by its device fact, posts the injections, then resumes. Both runs put the same events in the queue with the same tie-breaking sequence, so the live run equals the headless one (tested event for event on `orders-01`'s shift A). A CNC that enters `Idle NO-ORDER` at the start time and gets a job at that instant goes to `Setup` at the same instant; the zero-length `Idle` is dropped by the ground truth and by the MES (ADR-0018).

The headless run never depends on MES code. The MES's dispatch (#174) of the scenario's released orders must produce exactly the `dispatches`; the rule, as `orders-01` fixes it for #174: released orders in planned-start order, ties by order number; each whole order to the CNC whose queue _with the order appended_ finishes first by an ideal-time estimate, ties to the lower id. The estimate walks the queue in order: a job starts at the later of its `notBefore` and the previous job's end, plus a changeover when its product differs from the one before it (the first job of a run too, `none→…`), plus quantity × ideal OP10 cycle; breaks and shift ends are ignored. A simulator test recomputes `orders-01`'s dispatches from `orders.json` with this rule.

### Ground truth per order and per part (`sim-summary/4`, control API 1.4)

From events only, as the MES must build it from device facts (WIP at the end is read from the line): per job its times; per order the parts started, scrap per operation and reason, rework passes, packed good, WIP per place, completion, quantities per operation in completed cycles of every pass, and material; per part its operation records (operation, equipment, pass, completion time, result, reason), hashed as `units.sha256` with the count, the full list derived in the tests from the event log.

**Material is booked at cycle completion (H2):** a blank with the part's OP10 cycle, components with its OP30 cycle of that pass, because the MES knows a cycle only from its completion fact. Material taken for a cycle still running at the end is `materialInProcess` and not reconciled.

### Other scenarios unchanged (M6)

`products.yaml` and `stock.yaml` don't change; `EVENT_SCHEMA` stays `sim-event/1`; `week-01` and `alarms-01` keep `events.sha256` byte-identical. Their summaries are regenerated for `sim-summary/4`: the schema line, an empty `orders` section, `analysisConfigSha256` and `oee.config.scheduledTime` (ADR-0021 amendment) change, and a test reruns both under `shift-calendar` and compares every other field.

### Consequences

- Good: a retried, duplicated or late `LoadOrder` can never make a second job, and the device's answer to a late call settles whether a job exists; the device's own table makes this hold even if the gateway forgets a command. Job facts in the device sequence let the MES prove execution and attribute every part, with gap detection as for every other fact.
- Good: schedule mode and its golden scenarios are byte-identical, so every Phase 4–6 reconciliation stays valid; `orders-01` has its own `events.sha256`.
- Bad: a live run is reproducible from its headless scenario only when its jobs are given while it is idle at its start; jobs dispatched later change its future (as `LoadProgram` always did), and replaying them is a Phase 9 scenario feature.
- Bad: until #173 the gateway does not publish job events, so an orders-mode run seen through the UNS has sequence gaps; and the MES applies `NO-ORDER` to OEE only from #175 (its hourly aggregate has no cause), so oee.yaml's `orders` rule changes nothing on the MES side before then (schedule mode has no `NO-ORDER`).
- Bad: quantity is blanks started, so OP10 scrap makes an order short; make-up jobs are out of scope.
