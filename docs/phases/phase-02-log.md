# Phase 02 – Device layer: OPC UA: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-15

- Phase 2 planned: issues #46–#57. node-opcua 2.187.x bundles the DI, Machinery and MachineTool nodesets; the spike (#47) decides whether to instantiate them.
- Owner decision: Claude merges pull requests permanently, after an independent review agent and a green CI. Recorded as ADR-0011 and plan rev. 6, which supersede ADR-0004's merge rule.
- Merged #58 (#46): Phase 2 plan and ADR-0011.
- Spike #47: with default settings node-opcua loses 70–90% of short state changes (sampling 0 is revised to 50 ms). Lossless with `minSupportedSampleRate: 0` and exception-based items, or with events; ADR-0009 chooses events with sequence numbers.
- Merged #59 (#47): OPC UA spike, ADR-0008, ADR-0009. The review led to a corrected measurement table, a "not covered" list with a reconnect/resync rule, and `nsu=` node ids.
- Spike #48: Alarms & Conditions in node-opcua work with correct usage. There is one genuine deviation: Retain drops after an acknowledgement while the alarm is active. Two other "inconsistencies" in the first version were spike mistakes, found by the review agent. ADR-0010 keeps alarms as state variables plus project events, with the lifecycle in the MES (Phase 6), on the grounds of ownership and one delivery path. #53 is narrowed to raise and clear.
- Merged #60 (#48): alarm spike. The review showed that two of three reported A&C issues were spike mistakes; the ADR-0010 decision stands on ownership and one delivery path.
- Merged #61 (#49): live mode. The review found re-entrancy when pacing is controlled from inside an event handler, and a circular accuracy test; both were fixed, and a property test was added.
- Merged #62 (#50): process values. The review moved reads before the last state change to return no value and led to the rule that live readers use `simulation.now`.
- Merged #63 (#51): OPC UA servers. The review found that the lossless test couldn't see lost initial events (now exact), that Machinery TransitionEvents share `i=2253` (documented), and that initial values had wall-clock timestamps (fixed).
- Merged #64 (#52): LoadProgram. Status codes follow the OPC UA method rules, with the offending argument flagged.
- #53 alarms: the alarm events are pure additions. The golden week gained 4 events (two CNC-01 breakdowns) and nothing else changed. Its first `calibration-due` falls exactly at the run end, so the calibration alarm itself is covered by unit tests and a 30-day stress run, not by the golden week. The review also made a double raise throw, and added the reverse invariant (an active alarm ⇒ down with that code, or calibration due).
