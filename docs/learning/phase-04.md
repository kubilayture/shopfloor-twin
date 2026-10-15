# Phase 04 – MES foundation: historian and equipment states: learning notes

Phase 4 built the first part of the MES: it stores every UNS message, turns state changes into state intervals, serves them over REST and WebSocket, and shows them in a browser. These notes explain the ideas and give a reading order, questions _with answers_, and an exercise. They are reference material; the learning step is optional, as in earlier phases.

## 1. Concepts

### TimescaleDB hypertables

A hypertable looks like one PostgreSQL table but is stored as many child tables (**chunks**), each holding one range of a time column. Old chunks can be compressed or dropped as a whole, and a query for a time range only touches the chunks it needs. The MES partitions its fact tables by simulation time in 7-day chunks (`docs/data-model.md`, "Hypertables").

The catch: a primary key or unique constraint is enforced **per chunk**, so TimescaleDB requires it to include the partitioning column. Otherwise two rows with the same key in different chunks could never be detected. That is why `ingest.equipment_event` is unique on (equipment, epoch, seq, **source_time**). A duplicate message carries the same `sourceTime`, so the key still catches it.

### Idempotent ingest and acknowledgement after commit

QoS 1 delivers a message at least once. The MES stores each message with `INSERT … ON CONFLICT DO NOTHING`, so a second copy changes nothing: the operation is **idempotent**. It acknowledges the message (the PUBACK) only after the transaction has committed. A crash before the commit means the broker redelivers; a crash after the commit but before the PUBACK means a duplicate, which the unique key absorbs. Either way nothing is lost and nothing doubles (ADR-0017).

### SQLSTATE error classification

Every PostgreSQL error carries a five-character SQLSTATE code; its first two characters are the class. Ingest decides by class:

- 22 (data exception), 23 (integrity violation) and 54 (program limit exceeded) won't change on a retry: the message is recorded as `unstorable` in `ingest.rejected_message` and acknowledged, so it can't block the stream;
- everything else (a connection loss, a lock timeout `55P03`, a missing table during a deploy `42P01`) may heal: the message is retried, and if the database stays unavailable the MQTT session is dropped deliberately and never acknowledged.

### Persistent MQTT sessions and session expiry

With `clean: false` and a fixed client id (`mes-server`), the broker keeps the MES's subscriptions and queues QoS 1 messages while it is away. In MQTT 5 a session also needs a **session expiry interval**: with the default of 0 the session ends at disconnect, persistent flag or not. Mosquitto's `max_queued_messages` (100,000) bounds the queue, about one hour of the plant at 60×. Beyond that, messages are dropped and show up as sequence gaps.

### Epochs and watermarks

An **epoch** identifies one run of a sequence owner (ADR-0015). A simulator restart starts a new device epoch, and its simulation time may start earlier than the old run's. Intervals are therefore kept per (equipment, epoch), and a new epoch closes the old one's open interval.

The **plant watermark** is the latest `sourceTime` seen from any device in the current epoch. It answers "how far has the plant's time got?", even for a machine that says nothing for hours.

### Provisional intervals

The interval a machine is in now has no end yet. Storing nothing would make the current shift's totals wrong until the next state change. So the MES stores the open interval up to the watermark, flagged `provisional`, and replaces it when the next fact arrives (ADR-0018). A screen can show time in state now; a report knows which part may still change.

### Reorder-safe recomputation

Facts can arrive out of order (a replay, a late message after a reconnect). Intervals are built by `seq`, not by arrival. A late fact changes only the interval between its neighbours, so the MES recomputes that window and replaces its stored pieces in one statement. Running it twice gives the same rows. Delivery order therefore doesn't matter, which the tests show with shuffled, duplicated input.

### Splitting at hour and shift boundaries

OEE is reported per hour and per shift. Each interval is cut into **pieces**, each inside one UTC hour and one shift bucket (`<shiftDate>/<shiftId>` or `no-shift`). Summing pieces by `hour` or `shift_key` then needs no clipping. Istanbul has no DST (UTC+3), so UTC hours and local hours share boundaries. The MES uses the simulator's own shift calendar package, so both cut at exactly the same instants.

### OpenAPI drift tests

The OpenAPI document is generated from the zod route schemas, and a test regenerates it and compares it with the committed `docs/api/mes.openapi.json`. Any change to a route that isn't reflected in the committed file fails CI. `docs/data-model.md` works the same way: generated from a migrated database, checked by `db.test.ts`.

### WebSocket backpressure

A server can produce messages faster than a slow client can read them. Without a limit, each slow client's buffer grows in server memory. The MES watches `bufferedAmount`: above 256 KiB it coalesces the queue to the latest delta per key (a dashboard needs the latest state, not every intermediate one), and above 4 MiB or after a missed pong it drops the client. Pushing happens outside ingest's acknowledgement path, so a slow browser never slows ingest (ADR-0019).

