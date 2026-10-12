# Phase 00 – Foundations: report

Period: 2026-10-10 to 2026-10-12. Milestone: [Phase 00 – Foundations](https://github.com/kubilayture/shopfloor-twin/milestone/1).

## Outcome against exit criteria

| #   | Exit criterion                                        | Result | Evidence                                                                                                                                                        |
| --- | ----------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fresh clone: `pnpm install && pnpm verify` passes     | Met    | Fresh clone of the #2 branch passed (PR #8); CI `verify` job installs with `--frozen-lockfile` on a clean runner for every PR                                   |
| 2   | CI green on `main`                                    | Met    | Run [38305098760](https://github.com/kubilayture/shopfloor-twin/actions/runs/38305098760) on `main` after merging PR #14: `verify` and `stack smoke` both green |
| 3   | `docker compose up` shows healthy database and broker | Met    | `pnpm stack:smoke` locally and in the CI `stack smoke` job: TimescaleDB present, anonymous MQTT refused, retained message survives a broker restart             |
| 4   | `docs/STATUS.md` in place                             | Met    | Fixed layout from plan section 10, updated in every PR                                                                                                          |

## Delivered

| Issue | Pull request | What                                                                                                                              |
| ----- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| #1    | #7           | Docs skeleton, STATUS, phase plan and log, ADR-0001, ADR-0004, plan rev. 3                                                        |
| #2    | #8 → #9      | pnpm 12 workspace with catalog, Turborepo, strict TypeScript, Prettier, `pnpm verify`, `@shopfloor/contracts`, ADR-0002, ADR-0003 |
| #3    | #10          | Type-checked ESLint, plan section 8 dependency rules with tests, lefthook pre-commit hook, ADR-0005                               |
| #5    | #11          | Docker Compose: PostgreSQL 18 + TimescaleDB 2.30, Mosquitto 2.1 with authentication and persistence, `pnpm stack:*`, smoke test   |
| #12   | #13          | All documentation in English (plan rev. 4)                                                                                        |
| #4    | #14          | CI workflow, PR template, issue forms, CODEOWNERS, Renovate config                                                                |
| #6    | this PR      | Phase report and learning notes                                                                                                   |

## Metrics

- Packages: `@shopfloor/tsconfig`, `@shopfloor/eslint-config`, `@shopfloor/contracts`. No apps yet.
- Tests: 26 (9 in `contracts`, 17 in `eslint-config`), plus the 3-check stack smoke test.
- ADRs: 0001–0005, all accepted.
- Coverage thresholds: not enforced yet; they start with the first domain code in Phase 1 (plan section 9).

## Deviations from the plan

| Deviation                                               | Reason                                                                   | Recorded in                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| No branch protection; the owner's merge is the approval | Private repository on GitHub Free; an author cannot approve their own PR | ADR-0004, plan rev. 3                   |
| Learning notes briefly in Turkish, then English again   | Owner decision; mixed languages read as inconsistent                     | Plan rev. 3 and rev. 4                  |
| PR #8 merged into the #1 branch instead of `main`       | It was stacked on #7; re-opened as #9                                    | Phase log; working rule: no stacked PRs |
| Vitest 4.1.11 although Vitest 5 is stable               | Plan pins 4.x; upgrade to be its own PR with an ADR                      | ADR-0002                                |
| Prettier 3.9.9 instead of 3.9.10                        | pnpm 12's minimum release age held back a same-day release               | ADR-0002                                |
| `no-restricted-imports` instead of a boundaries plugin  | Fewer dependencies, rules are plain regexes with tests                   | ADR-0005                                |
| Database host port 5442 instead of 5432                 | Another local project uses 5432                                          | Runbook; configurable in `.env`         |
| PRs merged with merge commits, not squash-merge         | Owner's choice of merge button; plan section 8 says squash-merge         | Open question below                     |

## Known issues and carry-overs

- Renovate app not installed yet (owner action; see open questions).
- Docker Desktop has 2 GB of memory; raise it to about 6 GB before Phase 4.
- `~/Desktop/ShopFloor Twin — Project Plan.md` is the pre-repository copy of the plan and no longer matches `docs/project-plan.md`; the repository copy is the source of truth.
- The plan's CI stages 3–6 (integration, golden scenario, image builds, E2E) are added in the phases that create them.

## Open questions for the owner

1. **Merge method:** plan section 8 asks for squash-merge (one commit per PR on `main`). So far PRs were merged with merge commits. Either use "Squash and merge" from now on, or the plan is changed to allow merge commits.
2. **Renovate:** install the GitHub app for this repository only (https://github.com/apps/renovate → Configure → `shopfloor-twin`).

## Lessons

- Stacked pull requests do not fit a merge-button workflow: GitHub merges into whatever base the PR has. Dependent tasks now wait until their base is merged.
- New tool majors (pnpm 12, ESLint 10, setup-node v7, Mosquitto 2.1) changed defaults since earlier versions; reading the installed package's docs or `action.yml` before configuring avoided several wrong guesses.
- A healthcheck can be wrong in a way that looks like a broken service: the broker was fine, but the shell expanded `$SYS` inside the check.
