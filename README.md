# ShopFloor Twin

A deterministic simulation of a discrete-manufacturing plant with an edge gateway, MQTT Unified Namespace and MES core, built in TypeScript.

The project plan is in [docs/project-plan.md](docs/project-plan.md).

## Quick start

Requires Docker with Compose v2 (give its VM 4 GiB of memory), git and a POSIX shell; no Node.js and no pnpm. One command line starts the whole system on a fresh clone:

<!-- quick-start -->

```sh
git clone https://github.com/kubilayture/shopfloor-twin.git
cd shopfloor-twin
sh scripts/stack-init.sh && docker compose up -d --wait
```

<!-- quick-start -->

The first part runs once: `scripts/stack-init.sh` writes `.env` from `.env.example` with a new random value for every password and token (mode 600; it never replaces an existing `.env`, and on a rerun it only checks that every required secret is set and not `change-me`). `docker compose up -d --wait` then builds the images and starts the system, and returns once every service is healthy: PostgreSQL + TimescaleDB (migrated by a one-shot `migrate` step), the Mosquitto MQTT broker, the plant simulator at 60×, the edge gateway, the ERP mock, the MES server and the web app. `pnpm test:fresh-clone` runs exactly this block on a clone of the commit (runbook, "Fresh-clone test").

Every screen needs a login. The web is HTTPS only, with a certificate of the stack's own dev CA: trust that CA once (export it without Node with `docker compose exec -T web cat /etc/nginx/tls/ca.pem > dev-ca.pem`, or `pnpm stack:ca`; runbook "HTTPS and the dev CA"), or accept the browser's warning once. Log in as `admin` at <https://localhost:8443/login> with the password the init printed (or `MES_BOOTSTRAP_ADMIN_PASSWORD` in `.env`), change it as the first login requires, and create users in `/admin/users` (runbook, "Identity"). Then open the plant overview at <https://localhost:8443>, the OEE dashboard at `/oee`, the downtime coding screen at `/downtime`, the alarm list at `/alarms`, the alarm KPIs at `/alarms/kpi`, the shift reports at `/shifts`, the production orders at `/orders` (with each order's OEE and first-pass yield on its detail page), the operator terminal at `/terminal`, the traceability search at `/trace` (serials back to their lots, machines, operators and leak readings; lots and cartons forward), the SPC charts of the leak test at `/quality/spc` and the quality holds at `/quality/holds`, and, as `admin`, the simulation console at `/console` (orders and cartons run when the simulator is in orders mode, `SIM_PRODUCTION=orders`). Give the Docker VM 4 GB of memory (runbook, "Full stack"). To develop (Node.js 26 and pnpm): `pnpm install`, then `pnpm verify` (it needs 25 GiB free on the host and 15 GiB in Docker; runbook, "Merge gate"); `pnpm stack:init` is the init above and `pnpm stack:up` the start. The stack publishes neither the MES, the gateway nor the database; `pnpm stack:up:dev` also publishes them on `127.0.0.1` (4700, 4900, 5442) for development. `pnpm stack:up:observability` adds Prometheus and Grafana on `127.0.0.1` (9090, 3000; set `GRAFANA_ADMIN_PASSWORD` first; runbook, "Observability profile").

Current progress is in [docs/STATUS.md](docs/STATUS.md); operations in [docs/runbook.md](docs/runbook.md); the MES database in [docs/data-model.md](docs/data-model.md) (generated). Each phase has a report in [docs/phases/](docs/phases/) and learning notes in [docs/learning/](docs/learning/); the latest are the [Phase 9 report](docs/phases/phase-09-report.md) and [learning notes](docs/learning/phase-09.md); the security review is [docs/security-review.md](docs/security-review.md).
