# ADR-0029: Command path: at-least-once delivery, device dedup and settled outcomes

- Status: accepted
- Date: 2026-10-17
- Deciders: Claude (#173), within the Phase 7 plan ("Command path", review decisions B2, M2 and M4); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

From Phase 7 the MES dispatches jobs to the CNCs: MES → UNS `cmd/load-order` → edge gateway → OPC UA `LoadOrder` → UNS `cmd-res` (plan section 5, data path 3). Every hop can fail at the worst moment: the broker delivers at least once, the gateway can crash between receiving a command and recording it or between the call and its result, the OPC UA call can time out on the client after the device has acted (the review's probe `opcua/p1.js`), the TCP connection can be cut or the simulator restarted mid-call (`p2.js`, `p4.js`), and the broker can be away while a result waits. ADR-0030 made the device the place where execution becomes exactly-once: `LoadOrder` is idempotent by command id, checks its dedup table first and refuses a stale command (`DeviceEpoch`, `ExpiresAt`) only on a miss. This record decides the gateway's half:

- how a command reaches the gateway without being lost or taken over;
- when the gateway calls, how long it waits, and when it stops;
- what it answers when it doesn't know whether the device acted;
- what it remembers, and which UNS messages carry commands, results and job facts.

## Considered options

1. **Command session:** (a) subscribe on the publishing connection; (b) a second connection with its own client id, persistent, acknowledging after recording.
2. **Unknown outcomes:** (a) report `failed` or `expired` when the deadline passes; (b) retry until `expiresAt`, then settle by one more call after `expiresAt`, reporting `unknown` until it settles.
3. **Result memory:** (a) none (always call); (b) every outcome by command id; (c) definitive answers only, `expired` by command id and `expiresAt`.
4. **Message shapes:** (a) commands and results in the fact envelope; (b) a command envelope of their own, job facts as device facts.

## Decision outcome

Chosen: 1b, 2b, 3c and 4b.

### Command session (1b, M2)

The gateway opens a second MQTT 5 connection, client id `{GATEWAY_ID}-cmd` (`gw-01-cmd`) under the broker user `gw-01`, so it never takes over the publishing connection's session (client id `gw-01`, `clean: true`, with the last will). It is persistent: `clean: false`, session expiry `GATEWAY_CMD_SESSION_EXPIRY_S` (default 1 h, longer than any command's life), receive maximum 10, subscriptions `orbis/gebze/{area}/+/+/cmd/#` per area (a `+` in the area level would match `_sys`), QoS 1, renewed and checked on every connect. The gateway is ready only while both sessions are up and the subscriptions granted.

A delivery is committed to `command_inbox` in the gateway's SQLite file (the outbox's file, ADR-0014, on a connection of its own, `synchronous = FULL`) before its PUBACK: MQTT.js sends the PUBACK when `handleMessage`'s callback runs, as for the MES's facts (ADR-0017). If the insert fails, the delivery is not acknowledged: the session is dropped and resumed after a pause, and the broker delivers it again. A crash before the commit is the same case. A delivery leaves the inbox only once its answer is in the outbox, so whatever a crash interrupts is processed again at the next start.

### Calls (2b, B2)

