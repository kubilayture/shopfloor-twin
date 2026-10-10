# Phase 00 – Foundations: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-10

- Repository created (private), plan rev. 2 committed to `main`.
- Labels, milestone and issues #1–#6 created.
- Deviation: branch protection unavailable on a private GitHub Free repository; recorded in ADR-0004 and plan rev. 3.

## 2026-10-11

- Merged #7 (#1): docs skeleton, STATUS, ADR-0001, ADR-0004, plan rev. 3.
- Deviation: #8 (#2) was stacked on the #1 branch and merged into it instead of `main`. Re-opened as #9 against `main`. Lesson: no stacked PRs; a dependent task waits until its base is merged.
