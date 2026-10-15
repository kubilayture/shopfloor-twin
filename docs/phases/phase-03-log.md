# Phase 03 – Edge gateway and UNS: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-15

- Phase 3 planned: issues #70–#80, milestone 4.
  - Commands to machines (`cmd/load-program`) are deferred to Phase 7, where orders need them; the roadmap row for Phase 3 doesn't list them.
  - WSH-01 gets a state-change ring buffer in its register map, so that polling at 60× loses nothing.
  - Store-and-forward will probably use Node's built-in `node:sqlite` (SQLite 3.53, no warnings on Node 26); spike #71 decides.
