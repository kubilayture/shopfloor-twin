# ADR-0012: Prometheus metrics with prom-client; OpenTelemetry later

- Status: accepted
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
