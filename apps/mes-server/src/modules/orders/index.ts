/**
 * The `orders` module (#174, Phase 7 plan "Orders" and "Command path", ADR-0028, ADR-0029):
 * production orders from the ERP's change feed, the supervisor's writes, the dispatch rule, the
 * command outbox and the reading of every command from the gateway's results and the device's job
 * facts, incidents, and status messages to the ERP. Everything it stores lives in the `orders`
 * schema; other modules use only what is exported here.
 *
 * - `Orders.start()` / `stop()`; `onChange(listener)`: order and command upserts (push `orders`).
 * - Reads: `list(query)`, `order(id)`, `detail(id)`, `commands(filter)`, `incidents(query)`.
 * - Writes (a version per order, 409 `order-stale`; audited through `Identity.audit`): `release`,
 *   `dispatch`, `cancel`, `redispatch`, `close`; `complete(id, { short, at })` and
 *   `confirm(id, operation, totals, at)` are the execution module's seams (#175): the order's
 *   completion, and a final confirmation or a correction with the deltas through the ERP outbox;
 *   `confirmations(id)` reads them back; `useBlankCounter(counter)` counts a lost job's blanks from
 *   the execution module's units.
 * - `importNow()`, `postNow()`, `tick()`: one round of the ERP feed, the ERP outbox and the
 *   commands (the timers call them; tests call them directly).
 * - `readCommand` (pure): ADR-0029's reading of a command; `chooseCnc`/`estimateFinish` (pure):
 *   the dispatch rule; `validateErpOrder`: the import's check against master data.
 * - `ErpClient` (the ERP's REST API) and `MqttCommandPublisher` (the MES's command connection).
 */
export { DEFAULT_POLICY, readCommand } from './command-state.ts';
export type { CommandInputs, CommandPolicy, CommandReading } from './command-state.ts';
export { chooseCnc, estimateFinish } from './dispatch-rule.ts';
export type { CncQueue, ProductTimes, QueuedJob } from './dispatch-rule.ts';
export { ErpClient } from './erp-client.ts';
export type { ErpApi, ErpClientOptions, FeedPage, PostOutcome } from './erp-client.ts';
export { AUDIT_ENTITY, DEFAULT_TIMINGS, OrderError, Orders } from './orders.ts';
export type {
  BlankCounter,
  CommandRecord,
  ConfirmationRecord,
  CommandTimings,
  ErpMessageRecord,
  OrderChange,
  OrderDetailRecord,
  OrderErrorKind,
  OrderIncident,
  OperationConfirmation,
  OrderQuery,
  OrderRecord,
  OrdersIngest,
  OrdersLog,
  OrdersOptions,
  WriteContext,
} from './orders.ts';
export { MqttCommandPublisher } from './publisher.ts';
export type { CommandPublisher, MqttPublisherOptions } from './publisher.ts';
export { ORDERS_COLUMNS } from './tables.ts';
export type { OrdersTables } from './tables.ts';
export { validateErpOrder } from './validate.ts';