- **One command at a time per equipment,** in arrival order; every OPC UA request of an equipment (calls and reads, settle calls included) runs under one lock.
- **Only on a ready session:** connected, subscribed, resync done (the collector's `deviceEpoch` is known). Otherwise the command waits, at most until its `expiresAt`.
- **Deadline:** every call and read has an application-level deadline `GATEWAY_CALL_DEADLINE_MS` (default 5 s), independent of node-opcua's transaction timeout. The request is not cancelled; a late answer is ignored.
- **Retries until `expiresAt`:** a transient refusal (`BadWaitingForInitialData`: not attached, not running) or an unknown outcome (deadline, transport, session, any status not in the address-space contract) is retried after a pause. Before every retry the gateway re-reads `ShopFloor.Epoch`; if it differs from the command's `deviceEpoch` it answers `rejected` (`epoch-mismatch`, `statusCode: null`) without calling. The device's dedup makes every repeated call safe: a job it already accepted answers `Duplicate`.
- **No expired shortcut:** a command that arrives expired (or a resend whose `expiresAt` has passed) is still called once, because the gateway can't prove that it never called that id before a crash. The device answers `Duplicate` if the job was accepted and `expired` otherwise.

### Settling unknown outcomes (2b)

Without a definitive answer by `expiresAt`, the outcome is settled, never guessed. After `expiresAt` plus a 1 s clock allowance, once the session is ready (waiting up to 10 s for it), the gateway reads `ShopFloor.Epoch` (changed: `rejected`, `epoch-mismatch`), then the device's own clock `Server_ServerStatus_CurrentTime` (`ns=0;i=2258`), which must also be past `expiresAt` plus the allowance (otherwise the attempt is `unknown` and repeated: the device decides `ExpiresAt` by its own clock, review of PR #184), then `ShopFloor.Sequence` as `seqAfterExpiry`, then makes one more call with the same arguments. The device checks its dedup table first and refuses any miss after `ExpiresAt`, so: Every accepted fact of the command has a device sequence number at most `seqAfterExpiry` (the device accepts nothing for it once its clock is past `ExpiresAt`), so once the CNC's final-through is at or above `seqAfterExpiry`, every such fact has arrived.

| Settle call answers                              | Result                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `Good`, `Duplicate = true`                       | `duplicate`, with the original `AcceptedSeq` and `AcceptedAt`                                                                  |
| `Good`, `Duplicate = false`                      | `accepted` (the device's word, safer than `unknown`), logged as clock skew and counted in `gateway_command_settle_acceptances` |
| `BadInvalidState` flagged on `ExpiresAt`         | `expired` (never accepted), with `seqAfterExpiry`                                                                              |
| `BadInvalidState` flagged on `DeviceEpoch`       | `rejected`, `epoch-mismatch` (the run ended; the MES's epoch rule applies)                                                     |
| anything else, or no answer, or no ready session | `unknown`, with `seqAfterExpiry` when it was read; settled again                                                               |

`unknown` is published once, and again when `seqAfterExpiry` is read for the first time; the settle attempts repeat every 5 s while the command's device epoch lasts. They run in the background, so an unsettled command doesn't hold up the equipment's next command (the MES sends the next one only after a final result anyway); a settle call adds a job only if the device's clock is still before `ExpiresAt` despite the gateway's check of it (clock skew): it is then reported `accepted` with its own `acceptedSeq`, which the device sequence orders like any acceptance, and flagged. node-opcua may also replay a request that was pending when its connection dropped once the session is re-established; that replay is harmless: it is an ordinary call of the same command id and job, so the device's dedup turns it into a duplicate, and once the device's clock is past `ExpiresAt` a miss is refused, so it can't create a job after the settle call has read `seqAfterExpiry`. The gateway never reports `expired` or `failed` for an outcome it doesn't know: `failed` is the MES's own state (plan, "Results and what they mean").

**Known limit, accepted:** a simulator run that has finished answers `BadWaitingForInitialData` (transient) to every call, also to a settle call, so a command whose outcome is unknown when its run finishes stays `unknown` until the gateway sees a new epoch (then `rejected`, `epoch-mismatch`). The MES's `failed` and the re-dispatch rule (final-through at or above `seqAfterExpiry`, or the epoch's end) cover it.

### Result memory (3c)

`command_result` keeps definitive answers only: `accepted`, `duplicate` and `rejected` by (command id, `deviceEpoch`), `expired` by (command id, `deviceEpoch`, `expiresAt`), each with the job it answered (machine, device epoch, order, product, quantity, `notBefore`). The device epoch is part of the key because the device's dedup table ends with its run while the gateway's file outlives it (the `gateway-data` volume) and the MES's command ids are deterministic: an answer of one run never answers a command for another (review of PR #184). Answers older than 24 h are pruned at start and hourly; a table from before the epoch was in its key is dropped. A redelivery or resend of the same job is answered from it without calling, with the delivery's own `expiresAt` in the answer; an `expired` for an older `expiresAt` doesn't answer a resend with a new one, which is called (and the device's dedup makes that safe). Another job under a stored id goes to the device, which answers `command-conflict`; the first stored answer stays. `unknown` is never stored. A command that names equipment without `LoadOrder` is `rejected` (`unsupported-equipment`) by the gateway, the one refusal it decides itself, since no call is possible. A delivery that is not a valid `uns.cmd.load-order/1` is acknowledged, logged and dropped: the MES builds commands from the same schema, so it is a defect, and the MES's own `failed` margin reports it.

### Messages (4b, M4; UNS contract 1.3)

- **`cmd/load-order`, `uns.cmd.load-order/1`:** `schema`, `scope: topic`, `epoch` and `seq` of the issuer (the MES process, per topic), `source`, `issuedAt`, `expiresAt` (wall time), `value: { commandId, orderId, operation: OP10, product, quantity, notBefore, deviceEpoch }`; `commandId` must be `{orderId}~OP10~{n}`.
- **`cmd-res/load-order`, `uns.cmd-res/1`:** `scope: topic`, the gateway's `epoch` and `seq` per topic, `source` the equipment (protocol `opcua`), `respondedAt`, and a `value` discriminated by `result`, always with `commandId`, `orderId`, `deviceEpoch`, `expiresAt` (of the delivery answered) and `statusCode` (the OPC UA status that gave the answer, or null): `accepted` and `duplicate` with `position`, `acceptedSeq` and `acceptedAt` (the device's sequence number and plant time of the job's `accepted` fact, M4); `rejected` with `code`; `expired` and `unknown` with `seqAfterExpiry`; `unknown` with `reason`. A result goes through the store-and-forward outbox, so a broker outage delays it but doesn't lose it; when the outbox is full, `cmd-res` messages are never the ones evicted.

**How a consumer reads several results for one command id:** `accepted` and `duplicate` are sticky per command id (and device epoch): the job exists, and no later `expired`, `unknown` or `rejected` (`command-conflict`) for that id ever revokes them. `expired` and `unknown` hold only for the delivery they answer, which they name by `expiresAt`: an `expired` for one `expiresAt` says nothing about a resend with another, and an `unknown` never overrides a definitive answer (`expired`, `rejected` or a sticky one) for the same `expiresAt`, whatever their order, and is replaced by any definitive answer. `rejected` (other than `command-conflict` after an acceptance) is final for the command id.

- **`events/job`, `uns.events.job/1`:** a device fact (`scope: device`, the machine's shared `Sequence`), `{ transition, commandId, orderId, product, quantity }`, from `ShopFloorJobEventType`; the gateway dedups and gap-checks it with the machine's other facts.

Commands and results have their own registry (`UNS_COMMAND_SCHEMAS`, `parseUnsCommandMessage`), apart from the fact schemas, because they carry no `sourceTime`, `receivedAt` or `quality`. The job fact is one of the fact schemas.

### Broker ACL (M2)

`gw-01` (both connections) gets `read …/cmd/#` and `write …/cmd-res/#` per area; it can't publish `cmd`. `mes` keeps `write …/cmd/#` and can't publish `cmd-res`; it reads results through `read orbis/#`. `dev` stays read-only. Refusals are PUBACK 0x87, tested for `cmd` as `gw-01` and `dev` and `cmd-res` as `mes` and `dev`. The plain ACL file grants per user, not per client id; binding `gw-01` and `gw-01-cmd` to their uses, and preventing a client-id takeover of `gw-01-cmd`, wait for dynamic security (Phase 9).

### Consequences

- Good: every case of plan exit criterion 3 on the gateway's side ends with one job per command id: duplicate delivery, a lost `cmd-res` and its resend, a crash between receiving and recording and between the call and storing its result, a client timeout after the device acted, a TCP cut and a simulator restart mid-call, an expired command, a wrong epoch, an invalid product, a broker outage with a result pending, and a crash after the call followed by an expired resend (answered `duplicate`). Integration tests against the simulator in orders mode through TCP proxies, and end to end with Mosquitto and the gateway process (`commands.e2e.test.ts`).
- Good: the gateway never claims what it doesn't know; `unknown` carries `seqAfterExpiry`, which lets the MES decide a re-dispatch from device facts (#174).
- Bad: a job fact raised while the gateway's session is cut or the gateway is down is history to the next session (no event history, ADR-0009): the UNS doesn't carry it, the MES sees a sequence gap, and only the `cmd-res` (`duplicate` with `acceptedSeq`) says the job exists. #174's `command-unconfirmed` incident reports exactly that case.
- Bad: answers from the result table and repeated settle answers mean several `cmd-res` per command id; the MES treats them idempotently by command id (#174).
- Bad: until #174 the MES ingest refuses `events/job` (`unexpected-topic`), so an orders-mode run seen by the MES has `rejected_message` rows and sequence gaps where its job facts are. Schedule mode, the default, has no job facts.
- Bad: settling runs only while the gateway runs; an `unknown` left when the gateway is stopped is settled again after its next start, from the inbox.
