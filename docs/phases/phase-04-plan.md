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

- **One PostgreSQL schema per module** (`master_data`, `ingest`, `equipment`). A module reads and writes only its own schema; other modules call its TypeScript interface (plan section 7). The lint rules of plan section 8 already forbid cross-module imports other than through a module's `index.ts`.
- **Migrations:**
  - plain SQL files `apps/mes-server/migrations/NNNN_<module>_<what>.sql`, applied in order, each in a transaction, by a small runner;
  - the runner records name and checksum in `public.schema_migrations`, and refuses to start if an applied file has changed;
  - they run at start-up, before the server reports ready.

  TimescaleDB DDL is plain SQL anyway. Kysely provides typed queries on hand-written table types, which a test compares with `information_schema`. Details: ADR-0016 (#93).

- **One shift calendar for both sides.** The simulator's calendar (`apps/simulator/src/plant/calendar.ts`) moves into a pure package `@shopfloor/shift-calendar` (Temporal, no I/O), used by both simulator and MES. Shift boundaries in the MES then equal the simulator's by construction, which is what makes the reconciliation exact.
- **Ingest:**
  - **Persistent MQTT session** (`clean: false`, client id `mes-server`, QoS 1): the broker queues messages while the MES is down. Mosquitto's `max_queued_messages` is raised to 100,000 (about 5 hours of the plant at 60×).
  - **Validation:** every message is checked with `parseUnsMessage`; an invalid one is stored in `ingest.rejected_message` with the reason, never dropped silently.
  - **Durable dedup:** device facts go to the hypertable `ingest.equipment_event`, with a unique key on (equipment, epoch, seq); telemetry goes to the hypertable `ingest.telemetry_sample`, with a unique key on (topic, epoch, seq). `INSERT … ON CONFLICT DO NOTHING` makes every delivery idempotent, including across MES restarts. This is ADR-0015's rule, kept in the database.
  - **Gaps:** holes in a device's sequence are recorded in `ingest.data_quality_incident`, after a grace period for late arrivals, as are the gateway's own incidents from `_sys/…/incidents`.
  - **Retained and snapshot messages** update the current state only (`equipment.current_state`); they are not facts and never create intervals.
- **Equipment intervals:**
  - **Fact-driven:** an interval runs from one state change to the next of the same equipment, ordered by (epoch, seq), using the device's `sourceTime` (simulation time; never wall time).
  - **Split at boundaries:** every stored interval lies inside one clock hour and one shift instance, or the gap between shifts. The open (current) interval is closed provisionally at each boundary that the equipment's latest data has passed.
  - **Reorder-safe:** a fact arriving out of order recomputes the intervals of that equipment from the fact's time onward. Recomputing is idempotent, so a duplicate or a replay changes nothing.
- **API and push** (`realtime` module): REST under `/api/v1` (equipment with current state, state intervals, telemetry series), generated OpenAPI in `docs/api/mes.openapi.json` with a drift test, and a WebSocket that pushes state changes and telemetry to subscribed screens.
- **Web:**
  - React 19, Vite 8, TanStack Router and Query, Tailwind 4, uPlot for trends (plan section 6);
  - served by its own container (nginx, static files) that proxies `/api` to `mes-server`;
  - no login yet;
  - shadcn/ui components are added only where a screen needs them.
- **Ground truth in live mode:** the simulator's control API gains the run's ground-truth summary (the headless `GroundTruth`, kept live), so the end-to-end test compares the MES with exactly what the simulator knows.

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

1. **Reconciliation:** for one simulated shift run at 60× through simulator → gateway → broker → MES, the recorded state intervals equal the simulator's ground truth: time per state, per machine, for that shift, to the millisecond. Every stored interval lies inside one hour and one shift.
2. **Duplicates and reordering:** tests deliver duplicates, out-of-order facts, retained messages and an MES restart mid-stream, and the stored events and intervals are unchanged by them.
3. **Live overview at 60×:** a Playwright test sees each machine's state in the browser follow the UNS within 2 s.
4. Integration tests green in CI; `docs/data-model.md` generated from the database.

## Risks for this phase

| Risk                                                                   | Response                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase size L, with a new app and the first UI                          | Strict dependency order; the UI is limited to two screens; shadcn/ui only where needed                                                                                                                              |
| Off-by-one errors at hour and shift boundaries, and around DST         | One shared shift calendar (Temporal, Istanbul); property tests: split intervals sum to the original and never cross a boundary; a reconciliation test over the headless week, which includes the Friday night shift |
| Reordering corrupts intervals                                          | Recompute from the late fact onward, idempotently; tests with shuffled delivery                                                                                                                                     |
| A full shift at 60× takes 8 wall minutes in CI                         | The reconciliation runs as its own CI job, in parallel to `verify`                                                                                                                                                  |
| Docker memory: database, broker, simulator, gateway, MES and web       | Measured in #99; the runbook says to raise the VM                                                                                                                                                                   |
| Broker queue for the persistent session fills during a long MES outage | `max_queued_messages` sized for hours; overflow shows as sequence gaps, which are recorded as incidents                                                                                                             |
