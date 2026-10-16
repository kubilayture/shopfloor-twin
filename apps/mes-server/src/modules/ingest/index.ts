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
 * For the API (#97):
 * - `Ingest.telemetryMetrics(equipment)`: metrics with unit and latest sample.
 * - `Ingest.telemetrySeries(equipment, metrics, from, to, bucketMs)`: decimated series.
 * - `sample` notices of telemetry carry `telemetry` (metric, value, unit) for push.
 */
export { INGEST_TOPICS, Ingest } from './ingest.ts';
export type { FactSummary, IngestLog, IngestOptions, IngestOutcome } from './ingest.ts';
export type {
  GapIncident,
  IngestNotice,
  SettledState,
  StateAnchor,
  StateFact,
  StoredSample,
} from './store.ts';
export type { TelemetryBucket, TelemetryMetric, TelemetrySeries } from './telemetry.ts';
export { INGEST_COLUMNS } from './tables.ts';
export type { IngestTables, RejectReason } from './tables.ts';
