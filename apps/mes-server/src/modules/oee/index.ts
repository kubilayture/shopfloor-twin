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
