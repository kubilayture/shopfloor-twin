# Contract: OPC UA address space

Version 1 (Phase 2). Source of truth in code: `packages/contracts/src/opcua.ts`. Decisions: ADR-0008 (model), ADR-0009 (delivery), ADR-0010 (alarms). Any change bumps the version here and needs a changelog entry (plan section 2, Definition of Done).

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

| Path                                                        | Type           | Machines | Meaning                                                                                        |
| ----------------------------------------------------------- | -------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `ShopFloor.State`                                           | String         | all      | One of the ten states (plan section 4)                                                         |
| `ShopFloor.StateCause`                                      | String         | all      | Cause of the current state (failure code, `CHANGEOVER A→B`, `MATERIAL:SK-1`, …), empty if none |
| `ShopFloor.Sequence`                                        | UInt32         | all      | Last per-machine sequence number used by an event                                              |
| `ShopFloor.Counters.Produced`, `.Good`, `.Scrap`, `.Rework` | UInt32         | all      | Completed cycles since server start, total and per result                                      |
| `ShopFloor.LastSerial`                                      | String         | all      | Serial of the last completed cycle                                                             |
| `ShopFloor.Program`                                         | String         | CNCs     | Product the CNC is set up for                                                                  |
| `ShopFloor.Operator`                                        | String         | ASM-01   | Operator id at the station, empty if none                                                      |
| `ShopFloor.ProcessValues.SpindleLoad`                       | Double, %      | CNCs     | Telemetry, sampled (minimum sampling interval 100 ms)                                          |
| `ShopFloor.ProcessValues.CoolantTemperature`                | Double, °C     | CNCs     | Telemetry, sampled                                                                             |
| `ShopFloor.LeakTest.LastReading`                            | Double, Pa/min | LKT-01   | Last leak reading                                                                              |
| `ShopFloor.LeakTest.UpperLimit`                             | Double, Pa/min | LKT-01   | Pass/fail limit                                                                                |
| `ShopFloor.Alarms.ActiveCount`                              | UInt32         | all      | Number of active alarms (ADR-0010)                                                             |
| `ShopFloor.Alarms.<CODE>.Active`                            | Boolean        | all      | One per alarm code of the machine (see Alarms below); true while the alarm is active           |

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
- MES order dispatch uses this method in Phase 7 (plan section 5, data path 3).

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

| Event type (`nsu=<uri>;s=…`)    | Fields besides BaseEventType                                                                                             | Raised when            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `ShopFloorStateChangeEventType` | Sequence, MachineId, FromState, ToState, Cause                                                                           | Every state change     |
| `CycleCompleteEventType`        | Sequence, MachineId, Product, PartId, Serial, Result (`good`, `scrap`, `rework`), Reason, MeasurementValue (NaN if none) | Every completed cycle  |
| `ShopFloorAlarmEventType`       | Sequence, MachineId, AlarmCode, Transition (`active`, `cleared`); BaseEventType `Severity` set per code                  | Every alarm transition |

- `Time` is the simulation time; `ReceiveTime` is wall time.
- `Sequence` starts at 1 per machine and grows by 1 per event across all three types, so gaps mean loss (plan section 5).
- After a reconnect, compare the `ShopFloor.Sequence` variable with the last event received (ADR-0009).
- Clients that need every event subscribe with sampling 0, a queue of at least 1000 and `discardOldest = false`.
- A subscription on `i=2253` also receives the standard Machinery `TransitionEventType` events (see above). Select the project event types with an OfType where-clause, or ignore events without `MachineId`.
- Events raised before a client subscribes are not delivered later (no event history). A new client starts from the current `ShopFloor.Sequence` and the current values.
