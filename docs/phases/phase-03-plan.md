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
- **Retained:** `state`, `telemetry` (last value) and `alarms` (one topic per alarm code, last transition) are retained; `events` are not; `_sys` status is retained, with the last will "offline".
- **Envelope:** one shape for every payload:
  - `schema` (name and version, for example `uns.state.current/1`);
  - `source` (equipment id and protocol);
  - `seq`;
  - `sourceTime` (simulation time from the device);
  - `receivedAt` (gateway wall time);
  - `quality` (`good`, `uncertain`, `bad`);
  - `value`, and `unit` where it applies.

  The exact rules for `seq` and the dedup key are ADR-0015 (#72). The working assumption: OPC UA state, cycle and alarm messages carry the machine's own `Sequence`, so dedup is by (equipment, `seq`) across those classes; telemetry carries a per-topic gateway counter.

- **QoS 1 everywhere** (plan section 5). Duplicates are expected after a reconnect and are removed by dedup on (equipment, `seq`), never by hoping they don't happen.
- **WSH-01 without loss.** A polled legacy device can miss a state that comes and goes between polls. At 60×, a 250 ms poll is 15 s of plant time. The washer's register map therefore includes a **ring buffer of the last 32 state changes**, with a write counter, as many PLCs keep an event buffer. The poller reads only new entries; if the counter moved by more than 32 between polls, it reports an overrun incident. This keeps exit criterion 1 honest for WSH-01, and the MES's reconciliation (Phase 4) possible.
- **Store-and-forward** on local disk:
  - the gateway writes every message to the buffer first, and deletes it only after the broker's PUBACK;
  - after a broker outage it replays in original order;
  - the buffer is bounded, and overflow raises a `_sys` incident.

  Storage is decided by spike #71. The candidate is Node's built-in `node:sqlite` (SQLite 3.53 in Node 26, no extra dependency).

- **Gateway configuration** comes from validated environment variables, like the simulator: endpoints, broker URL and credentials, poll interval, buffer path and limits. The gateway reads the equipment hierarchy from `config/plant`.
- **Broker users:**
  - `gw-01` may publish only machine classes and its own `_sys` topic;
  - `mes` may read everything and publish `mes`, `cmd` and its own `_sys`;
  - `dev` is read-only;
  - `healthcheck` stays as it is.

  ACLs are rendered from `.env` by the broker's entrypoint, as the password file is today.

## Issues, in dependency order

| #                                                              | Task                                                                                                                            | Depends on |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [#70](https://github.com/kubilayture/shopfloor-twin/issues/70) | Phase 3 plan (this document)                                                                                                    | –          |
| [#71](https://github.com/kubilayture/shopfloor-twin/issues/71) | Spike: Modbus library (`modbus-serial` server and client) and store-and-forward storage. Results: ADR-0013, ADR-0014            | #70        |
| [#72](https://github.com/kubilayture/shopfloor-twin/issues/72) | UNS contracts: topics, envelope, payload schemas, generated JSON Schema, `docs/contracts/uns.md`; ADR-0015 (sequence and dedup) | #70        |
| [#73](https://github.com/kubilayture/shopfloor-twin/issues/73) | Washer process values and heater fault for WSH-01                                                                               | #70        |
| [#74](https://github.com/kubilayture/shopfloor-twin/issues/74) | Modbus TCP server for WSH-01 in the simulator; `docs/contracts/modbus-register-map.md`                                          | #71, #73   |
| [#75](https://github.com/kubilayture/shopfloor-twin/issues/75) | Edge gateway skeleton; broker users, ACLs and last will                                                                         | #72        |
| [#76](https://github.com/kubilayture/shopfloor-twin/issues/76) | Gateway OPC UA collector: subscriptions, reconnection, resync, normalisation                                                    | #75        |
| [#77](https://github.com/kubilayture/shopfloor-twin/issues/77) | Gateway Modbus poller for WSH-01                                                                                                | #74, #75   |
| [#78](https://github.com/kubilayture/shopfloor-twin/issues/78) | Store-and-forward buffer                                                                                                        | #71, #75   |
| [#79](https://github.com/kubilayture/shopfloor-twin/issues/79) | Gateway container, Compose, UNS integration tests, broker-outage test                                                           | #76–#78    |
| [#80](https://github.com/kubilayture/shopfloor-twin/issues/80) | Close Phase 3: report, learning notes, tag                                                                                      | all        |

## Exit criteria (plan section 11)

1. All machine data (five OPC UA machines and WSH-01) is visible in the UNS with valid envelopes. A test validates every message of a scripted shift against the contracts and finds every state change, cycle and alarm of the simulator's event log.
2. A broker-outage test (broker stopped mid-shift, then restarted) shows no loss and no duplicates after dedup.
3. `docs/contracts/uns.md` (with generated JSON Schema) and `docs/contracts/modbus-register-map.md` are complete and checked by contract tests.
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
