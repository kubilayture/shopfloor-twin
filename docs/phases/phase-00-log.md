# Phase 00 – Foundations: log

Dated entries, one per merged pull request: what merged, what was learned, deviations from the plan.

## 2026-10-10

- Repository created (private), plan rev. 2 committed to `main`.
- Labels, milestone and issues #1–#6 created.
- Deviation: branch protection unavailable on a private GitHub Free repository; recorded in ADR-0004 and plan rev. 3.

## 2026-10-11

- Merged #7 (#1): docs skeleton, STATUS, ADR-0001, ADR-0004, plan rev. 3.
- Deviation: #8 (#2) was stacked on the #1 branch and merged into it instead of `main`. Re-opened as #9 against `main`. Lesson: no stacked PRs; a dependent task waits until its base is merged.
- Decision change: all documentation in English, including learning notes and PR "Concepts" (plan rev. 4). Concepts sections of #7, #8, #10 and #11 translated.

## 2026-10-12

- Merged #10 (#3): type-checked ESLint, dependency rules, pre-commit hook, ADR-0005.
- Merged #13 (#12): English-only documentation, plan rev. 4.
- Merged #11 (#5): Docker Compose stack; conflicts with #10 in shared docs resolved by merging `main` into the branch.
- Merged #14 (#4): CI and templates. First run on `main` green: all four exit criteria met.
- Merged #15 (#6): phase report and learning notes.
- Owner decision: "Squash and merge" from now on (plan section 8 unchanged). Earlier PRs remain as merge commits.

## 2026-10-14

- Merged #31 (#17): Phase 1 plan and plan rev. 5.
- Phase 0 closed and tagged `phase-00`; learning step skipped by owner decision.
