/**
 * The `execution` module (#175, Phase 7 plan "Routing execution per part", ADR-0031): every part
 * tracked through OP10–OP50 from the device's cycle facts. Everything it stores lives in the
 * `execution` schema; other modules use only what is exported here.
 *
 * - `Execution.start()` / `stop()` / `tick()`; `onChange(listener)`: orders and scrap records.
 * - Units keyed (device epoch, partId), attributed to an order by the job facts (the latest
 *   `started` below the unit's OP10 cycle on its CNC); one operation record per cycle with its
 *   rework pass; routing violations as incidents; WIP; quantities and backflushed material per
 *   order operation; completion only when no unit can come back (H1); confirmations and the order's
 *   completion through the orders module (`Orders.confirm`, `Orders.complete`).
 * - Reads: `units(query)`, `orderExecution(orderId)`, `scrapRecords(query)`, `scrapRecord(id)`,
 *   `scrapAudit(id)`, `scrapReasons()`, `incidents(query)`.
 * - Writes: `codeScrap(id, { version, reason, comment }, context)` (`scrap:code`, audited).
 * - `blanksStarted(job)`: the orders module's `BlankCounter` (exact blank counts of a lost job).
 * - Pure (`derive.ts`): `buildUnit`, `holdsBlank`, `orderTotals`, `completion`.
 */
export { buildUnit, completion, confirmationTotals, holdsBlank, orderTotals } from './derive.ts';
export type {
  BomLine,
  BuiltUnit,
  CompletionUnit,
  ConfirmationTotals,
  JobStart,
  OperationTotals,
  RecordOf,
  RoutingModel,
  StateAfter,
  UnitFact,
} from './derive.ts';
export { Execution, ExecutionError, SCRAP_AUDIT_ENTITY } from './execution.ts';
export type {
  ExecutionChange,
  ExecutionErrorKind,
  ExecutionIncident,
  ExecutionIngest,
  ExecutionLog,
  ExecutionOptions,
  ExecutionOrders,
  ExecutionWriteContext,
  OrderExecutionRecord,
  OrderOperationRecord,
  ScrapRecord,
  UnitRecord,
} from './execution.ts';
export { EXECUTION_COLUMNS } from './tables.ts';
export type { ExecutionTables, RoutingViolation, UnitStatus } from './tables.ts';
