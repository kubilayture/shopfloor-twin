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
 *   anchor to arrive for that epoch.
 */
export { INGEST_TOPICS, Ingest } from './ingest.ts';
export type { IngestLog, IngestOptions, IngestOutcome } from './ingest.ts';
export type { IngestNotice, StateAnchor, StateFact, StoredSample } from './store.ts';
export { INGEST_COLUMNS } from './tables.ts';
export type { IngestTables, RejectReason } from './tables.ts';
