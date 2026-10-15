# Simulator control API

Version 1.2 (Phase 5; 1.0 in Phase 2, 1.1 adds `GET /api/v1/ground-truth`, #100; 1.2 adds its `oee` section, #117). The OpenAPI document's `info.version` is `1.2.0`. Source of truth in code: `apps/simulator/src/control/`. The OpenAPI description is generated into `docs/api/simulator-control.openapi.json`; a test fails when it drifts from the routes (`pnpm --filter @shopfloor/simulator openapi` rewrites it). Any change bumps the version here and needs a changelog entry.

The simulation console (Phase 9) is the client. The MES never uses this API: it sees the plant only through OPC UA and MQTT (plan section 5).

## Endpoint

`http://<CONTROL_HOST>:<CONTROL_PORT>`, by default `http://127.0.0.1:4800`. There is no authentication in Phase 2, so the default binds to loopback only. Access control comes with security in Phase 9.

## REST (`/api/v1`)

| Method and path            | Body             | Success                          | Errors                                                      |
| -------------------------- | ---------------- | -------------------------------- | ----------------------------------------------------------- |
| `GET /api/v1/status`       | none             | 200 `Status`                     | none                                                        |
| `GET /api/v1/ground-truth` | none             | 200 `GroundTruth`                | none                                                        |
| `POST /api/v1/pause`       | none             | 200 `Status`                     | 409 when the run has finished                               |
| `POST /api/v1/resume`      | none             | 200 `Status`; starts an idle run | 409 when the run has finished                               |
| `POST /api/v1/step`        | none             | 200 `{ stepped, status }`        | 409 unless paused or idle                                   |
| `PUT /api/v1/speed`        | `{ "speed": n }` | 200 `Status`                     | 400 when `speed` is missing, not a number or outside 0.5–60 |

- `Status` is `{ state, speed, simTime, lagMs, events }`.
  - `state` is `idle`, `running`, `paused` or `finished`.
  - `simTime` is ISO 8601 UTC.
  - `lagMs` is how far event processing trails the paced clock, in wall milliseconds.
  - `events` is the run-wide sequence number of the last plant event.
- `GroundTruth` is the headless ground truth (`docs/simulation-model.md`, "Ground-truth summary") of the live run so far, as `summary.json` would hold it if the run ended at `simTime`: `machines` (per machine `stateMs`, `byShift` keyed `2026-10-12/A` or `no-shift`, with all ten states, and `cycles`), `production` and `lots`; plus `epoch` (the run's epoch, as the devices publish it), `start`, `simTime` (how far events have been processed; the open state of each machine counts up to here), `pacedTime` (the paced simulation clock at the moment of reading, as `status` reports it; `simTime` trails it by up to about 1 s × speed while running), `currentBucket`, `buckets` (every bucket seen, `complete` once the run has left it; `no-shift` collects every gap between shifts and can be entered again), `current` (each machine's state and when it began) and `oee` (1.2: the ground-truth OEE as `summary.json` holds it, see `docs/simulation-model.md`, "Ground-truth OEE": per machine the `oee-core` inputs per shift bucket and UTC hour and the `bucketOee` result per shift bucket, per work center the `workCenterOee` result per shift bucket; fractions as `num/den` strings and four-decimal strings). An open Stopped interval appears with `open: true` and its whole length up to `simTime`, so a bucket still in progress can be `provisional` and differ from the MES's; only complete buckets are reconciled (ADR-0021). Cycles are bucketed by their time, but `byShift` and `buckets` follow the shift events: a snapshot taken between a cycle exactly at a shift start and that shift's event (the same simulation millisecond, before the event is processed) can show that shift in `oee` with zero `stateMs` and only the cycle, before `byShift` and `buckets` have it. Reading it never moves the run, and a paused run's buckets don't change. Reconciliation tests compare the MES with it (#100); a client of the plant (the MES) never uses it.
- Pausing a run that is not running, or resuming a running one, changes nothing and returns the status.
- `step` processes exactly one simulation event. `stepped: false` means no event is left before the end.
- Every error, including 404 and malformed JSON, is `{ error, message }`.
- Request bodies are strict: `"5"` or `true` is not a speed, and unknown fields give 400.
- Until every OPC UA server listens, `pause`, `resume`, `step` and `speed` return 503 `the simulator is starting`, so the run cannot move before its events have somewhere to go. `status` always answers.
- Pacing never changes the event stream: a run produces the same events whatever the pauses, steps and speed changes (proven by the pacer's property test, #49).

## Faults (`/api/v1/faults`)

Infrastructure faults for resilience tests (plan section 4), brought forward from Phase 9 for the Phase 3 gateway tests.

| Method and path                       | Body                         | Success                                       | Effect                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/faults/modbus`          | `{ "silent": true\|false }`  | 200 `{ silent }`                              | WSH-01 accepts connections but stops answering, or answers again. Its registers keep updating meanwhile, so a poller that recovers finds the ring entries it missed, unless more than 64 facts happened      |
| `POST /api/v1/faults/opcua/{machine}` | `{ "offline": true\|false }` | 200 `{ offline }`; 404 for an unknown machine | The machine's OPC UA server drops its connections and refuses new ones, or accepts them again. Its address space keeps following the plant meanwhile, so a reconnecting client sees how far `Sequence` moved |

## WebSocket: plant events

`GET /api/v1/events` upgrades to a WebSocket. Every plant event is sent as one text message in exactly the format of a headless event-log line (`schema: sim-event/1`, run-wide `seq`, ISO `at`, sorted keys; see `docs/simulation-model.md`, Event log).

- Events are not replayed: a client receives the events emitted after it connects. A gap in `seq` means the client missed events.
- The stream is read-only. A client that sends a message is closed with code 1003.
- A client whose unsent data exceeds 4 MB is disconnected (terminated, without a close frame, which a stalled client couldn't read) instead of being buffered without bound. It detects the gap through `seq` when it reconnects.

## Operations

| Path            | Meaning                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/health/live`  | 200 `{ "status": "ok" }` while the process is up                                                                   |
| `/health/ready` | 200 when every OPC UA server is listening and the run hasn't finished; otherwise 503 `{ "status": "unavailable" }` |
| `/metrics`      | Prometheus text format (ADR-0012)                                                                                  |

Metrics besides the standard `process_*` and `nodejs_*` ones:

| Metric                   | Type    | Meaning                                          |
| ------------------------ | ------- | ------------------------------------------------ |
| `sim_events_total{type}` | counter | Plant events emitted since start, by event type  |
| `sim_events_seq`         | gauge   | Run-wide sequence number of the last plant event |
| `sim_time_seconds`       | gauge   | Current simulation time, Unix seconds            |
| `sim_speed_ratio`        | gauge   | Simulation seconds per wall-clock second         |
| `sim_lag_seconds`        | gauge   | How far event processing trails the paced clock  |
| `sim_pacer_state{state}` | gauge   | 1 for the current pacer state, 0 for the others  |
| `sim_websocket_clients`  | gauge   | Connected event-stream clients                   |

## Configuration (environment)

The simulator validates its environment at start-up. With any invalid value it names each offending variable and exits with status 2. Empty variables count as unset.

| Variable            | Default                          | Meaning                                                                      |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `SIM_SEED`          | 1                                | Random seed, decimal digits, 0 to 2³²−1                                      |
| `SIM_SPEED`         | 60                               | Speed, 0.5–60                                                                |
| `SIM_START`         | `2026-10-12T06:00:00+03:00`      | Simulation start, ISO 8601 with an offset                                    |
| `SIM_CONFIG_DIR`    | `config/plant` in the repository | Plant configuration directory                                                |
| `SIM_AUTOSTART`     | `true`                           | `false` starts idle; the run begins with `POST /api/v1/resume`               |
| `OPCUA_HOST`        | `localhost`                      | Host name the OPC UA servers advertise and bind                              |
| `OPCUA_PORT_OFFSET` | 0                                | Added to the OPC UA ports 4841–4845                                          |
| `OPCUA_PKI_DIR`     | `./.pki`                         | Certificate store, one folder per machine                                    |
| `MODBUS_HOST`       | `127.0.0.1`                      | Bind address of the WSH-01 Modbus TCP server                                 |
| `MODBUS_PORT`       | 5020                             | Port of the WSH-01 Modbus TCP server (docs/contracts/modbus-register-map.md) |
| `CONTROL_HOST`      | `127.0.0.1`                      | Bind address of the control API                                              |
| `CONTROL_PORT`      | 4800                             | Port of the control API                                                      |
| `LOG_LEVEL`         | `info`                           | pino level: `fatal` … `trace`, or `silent`                                   |

## Shutdown

On SIGTERM or SIGINT the simulator:

1. stops the pacer;
2. closes the control API, terminating open WebSockets so that a client which stopped reading can't hold it up, and shuts down the OPC UA servers at the same time;
3. exits with status 0 (SIGTERM) or 130 (SIGINT).

If that takes longer than 10 s, it exits with status 1.
