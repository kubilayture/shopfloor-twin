# Phase 02 – Device layer: OPC UA: learning notes

Phase 2 put the simulated plant "on the wire". Each machine now speaks OPC UA, the standard protocol of real machines, and a control API steers simulation time. This file explains the ideas and gives a reading order, questions _with answers_, and an exercise. These notes are reference material; the learning step itself is optional, as in earlier phases.

## 1. Concepts

### OPC UA in one page

- An OPC UA **server** exposes an _address space_: a graph of nodes (objects, variables, methods, types) connected by typed references.
- A **client** can:
  - browse the graph;
  - read and write values;
  - call methods;
  - **subscribe**.
- A subscription holds **monitored items**. Each item watches one value (data changes) or one event notifier (events). The server queues notifications per item and sends them every _publishing interval_.
- Every node has a `NodeId`, written for example `ns=2;s=cnc-01.ShopFloor.State`. Namespace _indexes_ can differ per server, so contracts use the stable _URI_ form, `nsu=urn:…;s=…` (`toIndexedNodeId` converts it).

### Companion specifications

OPC UA defines generic building blocks; industry groups publish _companion specifications_ on top. We use:

- **DI** (devices): identification such as manufacturer and serial number;
- **Machinery:** machine identification, the `Machines` folder, and the item state and operation mode state machines;
- **Machine Tools**, for the CNCs.

A generic client that knows Machinery finds every machine and its state without knowing our project. Our own variables live in the project namespace under `ShopFloor` (ADR-0008).

### Values versus events, and why sequence numbers

- A **variable** holds the _current_ value. A client sampling it can miss a short state that came and went between samples.
- An **event** is a _fact that happened_, queued per subscriber.
- ADR-0009 sends every state change, cycle and alarm as an event carrying a per-machine **`Sequence`**:
  - consecutive numbers prove nothing was lost;
  - a jump proves something was lost, and how much.
- Variables still carry the current state, so a client that (re)connects can recover where things stand. This is the **resync rule**.

### Simulation time on the wire

Every project (`ShopFloor`) value and event carries the **simulation time** as its `SourceTimestamp` (or `Time`). The one exception is the Machinery state machines' `CurrentState`, which node-opcua stamps with wall time itself. The MES computes everything from these, never from wall time. That way a run at 60× gives the same OEE as a run at 1×, and the MES can be tested against the simulator's ground truth.

### Pacing without changing the outcome

The live pacer only decides _when_ the next simulation step is processed, never _what_ it does. That is why a live run produces byte-for-byte the same events as a headless run with the same seed. A property test proves it under random pauses, steps and speed changes.

### Alarms: state plus transitions

- An alarm is a _condition_ that stays true for a while.
- On OPC UA it appears twice:
  - as a Boolean `Active` variable, which is state for late joiners;
  - as an event for every transition, which is history for connected clients.
- Acknowledging and shelving are _operator_ actions, so they belong in the MES, not in the machine (ADR-0010).

### Operating a service

- **Liveness and readiness:** "don't restart me" versus "send me work".
- **Graceful shutdown:** on SIGTERM, stop accepting work, close connections in order, and exit before the orchestrator kills the process.
- **Configuration:** validated environment variables, fail-fast on bad values.
- **Metrics:** a Prometheus `/metrics` endpoint (ADR-0012).
- **Contract tests:** the OpenAPI file and the OPC UA contract are checked against the running code.

## 2. Reading order

| #   | File                                                                           | Look for                                                          |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | `docs/contracts/opcua-address-space.md`                                        | What a client sees: endpoints, variables, methods, alarms, events |
| 2   | `docs/adr/0008`, `0009`, `0010`                                                | Why it looks like that; the measured trade-offs                   |
| 3   | `apps/simulator/src/live/pacer.ts`                                             | Wall time × speed; pause, step, deferred calls                    |
| 4   | `apps/simulator/src/opcua/machine-server.ts`                                   | Building the address space; raising events with a sequence        |
| 5   | `apps/simulator/src/opcua/plant-servers.ts`                                    | Five servers, buffering until they listen, `alarmCodes`           |
| 6   | `apps/simulator/src/opcua/integration.test.ts`                                 | How "no event lost" and "contract complete" are proven            |
| 7   | `docs/contracts/simulator-control-api.md`, `apps/simulator/src/control/app.ts` | The control API, health, metrics                                  |
| 8   | `apps/simulator/Dockerfile`, `docker-compose.yml`                              | The simulator as a container                                      |

## 3. Questions, with answers

**1. Why can't the gateway simply sample `ShopFloor.State` every 100 ms?**

