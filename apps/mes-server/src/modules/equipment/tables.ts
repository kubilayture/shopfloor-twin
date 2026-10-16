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
  closed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  clamped: boolean;
  updated_at: DefaultTimestamp;
}

/** Per (equipment, epoch, UTC hour): when it became final and how often it changed since (#113). */
export interface BucketFinalityTable {
  equipment: string;
  epoch: number;
  hour: Timestamp;
  final_at: DefaultTimestamp;
  revision: ColumnType<number, number | undefined, number>;
  revised_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** ingest.data_quality_incident ids (BIGINT[], read as numbers). */
  incident_ids: ColumnType<number[], number[] | undefined, number[]>;
  /** The hour's cycle count, kept with the revision (#118); null: recorded before migration 0006. */
  cycles: ColumnType<number | null, number | null | undefined, number | null>;
}

/** Read-only: a continuous aggregate (#118). */
type ViewColumn<T> = ColumnType<T, never, never>;

/** `equipment.state_hourly`: time per state per (equipment, epoch, UTC hour, shift bucket). */
export interface StateHourlyView {
  equipment: ViewColumn<string>;
  epoch: ViewColumn<number>;
  hour: ViewColumn<Date>;
  shift_key: ViewColumn<string>;
  state: ViewColumn<string>;
  ms: ViewColumn<number>;
  provisional_ms: ViewColumn<number>;
}

export interface EquipmentTables {
  'equipment.equipment_state_interval': EquipmentStateIntervalTable;
  'equipment.interval_source': IntervalSourceTable;
  'equipment.bucket_finality': BucketFinalityTable;
  'equipment.state_hourly': StateHourlyView;
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
    'closed_at',
    'clamped',
    'updated_at',
  ],
  'equipment.bucket_finality': [
    'equipment',
    'epoch',
    'hour',
    'final_at',
    'revision',
    'revised_at',
    'incident_ids',
    'cycles',
  ],
  'equipment.state_hourly': [
    'equipment',
    'epoch',
    'hour',
    'shift_key',
    'state',
    'ms',
    'provisional_ms',
  ],
} as const;
