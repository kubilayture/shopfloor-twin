# Phase 08 – Traceability and quality: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan. Kept from the first merge (Phase 7 lesson: that phase ran without its log).

## 2026-10-17

- Phase 8 planned: issues #192 and #194–#205, milestone "Phase 08 – Traceability and quality" (milestone 9). #192 (the `alarm-core` revision-span bug found by the Phase 7 closing gate, fix in progress on `fix/192-alarm-revision-span`) is taken into wave A.
- #194 (plan, in review): `docs/phases/phase-08-plan.md` and master plan rev. 8. Decisions in brief: lots and the ASM-01 operator travel as fields of the existing cycle facts (no new device event, no event log change); genealogy and SPC truth in a `trace.json` sidecar, so the `week-01`, `alarms-01` and `orders-01` summaries stay byte-identical; a new golden `quality-01` with scenario-local stock and a `leak-drift` injection; cartons by the MES's packing rule shared with the ground truth; units keyed (epoch, `partId`) with a `serial-reused` incident; SPC on first-pass leak readings with frozen, versioned limits and Nelson rules; holds that block an order's close and notify the ERP mock, not the machines; per-order OEE moved to Phase 9. Probes P1–P4 run before the first review round.
