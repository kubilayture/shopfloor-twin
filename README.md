# ShopFloor Twin

A deterministic simulation of a discrete-manufacturing plant with an edge gateway, MQTT Unified Namespace and MES core, built in TypeScript.

The project plan is in [docs/project-plan.md](docs/project-plan.md).

## Quick start

Requires Node.js 26, pnpm and Docker.

```bash
pnpm install
pnpm verify
cp .env.example .env   # then set your own passwords
pnpm stack:up
```

`pnpm stack:up` builds and starts the whole system and waits until every service is healthy: PostgreSQL + TimescaleDB (migrated by a one-shot `migrate` step), the Mosquitto MQTT broker, the plant simulator at 60×, the edge gateway, the ERP mock, the MES server and the web app. Every screen needs a login: set `MES_BOOTSTRAP_ADMIN_PASSWORD` in `.env` before `pnpm stack:up`, then trust the stack's dev CA once (`pnpm stack:ca` prints how; the web is HTTPS only since #241, runbook "HTTPS and the dev CA"), log in as `admin` at <https://localhost:8443/login>, change the password as the first login requires, and create users in `/admin/users` (runbook, "Identity"). Then open the plant overview at <https://localhost:8443>, the OEE dashboard at `/oee`, the downtime coding screen at `/downtime`, the alarm list at `/alarms`, the alarm KPIs at `/alarms/kpi`, the shift reports at `/shifts`, the production orders at `/orders` (with each order's OEE and first-pass yield on its detail page), the operator terminal at `/terminal`, the traceability search at `/trace` (serials back to their lots, machines, operators and leak readings; lots and cartons forward), the SPC charts of the leak test at `/quality/spc` and the quality holds at `/quality/holds`, and, as `admin`, the simulation console at `/console` (orders and cartons run when the simulator is in orders mode, `SIM_PRODUCTION=orders`). Give the Docker VM 4 GB of memory (runbook, "Full stack"). `pnpm stack:up` publishes neither the MES, the gateway nor the database; `pnpm stack:up:dev` also publishes them on `127.0.0.1` (4700, 4900, 5442) for development. `pnpm stack:up:observability` adds Prometheus and Grafana on `127.0.0.1` (9090, 3000; set `GRAFANA_ADMIN_PASSWORD` first; runbook, "Observability profile").

Current progress is in [docs/STATUS.md](docs/STATUS.md); operations in [docs/runbook.md](docs/runbook.md); the MES database in [docs/data-model.md](docs/data-model.md) (generated). Each phase has a report in [docs/phases/](docs/phases/) and learning notes in [docs/learning/](docs/learning/); the latest are the [Phase 9 report](docs/phases/phase-09-report.md) and [learning notes](docs/learning/phase-09.md); the security review is [docs/security-review.md](docs/security-review.md).
