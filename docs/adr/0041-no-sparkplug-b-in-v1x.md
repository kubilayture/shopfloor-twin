# ADR-0041: No Sparkplug B in v1.x; a bridge beside the UNS if a consumer needs one

- Status: accepted (#283, P10-08); **awaiting the owner's review**
- Date: 2026-10-22
- Deciders: Claude, within the Phase 10 plan ("Sparkplug B (ADR-0041)" and the open decision marked † in "Open decisions, decided here"); recorded for the owner under the standing instruction of 2026-10-15. The owner's answer is asked in the final report's register (`docs/final-report.md`) and in P10-11 ([#286](https://github.com/kubilayture/shopfloor-twin/issues/286))

## Context and problem statement

The master plan lists Sparkplug B among v1's non-goals ("v1 uses JSON payloads with versioned schemas. Sparkplug B is a candidate for a later phase", section 1) and leaves an open decision: "Whether to add Sparkplug B after v1.0" (section 12, rev. 10: "to be decided by ADR-0041, P10-08"). Phase 3 and Phase 9 deferred it explicitly (`docs/phases/phase-03-plan.md`, `phase-09-plan.md`). This record answers it for the 1.x line.

What the project has today (UNS contract 1.5, `docs/contracts/uns.md`):

- **Topic tree:** the ISA-95 equipment hierarchy, `orbis/gebze/<area>/<work-center>/<equipment>/<class>/<name>` (classes `state`, `telemetry`, `events`, `alarms`, `cmd`, `cmd-res`) plus `_sys/edge-gateway/<id>/…`, built only by the helpers in `@shopfloor/contracts`. The MES subscribes to it by class (`orbis/gebze/+/+/+/state/+` and so on).
- **Payloads:** JSON envelopes with a `schema` name and version per message (`uns.state.current/1`, `uns.events.cycle-complete/1`, `uns.alarms/1`, …), defined as zod schemas, exported as JSON Schema under `docs/contracts/uns/` and checked for drift by `packages/contracts/src/uns/uns.test.ts`.
- **Identity and completeness:** every fact carries `(scope, epoch, seq)`: device facts the device's own sequence across all its fact topics, gateway streams a counter per topic, and an epoch per sequence owner (ADR-0015). The consumer rule (`Deduplicator`) removes duplicates exactly, tells a restart from loss and reports gaps as data-quality incidents; the MES acknowledges after commit, anchors on snapshots and writes gaps off explicitly (ADR-0017). Lossless delivery from OPC UA is events with sequence numbers (ADR-0009); the gateway's store-and-forward outbox in SQLite carries facts through broker outages (ADR-0014); the gateway's last will marks it offline.
- **Commands:** `cmd/load-order` and `cmd-res` with at-least-once delivery, device dedup and settled outcomes (ADR-0029).
- **Security:** Mosquitto's dynamic-security plugin, every user bound to one client id, ACLs per role (ADR-0039).

Sparkplug B (Eclipse Sparkplug 3.0) is an MQTT specification for industrial data. What it would mean here:

- **Its own topic namespace:** `spBv1.0/<group_id>/<message_type>/<edge_node_id>[/<device_id>]`, with message types `NBIRTH`, `NDEATH`, `DBIRTH`, `DDEATH`, `NDATA`, `DDATA`, `NCMD`, `DCMD` and the host's `STATE`. The hierarchy is fixed at group, edge node and device; the ISA-95 path would become an attribute, not the topic. Either the tree the MES subscribes to is replaced, or every fact exists twice on the broker.
- **Protobuf payloads with metric aliases:** a metric is named in the birth certificate and sent by alias afterwards. The versioned JSON Schemas and their contract tests would need a second definition in Protobuf, and a consumer must hold the births to read the data.
- **Birth, death and sequence:** what Sparkplug's births, deaths, `bdSeq` and `seq` provide (state on (re)connect, an offline marker, ordering), the project already has, with stronger guarantees: per-source sequences and epochs with exactly-once accounting and gap incidents (ADR-0015, ADR-0017), retained state and alarm snapshots as anchors, the gateway's last will. Sparkplug's `seq` is per edge node and wraps at 256 (0–255), so it can't carry ADR-0015's accounting: a gap of 256 messages is invisible, and it doesn't separate the device's facts from the gateway's telemetry.
- **Commands:** `NCMD`/`DCMD` write metrics; the command path's idempotent `LoadOrder` with a command id, expiry and settled outcomes (ADR-0029) has no Sparkplug equivalent and would have to be carried as metrics with the same rules on top.
- **No consumer needs it.** Nothing in the project, and no named external system, speaks only Sparkplug (a SCADA or historian acting as Sparkplug primary host). The MES, the only consumer, reads the ISA-95 tree.

## Considered options

1. **Native Sparkplug B:** the gateway publishes Sparkplug instead of the ISA-95 tree with JSON envelopes; the MES ingests Sparkplug.
2. **A Sparkplug B bridge beside the UNS:** the UNS stays as it is; an optional egress service publishes a Sparkplug B view of it for a named consumer.
3. **None in v1.x:** the UNS stays the ISA-95 tree with JSON envelopes (master plan section 5); Sparkplug is reconsidered only when a consumer needs it, then as option 2.

## Decision outcome

Chosen option: 3, with option 2 as the path if a consumer ever needs Sparkplug.

- Option 1 would replace a contract that every layer is proven against (UNS 1.5, its schemas, the golden harness that builds the same messages from an event log, the resilience suite's no-loss accounting) with one that carries weaker identity (`seq` 0–255 per edge node), for no consumer. It would change the gateway, ingest, the broker's ACLs and every reconciliation in the release line: a major version's work, against the master plan's non-goal.
- Option 2 is sound but has no consumer today: it would be code, a contract and a test suite that nothing reads. It costs nothing to defer, because the UNS already holds everything a Sparkplug view would carry.
- Option 3 keeps the 1.x line on one contract. The master plan's non-goal stands; section 12's open decision points here.

### If a consumer ever needs Sparkplug B (option 2)

A named consumer (for example a SCADA or historian that is a Sparkplug primary host) is the trigger. The work is its own ADR and its own phase, never a change inside a 1.x patch:

- **A separate service** (for example `apps/sparkplug-bridge`), off by default in its own Compose profile, as the observability profile is (ADR-0012). It is a UNS consumer like the MES: its own MQTT user bound to its own client id, with read-only ACLs on the UNS classes it maps and write rights only under `spBv1.0/<group>/…` (ADR-0039). It never publishes into the ISA-95 tree and never replaces it.
- **Egress only.** No `NCMD` or `DCMD` reaches the plant: commands stay on the command path (ADR-0029), whose idempotency and settled outcomes a metric write can't carry. A consumer's write request, if one is ever needed, is a new design with its own ADR.
- **Mapping:** one group for the site, the gateway as the edge node, each equipment as a device; births built from the retained state and alarm snapshots, data from the state, telemetry, event and alarm messages; deaths from the gateway's status and the bridge's own will. The bridge's `seq` and `bdSeq` are its own; no consumer inside the project uses them for completeness, which stays ADR-0015's.
- **Contract and tests:** a contract document beside `docs/contracts/uns.md` with the mapping table and a version; payloads checked against the Sparkplug specification's Protobuf definition; a test that the bridge's view of a golden run equals the UNS's facts (every fact once, in device order) and that a broker outage leaves the UNS unchanged. Protobuf and any Sparkplug library are new dependencies with their own entry in `docs/dependencies.md`.
- **Plan change:** the master plan's non-goal and section 5 are amended in the same pull request as that ADR (change control, section 2).

### Consequences

- Good: one UNS contract for 1.x, with the identity, dedup and gap accounting every reconciliation and the resilience suite rely on; no second payload definition to keep in step.
- Good: nothing in the stack changes for this decision; no golden, contract or test is touched.
- Good: the bridge path keeps the ISA-95 tree as the source of truth, so adding Sparkplug later is additive and can be removed again.
- Bad: a tool that only speaks Sparkplug B (auto-discovery of tags through births) can't read the plant without that bridge; a consumer must read the documented JSON tree instead.
- Bad: "Sparkplug-ready" can't be claimed in a portfolio sense; the project shows the ISA-95 UNS with JSON Schemas instead, and this record explains why.
- Neutral: the decision is cheap to reverse in the bridge's direction; reversing towards option 1 would be a 2.0 change.

## More information

- Master plan section 1 (non-goals), section 5 (the UNS), section 12 (open decisions).
- ADR-0009 (lossless OPC UA delivery), ADR-0014 (store-and-forward), ADR-0015 (identity, epochs, dedup), ADR-0017 (ingest acknowledgements, anchors, gaps), ADR-0029 (command path), ADR-0039 (MQTT dynamic security).
- `docs/contracts/uns.md` (UNS 1.5) and its JSON Schemas.
- The Phase 10 plan, "Sparkplug B (ADR-0041)"; the final report, "The Sparkplug B decision" and the register.
