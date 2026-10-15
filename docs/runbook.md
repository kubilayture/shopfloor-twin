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

## Run the simulator live

Runs the plant paced to wall time × speed and prints every machine state change:

```bash
pnpm sim:live --speed 60
```

Options: `--seed` (default 1), `--speed` (0.5–60, default 60), `--start` (ISO 8601 with an offset), `--config`. Ctrl+C stops it. At 60×, one shift (8 h) takes 8 minutes. For pause, resume, step and speed control, use `pnpm sim:serve` and its control API.

## Serve the plant: OPC UA and the control API

Runs the plant live and exposes the five OPC UA machines (contract: `docs/contracts/opcua-address-space.md`), the WSH-01 washer on Modbus TCP port 5020 (contract: `docs/contracts/modbus-register-map.md`) and the control API (contract: `docs/contracts/simulator-control-api.md`):

```bash
pnpm sim:serve
```

Configuration comes from environment variables, validated at start-up. Examples: `SIM_SPEED=30`, `SIM_SEED=7`, `SIM_AUTOSTART=false`, `OPCUA_PORT_OFFSET=100`, `CONTROL_PORT=4800`. The full list is in the contract.

```bash
SIM_SPEED=30 SIM_AUTOSTART=false pnpm sim:serve
```

Control the run from another terminal:

```bash
curl -s -X POST localhost:4800/api/v1/resume
```

The other commands are `POST /api/v1/pause`, `POST /api/v1/step`, `PUT /api/v1/speed` with a JSON body `{"speed": 10}`, and `GET /api/v1/status`. Plant events stream over a WebSocket at `ws://localhost:4800/api/v1/events`; health is at `/health/live` and `/health/ready`, and metrics at `/metrics`.

- Connect any OPC UA client, for example UaExpert, with security mode None. Read the washer with any Modbus TCP client, unit id 1, holding registers (function 3).
- `curl -s -X POST localhost:4800/api/v1/faults/modbus -H 'content-type: application/json' -d '{"silent": true}'` makes the washer stop answering, to exercise a poller.
- Each server creates its own certificate on first start in `./.pki/<machine>` (git-ignored).
- Logs are JSON lines (pino). `LOG_LEVEL=warn` keeps only warnings and errors.
- Ctrl+C or SIGTERM stops the run, closes the API and shuts the servers down. An invalid environment exits with status 2.
- After changing a route, regenerate the OpenAPI description with `pnpm --filter @shopfloor/simulator openapi`. A test fails while it is out of date.

## Run the edge gateway

The gateway publishes to the broker of the stack (`pnpm stack:up` first). It subscribes to the five OPC UA machines (the simulator of the stack, or `pnpm sim:serve`) and polls the WSH-01 washer over Modbus TCP, and publishes their state, cycles, alarms and telemetry to the UNS.

```bash
MQTT_PASSWORD=<MQTT_GATEWAY_PASSWORD from .env> pnpm --filter @shopfloor/edge-gateway start
```

- Environment: `GATEWAY_ID` (default `gw-01`), `MQTT_URL` (`mqtt://127.0.0.1:1883`), `MQTT_USERNAME` (`gw-01`), `MQTT_PASSWORD` (required), `OPCUA_HOST` (`localhost`), `OPCUA_PORT_OFFSET` (0), `OPCUA_PKI_DIR` (`.pki-gateway`, its own client certificate), `TELEMETRY_SAMPLING_MS` (1000), `MODBUS_HOST` (`127.0.0.1`), `MODBUS_PORT` (5020), `MODBUS_POLL_MS` (250), `BUFFER_PATH` (`.buffer/gateway.db`, the store-and-forward file), `BUFFER_MAX_MESSAGES` (200000), `HTTP_HOST` and `HTTP_PORT` (`127.0.0.1:4900`), `PLANT_CONFIG_DIR`, `LOG_LEVEL`. An invalid environment exits with status 2, and secrets are never echoed.
- `GET /health/live`, `/health/ready` (ready while the broker session is up) and `/metrics` (`gateway_device_connected{machine}`, `gateway_device_facts{machine}`, `gateway_published_messages`, `gateway_buffer_messages`, `gateway_buffer_dropped_messages`).
- While the broker is down, `gateway_buffer_messages` grows; it drains after the broker returns. Deleting `.buffer/` throws away whatever wasn't delivered yet.
- Data-quality incidents (sequence gaps, disconnects) go to `orbis/gebze/_sys/edge-gateway/gw-01/incidents` and to the log at `warn`.
- Try a disconnect: `curl -s -X POST localhost:4800/api/v1/faults/opcua/cnc-01 -H 'content-type: application/json' -d '{"offline": true}'`, then `{"offline": false}`. The washer: `curl -s -X POST localhost:4800/api/v1/faults/modbus -H 'content-type: application/json' -d '{"silent": true}'`.
- Watch the status: `docker compose exec broker mosquitto_sub -u dev -P <MQTT_DEV_PASSWORD> -t 'orbis/gebze/_sys/#' -v`.

