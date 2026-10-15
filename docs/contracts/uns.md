# Contract: Unified Namespace (UNS)

Version 1 (Phase 3). Source of truth in code: `packages/contracts/src/uns/` (Zod schemas, topic helpers, reference dedup consumer). The JSON Schema of every payload is generated into `docs/contracts/uns/` (`pnpm --filter @shopfloor/contracts json-schema`); a test fails when it drifts from the Zod schemas. Decisions: plan section 5, ADR-0015 (identity, sequence and dedup). Any change bumps the version here and needs a changelog entry.

## Broker

Mosquitto on `127.0.0.1:1883`, MQTT 5. Every publish and subscription uses **QoS 1**: at-least-once delivery, so consumers deduplicate (below). Users and topic rights are in the broker's ACL file (#75).

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
