# ADR-0017: MES ingest: acknowledge after commit, snapshot anchors, gap incidents

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (#95), within the Phase 4 plan; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

The Phase 4 plan fixes the ingest's persistent session, its tables and ADR-0015's dedup rule. Implementing it left three questions open:

- **Acknowledgement:** MQTT.js acknowledges a QoS 1 message as soon as its handler returns. How does the MES make sure a message is acknowledged only once its row is committed?
- **Snapshot anchors:** the plan anchors the starting state per (equipment, epoch), but a snapshot carries the _gateway's_ epoch (`scope: topic`), not the device's. Which device epoch does it anchor?
- **Gap incidents:** a hole may still be filled by a late message. When does it become an incident, and what happens when it is filled afterwards?

## Considered options

Acknowledgement: (a) `customHandleAcks`; (b) overriding `handleMessage`, whose callback MQTT.js waits for before the PUBACK; (c) manual acknowledgements outside MQTT.js.

Snapshot anchors: (a) the device epoch the MES knows when the snapshot arrives; (b) the device epoch of the next device fact of that equipment; (c) no attribution, left to the equipment module.

Gap incidents: (a) report at once; (b) report after a grace period, and write the gap off so it can't be filled; (c) report after a grace period, keep accepting late numbers and update the incident.

## Decision outcome

- **Acknowledgement: (b).** The MES stores the message inside `handleMessage` and calls back after the commit. MQTT.js handles the next packet only after that callback, so messages are stored one at a time in arrival order. A failed transaction is retried with backoff (up to 10 s) and never acknowledged unstored; on shutdown or a crash the broker delivers it again to the persistent session. `customHandleAcks` (a) gates the same flow but is meant for choosing reason codes; (c) would need MQTT.js internals.
- **Anchors: (b).** A retained state event carries its device epoch. A snapshot waits with no device epoch until the next device fact (state, cycle or alarm) of its equipment arrives, and takes that fact's epoch. The gateway publishes a snapshot after reconnecting, typically just after a device restart, before the new epoch's first fact reaches the MES, so (a) would attribute it to the old epoch. The first anchor to arrive per (equipment, device epoch) wins.
- **Gaps: (c).** A hole between numbers seen becomes a `sequence-gap` incident once it has been open for `INGEST_GAP_GRACE_MS` (wall time, default 30 s; the clock restarts with the process). The cursor records it as `reported`, so it is recorded only once. A late message still counts as a new fact: it is stored and lowers the incident's `lost`, and the incident is closed as `filled` when nothing is missing. A newer epoch closes the old epoch's open gaps as `epoch-ended`, and records any not yet reported at once. `_sys` streams are deduplicated but not checked for gaps, because status numbers aren't gap-free.

### Consequences

- Good: nothing is acknowledged unstored, and nothing stored twice; a crash costs only redelivery.
- Good: a gap that a slow redelivery fills isn't counted as lost; the incident shows what was finally missing.
- Bad: one transaction per message limits throughput to the database's commit rate (not yet measured). The live plant sends tens of messages per second; draining a long outage's queue (up to 100,000 messages) may take minutes. Batching would need acknowledgements outside MQTT.js's one-at-a-time flow.
- Bad: a snapshot with no device fact following it (a machine that stays silent) never gets a device epoch, so it can't anchor anything until a fact arrives.
