# ADR-0015: UNS message identity: sequence scopes, epochs and dedup

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (#72), from the Phase 3 plan review; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Plan section 5 requires QoS 1 everywhere, with the MES ingest deduplicating "by source and sequence number", and with gaps logged as data-quality incidents. ADR-0009 gives every OPC UA machine a per-machine `Sequence`. The plan review of Phase 3 found three problems with a plain (equipment, seq) key:

- **Restarts:** sequences restart at 1 when the simulator restarts. Compose restarts it with the same seed and start time, so new facts would look like duplicates. Gateway counters restart the same way.
- **Two kinds of sequence:** device facts carry the device's sequence; telemetry has no device sequence.
- **Resync snapshots:** after a reconnect, the gateway republishes the current state read from variables (ADR-0009). Giving it the device's current `Sequence` would collide with the last fact.

## Considered options

1. (equipment, seq), with consumers resetting on a gap larger than some threshold.
2. A random message id per message, and a set of seen ids.
3. Explicit sequence scopes plus an epoch: (stream, epoch, seq).

## Decision outcome

Chosen option: 3.

- **`scope: device`:** state changes, cycles and alarm transitions carry the device's own sequence. There is one stream per equipment, shared across its `state`, `events` and `alarms` topics, so the MES can order all facts of a machine and prove completeness.
- **`scope: topic`:** telemetry, resync snapshots and `_sys` messages carry a gateway counter per topic.
- **`epoch`:** the start time (Unix seconds) of whoever owns the sequence: the simulator process for device sequences (exposed as `ShopFloor.Epoch` over OPC UA and in two Modbus registers), the gateway process for its counters. A larger epoch starts the stream over; a smaller one is old.
- **Snapshots** are `uns.state.current/1` with `kind: snapshot` and `scope: topic`, so they never enter device dedup or gap checks.
- **Consumer rule** (`Deduplicator` in `@shopfloor/contracts`, which the MES implements in Phase 4):
  - a message with a newer epoch, or the first one seen, starts the stream;
  - a seen `seq`, or an older epoch, is a duplicate;
  - out-of-order deliveries are accepted;
  - missing numbers below the highest seen are gaps.

Option 1 can't tell a restart from loss. Option 2 deduplicates, but can't detect gaps, which plan section 5 requires.

### Consequences

- Good: duplicates from QoS 1 and replays are removed exactly; a restart is visible as an epoch change, not as a flood of duplicates or a fake gap.
- Good: gap detection is per device across all its fact topics, which is what "no transition lost" means.
- Bad: an epoch from wall-clock seconds assumes a source doesn't restart twice within one second. A crash loop that fast would merge two runs; the gateway reports an `epoch-change` incident on every restart, so it would be visible.
- Bad: a consumer that joins late can't tell whether earlier numbers were lost. By definition, it starts at the first message it sees.
