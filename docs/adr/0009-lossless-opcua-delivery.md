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
- **Variables still carry the current values:** `State`, counters and process values, for browsing clients and for the retained UNS state. Their `MinimumSamplingInterval` is 0, and the server advertises `minSupportedSampleRate: 0`. A client asking for sampling 0, a queue of at least 1000 and `discardOldest=false` gets every change; the integration tests use these settings.
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
