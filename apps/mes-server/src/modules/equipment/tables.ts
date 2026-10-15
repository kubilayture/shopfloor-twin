import type { ColumnType } from 'kysely';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** Defaults to now() in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface EquipmentStateIntervalTable {
  equipment: string;
  epoch: number;
  start_time: Timestamp;
  end_time: Timestamp;
  state: string;
  cause: string | null;
  hour: Timestamp;
  shift_key: string;
  provisional: boolean;
  interval_start: Timestamp;
  start_seq: number | null;
  recorded_at: DefaultTimestamp;
}

export interface IntervalSourceTable {
  equipment: string;
  epoch: number;
  state_facts: number;
  last_seq: number | null;
  anchor_arrival: number | null;
  closed: boolean;
  clamped: boolean;
  updated_at: DefaultTimestamp;
}

export interface EquipmentTables {
  'equipment.equipment_state_interval': EquipmentStateIntervalTable;
  'equipment.interval_source': IntervalSourceTable;
}

export const EQUIPMENT_COLUMNS = {
  'equipment.equipment_state_interval': [
    'equipment',
    'epoch',
    'start_time',
    'end_time',
    'state',
    'cause',
    'hour',
    'shift_key',
    'provisional',
    'interval_start',
    'start_seq',
    'recorded_at',
  ],
  'equipment.interval_source': [
    'equipment',
    'epoch',
    'state_facts',
    'last_seq',
    'anchor_arrival',
    'closed',
    'clamped',
    'updated_at',
  ],
} as const;
