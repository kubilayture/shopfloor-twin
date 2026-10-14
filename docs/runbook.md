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

`pnpm install` also installs a git pre-commit hook (lefthook) that formats and lints the files you stage. To skip it for one commit in an emergency: `git commit --no-verify`. CI runs the same checks (from #4).

## Run the simulator headless

Runs the plant as fast as possible, with no network servers, and writes an event log and a ground-truth summary (plan section 4).

```bash
pnpm sim:headless --seed 42 --days 7 --out runs/week-42
```

| Option     | Default                     | Meaning                                                                                                                                         |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--seed`   | 1                           | Master seed: the same seed, config and options always give byte-identical output                                                                |
| `--days`   | 7                           | Simulated duration                                                                                                                              |
| `--start`  | `2026-10-12T06:00:00+03:00` | Simulation start, ISO 8601 with an offset or `Z` (a time without an offset is rejected, so the result never depends on the machine's time zone) |
| `--config` | `config/plant`              | Plant configuration directory                                                                                                                   |
| `--out`    | `runs/latest`               | Output directory (`runs/` is git-ignored)                                                                                                       |

Output:

- `events.jsonl`: one JSON object per line. The first line is the run header (`sim-run/1`: seed, start, end, SHA-256 of the configuration); every other line is an event (`sim-event/1`).
- `summary.json`: the ground truth (`sim-summary/1`): time in every state per machine, in total and per shift instance; cycles per result; parts started, finished and scrapped by reason; remaining quantity per lot.

A week takes about 0.2 s and about 6 MB of events. The files are written under temporary names and renamed at the end, so a failed run never leaves a mix of old and new files. Invalid options exit with status 2, other failures with status 1. The event and summary formats are described in `docs/simulation-model.md`.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job           | What it runs                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`      | `pnpm install --frozen-lockfile`, then `pnpm verify` (format check, lint, typecheck, tests)                                           |
| `stack smoke` | Creates a throw-away `.env` with random passwords, runs `scripts/stack-smoke.sh`, prints container logs on failure, removes the stack |

A pull request is merged only when both jobs are green (ADR-0004). If CI fails but `pnpm verify` passes locally, check the Node.js and pnpm versions first: CI uses exactly `.nvmrc` and `packageManager`. A lockfile change that was not committed fails `--frozen-lockfile`.

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
