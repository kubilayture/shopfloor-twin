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
 * For OEE (#120, ADR-0021):
 * - `Equipment.oeeInputs(from, to, { equipment?, epoch? })`: the hourly state rows (with their
 *   incidents) and the Stopped pieces with their whole interval's length, in one REPEATABLE READ
 *   snapshot; `stopPieces(...)` reads the latter alone.
 *
 * For downtime (#119, #120):
 * - `Equipment.downtimeLoss({ from, to, equipment?, epoch? })`: the records' time per reason,
 *   summed in the database without a row limit (#120, the Pareto).
 * - `Equipment.downtimeRecords({ from, to, equipment?, epoch?, uncodedFirst?, uncoded?, limit? })`: the
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
  DowntimeLoss,
  DowntimeQuery,
  DowntimeRecord,
  EquipmentChange,
  EquipmentLog,
  EquipmentOptions,
  OeeInputs,
  PiecesChanged,
  ShiftTotal,
  StateHour,
  StateSource,
  StopPiece,
  StoredInterval,
} from './equipment.ts';
export { EQUIPMENT_COLUMNS } from './tables.ts';
export type { EquipmentTables } from './tables.ts';
