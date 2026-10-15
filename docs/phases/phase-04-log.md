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
