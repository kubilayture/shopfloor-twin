# ADR-0010: Alarms on the device as state variables and events; the lifecycle lives in the MES

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (spike #48), owner on review

## Context and problem statement

Plan section 12 left open how machine alarms are represented in OPC UA: Alarms & Conditions (A&C, OPC 10000-9) or state variables. Plan section 7 gives the alarm _lifecycle_ (active, acknowledged, cleared, shelved, flood detection, priorities) to the MES `alarms` module (Phase 6). ADR-0009 requires every alarm transition to carry the per-machine sequence number.

## What the spike found (#48, node-opcua 2.187.3)

A machine with a custom `AlarmConditionType` subtype (with a `Sequence` property) went through: activate, acknowledge by a client, deactivate, re-activate, then ConditionRefresh from a second client.

**With correct usage, A&C works:**

- The active alarm is delivered as an event with the custom `Sequence`.
- The standard `Acknowledge` method works: the server receives the comment, and the acknowledged state comes back as an event.
- Clearing works, as `deactivateAlarm(false)` followed by `raiseNewCondition`.
- ConditionRefresh delivers RefreshStart, the retained condition and RefreshEnd, once the A&C service is installed and the method is called on ConditionType.

**One genuine deviation from OPC 10000-9:** after an acknowledgement, node-opcua sets `Retain` to false even while the alarm is still active, because the condition has no ConfirmedState. It can be worked around by setting Retain again, or by adding ConfirmedState.

**Setup that must be known:**

- every alarm needs an `inputNode`;
- the machine must be an event source (`HasEventSource` from the Server object);
- `installAlarmsAndConditionsService()` must be called before ConditionRefresh works;
- `deactivateAlarm` raises no event by itself.

The first version of the spike missed two of these points and reported them wrongly as library inconsistencies. The independent review found the errors, and the spike was corrected (see `docs/spikes/0048-opcua-alarms.md`).

**Sequence numbers:** events that the library raises itself (the acknowledgement event, refresh brackets, branch events) don't advance the project's per-machine `Sequence`. The acknowledgement event carried the same sequence as the activation.

## Considered options

1. Full A&C on the device, with acknowledgement on the device.
2. State variables plus the project's own alarm events; the lifecycle is in the MES.
3. Option 2 now, and A&C as an additional view later if a standard client needs it.

## Decision outcome

Chosen option: 3. The device side is option 2; A&C may be added later as a read-only view without changing the MES.

The reason is not that A&C doesn't work. It works, with one workaround and some non-obvious setup. The reasons are:

- **Ownership:** plan section 7 already assigns the alarm lifecycle (active, acknowledged, cleared, shelved, priorities, flood detection) to the MES `alarms` module. A&C on the device would duplicate that lifecycle in a second place.
- **ISA-18.2 practice:** acknowledgement is an operator action in the alarm system or HMI, not on the controller.
- **One delivery path:** alarms use the same project event mechanism and the same per-machine sequence counter as state and cycle events. ADR-0009 measured that path as lossless.

On each machine, under `ShopFloor/Alarms`, there is one Boolean variable per alarm source, `<CODE>.Active`, plus `ActiveCount`. They are served exception-based (ADR-0009).

Each transition emits a project `AlarmEventType` event (a subtype of `BaseEventType`) with:

- `AlarmCode`, for example `SPINDLE-OVERLOAD`;
- `Transition`, `active` or `cleared`;
- `Severity`, 1–1000;
- `Message`;
- `Sequence`, which shares the per-machine counter with state and cycle events (ADR-0009);
- `Time` and `SourceTimestamp` as simulation time.

Alarm sources in Phase 2:

- every breakdown failure mode: active while `Down` for that code, cleared when the repair ends;
- `LKT-01 CALIBRATION-DUE`: active from the due time until calibration is done.

Material shortages and `NO-OPERATOR` remain machine _states_ with causes, not alarms; the MES may raise alarms from them in Phase 6.

Acknowledging, shelving, priorities and flood detection are **not** on the device. They live in the MES alarms module (Phase 6). The integration tests check raise and clear only. Issue #53 is adjusted accordingly.

The plan section 12 open decision on alarm representation is closed.

### Consequences

- Good: alarm delivery uses the same mechanism as state and cycle events, which ADR-0009 measured as lossless. One sequence counter covers everything a machine reports.
- Good: one place owns the alarm lifecycle, the MES. That matches ISA-18.2 practice, where acknowledgement is an operator action in the HMI or alarm system, not on the controller.
- Bad: a generic A&C client (for example an off-the-shelf alarm viewer) can't use the machines' alarms. If needed, option 3 adds an A&C view later. That view would be _outside_ the completeness guarantee: library-raised A&C events don't carry new sequence numbers, so the gateway would keep reading the project events.
- Bad: "acknowledge from a client", as written in #53, moves to Phase 6.
