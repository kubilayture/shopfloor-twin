# ADR-0002: Stack and versions

- Status: accepted
- Date: 2026-10-10
- Deciders: owner (plan section 6), Claude (exact pins)

## Context and problem statement

Plan section 6 chooses the stack and leaves rows marked "latest stable at Phase 0" to be pinned here. Exact versions must be recorded so every later upgrade is a visible, reviewable change.

## Decision outcome

### Pinned in Phase 0

| Tool        | Version                                               | Notes                                                                                                                                                          |
| ----------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js     | 26.11.1 (`>=26.11.1 <27` in `engines`, `.nvmrc` = 26) | On 2026-10-10 the Node.js release index still lists 26.x as "Current"; promotion to Active LTS is scheduled for later in October 2026 and needs no change here |
| pnpm        | 12.11.2 (`packageManager` field)                      | pnpm switches itself to this version; no Corepack, which Node.js 25+ no longer bundles                                                                         |
| Turborepo   | 2.11.7                                                |                                                                                                                                                                |
| TypeScript  | 6.0.3                                                 | Stays on 6.0.x: typescript-eslint 8.71 supports `>=4.8.4 <6.1.0`; TypeScript 7.0.2 is out but has no typed-lint support yet                                    |
| Vitest      | 4.1.11                                                | Vitest 5.0 has been stable since 2026-09-03. The plan pins 4.x; moving to 5 is a separate pull request with its own ADR                                        |
| Prettier    | 3.9.9                                                 | 3.9.10 was published on 2026-10-10 and is held back by pnpm's minimum release age (below)                                                                      |
| @types/node | 26.6.5                                                | Matches the Node.js major                                                                                                                                      |

Lint tooling (#3) and the libraries of later phases (Zod, node-opcua, MQTT.js, Kysely, Fastify, React and others) are pinned in the catalog when they first enter the lockfile and listed in `docs/dependencies.md`. The catalog is the live record of versions; this table is the Phase 0 baseline. A choice that departs from plan section 6 needs its own ADR.

### Version rules

- All versions live once, in the pnpm `catalog` in `pnpm-workspace.yaml`; packages refer to them as `catalog:`. The lockfile pins exact versions.
- pnpm 12's default minimum release age stays on: very recent versions are not installed (observed: a version published the same day was held back, and pnpm offered to add an exclusion). No `minimumReleaseAgeExclude` entries without an ADR. This blocks most compromised-package attacks, which are typically caught and unpublished within hours.
- `engineStrict: true`: install fails on the wrong Node.js major.
- A major upgrade is a separate pull request with an ADR (plan section 6).

### Licensing

TimescaleDB compression and continuous aggregates are under the Timescale License (TSL), which allows self-hosted use like this project; the project does not offer TimescaleDB as a service. PostgreSQL, Mosquitto and all npm dependencies used so far are under OSI-approved licenses.

### Consequences

- Good: one place to read and change every version; upgrades show up as small catalog diffs.
- Bad: the release-age gate means a same-day security fix needs a deliberate exclusion, which is an ADR-worthy event by design.
