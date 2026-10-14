# Spike #48: Alarms & Conditions in node-opcua

Date: 2026-10-15. node-opcua 2.187.3. Code: `apps/simulator/spikes/alarms.ts` (experimental).

Sequence:

1. activate SPINDLE-OVERLOAD;
2. a client acknowledges it with a comment;
3. deactivate;
4. activate again;
5. a second client connects and calls ConditionRefresh.

| Step                                                       | Server-side state                | Events seen by client A                   |
| ---------------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| Activate                                                   | active, unacked, Retain true     | active, unacked, retain, `Sequence` = 1 ✓ |
| Acknowledge (status Good; the server received the comment) | active, acked, **Retain false**  | active, acked, retain false               |
| Deactivate                                                 | inactive, acked, **Retain true** | **none**                                  |
| Re-activate, then ConditionRefresh by client B             | active, unacked, Retain true     | client B: **none**                        |

Per OPC 10000-9, Retain should be true while the condition is active or unacknowledged, and false once it is inactive and acknowledged. A clear should produce an event, and a refresh should re-send retained conditions.

Gotchas:

- `instantiateAlarmCondition` requires `inputNode`.
- The condition source must be an event source (`HasEventSource` from the Server object).
- Custom event fields are lowerCamelCase when raising (see spike #47).

Decision: ADR-0010. State variables plus project alarm events on the device; the lifecycle lives in the MES (Phase 6). A&C stays possible as an additional view later.
