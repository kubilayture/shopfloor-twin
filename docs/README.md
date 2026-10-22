# Documentation index

Every document of the repository, what it is for, when it changes and whether a test or script checks it against the code. This is master plan section 10's table made concrete; a document added, removed or renamed is added here in the same pull request. Start with the [README](../README.md) (what the project is and how to run it), then the [master plan](project-plan.md) and [`STATUS.md`](STATUS.md).

"Checked by" names the test or script that fails when the document and the code disagree; "–" means the document is kept current by its update rule and review only. Every document was audited against the code on 2026-10-21 (P10-04, [#279](https://github.com/kubilayture/shopfloor-twin/issues/279)); the findings are under "Audit" at the end.

## Plan, status and decisions

| Document                                   | Purpose                                                                                                                                                                                                                                  | Updated when                                                                     | Checked by |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------- |
| [`project-plan.md`](project-plan.md)       | The master plan: goals and success criteria, working model, plant, architecture, stack, roadmap, risks                                                                                                                                   | Scope, architecture or technology changes (with an ADR, section 2)               | –          |
| [`STATUS.md`](STATUS.md)                   | One page: current phase, done, in progress, next, blockers, health                                                                                                                                                                       | Every merged pull request                                                        | –          |
| [`adr/`](adr/README.md)                    | Architecture decision records ADR-0001 to ADR-0041 (MADR), their index and [template](adr/template.md)                                                                                                                                   | Any decision not already in the plan; an amendment when one changes              | –          |
| [`glossary.md`](glossary.md)               | Industrial and project terms, each pointing to the record that defines it                                                                                                                                                                | A new term appears in code or docs                                               | –          |
| [`dependencies.md`](dependencies.md)       | Every third-party package, container image, CI action and service, and why it exists                                                                                                                                                     | A dependency is added or removed                                                 | –          |
| [`security-review.md`](security-review.md) | Threat model per component, checklist S1–S10 with evidence, residual risks (Phase 9)                                                                                                                                                     | A component's exposure, authentication or secrets change                         | –          |
| [`final-report.md`](final-report.md)       | The v1.0 final report: what was built against the goals, each success criterion with its proof on the release commit (evidence filled by P10-10), the phase history, known limits, the register of decisions awaiting the owner, lessons | Release (P10-08 wrote it, P10-10 fills the evidence, P10-11 the owner's answers) | –          |

## Architecture, contracts and APIs

| Document                                                                               | Purpose                                                                                                | Updated when                                     | Checked by                                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md)                                                   | C4-style Mermaid views: context, containers, components, packages, runtime, deployment, concepts       | A component, interface or data flow changes      | `scripts/check-architecture.ts` in `pnpm verify`: containers, volumes, modules and imports, packages and dependencies (prose: –) |
| [`contracts/uns.md`](contracts/uns.md)                                                 | The UNS contract (version 1.5): broker users, topic tree, envelope, payloads, identity, dedup and gaps | Any UNS change (version bump required)           | The JSON Schemas only: `packages/contracts/src/uns/uns.test.ts` (prose: –)                                                       |
| [`contracts/uns/*.schema.json`](contracts/uns/) (generated)                            | JSON Schema of every UNS payload, generated from the zod schemas                                       | `pnpm --filter @shopfloor/contracts json-schema` | `packages/contracts/src/uns/uns.test.ts`                                                                                         |
| [`contracts/opcua-address-space.md`](contracts/opcua-address-space.md)                 | OPC UA node ids, types, methods and events per machine (version 1.3)                                   | Any address-space change                         | `apps/simulator/src/opcua/integration.test.ts` (parses the document)                                                             |
| [`contracts/modbus-register-map.md`](contracts/modbus-register-map.md)                 | WSH-01's Modbus registers, scaling, event ring and tables (map version 2)                              | Any register change                              | `apps/simulator/src/modbus/washer-server.test.ts` (the register, cause, product and alarm tables)                                |
| [`contracts/simulator-control-api.md`](contracts/simulator-control-api.md)             | The simulator's control API (version 1.11) in prose                                                    | A control route changes                          | –                                                                                                                                |
| [`api/simulator-control.openapi.json`](api/simulator-control.openapi.json) (generated) | OpenAPI of the control API                                                                             | Generated from the routes                        | `apps/simulator/src/control/control.test.ts`                                                                                     |
| [`api/mes.openapi.json`](api/mes.openapi.json) (generated)                             | OpenAPI 3.1 of the MES REST API                                                                        | Generated from the zod routes                    | `apps/mes-server/src/realtime.test.ts`, `identity.test.ts`, `version.test.ts` (`info.version`)                                   |
| [`api/mes-realtime.schema.json`](api/mes-realtime.schema.json) (generated)             | JSON Schema of every WebSocket message                                                                 | Generated from the zod schemas                   | `apps/mes-server/src/realtime.test.ts`                                                                                           |
| [`api/realtime.md`](api/realtime.md)                                                   | The MES's WebSocket push: connection, session, topics, messages, delivery                              | A topic, message or connection rule changes      | – (the message shapes: `mes-realtime.schema.json`)                                                                               |
| [`api/erp-mock.md`](api/erp-mock.md)                                                   | The ERP mock's REST API: routes, token, idempotency keys, datasets, errors, environment                | A route, payload, dataset or variable changes    | `apps/erp-mock/src/api-doc.test.ts` (routes against `apiRoutes`, problem types, environment)                                     |
| [`data-model.md`](data-model.md) (generated)                                           | Entity-relationship diagram and table notes of the MES database                                        | A migration is added                             | `apps/mes-server/src/db/db.test.ts` (generated by `src/db/data-model.ts`)                                                        |

## Models and reference cases

| Document                                                       | Purpose                                                                         | Updated when                    | Checked by                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`simulation-model.md`](simulation-model.md)                   | Every stochastic model of the simulator, its parameters, outputs and validation | Simulator behaviour changes     | The state diagram: `apps/simulator/src/plant/machine.test.ts` (the rest: –)                               |
| [`oee-reference-cases.md`](oee-reference-cases.md)             | Hand-calculated OEE, bottleneck, head-time, order and line OEE cases            | OEE logic or definitions change | `packages/oee-core/src/reference-cases.test.ts`, `order-line-reference-cases.test.ts` (parse every table) |
| [`alarm-kpi-reference-cases.md`](alarm-kpi-reference-cases.md) | Hand-calculated alarm KPI cases                                                 | Alarm KPI logic changes         | `packages/alarm-core/src/reference-cases.test.ts`                                                         |
| [`spc-reference-cases.md`](spc-reference-cases.md)             | Hand-calculated SPC cases: limits, zones, Nelson rules, ties                    | SPC logic changes               | `packages/spc-core/src/reference-cases.test.ts`                                                           |

## Running, demo and operations

| Document                             | Purpose                                                                                                                                                                                                           | Updated when                                                                                        | Checked by                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`../README.md`](../README.md)       | What the project is, how to run it                                                                                                                                                                                | A capability or the start changes                                                                   | – (its quick-start block: `pnpm test:fresh-clone`, from P10-02)                                               |
| [`runbook.md`](runbook.md)           | Every command; start, stop, reset, scenarios, the gate and the heavy lock, the harnesses, troubleshooting, upgrading a pre-1.0 stack, releasing                                                                   | Operations change                                                                                   | –                                                                                                             |
| [`demo.md`](demo.md)                 | The demo scenario's scene script, runnable by hand, probe D1's margins; the recording in [`demo/`](demo/) (video, captions, a screenshot per scene; P10-07), its SHA-256, commit and length, and how to re-record | The demo's scenes change; a scene's visible behaviour changes (re-record, at most once per release) | `pnpm demo` plays the same scenes (`e2e/src/demo.ts`); `pnpm demo:record` refuses a recording over its limits |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Keep a Changelog, grouped by release                                                                                                                                                                              | Every pull request                                                                                  | –                                                                                                             |

