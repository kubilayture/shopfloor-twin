# ADR-0033: Traceability facts on the cycle event, a bounded leak-drift injection and scenario-local stock

- Status: accepted (#196: device facts, drift, stock; the ground-truth sidecar `trace.json` is decided in the Phase 8 plan and follows in #208)
- Date: 2026-10-17
- Deciders: Claude (#196), within the Phase 8 plan and its review (PR #207, rounds 1–3); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Phase 8 traces every packed part back to its blank lot, its component lots and ASM-01's operator, and shows that SPC detects an injected leak-test drift (plan section 11, row 8). The simulator already knows the lots (`material-consumed`, in every event log) and the operator (`operator` events, `ShopFloor.Operator`), but neither reaches the UNS: the machine server ignores `material-consumed`. There is no drift injection, only failure injections (#140), and `config/plant/stock.yaml` has lots so large that no lot changes inside a two-day scenario.

Constraints:

- `week-01`, `alarms-01` and `orders-01` must keep `events.sha256` and `summary.json` byte-identical (no golden regeneration in this phase), and every device sequence number must stay where it is: the gateway and the MES judge loss by gaps in `Sequence` (ADR-0009).
- The MES's golden harness and the live machine server must attach lots and operators the same way, or the reconciliation tests two definitions instead of one fact path.
- The drift's detection must be shown to come from the drift, not from chance: the tests need the reading each draw would have given without it (the counterfactual), exactly.

## Considered options

Lots to the MES: (a) a new `material` OPC UA event in the device sequence; (b) lots and the operator as fields of the existing cycle event.

Array encoding: (a) `String[]` fields (`valueRank` 1); (b) one encoded string field.

Drift: (a) extend the failure injection (`injection-applied` with a drift code); (b) its own event variant `leak-drift` with `applied` and `ended`; time bound (a) open-ended until calibration; (b) `until`, or the next calibration if it comes first.

Drift arithmetic: (a) add `shift` to the mean before rounding; (b) add `shift / resolution` steps to the rounded reading, with `shift` a whole multiple of the resolution.

Small lots: (a) change `stock.yaml`; (b) a scenario-local stock file, and `SIM_STOCK` in live mode.

## Decision outcome

**Fields (b), arrays (a).** `CycleCompleteEventType` gains `LotMaterials` and `LotIds` (two `String[]` of equal length, in consumption order) and `Operator` (`String`, the station's operator when the cycle started, empty where a machine has none): address space 1.2. A CNC's OP10 cycle carries its blank lot, ASM-01's OP30 cycle the component lots of that pass (`components` on pass 1, `reworkComponents` on a rework pass), every other cycle two empty arrays. "When the cycle started" is the instant of the part's first `material-consumed` on that machine; the operator is the machine's latest `operator` event before it (MEDIUM 7 of the review). The rule is one fold in the pure package `trace-core` (#195): `attachConsumption(events)` over a stream, and `ConsumptionTracker`, its one-event-at-a-time form, which the machine server runs over its own machine's events. No event enters a device sequence; a test routes a scripted shift (`orders-01`'s Monday shift A) through the machine servers and compares the (machine, `Sequence`, type) digest with the one recorded before #196. Probe P1 (review of PR #207) showed node-opcua 2.187.3 delivering 3,000 such events intact and in order through an event filter, an empty array as an empty `String` array and the field of another event type as `Null`, so "no lots" and "no field" are told apart; the integration test checks the fields a generic client reads against `attachConsumption` over the plant events. The UNS mapping (contract 1.4: optional `lots` and `operator` on `uns.events.cycle-complete/1`, absent, `[]` and null kept apart), ingest's validation and lot index, and the golden harness's use of `attachConsumption` came with #197.

**Drift (b) with `until` (b), arithmetic (b).** A scenario entry `{ kind: "leak-drift", at, until, machine, shift }` or `POST /api/v1/faults/drift/{machine}` (control API 1.5) adds `shift` (Pa/min) to LKT-01's readings from `at` until `until` or the start of the tester's next calibration, whichever comes first. `PlantEvent` gains `{ type: 'leak-drift', at, machineId, injection, transition: 'applied' | 'ended', shift, endedBy?: 'until' | 'calibration' }`; a drift still active at the end of a run writes no `ended` line, and `until` may be at or after the end. A drift applied during a running calibration survives that calibration and is ended by the next one; a reading taken at the calibration's instant, by the cycle that frees the tester for it, still carries the drift. `shift` must be a non-zero whole multiple of the tester's `resolution` (refused otherwise); the tester adds `shift / resolution` to the rounded reading's steps, which equals adding `shift` to the mean before rounding but is exact, so the counterfactual is the logged steps minus `shift / resolution` between the `applied` and `ended` lines and the logged value outside them. The reading still draws one normal: the run before `at` is the run without the drift. Drifts and failure injections share one numbering and one scenario list; the run header lists a drift with `kind` only when a run has one (an entry without `kind` stays a failure), and the calendar-boundary rule of failure injections applies to `at` and to an `until` inside the run.

**Stock (b).** `scenario.json` may name `stock`, a file in the scenario's folder; a live run reads `SIM_STOCK` (default `stock.yaml` of `SIM_CONFIG_DIR`). `loadPlantConfig(dir, { stock })` validates and cross-checks it like the plant's, and the run's `configSha256` hashes the stock it used. A golden scenario's ERP dataset lists the same lots (asserted for every golden scenario; the ERP mock already takes a dataset's `lots`).

### Consequences

- Good: no sequence number, event log or summary of an existing golden changes (checked by the golden snapshots and the sequence digest); one definition of "the lots and operator of this cycle" for the simulator and the MES.
- Good: the drift's counterfactual is exact, and a drifted run is the plain run up to `at`, so exit criterion 3 can say "only because of the drift".
- Good: small lots belong to the one scenario that needs them; `stock.yaml`, `products.yaml` and `reasons.yaml` are unchanged in this phase.
- Bad: material taken for a cycle still running at the end of a run is reported by no fact (as `materialInProcess` in Phase 7); a cycle that consumed nothing (none today) would carry no operator.
- Bad: the gateway's event filter selects three more fields on every project event type (as `Null` where absent) until #197 maps them; a generic client sees them at once.
- Neutral: overlapping drifts add up; a calibration ends every active one. The control API cannot cancel a drift; a drift ends only by `until`, a calibration or the run's end.
