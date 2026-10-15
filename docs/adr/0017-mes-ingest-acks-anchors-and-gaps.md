# ADR-0017: MES ingest: acknowledge after commit, snapshot anchors, gap incidents

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (#95), within the Phase 4 plan; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

The Phase 4 plan fixes the ingest's persistent session, its tables and ADR-0015's dedup rule. Implementing it left three questions open:

- **Acknowledgement:** MQTT.js acknowledges a QoS 1 message as soon as its handler returns. How does the MES make sure a message is acknowledged only once its row is committed?
- **Snapshot anchors:** the plan anchors the starting state per (equipment, epoch), but a snapshot carries the _gateway's_ epoch (`scope: topic`), not the device's. Which device epoch does it anchor?
- **Gap incidents:** a hole may still be filled by a late message. When does it become an incident, and what happens when it is filled afterwards?
- **Failures:** a message that can never be stored (a value out of range, a string the database refuses) must not block the stream, and a long database outage must not leave the session timing out over and over.

## Considered options

Acknowledgement: (a) `customHandleAcks`; (b) overriding `handleMessage`, whose callback MQTT.js waits for before the PUBACK; (c) manual acknowledgements outside MQTT.js.

Snapshot anchors: (a) the device epoch the MES knows when the snapshot arrives; (b) the device epoch of the next device fact of that equipment; (c) no attribution, left to the equipment module; (d) the gateway names the device epoch in the snapshot.

Gap incidents: (a) report at once; (b) report after a grace period, and write the gap off so it can't be filled; (c) report after a grace period, keep accepting late numbers and update the incident.

## Decision outcome

- **Acknowledgement: (b).** The MES stores the message inside `handleMessage` and calls back after the commit. MQTT.js handles the next packet only after that callback, so messages are stored one at a time in arrival order. A failed transaction is retried with backoff (up to 10 s) and never acknowledged unstored; on shutdown or a crash the broker delivers it again to the persistent session. `customHandleAcks` (a) gates the same flow but is meant for choosing reason codes; (c) would need MQTT.js internals.
- **Anchors: (d), with (b) as the fallback.** A retained state event carries its device epoch. Since contract 1.1 a snapshot carries `deviceEpoch`, which the gateway knows when it reads the state (OPC UA `ShopFloor.Epoch`, the Modbus `epoch` register); the MES uses it directly. A snapshot without it (an older gateway) waits until the next device fact (state, cycle or alarm) of its equipment and takes that fact's epoch, and any newer snapshot of the equipment supersedes it before that, so only the latest waiting one can be attributed. The first anchor to arrive per (equipment, device epoch) wins. (a) would attribute a snapshot sent just after a device restart to the old epoch. (b) alone, the first version, was wrong in two cases the #95 review found: a persistent broker re-sends a stale retained snapshot of an earlier run to a fresh MES, which then took the new run's epoch and won as first; and a machine without later facts never got an anchor.
- **Gaps: (c).** A hole between numbers seen becomes a `sequence-gap` incident once it has been open for `INGEST_GAP_GRACE_MS` (wall time, default 30 s; the clock restarts with the process). The cursor records it as `reported`, so it is recorded only once. A late message still counts as a new fact: it is stored and lowers the incident's `lost`, and the incident is closed as `filled` when nothing is missing. A newer epoch closes the old epoch's open gaps as `epoch-ended`, and records any not yet reported at once. Every epoch numbers from 1 (ADR-0015), so when a stream the MES knows starts a new epoch, the numbers below its first one are a hole like any other; a stream seen for the first time starts at its first number. `_sys` streams are deduplicated but not checked for gaps, because status numbers aren't gap-free.
- **Failures.** A failed transaction is classified by its SQLSTATE. Transient errors (classes 08, 57, 40, 53, 58, and socket errors) are retried four times with backoff (about 4 s). If they persist, the MES drops the session deliberately, without acknowledging, waits until `SELECT 1` succeeds and reconnects; the broker queues meanwhile and redelivers what was unacknowledged. Holding the session instead would starve it: MQTT.js handles no other packet while one waits, not even PINGRESP, so the session would time out and reconnect about every 1.5 keepalive intervals, piling up redeliveries. Data and integrity errors (classes 22, 23, 54), and unknown errors after three attempts, are recorded in `rejected_message` as `unstorable` with the error and acknowledged. Validation already refuses what is known to be unstorable: times outside the years 1970–2199, NUL characters and lone surrogates.

### Consequences

- Good: nothing is acknowledged unstored, and nothing stored twice; a crash costs only redelivery.
- Good: a gap that a slow redelivery fills isn't counted as lost; the incident shows what was finally missing.
- Good: one bad message is recorded and skipped, never retried forever; a database outage costs a reconnect, not a storm of them.
- Bad: one transaction per message caps the rate at about 1,000 messages/s on a local database (measured in the #95 review). The plant sends about 25 messages/s at 60×, so the broker's 100,000-message queue holds about an hour and drains in about two minutes. Batching would need acknowledgements outside MQTT.js's one-at-a-time flow.
- Bad: an unknown error (a bug, or a missing table) is retried only three times, then the message counts as unstorable instead of waiting for a fix; they stay in `rejected_message` with their payload, but nothing replays them yet.
- Bad: a snapshot from a gateway older than contract 1.1 still needs a later device fact to get its epoch.
