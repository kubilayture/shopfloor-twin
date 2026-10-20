# ADR-0009: Lossless OPC UA delivery: events with sequence numbers, exception-based values

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (spike #47), owner on review

## Context and problem statement

Plan section 5 (rev. 2): no state transition, cycle completion or alarm may be lost between machine and gateway at any simulation speed, and each carries a per-source sequence number. At 60× a 10-second stop lasts about 170 ms of wall time, and same-millisecond bursts occur, for example at a shift boundary. How are these facts delivered?

## Measurements (spike #47)

Setup:

- node-opcua 2.187.3, one machine, one client over loopback, one subscription per item;
- publishing interval 100 ms, `discardOldest=false`;
- 600 changes in about 5.5 s (about 110 per second), with bursts of 10 in the same millisecond every 50 changes;
- the count uses each notification's `Sequence`.

Two runs per server setting:

| Delivery                                                                           | Default server (revises sampling 0 to 50 ms) | Server with `minSupportedSampleRate: 0` |
| ---------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------- |
| Monitored item, sampling 0, queue 1                                                | 99–110 of 600                                | 129–155 of 600                          |
| Monitored item, sampling 0, queue 1000                                             | 110 of 600                                   | **600 of 600, in order**                |
| Monitored item, sampling 100, queue 1000                                           | 56 of 600                                    | 55–56 of 600                            |
| Events of a custom type with a `Sequence` field (machine object and Server object) | **600 of 600, in order**                     | **600 of 600, in order**                |

For comparison, the real load: a headless day has about 6,800 state and cycle events for the whole plant. At 60× that is about 5 per second, at most 15 in one wall-clock second, and at most 10 with the same timestamp.

By default node-opcua revises a requested sampling interval of 0 to 50 ms. Within that window changes are coalesced, and a larger queue doesn't help: it holds samples, not changes. Only a server that advertises a `MinSupportedSampleRate` of 0 serves variables with `MinimumSamplingInterval` 0 exception-based, delivering every change.

## Considered options

1. Monitored items on the state variables, exception-based.
2. Events for state changes, cycle completions and alarms; variables for current values and telemetry.

## Decision outcome

Chosen option: 2.

- **State changes, cycle completions and alarm transitions are events** with a per-machine `Sequence` (UInt32, starting at 1, +1 per event, across all three event types).
  - An event carries every field atomically: state, cause, sequence, simulation time (as `Time`), serial and so on.
  - With variables, `State`, `StateCause` and `Sequence` would arrive as separate notifications that a client must re-assemble, and could see half-updated.
  - The gateway detects gaps from the sequence (plan section 5).
  - Only real transitions consume a sequence number. Events that re-send known information, such as an Alarms & Conditions ConditionRefresh (ADR-0010), carry the current sequence unchanged, and the gateway doesn't treat them as new.
- **Variables still carry the current values:** `State`, counters and process values, for browsing clients and for the retained UNS state. Their `MinimumSamplingInterval` is 0, and the server advertises `minSupportedSampleRate: 0`. A client asking for sampling 0, a queue of at least 1000 (node-opcua grants at most 5000; see Follow-up results) and `discardOldest=false` gets every change; the integration tests use these settings.
- **Telemetry (process values)** may be sampled and decimated (plan section 5): ordinary monitored items with a sampling interval.
- **Timestamps:** `Time` and `SourceTimestamp` are simulation time; `ReceiveTime` and `ServerTimestamp` are wall time (phase 2 plan).

### Consequences

- Good: lossless delivery is measured, not assumed, and the gap check by sequence makes any future loss visible.
- Good: per machine, the OPC UA events are a projection of the simulator's own event log (state, cycle and alarm events; material, shift and operator events stay internal), so the golden truth and the OPC UA stream can be compared machine by machine.
- Bad: subscribing to events is slightly more involved for clients (event filters with project fields). The address-space contract documents the fields.
- Bad: queue sizes must stay large enough for bursts. At 60× the whole plant emits about 5 events per second; the spike sustained about 93 per second per machine without loss.
- The plan section 12 open decision on lossless delivery is closed.

### Not covered by the spike, and how it is handled

The spike proves lossless delivery during an intact session. The following weren't tested:

- five servers with several clients at once (gateway plus a browsing client);
- session loss, reconnect and server restart;
- event-queue overflow.

OPC UA doesn't replay events lost while a session is down, so loss there is **detected, not prevented**. Rule for the gateway (Phase 3):

- after every (re)connect, read each machine's `Sequence` and `State` variables;
- if `Sequence` is ahead of the last event received, record a data-quality incident with the gap size (plan section 5);
- then publish the current state from the variables, so the UNS is correct again.

Recovering the missed _history_ would need the simulator's event log or an OPC UA history service. That is out of scope for v1 and listed as a known limit.

Follow-up tests:

- #56 (integration): five servers with two clients at 60×; overflow behaviour with a deliberately small queue.
- Phase 3 resilience: disconnect and reconnect with gap detection and resync.

### Follow-up results (#56, 2026-10-15)

- **Five servers, two clients each, at 60×:** over the rest of the Monday morning shift (seed 20261012), each of the ten subscriptions received every state, cycle and alarm event of its machine, with a gap-free `Sequence`. This is also the number of events the model emitted.
- **The queue size is revised.** node-opcua 2.187.3 bounds an event monitored item's queue to 100–5000 entries; a request of 0 gives 1000. A request of 3 becomes 100, and a request of 10,000 becomes 5000. The earlier advice of "at least 1000" stands, and 5000 is the useful maximum. Clients must log `revisedQueueSize`.
- **Overflow is detected:** with the 100-entry minimum, `discardOldest = true` and a burst of a simulated day in one tick, the client received fewer events than were raised. Its `Sequence` showed the gap, the newest event arrived, and the `Sequence` variable equalled the server's last number. That is the resync rule above, now tested. node-opcua raises no EventQueueOverflow event for event items, so `Sequence` is the only detector. The queue also holds the Machinery TransitionEvents, so the surviving project events are fewer than the queue size.

### Amendment: where loss happens in practice (#243, resilience suite, 2026-10-20)

The resilience suite's run R3 (Phase 9 plan P9-16) measured on the hardened stack (SignAndEncrypt, 60×, `orders-01`):

- **A server going offline loses nothing while the session lives.** The simulator's offline fault interrupts every secure channel and refuses new ones, but node-opcua keeps the session and its subscription on the server; the gateway's client reconnects, reactivates the session and republishes the queued events. CNC-01 offline for 30 s and for 90 s of wall time (the plan's 07:00–07:30, and 07:00–08:30) lost no event: no `sequence-gap`, every number stored. The resync still runs (snapshot and alarm snapshot within 0.2 s of the session's return).
- **Loss comes from a new session:** a gateway killed while the line runs starts new sessions whose subscriptions begin at the current `Sequence`; what the machines raised in between is never delivered. The collector takes it as its baseline (history, no incident of its own); the MES finds the hole in the device stream and records it as a `sequence-gap` after `INGEST_GAP_GRACE_MS`. Killed 10:45–10:50, four machines lost 16 facts, every one inside [kill − ε, the time of the resync's `asOfSeq` fact in the simulator's event log] and numbered at most that `asOfSeq`, with no lead, and the MES's answers equal the golden harness's on what it stored. WSH-01 lost none: the Modbus poller read the missed entries from its 64-entry ring.
- **Consequence for R3 (decided):** the plan's schedule (CNC-01 offline 07:00–07:30, the gateway killed 10:00–10:05 inside shift A's break, when no machine raises a fact) loses nothing, so the detected-loss assertions would hold on empty sets and exit criterion 5's detected-loss class would pass vacuously. The coordinator moved R3's schedule (#243): CNC-01 offline 07:00–08:30 and the gateway killed 10:45–10:50 while the line runs; R3 must lose at least one fact (`exercised: true`) or fail. The plan's first schedule stays as `RESILIENCE_R3_SCHEDULE=plan`, a non-loss variant.
