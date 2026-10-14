# Phase 02 – Device layer: OPC UA: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-15

- Phase 2 planned: issues #46–#57. node-opcua 2.187.x bundles the DI, Machinery and MachineTool nodesets; the spike (#47) decides whether to instantiate them.
- Owner decision: Claude merges pull requests permanently, after an independent review agent and a green CI. Recorded as ADR-0011 and plan rev. 6, which supersede ADR-0004's merge rule.
- Merged #58 (#46): Phase 2 plan and ADR-0011.
- Spike #47: with default settings node-opcua loses 70–90% of short state changes (sampling 0 is revised to 50 ms). Lossless with `minSupportedSampleRate: 0` and exception-based items, or with events; ADR-0009 chooses events with sequence numbers.