## Phases and learning

Records of their time: a plan, log or report is written for its phase and not rewritten later (a later change is an amendment or a new entry), so a statement that was true then is not stale.

| Documents                                                              | Purpose                                                                                        | Updated when                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| [`phases/phase-NN-plan.md`](phases/) (00–10)                           | Phase scope, decisions, issue list, exit criteria, review decisions                            | Phase start; scope changes in the phase |
| [`phases/phase-NN-log.md`](phases/) (00–06, 08–10)                     | Dated entries per merged pull request: what merged, gates, deviations                          | Every merged pull request of the phase  |
| [`phases/phase-NN-report.md`](phases/) (00–10)                         | Outcome against the exit criteria, metrics, known issues, carry-overs                          | Phase close                             |
| [`phases/phase-01-realism-check.md`](phases/phase-01-realism-check.md) | The simulated golden week against factory experience, for the owner (Phase 1 exit criterion 5) | Once (Phase 1)                          |
| [`phases/phase-09-perf-results.md`](phases/phase-09-perf-results.md)   | The measured performance targets T1–T6 (ADR-0040)                                              | A `pnpm test:perf` run of record        |
| [`learning/phase-NN.md`](learning/) (00–10)                            | Concepts, a reading order of the code, review questions, an exercise; the owner's answers      | Phase close (owner adds answers)        |
| [`spikes/`](spikes/)                                                   | Spike results: OPC UA servers (#47), OPC UA alarms (#48), Modbus and the buffer (#71)          | Once, by the spike                      |

## Elsewhere in the repository

- [`apps/web/README.md`](../apps/web/README.md): the web app's development server, the nginx front and the screens.
- [`apps/simulator/golden/README.md`](../apps/simulator/golden/README.md): the golden scenarios and how their snapshots are regenerated.
- The configuration files under `config/` carry their own header comments (plant, ERP datasets, scenarios, broker).

## Audit (P10-04, 2026-10-21)

Every document above was read against the code on `main` at `0fdf488`. What was found:

**Fixed in this pull request:**

- `api/realtime.md` led with `ws://<host>:4700/api/v1/ws` and named the cookie `sft_session`: it now leads with `wss://localhost:8443/api/v1/ws` and the `__Host-sft_session` cookie (`MES_COOKIE_SECURE=on` since #241), the MES's own port only with `pnpm stack:up:dev`, and the Origin scheme check behind the front.
- The ERP mock's API had no reference: `api/erp-mock.md`, with its drift test.
- `glossary.md` had 18 terms, a copy of master plan section 13: completed, and section 13 points to it.
- `dependencies.md`: `@playwright/test`, the nginx, Prometheus and Grafana images and `actions/upload-artifact` were missing; the "used in" column of `zod`, `yaml`, `node-opcua`, `mqtt`, `modbus-serial`, `fast-check`, `testcontainers` and the Node.js image was incomplete.
- `simulation-model.md` said failures, shifts, operators and materials were "added by later issues"; they are documented below it.
- `contracts/uns.md` said the `mes/…` class is published "Phase 4 onwards"; it is reserved and nothing publishes it in v1.
- Master plan section 5 showed an unrendered diagram placeholder (now a link to the architecture views), section 10 named `docs/api/openapi.json`, which never existed (now the real files, plus this index, `demo.md`, `final-report.md` and `api/erp-mock.md`).
- ADR-0011 said nothing about the local gate standing in for green CI since PR #149: a dated note, awaiting the owner's review. The ADR index listed ADR-0011 between 0007 and 0008: moved into order.

**Fixed since, by P10-02 and P10-03 ([#277](https://github.com/kubilayture/shopfloor-twin/issues/277), [#278](https://github.com/kubilayture/shopfloor-twin/issues/278)):**

- `../README.md`: its quick start failed on a fresh clone; since #277 it is the one command line `pnpm test:fresh-clone` runs, and since #278 the README has "Run it", "Screens", "Develop" and "Documentation".
- `runbook.md`: "Continuous integration" described `ci.yml` as running; it now says GitHub Actions is unavailable and the local `pnpm gate` is the merge gate. The dated upgrade notes inside "Full stack" (and in "Run the MES server" and "HTTPS and the dev CA") are in one section, "Upgrading a stack from before 1.0"; the current procedure comes first, with a table of every command (#278).
- `STATUS.md`: it named Phase 9 the current phase and kept every pull request since Phase 1 under "Done since last update"; it is trimmed to master plan section 10's fixed layout, Phase 10 current, the history left to the phase logs and reports (#278).

**Fixed since, by P10-05 ([#280](https://github.com/kubilayture/shopfloor-twin/issues/280)):**

- `architecture.md`: it was stale throughout (phase labels, no `pki`, `migrate`, `opcua-tools` or `edge` network, no diagrams); it is rewritten as C4-style Mermaid views (context, containers, observability, MES modules, gateway, simulator, packages, ten runtime sequences, deployment, cross-cutting concepts), checked by `scripts/check-architecture.ts` in `pnpm verify`.

**Fixed since, by P10-09 ([#284](https://github.com/kubilayture/shopfloor-twin/issues/284)):**

- `api/mes.openapi.json` (generated): it had `info.version` `0.0.0`, and its description said "API of the MES (Phases 4 and 5)" and "login sets the session cookie sft_session". `apps/mes-server/src/http.ts` now describes the current scope, the HTTPS front and the `__Host-sft_session` cookie (`sft_session` only with `MES_COOKIE_SECURE=off`), declares the tags `orders`, `execution`, `terminal`, `genealogy` and `quality`, and takes `info.version` from the root `package.json` (`1.0.0`). The file is generated as deployed (`MES_COOKIE_SECURE=on`), so the login route (`POST /api/v1/session`) names `__Host-sft_session` with `Secure` too, where it said `sft_session`. The file is regenerated; `apps/mes-server/src/version.test.ts` checks the version and the login's cookie.
- `runbook.md` gained "Releasing": the candidate, its closing gate, the sign-off's docs-only pull request and check, and the owner's tag and release.

**Known gaps, recorded:**

- There is no `phases/phase-07-log.md`: Phase 7 kept none (its report says so, "Deviations").
- Prose not checked by any test: `contracts/uns.md` (its JSON Schemas are), `contracts/simulator-control-api.md` (its OpenAPI is), `api/realtime.md` (its message schema is), `dependencies.md`, `security-review.md`, `runbook.md`, this index.

**Current, checked against the code:** `contracts/modbus-register-map.md` (every register, the ring, the read limits and the poller's batching), `contracts/uns.md` (users and client ids against `config/mosquitto/dynamic-security.json`, the ten schemas, incident types, defaults), `contracts/opcua-address-space.md`, `contracts/simulator-control-api.md` (1.11 as the code), `data-model.md` (through migration `0033`), the three reference-case documents, `security-review.md` (S1–S10 as of the Phase 9 close), `demo.md`, the ADR index (0001–0040).
