# MES WebSocket push

`mes-server` pushes equipment states, telemetry, OEE and downtime records to subscribed screens (#97, #120, ADR-0019). OpenAPI can't describe a WebSocket, so this page does; the JSON Schema of every message is generated from the zod schemas (`packages/contracts/src/mes-api.ts`, shared with `web`, ADR-0020) into [`mes-realtime.schema.json`](mes-realtime.schema.json) (`pnpm --filter @shopfloor/mes-server openapi`), and a test fails when it drifts. The REST API is in [`mes.openapi.json`](mes.openapi.json).

## Connection

- URL: `ws://<host>:4700/api/v1/ws` (the MES binds to `127.0.0.1` by default; in Compose the web container proxies it as `ws://localhost:8080/api/v1/ws`, #99). Read-only, no authentication until Phase 7 (`identity`).
- Every message is one JSON text frame. A client message may be at most 4 KiB.
- The server pings every 15 s; a client that misses a pong is disconnected (browsers answer pings on their own).
- At most 64 clients; one more is closed with code 1013 (try again later).
- An upgrade with an `Origin` header is accepted only from the MES's own host or an origin in `HTTP_ALLOWED_ORIGINS`, and the `Host` header must be in `HTTP_ALLOWED_HOSTS` (DNS rebinding); otherwise the answer is 403 (ADR-0019). Clients that send no `Origin` (not a browser page) are accepted.
- Client messages are limited to 10 per second on average, in bursts of up to 20; above that, `rate-limited` errors.

## Client messages

| Message                                                                              | Meaning                                                                      |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `{ "type": "subscribe", "topic": "states" }`                                         | Current state of every equipment, then each change                           |
| `{ "type": "subscribe", "topic": "telemetry:wsh-01" }`                               | Every metric of one equipment: latest values, then each                      |
| `{ "type": "subscribe", "topic": "telemetry:wsh-01", "metric": "bath-temperature" }` | One metric (repeat for more)                                                 |
| `{ "type": "unsubscribe", "topic": "telemetry:wsh-01" }`                             | Stops the topic (with `metric`: only that metric)                            |
| `{ "type": "subscribe", "topic": "oee:cell-m1" }`                                    | OEE of an equipment or work center: current hour and shift, then each change |
| `{ "type": "subscribe", "topic": "downtime" }`                                       | Downtime records as they are created, closed or recoded                      |

`metric` applies to telemetry topics only. A client may hold up to 16 OEE topics (`too-many-subscriptions`) and up to 64 telemetry subscriptions, counted per metric (a whole equipment counts one), and read up to 4 snapshots at a time (`busy`). Subscribing again sends a fresh snapshot. A client subscribed to every metric of an equipment can't unsubscribe one of them: unsubscribe the topic and subscribe the metrics wanted.

## Server messages

| `type`                           | Fields                                                                                                                                      | When                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `subscribed`, `unsubscribed`     | `topic`, `metric` (or null)                                                                                                                 | Answer to a request                                                    |
| `snapshot` (topic `states`)      | `clock` (`epoch`, `watermark`, or null), `states`: `[{ equipment, current }]`                                                               | Right after `subscribed`: every equipment that has reported            |
| `snapshot` (topic `telemetry:…`) | `samples`: `[{ equipment, metric, unit, t, value }]`                                                                                        | Right after `subscribed`: the latest stored sample per metric          |
| `snapshot` (topic `oee:…`)       | `hour`, `shift`: OEE buckets (as in `GET /api/v1/oee`), each null without data                                                              | Right after `subscribed`: the hour and shift the plant clock is in     |
| `state`                          | `equipment`, `current` (as in `GET /api/v1/equipment/{id}`)                                                                                 | The equipment's state, cause, start or epoch changed                   |
| `oee`                            | `topic`, `hour`, `shift` (as in the snapshot)                                                                                               | Inputs of a member machine changed: at most once a second per topic    |
| `downtime`                       | `event` (`created`, `closed`, `recoded`, `updated`, `removed`), `record` (as in `GET /api/v1/downtime`)                                     | A record changed (within about 250 ms of its write)                    |
| `telemetry`                      | `equipment`, `metric`, `unit`, `t`, `value`                                                                                                 | A sample was stored                                                    |
| `clock`                          | `epoch`, `watermark`                                                                                                                        | The plant clock moved (at most once a second, to `states` subscribers) |
| `error`                          | `code` (`invalid-message`, `unknown-equipment`, `too-many-subscriptions`, `unknown-topic`, `busy`, `rate-limited`, `unavailable`), `detail` | A request was refused; the connection stays open                       |

`current` is `{ epoch, state, cause, since, seq, provisionalUntil, ageMs }`: `since` is when the state began (simulation time), `ageMs` the time in it up to the epoch's watermark. All times are ISO 8601 UTC with milliseconds, simulation time.

### OEE and downtime topics (#120)

- `oee:<id>` names an equipment or a work center (`cell-m1`, `line-a1`); another id gets `unknown-equipment`. The epoch is the plant clock's, for all machines of a work center alike. The buckets are those the plant clock (the newest epoch's watermark) is in, read just before it: at 07:00:00.000 the current hour is 06:00. Each is the full bucket of `GET /api/v1/oee` (inputs, exact fractions, losses, `final`, `provisionalMs`, `revision`, `incidents`), so a client replaces what it holds.
- The topic is computed off ingest's path: a change to a member's pieces or cycles marks it dirty, and a timer computes dirty topics at most once a second (`oee` delta only when the result differs). The snapshot of a new subscriber comes from the next computation, never from a stale one; a pending delta of that topic is dropped for it.
- `downtime` has no snapshot (read `GET /api/v1/downtime` first). Every record change follows a change of its pieces or of its operator codings (#121); the MES reads the records of the changed hours about 250 ms later and compares them with those it knows. A record that is created and closed between two reads arrives once, as `created` with its end. Deltas are keyed per record, so a slow client may get only the latest event of a record: treat every `downtime` message as an upsert by `record.id` (`removed`: delete).
- `recoded` (#121): the record's reasons changed: its auto reason (new rules at start-up), or its codings (a `PUT /api/v1/downtime/{id}/coding`, or a clip after a re-cut). The record carries `reason`, `segments`, `codings`, `uncoded` and the coding set's `version`; that version also moves with writes to other records of the same machine and epoch, which push no event, so a client reads it again before writing or retries on 409. No OEE topic changes with a coding: reasons never change OEE (ADR-0021).
- The WebSocket carries no writes: its client messages are subscriptions only (ADR-0023).

Telemetry deltas of an equipment that arrive while its snapshot is being read are sent after it (state deltas are not held); a snapshot is not sent if the client unsubscribed meanwhile; a delta may repeat a value the snapshot already holds, so clients keep the newest by time.

## Delivery and slow clients

- Deltas leave the MES within milliseconds of the commit (the test pushes the 60× rate, about 25 messages/s, and checks the 2 s budget of exit criterion 3; measured about 30 ms at most locally).
- They are queued per client by key: one state per equipment, one sample per metric, one clock, one OEE pair per topic, one event per downtime record. While a client's socket buffers more than 256 KiB, its queue waits and a newer delta replaces the older one of the same key, so a slow client skips intermediate values and catches up with the latest. Above 4 MiB it is disconnected.
- At 60× even a fast client may see a short stop only as two quick deltas; history comes from REST (`/intervals`, `/telemetry`).
- Pushing never delays ingest's acknowledgements: the listeners only queue, and sending happens on a later turn of the event loop.
- Metrics: `mes_ws_clients`, `mes_push_messages_total{type}`, `mes_push_coalesced_total`, `mes_ws_dropped_total{reason}`.
