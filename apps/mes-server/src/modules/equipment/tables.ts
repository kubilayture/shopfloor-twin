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
  /** The micro-stop threshold the downtime records were derived with (#119); null before. */
  downtime_threshold_ms: ColumnType<number | null, number | null | undefined, number | null>;
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

/** One downtime record: an availability-loss interval in one shift bucket (#119). */
export interface DowntimeRecordTable {
  equipment: string;
  epoch: number;
  start_time: Timestamp;
  end_time: ColumnType<Date | null, Date | string | null, Date | string | null>;
  interval_start: Timestamp;
  shift_key: string;
  state: string;
  cause: string | null;
  auto_reason: string;
  provisional: boolean;
  recorded_at: DefaultTimestamp;
}

/** The coding set of one (equipment, epoch): its version is the concurrency token (#121). */
export interface DowntimeCodingSetTable {
  equipment: string;
  epoch: number;
  version: ColumnType<number, number | undefined, number>;
  updated_at: DefaultTimestamp;
}

/** One operator coding: a time range with a reason, inside a record's loss time (#121). */
export interface DowntimeCodingTable {
  id: ColumnType<number, never, never>;
  equipment: string;
  epoch: number;
  from_time: Timestamp;
  to_time: Timestamp;
  reason: string;
  comment: ColumnType<string, string | undefined, string>;
  coded_by: string;
  coded_at: Timestamp;
  version: number;
  orphaned: ColumnType<boolean, boolean | undefined, boolean>;
  orphaned_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** Append-only audit of codings and clips (#121). */
export interface DowntimeAuditTable {
  id: ColumnType<number, never, never>;
  equipment: string;
  epoch: number;
  record_id: string | null;
  from_time: Timestamp;
  to_time: ColumnType<Date | null, Date | string | null, Date | string | null>;
  action: string;
  before: ColumnType<unknown, string, never>;
  after: ColumnType<unknown, string, never>;
  actor: string;
  authenticated: ColumnType<boolean, boolean | undefined, never>;
  at: ColumnType<Date, Date | string | undefined, never>;
  request_id: string | null;
  version: number;
}

export interface EquipmentTables {
  'equipment.equipment_state_interval': EquipmentStateIntervalTable;
  'equipment.interval_source': IntervalSourceTable;
  'equipment.bucket_finality': BucketFinalityTable;
  'equipment.state_hourly': StateHourlyView;
  'equipment.downtime_record': DowntimeRecordTable;
  'equipment.downtime_coding_set': DowntimeCodingSetTable;
  'equipment.downtime_coding': DowntimeCodingTable;
  'equipment.downtime_audit': DowntimeAuditTable;
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
    'downtime_threshold_ms',
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
  'equipment.downtime_record': [
    'equipment',
    'epoch',
    'start_time',
    'end_time',
    'interval_start',
    'shift_key',
    'state',
    'cause',
    'auto_reason',
    'provisional',
    'recorded_at',
  ],
  'equipment.downtime_coding_set': ['equipment', 'epoch', 'version', 'updated_at'],
  'equipment.downtime_coding': [
    'id',
    'equipment',
    'epoch',
    'from_time',
    'to_time',
    'reason',
    'comment',
    'coded_by',
    'coded_at',
    'version',
    'orphaned',
    'orphaned_at',
  ],
  'equipment.downtime_audit': [
    'id',
    'equipment',
    'epoch',
    'record_id',
    'from_time',
    'to_time',
    'action',
    'before',
    'after',
    'actor',
    'authenticated',
    'at',
    'request_id',
    'version',
  ],
} as const;
