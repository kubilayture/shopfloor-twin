# Phase 02 – Device layer: OPC UA: report

Period: 2026-10-15. Closed 2026-10-15 and tagged `phase-02`. Milestone: [Phase 02 – Device layer: OPC UA](https://github.com/kubilayture/shopfloor-twin/milestone/3).

Under the owner's standing instruction of 2026-10-15 ("continue until all of the phases is completed"), Claude closed the phase without waiting for a review by the owner. This phase has no exit criterion that only the owner can judge. The owner can still try the plant themselves, using the runbook section "Serve the plant".

## Outcome against exit criteria

| #   | Exit criterion                                                                                                   | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A generic OPC UA client browses every machine and sees values change at the chosen speed                         | Met    | `integration.test.ts`: every machine is found under `Machinery/Machines`, and telemetry timestamps advance by exactly wall time × speed at two speeds (60× and 15×). Manually, a client on the host read `asm-01.ShopFloor.State` from the container (#55)                                                                                                                                                                       |
| 2   | At 60×, a test client receives every state transition and cycle event of a scripted shift, with no sequence gaps | Met    | Over the rest of the Monday morning shift (seed 20261012), **five servers and two clients each** received every state, cycle and alarm event with a gap-free `Sequence`. Counts and event times equal the model's own events. The manual clock delivers about 200 times faster than a real 60× run                                                                                                                               |
| 3   | A method call switches the program                                                                               | Met    | `opcua.test.ts`: `LoadProgram(VB-200, 50)` changes over CNC-01, and `ShopFloor.Program` follows; a bad product gives `BadInvalidArgument` on that argument                                                                                                                                                                                                                                                                       |
| 4   | Integration tests green in CI                                                                                    | Met    | The `verify` job runs the OPC UA, control API and integration tests on every PR. The `stack smoke` job builds and runs the simulator container and checks all five OPC UA ports                                                                                                                                                                                                                                                  |
| 5   | `docs/contracts/opcua-address-space.md` complete and checked against the live servers                            | Met    | The contract test parses the Project variables and Events tables. It checks every variable path, data type and machine on all five servers (run in-process by the test), and each event type's fields on CNC-01. Alarm folders match the code's alarm codes, and `LoadProgram` exists exactly on the CNCs. The Endpoints, Methods and Alarms tables are prose and not parsed; the container's ports are checked by `stack smoke` |

## Delivered

| Issue | Pull request | What                                                                                                                        |
| ----- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| #46   | #58          | Phase 2 plan; ADR-0011 (Claude merges after an independent review), plan rev. 6                                             |
| #47   | #59          | Spike: node-opcua servers and lossless delivery; ADR-0008 (address space), ADR-0009 (events with sequence numbers)          |
| #48   | #60          | Spike: alarms; ADR-0010 (state variables plus events; lifecycle in the MES)                                                 |
| #49   | #61          | Live mode: wall-clock pacing 0.5–60×, pause, resume, step; identical events to headless                                     |
| #50   | #62          | Process values: spindle load and coolant temperature                                                                        |
| #51   | #63          | One OPC UA server per machine: companion model, project namespace, events with sequence numbers, simulation-time timestamps |
| #52   | #64          | `LoadProgram` on the CNCs                                                                                                   |
| #53   | #65          | Alarms: failure codes and `CALIBRATION-DUE`; alarm invariants                                                               |
| #54   | #66          | Control API: REST, WebSocket events, health, metrics (ADR-0012), env config, graceful shutdown, OpenAPI                     |
| #55   | #67          | Simulator container and Compose service                                                                                     |
| #56   | #68          | Integration and contract tests; ADR-0009 follow-ups                                                                         |
| #57   | this PR      | Phase report, learning notes                                                                                                |

## Metrics

- Tests: 452 in total (simulator 282, `sim-core` 71, `eslint-config` 30, `plant-config` 29, `test-kit` 28, `contracts` 12). Phase 1 ended at 376.
- Coverage:
  - simulator: 85% lines, 80% branches (floor 80 / 70); by area, plant 97%, OPC UA 96%, control API 89%;
  - `sim-core`: 99% lines, 98% branches;
  - `plant-config`: 99% lines, 91% branches.
  - Entry points (`main.ts`, the CLIs) are exercised by smoke runs, not measured.
- OPC UA delivery: 0 events lost across 10 subscriptions over a shift. Overflow only happens on purpose (queue at the minimum of 100, plus a one-day burst), and `Sequence` detects it.
- Container: 388 MB image; healthy about 6 s after start; about 170–225 MiB memory and about 1% CPU at 60× (PR #67); SIGTERM shutdown in about 0.3 s.
- Golden week: unchanged except for 4 new alarm events (#53).
- ADRs: 0008, 0009, 0010, 0011, 0012.

## Deviations from the plan

| Deviation                                                                        | Reason                                                                                                   | Recorded in                          |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Claude merges every PR after an independent review agent and green CI            | Owner decision                                                                                           | ADR-0011, plan rev. 6                |
| Alarms as state variables plus events, not OPC UA Alarms & Conditions            | Ownership of the lifecycle (MES) and one delivery path; the spike found one genuine node-opcua deviation | ADR-0010                             |
| `prom-client` for metrics, not the OpenTelemetry SDK                             | One small dependency for a Prometheus endpoint; OpenTelemetry is reconsidered with tracing in Phase 9    | ADR-0012                             |
| `pnpm sim:serve` configured by environment variables instead of flags            | Plan section 8 requires validated environment configuration                                              | PR #66, runbook                      |
| Control API refuses control (503) until the OPC UA servers listen                | Found by review: a control call during start-up crashed autostart                                        | PR #66, contract                     |
| #53 narrowed to raise and clear; acknowledge, shelve and history move to the MES | Follows from ADR-0010                                                                                    | ADR-0010, Phase 6                    |
| Recommended event queue is 5000, not "at least 10,000"                           | node-opcua bounds event queues to 100–5000                                                               | ADR-0009 follow-up results, contract |

## Known issues and carry-overs

- **Phase 3 gateway:**
  - after each (re)connect, apply the resync rule of ADR-0009: read `Sequence` and `State`, record a data-quality incident for a gap, then publish the current state;
  - select project events with an OfType where-clause, so that Machinery TransitionEvents don't take up queue slots;
  - in Compose, connect to `opc.tcp://simulator:4841` with `endpointMustExist: false`, or set `SIM_OPCUA_HOST=simulator`.
- **Machinery `CurrentState`** values carry a wall-clock timestamp that node-opcua sets internally (PR #63). The gateway must take simulation time from the `ShopFloor` variables and events only.
- **Reproducing a live run that received commands** needs its `program-loaded` events as inputs. Replaying them belongs to the Phase 9 scenarios (PR #64).
- **The golden week doesn't reach `CALIBRATION-DUE`:** its first calibration falls due exactly at the end of the run. Unit tests and a 30-day stress run cover it (#53).
- **Control API:** it has no authentication until Phase 9, and binds to loopback by default; in Compose it is published on `127.0.0.1` only. Fault and infrastructure controls (inject a failure, take a server offline) arrive in Phase 9.
- **No event history:** OPC UA events lost while a client is disconnected are detected, not recovered (ADR-0009, known limit for v1).
- **Docker Desktop's 2 GB VM:** the database, broker and simulator fit (about 250 MB at runtime), but the MES joins in Phase 4. The runbook says to raise the VM memory first.
- **Renovate** is still not installed (owner item since Phase 0).

## Lessons

- **Reviews against the running system found the worst bugs.** The control API review reproduced two of them by running the real entry point:
  - a start-up race that crashed the process;
  - a shutdown that hung behind a stalled WebSocket client.

  Unit tests built on `app.inject` couldn't see either. Since then, every review prompt asks the reviewer to run the entry point.

- **Requested OPC UA parameters are only requests.** Two silent revisions surfaced:
  - sampling 0 became 50 ms (spike #47);
  - a 10,000-entry event queue became 5000 (#56).

  Tests now assert `revisedQueueSize` where it matters.

- **Tests that read the documentation keep the contract honest.** Parsing the contract tables in a test caught nothing new this time, but it turns "the doc is complete" from a claim into a check.
- **Spikes first paid off.** Both spikes changed the design before production code existed:
  - lossless delivery needs events or `minSupportedSampleRate: 0`;
  - Alarms & Conditions have real costs.
- **Type stripping shapes packaging.** Node.js won't strip types under `node_modules`, so the container installs the workspace instead of using `pnpm deploy`. This is a consequence of ADR-0003 to remember for the MES image.
