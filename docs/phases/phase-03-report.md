# Phase 03 – Edge gateway and UNS: report

Period: 2026-10-15. Closed 2026-10-15; the `phase-03` tag is set right after this report merges. Milestone: [Phase 03 – Edge gateway and UNS](https://github.com/kubilayture/shopfloor-twin/milestone/4).

Under the owner's standing instruction of 2026-10-15, Claude closed the phase without the owner's review. No Phase 3 exit criterion needs the owner. The owner can watch the UNS live: `pnpm stack:up`, then `mosquitto_sub` as `dev` (runbook).

## Outcome against exit criteria

| #   | Exit criterion                                                                                                                                                                                            | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | At 60×, all machine data (five OPC UA machines and WSH-01) is visible in the UNS with valid envelopes. Every state change, cycle and alarm of the live event log is found, and every telemetry topic seen | Met    | `e2e.test.ts` runs the simulator, a real Mosquitto and the gateway as separate processes. A consumer validates **every** message against the contracts. For all six machines, every fact of the simulator's WebSocket event log arrives with the same device sequence, simulation time and content, in device order. All seven telemetry topics are seen. `collector.test.ts` and `poller.test.ts` prove the same per protocol                                         |
| 2   | A broker outage and a gateway restart (with messages still buffered) show no loss and no duplicates after dedup; an OPC UA server going offline shows a gap incident and a resync snapshot                | Met    | `e2e.test.ts`: one broker outage with the gateway killed by SIGKILL while machine facts are in its outbox (asserted by reading the file), then a second outage with the gateway alive. After the contract's `Deduplicator`, every fact appears exactly once, with no holes. `collector.test.ts`: a long OPC UA outage (session lost) and a short one (republish) give disconnect and reconnect incidents and snapshots, and published ∪ lost = emitted with no overlap |
| 3   | `docs/contracts/uns.md` (with generated JSON Schema) and `docs/contracts/modbus-register-map.md` are complete and checked by contract tests                                                               | Met    | `uns.test.ts` checks the generated JSON Schema for drift. `washer-server.test.ts` parses the register table and the default lookup tables of the register map, and reads them from the live Modbus server                                                                                                                                                                                                                                                              |
| 4   | Integration tests green in CI                                                                                                                                                                             | Met    | `verify` runs the Testcontainers broker tests, the collector, poller, outbox and end-to-end tests on every PR. `stack smoke` builds and runs simulator and gateway and checks the ACLs and all six machines' state in the UNS                                                                                                                                                                                                                                          |

## Delivered

| Issue | Pull request | What                                                                                     |
| ----- | ------------ | ---------------------------------------------------------------------------------------- |
| #70   | #81          | Phase 3 plan, revised after review: event ring for WSH-01, epochs, fault controls        |
| #71   | #82          | Spike: `modbus-serial` (ADR-0013), store-and-forward in `node:sqlite` (ADR-0014)         |
| #72   | #83          | UNS contracts: topics, envelope, schemas, JSON Schema, `Deduplicator`; ADR-0015          |
| #73   | #84          | Washer process values; run epoch on OPC UA                                               |
| #74   | #85          | WSH-01 Modbus TCP server with the event ring; register-map contract; Modbus silent fault |
| #75   | #86          | Gateway skeleton; broker users, ACL file, last will                                      |
| #76   | #87          | OPC UA collector with resync, gap incidents, snapshots; OPC UA offline fault             |
| #77   | #88          | WSH-01 Modbus poller                                                                     |
| #78   | #89          | Store-and-forward outbox                                                                 |
| #79   | #90          | Gateway container, Compose service, end-to-end test                                      |
| #80   | this PR      | Phase report, learning notes                                                             |

## Metrics

- Tests: 549 in total (simulator 296, `sim-core` 71, `contracts` 60, `edge-gateway` 33, `plant-config` 31, `eslint-config` 30, `test-kit` 28). Phase 2 ended at 452.
- Coverage:
  - `edge-gateway`: 92% lines, 79% branches; `main.ts` and the test helpers are excluded and run as processes in the end-to-end test;
  - simulator: 85% lines, 79% branches;
  - `sim-core`: 99% lines, 98% branches; `plant-config`: 99% lines, 91% branches.
- End to end: more than 80 facts across six machines compared one by one through two outages and a crash, in about 40 s.
- Containers at 60×:
  - gateway: 398 MB image, about 95 MiB and 4% CPU;
  - simulator: about 170 MiB.
- Store-and-forward: about 14,800 durably committed messages per second in batches (spike), against about 5 facts per second plus telemetry from the plant.
- ADRs: 0013 (`modbus-serial`), 0014 (SQLite outbox), 0015 (identity, epochs, dedup).

## Deviations from the plan

| Deviation                                                                      | Reason                                                                                        | Recorded in                         |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------- |
| Commands to machines (`cmd/load-program`) deferred to Phase 7                  | The roadmap row for Phase 3 doesn't list them; Phase 7 dispatches orders                      | Phase 3 plan                        |
| Fault controls (OPC UA offline, Modbus silent) built now instead of in Phase 9 | The resilience tests of this phase need them                                                  | Phase 3 plan (review)               |
| An event ring buffer in the WSH-01 register map                                | Polling at 60× would lose short states, cycles and alarms                                     | Phase 3 plan (review), register map |
| `epoch` added to the envelope, beyond plan section 5's fields                  | Sequences restart with their owner; (source, seq) alone can't tell a restart from a duplicate | ADR-0015                            |
| `unit` only on telemetry; gateway counters per topic, not per source           | Refinements of plan section 5                                                                 | `docs/contracts/uns.md`             |
| Status messages excluded from gap checks                                       | Reserved will numbers leave holes                                                             | `docs/contracts/uns.md`             |

## Known issues and carry-overs

- **Phase 4 (MES ingest)** implements `Deduplicator`'s rule:
  - pass `retained` for messages delivered on subscribe;
  - exclude `_sys/…/status` from gap checks;
  - record gap and incident messages as data-quality incidents;
  - use `sourceTime`, never `receivedAt`.
- **Facts lost while no gateway listens:** OPC UA has no event history (ADR-0009), so facts during a gateway outage are lost. They are counted (sequence-gap incident) when the gateway reconnects, but not at a fresh start, where they are history. WSH-01 keeps up to 64 facts in its ring.
- **After a device restart (new epoch)** the old run's last facts can't be counted, because the last number is unknown (documented for both protocols).
- **The gateway's responsibility ends at the PUBACK:** a broker killed outright loses what it acknowledged but hadn't passed on. Mosquitto persistence and subscriber sessions are a Phase 9 hardening topic.
- **Client-id takeover:** anyone with broker credentials can take over `gw-01`. This is an accepted risk until Phase 9 (the dynamic-security plugin).
- **`prom-client` is deprecated** upstream in favour of `@prometheus-io/client`: a follow-up for ADR-0012.
- **Renovate** is still not installed (owner item since Phase 0).
- **Docker Desktop memory:** simulator, gateway, broker and database together use about 350 MB. Raise the VM before Phase 4 adds the MES.

## Lessons

- **Reviews found a blocking flaw in nearly every gateway PR**, mostly about accounting under failure:
  - a lost range reported twice;
  - a reconnect storm spinning the event loop;
  - overflow trimming in-flight messages;
  - a consumer dropping retained alarms;
  - a cursor ahead of lost facts.

  None showed in the happy path. What found them was asking reviewers to _run_ failure scenarios.

- **Prove "nothing lost" with an equation, not a count.** The strongest tests assert `published ∪ lost = emitted` with no overlap, against an independent ground truth (the simulator's event stream).
- **Library edges matter more than library features:**
  - node-opcua's `killClientSockets` silently did nothing;
  - modbus-serial answers a missing handler with silence instead of exception 1;
  - MQTT.js keeps QoS 1 messages in memory across disconnects;
  - macOS needs `fullfsync` for a real flush.

  Each was found by an experiment, not by documentation.

- **Test isolation includes ports and shared state:** a test port that collided with TimescaleDB, and a client certificate store left locked by a killed process, cost the most debugging time.
