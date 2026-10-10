# ADR-0001: Record architecture decisions

- Status: accepted
- Date: 2026-10-10
- Deciders: owner, Claude

## Context and problem statement

Claude sessions do not remember each other, and the owner reviews changes asynchronously. A decision made in one session must be findable, with its reasons, by every later session and by the owner months later. Where do decisions live, and in what form?

## Considered options

1. Decisions only in the project plan.
2. Decisions in pull request descriptions and issue comments.
3. Architecture decision records in the repository, in MADR format.

## Decision outcome

Chosen option: 3, architecture decision records in `docs/adr/`, numbered `NNNN-title.md`, using the [MADR](https://adr.github.io/madr/) structure (context, options, outcome, consequences).

- The project plan stays the source of truth for scope and design; an ADR records any decision not already in the plan, and when an ADR changes the plan, the plan is edited in the same pull request (plan section 2, change control).
- ADRs are immutable once accepted. A changed decision gets a new ADR that marks the old one "superseded by ADR-NNNN".
- Numbers 0002 and 0003 are reserved for the stack and monorepo ADRs named in the plan.

### Consequences

- Good: decisions travel with the code and are reviewed in pull requests like code.
- Good: a new session can reconstruct why things are the way they are.
- Bad: small overhead per decision; mitigated by the short template in `docs/adr/template.md`.