At 60×, 100 ms of wall time is 6 s of plant time, and a minor stop can be shorter. Sampling sees only the values that happen to be current at each sample, so short states vanish. Spike #47 measured this: with default settings, 70–90% of short state changes were lost. Events are queued per subscriber, so each one arrives.

**2. A client receives sequences 101, 102, 105. What happened, and what should it do?**

Events 103 and 104 were lost, for example by a queue overflow or a dropped session. The client can't get them back, because OPC UA has no event replay here. It should:

1. record a data-quality incident with the gap size;
2. read the current `State` (and the counters) to resynchronise;
3. continue from 105.

This is ADR-0009's rule, and the overflow test (#56) shows the signature.

**3. Why is `SourceTimestamp` the simulation time and not the time the server sent the value?**

All MES calculations (durations, OEE, shift splits) must be the same whatever the simulation speed, and must match the simulator's ground truth. Wall-clock timestamps would stretch or compress every duration by the speed factor and add network jitter. `ServerTimestamp` still carries wall time, for diagnosing delays.

**4. Why does a live run produce exactly the same events as a headless run?**

The pacer changes only _when_ `simulation.step()` is called, never the order of events or the random draws. The order of events is fixed by the event queue (time, then insertion order), and each entity has its own random stream. So the sequence of handled events is identical. Commands from outside (`LoadProgram`) are the exception: they are new inputs, recorded as `program-loaded` events.

**5. Why are alarms not modelled with OPC UA Alarms & Conditions?**

A&C bundles the lifecycle (acknowledge, confirm, shelve) into the server. In this project the operator acts in the MES, which also needs alarm history, priorities and flood detection (plan section 7). Duplicating that state in five machine servers would give two sources of truth. A&C would also add a second delivery path next to our sequenced events. The spike also found a real node-opcua deviation (`Retain` after an acknowledgement).

**6. The control API refuses `resume` with 503 right after start. Why is that correct?**

Until all five OPC UA servers listen, the events the run produces would reach no server and would then be replayed late from a buffer. More importantly, a `resume` racing the autostart crashed the process; the review reproduced this. 503 is "not ready yet, try again", which is the same answer `/health/ready` gives.

**7. Why does a slow WebSocket client get terminated rather than buffered?**

Buffering without a limit lets one slow client exhaust the server's memory. Past 4 MB of unsent data, the client is cut off and can reconnect; the gap in `seq` tells it what it missed. A close frame wouldn't help, because it would queue behind the backlog that the client isn't reading.

**8. Why does the container install the workspace instead of using `pnpm deploy`?**

Node.js runs our TypeScript sources directly, by stripping types (ADR-0003), but it refuses to do that for files under `node_modules`. `pnpm deploy` copies the workspace packages into `node_modules`, so they couldn't run. A workspace install keeps them as symlinks to `packages/*/src`, and Node resolves the real path outside `node_modules`.

**9. A client asked for an event queue of 10,000. What did it get, and how would it know?**

It got 5000, node-opcua's maximum for event items, which accepts 100 to 5000. The answer is `revisedQueueSize` in the monitored-item result. Clients should log it, and tests should assert it. A request is not a guarantee.

**10. What does the contract test catch that a code review might miss?**

- A variable added to the code but not to the contract, or the other way round.
- A wrong data type in the document.
- A variable exposed on the wrong machines.
- An event type whose fields differ from the document.

The document becomes something CI checks, not just a description.

## 4. Hands-on exercise

Watch lossless delivery and the resync rule yourself.

1. Start the plant: `SIM_AUTOSTART=false pnpm sim:serve` (or `pnpm stack:up`). Since #237 the control API needs a token: `export SIM_CONTROL_TOKEN=$(openssl rand -hex 16)` before `sim:serve` (with the stack, the value from your `.env`); the `curl` calls below send it.
2. Connect UaExpert to `opc.tcp://localhost:4841`.
   - Browse `Objects → Machines → CNC-01 → ShopFloor`.
   - Add an event view on the Server object, with the fields `Sequence`, `MachineId` and `ToState`. It also shows the Machinery TransitionEvents. Their `Sequence` and `MachineId` are empty, so ignore those rows, or filter on `ShopFloorStateChangeEventType`.
3. `curl -s -H "Authorization: Bearer $SIM_CONTROL_TOKEN" -X POST localhost:4800/api/v1/resume`, and watch the sequence numbers climb without gaps.
4. Disconnect UaExpert for a minute, then reconnect. Compare the last `Sequence` you saw with `ShopFloor.Sequence` now. The difference is exactly the number of events the gateway would report as a gap in Phase 3.
5. `curl -s -H "Authorization: Bearer $SIM_CONTROL_TOKEN" -X PUT localhost:4800/api/v1/speed -H 'content-type: application/json' -d '{"speed": 5}'`, and see the `SourceTimestamp` advance more slowly.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
