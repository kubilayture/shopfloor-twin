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

`pnpm stack:up` builds and starts the whole system and waits until every service is healthy: PostgreSQL + TimescaleDB, the Mosquitto MQTT broker, the plant simulator at 60×, the edge gateway, the MES server and the web app. Open the plant overview at <http://localhost:8080>, the OEE dashboard at `/oee` and the downtime coding screen at `/downtime`. Give the Docker VM 4 GB of memory (runbook, "Full stack").

Current progress is in [docs/STATUS.md](docs/STATUS.md); operations in [docs/runbook.md](docs/runbook.md); the MES database in [docs/data-model.md](docs/data-model.md) (generated). Each phase has a report in [docs/phases/](docs/phases/) and learning notes in [docs/learning/](docs/learning/).
