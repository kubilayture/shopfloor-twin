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
