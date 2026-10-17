/**
 * The `ingest` module (#95): the MES's persistent UNS subscription. Everything it stores lives in
 * the `ingest` schema; other modules use only what is exported here.
 *
 * For the equipment module (#96):
 * - `Ingest.onStored(listener)`: after each commit, `state` (a state change), `anchor` (a
 *   retained delivery or snapshot, once its device epoch is known) and `sample` (any other fact's
 *   time, for the plant watermark). Notices are a fast path, not a durable log: after a restart,
 *   catch up from the queries.
 * - `Ingest.stateFacts(equipment, epoch, window?)`: state changes of one device epoch by `seq`.
 * - `Ingest.epochs(equipment)`: device epochs with facts, in arrival order.
 * - `Ingest.anchor(equipment, deviceEpoch)`: the starting state when no fact precedes, the first
 *   anchor to arrive for that epoch; `anchors()` lists them all.
 * - `Ingest.stateFactWindow(equipment, epoch, seq)`: a fact with its neighbours by `seq`.
 * - `Ingest.stateFactCount`, `Ingest.latestStateTime`: for windows of reordered facts.
 * - `Ingest.factSummary()`: per (equipment, epoch), fact counts and the latest time (catch-up).
 * - `Ingest.settled(equipment, epoch, afterSeq?)`: the gap state of a device stream, for interval
 *   finality (#113): the highest `seq` with no open gap below it, the latest fact time up to it,
 *   and the epoch's gap incidents. Device fact notices carry `settledSeq`; a `gaps` notice follows
 *   a sweep that recorded gaps of a device stream.
 * - `Ingest.deliver(topic, payload, retained)`: the store path without a broker (tests, replays).
 *
 * For OEE (#118, ADR-0022):
 * - `cycle` notices (a stored cycle, with product and result) and `epoch` notices (the first fact
 *   of a device stream's new epoch, with its time).
 * - `Ingest.cycleHourly(from, to, { equipment?, epoch? })`: rows of `ingest.cycle_hourly`.
 * - `Ingest.cyclesRefreshed(hour)` / `cycleAggregate()`: whether an hour of `cycle_hourly` is
 *   materialised as it is now; an hour is final for OEE when it is and `Equipment.stateHourly`
 *   reports it `final`.
 * - `Ingest.refreshCyclesThrough(end)`: buckets are final up to `end` (the equipment module's latest
 *   final hour); `refreshAggregates()` runs a pending refresh now.
 * - `Ingest.cycleCounts(...)`, `hourlyCycleTotals()`: cycle counts per hour, from the facts and from
 *   the aggregate, for the equipment module's per-hour cycle counts.
 *
 * For the API (#97):
 * - `Ingest.telemetryMetrics(equipment)`: metrics with unit and latest sample.
 * - `Ingest.telemetrySeries(equipment, metrics, from, to, bucketMs)`: decimated series.
 * - `sample` notices of telemetry carry `telemetry` (metric, value, unit) for push.
 *
 * For alarms (#141, ADR-0017 amendment):
 * - `alarm` notices (a stored alarm transition, after its `sample`, with `settledSeq`).
 * - `alarm-anchor` notices: a retained alarm delivery stored in `ingest.alarm_anchor` (the
 *   highest `seq` per equipment, epoch and code wins); `alarm-snapshot` notices: the gateway's
 *   resync snapshot stored in `ingest.alarm_snapshot` (the highest `asOfSeq` per equipment and
 *   device epoch wins). Neither enters dedup or gap checks.
 * - Old epochs: an anchor or snapshot older than the newest device epoch known for its equipment
 *   (any fact, state anchor, alarm anchor or snapshot) is stored `stale` and never used; when a
 *   newer epoch arrives, an `alarm-stale` notice lists the rows that became stale.
 * - `Ingest.alarmFacts(equipment, epoch, { code?, fromSeq?, toSeq? })`, `alarmFactCounts()`,
 *   `alarmAnchors()`, `alarmSnapshots()` (stale ones only on request), and `alarmBaseline(equipment)`:
 *   the newest epoch's anchors and snapshot resolved by sequence (`resolveAlarmBaseline`).
 *
 * For orders (#174, UNS contract 1.3, ADR-0017 note):
 * - job facts (`events/job`) are device facts in `equipment_event` (`event_type` `job`): a `sample`
 *   notice (kind `job`) then a `job` notice with `settledSeq`; `Ingest.jobFacts({ commandIds?,
 *   equipment?, epoch? })` reads them back.
 * - command results (`cmd-res/load-order`) are a topic-scoped stream of the gateway, deduplicated
 *   by its cursor and stored in `ingest.command_result`: a `command-result` notice per stored one;
 *   `Ingest.commandResults(commandIds)` reads every one, in arrival order.
 * - `Ingest.deviceProgress(equipment)`: the device stream's epoch, `receivedThrough` (every number
 *   received up to it) and `settledSeq` (ADR-0018's final-through) with its time;
 *   `newestDeviceEpochs()`; `componentStatuses(component)` (the gateway's `_sys` status);
 *   `cyclesBetween(equipment, epoch, afterSeq, beforeSeq)`.
 *
 * For execution (#175, ADR-0031):
 * - `Ingest.cycleFacts({ epoch, partIds?, equipment?, seqs?, afterSeq?, beforeSeq? })`: cycle
 *   facts with their part, by device epoch and part id across machines (an expression index), or
 *   of one equipment by `seq`; `cycleFactCounts()` per (equipment, epoch) for the catch-up.
 *
 * For genealogy (#197, UNS contract 1.4, ADR-0033):
 * - cycle facts carry `lots` and `operator` as reported (absent when not reported, `[]` and null
 *   as values); `CycleFact` passes them on. Ingest drops them from a non-OPC UA cycle, and the
 *   operator from a cycle that consumed nothing, keeping the cycle (below).
 * - `Ingest.cycleFacts({ lot, epoch? })`: the cycles that consumed a lot, through the GIN index
 *   `ingest.equipment_event_cycle_lots` (the forward query during catch-up). The index spans
 *   device epochs: without `epoch`, every run's cycles of the lot.
 * - A cycle whose trace fields the contract refuses is stored without them; the delivery and
 *   what was dropped go to `rejected_message` as `trace-dropped` (the fact's own transaction).
 *
 * For quality (#200, ADR-0032):
 * - `CycleFact.measurement`: the reading a cycle carries (the leak test's), null when none; genealogy's backward trace shows it too (#199).
 */
export { INGEST_TOPICS, Ingest, baselineState } from './ingest.ts';
export { resolveAlarmBaseline } from './alarm-baseline.ts';
export type { AlarmPointState } from './alarm-baseline.ts';
export type {
  AlarmBaseline,
  AlarmFactCount,
  CycleCount,
  CycleFact,
  CycleFactQuery,
  CycleHour,
  DeviceProgress,
  FactSummary,
  IngestLog,
  IngestOptions,
  IngestOutcome,
} from './ingest.ts';
export type {
  AlarmAnchor,
  AlarmFact,
  GapIncident,
  IngestNotice,
  JobFact,
  StoredCommandResult,
  SettledState,
  StateAnchor,
  StateFact,
  StoredAlarmSnapshot,
  StoredCycle,
  StoredSample,
} from './store.ts';
export type { TelemetryBucket, TelemetryMetric, TelemetrySeries } from './telemetry.ts';
export { INGEST_COLUMNS } from './tables.ts';
export type { CycleHourlyView, IngestTables, RejectReason } from './tables.ts';
