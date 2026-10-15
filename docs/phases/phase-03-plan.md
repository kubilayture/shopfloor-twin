# Phase 03 – Edge gateway and UNS: plan

Planned 2026-10-15. Plan reference: section 3 (WSH-01), section 5 (components, UNS, envelope, delivery guarantees, data path 1), section 6 (Modbus, MQTT), section 9 (integration and resilience tests), section 11 row 3, section 12 (Modbus library). Size: L. Milestone: [Phase 03 – Edge gateway and UNS](https://github.com/kubilayture/shopfloor-twin/milestone/4).

## Scope

Phase 3 builds the edge layer: everything between the machines and the MES.

- **WSH-01 on Modbus TCP.** The simulator gets a Modbus TCP server for the legacy washer on port 5020, with a register map and no semantics, as in a brownfield plant. The washer also gets the process values plan section 3 promises: bath temperature, conveyor speed and the heater fault.
- **`edge-gateway`**, a new app:
  - OPC UA subscriptions to the five machines, with reconnection and the resync rule of ADR-0009;
  - a Modbus poller for WSH-01;
  - normalisation of everything into one UNS envelope;
  - publishing to Mosquitto with QoS 1 through an on-disk store-and-forward buffer.
- **UNS contracts:** topics, the envelope and every payload, as Zod schemas in `@shopfloor/contracts`, published as JSON Schema in `docs/contracts/`.
- **Broker security:** per-client users, topic ACLs, and the gateway's last will.

Out of scope here:

- Commands down to machines (`cmd/load-program` → `LoadProgram`); they arrive with orders in Phase 7.
- The MES ingest (Phase 4). This phase ships a small reference dedup consumer in `contracts` for tests, which is the rule the MES will implement.
- OPC UA security, broker TLS (Phase 9).
- Sparkplug B (decided after v1.0, plan section 12).

## Decisions made in this plan

- **Topics** follow plan section 5:
  - `orbis/gebze/{area}/{workcenter}/{equipment}/{class}/{name}`, built only by `contracts` helpers;
  - the hierarchy comes from `config/plant/plant.yaml`;
  - names are kebab-case, for example `telemetry/spindle-load` and `alarms/spindle-overload`.

  `_sys` topics, which have no equipment level, get their own helper:
  - `orbis/gebze/_sys/edge-gateway/gw-01/status` (retained; last will "offline");
  - `…/gw-01/incidents` (not retained), for data-quality incidents: sequence gap, ring-buffer overrun, device silent, buffer overflow.

- **Retained:** `state`, `telemetry` (last value) and `alarms` (one topic per alarm code, last transition) are retained; `events` and incidents are not.
- **Envelope:** one shape for every payload:
  - `schema` (name and version, for example `uns.state.current/1`);
  - `source` (equipment id and protocol);
  - `epoch` and `seq`;
  - `sourceTime` (simulation time from the device);
  - `receivedAt` (gateway wall time);
  - `quality` (`good`, `uncertain`, `bad`);
  - `value`, and `unit` where it applies.
- **Identity and dedup** (details in ADR-0015, #72):
  - **Sequence spaces are separate.**
    - _Device_ facts (state changes, cycles and alarm transitions) carry the device's own sequence: OPC UA `Sequence`, or the WSH-01 event-buffer sequence.
    - _Gateway_ streams (telemetry, snapshots) carry a gateway counter per topic.
  - **Every sequence space has an `epoch`**, because numbering restarts at 1 whenever its owner restarts. The Compose services restart on failure, with the same seed.
    - The simulator exposes a run epoch: the process start in Unix seconds, wall time, outside the model. It appears as `ShopFloor.Epoch` on OPC UA and in two registers on Modbus.
    - The gateway uses its own start time for gateway streams.
    - The dedup key is (equipment, stream, epoch, seq), where the stream is `device` or the topic.
    - A new epoch resets the expected sequence; a smaller `seq` within the same epoch is a duplicate.
  - **Resync snapshots are not events.** After a (re)connect, the gateway publishes the current state read from the variables (ADR-0009) with `kind: snapshot` and a gateway sequence. Dedup and gap checks on device sequences ignore them.
- **QoS 1 everywhere** (plan section 5). Duplicates are expected after a reconnect and are removed by the dedup above, never by hoping they don't happen. The reference dedup consumer in `contracts` is the rule the MES implements in Phase 4.
- **WSH-01 without loss.** A polled legacy device can miss what happens between polls: at 60×, a 250 ms poll is 15 s of plant time.
  - The washer's register map therefore includes an **event ring buffer of the last 64 facts**, as many PLCs keep an event buffer. Each entry covers a state change, a cycle (serial and result) or an alarm transition, with the device sequence and simulation time.
  - A 32-bit write counter sits in front of the buffer, and the poller reads the counter and the entries in one contiguous request.
  - If the counter moved by more than 64 since the last poll, the poller reports an overrun incident. After a gateway restart, it continues from the counter it last stored, or reports the gap.
  - This keeps exit criterion 1 honest for WSH-01, and makes the MES's reconciliation (Phase 4) possible.
  - The heater fault already exists as the failure mode `HEATER-FAULT` (`failures.yaml`). #73 adds the process values and exposes the fault; it doesn't model a new failure.
- **Fault controls for tests.** Plan section 4 lists infrastructure faults for the control API: "take a machine's OPC UA server offline" and "stop the legacy washer responding". They are brought forward from Phase 9, because the resilience tests here need them:
  - `POST /api/v1/faults/opcua/{machine}` with `{ "offline": true|false }`, in #76;
  - `POST /api/v1/faults/modbus` with `{ "silent": true|false }`, in #74.
- **Store-and-forward** on local disk:
  - the gateway writes every UNS message to the buffer first, and deletes it only after the broker's PUBACK; the buffer, not MQTT.js's in-memory store, owns retries;
  - after a broker outage or a gateway restart it replays in original order;
  - the buffer is bounded, and overflow raises an incident;
  - `_sys` status and the last will bypass the buffer, so an old "online" is never replayed after a newer state.

  The buffer lives in a named Compose volume. Storage is decided by spike #71; the candidate is Node's built-in `node:sqlite` (SQLite 3.53 in Node 26, no extra dependency). Until #78, the collectors (#76, #77) publish through a `Publisher` interface that #78 then backs with the buffer.

- **Gateway configuration** comes from validated environment variables, like the simulator: endpoints, broker URL and credentials, poll interval, buffer path and limits. The gateway reads the equipment hierarchy from `config/plant`.
- **Broker users and ACLs** live in a static `config/mosquitto/acl` file; only the passwords come from `.env`.
  - `gw-01` may publish only the machine classes (`state`, `telemetry`, `events`, `alarms`) and its own `_sys` topics. Its `cmd` subscription and `cmd-res` publish rights come with commands in Phase 7 (roadmap row 7: orders and dispatch).
  - `mes` may read everything and publish `mes`, `cmd` and its own `_sys` topics.
  - `dev` is read-only.
  - `healthcheck` keeps read access to `$SYS/#`; once an ACL file is set, Mosquitto denies everything not listed.
  - The smoke test checks an allowed and a denied publish for each user.

## Issues, in dependency order

| #                                                              | Task                                                                                                                                                                                                                | Depends on |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [#70](https://github.com/kubilayture/shopfloor-twin/issues/70) | Phase 3 plan (this document)                                                                                                                                                                                        | –          |
| [#71](https://github.com/kubilayture/shopfloor-twin/issues/71) | Spike: Modbus library (`modbus-serial` server and client) and store-and-forward storage. Results: ADR-0013, ADR-0014                                                                                                | #70        |
| [#72](https://github.com/kubilayture/shopfloor-twin/issues/72) | UNS contracts: topics (including `_sys` status and incidents), envelope, payload schemas, snapshots, generated JSON Schema, `docs/contracts/uns.md`, reference dedup consumer; ADR-0015 (epoch, sequence and dedup) | #70        |
| [#73](https://github.com/kubilayture/shopfloor-twin/issues/73) | Washer process values (bath temperature, conveyor speed) and the exposed heater fault for WSH-01; run epoch in the simulator                                                                                        | #70        |
| [#74](https://github.com/kubilayture/shopfloor-twin/issues/74) | Modbus TCP server for WSH-01 on port 5020 (Compose publishes it): register map with the event ring buffer and epoch, `docs/contracts/modbus-register-map.md` with a contract test, Modbus silent fault control      | #71, #73   |
| [#75](https://github.com/kubilayture/shopfloor-twin/issues/75) | Edge gateway skeleton; broker users, ACLs and last will                                                                                                                                                             | #72        |
| [#76](https://github.com/kubilayture/shopfloor-twin/issues/76) | Gateway OPC UA collector: subscriptions, reconnection, resync snapshots, gap incidents, normalisation; OPC UA offline fault control                                                                                 | #75        |
| [#77](https://github.com/kubilayture/shopfloor-twin/issues/77) | Gateway Modbus poller for WSH-01: event ring buffer, overruns, device silent                                                                                                                                        | #74, #75   |
| [#78](https://github.com/kubilayture/shopfloor-twin/issues/78) | Store-and-forward buffer                                                                                                                                                                                            | #71, #75   |
| [#79](https://github.com/kubilayture/shopfloor-twin/issues/79) | Gateway container, Compose (buffer volume), UNS integration tests, broker-outage and gateway-restart tests, OPC UA disconnect test                                                                                  | #76–#78    |
| [#80](https://github.com/kubilayture/shopfloor-twin/issues/80) | Close Phase 3: report, learning notes, tag                                                                                                                                                                          | all        |

## Exit criteria (plan section 11)

1. At 60×, all machine data (five OPC UA machines and WSH-01) is visible in the UNS with valid envelopes.
   - A test validates every message of a scripted shift against the contracts.
   - It finds every state change, cycle and alarm of the simulator's live event log (the control WebSocket `/api/v1/events`) for all six machines.
   - It sees every telemetry topic, the washer's included, at least once.
2. A broker-outage test (broker stopped mid-shift, then restarted) and a gateway-restart test (with messages still buffered) show no loss and no duplicates after dedup. An OPC UA server taken offline and back shows a gap incident and a resync snapshot.
3. `docs/contracts/uns.md` (with generated JSON Schema) and `docs/contracts/modbus-register-map.md` are complete:
   - a drift test checks the JSON Schema against the Zod schemas;
   - a contract test parses the register-map table and reads it from the live Modbus server.
4. Integration tests are green in CI.

## Risks for this phase

| Risk                                                                | Response                                                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modbus-serial` falls short as a server or client (plan section 12) | Spike #71 first; the washer is one device, so swapping the library is cheap                                                                                 |
| Polling loses short washer states at 60×                            | State-change ring buffer with a write counter in the register map; overrun detection                                                                        |
| Store-and-forward reorders or duplicates during replay              | Single writer, ordered by an autoincrement key; delete only after PUBACK; dedup by (equipment, `seq`) at the consumer; tests with a broker killed mid-burst |
| Mosquitto ACL mistakes lock out a client or leave topics open       | The smoke test checks both allowed and denied publishes per user                                                                                            |
| More containers on the 2 GB Docker VM                               | The gateway is small, and memory is measured in #79; raise the VM before Phase 4 (runbook)                                                                  |
| Phase size L                                                        | Strict dependency order; at most two PRs open; the spike and the contracts come first, so later issues don't re-decide them                                 |
