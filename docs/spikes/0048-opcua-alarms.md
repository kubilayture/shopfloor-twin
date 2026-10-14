# Spike #48: Alarms & Conditions in node-opcua

Date: 2026-10-15. node-opcua 2.187.3. Code: `apps/simulator/spikes/alarms.ts` (experimental; corrected after review).

Sequence:

1. activate SPINDLE-OVERLOAD;
2. a client acknowledges it with a comment;
3. deactivate;
4. activate again;
5. a second client connects and calls ConditionRefresh.

## Result with correct usage

| Step                                                        | Server-side state               | Events seen by the clients                                 |
| ----------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| Activate (`activateAlarm` + `raiseNewCondition`)            | active, unacked, Retain true    | A: active, unacked, retain, `Sequence` = 1                 |
| Acknowledge (status Good; the server received the comment)  | active, acked, **Retain false** | A: active, acked, retain false, `Sequence` still 1         |
| Deactivate (`deactivateAlarm(false)` + `raiseNewCondition`) | inactive, acked, Retain false   | A: inactive, acked, `Sequence` = 2                         |
| Re-activate, then ConditionRefresh by B (status Good)       | active, unacked, Retain true    | B: RefreshStart, the alarm with `Sequence` = 3, RefreshEnd |

The only deviation from OPC 10000-9 is that **Retain drops to false after an acknowledgement while the alarm is still active**. node-opcua does this when a condition has no ConfirmedState; it can be worked around.

## Correction

The first version of this spike reported three inconsistencies. The independent review showed that two of them were mistakes in the spike:

- **No event on clear:** `deactivateAlarm` doesn't raise an event; the caller must call `raiseNewCondition` afterwards.
- **ConditionRefresh delivered nothing:** the method was called on the Server object instead of ConditionType (`i=2782`), and the A&C service wasn't installed. The call's status code, which was ignored, was an error.

Lesson for spikes: check and print the status of every call.

## Gotchas

- `instantiateAlarmCondition` requires `inputNode`.
- The condition source must be an event source (`HasEventSource` from the Server object).
- `addressSpace.installAlarmsAndConditionsService()` is required before ConditionRefresh works; the method is called on ConditionType `i=2782`.
- `deactivateAlarm(retain)` sets state only; raise an event yourself.
- Library-raised events (acknowledgement, refresh brackets) don't advance a project sequence number.
- Custom event fields are lowerCamelCase when raising (see spike #47).

Decision: ADR-0010. State variables plus project alarm events on the device, with the lifecycle in the MES (Phase 6), because the plan assigns the lifecycle there and one delivery path with one sequence counter is simpler. A&C stays possible as an additional view later.
