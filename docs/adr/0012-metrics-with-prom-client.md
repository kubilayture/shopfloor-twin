# ADR-0012: Prometheus metrics with prom-client; OpenTelemetry later

- Status: accepted; amended 2026-10-20 by #244 (P9-17: `prom-client` stays, no OpenTelemetry tracing in v1, the observability profile), below
- Date: 2026-10-15
- Deciders: Claude (#54); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Plan section 6 names "OpenTelemetry SDK, Prometheus endpoint" for metrics and tracing. Plan section 8 says every service exposes `/metrics`. The simulator's control API (#54) is the first service that needs `/metrics`. What should produce it?

## Considered options

1. OpenTelemetry metrics SDK with the Prometheus exporter.
2. `prom-client`, the Prometheus client for Node.js, with its own registry per service.

## Decision outcome

Chosen option: 2, `prom-client`, for metrics now. OpenTelemetry is reconsidered for tracing in Phase 9, when the Grafana profile arrives.

- What is needed today is a Prometheus text endpoint with a few gauges and counters and the standard process metrics. `prom-client` does exactly that in one dependency, with no SDK or exporter set-up.
- The OpenTelemetry Prometheus exporter adds several packages and runs its own HTTP server by default, or needs adapting to Fastify. Its benefit, one API for metrics and traces, matters only once traces exist.
- Metric names follow the Prometheus conventions (base units, `_total` for counters), so moving to OpenTelemetry later doesn't change what Prometheus scrapes.

### Consequences

- Good: `/metrics` is small and testable: each app has its own `Registry`, so tests create several apps in one process.
- Good: a plan deviation is written down, not silent.
- Bad: if tracing arrives in Phase 9, metrics may move to the OpenTelemetry SDK to share resources and exporters. That is a contained change behind `createMetrics`.

## Amendment (#244, P9-17): `prom-client` stays; no OpenTelemetry tracing in v1; the observability profile

Phase 9 reconsidered tracing as this ADR said it would (plan, decisions table "Tracing"). Decision:

- **Metrics stay on `prom-client`**, one `Registry` per service, unchanged. **No OpenTelemetry SDK, metrics or tracing, in v1.** A trace would follow one message from the device through the gateway, the broker and the MES, but the questions Phase 9 asks (ingest lag, pending messages, derived-work timings, resources) are answered by histograms and gauges, and the SDK would add several packages, an exporter and a collector to the 2 GiB VM for no target that needs it. Reconsidered after v1 if a question needs a per-message trace.
- **The observability profile** (`compose.observability.yml`, off by default; runbook, "Observability profile"). Two Compose profiles: `observability` is Prometheus, `grafana` is Grafana on top of it. `pnpm stack:up:observability` starts both; **the performance suite (P9-18) starts Prometheus only** (`--profile observability`), so Grafana's memory (peak 502 of its 512 MiB with page cache) never meets T5's "below 80 % of each limit".
  - **Prometheus** (`prom/prometheus`, pinned) scrapes every component's `/metrics` every 5 s (`config/prometheus/prometheus.yml`): the MES (`mes:4700`), the gateway (`gateway:4900`), the simulator's control API (`simulator:4800`), the ERP mock (`erp:4600`) and itself. By service name on the project's `default` network, never through a host port: the MES and the gateway stay unpublished (P9-14, ADR-0039). Every `/metrics` is open by design (the control API's token covers every route but health and metrics, #237; the ERP token covers `/api/v1`; the MES's Host and Origin checks cover `/api`), so Prometheus holds no credential. It is not on the `edge` network, so the MES's proxy-header trust (only nginx, ADR-0026 amendment of #237) is unchanged; it sends no `X-Real-IP`. Admin and lifecycle APIs off (their defaults).
  - **No CORS on Prometheus:** its default `--web.cors.origin` is `.*`, which let any web page the owner opens read every metric, the unpublished MES's and gateway's included. The flag is set to a fully anchored class that matches no character, so no origin is allowed; its own UI is same-origin. **Residual risk, accepted:** Prometheus has no Host check, so a DNS-rebinding page could still read its API. What it reads is metrics: read-only, no secrets, no write path (admin and lifecycle APIs off).
  - **Retention:** 3 days or 1 GB, whichever comes first (`PROMETHEUS_RETENTION_TIME`, `PROMETHEUS_RETENTION_SIZE`). Prometheus reads "GB" as GiB, and the size limit covers the blocks; the write-ahead log can take it a little over.
  - **Grafana** (`grafana/grafana`, pinned; not the `-slim` image, which leaves out the Prometheus datasource plugin: its datasource answers "Plugin not registered") with one provisioned datasource, that Prometheus, and nothing else. Login `admin` with `GRAFANA_ADMIN_PASSWORD`, required by the `grafana` profile (`:?`, no default); anonymous access and sign-up off. Off as well: usage reports, update checks, news, plugin preinstall, the plugin admin (installs from the UI), plugin signature-key downloads, external snapshots, public dashboards, unified alerting and Grafana's own `/metrics`. Its datasource proxy is allowed `prometheus:9090` only (`GF_SECURITY_DATA_SOURCE_PROXY_WHITELIST`). Its database (users, sessions, API tokens, anything saved in the UI) is on a tmpfs owned by its user 472, so the password is the env's on every start and a restart ends every session and token.
  - **Grafana's network, an accepted risk:** it is on its own `observability` network with Prometheus only, so it has no route to the plant's containers by name. That network is not `internal`: an internal network can't publish a port. So Grafana's container can reach the Docker host (with Colima, the services the Mac publishes on `127.0.0.1`: the plant's ports, other projects' databases) and the internet. Accepted because the only Grafana user is `admin` with a random password on `127.0.0.1`, and the outgoing features above are off; an admin could still add a datasource of their own pointing at one of those addresses; the proxy allow-list covers Grafana's data source proxy route, not necessarily every backend query path, so it narrows that but is not counted on.
  - **Ports:** both on `127.0.0.1` only (`PROMETHEUS_PORT` 9090, `GRAFANA_PORT` 3000; `0` for an ephemeral one). Prometheus's UI has no login, as the `/metrics` endpoints it reads. ADR-0039's accepted risk of the `__Host-` cookie on `localhost` (other ports of the name) now covers 3000 and 9090 too: the browser sends the MES's cookie to them as to any `localhost` port; neither reads it (ADR-0039 note).
  - **Limits:** 0.5 CPU each; 256 MiB for Prometheus, 512 MiB for Grafana. Measured with the stack at 60× (#244): Prometheus 33 MiB anonymous memory, peak 43 MiB, 1,385 series; Grafana 231 MiB anonymous (its page cache on top; peak 502 MiB with the cache), so its first limit of 256 MiB left it at 99 %; no OOM kill.
  - **Secrets:** the default stack needs nothing new: `pnpm stack:up` never reads the file. Loading `compose.observability.yml` needs `GRAFANA_ADMIN_PASSWORD` even for Prometheus alone: Compose interpolates every service of a file it loads, inactive profiles included (checked: `config` and `up` refuse, only `ps` doesn't). The performance suite's env, generated from `.env.example` like the gate's, has it. The stack smoke checks both directions when the env file sets it (the gate's does).
- **Grafana dashboards: cut** (the first item of the Phase 9 cut line; recorded as a deviation in the phase log). The profile has no dashboard; the runbook lists the queries for Grafana's Explore or Prometheus's own UI. A provisioned dashboard can be added later under `config/grafana/provisioning/` without changing anything here.
- **Not scraped:** the broker and the database (no exporter: each would be one more container with a credential of its own), nginx. **No cAdvisor** for container CPU and memory: it needs the Docker socket or the host's `/sys` and `/var/lib/docker` mounted (checklist S8 rules out the socket) and costs about as much memory as Prometheus. The performance suite (P9-18) reads the containers' cgroups (`cpu.stat`, `memory.peak`) and `docker inspect` instead, as its plan says. The simulator's, gateway's and MES's `process_*` metrics are in Prometheus (resident memory, not the cgroup's `memory.peak`); the ERP mock has none.
- **For the performance suite (P9-18):** it can read this Prometheus but doesn't need it: its targets are judged from what it measures itself. If it uses it: start Prometheus only (`--profile observability`), and at the end `down --volumes` **with `compose.observability.yml` loaded** (otherwise `prometheus-data` and the `observability` network stay behind) and remove both images (`prom/prometheus`, and `grafana/grafana` if pulled). `scripts/observability-smoke.ts` shows how to find the published port.

### Consequences of the amendment

- Good: one `docker compose` profile gives a time series of every metric of a run, for the performance suite and for diagnosis, with no new secret in the default stack and no new published port by default.
- Good: the scrape path adds no trust: no credential, no `edge` membership, no published MES or gateway port, no CORS.
- Bad: two more images (357 MB and 1.8 GB unpacked) when the profile is used, and about 270 MiB of anonymous memory with the stack (Grafana most of it).
- Bad: Grafana's container has a route to the host and the internet (accepted, above), and Prometheus's API is open to a DNS-rebinding page (read-only metrics, accepted).
- Bad: no dashboards: Explore queries instead, until someone needs one.
