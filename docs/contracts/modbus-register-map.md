# Contract: WSH-01 Modbus register map

Version 1 (Phase 3). Source of truth in code: `packages/contracts/src/modbus.ts`. Server: `apps/simulator/src/modbus/washer-server.ts`. A contract test (`washer-server.test.ts`) parses the Registers table below and checks it against the code and the running server. Any change bumps `mapVersion` and the version here, and needs a changelog entry.

WSH-01, the conveyor washer, is a legacy device (plan section 3): it exposes raw registers without semantics. The gateway gives them meaning through this map.

## Connection

| Setting  | Value                                                                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol | Modbus TCP                                                                                                                                                                          |
| Port     | 5020 (`MODBUS_PORT`); bound to `MODBUS_HOST`, default `127.0.0.1`                                                                                                                   |
| Unit id  | 1. Requests for any other unit id get no answer, which looks like a timeout                                                                                                         |
| Function | 3, read holding registers; at most 125 registers per request. Every other function answers exception 1 (illegal function); writes are not supported                                 |
| Errors   | exception 2 (illegal data address) for a read outside 0–739, or of 126–127 registers; a read of 128 or more registers gets exception 4 from the library before the map is consulted |
| Encoding | 16-bit words, big-endian; 32- and 64-bit values put the high word first                                                                                                             |

## Registers

| Address | Name              | Type    | Meaning                                                                                                                       |
| ------- | ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0       | `mapVersion`      | u16     | Register map version, 1                                                                                                       |
| 1       | `epoch`           | u32     | Start of this simulator run, Unix seconds: the epoch of the event sequence (ADR-0015). Same value as OPC UA `ShopFloor.Epoch` |
| 3       | `simTime`         | u64     | Simulation time of this snapshot, ms since 1970 UTC                                                                           |
| 7       | `state`           | u16     | Current machine state, as an index into the state table                                                                       |
| 8       | `status`          | u16     | Bit 0 heater on, bit 1 heater fault active, bit 2 conveyor running                                                            |
| 9       | `bathTemperature` | i16     | Bath temperature in units of the bath resolution (0.1 °C)                                                                     |
| 10      | `conveyorSpeed`   | u16     | Conveyor speed in units of the conveyor resolution (0.01 m/min)                                                               |
| 11      | `cycles`          | u32     | Cycles completed since the run started                                                                                        |
| 13      | `eventCounter`    | u32     | Sequence number of the newest ring entry; 0 before the first                                                                  |
| 15      | `ringCapacity`    | u16     | Entries in the ring, 64                                                                                                       |
| 16      | `entrySize`       | u16     | Registers per entry, 10                                                                                                       |
| 100     | `ring`            | entries | 64 entries of 10 registers each (100–739). The entry with sequence _s_ is at 100 + ((_s_ − 1) mod 64) × 10                    |

The scaling of `bathTemperature` and `conveyorSpeed` comes from the resolutions in `processValues.washer` in `process.yaml`. Changing a resolution changes the map and needs a new map version.

## Ring entries (events)

Every state change, completed cycle and alarm transition of WSH-01 becomes one entry, numbered by the device's own sequence (1, 2, 3, …), so the poller can prove it missed nothing.

| Offset | Type | Meaning                                                                                                                                                          |
| ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | u32  | Sequence number                                                                                                                                                  |
| 2      | u64  | Simulation time of the fact, ms since 1970 UTC                                                                                                                   |
| 6      | u16  | Entry type: 1 state change, 2 cycle complete, 3 alarm                                                                                                            |
| 7      | u16  | State change: the new state (state table). Cycle: product index in the low byte, result in the high byte (0 good, 1 scrap, 2 rework). Alarm: 1 active, 0 cleared |
| 8      | u32  | State change: cause index (cause table; 0 means none). Cycle: part id. Alarm: alarm code index (alarm table)                                                     |

**Reading without loss:**

1. Read `eventCounter` (with the snapshot block, registers 0–16).
2. Read the entries from the last sequence handled up to the counter, in requests of at most 12 entries (120 registers). Split a request where the ring ends (address 740): entries 64 and 65 are not next to each other in the address space, and a read across the end answers exception 2.
3. Check every entry's own sequence number. If an entry carries a higher number than expected, the ring wrapped: more than 64 facts happened since the last poll. That is an overrun, and the facts in between are lost.
4. After a gateway restart, continue from the last sequence handled, kept on disk, if the epoch is unchanged; otherwise start from the current counter.

An entry is only rewritten when the ring wraps 64 facts later, and then it carries the new sequence number. Checking every entry's own number therefore makes it safe to read the counter and the entries in separate requests.

## Tables

**States** (index → state; the same order as the UNS `MACHINE_STATES`): 0 Off, 1 Idle, 2 Running, 3 Stopped, 4 Starved, 5 Blocked, 6 Setup, 7 Down, 8 PlannedStop, 9 Maintenance.

The other tables are derived from the plant configuration by `modbusTables()`, identically in the simulator and the gateway. With the default configuration:

| Table    | Index → value                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Causes   | 0 none, 1 `HEATER-FAULT`, 2 `CONVEYOR-JAM`, 3 `BREAK`, 4 `SHIFT-END`, 5 `NO-OPERATOR` (the washer's failure codes, then its minor-stop causes, then the unavailability causes) |
| Products | 0 `VB-100`, 1 `VB-200` (`products.yaml` order)                                                                                                                                 |
| Alarms   | 0 `HEATER-FAULT` (the washer's failure codes; severity 700, as on OPC UA)                                                                                                      |

A legacy washer doesn't read serial numbers: cycle entries carry the part id but no serial.
