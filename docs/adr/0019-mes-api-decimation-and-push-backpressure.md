# ADR-0019: MES API: zod routes with generated OpenAPI 3.1, time-bucket decimation, coalescing push

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (#97), within the Phase 4 plan; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

The Phase 4 plan puts a read-only REST API under `/api/v1`, an OpenAPI description in `docs/api/mes.openapi.json` with a drift test, and a WebSocket that pushes state changes and telemetry, all in the `realtime` module. Implementing it left these questions open:

- **Validation and OpenAPI:** plan section 8 validates at the boundary with zod; Fastify validates with Ajv from JSON Schema. Which one runs, and where does the OpenAPI description come from?
- **Intervals:** the equipment module stores pieces cut at every UTC hour and shift. Does the API return pieces or whole intervals?
- **Decimation:** at 60× a week of one metric is about 600,000 samples (one per wall second). How does a week fit in a uPlot chart?
- **WebSocket library and backpressure:** ingest awaits its listeners before the broker acknowledgement (ADR-0017), and the equipment module's change listeners run inside that path. A slow browser must not slow ingest, nor make the MES buffer without bound.

## Considered options

Validation: (a) Ajv on JSON Schema written by hand; (b) zod schemas converted to JSON Schema (`z.toJSONSchema`) for Ajv; (c) zod validates (a per-route `validatorCompiler`), and the same zod schemas, converted, describe the route for `@fastify/swagger`.

Intervals: (a) return the stored pieces; (b) merge the pieces of each interval back and clip to the range; (c) both, by a parameter.

Decimation: (a) return raw samples, let the client thin them; (b) LTTB (largest triangle, three buckets) in the server; (c) TimescaleDB `time_bucket` with min, max, average and count per bucket.

WebSocket: (a) `@fastify/websocket` (on `ws`); (b) `ws` on its own; (c) Server-Sent Events. Backpressure: (a) send everything and disconnect at a buffer limit; (b) per-client queues of deltas keyed by what they describe, coalesced while the socket's buffer is over a soft limit, disconnect at a hard limit.

## Decision outcome

- **Validation: (c).** A route is declared once with zod schemas for path, query and response. Zod parses the input (dates and numbers arrive parsed in the handler; unknown query parameters are refused), the handler's return type is the response schema's type, and `@fastify/swagger` builds an **OpenAPI 3.1** document from the converted schemas (JSON Schema 2020-12 is OpenAPI 3.1's dialect, so nothing is translated). Responses are serialised with `JSON.stringify`: they are typed, not filtered by a schema. (b) would validate with different semantics than the types (Ajv coercion versus zod transforms). `pnpm --filter @shopfloor/mes-server openapi` writes the document and the WebSocket message schemas; a test fails when the committed files differ.
- **Errors:** RFC 9457 problem details (`application/problem+json`: `type`, `title`, `status`, `detail`, `instance`), with a validation message for 400 and `internal error` for any 5xx except 503, so a database error never reaches a client.
- **Intervals: (b).** Pieces exist for OEE per hour and shift (Phase 5); a timeline wants whole intervals. Pieces with the same epoch and opening fact are merged and clipped to the range, with `intervalStart` giving the true start; `provisional` marks the open interval. Time per shift comes from `GET /shifts/{date}/{shift}/totals`. A range is at most 7 days and a response is built from at most 20,000 pieces. When more exist, `truncated` is true, every interval that may continue past the limit is left out (none is returned with a wrong end), and `next` says where the following request starts (`from=next`); the intervals before it are complete.
- **Decimation: (c).** The range is cut into at most `maxPoints` buckets (default 1,000, at most 5,000) of equal width aligned on `from`; each non-empty bucket gives min, max, average and count, computed by the database next to the data. Min and max keep spikes visible as a band (uPlot can fill between two series), which an average alone hides; (b) picks shape-preserving points but needs every raw sample in the server; (a) moves the whole week to the browser. A range is at most 31 days and 8 metrics. The metric list per equipment, with units and latest values, is read with a loose index scan over `(equipment, name, source_time)`, one row per metric.
- **WebSocket: (a)**, as in the simulator's control API: it shares Fastify's server, port, lifecycle and close hooks, and its handler gets a plain `ws` socket (`bufferedAmount`, `ping`, `terminate`) for backpressure. (b) would need its own upgrade handling beside Fastify for the same `ws` underneath. (c) can't receive subscriptions on the same connection.
- **Backpressure: (b).** The listeners on `Equipment.onChange` and `Ingest.onStored` are synchronous: they serialise a delta once, put it in the queue of each subscribed client under its key (`state:<equipment>`, `telemetry:<equipment>:<metric>`, `clock`) and schedule a flush with `setImmediate`. Nothing is sent on ingest's acknowledgement path. A flush sends a client's queue unless its socket buffers more than 256 KiB; then the queue waits (tried again every 100 ms) and a newer delta replaces the older one of the same key, so a slow client holds at most one delta per key and catches up with the latest values. Above 4 MiB, or after a missed pong (ping every 15 s), the client is disconnected. A state delta is sent only when the state, its cause, start or epoch changed; the plant clock is pushed at most once a second, when it moved. A telemetry snapshot being read holds back only that equipment's telemetry deltas; state deltas keep flowing, and a snapshot is not sent when the client unsubscribed meanwhile.
- **Per-client limits:** at most 64 telemetry subscriptions, counted per metric (a whole equipment counts one), checked whenever a subscription is new; at most 4 snapshots in flight; client messages are rate-limited by a token bucket (10 per second, bursts of 20; `rate-limited` error). A client subscribed to every metric of an equipment can't unsubscribe a single one (an error says to unsubscribe the topic and subscribe the metrics wanted).
- **Database pools:** the API reads through its own pool (`API_DB_POOL_SIZE`, default 4) with `statement_timeout` and a connection wait of `API_STATEMENT_TIMEOUT_MS` (default 5 s); ingest and the equipment module keep theirs. A dashboard read therefore never takes a connection that ingest's acknowledgement path is waiting for, and a timed-out read answers 503 (`the database is busy; try again`), not 500.
- **Origin and Host checks:** the API is read-only and unauthenticated until Phase 9, so a page on another site must not read it. Browsers don't let a cross-site page read REST responses (no CORS headers), but they do let it open a WebSocket, and DNS rebinding (a site's own name resolving to 127.0.0.1) turns any request into a same-origin one. So every `/api/v1` request must name an allowed host in its `Host` header (`HTTP_ALLOWED_HOSTS`, default `localhost,127.0.0.1,[::1]`, `*` for any), and a WebSocket upgrade with an `Origin` header must come from the MES's own host or from `HTTP_ALLOWED_ORIGINS` (default none); requests without `Origin` (not from a page) pass. Refusals are 403. The nginx container of #99 has to forward `Host` or be listed. _Writes (#121): a non-GET request must also carry an `Origin` of the MES's own host or of the allowlist, among other guards; see ADR-0023._

### Consequences

- Good: one schema per route gives validation, types and documentation; the OpenAPI document can't drift from the code.
- Good: a week of telemetry is at most a few thousand points per metric whatever the sample rate; spikes stay visible.
- Good: a stalled browser costs bounded memory (one delta per key) and never delays an acknowledgement; a fast client gets every delta.
- Bad: a slow client may skip intermediate states and samples; at 60× even a fast client sees short stops only as deltas (exit criterion 3 asks for the latest state within 2 s, not for every state). Clients that need history read it from REST.
- Bad: responses aren't filtered by their schema at runtime; the tests parse them with the response schemas instead.
- Bad: the allowlists must be kept in step with how the MES is reached (names, ports behind a proxy); a wrong list shows as 403, not as a silent leak.
- Bad: buckets are by simulation time; after a simulator restart (new epoch, time jumping back) a range may mix both runs' samples, and "latest" per metric is by `sourceTime`.

## Note: authentication (#168)

"Read-only and unauthenticated until Phase 9" is amended: identity arrives in Phase 7 (ADR-0026). With `MES_AUTH=on` every `/api/v1` route but `POST /session` needs a session cookie (401 `urn:shopfloor:unauthenticated`) and the route's permission (403 `urn:shopfloor:forbidden`; every read needs `read`, which every role holds), and the WebSocket needs it too: an upgrade passes the `Host` and `Origin` checks above first (403), then a socket without a live session is closed at once with code 4401, and an open socket is closed with 4401 when its session ends or expires. The `Host` and `Origin` checks stay as they are and run before authentication, so a page on another site never learns whether a session exists. `/health/*` and `/metrics` stay open. #168 builds this behind `MES_AUTH=off` (the default until #170, which turns it on with the web's login), so until then the API answers as described above.
