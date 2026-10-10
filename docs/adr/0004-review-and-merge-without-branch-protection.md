# ADR-0004: Review and merge without branch protection

- Status: accepted
- Date: 2026-10-10
- Deciders: owner

## Context and problem statement

The plan (section 8) asked for branch protection with required CI checks and the owner's approval before merge. Two facts make that impossible as written:

1. The repository is private on GitHub Free. GitHub rejects branch protection and rulesets on such repositories (HTTP 403, "Upgrade to GitHub Pro or make this repository public").
2. Claude opens pull requests through the owner's own GitHub account, and GitHub never lets an author approve their own pull request, so a required approval would block every merge even with protection available.

## Considered options

1. Make the repository public to get branch protection for free.
2. Upgrade to GitHub Pro.
3. Stay private and treat the merge rules as working rules.
4. A separate bot account for Claude, so the owner can formally approve.

## Decision outcome

Chosen option: 3, decided by the owner. The repository stays private, without paid plans or extra accounts.

Working rules that replace the protection settings:

- Claude never pushes to `main` and never merges a pull request; every change goes through a pull request from a `<type>/<issue>-<slug>` branch.
- The owner's squash-merge is the approval.
- A pull request is merged only when CI is green; the PR template carries a checkbox for it.
- Exception: the initial commit that added the project plan, made before any tooling existed.

### Consequences

- Good: no cost, no extra accounts, no friction on merge.
- Bad: nothing technically stops a merge with red CI or a direct push to `main`. The rules depend on discipline; CI on `main` (#4) makes any slip visible immediately.
- Revisit: if the repository becomes public or moves to GitHub Pro, enable required checks and linear history, and mark this ADR superseded.
