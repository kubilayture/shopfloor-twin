/**
 * The `alarms` module (#142, ADR-0024): alarm occurrences derived from the device's facts, stored
 * in the `alarms` schema, with finality and revisions; alarm KPIs computed on read with
 * `alarm-core`. Other modules use only what is exported here.
 *
 * - `Alarms.start()` (after `Equipment.start()`: a newer epoch is closed there first) and `stop()`.
 * - `Alarms.list(query)`, `occurrence(id)`, `history(id)`: occurrences (`{equipment}~{epoch}~{seq}`)
 *   with their end (`cleared`, `lost`, `superseded`, `epoch-ended`) and the device facts behind
 *   them.
 * - `Alarms.kpis({ scope, id, bucket, from, to, epoch? })`: KPIs per hour or shift bucket for the
 *   plant, an operator position or an equipment, with `final`, `revision` and `incidents`;
 *   `floods(...)`, `badActors(...)`; `current(scope, id)`: the hour and shift at the plant clock.
 * - `Alarms.onChange(listener)`: occurrence upserts, finality moves and shelf changes (push).
 * - Operator writes (#143, ADR-0023, audited in `alarms.alarm_transition`): `acknowledge(ids,…)`
 *   (monotonic, bulk up to 100), `comment(id,…)`, `shelve(equipment, code,…)` and
 *   `unshelve(…)` (versioned, limited in plant time); reads `points()`, `point()`, `shelf()`,
 *   `comments(id)`, `pointAudit()`. None of them changes a KPI.
 * - `Alarms.scopes()`, `scope(kind, id)`, `definition(equipment, code)`.
 * - `deriveOccurrences(...)`: the pure pairing of facts, anchors, snapshot and epoch end.
 */
export { Alarms, occurrenceId, parseOccurrenceId } from './alarms.ts';
export type {
  AlarmBucketKind,
  AlarmChange,
  AlarmEvent,
  AlarmPointChange,
  AlarmWriteRequest,
  AlarmFinalityChange,
  AlarmHistoryEntry,
  AlarmKpiBucket,
  AlarmKpiQuery,
  AlarmListQuery,
  AlarmOccurrence,
  AlarmRangeQuery,
  AlarmScope,
  AlarmSources,
  AlarmsLog,
  AlarmsOptions,
  ScopeInfo,
} from './alarms.ts';
export { alarmHourBuckets, alarmShiftBuckets, noShiftKey } from './buckets.ts';
export type { AlarmBucket } from './buckets.ts';
export { deriveOccurrences, earliestEffect } from './derive.ts';
export { AlarmWriteError, UNSHELVED, alarmState } from './lifecycle.ts';
export type {
  Acknowledgement,
  AlarmComment,
  AlarmPoint,
  AlarmShelf,
  AlarmState,
  AlarmTransition,
  AlarmWriteErrorKind,
  PlantClock,
} from './lifecycle.ts';
export type { Derived, DeviceTransition } from './derive.ts';
export { ALARMS_COLUMNS } from './tables.ts';
export type {
  AlarmsTables,
  EndReason,
  TransitionAction,
  UsedAnchor,
  UsedSnapshot,
} from './tables.ts';
