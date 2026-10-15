# Phase 03 – Edge gateway and UNS: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-15

- Phase 3 planned: issues #70–#80, milestone 4.
  - Commands to machines (`cmd/load-program`) are deferred to Phase 7, where orders need them; the roadmap row for Phase 3 doesn't list them.
  - WSH-01 gets a state-change ring buffer in its register map, so that polling at 60× loses nothing.
  - Store-and-forward will probably use Node's built-in `node:sqlite` (SQLite 3.53, no warnings on Node 26); spike #71 decides.
- The plan review (PR #81) asked for changes, all adopted:
  - WSH-01 completeness: the ring buffer became an event buffer for state, cycle and alarm entries;
  - an `epoch` in every sequence space, because numbering restarts with the process;
  - resync snapshots marked and kept apart from device sequences;
  - fault controls (OPC UA offline, Modbus silent) brought forward from Phase 9 for the resilience tests;
  - an incidents topic;
  - a static ACL file with `$SYS` access for the healthcheck;
  - store-and-forward details: status messages bypass the buffer, a named volume, and a gateway-restart test.
