# ADR-0011: Claude merges after an independent review

- Status: accepted; note of 2026-10-21 (the local gate in place of green CI since PR #149) awaiting the owner's review
- Date: 2026-10-15
- Deciders: owner
- Supersedes: ADR-0004 (only its rule "Claude never merges"; the absence of branch protection still holds)

## Context and problem statement

Under ADR-0004 the owner reviewed and merged every pull request. In Phase 1 the owner first delegated merging for the rest of that phase. On 2026-10-15 the owner decided to make it permanent. Owner review was the bottleneck, and the Phase 1 trial showed that a separate review agent finds real defects. Examples:

- an invariant that could never fail;
- output that depended on the machine's time zone;
- a CLI that reported success after a failed write.

What conditions must hold before Claude merges, and what stays with the owner?

## Considered options

1. Keep ADR-0004: the owner merges every PR.
2. Claude merges every PR, with no conditions.
3. Claude merges after an independent review and a green CI, and the owner gates plans and phases.

## Decision outcome

Chosen option: 3, decided by the owner.

Every pull request goes through these steps before Claude squash-merges it:

1. **Branch and template:** a `<type>/<issue>-<slug>` branch, and a PR filled in with the template (plan section 2).
2. **Independent review:** a separate review agent, without the author's context, reviews the diff for:
   - correctness;
   - determinism;
   - test gaps;
   - for docs, factual accuracy against the repository.
3. **Findings handled:** blocker and should-fix findings are fixed in the same PR, or explicitly answered in it. The PR description lists them.
4. **Green CI** on the PR's latest commit, for every job, including `pnpm test:golden`.
5. **Squash-merge**, so each PR is one commit on `main`.

Unchanged rules:

- Golden snapshot updates need a written reason in the PR (plan section 9).
- A change to scope, architecture or technology needs an ADR and a plan edit in the same PR (plan section 2).
- No pushes to `main` except tags.
- At most two pull requests are open at a time.

The owner's role:

- approves each phase plan and each phase close, including the realism or demo checks in its exit criteria;
- decides open questions;
- may review, comment on or revert any pull request at any time.

A review comment from the owner on an open PR blocks its merge until it is answered.

### Consequences

- Good: work no longer waits for the owner's merge, and the review is still done by a reviewer other than the author.
- Good: every merged PR records its review findings and how they were handled.
- Bad: the owner may understand less of the code day to day. Phase reports, realism checks and the optional learning notes are the main way to keep up; the plan's "review backlog" risk is restated accordingly.
- Bad: a review agent can miss what a domain expert would see. The phase-level realism checks remain the owner's.

## Note (2026-10-21, Phase 10 plan, P10-04): the local gate in place of green CI

**Awaiting the owner's review.** This note records a practice; it is not the owner's decision. The owner decided this record, so only the owner can confirm or change it (P10-11, the final report's register of decisions awaiting the owner).

- **What happened:** GitHub Actions has not run since PR #149 (the spending limit of the account); the last green CI on `main` is `cfed3a0`, the Phase 5 close. Step 4 above ("Green CI on the PR's latest commit, for every job, including `pnpm test:golden`") could not be met from then on.
- **The practice since PR #149:** step 4 has been met by the local equivalent of every CI job on the pull request's final commit: run by hand from PR #150 (PRs #150–#190, the Phase 7 plan #180 excepted; each PR's "Gate" section names the commit and who ran what; Phase 6 and Phase 7 reports), and from PR #191 on by the **local merge gate**, `pnpm gate` (#178, `scripts/gate.ts`; runbook "Merge gate"): the same jobs (`pnpm verify --concurrency=1`, `pnpm test:golden`, `pnpm test:e2e`, the stack smoke and `pnpm test:reconcile`) one after the other on a disposable Compose project, and since #228 under the host-wide heavy lock. The runbook's rerun table names the steps a pull request must run for the paths it changes (`GATE_STEPS`); the gate's record (commit, each step's duration and result, image digests, free disk) goes into the pull request and the phase log. Steps 1–3 and 5 are unchanged.
- **What differs from CI:** the gate runs on the owner's machine, not on a clean runner; its record names the commit and image digests, but nobody else re-runs it. The Phase 10 plan says so wherever it relies on it (success criterion 2, "by the local gate while GitHub Actions is unavailable", master plan rev. 10).
- **When Actions runs again:** step 4 is green CI again as written; the gate stays the way to run the same jobs locally. If the owner restores Actions before the `v1.0.0` tag, one CI run on the release candidate is added to the final report as further evidence.
