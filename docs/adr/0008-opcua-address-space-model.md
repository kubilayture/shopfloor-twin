# ADR-0008: OPC UA address space: companion types plus a project namespace

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (spike #47), owner on review

## Context and problem statement

Plan section 11 asks for an address space "modelled on OPC UA for Machine Tools concepts", one server per machine. node-opcua 2.187.3 bundles the companion nodesets: DI, IA, Machinery, Machinery Jobs and Result, ISA-95 Job Control, and MachineTool. Should the servers instantiate the standard types, or use a project-specific model?

The MES needs facts the standard models don't carry exactly:

- the ten machine states, with cause (plan section 4);
- a per-source sequence number (plan section 5);
- serials, results and measurements per cycle;
- the operator at ASM-01.

The Machinery `MachineryItemState` has four states (NotAvailable, OutOfService, Executing, NotExecuting); mapping our ten states onto it loses information that OEE depends on.

## Considered options

1. Companion types only.
2. A project model only, loosely inspired by the companion specifications.
3. A hybrid: standard companion types where they fit, plus a project namespace for what the MES needs exactly.

## Decision outcome

Chosen option: 3.

- **Standard part, for interoperability.**
  - CNC-01 and CNC-02 are instances of `MachineToolType`, which gives Identification, Monitoring, Production, Equipment and Notification.
  - ASM-01, LKT-01 and PCK-01 get the Machinery building blocks: `MachineIdentificationType` and `MachineryItemState`.
  - The coarse Machinery state is derived from our state: `Running` → Executing; `Idle`, `Stopped`, `Starved`, `Blocked`, `Setup` and `PlannedStop` → NotExecuting; `Down` and `Maintenance` → OutOfService; `Off` → NotAvailable.
  - Any generic Machinery client can identify the machines and see whether they are working.
- **Project namespace** `urn:orbis-components:shopfloor-twin` (ns name). Under a `ShopFloor` object on each machine:
  - `State`: one of the ten states; `StateCause`; `Sequence`, the last per-source sequence number;
  - counters: produced, good, scrap, rework;
  - `LastSerial`;
  - process values;
  - CNCs: `Program` and `LoadProgram`;
  - ASM-01: `Operator`;
  - LKT-01: the last leak reading and its limit.
- **Project event types** carry the same facts as events: `ShopFloorStateChangeEventType`, `CycleCompleteEventType`, and alarm events per ADR-0010 (ADR-0009 explains why events).
- **Node ids** are string ids (`ns=<project>;s=cnc-01.ShopFloor.State`), defined once in `@shopfloor/contracts` and documented in `docs/contracts/opcua-address-space.md`.

### Consequences

- Good: standard clients understand the machines' identity and coarse state, and the MES gets exactly the facts it needs, with nothing lost in a mapping.
- Good: the cost is small. Five servers with the full companion nodesets start in about 0.8 s and use about 135 MB, against 0.7 s and 110 MB for a minimal model (spike #47).
- Bad: two descriptions of the state (the Machinery coarse state and the project `State`) must be kept consistent; one function derives the first from the second, and a test covers the mapping.
- Bad: loading MachineTool requires the ISA-95 Job Control and Machinery Jobs and Result nodesets, even though jobs aren't modelled yet.
