# ADR-0037: Console actions as new event variants that keep every draw

- Status: accepted (#234: the console actions and their read routes, control API 1.7, as decided in the Phase 9 plan, "Console actions"; amended by #235, scenario timelines and the order of an instant, control API 1.9; dispatch recording (P9-09) and the console's access path (P9-10) amend it further)
- Date: 2026-10-18
- Deciders: Claude (#234), within the Phase 9 plan and its review (rounds 1–3 and the final check); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

The master plan's simulation console (section 1, goal 5; section 4, "mark an operator absent, block a component lot") needs levers on the physical world beside the failure and drift injections of Phases 6 and 8. The model has a lot block (`ProductionLine.blockLot`) that no route reaches, operator absence only as a random draw per operator and shift, and no tool breakage. Three questions:

- How does an action enter the run so that a live run and a headless run with the same actions give the same event log, and every golden keeps its bytes?
- What is a tool breakage, given the existing tool model (wear from the cycle count, one defect draw per OP10 cycle, a tool change at the next start after end of life)?
- How is an operator made absent without moving the random draws of the roster?

Constraints:

- `week-01`, `alarms-01`, `orders-01` and `quality-01` keep `events.sha256`, `summary.json` and `trace.json` byte-identical, and `configSha256` with them: no new key in a simulation input such as `failures.yaml`.
- Every shift has two operators qualified for ASM-01 (`config/plant/operators.yaml`), and the first present one takes the station, so one absence changes nothing.
- Random streams are per entity and per purpose (ADR-0007); an action must not add or remove a draw on any stream, or the run after it would differ for reasons other than the action.

## Considered options

Tool breakage:

1. Wear set to end of life (1.0): the cycle in progress draws its defect at that wear, the next start changes the tool (`Setup TOOL-CHANGE`), as at a natural end of life.
2. A `Down` with a new failure code `TOOL-BREAK` and a repair.

Forced absence:

1. Skip the roster draw of a listed operator.
2. Draw as always, then override: a listed operator is absent whatever the draw says.

How an action enters the run and the log:

1. Change the existing events (an `operator` event with a `forced` field, `state` causes).
2. A new event variant per action, written only by runs that use it, and a new header key `actions` written only when a run has one.

## Decision outcome

- **Tool breakage, option 1.** Option 2 changes `failures.yaml` and so `configSha256` of every golden, and a breakage is not a repair job in this model: the tool is a consumable the machine's own setup replaces. At `at` the tool's cycle count is set to its `lifeCycles` (`ToolWear.break`); nothing else happens then. A cycle in progress completes normally and its defect draw reads the curve at wear 1.0 (5 % by default); `needsChange` is then true, so `#tryStart` changes the tool before the next cycle, as at end of life (`Setup`, `TOOL-CHANGE`, `changeMinutes`). With no cycle in progress the change happens at the next start. **Draws:** every OP10 cycle still makes exactly one `bernoulli` on `{cnc}/quality/defect`; only its probability changes. The breakage and the change draw nothing (`changeMinutes` is fixed). So the run before `at` is identical, and every stream draws the same sequence of values; only the timing after `at` moves, as with any injection.
- **Forced absence, option 2.** Skipping a draw would shift every later draw of that operator's stream, so every later shift's staffing would change. Drawing always keeps the number of draws per operator and shift, so every other shift is staffed exactly as without the action (tested). The absence names a shift (`YYYY-MM-DD/<id>`, the ground truth's bucket key) whose start is after the simulation time, so no running shift's staffing changes mid-cycle. Marking both ASM-01-qualified operators leaves ASM-01 `Idle` with cause `NO-OPERATOR` at that shift's start (tested headless and through the control API).
- **Entry and log, option 2.** Each action is a new variant of the event union: `lot` (`lotId`, `material`, `transition: blocked | released`, `action`), `absence` (`shiftId`, `shiftDate`, `operators` in roster order, written at the shift start before its `operator` events) and `tool-breakage` (`machineId`, `action`, `cycles` before). A lot action and a tool breakage are simulation events at `at`, as failure injections are, with the same refusals (a time in the past or on a calendar boundary); a headless run takes them as `actions` after the dispatches and the injections, in list order, and records them under a new header key `actions` only when it has one. Console actions have their own numbering (1, 2, …), so the injection numbering of existing scenarios is unchanged.
- **Tool breakage, two edges (review of #234):** a breakage on an OP10 machine without a tool (one the schedule doesn't list, in schedule mode) is refused when it is accepted (`not-a-cnc`), never discovered at the event, where it would abort a headless run or stop the live pacer. A breakage that falls due inside the machine's own `TOOL-CHANGE` setup is a recorded no-op (event `tool-breakage` with `ignored: tool-change-in-progress`, status `ignored`): the tool being fitted has not cut, and breaking it would chain a second change into one 16-minute setup. A refusal was not chosen because a scheduled breakage can't know at acceptance what the machine will be doing at `at`.
- **Read routes:** `GET /api/v1/lots` (lot, material, remaining, blocked), `GET /api/v1/operators` (roster, present, absent or off shift in the current shift, the station staffed, forced absences planned or applied) and `GET /api/v1/actions`, for the console.
- **No MES path:** a lot block is the physical counterpart of an MES hold, never triggered by the MES (ADR-0035 stays); none of the new events is an OPC UA fact, so no device sequence number moves. The MES sees their effects (starvation with `MATERIAL:<material>`, `NO-OPERATOR`, a scrap and a `TOOL-CHANGE` setup) through the existing state and cycle facts. One exception, older than this record and left as it is: a tool change that follows a product changeover directly (Setup → Setup) has no state event of its own, so the MES sees one longer Setup with the changeover's cause, not a `TOOL-CHANGE`. A breakage during a changeover is therefore applied (only the machine's own `TOOL-CHANGE` setup ignores one), and its change shows only as the longer setup.

### Consequences

- Good: every golden keeps its bytes (`pnpm test:golden`), and a run with actions equals itself live and headless when the actions are accepted before the run starts (tested); P9-08's timelines map onto the same `ActionSpec` list.
- Good: the actions are plain uses of the existing model (the lot block, the roster, the tool's wear), so no new state or cause appears in the MES.
- Bad: a tool breakage cannot stop a cycle or raise an alarm; a breakage that should is a failure injection with an existing code. Recorded under the Phase 9 plan's "Out of scope".
- Bad: a forced absence can't be withdrawn once accepted; a console user plans the next shift, not the running one.
- Bad: control API 1.7 is the first free minor in merge order, not the 1.8 the plan's listing assumed: P9-03's ground-truth `lineOee` takes 1.8 if this merges first.
- Bad: a lot block of a blocked lot, or a release of a free lot, is accepted and recorded (a `lot` event) although it changes nothing; refusing it would need the lot's state at a future `at`.
- Follow-up for P9-10: `GET /api/v1/actions` is not in the plan's `/sim/` allowlist and must be added to it.
- Follow-up for P9-08 (closed by the amendment below): a live post with `at` equal to the simulation time (or without `at`) runs after the events already processed in that millisecond, so it equals the headless run only when posted before the run starts; the timeline test must cover posts made mid-run.

## Amendment (#235): scenario timelines and the order of an instant

P9-08 plays timelines of these actions headless and live (Phase 9 plan, "Scenario playback"; `docs/simulation-model.md`, "Scenario timelines"). It closes the follow-up above on posts made mid-run.

- **Timelines map onto the same lists.** `config/scenarios/<name>.yaml` and a golden `scenario.json` are parsed by one schema in `plant-config` (`scenarioSchema`, `scenarioPlan`, `checkScenarioPlan`). A timeline's `lot-block`, `lot-release`, `operators-absent` and `tool-breakage` entries go to `actions` in timeline order, as `ActionSpec`s: the entry and log decisions above are unchanged, and the run header lists them under `actions`. `failure` and `leak-drift` go to `injections`, `dispatch` to `dispatches`, as before #235; `opcua-offline`, `modbus-silent`, `speed` and `pause` are live only and touch neither the model nor the log.
- **A live timeline is accepted before the run starts.** `SIM_TIMELINE` or `POST /api/v1/scenario` (control API 1.9) only while the run is idle: every plant entry is accepted at the start time in the headless order, so a live timeline is the case "accepted before the run starts" this record already proved equal to headless. The infrastructure entries are pacer cues, applied when the simulation has processed every event at or before their time. A `dispatch` entry is refused live.
- **Accepted actions are external events.** Options for an action posted mid-run, the open point above: (1) leave the FIFO queue and record what was posted where; (2) refuse a mid-run post for the simulation time; (3) an `external` lane in `sim-core`'s queue: at one millisecond every event accepted from outside (an injection, a drift's start and end, a lot action, a tool breakage) runs before every model event, in acceptance order. **Chosen: (3)**, with (1)'s recording left to P9-09 for dispatches. With a FIFO queue an action posted for a later time runs after any model event already queued for that millisecond, and the headless run, which accepts everything first, before it: the two logs differ (checked by hand: the mid-run test fails with the lane removed). With the lane both put it first. A post for the simulation time itself still runs after the events of that millisecond already processed, which no queue can undo; that order is now defined and tested, and option (2) would have refused the console's most common request ("now").
- **The goldens keep their bytes:** a run that accepts everything before it starts changes only where an external event shares its millisecond with an event `line.start` queued, and none of the four goldens has one (`pnpm test:golden` unchanged).

### Consequences of the amendment

- Good: exit criterion 3 holds: a timeline with every live action kind, played live at 1× to 60× with its own pauses and speed changes, writes the headless event log byte for byte (`SIM_EVENT_LOG`), and a mid-run post for a later time equals the headless run with the same action.
- Good: one schema and one mapping for both formats, so the console, the headless CLI and the goldens can't drift apart.
- Bad: a post at the simulation time is reproduced by a headless run only when no event of that millisecond had been processed; replaying it exactly needs the recording P9-09 builds for dispatches.
- Bad: the headless run gives every injection before every action, so an injection and an action of the same millisecond posted action first differ from it; posting in group order, or a timeline, avoids it.
- Bad: a live run plays a timeline against its own configuration; the timeline's `config` and `stock` describe the headless run, and a stock of the timeline's own needs `SIM_STOCK` set to it.
- Bad: control API 1.9, not 1.8: 1.8 is left to P9-03 (#230), still open when this was numbered.
