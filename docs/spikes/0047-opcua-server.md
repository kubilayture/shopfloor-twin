# Spike #47: OPC UA servers with node-opcua

Date: 2026-10-15. node-opcua 2.187.3, Node.js 26.11.1, macOS ARM. Code: `apps/simulator/spikes/` (experimental: excluded from lint and typecheck, not part of the build; any `spikes/` folder in the repo is treated this way).

## Questions and answers

1. **Can one process run five OPC UA servers?** Yes.

   | Model                                                                                                  | Start time (5 servers) | Extra memory    |
   | ------------------------------------------------------------------------------------------------------ | ---------------------- | --------------- |
   | Minimal project model (standard nodeset only)                                                          | 0.33–0.68 s            | +110 MB RSS     |
   | Full companion nodesets: DI, IA, ISA-95 Job Control, Machinery, Machinery Jobs and Result, MachineTool | 0.49–0.80 s            | +135–149 MB RSS |

   The ranges are two runs: the author's and the reviewer's.

   The Docker VM on this Mac has 2 GB, so this fits.

2. **Can the companion types be used?** Yes. `MachineToolType` instantiates with Equipment, Identification, Monitoring, Notification and Production. The MachineTool nodeset fails to load until ISA-95 Job Control and Machinery Jobs and Result are loaded too. Decision: ADR-0008.

3. **Lossless delivery at 60×.** Short state changes are lost with default settings: node-opcua revises sampling 0 to 50 ms and coalesces changes. Lossless delivery comes in two ways: exception-based monitored items, once the server advertises `minSupportedSampleRate: 0`, and events. Both delivered 600 of 600 changes in order, counted by their `Sequence` field, including bursts of 10 in the same millisecond (the plant's maximum). The full table and the cases not covered are in ADR-0009.

## Gotchas found

- When raising an event, custom fields must be given in lowerCamelCase (`sequence`), even if the property's BrowseName is `Sequence`; otherwise the field arrives as null.
- `constructEventFilter` needs the namespace prefix for project fields (`1:Sequence`).
- Requested sampling and queue settings are only a request. Always log `revisedSamplingInterval` and `revisedQueueSize` from the monitored item result; the integration tests (#56) assert them.
