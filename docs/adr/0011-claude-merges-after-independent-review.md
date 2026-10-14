# ADR-0011: Claude merges after an independent review

- Status: accepted
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
