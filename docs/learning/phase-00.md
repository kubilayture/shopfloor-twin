# Phase 00 – Foundations: learning notes

Phase 0 built no plant software yet. It built the workshop: the rules, tools and safety nets that every later phase relies on. This file explains them, gives a reading order, asks review questions, and ends with an exercise you do on your own. The phase closes when sections 4 and 5 are done.

## 1. Concepts

### Monorepo, workspace and catalog

All components (simulator, gateway, MES, ERP mock, web) and shared packages live in one repository. pnpm treats each folder under `apps/` and `packages/` as its own package and links them by name (`@shopfloor/contracts`) through `workspace:*`. Versions of third-party libraries are written once in the **catalog** in `pnpm-workspace.yaml`. A change to a shared contract and every consumer of it can therefore land in one pull request.
Read: [pnpm workspaces](https://pnpm.io/workspaces), [pnpm catalogs](https://pnpm.io/catalogs).

### Turborepo

`pnpm verify` asks Turborepo to run `lint`, `typecheck` and `test` in every package, in dependency order, and caches each result by its inputs. Run `pnpm verify` twice: the second run is answered from the cache.
Read: the docs bundled with the installed package, `node_modules/turbo/docs/`.

### TypeScript without a build step (ADR-0003)

Node.js 26 strips type annotations and runs `.ts` files directly; `tsc` only checks types and never writes JavaScript. That is why imports end in `.ts`, and why `erasableSyntaxOnly` forbids `enum` and other features that would need code generation.
Read: [Node.js: running TypeScript natively](https://nodejs.org/api/typescript.html).

### Static checks: formatter, linter, type checker

- **Prettier** decides how code looks. No style discussions in review.
- **TypeScript** (`strict` plus extra flags) proves type correctness, for example that an array access may be `undefined` (`noUncheckedIndexedAccess`).
- **ESLint with type information** catches what compiles but is wrong. The key rule for this project is `no-floating-promises`: an async call nobody awaits loses errors silently, and MQTT, OPC UA and database code is all async.

### Architecture enforced by lint (ADR-0005)

Plan section 8 says the simulator never imports MES code, packages never import apps, `sim-core` and `oee-core` stay pure, and MES modules talk only through `index.ts`. `packages/eslint-config/src/dependency-rules.ts` turns those sentences into `no-restricted-imports` patterns, and the test file proves each one with a rejected and an allowed example. An architecture that only exists in a diagram erodes; one that fails the build does not.

### Pre-commit hook and CI: two safety nets

The **lefthook** pre-commit hook formats and lints only the files you stage, so mistakes are caught in seconds on your machine. **CI** (`.github/workflows/ci.yml`) repeats the full check on a clean machine for every pull request and every push to `main`. The hook is fast and can be skipped (`--no-verify`); CI is complete and cannot. Because branch protection is unavailable (ADR-0004), "merge only when CI is green" is a rule you keep, not one GitHub enforces.

### Supply-chain defences

Three small measures, one idea: do not run code nobody has looked at yet.

- pnpm's **minimum release age**: very new versions are not installed.
- **Denied install scripts:** `allowBuilds: { lefthook: false }`.
- **GitHub Actions pinned by commit SHA**, not by a movable tag.

Renovate later proposes upgrades as normal, reviewable pull requests.

### Docker Compose, healthchecks and the infrastructure stack

`docker-compose.yml` defines the two infrastructure services of plan section 5: `db` (PostgreSQL 18 + TimescaleDB) and `broker` (Mosquitto). A **healthcheck** tests real readiness: `pg_isready` for the database; for the broker, an actual MQTT subscription to `$SYS/broker/uptime`. Secrets live only in the git-ignored `.env`. The broker's password file is generated from it on every start.

### MQTT basics used so far

- **Topic:** a slash-separated path. The UNS uses `orbis/gebze/{area}/{work center}/{equipment}/{class}/{name}`, which is the ISA-95 hierarchy written as a path. `+` and `#` are wildcards in subscriptions, which is why `equipmentTopic()` rejects them as segment names.
- **Retained message:** the broker keeps the last message on a topic and hands it to every new subscriber at once. This is how "current state" topics work.
- **Persistence:** retained messages and QoS 1 queues survive a broker restart. The smoke test proves this.
- Read: [MQTT essentials (HiveMQ)](https://www.hivemq.com/mqtt/), [Mosquitto configuration](https://mosquitto.org/man/mosquitto-conf-5.html).

### Architecture decision records

A decision that is not in the plan gets an ADR: context, options, decision, consequences. Accepted ADRs are never edited; a new ADR supersedes an old one. ADR-0001 to ADR-0005 record this phase's decisions.
Read: [MADR](https://adr.github.io/madr/).

## 2. Reading order

| #   | File                                                                              | Look for                                                           |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `docs/STATUS.md`, `docs/phases/phase-00-report.md`                                | Where the project stands and what changed against the plan         |
| 2   | `docs/adr/0003-monorepo-layout.md`                                                | Why there is no build step, and what it forbids                    |
| 3   | `pnpm-workspace.yaml`, `package.json`, `turbo.json`                               | How one command (`pnpm verify`) fans out to every package          |
| 4   | `packages/tsconfig/base.json`                                                     | Each compiler flag; try to name a bug each one prevents            |
| 5   | `packages/contracts/src/uns-topic.ts` and its test                                | The smallest complete example of code + test in the repo           |
| 6   | `packages/eslint-config/src/dependency-rules.test.ts`, then `dependency-rules.ts` | The test table reads as the specification of plan section 8        |
| 7   | `lefthook.yml`, `.github/workflows/ci.yml`                                        | The same checks, local and on the server                           |
| 8   | `docker-compose.yml`, `config/mosquitto/`, `scripts/stack-smoke.sh`               | How the infrastructure starts, proves itself healthy and is tested |
| 9   | `.github/pull_request_template.md`, `docs/adr/0004-…`                             | The rules every future change follows                              |

## 3. Review questions

Answer from the code and docs, in your own words. Short answers are fine.

1. `pnpm verify` passes on your laptop but fails in CI with a lockfile error. What happened, and what is the fix?
2. Why does `packages/contracts/src/index.ts` import `./uns-topic.ts` with the `.ts` extension? What would break if you wrote an `enum` in that package?
3. In `apps/simulator` someone writes `import { x } from '@shopfloor/mes-server'`. Which rule stops it, where is the rule defined, and which test proves it works?
4. Why are `sim-core` and `oee-core` allowed only relative imports in their source files, while their test files may import `vitest`? Connect your answer to the simulator's determinism goal (plan section 4).
5. What exactly does the broker healthcheck test, and why is "the container is running" not enough? What bug did the first version of this healthcheck have?
6. A machine publishes its state as a retained message, then the broker restarts. What does a client that subscribes afterwards receive, and which two settings make that true?
7. Without branch protection, what stops a pull request with red CI from being merged? What would change if the repository became public?
8. Why are GitHub Actions pinned to a commit SHA instead of `@v7`, and how will they still get updated?
9. Name two places where the project refuses very new or unreviewed third-party code, and the risk each one addresses.
10. Plan section 7 says MES modules talk to each other only through `index.ts`. Give one benefit of that rule for the future, and show which test case covers it.

## 4. Hands-on exercise

Goal: make one small change entirely on your own, through the full workflow: issue → branch → code + test → `pnpm verify` → PR → green CI → merge.

**Task: add a builder for system topics.** The UNS `_sys` class (plan section 5) has a different shape from equipment topics: `orbis/gebze/_sys/{component}/{instance}/{name}`, for example `orbis/gebze/_sys/edge-gateway/gw-01/status`.

1. Create an issue from the **Task** form, then a branch `feat/<issue>-system-topic`.
2. In `packages/contracts/src/uns-topic.ts`, add `systemTopic({ component, instance, name })` that returns that path. Every segment must follow the same rules as `equipmentTopic` (lower-case kebab, no wildcards). Reuse the validation instead of copying it.
3. Export it from `src/index.ts`.
4. Add tests next to the existing ones: one valid path, and at least three invalid segments, one of them an MQTT wildcard.
5. Run `pnpm verify`, commit (watch the pre-commit hook run), push and open a PR using the template. Fill in every section; the "Concepts" section can be two sentences.
6. Merge once CI is green.

Stretch goal: add a case to `dependency-rules.test.ts` proving that `packages/contracts` may **not** import `@shopfloor/erp-mock`. Does it pass without changing the rules? Why?

## 5. Owner's answers and notes

_To be filled in by the owner. The phase closes, and the `phase-00` tag is created, once the review questions are answered and the exercise PR is merged._

### Answers

1.
2.
3.
4.
5.
6.
7.
8.
9.
10.

### Exercise

- Issue:
- Pull request:
- Notes (what was surprising or unclear):
