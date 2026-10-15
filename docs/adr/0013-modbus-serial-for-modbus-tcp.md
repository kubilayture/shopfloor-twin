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
