# Architecture decision records

Format and rules: [ADR-0001](0001-record-architecture-decisions.md). New records start from [template.md](template.md).

| #                                                                  | Title                                                                                   | Status             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------ |
| [0001](0001-record-architecture-decisions.md)                      | Record architecture decisions                                                           | accepted           |
| [0002](0002-stack-and-versions.md)                                 | Stack and versions                                                                      | accepted           |
| [0003](0003-monorepo-layout.md)                                    | Monorepo layout and TypeScript without a build step                                     | accepted           |
| [0004](0004-review-and-merge-without-branch-protection.md)         | Review and merge without branch protection                                              | superseded by 0011 |
| [0005](0005-dependency-rules-with-no-restricted-imports.md)        | Enforce dependency rules with no-restricted-imports                                     | accepted           |
| [0006](0006-simulation-time.md)                                    | Simulation time as integer milliseconds                                                 | accepted           |
| [0007](0007-random-streams.md)                                     | Random streams with xoshiro128** derived per entity key                                 | accepted           |
| [0011](0011-claude-merges-after-independent-review.md)             | Claude merges after an independent review                                               | accepted           |
| [0008](0008-opcua-address-space-model.md)                          | OPC UA address space: companion types plus a project namespace                          | accepted           |
| [0009](0009-lossless-opcua-delivery.md)                            | Lossless OPC UA delivery: events with sequence numbers                                  | accepted           |
| [0010](0010-alarms-as-state-variables-and-events.md)               | Alarms on the device as state variables and events; lifecycle in the MES                | accepted           |
| [0012](0012-metrics-with-prom-client.md)                           | Prometheus metrics with prom-client; OpenTelemetry later                                | accepted           |
| [0013](0013-modbus-serial-for-modbus-tcp.md)                       | `modbus-serial` for Modbus TCP, server and client                                       | accepted           |
| [0014](0014-store-and-forward-in-sqlite.md)                        | Store-and-forward buffer in SQLite through `node:sqlite`                                | accepted           |
| [0015](0015-uns-identity-epochs-and-dedup.md)                      | UNS message identity: sequence scopes, epochs and dedup                                 | accepted           |
| [0016](0016-sql-migrations-and-module-schemas.md)                  | Plain SQL migrations, one PostgreSQL schema per MES module                              | accepted           |
| [0017](0017-mes-ingest-acks-anchors-and-gaps.md)                   | MES ingest: acknowledge after commit, snapshot anchors, gap incidents                   | accepted           |
| [0018](0018-equipment-intervals-provisional-and-catch-up.md)       | Equipment intervals: provisional storage, watermark sources and catch-up                | accepted           |
| [0019](0019-mes-api-decimation-and-push-backpressure.md)           | MES API: zod routes with generated OpenAPI 3.1, time-bucket decimation, coalescing push | accepted           |
| [0020](0020-web-shared-api-schemas-code-routes-live-cache.md)      | Web app: shared zod API schemas, code-based routes, pushed states in the query cache    | accepted           |
| [0021](0021-oee-definitions-exact-arithmetic-and-micro-stops.md)   | OEE definitions, exact arithmetic and the micro-stop threshold                          | accepted           |
| [0022](0022-hourly-aggregates-refreshed-explicitly.md)             | Hourly continuous aggregates, refreshed explicitly by their owning modules              | accepted           |
| [0023](0023-guarded-writes-before-identity.md)                     | Guarded, audited writes before identity                                                 | accepted           |
| [0024](0024-alarm-kpis-definitions-and-pure-package-imports.md)    | Alarm KPI definitions, exact arithmetic and pure-package imports                        | accepted           |
| [0025](0025-shift-instances-report-finality-and-handover-notes.md) | Shift instances, report finality, composite revision and handover notes                 | accepted           |
| [0028](0028-erp-mock-rest-feed-and-idempotent-messages.md)         | ERP mock: a REST change feed pulled by the MES, idempotent messages in SQLite           | accepted           |
