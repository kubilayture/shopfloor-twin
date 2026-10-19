/**
 * The `oee` module (#120, ADR-0021, ADR-0022): OEE per equipment and work center, per hour and
 * shift bucket, computed on read from the other modules' interfaces. It owns no tables. Other
 * modules use only what is exported here.
 *
 * - `Oee.buckets({ scope, id, bucket, from, to, epoch? })`: OEE buckets with inputs, the
 *   `oee-core` result, `final`, `provisionalMs`, `revision` and `incidents`.
 * - `Oee.shift(bucket, epoch?)`: one shift bucket for every machine and work center.
 * - `Oee.current(scope, id)`: the hour and shift bucket at the plant clock (push).
 * - `Oee.onChange(listener)`: after the pieces or cycles of an hour changed.
 * - `Oee.paretoInputs(...)` and `pareto(...)`: the downtime Pareto (loss by reason, without a
 *   row limit; micro-stops by cause); `DowntimeFeed`: record changes for push; `downtimeId(record)`: the API's record id.
 *
 * Order OEE (#231, ADR-0036 and its P9-04 amendment), per order and job, derived on read:
 * - `OrderOee.order(id)`: the order OEE over its job windows, every job (head time, window, OEE)
 *   and the first-pass yield, each with its finality; final results kept in memory.
 * - `OrderOee.onChange(listener)`: an order, or a CNC whose orders may have moved (push).
 * - Pure (`order-queue.ts`): `commandQueues`, `queuedJob`, `acceptanceOrder`, `inQueue`,
 *   `orderSlice`: each CNC's queue from the orders module's command state, lost facts included.
 *
 * Scheduled shifts and shift buckets (`shiftInstances`, `shiftBuckets`, …) come from the pure
 * `@shopfloor/shift-calendar` (#144), which the `shifts` module uses too.
 */
export { Oee } from './oee.ts';
export type {
  OeeBucket,
  OeeBucketKind,
  OeeChange,
  OeeMember,
  OeeOptions,
  OeeQuery,
  OeeScope,
  OeeSources,
  WorkCenter,
} from './oee.ts';
export { DowntimeFeed, downtimeId, pareto, recordEnd } from './downtime.ts';
export type {
  DowntimeChange,
  DowntimeEvent,
  DowntimeFeedOptions,
  Pareto,
  ParetoMicroStop,
  ParetoReason,
} from './downtime.ts';
export { OrderOee, piecesFinal, processedThrough, wholeIntervals } from './order-oee.ts';
export type {
  OrderGapIncident,
  OrderJobView,
  OrderOeeChange,
  OrderOeeOptions,
  OrderOeeSources,
  OrderOeeView,
} from './order-oee.ts';
export { acceptanceOrder, commandQueues, inQueue, orderSlice, queuedJob } from './order-queue.ts';
export type { CommandQueue, DeviceCut, QueueCommand } from './order-queue.ts';