The gateway's tests start a real Mosquitto with Testcontainers, so Docker must be running. They also start the simulator as a child process on ports clear of the stack: OPC UA 7941–7945, Modbus 8120, control 7900. Without `DOCKER_HOST` the tests use the active `docker context`, which covers Colima and similar setups.

## Run the MES server

`mes-server` (Phase 4) runs on the stack's TimescaleDB (`pnpm stack:up` first) and migrates the database at start-up (ADR-0016):

```bash
DATABASE_URL=postgres://shopfloor:<DB_PASSWORD>@127.0.0.1:5442/shopfloor pnpm --filter @shopfloor/mes-server start
```

- Environment: `DATABASE_URL` (required, never echoed), `HTTP_HOST` and `HTTP_PORT` (`127.0.0.1:4700`), `MIGRATIONS_DIR` (`db/migrations`), `PLANT_CONFIG_DIR`, `LOG_LEVEL`.
- `GET /health/live`, `/health/ready` (database answers and migrations are applied) and `/metrics`.
- Migrations only: `DATABASE_URL=… pnpm --filter @shopfloor/mes-server migrate`.
- A new migration is a new file `db/migrations/NNNN_<module>_<what>.sql`. An applied file is never edited: the server refuses to start if one changed.
- The MES tests start their own TimescaleDB with Testcontainers.

## Golden scenarios

A golden scenario is a fixed seed and configuration whose expected output is committed (plan section 9). Each one lives in `apps/simulator/golden/<name>/`:

- `scenario.json`: seed, start, number of days, configuration directory;
- `summary.json`: the expected ground-truth summary, byte for byte;
- `events.sha256`: the SHA-256 and line count of the expected event log. The log itself (about 6 MB per week) is not committed; its hash pins every byte.

| Task                                           | Command                     |
| ---------------------------------------------- | --------------------------- |
| Check every scenario against its snapshot      | `pnpm test:golden`          |
| Rewrite the snapshots after an intended change | `pnpm test:golden --update` |

Each run also checks the conservation and time-accounting invariants after every simulation step, and fails on the first violation. `pnpm verify` (and the pre-commit hook) does not compare snapshots, to stay fast; CI runs `pnpm test:golden` on every pull request.

