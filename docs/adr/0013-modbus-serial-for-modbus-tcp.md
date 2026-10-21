# ADR-0013: `modbus-serial` for Modbus TCP, server and client

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (spike #71), recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Plan section 6 names `modbus-serial` for the legacy washer WSH-01, to be confirmed by a spike in Phase 3 (plan section 12, open decision). The simulator needs a Modbus TCP server on port 5020, and the gateway needs a polling client that copes with timeouts, exceptions and server restarts.

## Considered options

1. `modbus-serial` 8.0.25 for both sides.
2. `jsmodbus` 5.0.0.

## Decision outcome

Chosen option: 1, `modbus-serial`, because spike #71 (`docs/spikes/0071-modbus-and-buffer.md`) passed every check:

- block reads at about 1.4 ms;
- exceptions, client timeouts and server restarts behave correctly;
- two clients can be served at once.

It has one runtime dependency and an ISC licence.

### Consequences

- Good: one library for both ends; the server's callback form lets the simulator play a _silent_ device for the resilience tests.
- Bad: the client doesn't reconnect by itself. The gateway's poller owns reconnection, with backoff.
- Bad: the optional `serialport` dependency is ignored in `pnpm-workspace.yaml`. If serial lines are ever needed, that decision is revisited.

### Amendment: closing a connection the device closed (#272, P9-F4, 2026-10-21)

The spike's "server restarts" check restarted the server while the client was idle. If the server goes away while a client is connected, as when the simulator is recreated, `modbus-serial` 8.0.25 has a trap. `ModbusRTU.close(cb)` ends the socket and calls `cb` only from the socket's next `close` event. A socket the peer has already closed never emits that event again, so `cb` is never called. The gateway's poller awaited that close before it reconnected. It therefore stopped polling for good, raised no incident, and kept reporting the device as connected. In the MES, WSH-01 stayed in its old epoch.

Decision:

- the gateway closes a Modbus connection with `destroy(cb)`, which cancels pending requests, destroys the socket and calls back at once;
- a failed poll drops its connection without waiting for it to close;
- a connect that fails destroys its socket, since a timed-out connect otherwise keeps connecting.

The upstream library is unchanged.

Bound, measured after the fix:

- **Real simulator child process** (`poller.test.ts`): stopped and started again on the same ports with a new epoch. The new run's snapshot was published before the simulator's control API reported ready. The test allows at most 2 s after ready.
- **Disposable Compose stack:** see the #272 entry in `docs/phases/phase-09-log.md`.
