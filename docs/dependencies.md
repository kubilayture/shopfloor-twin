# Dependencies

Every third-party dependency and why it exists. A dependency is not added without a row here (plan section 6).

| Package                  | Used in                       | Why                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`             | all packages                  | Type checking (`tsc --noEmit`); Node.js runs the sources directly (ADR-0003)                                                                                                                                                      |
| `turbo`                  | root                          | Runs `typecheck` and `test` per package in dependency order, with caching                                                                                                                                                         |
| `prettier`               | root                          | One formatting style for code, JSON, YAML and Markdown; checked in `pnpm verify`                                                                                                                                                  |
| `vitest`                 | packages with tests           | Unit, property and integration test runner across the monorepo (plan section 9)                                                                                                                                                   |
| `@types/node`            | all packages                  | Types for Node.js built-ins                                                                                                                                                                                                       |
| `eslint`                 | all packages                  | Linter; runs the type-aware rules and the dependency rules of plan section 8                                                                                                                                                      |
| `@eslint/js`             | `eslint-config`               | ESLint's recommended JavaScript rules                                                                                                                                                                                             |
| `typescript-eslint`      | `eslint-config`               | TypeScript parser and type-checked rules (`no-floating-promises`, `no-explicit-any`, …)                                                                                                                                           |
| `eslint-config-prettier` | `eslint-config`               | Turns off lint rules that conflict with Prettier's formatting                                                                                                                                                                     |
| `globals`                | `eslint-config`               | Declares Node.js global variables for ESLint                                                                                                                                                                                      |
| `fast-check`             | `sim-core` (tests)            | Property-based tests: generates thousands of inputs to check invariants such as event ordering (plan section 9)                                                                                                                   |
| `@vitest/coverage-v8`    | packages with coverage floors | Measures test coverage and enforces the floors of plan section 9                                                                                                                                                                  |
| `zod`                    | `plant-config`, `simulator`   | Validates configuration at runtime and gives TypeScript types from the same schema (plan section 6)                                                                                                                               |
| `yaml`                   | `plant-config`                | Reads the YAML files in `config/plant/` (plan section 4: parameters in YAML)                                                                                                                                                      |
| `node-opcua`             | `simulator`                   | OPC UA server per machine (and client in tests); bundles the DI, Machinery and MachineTool companion nodesets (plan section 6, ADR-0008). Pinned to a release at least three days old because it publishes several versions a day |
| `fastify`                | `simulator`                   | HTTP server for the control API (plan section 6: Fastify 5.x); JSON-schema validation of request bodies                                                                                                                           |
| `@fastify/websocket`     | `simulator`                   | WebSocket stream of plant events on the control API (plan section 6)                                                                                                                                                              |
| `@fastify/swagger`       | `simulator`                   | Generates the OpenAPI description from the route schemas; committed in `docs/api/` and checked for drift by a test                                                                                                                |
| `prom-client`            | `simulator`                   | Prometheus `/metrics` endpoint (plan section 8); chosen over the OpenTelemetry SDK for now (ADR-0012)                                                                                                                             |
| `@types/ws`              | `simulator` (types)           | Types for the `ws` sockets that `@fastify/websocket` hands to route handlers                                                                                                                                                      |
| `lefthook`               | root                          | Git pre-commit hook: formats and lints staged files. Its install script is denied in `pnpm-workspace.yaml` (`allowBuilds`); the root `prepare` script installs the hooks instead                                                  |

## Container images

| Image                               | Service  | Why                                                                                                                                                |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timescale/timescaledb:2.30.2-pg18` | `db`     | PostgreSQL 18 with TimescaleDB for MES data and time series (plan section 6). The plain image, not `timescaledb-ha`, which is several times larger |
| `eclipse-mosquitto:2.1.2-alpine`    | `broker` | MQTT broker for the Unified Namespace (plan section 6). Mosquitto 2.1 is published only as Alpine images                                           |

## CI actions

Pinned to a full commit SHA (the tag in the trailing comment), so a moved or compromised tag cannot change what runs. Renovate updates the SHA and the comment together.

| Action                      | Why                                                                |
| --------------------------- | ------------------------------------------------------------------ |
| `actions/checkout` v7.0.1   | Check out the repository                                           |
| `pnpm/action-setup` v6.1.0  | Install the pnpm version from `packageManager` and cache its store |
| `actions/setup-node` v7.1.0 | Install the Node.js version from `.nvmrc`                          |
| `actions/cache` v6.1.0      | Keep Turborepo's task cache between runs                           |

## Services

| Service               | Why                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renovate (GitHub app) | Opens upgrade pull requests on Mondays, at most two at a time, for versions at least three days old; majors are labelled `prio:high` and need an ADR. Config: `renovate.json` |
