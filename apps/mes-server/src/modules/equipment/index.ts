/**
 * The `equipment` module (#96): state intervals from ingest's state facts, stored in the
 * `equipment` schema, each piece inside one UTC hour and one shift bucket. Other modules use only
 * what is exported here.
 *
 * For the API (#97):
 * - `Equipment.currentStates()` / `currentState(id)`: the latest state per equipment, in its
 *   newest device epoch, with the time it began.
 * - `Equipment.intervals(equipment, from, to, { epoch?, limit? })`: stored pieces overlapping a
 *   range.
 * - `Equipment.watermarks()`: each device epoch's watermark, newest first (the plant clock).
 * - `Equipment.shiftTotals(shiftKey, { equipment?, epoch? })`: time per state in a shift bucket.
 * - `Equipment.onChange(listener)`: after stored intervals or a current state changed (push).
 *
 * For OEE (#118, ADR-0022):
 * - `Equipment.stateHourly(from, to, { equipment?, epoch?, shiftKey? })`: rows of
 *   `equipment.state_hourly`, each with its hour's `final` (a `bucket_finality` row and the
 *   aggregate refreshed through it) and `revision`. Final for OEE also needs
 *   `Ingest.cyclesRefreshed(hour)`.
 * - `Equipment.onPiecesChanged(listener)`: after any write to the pieces, with the hours touched.
 * - `Equipment.stateAggregate()`: how far `state_hourly` is refreshed; `refreshAggregates()` runs
 *   a pending refresh now. The module refreshes `state_hourly` itself and tells ingest how far
 *   buckets are final, so `cycle_hourly` follows (`Ingest.refreshCyclesThrough`).
 *
 * For downtime (#119, #120):
 * - `Equipment.downtimeRecords({ from, to, equipment?, epoch?, uncodedFirst?, limit? })`: the
 *   downtime records (availability-loss intervals per shift bucket, with their auto reason)
 *   overlapping a range; the reason tree itself is `MasterData.reasonCodes()`.
 * - `downtimeRules(config)`: the threshold and reason rules of a plant configuration, for
 *   `EquipmentOptions.downtime`.
 */
export { Equipment } from './equipment.ts';
export { downtimeRules } from './downtime.ts';
export type { DowntimeRules } from './downtime.ts';
export type {
  CurrentState,
  DowntimeQuery,
  DowntimeRecord,
  EquipmentChange,
  EquipmentLog,
  EquipmentOptions,
  PiecesChanged,
  ShiftTotal,
  StateHour,
  StateSource,
  StoredInterval,
} from './equipment.ts';
export { EQUIPMENT_COLUMNS } from './tables.ts';
export type { EquipmentTables } from './tables.ts';
