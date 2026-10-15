# Phase 03 – Edge gateway and UNS: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-15

- Phase 3 planned: issues #70–#80, milestone 4.
  - Commands to machines (`cmd/load-program`) are deferred to Phase 7, where orders need them; the roadmap row for Phase 3 doesn't list them.
  - WSH-01 gets a state-change ring buffer in its register map, so that polling at 60× loses nothing.
  - Store-and-forward will probably use Node's built-in `node:sqlite` (SQLite 3.53, no warnings on Node 26); spike #71 decides.
- The plan review (PR #81) asked for changes, all adopted:
  - WSH-01 completeness: the ring buffer became an event buffer for state, cycle and alarm entries;
  - an `epoch` in every sequence space, because numbering restarts with the process;
  - resync snapshots marked and kept apart from device sequences;
  - fault controls (OPC UA offline, Modbus silent) brought forward from Phase 9 for the resilience tests;
  - an incidents topic;
  - a static ACL file with `$SYS` access for the healthcheck;
  - store-and-forward details: status messages bypass the buffer, a named volume, and a gateway-restart test.
- Merged #81 (#70): Phase 3 plan.
- Spike #71: `modbus-serial` passes every check (ADR-0013). Its server needs the callback form for asynchronous or silent answers, because a returned Promise becomes exception 4. `node:sqlite` lost nothing under SIGKILL (ADR-0014). The review caught an unfair measurement: on macOS SQLite needs `fullfsync=ON` to flush like `fsyncSync` does. A durable commit then costs about 3 ms, so #78 commits in batches per flush tick (about 14,800 messages per second). Plan section 12's Modbus open decision is closed.
- Merged #82 (#71): the spike review caught an unfair storage comparison (macOS needs `fullfsync` for a real flush). The decisions stand, with batched commits.
- #72: `zod` and `fast-check` join `contracts`. Zod 4's `z.toJSONSchema` generates the JSON Schema, as for the OpenAPI file. The dedup rule accepts out-of-order delivery, because MQTT orders messages only per topic and device facts span three topics.
- #72 review: the first `Deduplicator` treated the first message as a high-water mark, so a consumer starting fresh would drop retained alarms with lower numbers as duplicates. The rule now keeps ranges of seen numbers, takes retained deliveries apart, and hands back gaps when an epoch closes. The schemas pin `scope` per payload, so a snapshot can't claim a device sequence.
- Merged #83 (#72): UNS contracts.
- #73: the washer's process values follow the CNC pattern: pure functions of simulation time, so the event log is unchanged; only the configuration hash in the golden header moved. The run epoch is wall time and lives outside the model, in `PlantServers`, so determinism is untouched.
- Merged #84 (#73): washer process values. The review confirmed byte for byte that only the golden header's configuration hash changed.
- #74: `modbus-serial` gives no answer at all for a function without a handler, where a real device answers exception 1. The server now refuses functions 1, 2, 4, 5, 6 and 16 explicitly. Ring entries are never rewritten until they wrap, so the poller can read the counter and the entries in separate requests. Each entry's own sequence reveals a wrap.
- Merged #85 (#74): Modbus server. The review found that reads must split at the ring end, and that values outside the tables were encoded silently; encoding now throws.
- #75: the gateway's integration tests run the project's real Mosquitto through Testcontainers, so the ACL file is tested, not only the code.
  - Docker here runs on Colima, so the test helper takes `DOCKER_HOST` from the active `docker context`.
  - Mosquitto rejects a denied QoS 1 publish with reason 0x87, and MQTT.js rejects the promise. The store-and-forward buffer (#78) must treat that as permanent, not retry it.
  - `prom-client` is deprecated upstream (replaced by `@prometheus-io/client`): a follow-up for ADR-0012.
- #75 review: `publish()` now refuses at once while disconnected, because MQTT.js would otherwise queue in memory and duplicate the disk buffer's replay. `close()` no longer hangs with in-flight packets; ACL areas are listed explicitly, since `+` matched `_sys`; client-id takeover is documented as an accepted risk until Phase 9.
- Merged #86 (#75): gateway skeleton.
- #76, three surprises:
  - **node-opcua's `killClientSockets` does nothing in 2.187**: it looks for a socket property that moved. The offline fault interrupts each secure channel with `abruptlyInterrupt()` instead, and a simulator test proves clients see the loss and the recovery.
  - **Test ports:** an offset that put CNC-02 on 5442 made the gateway talk OPC UA to the stack's TimescaleDB and hang. The gateway tests now use ports clear of the stack.
  - **Certificates:** collectors share one client certificate in the gateway's own folder (`OPCUA_PKI_DIR`), and start one after another. The default store in the user's home folder can be left locked by a killed process.
- #76 review:
  - Blocking: a lost range was reported again at the next reconnect, and a late copy could be both published and counted lost.
  - Blocking: one unreachable machine stopped every later collector from starting.
  - The collector now buffers events until their epoch is known, acknowledges every range it reports, coalesces reconnects, and starts the collectors concurrently once the shared certificate exists.
  - A new test forces a session loss and then a republish, and proves that published ∪ lost = emitted, with no overlap.
- Merged #87 (#76): OPC UA collector.
- #77: the poller is tested against an in-memory register map, built with the contract's own encoders: wrap, overrun, silence, cursor resume and epoch change. It is also tested against the real simulator, where every washer fact arrives in order through a 3 s silence. The metric `gateway_opcua_connected` became `gateway_device_connected`, because it now covers Modbus too.
