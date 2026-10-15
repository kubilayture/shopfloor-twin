# Phase 04 – MES foundation: historian and equipment states: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-15

- Phase 4 planned: issues #92–#101, milestone 5.
  - The simulator's shift calendar becomes a shared package, so that the MES cuts shifts exactly as the simulator does.
  - Ingest keeps ADR-0015's dedup in the database (unique keys) and uses a persistent MQTT session.
- The plan review (PR #102) found three blockers, all adopted:
  - hypertable unique keys must include the time column;
  - the MES needs a starting state (retained messages and snapshots anchor it);
  - a simulator restart moves simulation time backwards, so intervals are scoped per epoch.

  Also adopted: a plant watermark for provisional closing, UTC hours, a session expiry for the persistent session, a cursor table, `db/migrations` as in plan section 8, the interval functions in `oee-core`, and window-only recomputation.

- Merged #102 (#92): Phase 4 plan.
- #93: the migration runner is about 80 lines with an advisory lock, checksums and a transaction per file; tests start a real TimescaleDB and cover a concurrent start, a changed file, an unknown migration and a rollback. The Docker-context helper moved to `@shopfloor/test-kit/docker` for the gateway and the MES.
- #93 review and CI: the gateway end-to-end test timed out in CI once the MES tests (a second database container) ran beside it. End-to-end tests (`*.e2e.test.ts`) now run in their own CI job, one at a time, and their waits say what they waited for. Migration runner: no-transaction files (PostgreSQL runs a multi-statement query as one implicit transaction, so they are split into statements), LF-normalised checksums, a lock wait limit, and a column list typed from `Database`.
- CI again: the outbox outage test (#78) timed out under the same load. The gateway and MES test files now run one after another (`fileParallelism: false`); they start processes and containers.
- Merged #103 (#93).
- #94: the calendar moved without any behaviour change; the golden week is byte-identical. `shift-calendar` and `oee-core` are pure packages (lint-enforced). A property test checks that the shift bucket is constant between consecutive cuts and changes at each one, over a whole week.
- #95: ingest stores every message in a transaction inside MQTT.js's `handleMessage`, whose callback gates the PUBACK, so a message is acknowledged only after the commit, in arrival order (ADR-0017). Tests run a real TimescaleDB and Mosquitto: duplicates, out-of-order facts, retained messages, stale epochs, invalid payloads, a gap that becomes an incident and is filled late (also across a restart), a failed transaction retried, and an MES crash inside a transaction with the broker queueing for the persistent session: all twenty facts stored exactly once.
  - Deviation: a snapshot carries the gateway's epoch, not the device's, so "first anchor per (equipment, epoch)" became "per (equipment, device epoch)", with a snapshot taking the epoch of the next device fact of its equipment (ADR-0017).
  - Added beyond the issue: `ingest.component_status` (the gateway's latest status) and a pool error handler, so an idle database connection closed by the server no longer ends the process.
  - Known limit: one transaction per message; draining a long outage's queue may take minutes (not measured yet).
- #95 review (PR #105), all adopted:
  - poison messages: a value the database can't store blocked ingest in an endless retry. Failures are now classified by SQLSTATE: transient ones are retried and, if the database stays down, the session is dropped deliberately until it answers (a blocked MQTT.js pump doesn't even read PINGRESP); data errors are recorded as `unstorable` and acknowledged. Validation refuses times outside 1970–2199 and lone surrogates; `lost` is BIGINT;
  - snapshot anchors could take the wrong epoch (a stale retained snapshot on a persistent broker) or none (a silent machine): snapshots now carry an optional `deviceEpoch` (UNS contract 1.1), filled by the gateway; older snapshots fall back to the next fact, latest one only;
  - the queue sizing was wrong: 100,000 messages is about one hour at the real ~25 messages/s at 60× (the plan's "5 hours" overstated it), and draining it takes about two minutes at the measured ~1,000 messages/s;
  - hypertable chunks are 7 days (1 day of simulation time made about 60 chunks per wall day at 60×);
  - a known stream's new epoch counts numbers below its first one as a gap;
  - any broker user can take over client id `mes-server` (documented; the plain ACL can't prevent it);
  - a test for a crash between commit and acknowledgement.
- #95 re-review: "an unknown error three times is unstorable" lost good facts behind a held lock (`55P03`), and the same would happen during a deploy (`42P01`). Now only SQLSTATE classes 22, 23 and 54 are unstorable; every other error is retried and then suspends the session, never acknowledged. The cursors are reloaded before reconnecting, so a commit that was applied although it reported failure is a duplicate on redelivery. A test holds an `ACCESS EXCLUSIVE` lock against a 200 ms `lock_timeout`.
- #96: the `equipment` module stores state intervals in `equipment.equipment_state_interval` (a hypertable), every piece inside one UTC hour and one shift bucket, with the opening fact's `seq` and a `provisional` flag for the open interval (ADR-0018).
  - Reconciliation without a broker: the headless simulator runs as a process (apps never import each other), its event log is mapped to the UNS messages the gateway publishes (one device sequence per machine across state, cycle and alarm, as OPC UA `Sequence` and the washer's ring number them; a snapshot per machine at start, everything starting Off) and fed through ingest's store path (`Ingest.deliver`, new) into TimescaleDB. The golden week equals the ground truth per machine and shift bucket to the millisecond, in order and shuffled with 10 % duplicates, and both runs store identical rows. The week takes about three minutes, so it runs in the end-to-end job; `pnpm test` reconciles a Friday with its night shift (about 40 s).
  - Epochs: all simulated devices share the simulator's epoch, so cycles and states of any machine move the plant watermark; telemetry carries the gateway's epoch and counts for its equipment's newest device epoch.
  - `shiftKeyAt` per piece would have cost about 54 µs each; `shiftSegments` (new in `shift-calendar`, property-tested against `shiftKeyAt`) walks the calendar once per window.
  - Performance: the first version added about 3.8 ms per state fact (a window query and a five-statement transaction); an in-order fast path and a single upsert-and-delete statement bring it to about 1.4 ms. Storing open intervals every simulated minute dominated a replay, so replays use an hour step (boundaries still trigger).
  - Ingest change: a fact already in the table but unknown to the cursor (a commit reported failed but applied) is now re-announced to listeners, which otherwise never heard of it.
- #96 review (PR #106), all adopted:
  - blocking: a restarted simulator's telemetry arrives before the collector's resync publishes the new snapshot, so it was credited to the old epoch (an old interval became 46 hours of final Running; after an MES restart old open intervals moved a day). Telemetry now carries an optional `deviceEpoch` (UNS contract 1.1), filled from the same Modbus read or the OPC UA connection's resync; telemetry without it never moves a watermark, and a closed epoch's end (`interval_source.closed_at`) never moves again;
  - a clamped (equipment, epoch) is recomputed once, then handled window by window with clamped neighbours, instead of in full on every fact inside ingest's acknowledgement path;
  - the fact count is taken from ingest for reordered facts, so a fact handled twice no longer makes every start recompute; a start also accepts an open interval that has no piece yet;
  - a track marked for recompute is never patched from its stale state; the re-announce also re-sends the epoch's anchor;
  - ADR-0018 corrected, with a note on retention; per-test limits of the golden week (4 and 6 minutes) stay inside the end-to-end job's 20 minutes; the Friday test now starts at 14:00 (about 25 s).
- Merged #106 (#96).
- #97: the `realtime` module serves the read-only REST API under `/api/v1` and WebSocket push at `/api/v1/ws` (ADR-0019).
  - Routes are declared once with zod: zod validates path and query (dates parsed, unknown parameters refused, ranges bounded), the response schema types the handler, and the converted schemas give an OpenAPI 3.1 document (`docs/api/mes.openapi.json`, drift test). Errors are RFC 9457 problem details; 5xx details never carry the cause.
  - Intervals are returned merged: the stored hour and shift pieces of one interval are joined back and clipped to the range. Telemetry is decimated by `time_bucket` (min, max, average, count per bucket, at most 5,000 buckets) so a week fits a chart.
  - Push: ingest awaits its listeners before the broker acknowledgement, and the equipment module's changes are announced inside that path, so the push listeners only queue a delta per client and key and flush on a later event-loop turn. A slow client's queue is coalesced (one delta per key) above 256 KiB buffered and the client dropped above 4 MiB or after a missed pong.
  - Measured: the 60× rate (25 messages/s, a third of them state changes) reaches a WebSocket client within about 30 ms at most locally (exit criterion 3 allows 2 s).
  - Deviations: `GET /shifts/{date}/{shift}/totals` instead of `/shifts/{shiftKey}/totals` (the key contains a slash); the slow-client coalescing is tested with a fake socket (a real one needs megabytes in the kernel's buffers before `bufferedAmount` grows), the rest of the protocol with a real WebSocket client. Master data's equipment list now includes the site; ingest's sample notices carry telemetry values.
