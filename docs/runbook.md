# Runbook

How to start, stop and reset the system and run scenarios. Updated whenever operations change.

## Prerequisites

- Node.js 26 (`nvm use` reads `.nvmrc`)
- pnpm 11 or newer installed globally; it switches itself to the version pinned in `package.json`
- Docker with Compose

## Check the workspace

```bash
pnpm install
pnpm verify
```

## Infrastructure stack (database and broker)

First time only: create your local secrets file. It is git-ignored; never commit it.

```bash
cp .env.example .env
```

Then replace every `change-me` with a random value of your own, for example from `openssl rand -base64 18`. Passwords must not contain spaces. Change `DB_PORT` or `MQTT_PORT` if another program already uses 5442 or 1883.

| Task                                                                                                     | Command                                                                            |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Start and wait until healthy                                                                             | `pnpm stack:up`                                                                    |
| Check it works (TimescaleDB present, anonymous MQTT refused, retained messages survive a broker restart) | `pnpm stack:smoke`                                                                 |
| Stop, keep data                                                                                          | `pnpm stack:down`                                                                  |
| Stop and delete all data                                                                                 | `pnpm stack:reset`                                                                 |
| Status                                                                                                   | `docker compose ps`                                                                |
| Logs                                                                                                     | `docker compose logs -f db` or `broker`                                            |
| SQL shell                                                                                                | `docker compose exec db psql -U shopfloor -d shopfloor`                            |
| Watch all MQTT traffic                                                                                   | `docker compose exec broker mosquitto_sub -u dev -P <MQTT_DEV_PASSWORD> -t '#' -v` |

| Service  | Host address     | Notes                                                                                                                                  |
| -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `db`     | `127.0.0.1:5442` | PostgreSQL 18 + TimescaleDB 2.30; database and user `shopfloor`; TimescaleDB telemetry off                                             |
| `broker` | `127.0.0.1:1883` | Mosquitto 2.1; anonymous access off; users `dev` (manual testing) and `healthcheck`. Per-client users and topic ACLs arrive in Phase 3 |

Both services listen on `127.0.0.1` only, so nothing is reachable from the network.

### Troubleshooting

- **A port is already in use:** set `DB_PORT` or `MQTT_PORT` in `.env` and run `pnpm stack:up` again.
- **`Set DB_PASSWORD in .env`:** `.env` is missing or incomplete; see the first step above.
- **Broker users changed:** the password file is rebuilt from `.env` on every broker start; restart with `docker compose restart broker`.
- **Debugging MQTT connections:** set `connection_messages true` in `config/mosquitto/mosquitto.conf` (off by default because the healthcheck connects every 5 seconds) and restart the broker.
- **Memory:** Docker Desktop on this machine has a 2 GB VM; the database is tuned for 512 MB (`DB_TUNE_MEMORY`). Raise Docker Desktop's memory before Phase 4, when the MES and simulator containers join.
