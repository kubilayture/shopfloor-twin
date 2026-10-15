/**
 * The `equipment` module (#96): state intervals from ingest's state facts, stored in the
 * `equipment` schema, each piece inside one UTC hour and one shift bucket. Other modules use only
 * what is exported here.
 *
 * For the API (#97):
 * - `Equipment.currentStates()` / `currentState(id)`: the latest state per equipment, in its
 *   newest device epoch, with the time it began.
 * - `Equipment.intervals(equipment, from, to, { epoch? })`: stored pieces overlapping a range.
 * - `Equipment.shiftTotals(shiftKey, { equipment?, epoch? })`: time per state in a shift bucket.
 * - `Equipment.onChange(listener)`: after stored intervals or a current state changed (push).
 */
export { Equipment } from './equipment.ts';
export type {
  CurrentState,
  EquipmentChange,
  EquipmentLog,
  EquipmentOptions,
  ShiftTotal,
  StateSource,
  StoredInterval,
} from './equipment.ts';
export { EQUIPMENT_COLUMNS } from './tables.ts';
export type { EquipmentTables } from './tables.ts';
