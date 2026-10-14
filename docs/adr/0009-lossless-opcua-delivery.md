# ADR-0009: Lossless OPC UA delivery: events with sequence numbers, exception-based values

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (spike #47), owner on review

## Context and problem statement

Plan section 5 (rev. 2): no state transition, cycle completion or alarm may be lost between machine and gateway at any simulation speed, and each carries a per-source sequence number. At 60× a 10-second stop lasts about 170 ms of wall time, and same-millisecond bursts occur, for example at a shift boundary. How are these facts delivered?

## Measurements (spike #47, node-opcua 2.187.3, one machine, 600 changes in about 6.5 s with bursts of three in the same millisecond)

| Delivery                                                                                          | Revised sampling    | Received                 |
| ------------------------------------------------------------------------------------------------- | ------------------- | ------------------------ |
| Monitored item, sampling 0, queue 1, default server                                               | 50 ms               | 114–178 of 600           |
| Monitored item, sampling 0, queue 1000, default server                                            | 50 ms               | 130 of 600               |
| Monitored item, sampling 100, queue 1000                                                          | 100 ms              | 63–66 of 600             |
| Monitored item, sampling 0, queue 1000, `discardOldest=false`, server `minSupportedSampleRate: 0` | 0 (exception-based) | **600 of 600, in order** |
| Events of a custom type with a `Sequence` field (on the machine object and on the Server object)  | –                   | **600 of 600, in order** |

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
- **Variables still carry the current values:** `State`, counters and process values, for browsing clients and for the retained UNS state. Their `MinimumSamplingInterval` is 0, and the server advertises `minSupportedSampleRate: 0`. A client asking for sampling 0, a queue of at least 1000 and `discardOldest=false` gets every change; the integration tests use these settings.
- **Telemetry (process values)** may be sampled and decimated (plan section 5): ordinary monitored items with a sampling interval.
- **Timestamps:** `Time` and `SourceTimestamp` are simulation time; `ReceiveTime` and `ServerTimestamp` are wall time (phase 2 plan).

### Consequences

- Good: lossless delivery is measured, not assumed, and the gap check by sequence makes any future loss visible.
- Good: events map one-to-one onto the simulator's own event log, so the golden truth and the OPC UA stream can be compared event by event.
- Bad: subscribing to events is slightly more involved for clients (event filters with project fields). The address-space contract documents the fields.
- Bad: queue sizes must stay large enough for bursts. At 60× the whole plant emits about 5 events per second; the spike sustained about 93 per second per machine without loss.
- The plan section 12 open decision on lossless delivery is closed.
