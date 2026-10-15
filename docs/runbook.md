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

`mes-server` (Phase 4) runs on the stack's TimescaleDB and broker (`pnpm stack:up` first), migrates the database at start-up (ADR-0016) and then subscribes to the UNS (#95):

```bash
DATABASE_URL=postgres://shopfloor:<DB_PASSWORD>@127.0.0.1:5442/shopfloor \
  MQTT_PASSWORD=<MQTT_MES_PASSWORD from .env> pnpm --filter @shopfloor/mes-server start
```

- Environment: `DATABASE_URL` (required, never echoed), `MQTT_URL` (`mqtt://127.0.0.1:1883`, never echoed), `MQTT_USERNAME` (`mes`), `MQTT_PASSWORD` (required: `MQTT_MES_PASSWORD` from `.env`), `MQTT_CLIENT_ID` (`mes-server`), `MQTT_SESSION_EXPIRY_S` (604800, 7 days), `INGEST_GAP_GRACE_MS` (30000), `HTTP_HOST` and `HTTP_PORT` (`127.0.0.1:4700`), `MIGRATIONS_DIR` (`db/migrations`), `LOG_LEVEL`.
- `GET /health/live`, `/health/ready` (database answers, migrations are applied, and the UNS subscription is granted) and `/metrics` (`mes_ingest_messages_total{outcome}` with outcomes `stored`, `duplicate`, `rejected`, `anchor`, `status`, `retained`; `mes_ingest_incidents_total{origin}`; `mes_ingest_store_errors_total`; `mes_ingest_suspensions_total`; `mes_ingest_subscribed`).
- The MES keeps a persistent broker session (client id `mes-server`): while it is stopped, the broker queues up to 100,000 messages for it (about one hour of the plant at 60×), delivered on the next start; the MES stores about 1,000 messages/s, so a full queue drains in about two minutes. Only one MES may use the client id; a second one takes the session over. **Accepted risk until Phase 9:** the plain ACL file can't bind a client id to a user, so any broker user (even `dev`) can connect as `mes-server` and take the session, and with it the queued messages. Phase 9 moves to Mosquitto's dynamic-security plugin. To drop the session (and its queue), start once with another `MQTT_CLIENT_ID` or reset the broker volume (`pnpm stack:reset`).
- What arrived: `SELECT reason, count(*) FROM ingest.rejected_message GROUP BY 1;` lists rejected messages; `SELECT * FROM ingest.data_quality_incident WHERE closed_at IS NULL;` lists open gaps and gateway incidents (contract: `docs/contracts/uns.md`, "Consumer: MES ingest").
- A storage failure is logged (`mes_ingest_store_errors_total`). Only a data or integrity error (SQLSTATE classes 22, 23, 54: the database refuses this message for good) is recorded with reason `unstorable` and acknowledged. Any other error (database down, a lock held too long, a migration in progress) is retried for a few seconds; then the MES drops its broker session without acknowledging anything unstored (`mes_ingest_suspensions_total`, readiness 503), waits, reloads its cursors and reconnects, with a growing pause while the failure repeats. The broker queues meanwhile, so an outage shorter than the queue (about an hour) loses nothing (ADR-0017).
- State intervals (#96, ADR-0018): at start-up the `equipment` module compares `equipment.interval_source` with ingest's tables and recomputes what differs (log line `equipment intervals caught up` with the number `rebuilt`), then follows ingest. Every piece lies inside one UTC hour and one shift bucket; the open interval is stored up to the plant watermark and flagged `provisional`. Time per state in a shift: `SELECT equipment, state, sum(end_time - start_time) FROM equipment.equipment_state_interval WHERE shift_key = '2026-10-12/A' GROUP BY 1, 2 ORDER BY 1, 2;` (per epoch after a simulator restart). To recompute everything from ingest's tables, stop the MES, `TRUNCATE equipment.interval_source;` and start it again.
- API (#97, ADR-0019), on `HTTP_HOST:HTTP_PORT` (`127.0.0.1:4700`), read-only, no authentication until Phase 9, no CORS (the web app is served from the same origin, by the `web` container in Compose); errors are problem details (`application/problem+json`). Until the modules have started, `/api/v1/*` answers 503.
  - Environment: `HTTP_ALLOWED_HOSTS` (`localhost,127.0.0.1,[::1]`; `Host` names answered, `*` for any, against DNS rebinding), `HTTP_ALLOWED_ORIGINS` (none; extra origins a WebSocket may connect from besides the MES's own host), `API_DB_POOL_SIZE` (4; the API's own read pool, so reads never hold up ingest), `API_STATEMENT_TIMEOUT_MS` (5000; a read over it answers 503). A 403 with `host not allowed` or `origin not allowed` means the request came through a name or page not on these lists.
  - `GET /api/v1/equipment` and `/api/v1/equipment/{id}`: master data with hierarchy and current state (`current` is null for equipment that never reported).
  - `GET /api/v1/equipment/{id}/intervals?from&to`: state intervals (stored hour and shift pieces merged back, clipped to the range; at most 7 days; when `truncated`, continue with `from=next`).
  - `GET /api/v1/equipment/{id}/telemetry/metrics`, and `/telemetry?metric&from&to&maxPoints`: metrics with units, and series decimated into at most `maxPoints` time buckets (min, max, avg, count; at most 31 days, 8 metrics, 5,000 buckets).
  - `GET /api/v1/shifts/{date}/{shift}/totals?equipment`: time per state in a shift (for example `/api/v1/shifts/2026-10-12/A/totals`).
  - `GET /api/v1/plant`: site and plant clock (watermark of the newest epoch).
  - WebSocket `ws://127.0.0.1:4700/api/v1/ws`: subscribe to `states` and `telemetry:<equipment>`; protocol in `docs/api/realtime.md`. Metrics `mes_ws_clients`, `mes_push_messages_total{type}`, `mes_push_coalesced_total`, `mes_ws_dropped_total{reason}`.
  - Description: `docs/api/mes.openapi.json` (OpenAPI 3.1) and `docs/api/mes-realtime.schema.json`; after changing a route or message, regenerate them with `pnpm --filter @shopfloor/mes-server openapi` (a test fails on drift; `… openapi --check` only compares).
  - Quick look: `curl -s 127.0.0.1:4700/api/v1/equipment | jq '.equipment[] | {id, state: .current.state}'`.
- Migrations only: `DATABASE_URL=… pnpm --filter @shopfloor/mes-server migrate`.
- A new migration is a new file `db/migrations/NNNN_<module>_<what>.sql`. An applied file is never edited: the server refuses to start if one changed. A statement that can't run in a transaction (`CREATE INDEX CONCURRENTLY`) goes into a file marked `-- migrate:no-transaction`, written so that it can be rerun.
- End-to-end tests (`*.e2e.test.ts`) run apart from the others: `pnpm test:e2e`, one at a time; in CI they have their own job. In `mes-server` this is the golden-week reconciliation (a few minutes: the headless simulator's week replayed through ingest into TimescaleDB, in order and shuffled); `pnpm test` reconciles a Friday with its night shift.
- The MES tests start their own TimescaleDB and Mosquitto with Testcontainers (the broker harness is shared with the gateway in `@shopfloor/test-kit/broker`).

## Run the web app

`apps/web` (#98) is the MES's browser app: a plant overview and a machine detail. With the MES running (above):

```bash
pnpm --filter @shopfloor/web dev        # http://127.0.0.1:5173, proxies /api to 127.0.0.1:4700
pnpm --filter @shopfloor/web build      # static files in apps/web/dist
```

- `MES_URL` changes the proxy target. The proxy sends the MES's host (so `HTTP_ALLOWED_HOSTS` keeps its default). For the WebSocket it refuses upgrades whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` (Vite's host check skips proxied upgrades, so this keeps the MES's DNS-rebinding protection), and presents a page served under that loopback name as the MES's origin, so `HTTP_ALLOWED_ORIGINS` is not needed; any other origin is passed on and refused by the MES. Open the app as `localhost` or `127.0.0.1`.
- The header shows the plant clock (simulation time, Istanbul) and the connection: `Live`, `Connecting…` or `Reconnecting…`. Machine states marked **Stale** are from before a lost connection or from an earlier simulator run (not shown while the page first connects).
- A blank overview with `Could not load the equipment` and `Forbidden: host not allowed` means the request reached the MES under a name not in `HTTP_ALLOWED_HOSTS`; a connection stuck at `Reconnecting…` with 403 upgrades in the MES log means the page's origin is not accepted (`HTTP_ALLOWED_ORIGINS`).
- More (screens, test ids, the nginx container): `apps/web/README.md`. In Compose the app runs as service `web` ("Full stack" below).

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

## Full stack (Compose)

Database, broker, simulator, edge gateway, MES server and web app (`docker-compose.yml`).

First time only: create your local secrets file. It is git-ignored; never commit it.

```bash
cp .env.example .env
```

Then replace every `change-me` with a random value of your own, for example from `openssl rand -base64 18`. Passwords must not contain spaces. Change `DB_PORT`, `MQTT_PORT`, `MES_HTTP_PORT` or `WEB_PORT` if another program already uses 5442, 1883, 4700 or 8080. An `.env` from before #99 works unchanged: the MES and web variables have defaults.

| Task                                                                                                                                                                                                                              | Command                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Start (builds the images) and wait until healthy; then open <http://localhost:8080>                                                                                                                                               | `pnpm stack:up`                                                                    |
| Check it works (TimescaleDB, MQTT ACLs, retained messages, simulator ports, gateway ready, all six machines' state in the UNS, MES ready, web app, API and WebSocket through the web, Host and Origin refusals; needs Node.js 26) | `pnpm stack:smoke`                                                                 |
| Stop, keep data                                                                                                                                                                                                                   | `pnpm stack:down`                                                                  |
| Stop and delete all data                                                                                                                                                                                                          | `pnpm stack:reset`                                                                 |
| Status                                                                                                                                                                                                                            | `docker compose ps`                                                                |
| Logs                                                                                                                                                                                                                              | `docker compose logs -f db`, `broker`, `simulator`, `gateway`, `mes` or `web`      |
| SQL shell                                                                                                                                                                                                                         | `docker compose exec db psql -U shopfloor -d shopfloor`                            |
| Watch all MQTT traffic                                                                                                                                                                                                            | `docker compose exec broker mosquitto_sub -u dev -P <MQTT_DEV_PASSWORD> -t '#' -v` |

| Service     | Host address                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`        | `127.0.0.1:5442`                                                                                    | PostgreSQL 18 + TimescaleDB 2.30; database and user `shopfloor`; TimescaleDB telemetry off                                                                                                                                                                                                                                                                                                                                                                                                              |
| `broker`    | `127.0.0.1:1883`                                                                                    | Mosquitto 2.1; anonymous access off; users `dev` (manual testing) and `healthcheck`. Per-client users and topic ACLs arrive in Phase 3                                                                                                                                                                                                                                                                                                                                                                  |
| `simulator` | `127.0.0.1:4800` (control API), `127.0.0.1:4841`–`4845` (OPC UA), `127.0.0.1:5020` (Modbus, WSH-01) | Live mode, built from `apps/simulator/Dockerfile` on every `stack:up` (cached layers make it fast). `SIM_SEED`, `SIM_SPEED`, `SIM_START`, `SIM_AUTOSTART`, `SIM_OPCUA_HOST`, `SIM_CONTROL_PORT` and `SIM_LOG_LEVEL` in `.env`; healthy when `/health/ready` answers                                                                                                                                                                                                                                     |
| `gateway`   | `127.0.0.1:4900` (health, metrics)                                                                  | The edge gateway (`apps/edge-gateway/Dockerfile`), started once broker and simulator are healthy; connects to `simulator` (OPC UA, Modbus) and `broker`. Its store-and-forward buffer and client certificate live in the `gateway-data` volume. `GATEWAY_HTTP_PORT` and `GATEWAY_LOG_LEVEL` in `.env`                                                                                                                                                                                                   |
| `mes`       | `127.0.0.1:4700` (API, WebSocket, health, metrics)                                                  | The MES server (`apps/mes-server/Dockerfile`), started once database and broker are healthy; migrates the database, then subscribes to the UNS as `mes`; healthy when `/health/ready` answers. `MES_HTTP_PORT`, `MES_LOG_LEVEL`, `MES_ALLOWED_HOSTS` (`HTTP_ALLOWED_HOSTS`, default `localhost,127.0.0.1,[::1]`) and `MES_ALLOWED_ORIGINS` (`HTTP_ALLOWED_ORIGINS`, default none) in `.env`; the database password reaches it as `PGPASSWORD`, never inside `DATABASE_URL`, so it needs no URL encoding |
| `web`       | `127.0.0.1:8080`                                                                                    | The web app (`apps/web/Dockerfile`): the Vite build served by nginx, `/api` (REST and WebSocket) proxied to `mes`; started once the MES is healthy. `WEB_PORT` in `.env`. Plant overview at <http://localhost:8080>, a machine at `/equipment/cnc-01`, the API through it at `/api/v1/…`                                                                                                                                                                                                                |

All services listen on `127.0.0.1` only, so nothing is reachable from the network. Inside the Compose network the MES and nginx listen on all interfaces (`0.0.0.0`), which only the other containers reach.

Start order: `db` and `broker` first; `simulator`, then `gateway` (needs broker and simulator); `mes` (needs db and broker); `web` (needs a healthy MES). The gateway does not wait for the MES: the edge must work without it, the MES's broker session is persistent, and the current state of every machine is retained in the UNS, so the overview is complete whenever the MES joins. Only cycles and telemetry published before the MES's very first session (a fresh broker volume) are not stored. The reconciliation of #100 needs the stricter order of the Phase 4 plan (database and broker, MES ready, gateway connected, then the simulator resumed at 06:00): it starts the simulator with `SIM_AUTOSTART=false` and drives the order itself, so the default stack stays as it is. A consequence: every fresh `docker compose up` records one `sequence-gap` incident per machine (the first numbers of each `device:*` stream, about 30 s after start), because the autostarted simulator publishes before the gateway subscribes. That is expected with `SIM_AUTOSTART=true`.

MES and web notes:

- The overview shows `Live` in its header once the WebSocket through nginx is open. `docker compose logs -f mes` shows ingest and the API; health probes are logged only at `warn`.
- `pnpm stack:down` keeps the database and the broker's queue; on the next start the MES catches up from where it stopped (the broker queued the UNS meanwhile).
- `docker compose up -d --build mes web` rebuilds just these two after a code change (`stack:up` rebuilds everything, from cached layers).
- **403 `host not allowed`** (a blank overview with `Could not load the equipment`, or `curl` answers 403): the browser reached the app under a name not in `MES_ALLOWED_HOSTS`. Use `localhost` or `127.0.0.1`, or add the name to `MES_ALLOWED_HOSTS` in `.env` and run `pnpm stack:up` again.
- **Stuck at `Reconnecting…`, 403 upgrades in the MES log (`origin not allowed`):** the page's origin is not the host nginx forwarded. nginx must send `Host $http_host` (with the port, `apps/web/nginx/default.conf`); a page served from elsewhere needs its origin in `MES_ALLOWED_ORIGINS`.
- **502 from `/api/`:** the MES is down or restarting (`docker compose ps mes`); nginx finds a recreated MES again within 10 s.

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
- **Memory:** measured with the full stack at 60× (#99, Colima VM with 2 GiB and 2 CPUs, the web app's detail screen open, `docker stats` every 12 s for 4 minutes, maximum):

  | Service   | Memory  | Limit                         | Image   |
  | --------- | ------- | ----------------------------- | ------- |
  | db        | 61 MiB  | none (tuned for 512 MB)       | 1.45 GB |
  | broker    | 4 MiB   | none                          | 43 MB   |
  | simulator | 190 MiB | 512 MiB                       | 389 MB  |
  | gateway   | 94 MiB  | 384 MiB                       | 398 MB  |
  | mes       | 79 MiB  | 512 MiB                       | 314 MB  |
  | web       | 9 MiB   | 64 MiB                        | 94 MB   |
  | **Total** | 437 MiB | 1.5 GiB + db's tuning (2 GiB) |         |

  The database grows towards its 512 MB tuning as data and queries grow, and `pnpm test` and `pnpm test:e2e` start their own TimescaleDB and Mosquitto containers through Testcontainers beside the stack. The stack fits a 2 GiB VM today, but with little room: give the Docker VM **4 GiB** (Colima: `colima stop && colima start --memory 4 --cpu 2`; Docker Desktop: Settings → Resources). Containers that hit their limit are killed (`docker compose ps` shows the restart, `docker inspect <container> --format '{{.State.OOMKilled}}'`).
