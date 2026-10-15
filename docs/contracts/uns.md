# Contract: Unified Namespace (UNS)

Version 1 (Phase 3). Source of truth in code: `packages/contracts/src/uns/` (Zod schemas, topic helpers, reference dedup consumer). The JSON Schema of every payload is generated into `docs/contracts/uns/` (`pnpm --filter @shopfloor/contracts json-schema`); a test fails when it drifts from the Zod schemas. Decisions: plan section 5, ADR-0015 (identity, sequence and dedup). Any change bumps the version here and needs a changelog entry.

## Broker

Mosquitto on `127.0.0.1:1883`, MQTT 5. Every publish and subscription uses **QoS 1**: at-least-once delivery, so consumers deduplicate (below).

Users and topic rights are in `config/mosquitto/acl`. Mosquitto denies everything not listed, and answers a denied QoS 1 publish with PUBACK reason 0x87 (not authorized). Passwords come from `.env`.

| User          | Reads                               | Publishes                                                                                                                      |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `gw-01`       | its own `_sys/edge-gateway/gw-01/#` | `state`, `telemetry`, `events`, `alarms` of any equipment; its own `_sys` topics. `cmd` and `cmd-res` rights arrive in Phase 7 |
| `mes`         | `orbis/#`                           | `mes` and `cmd` of any equipment; `_sys/mes-server/#`                                                                          |
| `dev`         | `orbis/#`, `$SYS/#`                 | nothing (manual testing)                                                                                                       |
| `healthcheck` | `$SYS/#`                            | nothing (the broker's Compose healthcheck)                                                                                     |

**Accepted risk until Phase 9:** the plain ACL file can't tie a client id to a user. Anyone with valid credentials can connect with client id `gw-01`; the broker then disconnects the real gateway, whose will says `offline` until it reconnects. Phase 9 (security) moves to Mosquitto's dynamic-security plugin, which binds client ids to users.

## Topics

Equipment data:

`orbis/gebze/{area}/{workcenter}/{equipment}/{class}/{name}`

- Segments are lower-case kebab-case.
- The hierarchy is `config/plant/plant.yaml`, for example `machining/cell-m1/cnc-01` or `assembly/line-a1/lkt-01`.
- Build topics only with the helpers `stateTopic`, `telemetryTopic`, `cycleTopic`, `alarmTopic` and `equipmentTopic`, and parse them with `parseEquipmentTopic`.

| Class and name          | Example                            | Schema                        | Retained                       |
| ----------------------- | ---------------------------------- | ----------------------------- | ------------------------------ |
| `state/current`         | `…/cnc-01/state/current`           | `uns.state.current/1`         | yes                            |
| `telemetry/{name}`      | `…/cnc-01/telemetry/spindle-load`  | `uns.telemetry/1`             | yes (last value)               |
| `events/cycle-complete` | `…/lkt-01/events/cycle-complete`   | `uns.events.cycle-complete/1` | no                             |
| `alarms/{code}`         | `…/cnc-01/alarms/spindle-overload` | `uns.alarms/1`                | yes (last transition per code) |
| `cmd/…`, `cmd-res/…`    | Phase 7                            | –                             | no                             |
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

| Schema                        | Extra fields                  | `value`                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uns.state.current/1`         | `kind`: `event` or `snapshot` | `{ state, cause }`. `state` is one of the ten machine states; `cause` is a string or null                                                                                                                          |
| `uns.telemetry/1`             | `unit`                        | number                                                                                                                                                                                                             |
| `uns.events.cycle-complete/1` | –                             | `{ product, partId, serial, result (good, scrap, rework), reason (or null), measurement ({ characteristic, value, unit, upperLimit } or null) }`                                                                   |
| `uns.alarms/1`                | –                             | `{ code, transition (active, cleared), severity (1–1000) }`                                                                                                                                                        |
| `uns.sys.status/1`            | –                             | `{ status (online, offline), startedAt, version }`                                                                                                                                                                 |
| `uns.sys.incident/1`          | –                             | `{ type, equipment (or null), lost (or null), message }`, with `type` one of `sequence-gap`, `epoch-change`, `ring-overrun`, `device-silent`, `device-recovered`, `disconnected`, `reconnected`, `buffer-overflow` |

Validate any payload with `parseUnsMessage(json)`.

## Sources

### OPC UA machines (edge gateway, #76)

| OPC UA (docs/contracts/opcua-address-space.md)                                             | UNS                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ShopFloorStateChangeEventType`                                                            | `state/current`, `kind: event`, `seq` = the event's `Sequence`, `epoch` = `ShopFloor.Epoch`; value `{ state: ToState, cause: Cause or null }`                                                                             |
| `CycleCompleteEventType`                                                                   | `events/cycle-complete`; an empty `Reason` becomes null; `MeasurementValue` (LKT-01) becomes `measurement` with characteristic `leak-rate`, unit `Pa/min` and the `LeakTest.UpperLimit` read at connect; NaN becomes null |
| `ShopFloorAlarmEventType`                                                                  | `alarms/{code}` with `{ code, transition, severity }`                                                                                                                                                                     |
| `ProcessValues.SpindleLoad`, `.CoolantTemperature` (CNCs), `LeakTest.LastReading` (LKT-01) | `telemetry/spindle-load`, `coolant-temperature`, `leak-rate`, sampled every `TELEMETRY_SAMPLING_MS` (wall, default 1 s); `sourceTime` is the value's SourceTimestamp (simulation time)                                    |
| `State`, `StateCause` read after every (re)connect                                         | `state/current`, `kind: snapshot`                                                                                                                                                                                         |

The gateway subscribes first, then reads `Epoch` and `Sequence`; events wait until their epoch is known, at start-up and after every connection loss. History is everything before the first event the subscription delivered. After a reconnect it waits a grace period (2 s) for the repaired subscription to republish what it kept, then reports every number that never arrived as one `sequence-gap` incident with `lost`. A reported number counts as handled: it is never reported twice, and a copy arriving later is dropped, so every fact is either published once or counted lost once. Known limit: after a simulator restart (new epoch) the old run's last facts that never arrived can't be counted, because the old run's final number is unknown; its open holes are reported. A changed `Epoch` (the simulator restarted) gives an `epoch-change` incident. Connection loss and recovery give `disconnected` and `reconnected` incidents.

### WSH-01 on Modbus (edge gateway, #77)

The poller reads the register map (docs/contracts/modbus-register-map.md) every `MODBUS_POLL_MS` (wall, default 250 ms).

| Registers                                                           | UNS                                                                                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Ring entry, type state                                              | `state/current`, `kind: event`, `seq` = the entry's sequence, `epoch` = register `epoch`                                           |
| Ring entry, type cycle                                              | `events/cycle-complete`; `serial` is empty (a legacy washer reads none), `reason` and `measurement` are null                       |
| Ring entry, type alarm                                              | `alarms/{code}`, severity 700 (the washer's alarms are its failure codes)                                                          |
| `bathTemperature`, `conveyorSpeed`                                  | `telemetry/bath-temperature`, `telemetry/conveyor-speed`, scaled by the configured resolutions; `sourceTime` is register `simTime` |
| `state` on first contact, after a silence and after an epoch change | `state/current`, `kind: snapshot` (cause null: the map carries no cause for the current state)                                     |

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

## Identity, duplicates and gaps (ADR-0015)

- **Device facts** (state changes, cycles, alarm transitions) have `scope: device`. Their `seq` is the device's own sequence: OPC UA `Sequence`, or the WSH-01 event-buffer sequence. It is shared across that device's `state`, `events` and `alarms` topics, so one stream per equipment orders all its facts.
- **Gateway streams** (telemetry, snapshots, `_sys`) have `scope: topic`, with a gateway counter per topic.
- **Epoch:** numbering restarts at 1 whenever the owner of a sequence restarts. The `epoch` (the owner's start time) separates the runs.
- **Snapshots:** after every (re)connect, the gateway publishes the current state read from the device's variables as `uns.state.current/1` with `kind: snapshot` and `scope: topic`. They restore the current state. They are not facts, and they never take part in device dedup or gap checks.
- **The consumer rule** (reference implementation: `Deduplicator`):
  - stream = `device:{equipment}` for device facts, `topic:{topic}` otherwise;
  - a message whose (epoch, `seq`) was already seen, or with an older epoch, is a **duplicate** and is dropped;
  - a newer epoch starts the stream over. The verdict hands back the old epoch's open gaps (`closedGaps`), which can no longer be filled;
  - out-of-order deliveries are accepted, including numbers below the first one seen, as with a reordered start;
  - **gaps** are holes _between_ numbers seen (`gaps()`). Numbers before the first one seen are history the consumer joined after, not gaps. A gap recorded as an incident is written off with `acknowledge(gap)`. Memory grows with the number of open gaps, not with the number of messages;
  - messages the broker delivers as **retained** on subscribe are passed with `{ retained: true }`. They restore current state, and are dropped if already seen, but they neither start the stream nor create gaps: retained topics hold the latest facts of different kinds, so their numbers are far apart.
- The gateway reports the gaps _it_ sees (from a device) as `uns.sys.incident/1` messages. The MES counts both kinds.
