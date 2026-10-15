# ShopFloor Twin — Project Plan

Oct 10, 2026 · @Kubilay

> **Change note — rev. 2 (10 Oct 2026).** Review fixes before Phase 0: (1) new machine state `Stopped` for short self-clearing stops; the simulator reports raw states and only the MES classifies micro-stops, with ground truth using the same threshold (sections 4, 7). (2) Interim "scheduled time" rule for Phases 1–6, before orders exist (section 7). (3) Lossless OPC UA delivery of state changes and events at 60×, decided by a Phase 2 spike (sections 5, 11, 12). (4) State intervals split at hour as well as shift boundaries for continuous aggregates (sections 7, 11). (5) Night shift and production-week boundaries defined (section 3). (6) Short breakdowns stay availability loss; OEE dashboard separates own and external availability loss (section 7).
>
> **Change note — rev. 3 (10 Oct 2026).** Repository is private on GitHub Free, so branch protection is unavailable; the owner's merge is the approval and "CI green before merge" is a working rule, see ADR-0004 (sections 2, 8). Learning files and PR "Concepts" notes are written in Turkish (sections 2, 10).
>
> **Change note — rev. 4 (11 Oct 2026).** All documentation, including learning files and PR "Concepts" notes, is written in English; the Turkish rule of rev. 3 is withdrawn because mixed languages read as inconsistent (sections 2, 10).
>
> **Change note — rev. 5 (12 Oct 2026).** Phases 1–6 run from a fixed weekly production schedule file (variant campaigns per CNC), the counterpart of the initial stock file, until released orders replace it in Phase 7 (sections 4, 11). Found while planning Phase 1: the plan defined what is in stock but not what to make.
>
> **Change note — rev. 6 (15 Oct 2026).** Claude merges pull requests after an independent review agent and a green CI; the owner approves plans and phases and may review or revert any PR (ADR-0011, superseding ADR-0004's merge rule; sections 2, 8, 12).

ShopFloor Twin is a realistic simulation of a discrete-manufacturing plant plus a working MES core built on top of it, developed end to end in TypeScript. The simulator plays the role of the physical shop floor; everything above it (edge gateway, MQTT Unified Namespace, historian, MES, operator and management UIs) is built the way it would be in a real plant, so the same software could in principle be pointed at real machines.

## 1. Purpose, goals and non-goals

**Purpose.** Give the owner hands-on, reviewable experience of the complete industrial software workflow, from a machine signal to an OEE report and a traceable serial number, and produce a portfolio project that holds up in a technical interview.

**Goals**

1. A deterministic, configurable simulation of one plant: a CNC machining cell feeding an assembly line, with realistic failures, micro-stops, changeovers, tool wear, quality drift, shifts and operators.
2. Machines exposed the way real equipment is: OPC UA servers per machine, plus one legacy device on Modbus TCP (a brownfield reality).
3. An edge gateway that collects, normalizes and publishes data into an MQTT Unified Namespace organized by the ISA-95 equipment hierarchy.
4. An MES core: equipment states and downtime with reason codes, OEE per ISO 22400-2 definitions, alarms, production orders received from a mock ERP, routing execution, material and serial genealogy, quality checks and SPC, shift handling.
5. Interactive control: a simulation console to change speed, inject faults, starve material, release orders and act as the operator.
6. Professional engineering throughout: tests at every level, CI, typed contracts, architecture decision records, and documentation and tracking files updated at the end of every phase.

**Non-goals (explicitly out of scope for v1)**

- Real PLC hardware, ladder logic or IEC 61131-3 programming.
- A full ERP, finance, purchasing or HR functions; the ERP is a mock that only exchanges orders and confirmations.
- Cloud deployment, multi-tenancy, high availability and horizontal scaling.
- Enterprise identity (SSO/OIDC); v1 uses local accounts with roles.
- Sparkplug B encoding; v1 uses JSON payloads with versioned schemas. Sparkplug B is a candidate for a later phase.
- Mobile native apps; the operator terminal is a responsive web UI for a tablet.

**Success criteria for v1**

| # | Criterion | How it is verified |
| --- | --- | --- |
| 1 | The whole system starts with one command on a clean machine | `docker compose up` on a fresh clone, documented in README |
| 2 | The same seed and scenario always produce the same events and KPIs | Golden-scenario test in CI compares output with a committed snapshot |
| 3 | OEE numbers match hand-calculated reference cases exactly | Reference-case unit tests in the OEE package |
| 4 | A finished serial number can be traced back to its raw-material lot, machines, operators and test results | End-to-end test plus a traceability screen |
| 5 | Data survives a broker outage without loss | Integration test: broker stopped and restarted, gateway buffer replayed, no gaps |
| 6 | Every phase closes with updated docs, a phase report and owner sign-off | Phase checklist in the tracking files |

## 2. Working model

Claude writes the code; an independent review agent reviews every change before Claude merges it, and the owner approves the plan and every phase close (ADR-0011). The repository is the shared memory: Claude sessions do not remember each other, so every session starts by reading the tracking files and ends by updating them.

**Roles**

| Role | Responsibilities |
| --- | --- |
| Owner (you) | Creates the GitHub repo and connects it to Claude; approves the plan and every phase, including its realism or demo checks; may review, comment on or revert any pull request (ADR-0011); completes the learning exercise of each phase if they wish; decides on open questions |
| Claude (developer) | Implements tasks on branches; writes tests and docs with the code; opens pull requests with an explanation aimed at learning; has each one reviewed by an independent review agent, fixes the findings and squash-merges when CI is green (ADR-0011); updates tracking files; proposes ADRs for any decision not already in this plan |

**Unit of work.** One task = one GitHub issue = one branch = one pull request. A task is sized to be reviewable in under one hour (as a guideline, roughly 400 changed lines excluding generated files and fixtures).

**Session protocol (every Claude session)**

1. Read `docs/STATUS.md`, the open phase in `docs/phases/`, and the issue being worked on.
2. Confirm the task's acceptance criteria; if anything conflicts with this plan, stop and raise it instead of guessing.
3. Implement with tests; run the full local check (`pnpm verify`).
4. Open a pull request using the template; update `docs/STATUS.md` and the phase log.

**Pull request content (template-enforced)**

- What changed and why, linked to the issue and to the plan section.
- A "How to review" walkthrough: which files to read first, in what order.
- A "Concepts" note: the industrial or engineering ideas involved, in plain language.
- Test evidence: which tests were added, and the CI result.
- Docs touched: README, architecture, ADR, API or UNS spec, changelog.

**Definition of Done (a task)**

- [ ] Acceptance criteria in the issue are met
- [ ] Unit tests added or updated; integration or E2E tests where the task crosses a process boundary
- [ ] `pnpm verify` passes locally and CI is green on the latest commit
- [ ] Independent review agent run; findings fixed or answered in the pull request (ADR-0011)
- [ ] No new lint suppressions without a comment explaining why
- [ ] Public contracts (OPC UA address space, UNS topics, REST API, DB schema) documented and versioned
- [ ] `CHANGELOG.md` entry under "Unreleased"
- [ ] `docs/STATUS.md` updated

**Definition of Done (a phase)**

- [ ] All phase issues closed or explicitly moved to a later phase with a reason
- [ ] Exit criteria of the phase (section 11) demonstrated and recorded
- [ ] Phase report written in `docs/phases/phase-NN-report.md`
- [ ] Learning notes written in `docs/learning/phase-NN.md`, with review questions
- [ ] Owner approved the phase close, including its realism or demo checks (the hands-on exercise and review answers are optional for the owner; the learning notes themselves are required)
- [ ] Git tag `phase-NN` created and release notes published on GitHub

**Change control.** This plan is the source of truth for scope and design. A change to scope, architecture or technology needs an ADR in `docs/adr/` and a matching edit to this plan in the same pull request, so the two never disagree.

## 3. The simulated plant

The plant is a fictional automotive-hydraulics supplier, Orbis Components, Gebze site, making two variants of a hydraulic valve block. Aluminium blanks are machined on two parallel CNC machines, washed, assembled by an operator, leak-tested and packed. All numbers below are configurable defaults chosen for the simulation, not industry data; they live in versioned YAML files under `config/plant/`.

**ISA-95 equipment hierarchy**

- Enterprise: Orbis Components
  - Site: Gebze
    - Area: Machining → Work center: Cell M1 → CNC-01, CNC-02, WSH-01
    - Area: Assembly → Work center: Line A1 → ASM-01, LKT-01, PCK-01

**Equipment**

| ID | Equipment | Operation | Interface | Behaviours the simulator models |
| --- | --- | --- | --- | --- |
| CNC-01, CNC-02 | Horizontal machining centre (parallel pair) | OP10 Machining | OPC UA | Program per variant, tool life and wear, spindle and coolant faults, door-interlock micro-stops, laser-marked serial (DMC) at cycle end |
| WSH-01 | Conveyor washer | OP20 Wash | Modbus TCP (legacy) | Bath temperature, conveyor speed, heater fault; exposes only registers, no semantics |
| ASM-01 | Manual assembly station | OP30 Assembly | OPC UA (station PLC) | Needs an operator logged in; component lot scanning; operator speed varies by person and shift |
| LKT-01 | Leak tester | OP40 Leak test | OPC UA | Pressure-decay measurement per part, pass/fail limits, sensor drift, calibration due |
| PCK-01 | Pack and label | OP50 Pack | OPC UA | Label printing, carton fill, label-printer out-of-stock stop |

Buffers between operations have finite capacity (defaults: OP10→OP20: 20 parts, OP20→OP30: 30, OP30→OP40: 5, OP40→OP50: 10). Full buffers block upstream machines and empty ones starve downstream machines, so bottlenecks emerge from the model rather than being scripted.

**Products and routing**

| Product | Description | OP10 ideal cycle (s) | OP20 | OP30 | OP40 | OP50 | Components consumed at OP30 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VB-100 | 2-way valve block | 240 per machine | 60 | 150 | 90 | 30 | Seal kit SK-1, spool SP-100 |
| VB-200 | 4-way valve block | 330 per machine | 60 | 210 | 90 | 30 | Seal kit SK-2, spool SP-200 |

With two CNCs in parallel, OP10 delivers one VB-100 every 120 s on average, so OP30 assembly (150 s) is the designed bottleneck. Changing variant on a CNC requires a changeover (default 25 min) that the MES records as setup time.

**Quality and rework rules**

- OP10 dimensional defects rise with tool wear; a defective part is scrapped at OP10.
- OP40 leak-test failure sends the part back to OP30 once for rework; a second failure scraps it.
- Every scrap and rework carries a reason code.

**Materials and traceability**

- Raw material and components arrive as lots (blank lot, seal-kit lot, spool lot) issued from the mock ERP.
- Each part receives its serial number at the end of OP10; the serial links to the blank lot, then to the component lots consumed at OP30.
- Finished serials are packed into cartons; carton, serial and lot form the genealogy tree.

**Time and people**

- Three shifts: 06:00–14:00, 14:00–22:00, 22:00–06:00, each with a 30-minute planned break, Monday to Friday. The production week starts with the Monday 06:00 shift and ends with the Friday night shift, which runs until Saturday 06:00; there is no Sunday night shift. A shift belongs to the date on which it starts.
- Operators are simulated people with IDs, skills and individual speed factors; ASM-01 stops when no qualified operator is present.

## 4. Simulation engine

The simulator is a deterministic discrete-event engine: the same seed, plant configuration and scenario always produce the same event stream, which makes the whole system testable. It is the only component allowed to know the "truth"; everything above it sees only what a real machine would expose.

**Core**

- Event queue ordered by simulation time, ties broken by a monotonically increasing sequence number, so ordering never depends on insertion luck.
- One master seed; each entity (machine, failure mode, operator) gets its own derived random stream, so adding a machine does not change the random sequence of the others.
- Simulation clock with a configurable start date. Every emitted value carries its simulation-time source timestamp, and every downstream calculation uses that timestamp, never wall-clock time. This is what makes OEE independent of simulation speed.

**Two run modes, one engine**

| Mode | Pacing | Outputs | Used for |
| --- | --- | --- | --- |
| Live | Simulation time paced to wall time × speed factor (0.5× to 60×), with pause and single-step | OPC UA and Modbus servers, control API | Running the full system, demos, manual exploration |
| Headless | As fast as possible, no network servers | Event log as JSON Lines plus a ground-truth KPI summary | Golden-scenario tests, statistical validation, quick what-if runs |

**Machine behaviour.** Each machine is a typed state machine with an exhaustive transition table. States: Off, Idle, Running, Stopped, Starved, Blocked, Setup, Down, PlannedStop, Maintenance. Illegal transitions throw in development and are covered by tests.

`Stopped` is a short, self-clearing stop with a cause the machine knows (door interlock, jam, operator pause); `Down` is a failure that needs repair. The machine reports both exactly as they happen and never decides whether a stop is "micro": that classification belongs to the MES (section 7), so the simulator's ground truth and the MES apply the same threshold to the same raw states.

**Stochastic models (all parameters in YAML, per machine or per operation)**

| Phenomenon | Model | Parameters |
| --- | --- | --- |
| Cycle time | Log-normal around the ideal cycle time × machine and operator speed factors | Ideal time, coefficient of variation |
| Minor stops (`Stopped`) | Poisson arrivals while running, exponential durations (not truncated: some will exceed the MES micro-stop threshold, as in a real plant) | Rate per hour, mean duration, stop cause |
| Breakdowns (`Down`) | Weibull time-to-failure in running hours, one per failure mode | Shape, scale, failure code |
| Repair | Log-normal time-to-repair, starting only when a maintenance technician is available | Median, spread, technician count |
| Tool wear | Linear wear per cycle; defect probability rises with wear; tool change resets it | Tool life, wear-to-defect curve |
| Leak-test reading | Normal distribution with slow sensor drift until calibration | Mean, sigma, drift per day |
| Operators | Presence by shift, absences, individual speed factor, skill qualification per station | Roster file |
| Production schedule | Which variant each CNC runs, as a fixed weekly list of campaigns (variant, quantity, machine); a variant change triggers a changeover | Schedule file in Phases 1–6; replaced by released orders from Phase 7 |
| Materials | Lots with finite quantity; a missing lot starves the consuming operation | Initial stock file in Phases 1–6; issued by the mock ERP from Phase 7 |

**Interactivity.** The simulator exposes a control API (REST for commands, WebSocket for live state) used by the simulation console:

- Time: pause, resume, single-step, change speed.
- Faults: inject a specific failure mode on a machine, force tool breakage, cause sensor drift.
- Infrastructure: take a machine's OPC UA server offline, stop the legacy washer responding, to exercise the gateway's error handling.
- People and material: mark an operator absent, block a component lot.
- Scenarios: YAML timelines of these actions (for example "Monday breakdown and recovery") that play back identically every run.

**Built-in validation of the simulator itself**

- Statistical tests: with fixed seeds, generated samples match their configured distributions within tolerance (goodness-of-fit tests).
- Conservation: parts in = parts out + work in progress + scrap, at any moment.
- Time accounting: for every machine, the sum of time in all states equals elapsed calendar time.
- Ground truth: in headless mode the simulator writes the KPIs it knows to be true, and the MES must reproduce them from the data it receives. From Phase 5 on, the ground-truth KPIs are computed with `oee-core` (Phase 1 writes raw state durations and counts only) and the same configuration (micro-stop threshold, planned-busy-time rule) the MES uses, so any difference points to lost or distorted data, not to two different definitions.

## 5. System architecture

Seven runtime components mirror the levels of a real plant: devices (simulator), edge (gateway), integration (MQTT Unified Namespace), operations (MES with its database) and business (mock ERP), plus the web UI. Each runs in its own container, and the simulator knows nothing about the MES.

&#91;embedded content: system architecture · 7 components by ISA-95 level\]

Only the gateway talks to machines and only the MES talks to the database; the console reaches the simulator directly because the simulator stands in for the physical world.

**Components**

| Component | ISA-95 level | Responsibility | Talks to |
| --- | --- | --- | --- |
| `simulator` | 0–2 (process, devices, control) | Discrete-event plant model; one OPC UA server endpoint per machine (ports 4841–4845); Modbus TCP server for WSH-01 (port 5020); control API | Gateway (serves it), simulation console |
| `edge-gateway` | 2 (edge) | OPC UA subscriptions and Modbus polling; normalization to canonical payloads; on-disk store-and-forward buffer; MQTT publishing; executing commands as OPC UA writes or method calls | Simulator, broker |
| `broker` | Integration | Eclipse Mosquitto; per-client credentials and topic ACLs; retained state; last-will messages | Gateway, MES |
| `mes-server` | 3 (operations) | Modular monolith: ingest, equipment states and downtime, OEE, alarms, orders and routing, genealogy, quality and SPC, shifts, users; REST API and WebSocket push | Broker, database, ERP mock, web |
| `db` | 3 | PostgreSQL with TimescaleDB: relational MES data plus time-series hypertables and continuous aggregates | MES only |
| `erp-mock` | 4 (business) | Issues production orders and material lots; receives production confirmations | MES |
| `web` | UI | MES screens, operator terminal, simulation console | MES API, simulator control API |

**Unified Namespace (UNS).** All shop-floor data flows through one MQTT topic tree that follows the ISA-95 hierarchy:

`orbis/gebze/{area}/{workcenter}/{equipment}/{class}/{name}`

| Class | Example topic | Kind | Retained |
| --- | --- | --- | --- |
| `state` | `orbis/gebze/machining/cell-m1/cnc-01/state/current` | Current machine state | Yes |
| `telemetry` | `…/cnc-01/telemetry/spindle-load` | Sampled process values | Yes (last value) |
| `events` | `…/cnc-01/events/cycle-complete` | Discrete events: cycle complete with serial and result, tool change | No |
| `alarms` | `…/cnc-01/alarms/spindle-overload` | Alarm lifecycle: active, acknowledged, cleared | Yes |
| `cmd` / `cmd-res` | `…/cnc-01/cmd/load-program` | Commands from MES and their responses | No |
| `mes` | `…/assembly/line-a1/asm-01/mes/active-order` | Context published by MES for HMIs | Yes |
| `_sys` | `orbis/gebze/_sys/edge-gateway/gw-01/status` | Component health, last-will "offline" | Yes |

Every payload uses one envelope: schema name and version, source timestamp, gateway receive timestamp, value, unit, quality (`good`, `uncertain`, `bad`), and a per-source sequence number. Schemas are defined once in the `contracts` package and published as JSON Schema in `docs/contracts/`.

**Delivery guarantees**

- MQTT QoS 1 everywhere: at-least-once delivery.
- The MES ingest is idempotent: events are deduplicated by source and sequence number, so a re-delivered message changes nothing.
- Sequence gaps are detected and logged as data-quality incidents.
- The gateway buffers to disk while the broker is unreachable and replays in order when it returns.
- No transition is lost between machine and gateway, at any simulation speed. At 60× a 10-second stop lasts about 170 ms of wall time, which an OPC UA monitored item with default settings (one sampling interval, queue size 1) can silently merge away. State changes, cycle completions and alarms are therefore delivered as OPC UA events, or as monitored items with a queue size above 1, `discardOldest = false` and a sampling interval of 0 (exception-based); each carries the source sequence number so the gateway can prove completeness. The Phase 2 spike chooses between the two and records it in an ADR. Sampled telemetry (spindle load, temperatures) may be decimated; state and events may not.

**Main data paths**

1. Telemetry and events: machine → OPC UA monitored item (or Modbus poll) → gateway normalizes → UNS → MES ingest → TimescaleDB.
2. Equipment state: state changes become state intervals in the MES; operators or rules attach downtime reason codes; OEE is computed from intervals and counts.
3. Orders down: ERP mock → MES order released → MES publishes `cmd/load-program` → gateway calls the machine's OPC UA method → response published on `cmd-res`.
4. Confirmations up: MES aggregates good, scrap and material consumption per order operation → sends confirmations to the ERP mock.
5. UI: MES pushes changes over WebSocket; the simulation console talks only to the simulator's control API.

## 6. Technology stack

The stack is TypeScript end to end on Node.js 26 LTS, PostgreSQL 18 with TimescaleDB, and React on Vite 8. Versions marked "verified" were checked against release notes on 10 October 2026; the others are pinned to their latest stable release in Phase 0, recorded in ADR-0002 and enforced by the lockfile.

| Area | Choice | Version policy | Why this choice |
| --- | --- | --- | --- |
| Runtime | Node.js | 26.x, verified: promoted to Active LTS in October 2026 ([schedule](https://github.com/nodejs/nodejs.org/pull/8826/files)) | Long support window covers the whole project |
| Language | TypeScript, `strict` | 6.0.x, verified | TypeScript 7.0 ships without the programmatic API that typescript-eslint needs; typed linting stays on 6.x until 7.1 and typescript-eslint support land ([InfoQ](https://infoq.com/news/2026/08/typescript-7-released/)). Revisit via ADR |
| Package manager and monorepo | pnpm workspaces + Turborepo | Latest stable at Phase 0 | Strict dependency isolation; cached, dependency-aware task runs |
| Validation and contracts | Zod | Latest stable at Phase 0 | One schema gives runtime validation, TypeScript types and generated JSON Schema / OpenAPI |
| OPC UA (server and client) | node-opcua | 2.170.0 or later, verified; earlier versions have a client reconnection resource leak ([CVE-2026-68904](https://osv.dev/vulnerability/CVE-2026-68904)) | The mature full OPC UA stack for Node.js, including server, client, subscriptions, methods and companion nodesets |
| Modbus TCP | `modbus-serial` (server and client) | Latest stable at Phase 0 | Covers the legacy washer; chosen by a spike in Phase 3 if it falls short |
| MQTT broker | Eclipse Mosquitto | 2.x | Lightweight, standard, ACLs and persistence; easy to reason about |
| MQTT client | MQTT.js | 5.x | De facto Node.js MQTT client, MQTT 5 support |
| Database | PostgreSQL + TimescaleDB | PostgreSQL 18, TimescaleDB 2.x, verified compatible ([support matrix](https://www.tigerdata.com/docs/get-started/timescaledb-supported-platforms)) | One database for relational MES data and time series; hypertables, compression and continuous aggregates |
| Data access | Kysely + SQL migrations | Latest stable at Phase 0 | Type-safe SQL builder that stays close to SQL, which is a learning goal; TimescaleDB DDL is written as plain SQL. Drizzle was considered but its 1.0 is still a release candidate |
| HTTP API | Fastify | 5.x | Fast, explicit plugin model, first-class schema validation and OpenAPI generation |
| Real-time push | WebSocket (`@fastify/websocket`) | Matches Fastify | Pushes state changes to UI; no extra infrastructure |
| Logging | pino | Latest stable | Structured JSON logs, the Fastify default |
| Metrics and tracing | OpenTelemetry SDK, Prometheus endpoint | Latest stable | Standard observability; optional Grafana profile in Phase 9 |
| Web app | React 19 + Vite 8 + TanStack Router and Query | Vite 8 verified stable since March 2026 ([Vite](https://vite.dev/blog/announcing-vite8)) | The owner's existing strength; Rolldown-based builds |
| UI | Tailwind CSS 4 + shadcn/ui components | Latest stable | Accessible components owned in the repo, not a black-box kit |
| Charts | Apache ECharts (dashboards), uPlot (high-rate time series) | Latest stable | ECharts for Pareto, gauges and SPC; uPlot for thousands of live points |
| Unit and integration tests | Vitest 4 | 4.x, verified ([Vitest 4](https://voidzero.dev/posts/announcing-vitest-4)) | Same runner across packages; browser mode for components |
| Property-based tests | fast-check | Latest stable | Finds edge cases in OEE and state logic automatically |
| Containers in tests | Testcontainers for Node.js | Latest stable | Real PostgreSQL/TimescaleDB and Mosquitto in integration tests |
| End-to-end tests | Playwright | Latest stable | Full-system browser tests against Docker Compose |
| Lint and format | ESLint (flat config) + typescript-eslint type-checked rules + Prettier | Latest compatible with TypeScript 6 | Type-aware rules such as no-floating-promises matter in async I/O code |
| CI | GitHub Actions | n/a | Lint, typecheck, tests, image builds, on every pull request |
| Runtime packaging | Docker + Docker Compose | Compose spec | One-command start, profiles for optional services |
| Dependency hygiene | Renovate | n/a | Automated, reviewable upgrade pull requests |

**Rules that keep the stack consistent**

- Exact versions in the lockfile; ranges only in `package.json` where pnpm catalogs define them once for the whole monorepo.
- A major upgrade of any row above is a separate pull request with an ADR.
- No dependency is added without a line in `docs/dependencies.md` stating why it is needed.

## 7. MES modules and data model

The MES is a modular monolith: one deployable `mes-server` whose modules own their tables and talk to each other only through their public TypeScript interfaces, never through each other's tables. This keeps the code splittable later without paying for microservices now.

**Modules**

| Module | Owns | Key functions |
| --- | --- | --- |
| `master-data` | ISA-95 hierarchy, products, routings, BOMs, reason-code tree, shift patterns | CRUD with versioning; seeded from `config/plant/` |
| `ingest` | Raw telemetry and event tables | Subscribe to UNS, validate envelopes, deduplicate by source and sequence, persist, detect gaps |
| `equipment` | State intervals, downtime records | Turn state changes into closed intervals; auto-classify by rules; operator reason coding; split intervals at hour and shift boundaries so every stored interval lies inside one hour and one shift (required for correct hourly continuous aggregates); open intervals are closed provisionally at each boundary |
| `oee` | OEE results and aggregates | Calculate per equipment, work center, shift, order; continuous aggregates per hour and shift |
| `alarms` | Alarm definitions and occurrences | Lifecycle (active, acknowledged, cleared, shelved), priorities, alarm-flood detection, top-offender reports |
| `orders` | Production orders and order operations | Import from ERP mock, release, dispatch to equipment, progress, close, confirm back to ERP |
| `execution` | Operation records per serial | Track each serial through OP10–OP50, enforce routing order, rework loop, component consumption |
| `genealogy` | Lots, serials, cartons, parent-child links | Forward and backward trace queries |
| `quality` | Measurements, inspections, scrap and rework records | Limits per characteristic, SPC charts and run rules, quality holds |
| `shifts` | Shift instances, crews, handover notes | Shift calendar, shift report generation |
| `identity` | Users, roles, sessions, audit log | Local accounts; roles: operator, supervisor, maintenance, quality, admin; every write is audited |
| `realtime` | WebSocket channels | Push state, alarm and order changes to subscribed screens |

**OEE definitions.** Terms follow ISO 22400-2. Planned busy time is the scheduled time minus planned stops (breaks, planned maintenance, no scheduled order). Actual production time is time in the Running state plus time in `Stopped` episodes shorter than the micro-stop threshold.

"Scheduled" depends on the phase. In Phases 1–6 there are no production orders, so every shift in the shift calendar counts as scheduled and Idle is always an availability loss. From Phase 7, scheduled time is the time a released order is dispatched to the equipment, and Idle without one is excluded. The rule is a single configuration switch in `oee-core`, so the golden-scenario snapshots change only in the pull request that switches it, with the reason written down.

```latex
\text{Availability} = \frac{\text{Actual production time}}{\text{Planned busy time}}
```

```latex
\text{Performance} = \frac{\text{Ideal cycle time} \times \text{Produced quantity}}{\text{Actual production time}}
```

```latex
\text{Quality} = \frac{\text{Good quantity}}{\text{Produced quantity}}
```

```latex
\text{OEE} = \text{Availability} \times \text{Performance} \times \text{Quality}
```

**State-to-loss mapping**

| Equipment state | Counts as | OEE loss category |
| --- | --- | --- |
| Running | Actual production time | Performance loss if slower than ideal |
| Stopped, shorter than the micro-stop threshold | Actual production time | Performance loss (micro-stop) |
| Stopped at or above the threshold, Down, Setup | Unplanned stop within planned busy time | Availability loss |
| Starved, Blocked | Unplanned stop within planned busy time | Availability loss, flagged as external cause so it is not blamed on the machine |
| Idle (scheduled, see above) | Unplanned stop | Availability loss |
| PlannedStop, Maintenance (planned), Off, Idle (not scheduled) | Excluded from planned busy time | None |

With mixed products, performance uses the sum of ideal cycle time × quantity per product. Quality uses first-pass yield: a part reworked after a leak-test failure is not counted as good at OP40 on its first pass. The threshold between a micro-stop and a stop (default 2 minutes) is configuration, documented in an ADR. The threshold applies to `Stopped` only: a `Down` breakdown is always an availability loss, however quickly it is repaired.

Starved and Blocked are counted as availability losses on every machine, so by design every machine except the bottleneck (ASM-01) shows a visibly lower OEE than its own reliability would suggest. The OEE dashboard shows availability loss split into "own" and "external" causes, and marks the bottleneck, so this reads as line behaviour and not as a defect.

**Core data model (PostgreSQL, TimescaleDB hypertables marked)**

| Group | Tables |
| --- | --- |
| Hierarchy and master data | `site`, `area`, `work_center`, `equipment`, `product`, `routing`, `routing_operation`, `bom_item`, `reason_code` (tree), `alarm_definition`, `shift_pattern` |
| Raw shop-floor data | `telemetry_sample` (hypertable), `equipment_event` (hypertable), `ingest_source_cursor` (last sequence per source) |
| Equipment and OEE | `equipment_state_interval`, `downtime_record`, `production_count` (hypertable), `oee_hourly` and `oee_shift` (continuous aggregates) |
| Alarms | `alarm_occurrence`, `alarm_transition` |
| Orders and execution | `production_order`, `order_operation`, `operation_record`, `material_consumption`, `erp_message_log` |
| Genealogy and quality | `material_lot`, `serial_unit`, `carton`, `genealogy_link`, `quality_characteristic`, `quality_measurement`, `quality_hold` |
| People and shifts | `user_account`, `role`, `shift_instance`, `crew_assignment`, `handover_note`, `audit_log` |

The full entity-relationship diagram is generated from the database into `docs/data-model.md` at the end of each phase that changes the schema.

## 8. Repository structure and conventions

One pnpm monorepo holds every runtime component, the shared packages, the plant configuration and all documentation, so a single pull request can change a contract and every consumer of it together.

```
shopfloor-twin/
├── apps/
│   ├── simulator/          # discrete-event engine, OPC UA + Modbus servers, control API
│   ├── edge-gateway/       # OPC UA client, Modbus poller, normalizer, buffer, MQTT publisher
│   ├── mes-server/         # Fastify modular monolith (src/modules/<module>/)
│   ├── erp-mock/           # orders, lots, confirmations
│   └── web/                # React app: MES, operator terminal, simulation console
├── packages/
│   ├── contracts/          # Zod schemas: UNS envelopes and topics, REST DTOs, OPC UA node ids
│   ├── oee-core/           # pure OEE and state-accounting functions, no I/O
│   ├── sim-core/           # pure DES kernel, random streams, distributions
│   ├── plant-config/       # loads and validates config/plant/*.yaml
│   ├── test-kit/           # shared fixtures, builders, Testcontainers helpers
│   └── tsconfig/, eslint-config/
├── config/
│   ├── plant/              # equipment, products, routings, shifts, operators, failure models
│   ├── scenarios/          # scripted scenario timelines
│   └── mosquitto/          # broker config and ACLs
├── db/migrations/          # ordered SQL migrations
├── e2e/                    # Playwright tests against docker compose
├── docs/                   # see section 10
├── docker-compose.yml      # + compose.observability.yml profile
└── .github/                # workflows, issue and PR templates, CODEOWNERS
```

**Dependency rules (enforced by lint)**

- `packages/*` never import from `apps/*`.
- `sim-core` and `oee-core` have no I/O and no framework dependencies; they are pure and fully unit-tested.
- Apps share data only through `contracts`; the simulator never imports MES code and vice versa.
- Inside `mes-server`, a module imports another module only through that module's `index.ts`.

**Code conventions**

- TypeScript `strict`, no `any` in production code, `unknown` at boundaries, then parse with Zod.
- No code comments unless they are a must. Names, types and tests carry the meaning. A comment is allowed only to explain a non-obvious why that the code cannot express: a workaround with its issue link, a rule taken from a standard, a deliberate trade-off, or a required lint suppression. Comments that restate what the code does are removed in review.
- Times are stored and transported as UTC (ISO 8601 in JSON, `timestamptz` in PostgreSQL); conversion to Europe/Istanbul happens only in the UI and in shift calculations.
- Errors: typed result objects inside domain code; exceptions only for programmer errors and at process boundaries.
- Configuration through environment variables validated at start-up; the process refuses to start on invalid config.
- Every service exposes `/health/live`, `/health/ready` and `/metrics`, and shuts down gracefully on SIGTERM.

**Git workflow**

- Trunk-based: `main` is always green and releasable; short-lived branches named `<type>/<issue>-<slug>`, for example `feat/42-oee-calculator`.
- Conventional Commits; squash-merge so each pull request becomes one commit on `main`.
- Merge rules (ADR-0011): Claude squash-merges a pull request after an independent review agent has reviewed it, its findings are fixed or answered in the PR, and CI is green on the latest commit. A review comment from the owner blocks the merge until answered. The repository is private on GitHub Free, where branch protection is not available, so these are working rules rather than enforced settings; nobody pushes to `main` directly (tags excepted).
- Tags: `phase-NN` at each phase close, `v1.0.0` at release; Semantic Versioning for the release.

## 9. Testing and verification

The determinism of the simulator is the backbone of testing: because a seed and a scenario fully define what happens on the shop floor, the MES's output can be checked against known truth, not just against itself.

**Test levels**

| Level | Tool | Scope | Runs |
| --- | --- | --- | --- |
| Static | TypeScript, ESLint (type-checked), Prettier, dependency-rule lint | Whole repo | Every commit (pre-commit hook) and CI |
| Unit | Vitest | Pure functions and classes: DES kernel, distributions, state machines, OEE, SPC rules, payload normalizers | Every commit and CI |
| Property-based | fast-check | Invariants: OEE components between 0 and 1; state durations sum to elapsed time; splitting an interval at a shift boundary preserves total time; ingest is idempotent under duplicates and reordering | CI |
| Statistical | Vitest + fixed seeds | Simulator distributions match configuration (goodness-of-fit within tolerance); long-run MTBF and MTTR match configured values | CI (nightly for long runs) |
| Contract | Vitest + Zod | Every UNS payload and REST DTO validates against `contracts`; OPC UA address space matches its documented node-id list; generated JSON Schema and OpenAPI are up to date | CI |
| Integration | Vitest + Testcontainers | One app against real dependencies: gateway ↔ simulator OPC UA and Modbus; gateway ↔ Mosquitto; MES ↔ TimescaleDB and Mosquitto; SQL migrations up from empty | CI |
| Component | Vitest browser mode | React components with real browser rendering, including chart and terminal screens | CI |
| Golden scenario | Headless simulator + MES pipeline | A committed scenario and seed; MES KPIs, downtime totals and genealogy must equal the simulator's ground truth and the committed snapshot | CI |
| Resilience | Docker Compose + test scripts | Broker restart, OPC UA server offline, Modbus device silent, MES restart mid-shift: no data loss, no duplicates, correct recovery | CI (nightly) |
| End-to-end | Playwright | Full system in Docker Compose: operator codes a downtime, supervisor sees OEE change, order runs to confirmation, serial traced back to lot | CI |
| Performance | Scripted load (k6 or a Node load script, decided in Phase 9) | Ingest throughput at 60× simulation speed with all machines; UI update latency | Before release |

**Coverage targets (enforced in CI)**

| Package or app | Line coverage | Branch coverage |
| --- | --- | --- |
| `oee-core`, `sim-core` | 95% | 90% |
| `contracts`, `plant-config` | 90% | 85% |
| Apps (`mes-server`, `edge-gateway`, `simulator`, `erp-mock`) | 80% | 70% |
| `web` | 70% | 60% |

Coverage is a floor, not a goal: every bug fix starts with a failing test that reproduces it.

**Reference cases for OEE.** `oee-core` ships a table of hand-calculated cases in `docs/oee-reference-cases.md`, each with inputs, step-by-step arithmetic and the expected result to four decimals. The same table drives unit tests, so the documentation and the tests cannot disagree.

**Commands**

- `pnpm verify`: format check, lint, typecheck, unit, property and contract tests. Must pass before every push.
- `pnpm test:integration`: Testcontainers suite.
- `pnpm test:e2e`: brings the Compose stack up, runs Playwright, tears it down.
- `pnpm test:golden`: runs the golden scenarios and compares snapshots; `pnpm test:golden --update` only with an explanation in the pull request.

**CI pipeline (GitHub Actions)**

1. Install with frozen lockfile and Turborepo cache.
2. `pnpm verify` across affected packages.
3. Integration tests.
4. Golden-scenario tests.
5. Build Docker images; run end-to-end tests against them.
6. Upload coverage, test reports and Playwright traces as artifacts.

Nightly: full (not just affected) test run, long statistical runs, resilience suite, dependency audit.

## 10. Documentation and tracking

Every document has one owner-facing purpose and a fixed update trigger, so nothing goes stale silently. GitHub Issues and Milestones track work items; the files in `docs/` track decisions, status and learning, and travel with the code.

**Documents and when they change**

| Document | Purpose | Updated when |
| --- | --- | --- |
| `README.md` | What the project is, quick start, screenshots | A user-visible capability or the start procedure changes |
| `docs/STATUS.md` | Single page: current phase, done, in progress, next, blockers, health of CI | Every merged pull request |
| `docs/phases/phase-NN-plan.md` | Phase scope, issue list, acceptance and exit criteria | Phase start; scope changes during the phase |
| `docs/phases/phase-NN-log.md` | Dated entries: what merged, what was learned, deviations | Every merged pull request in that phase |
| `docs/phases/phase-NN-report.md` | Outcome against exit criteria, metrics, known issues, carry-overs | Phase close |
| `docs/learning/phase-NN.md` | Concepts explained, suggested reading order of the code, review questions, hands-on exercise, owner's answers | Phase close (owner adds answers) |
| `docs/adr/NNNN-title.md` | Architecture decision records in MADR format: context, options, decision, consequences | Any decision not already in this plan |
| `docs/architecture.md` | Architecture overview (arc42-lite): context, containers, runtime views, deployment | A component, interface or data flow changes |
| `docs/contracts/uns.md` + generated JSON Schema | Topic tree, payloads, QoS and retain rules | Any UNS change (version bump required) |
| `docs/contracts/opcua-address-space.md` | Node ids, types, methods, events per machine | Any address-space change |
| `docs/contracts/modbus-register-map.md` | Register addresses, scaling, units for WSH-01 | Any register change |
| `docs/api/openapi.json` (generated) | MES and ERP mock REST APIs | Generated in CI; checked for drift |
| `docs/data-model.md` (generated) | Entity-relationship diagram and table notes | A migration is added |
| `docs/oee-reference-cases.md` | Hand-calculated OEE cases that also drive tests | OEE logic or definitions change |
| `docs/simulation-model.md` | Every stochastic model, its parameters and its validation | Simulator behaviour changes |
| `docs/runbook.md` | Start, stop, reset data, run scenarios, troubleshoot | Operations change |
| `docs/dependencies.md` | Why each third-party dependency exists | A dependency is added or removed |
| `docs/glossary.md` | Industrial and project terms | A new term appears in code or docs |
| `CHANGELOG.md` | Keep a Changelog format, grouped by release | Every pull request ("Unreleased" section) |

**GitHub tracking**

- One Milestone per phase, named `Phase NN – <name>`, with the phase's exit date when one is set.
- Issues use templates (task, bug, spike, ADR proposal) with acceptance criteria as a checklist.
- Labels: `type:*` (feat, fix, test, docs, chore, spike), `area:*` (sim, gateway, mes, web, erp, infra, docs), `prio:*`.
- One GitHub Project board with columns Backlog, Ready, In progress, In review, Done, and a Phase field.
- Pull requests link their issue (`Closes #N`), so the board and Milestones update automatically.

**`docs/STATUS.md` layout (fixed)**

```markdown
# Status — updated YYYY-MM-DD
## Current phase: NN – <name> (started YYYY-MM-DD)
## Exit criteria progress: x / y met
## Done since last update
## In progress
## Next up
## Blockers and open questions for the owner
## Health: CI on main, coverage, open bugs
```

**Learning file layout (`docs/learning/phase-NN.md`)**

1. Concepts introduced in this phase, in plain language, with links to primary sources.
2. Reading order: which files to read first and what to look for.
3. Review questions (5–10), answerable from the code and docs.
4. Hands-on exercise: a small change the owner makes alone, with tests (for example, add a new failure mode).
5. Owner's answers and notes (filled in by the owner; required to close the phase).

## 11. Roadmap

Eleven phases build the system bottom-up, following the data from the machine to the report, so each phase stands on tested ground and ends with something the owner can run and demonstrate. Phases are sequential; no calendar dates are set, because the owner's review pace is the main constraint. Size is relative effort: S, M or L.

| Phase | Name | Main deliverables | Exit criteria (all must be demonstrated) | Size |
| --- | --- | --- | --- | --- |
| 0 | Foundations | Repo, pnpm + Turborepo, TypeScript and lint config, CI, issue and PR templates, docs skeleton, ADR-0001 (use ADRs), ADR-0002 (stack and versions), ADR-0003 (monorepo layout), Compose with TimescaleDB and Mosquitto | Fresh clone: `pnpm install && pnpm verify` passes; CI green on `main`; `docker compose up` shows healthy database and broker; `docs/STATUS.md` in place | S |
| 1 | Simulation core (headless) | `sim-core` kernel, random streams, distributions; `plant-config` with schema; machine state machines; buffers, routing, products, shifts, operators, tool wear, leak-test model; materials from an initial stock file and a weekly production schedule file (both replaced by the ERP mock in Phase 7); JSONL event log and ground-truth KPI summary; `docs/simulation-model.md` | Two runs with the same seed are byte-identical; conservation and time-accounting invariants hold over a simulated 5-day week; statistical tests pass | L |
| 2 | Device layer: OPC UA | One OPC UA server per machine, address space modelled on OPC UA for Machine Tools concepts; live mode pacing and time controls in the control API; `LoadProgram` method; alarm representation decided by spike and ADR (Alarms & Conditions vs state variables); lossless state and event delivery decided by spike and ADR (events vs queued monitored items, section 5); security mode None for now | A generic OPC UA client browses every machine and sees values change at the chosen speed; at 60× a test client receives every state transition and cycle event of a scripted shift, with no sequence gaps; method call switches the program; integration tests green; address-space doc complete | M |
| 3 | Edge gateway and UNS | Gateway with OPC UA subscriptions and reconnection; Modbus TCP server for WSH-01 in the simulator and poller in the gateway (library confirmed by spike); `contracts` for UNS; normalization; store-and-forward; Mosquitto ACLs and last-will | All machine data visible in the UNS with valid envelopes; broker-outage test shows no loss and no duplicates after dedup; UNS and Modbus docs complete | L |
| 4 | MES foundation: historian and equipment states | `mes-server` skeleton, migrations, master-data seeding, idempotent ingest, hypertables, state intervals with hour and shift splitting, REST and WebSocket; web plant overview and machine detail with live state and trends | Recorded state intervals for a simulated shift equal the simulator's ground truth; duplicate and reorder tests pass; live overview works at 60× | L |
| 5 | OEE and downtime | `oee-core` with reference cases; continuous aggregates; reason-code tree; auto-classification rules; operator downtime coding UI; OEE dashboard and downtime Pareto | MES OEE for the golden scenario equals the simulator's ground truth to four decimals, per machine and per shift | L |
| 6 | Alarms and shifts | Alarm lifecycle (active, acknowledged, cleared, shelved), alarm list UI, alarm KPIs and flood detection; shift calendar, handover notes, shift report | Injected faults appear, are acknowledged and clear with a complete audit trail; shift report totals reconcile with OEE data | M |
| 7 | Orders, ERP and execution | `erp-mock`; `identity` (users, roles, login, audit); order import, release and dispatch over the command path; routing execution per serial; operator terminal; confirmations to ERP; simulator takes lots from the ERP mock | An order runs end to end: ERP → MES → machine program → production → confirmation in ERP, quantities reconciled; role permissions tested | L |
| 8 | Traceability and quality | Lots, serials, cartons, genealogy queries; rework loop; leak-test measurements; SPC charts (I-MR, X̄-R) with run rules; quality holds; traceability screen | Any shipped serial traces back to its blank lot, component lots, machines, operators and test values, and a lot traces forward to all affected cartons; SPC detects an injected drift | L |
| 9 | Simulation console, scenarios and hardening | Interactive console UI; scenario playback; resilience suite; OPC UA security mode SignAndEncrypt with certificates; optional Prometheus + Grafana profile; load-test tool chosen and performance test run | Resilience suite passes; performance at 60× meets the targets set in the phase plan; security review checklist complete | M |
| 10 | Release 1.0 | Documentation pass, architecture views updated, demo scenario and recording, final report, `v1.0.0` tag | All six success criteria in section 1 verified and recorded in the final report | S |

The golden scenario grows phase by phase: from simulator-only output in Phase 1 to full end-to-end reconciliation (states, OEE, orders, genealogy) by Phase 8.

## 12. Risks, constraints and open decisions

The biggest risk is not technical: it is the scope outgrowing the owner's review capacity, so the plan limits task size, puts an independent review on every change and requires the owner's approval at every phase close. Technical risks are known and each has a planned response.

| Risk | Likelihood | Impact | Response |
| --- | --- | --- | --- |
| Owner understanding: code is produced and merged faster than the owner follows it | High | Medium | Task size limit (section 2); independent review agent per PR (ADR-0011); at most two open pull requests; phase reports, owner-approved realism or demo checks at every phase close; optional learning notes |
| Realism drift: simulator behaviour is plausible but not validated | Medium | Medium | Every model documented with parameters and validated statistically; owner checks behaviour against his factory experience at each Phase 1 review |
| node-opcua feature gaps (for example Alarms & Conditions details or companion nodesets) | Medium | Medium | Spike in Phase 2 before committing; fallback to state variables recorded in an ADR |
| Modbus library limitations | Low | Low | Spike in Phase 3; the washer is a single device, so a swap is cheap |
| Tooling churn: TypeScript 7 and typescript-eslint support, Drizzle 1.0, Node.js 27 | High | Low | Versions pinned; upgrades only as separate pull requests with ADRs; Renovate surfaces them |
| Golden snapshots updated carelessly, hiding regressions | Medium | High | Snapshot updates require a written justification in the pull request and owner approval |
| Local machine resources: many containers at 60× speed | Medium | Low | Speed limits configurable; Compose profiles keep optional services off by default |
| Continuity between Claude sessions | High | Medium | Repository docs are the memory: session protocol in section 2 starts and ends with `docs/STATUS.md` |

**Constraints**

- Runs on one developer machine with Docker; no paid services required.
- TimescaleDB's compression and continuous aggregates are under the Timescale License, which allows this self-hosted use; this is recorded in ADR-0002.
- All plant data is fictional; no real company's names, layouts or data are used.

**Open decisions (to be closed by ADRs in the phase shown)**

- [x] Alarm representation in OPC UA: state variables plus project alarm events; lifecycle in the MES (ADR-0010)
- [x] Lossless state and event delivery from OPC UA: events with sequence numbers, exception-based values (ADR-0009)
- [x] Modbus library confirmation: `modbus-serial` (ADR-0013)
- [x] Micro-stop threshold: 120 s over the whole Stopped interval, in `config/plant/oee.yaml` (ADR-0021)
- [ ] Auto-classification rules for downtime (Phase 5, #119; added to ADR-0021)
- [ ] Load-testing tool and performance targets (Phase 9)
- [ ] Whether to add Sparkplug B after v1.0 (Phase 10 report)

## 13. Glossary and references

| Term | Meaning in this project |
| --- | --- |
| ADR | Architecture Decision Record: a short file recording one decision, its options and consequences |
| Blocked / Starved | A machine that cannot unload because the downstream buffer is full / cannot load because the upstream buffer is empty |
| Changeover (setup) | Time to switch a machine from one product variant to another |
| DES | Discrete-event simulation: time jumps from event to event instead of ticking |
| DMC | Data Matrix Code laser-marked on a part, carrying its serial number |
| Genealogy | Parent-child links between lots, serials and cartons that make traceability possible |
| Golden scenario | A fixed seed and scenario whose expected outputs are committed and checked in CI |
| ISA-95 | Standard for integrating enterprise and control systems; defines the equipment hierarchy and the level model used here |
| ISO 22400-2 | Standard defining manufacturing KPIs, including the OEE terms used here |
| MES | Manufacturing Execution System: software that manages and records production on the shop floor |
| Micro-stop | A `Stopped` episode shorter than the configured threshold; counted as performance loss, not availability loss. Breakdowns (`Down`) are never micro-stops |
| MQTT | Lightweight publish/subscribe protocol; QoS 1 means at-least-once delivery |
| OEE | Overall Equipment Effectiveness = Availability × Performance × Quality |
| OPC UA | Industrial communication standard with a typed information model, subscriptions, methods and security |
| Modbus TCP | Older, register-based industrial protocol with no built-in semantics |
| SPC | Statistical Process Control: control charts and run rules that detect process drift |
| Store-and-forward | Buffering data locally while the network is down and sending it later in order |
| UNS | Unified Namespace: one shared MQTT topic tree, organized by the plant hierarchy, as the single hub of shop-floor data |

**References**

- Node.js release schedule announcement and schedule page: [nodejs.org PR #8826](https://github.com/nodejs/nodejs.org/pull/8826/files), [DEV summary](https://dev.to/mr_manushukla/one-nodejs-release-a-year-from-2027-what-the-node-27-lts-change-means-for-your-upgrade-cadence-2fo3)
- TypeScript 7.0 release and tooling compatibility: [InfoQ](https://infoq.com/news/2026/08/typescript-7-released/), [DEV](https://dev.to/dev_encyclopedia/why-your-typescript-7-upgrade-broke-eslint-ts-jest-and-ts-morph-385k)
- node-opcua advisory: [CVE-2026-68904 on OSV](https://osv.dev/vulnerability/CVE-2026-68904)
- TimescaleDB and PostgreSQL support matrix: [Tiger Data docs](https://www.tigerdata.com/docs/get-started/timescaledb-supported-platforms)
- Vite 8 announcement: [vite.dev](https://vite.dev/blog/announcing-vite8)
- Vitest 4 announcement: [VoidZero](https://voidzero.dev/posts/announcing-vitest-4)
- Drizzle 1.0 release-candidate status: [release list](https://releasealert.dev/npmjs/_/drizzle-orm)
- Standards to read during the project (not reproduced here): ISA-95 / IEC 62264, ISO 22400-2, ISA-18.2 (alarm management), OPC UA for Machine Tools (OPC 40501-1), MQTT 5.0 specification.
