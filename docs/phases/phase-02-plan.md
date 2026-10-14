# Phase 02 – Device layer: OPC UA: plan

Planned 2026-10-15. Plan reference: section 4 (two run modes, interactivity), section 5 (components, delivery guarantees), section 11 row 2, section 12 (node-opcua risk). Size: M. Milestone: [Phase 02 – Device layer: OPC UA](https://github.com/kubilayture/shopfloor-twin/milestone/3).

## Scope

The simulator gets its second run mode, **live**:

- Simulation time is paced to wall time × a speed factor (0.5× to 60×), with pause, resume and single step.
- The five OPC UA machines are exposed as **one OPC UA server per machine**, the way real equipment would be.
- A control API lets the simulation console (Phase 9), and tests, steer time.

Out of scope here:

- Modbus for WSH-01 (Phase 3).
- Faults and infrastructure controls in the control API (Phase 9).
- OPC UA security other than mode None (Phase 9).
- Any client beyond tests (the gateway is Phase 3).

The headless mode and the golden scenario stay unchanged. Live mode runs the same plant model; pacing only decides _when_ the next simulation step is processed, never _what_ happens. The event stream of a live run therefore equals the headless one for the same seed and duration, and a test proves it.

## Machines and endpoints

| Machine | Endpoint (default)         | Exposes                                                                                                                                  |
| ------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CNC-01  | `opc.tcp://localhost:4841` | Identification, state and cause, counters, last serial, program (`LoadProgram`), cycle events, alarms, spindle load, coolant temperature |
| CNC-02  | `opc.tcp://localhost:4842` | As CNC-01                                                                                                                                |
| ASM-01  | `opc.tcp://localhost:4843` | Identification, state and cause, counters, operator, cycle events, alarms                                                                |
| LKT-01  | `opc.tcp://localhost:4844` | Identification, state and cause, counters, last leak reading and limit, calibration due, cycle events, alarms                            |
| PCK-01  | `opc.tcp://localhost:4845` | Identification, state and cause, counters, cycle events, alarms                                                                          |

WSH-01 is a Modbus device (plan section 3) and joins in Phase 3 on port 5020.

## Decisions made in this plan

- **Timestamps:** every value and event carries the **simulation time as SourceTimestamp**; ServerTimestamp is wall time (plan section 4). The MES computes OEE from SourceTimestamp only, so its results don't depend on simulation speed.
- **`LoadProgram(product, quantity)`** on a CNC inserts a campaign at the _front_ of that CNC's queue. A product change then causes a changeover at the next cycle boundary, exactly as a schedule change would. It returns a status and the campaign position. The same method is the target of MES order dispatch in Phase 7 (plan section 5, data path 3).
- **Process values** (spindle load and coolant temperature are new: a small model in `apps/simulator/src/plant`, deterministic, with their own random streams; the leak reading exists since #25):
  - CNC spindle load: about 65% ± noise while `Running`, 0 otherwise;
  - CNC coolant temperature: a first-order lag towards 22–30 °C;
  - the existing LKT-01 leak reading.

  This gives the gateway (Phase 3) real telemetry to sample. Parameters live in `config/plant/process.yaml`.

- **Sequence numbers:** every state change, cycle event and alarm carries a per-source sequence number, so a client can prove it missed nothing (plan section 5, rev. 2). How it is exposed is decided in ADR-0009 (#47).
- **Node ids** for every exposed node are constants in `@shopfloor/contracts` (plan section 8: OPC UA node ids belong in contracts). A contract test compares the live address space with them and with `docs/contracts/opcua-address-space.md`.
- **Control API:** Fastify (plan section 6). REST endpoints for time (`pause`, `resume`, `step`, `speed`) and a WebSocket stream of plant events. Every service gets `/health/live`, `/health/ready` and `/metrics`, and shuts down gracefully on SIGTERM (plan section 8).
- **Config** comes from environment variables, validated at start-up (seed, start, speed, ports).

## Issues, in dependency order

| #                                                              | Task                                                                                                                                                                                                                                                                                         | Depends on    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [#46](https://github.com/kubilayture/shopfloor-twin/issues/46) | Phase 2 plan (this document)                                                                                                                                                                                                                                                                 | –             |
| [#47](https://github.com/kubilayture/shopfloor-twin/issues/47) | Spike: node-opcua server per machine, Machine Tools companion model vs project model, and lossless delivery at 60× (events vs queued monitored items). Results: ADR-0008 (address-space model), ADR-0009 (lossless delivery)                                                                 | #46           |
| [#48](https://github.com/kubilayture/shopfloor-twin/issues/48) | Spike: alarm representation, Alarms & Conditions vs state variables. Result: ADR-0010                                                                                                                                                                                                        | #47           |
| [#49](https://github.com/kubilayture/shopfloor-twin/issues/49) | Live run mode: wall-clock pacing, speed 0.5–60×, pause, resume, single step; identical events to headless for the same seed                                                                                                                                                                  | #46           |
| [#50](https://github.com/kubilayture/shopfloor-twin/issues/50) | Process values: spindle load, coolant temperature (config, model, tests, docs)                                                                                                                                                                                                               | #46           |
| [#51](https://github.com/kubilayture/shopfloor-twin/issues/51) | OPC UA servers: one per machine, address space per ADR-0008, values, counters and cycle events driven by plant events; node ids in `contracts`; sequence numbers per ADR-0009                                                                                                                | #47, #49, #50 |
| [#52](https://github.com/kubilayture/shopfloor-twin/issues/52) | `LoadProgram` method on the CNCs                                                                                                                                                                                                                                                             | #51           |
| [#53](https://github.com/kubilayture/shopfloor-twin/issues/53) | Alarms on the OPC UA servers per ADR-0010                                                                                                                                                                                                                                                    | #48, #51      |
| [#54](https://github.com/kubilayture/shopfloor-twin/issues/54) | Control API: Fastify REST time controls, WebSocket event stream, health and metrics, env config                                                                                                                                                                                              | #49           |
| [#55](https://github.com/kubilayture/shopfloor-twin/issues/55) | Simulator container in Docker Compose (live mode, ports 4841–4845 and the control API)                                                                                                                                                                                                       | #51, #54      |
| [#56](https://github.com/kubilayture/shopfloor-twin/issues/56) | Integration tests and contract doc: a generic client browses every machine; values change at the chosen speed; at 60× every state transition and cycle event of a scripted shift arrives, with no sequence gaps; `LoadProgram` switches the program; `docs/contracts/opcua-address-space.md` | #51, #52, #53 |
| [#57](https://github.com/kubilayture/shopfloor-twin/issues/57) | Close Phase 2: report, learning notes, tag                                                                                                                                                                                                                                                   | all           |

## Exit criteria (plan section 11)

1. A generic OPC UA client browses every machine and sees values change at the chosen speed.
2. At 60×, a test client receives every state transition and cycle event of a scripted shift, with no sequence gaps (plan rev. 2).
3. A method call switches the program.
4. Integration tests green in CI.
5. `docs/contracts/opcua-address-space.md` complete and checked against the live servers.

## Risks for this phase

| Risk                                                                                | Response                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node-opcua gaps (Alarms & Conditions details, companion nodesets) (plan section 12) | Spikes #47 and #48 come before any production code. If something doesn't work, fall back to state variables or a project-specific model, recorded in an ADR |
| node-opcua releases several versions a day                                          | Pin a version at least three days old; Renovate groups updates; a major upgrade needs an ADR                                                                |
| Pacing makes runs non-deterministic                                                 | Pacing only changes when a step runs, never which step. A test compares the live and headless event streams for the same seed                               |
| Short stops are merged away at 60× (plan rev. 2)                                    | Spike 2 measures it; exit criterion 2 tests it                                                                                                              |
| Five servers plus the control API on a 2 GB Docker VM                               | Measured in #55; raise Docker Desktop memory if needed (runbook)                                                                                            |
