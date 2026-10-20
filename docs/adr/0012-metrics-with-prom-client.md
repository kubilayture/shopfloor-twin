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
- **The observability profile** (`compose.observability.yml`, profile `observability`, off by default; `pnpm stack:up:observability`; runbook, "Observability profile"):
  - **Prometheus** (`prom/prometheus`, pinned) scrapes every component's `/metrics` every 5 s (`config/prometheus/prometheus.yml`): the MES (`mes:4700`), the gateway (`gateway:4900`), the simulator's control API (`simulator:4800`), the ERP mock (`erp:4600`) and itself. By service name on the project's `default` network, never through a host port: the MES and the gateway stay unpublished (P9-14, ADR-0039). Every `/metrics` is open by design (the control API's token covers every route but health and metrics, #237; the ERP token covers `/api/v1`; the MES's Host and Origin checks cover `/api`), so Prometheus holds no credential. It is not on the `edge` network, so the MES's proxy-header trust (only nginx, ADR-0026 amendment of #237) is unchanged; it sends no `X-Real-IP`. Retention: 3 days or 1 GB, whichever comes first (`PROMETHEUS_RETENTION_TIME`, `PROMETHEUS_RETENTION_SIZE`); admin and lifecycle APIs off (their defaults).
  - **Grafana** (`grafana/grafana`, pinned; not the `-slim` image, which leaves out the Prometheus datasource plugin: its datasource answers "Plugin not registered") with one provisioned datasource, that Prometheus, and nothing else. It is on its own `observability` network with Prometheus only, so it reaches none of the plant's services. Login `admin` with `GRAFANA_ADMIN_PASSWORD`, required by the profile (`:?`, no default), anonymous access and sign-up off, no usage reports, update checks, news or plugin installs. It keeps no state (no volume), so the password is the env's at every start.
  - **Ports:** both on `127.0.0.1` only (`PROMETHEUS_PORT` 9090, `GRAFANA_PORT` 3000; `0` for an ephemeral one). Prometheus's UI has no login, as the `/metrics` endpoints it reads.
  - **Limits:** 0.5 CPU each; 256 MiB for Prometheus, 512 MiB for Grafana. Measured with the stack at 60× (#244): Prometheus 33 MiB anonymous memory, peak 43 MiB, 1,385 series; Grafana 231 MiB anonymous (its page cache on top; peak 502 MiB with the cache), so its first limit of 256 MiB left it at 99 %; no OOM kill.
  - **Secrets:** the default stack needs nothing new: `pnpm stack:up` never reads the file. The stack smoke checks both directions when the env file sets `GRAFANA_ADMIN_PASSWORD` (the gate's does).
- **Grafana dashboards: cut** (the first item of the Phase 9 cut line; recorded as a deviation in the phase log). The profile has no dashboard; the runbook lists the queries for Grafana's Explore or Prometheus's own UI. A provisioned dashboard can be added later under `config/grafana/provisioning/` without changing anything here.
- **Not scraped:** the broker and the database (no exporter: each would be one more container with a credential of its own), nginx. **No cAdvisor** for container CPU and memory: it needs the Docker socket or the host's `/sys` and `/var/lib/docker` mounted (checklist S8 rules out the socket) and costs about as much memory as Prometheus. The performance suite (P9-18) reads the containers' cgroups (`cpu.stat`, `memory.peak`) and `docker inspect` instead, as its plan says; the Node services' `process_*` metrics are in Prometheus.
- **The performance suite** can read this Prometheus (its own project with the profile; `scripts/observability-smoke.ts` shows how to find it) but doesn't need it: its targets are judged from the metrics it reads itself.

### Consequences of the amendment

- Good: one `docker compose` profile gives a time series of every metric of a run, for the performance suite and for diagnosis, with no new secret in the default stack and no new published port by default.
- Good: the scrape path adds no trust: no credential, no `edge` membership, no published MES or gateway port.
- Bad: two more images (357 MB and 1.8 GB unpacked) when the profile is used, and about 270 MiB of anonymous memory with the stack (Grafana most of it).
- Bad: no dashboards: Explore queries instead, until someone needs one.
