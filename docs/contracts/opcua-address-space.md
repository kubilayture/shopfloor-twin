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

Both Machinery state machines are derived from the project `State`:

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
| `ShopFloor.Alarms.ActiveCount`                              | UInt32         | all      | Number of active alarms (ADR-0010; filled by #53)                                              |

Value timestamps:

- non-telemetry variables are served exception-based (`MinimumSamplingInterval = 0`), with **SourceTimestamp = simulation time** of the event that changed them;
- telemetry has SourceTimestamp = the simulation time of the read; it is `UncertainNoCommunicationLastUsableValue` before the simulation has started.

## Events (ADR-0009)

Events are raised on the machine object, which is a notifier of the Server object, so a subscription on `i=2253` receives the events of that server.

| Event type (`nsu=<uri>;s=…`)    | Fields besides BaseEventType                                                                                             | Raised when             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `ShopFloorStateChangeEventType` | Sequence, MachineId, FromState, ToState, Cause                                                                           | Every state change      |
| `CycleCompleteEventType`        | Sequence, MachineId, Product, PartId, Serial, Result (`good`, `scrap`, `rework`), Reason, MeasurementValue (NaN if none) | Every completed cycle   |
| `ShopFloorAlarmEventType`       | Sequence, MachineId, AlarmCode, Transition (`active`, `cleared`)                                                         | Alarm transitions (#53) |

- `Time` is the simulation time; `ReceiveTime` is wall time.
- `Sequence` starts at 1 per machine and grows by 1 per event across all three types, so gaps mean loss (plan section 5).
- After a reconnect, compare the `ShopFloor.Sequence` variable with the last event received (ADR-0009).
- Clients that need every event subscribe with sampling 0, a queue of at least 1000 and `discardOldest = false`.