### Host and Origin checks against DNS rebinding

An attacker's page at `evil.example` can make its DNS name point at 127.0.0.1. The browser then sends requests to the local MES as "same origin" with `evil.example`, reading the API. Checking the `Host` header against an allowlist (`localhost`, `127.0.0.1`, `[::1]`) refuses them. WebSockets aren't covered by the same-origin policy at all, so the server also checks the `Origin` header against `Host` or an allowlist.

### nginx as a reverse proxy

The `web` container serves the built app and forwards `/api` (including the WebSocket upgrade) to the MES. The browser sees one origin, so no CORS. Details that mattered:

- `Host $http_host` keeps the port, which the MES's Origin check compares;
- nginx resolves `mes` through Docker's DNS every 10 s, so a recreated MES container is found again;
- CSP, caching and compression headers are set in one place.

### Playwright latency judging

At 60×, a 10 s stop lasts about 170 ms of wall time, so the browser can't be expected to show every state. The rule: when the truth changes at time t, the page must show that state, or one the truth took later, by t + 2 s. The page records its badges every 20 ms; t comes from the simulator's paced clock. A frozen page could match by accident, so the test also requires real transitions on the page.

### Reconciliation as proof

The MES's shift totals are compared with an independent ground truth (the simulator's own accounting) per state, per machine, to the millisecond. Equality, not tolerance, is the test. A tolerance would hide off-by-one cuts, double-counted pieces and lost facts. Integer milliseconds end to end make exact equality possible.

## 2. Reading order

| #   | File                                                            | Look for                                                                |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `docs/data-model.md`                                            | The tables, their keys and the three hypertables                        |
| 2   | `docs/adr/0017-mes-ingest-acks-anchors-and-gaps.md`             | Ack after commit, anchors, gaps, error classes                          |
| 3   | `apps/mes-server/src/modules/ingest/ingest.ts`                  | The `handleMessage` path: validate, store, notify, acknowledge          |
| 4   | `apps/mes-server/src/modules/ingest/classify.ts`                | Which SQLSTATE classes are unstorable                                   |
| 5   | `packages/oee-core/src/intervals.ts`                            | Building intervals from facts and cutting them at boundaries            |
| 6   | `docs/adr/0018-equipment-intervals-provisional-and-catch-up.md` | Provisional storage, watermarks, catch-up                               |
| 7   | `apps/mes-server/src/modules/equipment/equipment.ts`            | Windows, the in-order fast path, the single upsert-and-delete statement |
| 8   | `apps/mes-server/src/modules/realtime/push.ts`                  | Queues per client, coalescing, limits                                   |
| 9   | `apps/web/nginx/default.conf`                                   | Proxy headers, WebSocket upgrade, CSP                                   |
| 10  | `e2e/` (`pnpm test:reconcile`)                                  | Start order, the comparison, the latency rule                           |

## 3. Questions, with answers

**1. Why does `ingest.equipment_event` have a unique key on four columns, including `source_time`, when (equipment, epoch, seq) already identifies a fact?**

Because it is a hypertable. TimescaleDB enforces unique constraints per chunk, so it only allows those that include the partitioning column (`source_time`). A duplicate is the same message again with the same `sourceTime`, so including the time doesn't weaken dedup. The durable cursor (`ingest.source_cursor`) still records which numbers were seen.

**2. Why acknowledge a message after the commit and not when it arrives?**

An acknowledged message is gone from the broker. If the MES acknowledged first and crashed before committing, the fact would be lost for good. Acknowledging after the commit turns the crash into a redelivery, and the unique key makes that redelivery harmless.

**3. A message fails with SQLSTATE `55P03` (lock not available). Why must it not be recorded as unstorable after a few tries?**

`55P03` says another transaction holds a lock, which is temporary. Giving up would acknowledge a good fact without storing it: data loss caused by a slow migration or a long query. Only classes 22, 23 and 54 describe the message itself (bad data, a broken constraint, a value too large); they will fail every time, so skipping them is the only way to keep the stream moving.

**4. Why is `clean: false` not enough for a persistent session in MQTT 5?**

MQTT 5 separates "keep the session" from "for how long". The session expiry interval defaults to 0, which ends the session at disconnect. Without a positive expiry, the broker discards the MES's subscriptions and queue the moment it disconnects, so everything published during an MES restart would be lost.

**5. A machine is Off over the weekend and sends nothing. How does the MES still cut its open interval at each hour and shift boundary?**

