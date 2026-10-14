Closes #<!-- issue -->. Plan: section <!-- N -->.

## What changed and why

## How to review

<!-- Which files to read first, and in what order. -->

## Concepts

<!-- The industrial or engineering ideas involved, in plain language. -->

## Test evidence

<!-- Tests added or updated; how you ran them. -->

## Docs touched

<!-- README, architecture, ADR, API or UNS spec, changelog, STATUS. -->

## Checklist (Definition of Done, plan section 2)

- [ ] Acceptance criteria in the issue are met
- [ ] Unit tests added or updated; integration or E2E tests where the change crosses a process boundary
- [ ] `pnpm verify` passes locally and **CI is green** on the latest commit (required before merge, ADR-0011)
- [ ] Independent review agent run; findings fixed or answered in this description (ADR-0011)
- [ ] No new lint suppressions without a comment explaining why
- [ ] Public contracts (OPC UA address space, UNS topics, REST API, DB schema) documented and versioned
- [ ] `CHANGELOG.md` entry under "Unreleased"
- [ ] `docs/STATUS.md` updated
