# Phase 04 – MES foundation: historian and equipment states: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-15

- Phase 4 planned: issues #92–#101, milestone 5.
  - The simulator's shift calendar becomes a shared package, so that the MES cuts shifts exactly as the simulator does.
  - Ingest keeps ADR-0015's dedup in the database (unique keys) and uses a persistent MQTT session.
