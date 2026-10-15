# Phase 04 – MES foundation: historian and equipment states: plan

Planned 2026-10-15. Plan reference: section 5 (data paths 1, 2 and 5), section 6 (stack), section 7 (modules master-data, ingest, equipment, realtime; data model), section 8 (module rules), section 9 (tests), section 11 row 4. Size: L. Milestone: [Phase 04 – MES foundation](https://github.com/kubilayture/shopfloor-twin/milestone/5).

## Scope

The MES starts:

- **`mes-server`**: a Fastify modular monolith on TimescaleDB, with the modules `master-data`, `ingest`, `equipment` and `realtime` (plan section 7).
- **Master data:** seeded from `config/plant`.
- **Ingest:** subscribes to the UNS and stores every message idempotently.
- **Equipment:** turns state changes into **state intervals**, each inside one hour and one shift, the basis of OEE in Phase 5.
- **API:** REST and WebSocket.
- **`web`:** the first screens, a plant overview with every machine's live state and a machine detail with its state timeline and telemetry trends.

Out of scope here:

- OEE and downtime reason coding (Phase 5);
- alarm lifecycle and shift reports (Phase 6);
- orders and the ERP mock (Phase 7);
- identity and login (Phase 9 security). The API is read-only, and bound to loopback in Compose.

## Decisions made in this plan

### Structure

- **One PostgreSQL schema per module** (`master_data`, `ingest`, `equipment`). A module reads and writes only its own schema; other modules call its TypeScript interface (plan section 7). The lint rules of plan section 8 already forbid cross-module imports other than through a module's `index.ts`.
- **Migrations:**
  - plain SQL files in **`db/migrations/`** (plan section 8), named `NNNN_<module>_<what>.sql`, applied in order, each in a transaction, by a small runner in `mes-server`;
  - the runner records name and checksum in `public.schema_migrations`, and refuses to start if an applied file has changed;
  - they run at start-up, before the server reports ready.

  Kysely provides typed queries on hand-written table types; a test compares them with `information_schema`, so the types can't drift from the schema. Details: ADR-0016 (#93).

- **Pure packages:**
  - `@shopfloor/shift-calendar`: the simulator's calendar, extracted, with its own input types, so it stays dependency-free. Simulator and MES both use it, so the MES cuts shifts exactly as the simulator does. The headless golden snapshot must stay byte-identical through the extraction.
  - `@shopfloor/oee-core` starts with the pure state-accounting functions: building intervals from facts and splitting them at boundaries (plan section 8 puts these there). Phase 5 adds OEE.
  - Because simulator and MES share the calendar, the reconciliation can't catch a calendar bug. The calendar keeps its own tests: DST-free Istanbul, handovers, the Friday night shift.

### Time

- **Simulation time only:** intervals, boundaries and ordering use the devices' `sourceTime`; wall time never enters the MES's accounting.
- **"Hour" means UTC hour.** Istanbul is UTC+3 all year (no DST), so UTC hours and local hours share boundaries. A future tzdata change is covered by testing through Temporal.
- **Shift buckets** are keyed by (shift date, shift id), as in the ground truth. Each gap between shifts is one `no-shift` bucket. (Shift instances as records belong to the `shifts` module in Phase 6.)
- **Plant watermark:** the latest `sourceTime` seen from _any_ device in the current epoch. A machine that sends nothing (Off over the weekend) still has its open interval closed provisionally at every hour and shift boundary the watermark has passed. A device's own telemetry isn't enough, because a constant value keeps its old timestamp.

### Identity, dedup and epochs (ADR-0015 in the database)

- **Hypertable keys must include the time column** (a TimescaleDB rule): `ingest.equipment_event` is unique on (equipment, epoch, seq, source_time), and `ingest.telemetry_sample` on (topic, epoch, seq, source_time). A duplicate carries the same `sourceTime`, so `INSERT … ON CONFLICT DO NOTHING` deduplicates.
- **Cursor table** `ingest.source_cursor` (the master plan's `ingest_source_cursor`): per stream, the current epoch and the ranges of numbers seen, stored as ranges like `Deduplicator`. Gap tracking therefore survives MES restarts, and a message from an **older epoch** is refused as stale.
- **Gaps:** holes in a device stream are recorded in `ingest.data_quality_incident` after a grace period, together with the gateway's own `_sys/…/incidents`.
- **Epoch change** (a simulator or device restart): simulation time may jump backwards under the new epoch, as with Compose's fixed `SIM_START`. Intervals are therefore **scoped per epoch**, and a new epoch closes the old epoch's open interval at its last watermark. The ground-truth comparison is per epoch, and a test covers the restart.

### Ingest

- **Persistent MQTT session:** client id `mes-server`, QoS 1, `clean: false` **and** a session expiry interval (MQTT 5: without it the session ends on disconnect), so the broker queues messages while the MES is down. Mosquitto's `max_queued_messages` is raised to 100,000 (about 5 hours of the plant at 60×). Known limit: queued messages survive a broker crash only up to its last autosave.
- **Validation:** every message is checked with `parseUnsMessage`; an invalid one is stored in `ingest.rejected_message` with the reason, never dropped silently.
- **Retained messages** (retain flag set on delivery) and **snapshots** are not facts. They never enter dedup or gap checks. They anchor the current state at their `sourceTime` when the MES doesn't know one yet (first start, or a new epoch), and that anchor opens an interval. From then on, facts drive intervals.

### Equipment intervals

- An interval runs from one state fact (or the anchor) to the next fact of the same equipment within the epoch, ordered by `seq`, using `sourceTime`. It is stored in **`equipment.equipment_state_interval`** (data-model name). Every stored interval lies inside one UTC hour and one shift bucket.
- **Reorder-safe:** a fact arriving out of order changes only the interval between its neighbours. That window is recomputed and re-split, idempotently, so duplicates and replays change nothing.

### API, push and web

- **API and push** (`realtime` module): REST under `/api/v1` (equipment with current state, state intervals, telemetry series), generated OpenAPI in `docs/api/mes.openapi.json` with a drift test, and a WebSocket that pushes state changes and telemetry to subscribed screens.
- **Web:**
  - React 19, Vite 8, TanStack Router and Query, Tailwind 4, uPlot for trends (plan section 6);
  - served by its own container (nginx, static files) that proxies `/api` to `mes-server`;
  - no login yet;
  - shadcn/ui components are added only where a screen needs them.
- **Telemetry rates:** OPC UA telemetry is sampled every second (gateway default); WSH-01's telemetry comes with every Modbus poll (250 ms). The MES stores what arrives; plan section 5 allows decimation.

### Reconciliation

The simulator's control API exposes the run's ground-truth summary (the headless `GroundTruth`, kept live). The end-to-end test starts things in order: database and broker, then the MES ready, then the gateway connected, and only then the simulator (`SIM_AUTOSTART=false`, resumed over its control API, starting at 06:00, the start of shift A). The MES knows every machine's state from the first instant of the shift.

## Issues, in dependency order

| #                                                                | Task                                                                                                                                                                        | Depends on    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [#92](https://github.com/kubilayture/shopfloor-twin/issues/92)   | Phase 4 plan (this document)                                                                                                                                                | –             |
| [#93](https://github.com/kubilayture/shopfloor-twin/issues/93)   | `mes-server` skeleton: env, health and readiness, metrics, module layout, Kysely, SQL migration runner (ADR-0016), Testcontainers TimescaleDB harness                       | #92           |
| [#94](https://github.com/kubilayture/shopfloor-twin/issues/94)   | `@shopfloor/shift-calendar` extracted from the simulator; `master-data` schema and idempotent seed from `config/plant`                                                      | #93           |
| [#95](https://github.com/kubilayture/shopfloor-twin/issues/95)   | `ingest`: persistent UNS subscription, validation, hypertables, durable dedup, gaps and incidents                                                                           | #93, #94      |
| [#96](https://github.com/kubilayture/shopfloor-twin/issues/96)   | `equipment`: state intervals split at hour and shift boundaries, provisional closing, reorder-safe recomputation; reconciliation with the simulator's headless ground truth | #94, #95      |
| [#97](https://github.com/kubilayture/shopfloor-twin/issues/97)   | REST API and WebSocket push; OpenAPI                                                                                                                                        | #95, #96      |
| [#98](https://github.com/kubilayture/shopfloor-twin/issues/98)   | `apps/web`: plant overview and machine detail                                                                                                                               | #97           |
| [#99](https://github.com/kubilayture/shopfloor-twin/issues/99)   | MES and web containers in Compose                                                                                                                                           | #97, #98      |
| [#100](https://github.com/kubilayture/shopfloor-twin/issues/100) | End to end: simulator ground truth in live mode; one simulated shift reconciled through the whole chain; Playwright check of the live overview at 60×                       | #96, #98, #99 |
| [#101](https://github.com/kubilayture/shopfloor-twin/issues/101) | Close Phase 4: report, learning notes, `docs/data-model.md` generated from the database, tag                                                                                | all           |

## Exit criteria (plan section 11)

1. **Reconciliation:** for one simulated shift run at 60× through simulator → gateway → broker → MES, started in the order above, the recorded state intervals equal the simulator's ground truth: time per state, per machine, for that shift, to the millisecond (all times are integer milliseconds end to end). Every stored interval lies inside one UTC hour and one shift bucket.
2. **Duplicates and reordering:** tests deliver duplicates, out-of-order facts, retained messages, stale epochs and an MES restart mid-stream, and the stored events and intervals are unchanged by them. A simulator restart (new epoch) is handled per epoch.
3. **Live overview at 60×:** a Playwright test sees the browser show each machine's latest UNS state within 2 s. At 60×, intermediate states may be skipped: a 10 s stop lasts about 170 ms of wall time.
4. **Integration tests green in CI:** TimescaleDB runs through Testcontainers on the GitHub runner. The full-shift reconciliation is its own job, with a budget of about 15 minutes (8 minutes of shift plus start-up). `docs/data-model.md` is generated from the database.

## Risks for this phase

| Risk                                                                   | Response                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase size L, with a new app and the first UI                          | Strict dependency order; the UI is limited to two screens; shadcn/ui only where needed                                                                                                                              |
| Off-by-one errors at hour and shift boundaries, and around DST         | One shared shift calendar (Temporal, Istanbul); property tests: split intervals sum to the original and never cross a boundary; a reconciliation test over the headless week, which includes the Friday night shift |
| Reordering corrupts intervals                                          | Recompute from the late fact onward, idempotently; tests with shuffled delivery                                                                                                                                     |
| A full shift at 60× takes 8 wall minutes in CI                         | The reconciliation runs as its own CI job, in parallel to `verify`                                                                                                                                                  |
| Docker memory: database, broker, simulator, gateway, MES and web       | Measured in #99; the runbook says to raise the VM                                                                                                                                                                   |
| Broker queue for the persistent session fills during a long MES outage | `max_queued_messages` sized for hours; overflow shows as sequence gaps, which are recorded as incidents                                                                                                             |
