# Contract: OPC UA address space

Version 1.2 (Phase 8, #196: `LotMaterials`, `LotIds` and `Operator` on `CycleCompleteEventType`; 1.1 in Phase 7, #172: `LoadOrder`, `ShopFloor.ActiveOrder`, `ShopFloor.QueuedJobs` and `ShopFloorJobEventType` for the production mode `orders`; version 1 in Phase 2). Source of truth in code: `packages/contracts/src/opcua.ts`. A contract test (`apps/simulator/src/opcua/integration.test.ts`) reads the Project variables table of this file and checks it against the code and the running servers: every path, data type and machine in the Project variables table, and the fields in the Events table. It also checks the alarm codes per machine and `LoadProgram` and `LoadOrder` against the code; the Alarms table describes the rules in prose and is not parsed. Decisions: ADR-0008 (model), ADR-0009 (delivery), ADR-0010 (alarms), ADR-0030 (orders mode, `LoadOrder`, job facts), ADR-0033 (lots and operator on the cycle event). Any change bumps the version here and needs a changelog entry (plan section 2, Definition of Done).

## Endpoints

| Machine | Endpoint                | Kind            |
| ------- | ----------------------- | --------------- |
| CNC-01  | `opc.tcp://<host>:4841` | MachineToolType |
| CNC-02  | `opc.tcp://<host>:4842` | MachineToolType |
| ASM-01  | `opc.tcp://<host>:4843` | Station         |
| LKT-01  | `opc.tcp://<host>:4844` | Station         |
| PCK-01  | `opc.tcp://<host>:4845` | Station         |

- Security mode None in Phase 2; SignAndEncrypt follows in Phase 9.
- Each server has its own certificate, generated on first start in `<pki>/<machine>`, with ApplicationUri `urn:orbis-components:shopfloor-twin:<machine>`.
- Servers advertise `MinSupportedSampleRate = 0` (ADR-0009).

## Namespaces and node ids

- **Project namespace URI:** `urn:orbis-components:shopfloor-twin`, the same on every server.
- **Node ids** are written as `nsu=<uri>;s=<machine>.<path>`. A client resolves the index from the server's NamespaceArray at connect time; `toIndexedNodeId` in `@shopfloor/contracts` does it. Never hard-code `ns=`.

## Standard part (ADR-0008)

- **Location:** under `Objects/Machines` (Machinery), the object `s=<machine>`, with browse name = equipment name.
- **CNC-01/02:** instances of `MachineToolType`, with Identification, Monitoring, Production, Equipment, Notification and the optional `MachineryBuildingBlocks`.
- **Other machines:** `Identification` (`MachineIdentificationType`) and a `MachineryBuildingBlocks` folder.
- **`MachineryBuildingBlocks/MachineryItemState`:** NotAvailable, OutOfService, Executing or NotExecuting.
- **`MachineryBuildingBlocks/MachineryOperationMode`:** None, Setup, Processing or Maintenance.
- **Identification:** Manufacturer, SerialNumber and ProductInstanceUri are set.

Both Machinery state machines are derived from the project `State`. Their `CurrentState` timestamps are server (wall) time, because node-opcua sets them internally. Every `setState` also raises a standard `TransitionEventType` event on the Server object, without `Sequence`, with wall-clock `Time`. Clients that check sequences must filter for the project event types (see Events).

| Project `State`                              | MachineryItemState | MachineryOperationMode |
| -------------------------------------------- | ------------------ | ---------------------- |
| Off                                          | NotAvailable       | None                   |
| Running                                      | Executing          | Processing             |
| Idle, Stopped, Starved, Blocked, PlannedStop | NotExecuting       | Processing             |
| Setup                                        | NotExecuting       | Setup                  |
| Down                                         | OutOfService       | Processing             |
| Maintenance                                  | OutOfService       | Maintenance            |

## Project variables (`s=<machine>.ShopFloor…`)

| Path                                                        | Type           | Machines | Meaning                                                                                                                                |
| ----------------------------------------------------------- | -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ShopFloor.State`                                           | String         | all      | One of the ten states (plan section 4)                                                                                                 |
| `ShopFloor.StateCause`                                      | String         | all      | Cause of the current state (failure code, `CHANGEOVER A→B` with `A` = `none` if nothing was loaded, `MATERIAL:SK-1`, …), empty if none |
| `ShopFloor.Sequence`                                        | UInt32         | all      | Last per-machine sequence number used by an event                                                                                      |
| `ShopFloor.Epoch`                                           | UInt32         | all      | Start of this simulator run, Unix seconds (wall time): the epoch of `Sequence`, which restarts at 1 with every run (ADR-0015)          |
| `ShopFloor.Counters.Produced`, `.Good`, `.Scrap`, `.Rework` | UInt32         | all      | Completed cycles since server start, total and per result                                                                              |
| `ShopFloor.LastSerial`                                      | String         | all      | Serial of the last completed cycle                                                                                                     |
| `ShopFloor.Program`                                         | String         | CNCs     | Product the CNC is set up for; empty in orders mode until the first job's changeover starts                                            |
| `ShopFloor.ActiveOrder`                                     | String         | CNCs     | Orders mode: the order of the job the CNC works on (from its `started` to its `completed` fact), empty if none                         |
| `ShopFloor.QueuedJobs`                                      | UInt32         | CNCs     | Orders mode: jobs accepted and not completed, the active one included (at most 50); 0 in schedule mode                                 |
| `ShopFloor.Operator`                                        | String         | ASM-01   | Operator id at the station, empty if none                                                                                              |
| `ShopFloor.ProcessValues.SpindleLoad`                       | Double, %      | CNCs     | Telemetry, sampled (minimum sampling interval 100 ms)                                                                                  |
| `ShopFloor.ProcessValues.CoolantTemperature`                | Double, °C     | CNCs     | Telemetry, sampled                                                                                                                     |
| `ShopFloor.LeakTest.LastReading`                            | Double, Pa/min | LKT-01   | Last leak reading                                                                                                                      |
| `ShopFloor.LeakTest.UpperLimit`                             | Double, Pa/min | LKT-01   | Pass/fail limit                                                                                                                        |
| `ShopFloor.Alarms.ActiveCount`                              | UInt32         | all      | Number of active alarms (ADR-0010)                                                                                                     |
| `ShopFloor.Alarms.<CODE>.Active`                            | Boolean        | all      | One per alarm code of the machine (see Alarms below); true while the alarm is active                                                   |

Value timestamps:

- non-telemetry variables are served exception-based (`MinimumSamplingInterval = 0`), with **SourceTimestamp = simulation time** of the event that changed them, or the run's start time before the first event. `State` starts as `Off`;
- telemetry has SourceTimestamp = the simulation time of the read; it is `UncertainNoCommunicationLastUsableValue` before the simulation has started.

## Methods

`ShopFloor.LoadProgram` on CNC-01 and CNC-02 (`nsu=<uri>;s=<machine>.ShopFloor.LoadProgram`, object `…ShopFloor`).

| Argument       | Type   | Meaning                                                        |
| -------------- | ------ | -------------------------------------------------------------- |
| in `Product`   | String | Product id, for example `VB-200`                               |
| in `Quantity`  | UInt32 | Parts to make, at least 1                                      |
| out `Position` | UInt32 | Position of the new campaign in the CNC queue (always 1: next) |

- The campaign is put at the front of the CNC's queue. If the product differs from the one loaded, the CNC changes over (`Setup`, `CHANGEOVER A→B`) at its next cycle boundary, and `ShopFloor.Program` changes when the changeover starts. After the campaign the CNC continues with its remaining schedule.
- Call it on the object `…ShopFloor` (calling it on the machine root gives `BadMethodInvalid`). Anonymous clients may call it in Phase 2 (Executable and UserExecutable are true); access control comes with security in Phase 9.
- Errors:
  - an unknown product, or a quantity outside 1–100,000, gives `BadInvalidArgument`, with the offending argument flagged in `inputArgumentResults`;
  - a call before the simulation is running gives `BadInvalidState`;
  - node-opcua itself rejects missing arguments (`BadArgumentsMissing`), extra arguments (`BadTooManyArguments`) and wrong types (`BadInvalidArgument`, with `BadTypeMismatch` on the argument).
- In live mode the command takes effect at the simulation time of the last processed step, which can trail the paced clock by up to about 1 s × speed.
- Every accepted call is recorded as a `program-loaded` event in the simulator's event log (not an OPC UA event).
- In production mode `orders` (Phase 7, #172) the call is refused with `BadInvalidState`: CNCs then run only `LoadOrder` jobs.

`ShopFloor.LoadOrder` on CNC-01 and CNC-02 (`nsu=<uri>;s=<machine>.ShopFloor.LoadOrder`, object `…ShopFloor`; #172, ADR-0030). The MES's order dispatch (plan section 5, data path 3) reaches it through the gateway's `cmd/load-order` (#173). Argument order: `LOAD_ORDER_INPUTS` and `LOAD_ORDER_OUTPUTS` in `@shopfloor/contracts`.

| Argument          | Type     | Meaning                                                                                                    |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| in `CommandId`    | String   | The command's id, `{orderId}~OP10~{n}` from the MES; 1–128 characters                                      |
| in `OrderId`      | String   | The MES order the job belongs to; 1–128 characters                                                         |
| in `Product`      | String   | Product id, for example `VB-200`                                                                           |
| in `Quantity`     | UInt32   | Blanks to machine, 1–100,000 (OP10 scrap uses up a slot)                                                   |
| in `NotBefore`    | DateTime | Plant (simulation) time; the job doesn't start earlier                                                     |
| in `DeviceEpoch`  | UInt32   | The device epoch (`ShopFloor.Epoch`) the command is meant for                                              |
| in `ExpiresAt`    | DateTime | Wall time; a command that was not accepted by then is refused                                              |
| out `Position`    | UInt32   | Place of the job in the CNC's queue when it was accepted (1 = next); a duplicate returns the original      |
| out `Duplicate`   | Boolean  | True when this command id was already accepted with the same job: nothing was added                        |
| out `AcceptedSeq` | UInt32   | The `Sequence` of the job's `accepted` event (`ShopFloorJobEventType`); a duplicate returns the original's |
| out `AcceptedAt`  | DateTime | The plant time of that event; a duplicate returns the original's                                           |

- **Dedup first.** The device looks the `CommandId` up in the run's table of accepted commands before any other check. The table is line-wide: a command id names one job on one CNC. A hit with the same job (`OrderId`, `Product`, `Quantity`, `NotBefore`) on the same CNC answers `Good` with `Duplicate = true` and the original outputs, even when `ExpiresAt` has passed or `DeviceEpoch` is wrong: a late call for an accepted job always learns that it was. A hit with another job, or for the other CNC, is `BadInvalidArgument` (`command-conflict`, flagged on `CommandId`).
- **Only on a miss:** a `DeviceEpoch` other than this run's is `BadInvalidState` flagged on `DeviceEpoch` (`epoch-mismatch`); an `ExpiresAt` before the simulator's wall clock is `BadInvalidState` flagged on `ExpiresAt` (`expired`). So a command not accepted before its expiry is never accepted later, and an `expired` answer proves that it never was. Then the job's arguments: an unknown product, a quantity outside 1–100,000 or an empty or over-long id is `BadInvalidArgument` flagged on that argument; a queue of 50 jobs is `BadResourceUnavailable`.
- A refusal flags exactly one argument in `inputArgumentResults` (the others `Good`), or none. The two refusals with no argument flagged differ in their status code, so a client can tell a retry from a definitive answer:
  - **Transient:** `BadWaitingForInitialData`, no argument flagged: the simulation is not attached yet, or not every server has started and replayed the events it missed (`not-attached`), or the run has finished (`not-running`). Nothing was checked or accepted; the caller may retry the same command until its `ExpiresAt` (a finished run never accepts again, so its commands end as `expired` or are settled against the next epoch).
  - **Permanent:** `BadInvalidState`, no argument flagged: production mode `schedule` (`wrong-mode`), where no retry is ever accepted. `BadInvalidState` with an argument flagged is `epoch-mismatch` or `expired` (above).
- **FIFO:** the job is appended; the CNC runs its queue in order, and the head job waits for its `NotBefore` (the CNC is `Idle` with cause `NO-ORDER` meanwhile). A job whose product isn't loaded starts with a changeover (`CHANGEOVER A→B`, `A` = `none` for a CNC's first job). A job's quantity is blanks started.
- Every accepted call raises the job's `accepted` event in the device sequence before the call returns; the job's `started` (its first blank) and `completed` (the end of its last OP10 cycle, whatever the result) follow.
- In live mode the job is accepted at the simulation time of the last processed step, as `LoadProgram`.

## Alarms (ADR-0010)

The simulator raises and clears alarms; acknowledgement, shelving and history belong to the MES (Phase 6).

| Code                                                         | Machines                       | Severity | Active from … until …                                    |
| ------------------------------------------------------------ | ------------------------------ | -------- | -------------------------------------------------------- |
| each failure code in `failures.yaml` (`SPINDLE-OVERLOAD`, …) | the machine with that mode     | 700      | the machine goes `Down` with that code … its repair ends |
| `CALIBRATION-DUE`                                            | LKT-01 (the leak-test station) | 300      | the calibration interval runs out … the calibration ends |

- The set of `ShopFloor.Alarms.<CODE>.Active` variables per machine is fixed at server start, from the plant configuration (`alarmCodes` in `apps/simulator/src/opcua/plant-servers.ts`); all start false.
- Every transition sets the Boolean, updates `ActiveCount` and raises one `ShopFloorAlarmEventType` event, which uses the shared per-machine `Sequence`.
- An alarm never goes active twice without being cleared in between (checked by the simulator's invariant checker).
- Path helper: `opcuaAlarmPath(code)` in `@shopfloor/contracts`.

## Events (ADR-0009)

Events are raised on the machine object, which is a notifier of the Server object, so a subscription on `i=2253` receives the events of that server.

| Event type (`nsu=<uri>;s=…`)    | Fields besides BaseEventType                                                                                                                                                   | Raised when                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `ShopFloorStateChangeEventType` | Sequence, MachineId, FromState, ToState, Cause                                                                                                                                 | Every state change                            |
| `CycleCompleteEventType`        | Sequence, MachineId, Product, PartId, Serial, Result (`good`, `scrap`, `rework`), Reason, MeasurementValue (NaN if none), LotMaterials (String[]), LotIds (String[]), Operator | Every completed cycle                         |
| `ShopFloorAlarmEventType`       | Sequence, MachineId, AlarmCode, Transition (`active`, `cleared`); BaseEventType `Severity` set per code                                                                        | Every alarm transition                        |
| `ShopFloorJobEventType`         | Sequence, MachineId, Transition (`accepted`, `started`, `completed`), CommandId, OrderId, Product, Quantity                                                                    | Every job transition (orders mode, CNCs only) |

- `Time` is the simulation time; `ReceiveTime` is wall time.
- **Lots and operator on a cycle (1.2, #196, ADR-0033).** `LotMaterials` and `LotIds` are two `String[]` (`valueRank` 1) of equal length: the lots the machine consumed for this part, in consumption order, as material and lot id pairs (CNC-01/02: the blank lot of the OP10 cycle; ASM-01: the component lots of this pass, `components` on the first pass and `reworkComponents` on a rework pass; every other cycle: two empty arrays). `Operator` (String) is the station's operator when the cycle started, which is the instant of the part's first material consumption on that machine; it is empty where a machine has no operator (every machine but ASM-01) and on a cycle that consumed nothing. The rule is one fold, `attachConsumption` and its live form `ConsumptionTracker` in `@shopfloor/trace-core`, which the machine server and the MES's golden harness share. The fields add no event: every `Sequence` stays as it was (tested: the (machine, `Sequence`, type) digest of a scripted shift). An empty array arrives at a client as an empty `String` array; a field another event type lacks arrives as `Null`, so "no lots" and "no field" are told apart (probe P1 of the Phase 8 plan).
- **Leak drift (control API 1.5, #196):** LKT-01's `MeasurementValue` carries an injected `leak-drift` while it is active; no field says so (the drift is a sensor fault, invisible to the device's clients). A drift ends at its `until` or at the start of the tester's next calibration; a drift applied during a running calibration survives that calibration and is ended by the next one.
- `Sequence` starts at 1 per machine and grows by 1 per event across all project event types, so gaps mean loss (plan section 5). Job events exist only in orders mode; a schedule-mode run's sequence is unchanged.
- After a reconnect, compare the `ShopFloor.Sequence` variable with the last event received (ADR-0009).
- Clients that need every event subscribe with sampling 0, a queue of 5000 and `discardOldest = false`. The server revises an event queue to 100–5000 entries, so a client should log `revisedQueueSize`.
- When a burst within one publishing interval is larger than the queue, the excess is lost. The queue also holds the Machinery `TransitionEventType` events, unless an OfType where-clause excludes them. The `Sequence` field shows the gap, and the `ShopFloor.Sequence` variable says how far the server got (tested in #56).
- A subscription on `i=2253` also receives the standard Machinery `TransitionEventType` events (see above). Select the project event types with an OfType where-clause, or ignore events without `MachineId`.
- Events raised before a client subscribes are not delivered later (no event history). A new client starts from the current `ShopFloor.Sequence` and the current values.