**When a snapshot changes:** any change to the plant model, its random draws or the default configuration changes the snapshot. That is the point. Run `--update` only when the change is intended, and explain in the pull request what changed in the simulated behaviour and why (plan section 9). The diff of `summary.json` shows the effect in numbers.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job           | What it runs                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`      | `pnpm install --frozen-lockfile`, then `pnpm verify` (format check, lint, typecheck, tests), then `pnpm test:golden`                  |
| `stack smoke` | Creates a throw-away `.env` with random passwords, runs `scripts/stack-smoke.sh`, prints container logs on failure, removes the stack |

A pull request is merged only when both jobs are green on its latest commit (ADR-0011). If CI fails but `pnpm verify` passes locally, check the Node.js and pnpm versions first: CI uses exactly `.nvmrc` and `packageManager`. A lockfile change that was not committed fails `--frozen-lockfile`.

## Infrastructure stack (database, broker, simulator)

First time only: create your local secrets file. It is git-ignored; never commit it.

```bash
cp .env.example .env
```

Then replace every `change-me` with a random value of your own, for example from `openssl rand -base64 18`. Passwords must not contain spaces. Change `DB_PORT` or `MQTT_PORT` if another program already uses 5442 or 1883.

| Task                                                                                                                           | Command                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Start and wait until healthy                                                                                                   | `pnpm stack:up`                                                                    |
| Check it works (TimescaleDB, MQTT ACLs, retained messages, simulator ports, gateway ready, all six machines' state in the UNS) | `pnpm stack:smoke`                                                                 |
| Stop, keep data                                                                                                                | `pnpm stack:down`                                                                  |
| Stop and delete all data                                                                                                       | `pnpm stack:reset`                                                                 |
| Status                                                                                                                         | `docker compose ps`                                                                |
| Logs                                                                                                                           | `docker compose logs -f db`, `broker` or `simulator`                               |
| SQL shell                                                                                                                      | `docker compose exec db psql -U shopfloor -d shopfloor`                            |
| Watch all MQTT traffic                                                                                                         | `docker compose exec broker mosquitto_sub -u dev -P <MQTT_DEV_PASSWORD> -t '#' -v` |

| Service     | Host address                                                                                        | Notes                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`        | `127.0.0.1:5442`                                                                                    | PostgreSQL 18 + TimescaleDB 2.30; database and user `shopfloor`; TimescaleDB telemetry off                                                                                                                                                                                                            |
| `broker`    | `127.0.0.1:1883`                                                                                    | Mosquitto 2.1; anonymous access off; users `dev` (manual testing) and `healthcheck`. Per-client users and topic ACLs arrive in Phase 3                                                                                                                                                                |
| `simulator` | `127.0.0.1:4800` (control API), `127.0.0.1:4841`–`4845` (OPC UA), `127.0.0.1:5020` (Modbus, WSH-01) | Live mode, built from `apps/simulator/Dockerfile` on every `stack:up` (cached layers make it fast). `SIM_SEED`, `SIM_SPEED`, `SIM_START`, `SIM_AUTOSTART`, `SIM_OPCUA_HOST`, `SIM_CONTROL_PORT` and `SIM_LOG_LEVEL` in `.env`; healthy when `/health/ready` answers                                   |
| `gateway`   | `127.0.0.1:4900` (health, metrics)                                                                  | The edge gateway (`apps/edge-gateway/Dockerfile`), started once broker and simulator are healthy; connects to `simulator` (OPC UA, Modbus) and `broker`. Its store-and-forward buffer and client certificate live in the `gateway-data` volume. `GATEWAY_HTTP_PORT` and `GATEWAY_LOG_LEVEL` in `.env` |

All services listen on `127.0.0.1` only, so nothing is reachable from the network.

Simulator notes:

- The OPC UA servers advertise `localhost` in their endpoint URLs (`SIM_OPCUA_HOST` changes it), so clients on the host, such as UaExpert, connect as with `pnpm sim:serve`. Containers that join in Phase 3 connect to `opc.tcp://simulator:4841` and must use that URL as given (in node-opcua, `endpointMustExist: false`).
- Certificates persist in the `simulator-pki` volume; `pnpm stack:reset` deletes them. The container's host name is fixed to `simulator`, so the certificate's SAN stays valid when the container is recreated.
- `pnpm stack:smoke` expects the simulator to be running, so it fails with `SIM_AUTOSTART=false`.
- Health probes and metric scrapes are logged only at `warn` and above.
- `docker compose stop simulator` sends SIGTERM; the simulator shuts down in well under a second.
- Gateway, measured the same way: image 398 MB (node-opcua again), about 95 MiB memory and 4% CPU at 60×, under a limit of 384 MB.
- Watch the whole UNS: `docker compose exec broker mosquitto_sub -u dev -P <MQTT_DEV_PASSWORD> -t 'orbis/#' -v`.
- Measured on the reference machine (M3, Docker Desktop 2 GB VM) at 60×:
  - image 388 MB, mostly `node-opcua` and its nodesets;
  - healthy about 6 s after start;
  - about 170–225 MiB memory and about 1% CPU, under a limit of 512 MB and one CPU.

### Troubleshooting

- **A port is already in use:** set `DB_PORT`, `MQTT_PORT` or `SIM_CONTROL_PORT` in `.env` (the OPC UA ports 4841–4845 are fixed by the contract) and run `pnpm stack:up` again.
- **`Set DB_PASSWORD in .env`:** `.env` is missing or incomplete; see the first step above.
- **Broker users changed:** the password file is rebuilt from `.env` on every broker start; restart with `docker compose restart broker`.
- **Debugging MQTT connections:** set `connection_messages true` in `config/mosquitto/mosquitto.conf` (off by default because the healthcheck connects every 5 seconds) and restart the broker.
- **Memory:** Docker Desktop on this machine has a 2 GB VM; the database is tuned for 512 MB (`DB_TUNE_MEMORY`). The simulator adds up to 512 MB. Raise Docker Desktop's memory before Phase 4, when the MES container joins.
