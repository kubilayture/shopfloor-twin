# Glossary

Industrial and project terms used in code and docs. Seeded from plan section 13; add a row whenever a new term appears.

| Term               | Meaning in this project                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR                | Architecture Decision Record: a short file recording one decision, its options and consequences                                                          |
| Blocked / Starved  | A machine that cannot unload because the downstream buffer is full / cannot load because the upstream buffer is empty                                    |
| Changeover (setup) | Time to switch a machine from one product variant to another                                                                                             |
| DES                | Discrete-event simulation: time jumps from event to event instead of ticking                                                                             |
| DMC                | Data Matrix Code laser-marked on a part, carrying its serial number                                                                                      |
| Genealogy          | Parent-child links between lots, serials and cartons that make traceability possible                                                                     |
| Golden scenario    | A fixed seed and scenario whose expected outputs are committed and checked in CI                                                                         |
| ISA-95             | Standard for integrating enterprise and control systems; defines the equipment hierarchy and the level model used here                                   |
| ISO 22400-2        | Standard defining manufacturing KPIs, including the OEE terms used here                                                                                  |
| MES                | Manufacturing Execution System: software that manages and records production on the shop floor                                                           |
| Micro-stop         | A `Stopped` episode shorter than the configured threshold; counted as performance loss, not availability loss. Breakdowns (`Down`) are never micro-stops |
| MQTT               | Lightweight publish/subscribe protocol; QoS 1 means at-least-once delivery                                                                               |
| OEE                | Overall Equipment Effectiveness = Availability × Performance × Quality                                                                                   |
| OPC UA             | Industrial communication standard with a typed information model, subscriptions, methods and security                                                    |
| Modbus TCP         | Older, register-based industrial protocol with no built-in semantics                                                                                     |
| SPC                | Statistical Process Control: control charts and run rules that detect process drift                                                                      |
| Store-and-forward  | Buffering data locally while the network is down and sending it later in order                                                                           |
| UNS                | Unified Namespace: one shared MQTT topic tree, organized by the plant hierarchy, as the single hub of shop-floor data                                    |