Through the plant watermark: the latest `sourceTime` from any device in the epoch. Other devices keep sending (telemetry, other machines' facts), so the watermark passes each boundary, and the silent machine's open interval is stored provisionally up to it. The machine's own telemetry can't do it, because a constant value keeps its old timestamp.

**6. Why are intervals scoped per epoch rather than per equipment?**

A simulator restart begins a new run whose simulation time may begin earlier than the old run's (Compose starts at a fixed `SIM_START`). Mixing both runs on one time line would create overlapping or negative intervals. Per epoch, each run is consistent on its own, and a new epoch simply closes the old run's open interval at its last watermark.

**7. A fact with seq 42 arrives after seq 43 and 44 were already processed. What does the MES recompute?**

Only the window between seq 42's neighbours: the interval that seq 41 opened, which now ends at 42, and the new interval from 42 to 43. Those pieces are replaced in one statement. Intervals before 41 and after 43 don't change. Because the recomputation derives the same rows from the same facts, doing it twice changes nothing.

**8. Why store the intervals already cut at hours and shifts instead of cutting at query time?**

Phase 5 aggregates per hour and per shift continuously. With stored pieces, an aggregate is a plain `GROUP BY hour` or `GROUP BY shift_key`, which TimescaleDB can maintain incrementally. Cutting at query time would repeat the calendar logic in SQL for every query and risk differing from the simulator's calendar.

**9. Why does the MES need state anchors at all? Doesn't the next state fact say what the machine is doing?**

The next fact says what the machine does from then on, not before. Between the MES's start (or a new epoch) and the first state change, the state is unknown. A retained `state/current` message or a resync snapshot gives the state at a known time, so the first interval can start there. Anchors never count as facts: they don't enter dedup or gap checks.

**10. What does the OpenAPI drift test catch that a type check doesn't?**

The type check proves the server and the web app agree with the schemas in the code. The drift test proves the published document agrees with them too. Without it, a route could change while `docs/api/mes.openapi.json` still describes the old shape, misleading any client written from the document.

**11. Why does the push coalesce a slow client's queue instead of just dropping old messages?**

Dropping arbitrary messages would leave a screen showing a state that is no longer true. Coalescing keeps the newest delta per key (per machine state, per metric), so the screen ends up correct, only with fewer intermediate steps. Above 4 MiB the client is dropped; it reconnects and gets a fresh snapshot.

**12. Compose publishes the MES only on 127.0.0.1. Why does it still need a Host allowlist?**

Because a browser on the same machine can be tricked into talking to it. With DNS rebinding, `evil.example` resolves to 127.0.0.1 after the page loads, and the browser treats requests to it as same-origin with the attacker's page. The request still carries `Host: evil.example`, which the allowlist refuses.

**13. Why does nginx forward `Host $http_host` and not `$host`?**

`$host` drops the port. The MES checks a WebSocket's `Origin` (with port, like `http://localhost:8080`) against `Host`; without the port they never match, and every WebSocket would be refused. `$http_host` passes the header as the browser sent it.

**14. Why judge the browser by "this state or a later one within 2 s" instead of "every state within 2 s"?**

At 60× many states last less than a frame or two. A UI that shows the latest state is correct even if it skips one that lasted 100 ms. The rule demands what a user needs (the screen catches up within 2 s) without demanding the impossible.

**15. Shift totals matched to the millisecond, yet three machines reported provisional time. Is the proof still valid?**

Yes. The provisional part is the open interval at 14:00, but its shift-A piece ends exactly at the shift boundary. It can only change if an earlier fact of the same machine arrives. The drain check shows the MES already has every fact up to the boundary: each machine's current state and start equal the simulator's. So the piece is final in fact, only not marked so; #113 stores finality per piece.

## 4. Hands-on exercise

Watch idempotency and the data model at work.

1. `pnpm stack:up`, then open <http://localhost:8080> and pick a machine.
2. Open a database shell: `docker compose exec db psql -U shopfloor shopfloor` (or `DB_USER` and `DB_NAME` from `.env`, if set).
3. Count the facts: `SELECT equipment, count(*) FROM ingest.equipment_event GROUP BY 1;`. Note the numbers.
4. Restart the MES: `docker compose restart mes`. While it is down, the broker queues for its persistent session. When it is back, run the count again: the facts from the downtime are there, none twice (`SELECT equipment, epoch, seq, count(*) FROM ingest.equipment_event GROUP BY 1, 2, 3 HAVING count(*) > 1;` returns no rows).
5. Look at the pieces of the current hour: `SELECT equipment, state, start_time, end_time, shift_key, provisional FROM equipment.equipment_state_interval WHERE hour = date_trunc('hour', (SELECT max(start_time) FROM equipment.equipment_state_interval), 'UTC') ORDER BY equipment, start_time;`. The last piece of each machine is provisional.
6. Compare with `docs/data-model.md`: find the check constraints that guarantee a piece never crosses its hour.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
