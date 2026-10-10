# Dependencies

Every third-party dependency and why it exists. A dependency is not added without a row here (plan section 6).

| Package       | Used in             | Why                                                                              |
| ------------- | ------------------- | -------------------------------------------------------------------------------- |
| `typescript`  | all packages        | Type checking (`tsc --noEmit`); Node.js runs the sources directly (ADR-0003)     |
| `turbo`       | root                | Runs `typecheck` and `test` per package in dependency order, with caching        |
| `prettier`    | root                | One formatting style for code, JSON, YAML and Markdown; checked in `pnpm verify` |
| `vitest`      | packages with tests | Unit, property and integration test runner across the monorepo (plan section 9)  |
| `@types/node` | all packages        | Types for Node.js built-ins                                                      |

## Container images

| Image                               | Service  | Why                                                                                                                                                |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timescale/timescaledb:2.30.2-pg18` | `db`     | PostgreSQL 18 with TimescaleDB for MES data and time series (plan section 6). The plain image, not `timescaledb-ha`, which is several times larger |
| `eclipse-mosquitto:2.1.2-alpine`    | `broker` | MQTT broker for the Unified Namespace (plan section 6). Mosquitto 2.1 is published only as Alpine images                                           |
