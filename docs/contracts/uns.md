# Contract: Unified Namespace (UNS)

Version 1.3 (Phase 7; 1.2 in Phase 6, 1.1 in Phase 4, 1 in Phase 3). Version 1.1 adds the optional `deviceEpoch` to snapshots (#95) and to telemetry (#96). It is optional, so every version 1 message stays valid; the strict schemas mean an old consumer would refuse a snapshot that carries it, and the MES, the only consumer, accepts both. Version 1.2 (#141) adds the alarm snapshot: schema `uns.alarm-snapshot/1` on the topic `…/alarms/_snapshot`, the one topic name that isn't kebab-case. It is additive: no existing message changes, and a consumer that doesn't know the schema rejects it as unknown. Version 1.3 (#173, ADR-0029) adds the command path: commands `uns.cmd.load-order/1` on `…/cmd/load-order`, the gateway's results `uns.cmd-res/1` on `…/cmd-res/load-order`, and the job facts `uns.events.job/1` on `…/events/job` (orders mode only); also additive. Source of truth in code: `packages/contracts/src/uns/` (Zod schemas, topic helpers, reference dedup consumer; commands and results in `commands.ts`). The JSON Schema of every payload is generated into `docs/contracts/uns/` (`pnpm --filter @shopfloor/contracts json-schema`); a test fails when it drifts from the Zod schemas. Decisions: plan section 5, ADR-0015 (identity, sequence and dedup). Any change bumps the version here and needs a changelog entry.

## Broker

Mosquitto on `127.0.0.1:1883`, MQTT 5. Every publish and subscription uses **QoS 1**: at-least-once delivery, so consumers deduplicate (below).

Users and topic rights are in `config/mosquitto/acl`. Mosquitto denies everything not listed, and answers a denied QoS 1 publish with PUBACK reason 0x87 (not authorized). Passwords come from `.env`.

| User          | Reads                                                             | Publishes                                                                                                         |
| ------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `gw-01`       | its own `_sys/edge-gateway/gw-01/#`; `cmd` of any equipment (1.3) | `state`, `telemetry`, `events`, `alarms` and `cmd-res` (1.3) of any equipment; its own `_sys` topics. Never `cmd` |
| `mes`         | `orbis/#` (`cmd-res` included)                                    | `mes` and `cmd` of any equipment; `_sys/mes-server/#`. Never `cmd-res`                                            |
| `dev`         | `orbis/#`, `$SYS/#`                                               | nothing (manual testing)                                                                                          |
| `healthcheck` | `$SYS/#`                                                          | nothing (the broker's Compose healthcheck)                                                                        |

**Accepted risk until Phase 9:** the plain ACL file can't tie a client id to a user. Anyone with valid credentials can connect with client id `gw-01`; the broker then disconnects the real gateway, whose will says `offline` until it reconnects. Phase 9 (security) moves to Mosquitto's dynamic-security plugin, which binds client ids to users. The same holds for the gateway's command session (client id `gw-01-cmd`, 1.3): both gateway connections log in as `gw-01`, and the ACL can't tie each client id to its use.

## Topics

Equipment data:

`orbis/gebze/{area}/{workcenter}/{equipment}/{class}/{name}`

- Segments are lower-case kebab-case.
- The hierarchy is `config/plant/plant.yaml`, for example `machining/cell-m1/cnc-01` or `assembly/line-a1/lkt-01`.
- Build topics only with the helpers `stateTopic`, `telemetryTopic`, `cycleTopic`, `jobTopic`, `alarmTopic`, `alarmSnapshotTopic`, `commandTopic`, `commandResultTopic` and `equipmentTopic`, and parse them with `parseEquipmentTopic`.
- One exception to kebab-case (1.2): the name `_snapshot` (`ALARM_SNAPSHOT_NAME`) under the `alarms` class. The underscore keeps it apart from every alarm code's topic name; anywhere else it is refused.

| Class and name          | Example                            | Schema                        | Retained                       |
| ----------------------- | ---------------------------------- | ----------------------------- | ------------------------------ |
| `state/current`         | `…/cnc-01/state/current`           | `uns.state.current/1`         | yes                            |
| `telemetry/{name}`      | `…/cnc-01/telemetry/spindle-load`  | `uns.telemetry/1`             | yes (last value)               |
| `events/cycle-complete` | `…/lkt-01/events/cycle-complete`   | `uns.events.cycle-complete/1` | no                             |
| `alarms/{code}`         | `…/cnc-01/alarms/spindle-overload` | `uns.alarms/1`                | yes (last transition per code) |
| `alarms/_snapshot`      | `…/cnc-01/alarms/_snapshot`        | `uns.alarm-snapshot/1` (1.2)  | yes (latest resync)            |
| `events/job`            | `…/cnc-01/events/job`              | `uns.events.job/1` (1.3)      | no                             |
| `cmd/load-order`        | `…/cnc-01/cmd/load-order`          | `uns.cmd.load-order/1` (1.3)  | no                             |
| `cmd-res/load-order`    | `…/cnc-01/cmd-res/load-order`      | `uns.cmd-res/1` (1.3)         | no                             |
| `mes/…`                 | Phase 4 onwards                    | –                             | yes                            |

Component topics (helper `sysTopic`):

| Topic                                                                                     | Schema               | Retained                          |
| ----------------------------------------------------------------------------------------- | -------------------- | --------------------------------- |
| `orbis/gebze/_sys/{component}/{instance}/status`, e.g. `…/_sys/edge-gateway/gw-01/status` | `uns.sys.status/1`   | yes; the last will sets `offline` |
| `orbis/gebze/_sys/{component}/{instance}/incidents`                                       | `uns.sys.incident/1` | no                                |

The gateway publishes `online` on every (re)connect. Its last will, refreshed before every connect so it carries a new sequence number, is `offline`; on a clean shutdown it publishes `offline` itself. Status messages bypass the store-and-forward buffer, so an old `online` is never replayed after a newer state. Their sequence numbers are unique, but neither ordered by time nor gap-free: a will's number is reserved before the `online` that follows it, and most wills are never sent. Use the latest delivery, not the highest number, and **exclude `_sys/…/status` from gap checks**.

Alarm topic names are the alarm code in lower case (`SPINDLE-OVERLOAD` → `spindle-overload`); the payload carries the code as is.

### Telemetry names

| Name                  | Unit   | Equipment      | Source                                              |
| --------------------- | ------ | -------------- | --------------------------------------------------- |
| `spindle-load`        | %      | CNC-01, CNC-02 | OPC UA `ShopFloor.ProcessValues.SpindleLoad`        |
| `coolant-temperature` | °C     | CNC-01, CNC-02 | OPC UA `ShopFloor.ProcessValues.CoolantTemperature` |
| `leak-rate`           | Pa/min | LKT-01         | OPC UA `ShopFloor.LeakTest.LastReading`             |
| `bath-temperature`    | °C     | WSH-01         | Modbus (#74)                                        |
| `conveyor-speed`      | m/min  | WSH-01         | Modbus (#74)                                        |

In code: `UNS_TELEMETRY`. Telemetry is sampled and may be decimated (plan section 5); state, cycles and alarms may not.

## Envelope

Every payload is one JSON object with these fields, and no others except those listed per schema.

**Versioning:** the schemas are strict, so adding a field is a new version (`/2`). Publishers then send the new version only once every consumer accepts it. Consumers reject versions they don't know rather than guessing.

| Field        | Type                       | Meaning                                                                                           |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `schema`     | string                     | Name and version, e.g. `uns.alarms/1`. A consumer rejects versions it doesn't know                |
| `source`     | `{ id, protocol }`         | Equipment id (`cnc-01`) or component instance (`gw-01`); protocol `opcua`, `modbus` or `internal` |
| `scope`      | `device` or `topic`        | Which sequence space `seq` belongs to (see Identity)                                              |
| `epoch`      | integer, Unix seconds      | Start of the owner of that sequence space                                                         |
| `seq`        | integer ≥ 1                | Sequence number within (stream, epoch)                                                            |
| `sourceTime` | ISO 8601 UTC               | When the fact happened: **simulation time** from the device. All MES calculations use this        |
| `receivedAt` | ISO 8601 UTC               | Gateway wall time when it read the fact, for diagnosing delays                                    |
| `quality`    | `good`, `uncertain`, `bad` | `bad` values must not be used (for example a silent device)                                       |
| `value`      | per schema                 | The payload                                                                                       |

| Schema                        | Extra fields                                                           | `value`                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uns.state.current/1`         | `kind`: `event` or `snapshot`; snapshots may carry `deviceEpoch` (1.1) | `{ state, cause }`. `state` is one of the ten machine states; `cause` is a string or null                                                                                                                          |
| `uns.telemetry/1`             | `unit`; may carry `deviceEpoch` (1.1)                                  | number                                                                                                                                                                                                             |
| `uns.events.cycle-complete/1` | –                                                                      | `{ product, partId, serial, result (good, scrap, rework), reason (or null), measurement ({ characteristic, value, unit, upperLimit } or null) }`                                                                   |
| `uns.events.job/1` (1.3)      | –                                                                      | `{ transition (accepted, started, completed), commandId, orderId, product, quantity }`: a job fact of a CNC in orders mode (ADR-0030)                                                                              |
| `uns.alarms/1`                | –                                                                      | `{ code, transition (active, cleared), severity (1–1000) }`                                                                                                                                                        |
| `uns.alarm-snapshot/1` (1.2)  | `kind: snapshot`, scope `topic`; `deviceEpoch` and `asOfSeq` required  | `{ active: [code…] }`: the codes active at device sequence `asOfSeq` of device epoch `deviceEpoch`, sorted, empty when none; `asOfSeq` 0 means the device had no fact yet                                          |
| `uns.sys.status/1`            | –                                                                      | `{ status (online, offline), startedAt, version }`                                                                                                                                                                 |
| `uns.sys.incident/1`          | –                                                                      | `{ type, equipment (or null), lost (or null), message }`, with `type` one of `sequence-gap`, `epoch-change`, `ring-overrun`, `device-silent`, `device-recovered`, `disconnected`, `reconnected`, `buffer-overflow` |

Validate any payload with `parseUnsMessage(json)`; commands and results (1.3) have their own envelope (see Commands) and are validated with `parseUnsCommandMessage(json)`.

## Sources

### OPC UA machines (edge gateway, #76)

| OPC UA (docs/contracts/opcua-address-space.md)                                                        | UNS                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ShopFloorStateChangeEventType`                                                                       | `state/current`, `kind: event`, `seq` = the event's `Sequence`, `epoch` = `ShopFloor.Epoch`; value `{ state: ToState, cause: Cause or null }`                                                                                                                                                                                                                            |
| `CycleCompleteEventType`                                                                              | `events/cycle-complete`; an empty `Reason` becomes null; `MeasurementValue` (LKT-01) becomes `measurement` with characteristic `leak-rate`, unit `Pa/min` and the `LeakTest.UpperLimit` read at connect; NaN becomes null                                                                                                                                                |
| `ShopFloorJobEventType` (CNCs, orders mode; 1.3)                                                      | `events/job`, `uns.events.job/1`, `scope: device` in the machine's shared sequence; value `{ transition, commandId, orderId, product, quantity }`                                                                                                                                                                                                                        |
| `ShopFloorAlarmEventType`                                                                             | `alarms/{code}` with `{ code, transition, severity }`                                                                                                                                                                                                                                                                                                                    |
| `ProcessValues.SpindleLoad`, `.CoolantTemperature` (CNCs), `LeakTest.LastReading` (LKT-01)            | `telemetry/spindle-load`, `coolant-temperature`, `leak-rate`, sampled every `TELEMETRY_SAMPLING_MS` (wall, default 1 s); `sourceTime` is the value's SourceTimestamp (simulation time); `deviceEpoch` (1.1) is the `Epoch` read by the resync of the current connection, left out after a connection loss until that resync ran                                          |
| `State`, `StateCause` read after every (re)connect                                                    | `state/current`, `kind: snapshot`, `deviceEpoch` = `ShopFloor.Epoch`                                                                                                                                                                                                                                                                                                     |
| `Epoch`, `Sequence` and every `Alarms.<CODE>.Active`, in one Read call, after every (re)connect (1.2) | `alarms/_snapshot`, `uns.alarm-snapshot/1`: `deviceEpoch` = `Epoch`, `asOfSeq` = `Sequence`, `active` = the codes whose `Active` is true, `sourceTime` = the `Sequence` value's source timestamp (the time of fact `asOfSeq`). The codes are the machine's slice of the plant's alarm vocabulary. A value that isn't Good publishes nothing; the next resync tries again |

The gateway subscribes first, then reads `Epoch` and `Sequence`; events wait until their epoch is known, at start-up and after every connection loss. History is everything before the first event the subscription delivered. After a reconnect it waits a grace period (2 s) for the repaired subscription to republish what it kept, then reports every number that never arrived as one `sequence-gap` incident with `lost`. A reported number counts as handled: it is never reported twice, and a copy arriving later is dropped, so every fact is either published once or counted lost once. Known limit: after a simulator restart (new epoch) the old run's last facts that never arrived can't be counted, because the old run's final number is unknown; its open holes are reported. A changed `Epoch` (the simulator restarted) gives an `epoch-change` incident. Connection loss and recovery give `disconnected` and `reconnected` incidents.

### WSH-01 on Modbus (edge gateway, #77)

The poller reads the register map (docs/contracts/modbus-register-map.md) every `MODBUS_POLL_MS` (wall, default 250 ms).

| Registers                                                                                   | UNS                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ring entry, type state                                                                      | `state/current`, `kind: event`, `seq` = the entry's sequence, `epoch` = register `epoch`                                                                                                  |
| Ring entry, type cycle                                                                      | `events/cycle-complete`; `serial` is empty (a legacy washer reads none), `reason` and `measurement` are null                                                                              |
| Ring entry, type alarm                                                                      | `alarms/{code}`, severity 700 (the washer's alarms are its failure codes)                                                                                                                 |
| `bathTemperature`, `conveyorSpeed`                                                          | `telemetry/bath-temperature`, `telemetry/conveyor-speed`, scaled by the configured resolutions; `sourceTime` is register `simTime`, `deviceEpoch` (1.1) register `epoch` of the same read |
| `state` on first contact, after a silence and after an epoch change                         | `state/current`, `kind: snapshot`, `deviceEpoch` = register `epoch` (cause null: the map carries no cause for the current state)                                                          |
| `activeAlarms` and `eventCounter` of the same read, at the same times (1.2, register map 2) | `alarms/_snapshot`, `uns.alarm-snapshot/1`: `deviceEpoch` = register `epoch`, `asOfSeq` = `eventCounter`, `active` from the bits, `sourceTime` = register `simTime`                       |

- Each poll walks the ring from the last entry handled to the counter, in requests of at most 12 entries, split at the ring end. An entry whose own number isn't the expected one was overwritten: a `ring-overrun` incident. So is a counter that moved by more than 64 since the last poll. One incident per poll carries the total; an entry that can't be decoded is a `sequence-gap` incident instead.
- On first contact the facts already in the ring are history. The poller keeps a cursor (epoch and last sequence) and continues from it while the epoch is unchanged. The cursor is saved with the outbox (#78), so it survives gateway restarts.
- After three failed polls (timeout, refused connection) the device counts as silent: a `device-silent` incident, and the next successful poll gives `device-recovered` and a snapshot. The ring keeps what happened meanwhile, so a short silence loses nothing.
- Known limit, as for OPC UA: after a device restart (new epoch), the old run's facts after the last poll are lost and not counted.

### Store-and-forward (edge gateway, #78)

Every UNS message passes through the gateway's outbox (ADR-0014), except the gateway's own `_sys/…/status`:

1. Each message is committed to a SQLite file (`BUFFER_PATH`), in one durable transaction per tick (20 ms or 100 messages).
2. While the broker is reachable, stored messages are sent in insertion order, at most 100 at a time unacknowledged, and deleted after their PUBACK.
3. During a broker outage they stay on disk; after the outage, or after a gateway restart, the rest is sent in the same order.

- A crash between PUBACK and delete sends one message twice, which the consumer's dedup removes.
- A message the broker refuses for good (reason codes 0x87, 0x90, 0x95 and 0x99, for example the ACL) is dropped and logged, so it can't block the rest. Other failures pause sending for a second and retry.
- The gateway's responsibility ends at the PUBACK. A broker killed outright loses what it had acknowledged but not yet passed on to subscribers; that is the broker's durability (Mosquitto persistence), not the gateway's.
- The outbox holds at most `BUFFER_MAX_MESSAGES` (200,000, about 11 hours of the whole plant at 60×). Beyond that the oldest messages not yet handed to the broker are dropped, with a `buffer-overflow` incident.
- The Modbus cursor is saved in the same transaction as the messages it produced, so a gateway restart neither repeats nor skips washer facts.

## Commands (1.3, #173, ADR-0029)

The MES dispatches a job to a CNC with `cmd/load-order`; the gateway calls OPC UA `LoadOrder` (docs/contracts/opcua-address-space.md) and answers every delivery on `cmd-res/load-order`. Delivery is at least once on every hop; the device's dedup by command id (ADR-0030) makes execution exactly-once, and the device's job facts (`events/job`) prove it.

**Command envelope** (`uns.cmd.load-order/1`; a command is not a fact, so no `sourceTime`, `receivedAt` or `quality`):

| Field       | Meaning                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`    | `uns.cmd.load-order/1`                                                                                                                                                                              |
| `scope`     | `topic`; `epoch` (the issuer's start, Unix seconds) and `seq` (per topic) identify the message                                                                                                      |
| `source`    | the issuer, `{ id: mes-server, protocol: internal }`                                                                                                                                                |
| `issuedAt`  | wall time of this publish (a resend has its own)                                                                                                                                                    |
| `expiresAt` | wall time; passed to the device as `ExpiresAt`: a command not accepted by then is refused                                                                                                           |
| `value`     | `{ commandId, orderId, operation: OP10, product, quantity (1–100,000 blanks), notBefore (plant time), deviceEpoch }`; `commandId` is `{orderId}~OP10~{n}` (`loadOrderCommandId`), reused by resends |

**Result envelope** (`uns.cmd-res/1`): `schema`, `scope: topic`, the gateway's `epoch` and `seq` per topic, `source` the equipment (`protocol: opcua`), `respondedAt` (gateway wall time) and a `value` with `commandId`, `orderId`, `deviceEpoch`, `expiresAt` (of the delivery it answers) and `statusCode` (the OPC UA status that gave the answer, or null), plus by `result`:

| `result`    | Extra fields                            | Meaning                                                                                                                                                                                                    | Final for the MES?                                 |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `accepted`  | `position`, `acceptedSeq`, `acceptedAt` | the device accepted the job now; `acceptedSeq`/`acceptedAt` are the device sequence and plant time of its `accepted` fact                                                                                  | yes: the job exists                                |
| `duplicate` | `position`, `acceptedSeq`, `acceptedAt` | the device had already accepted this command id (the original's acceptance)                                                                                                                                | yes: the job exists                                |
| `rejected`  | `code`                                  | refused: `invalid-product`, `invalid-quantity`, `invalid-argument`, `command-conflict`, `epoch-mismatch`, `wrong-mode`, `queue-full`, or `unsupported-equipment` (no `LoadOrder` there; the gateway's own) | yes: no job                                        |
| `expired`   | `seqAfterExpiry` (or null)              | the device answered `expired` on a dedup miss: never accepted. Never the gateway's own guess                                                                                                               | yes, for that `expiresAt`; a resend may follow     |
| `unknown`   | `seqAfterExpiry` (or null), `reason`    | the gateway couldn't learn the outcome even with the settle call; `seqAfterExpiry` is `ShopFloor.Sequence` read after `expiresAt` + 1 s                                                                    | no: settled again; the MES decides `failed` itself |

The gateway (ADR-0029):

- **Session:** a second MQTT connection, client id `gw-01-cmd` (user `gw-01`), `clean: false` with session expiry `GATEWAY_CMD_SESSION_EXPIRY_S` (1 h), subscriptions `orbis/gebze/{area}/+/+/cmd/#` per area. A delivery is committed to the gateway's SQLite file before its PUBACK; one it can't record is never acknowledged, so the broker delivers it again.
- **Calls:** one command at a time per equipment; only on a ready OPC UA session; each request with the deadline `GATEWAY_CALL_DEADLINE_MS` (5 s); before every retry `ShopFloor.Epoch` is read again, and a changed epoch is answered `rejected` (`epoch-mismatch`, `statusCode` null) without calling; retries until `expiresAt`. A command that arrives expired is still called once.
- **Settling:** without a definitive answer by `expiresAt`, after `expiresAt` + 1 s the gateway reads `ShopFloor.Sequence` (`seqAfterExpiry`) and calls once more: `Duplicate` → `duplicate`, the device's `expired` → `expired`, `epoch-mismatch` → `rejected`, anything else → `unknown`, published and settled again every 5 s while the device epoch lasts. A finished simulator run answers every call with the transient `BadWaitingForInitialData`, so a command whose outcome is unknown when its run finishes stays `unknown` until a new epoch is seen.
- **Result table:** definitive answers only, `accepted`, `duplicate` and `rejected` by command id, `expired` by command id and `expiresAt`; a redelivery or a resend of the same job is answered from it without calling. `unknown` is never stored.
- **Delivery:** results go through the store-and-forward outbox like every other message, so a broker outage delays them and loses none. There may be several results per command id (redeliveries, resends, `unknown` then the settled answer): consumers treat them idempotently by command id.

Until #174 the MES ingest refuses `events/job` and `cmd-res` (`unexpected-topic`): an orders-mode run seen by the MES has sequence gaps where its job facts are. Schedule mode, the default, has no job facts.

## Identity, duplicates and gaps (ADR-0015)

- **Device facts** (state changes, cycles, alarm transitions, and job transitions from 1.3) have `scope: device`. Their `seq` is the device's own sequence: OPC UA `Sequence`, or the WSH-01 event-buffer sequence. It is shared across that device's `state`, `events` and `alarms` topics, so one stream per equipment orders all its facts.
- **Gateway streams** (telemetry, snapshots, `_sys`, command results) have `scope: topic`, with a gateway counter per topic. Commands have `scope: topic` with the issuer's (the MES's) counter per topic.
- **Epoch:** numbering restarts at 1 whenever the owner of a sequence restarts. The `epoch` (the owner's start time) separates the runs.
- **Snapshots:** after every (re)connect, the gateway publishes the current state read from the device's variables as `uns.state.current/1` with `kind: snapshot` and `scope: topic`. They restore the current state. They are not facts, and they never take part in device dedup or gap checks. Their `epoch` is the gateway's (the counter's owner); `deviceEpoch` (1.1) names the device run the state was read in, so a consumer can tell a snapshot of an earlier run.
- **Alarm snapshots (1.2):** with each state snapshot the gateway publishes `uns.alarm-snapshot/1`, retained, one topic per equipment. Its `asOfSeq` and active codes come from one atomic read (OPC UA: one Read call of `Epoch`, `Sequence` and every `Alarms.<CODE>.Active`, ADR-0010; Modbus: one read of the snapshot block, registers 0–17), so every fact up to `asOfSeq` is reflected in it and none after. It is not a fact and never takes part in the device stream's dedup or gap checks: `asOfSeq` only orders it against the device's facts. A consumer can tell from it that a clear it never received happened (the code is inactive at a higher sequence than the raise).
- **The consumer rule** (reference implementation: `Deduplicator`):
  - stream = `device:{equipment}` for device facts, `topic:{topic}` otherwise;
  - a message whose (epoch, `seq`) was already seen, or with an older epoch, is a **duplicate** and is dropped;
  - a newer epoch starts the stream over. The verdict hands back the old epoch's open gaps (`closedGaps`), which can no longer be filled;
  - out-of-order deliveries are accepted, including numbers below the first one seen, as with a reordered start;
  - **gaps** are holes _between_ numbers seen (`gaps()`). Numbers before the first one seen are history the consumer joined after, not gaps. A gap recorded as an incident is written off with `acknowledge(gap)`. Memory grows with the number of open gaps, not with the number of messages;
  - messages the broker delivers as **retained** on subscribe are passed with `{ retained: true }`. They restore current state, and are dropped if already seen, but they neither start the stream nor create gaps: retained topics hold the latest facts of different kinds, so their numbers are far apart.
- The gateway reports the gaps _it_ sees (from a device) as `uns.sys.incident/1` messages. The MES counts both kinds.

## Consumer: MES ingest (#95)

The MES `ingest` module (`apps/mes-server/src/modules/ingest/`, ADR-0017) is the UNS's durable consumer.

**Session:** user `mes`, client id `mes-server`, MQTT 5, `clean: false` with a session expiry interval (`MQTT_SESSION_EXPIRY_S`, default 7 days) and receive maximum 100. The broker keeps the session and queues QoS 1 messages while the MES is down, up to `max_queued_messages` 100,000: about one hour of the plant at 60× (about 25 messages/s); beyond that, messages are lost and show up as sequence gaps. The MES stores about 1,000 messages/s (measured in the #95 review), so a full queue drains in about two minutes. Known limit: the queue survives a broker crash only up to its last autosave.

**Subscriptions** (QoS 1, renewed and checked on every connect; readiness requires all granted; the ACL's `topic read orbis/#` for `mes` covers them):

- `orbis/gebze/+/+/+/state/+`, `…/telemetry/+`, `…/events/+`, `…/alarms/+`;
- `orbis/gebze/_sys/edge-gateway/+/status` and `…/incidents`.

**Acknowledgement:** a message is acknowledged only after its transaction committed, one at a time in arrival order. A crash before the commit means the broker delivers the message again; a crash between commit and acknowledgement means a copy, which dedup removes. When a transaction fails (ADR-0017):

- **data or integrity** (SQLSTATE classes 22, 23, 54) only: the message is recorded in `rejected_message` as `unstorable` with the error and acknowledged, so one message can't block the stream.
- **anything else**, including unknown and non-SQL errors (connection, lock timeout, a deploy's missing table, an internal error): retried a few times with backoff. If it persists, the MES drops the session without acknowledging, waits until the database answers, reloads its cursors and reconnects; the broker queues meanwhile. (While a message waits, MQTT.js handles no other packet, not even the keepalive answer, so holding the session would only make it time out and reconnect again and again.)

**What happens to each delivery** (tables in the `ingest` schema, `db/migrations/0003_ingest_raw.sql`):

| Delivery                                                                       | Result                                                                                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Invalid JSON, a schema `parseUnsMessage` rejects, a topic/payload mismatch     | `rejected_message` with reason `invalid-json`, `invalid-payload`, `topic-mismatch` or `unexpected-topic` and the detail |
| A time outside the years 1970–2199, a NUL character, a lone surrogate          | `rejected_message`, reason `invalid-payload` (the database couldn't store it)                                           |
| A valid message the database still refuses                                     | `rejected_message`, reason `unstorable`                                                                                 |
| State event, cycle, alarm (`scope: device`)                                    | `equipment_event` (hypertable; unique on equipment, epoch, seq, sourceTime)                                             |
| Telemetry                                                                      | `telemetry_sample` (hypertable; unique on topic, epoch, seq, sourceTime)                                                |
| Gateway incident                                                               | `data_quality_incident`, origin `gateway`                                                                               |
| Gateway status                                                                 | `component_status`: the latest delivery wins                                                                            |
| Snapshot (`kind: snapshot`), or `state/current` delivered with the retain flag | `state_anchor`: not a fact                                                                                              |
| `alarms/{code}` delivered with the retain flag (#141)                          | `alarm_anchor`: the device's last fact for the code, not a fact here; the highest `seq` per (equipment, epoch, code)    |
| `alarms/_snapshot` (`uns.alarm-snapshot/1`, #141), retained or not             | `alarm_snapshot`: the highest `asOfSeq` per (equipment, `deviceEpoch`)                                                  |
| Other retained deliveries (telemetry, cycles)                                  | not stored: current values, not facts (counted in metrics)                                                              |
| A number already seen in the stream's current epoch                            | dropped as a duplicate (counted)                                                                                        |
| An epoch older than the stream's current one                                   | `rejected_message`, reason `stale-epoch`                                                                                |

Topic/payload checks: the schema must be the one of the topic class, an alarm's `code` must match its topic name, and `source.id` must be the topic's equipment (or the `_sys` instance).

**Dedup and gaps** follow the consumer rule above, made durable: `source_cursor` holds each stream's current epoch, the ranges seen and the gaps already reported, so a restart neither forgets duplicates nor invents gaps.

- A hole that stays open for `INGEST_GAP_GRACE_MS` (wall time, default 30 s) becomes a `sequence-gap` incident (origin `mes`, with the missing range and `lost`). A late message still fills it: `lost` goes down, and the incident is closed as `filled` once nothing is missing.
- A newer epoch closes the old epoch's open gaps as `epoch-ended`, and records any hole not yet reported. Every epoch numbers from 1, so in a stream the MES already knows, numbers below the new epoch's first one are a hole too (facts lost at a restart). A stream seen for the first time starts at its first number: what came before is history.
- `_sys` streams are deduplicated, never checked for gaps.

**Anchors:** retained deliveries and snapshots never enter dedup or gap checks. A retained state event anchors its own device epoch, a snapshot its `deviceEpoch`. A snapshot without it (from a gateway older than 1.1) waits for the device epoch of the next device fact of its equipment; any newer snapshot of that equipment supersedes it first, so only the latest waiting one can be attributed. The first anchor to arrive per (equipment, device epoch) is the starting state, used by the equipment module when it knows no state for that epoch yet.

**Alarm anchors and snapshots (#141, ADR-0017 amendment):** neither enters dedup or gap checks, and neither creates a cursor. A snapshot with a higher `asOfSeq` than an anchor's `seq` beats the anchor; an anchor with a higher `seq` beats the snapshot (`Ingest.alarmBaseline`). An anchor or snapshot of a device epoch older than the newest one ingest knows for its equipment (any fact, state anchor, alarm anchor or snapshot) is stored stale and never used; when a newer epoch arrives, the older ones become stale. Notices: `alarm` (each stored alarm fact), `alarm-anchor`, `alarm-snapshot` and `alarm-stale`.

## Consumer: MES equipment intervals (#96)

The MES `equipment` module (`apps/mes-server/src/modules/equipment/`, ADR-0018) turns the stored state facts into `equipment.equipment_state_interval` (`db/migrations/0004_equipment_state_interval.sql`). What it takes from the UNS:

- **Facts:** `state/current` events (`scope: device`) of one equipment and one device `epoch`, ordered by `seq`; each state lasts from its `sourceTime` to the next fact's. Facts in the same millisecond are ordered by `seq`; a zero-length interval is dropped. Cycles and alarms are not states, but their `sourceTime` moves the watermark.
- **Anchor:** the first anchor of (equipment, device epoch) opens the first interval when it is earlier than the first fact.
- **Epochs:** intervals never cross an epoch; a newer device epoch of an equipment (fact or anchor) closes its old epoch's open interval at the old epoch's watermark. All simulated devices share the simulator's epoch.
- **Plant watermark** of a device epoch: the latest `sourceTime` of any device fact in it, and of telemetry whose `deviceEpoch` names it (WSH-01's telemetry carries the simulation clock). Telemetry without `deviceEpoch` never moves a watermark, and nothing moves an epoch an equipment has left: its last interval ends where the newer epoch closed it. The open interval of every equipment in that epoch is stored up to the watermark, cut at hours and shifts, flagged `provisional`.
- **Buckets:** every stored piece lies inside one UTC hour (`hour`) and one shift bucket (`shift_key`, `<shiftDate>/<shiftId>` or `no-shift`, from `@shopfloor/shift-calendar`, as in the simulator's ground truth).
- **Reordering and duplicates:** a late fact recomputes only the pieces between its neighbours by `seq`; duplicates never reach the module (ingest dedup), and a replay changes nothing.
