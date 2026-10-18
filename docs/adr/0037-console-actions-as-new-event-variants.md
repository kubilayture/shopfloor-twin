# ADR-0037: Console actions as new event variants that keep every draw

- Status: accepted (#234: the console actions and their read routes, control API 1.7, as decided in the Phase 9 plan, "Console actions"; scenario playback (P9-08), dispatch recording (P9-09) and the console's access path (P9-10) amend this record)
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
- Follow-up for P9-08: a live post with `at` equal to the simulation time (or without `at`) runs after the events already processed in that millisecond, so it equals the headless run only when posted before the run starts; the timeline test must cover posts made mid-run.
