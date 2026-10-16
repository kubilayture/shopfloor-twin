import type { ColumnType, JSONColumnType } from 'kysely';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** Defaults to now() in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type EndReason = 'cleared' | 'lost' | 'superseded' | 'epoch-ended';

/** One alarm occurrence per device raise (#142, migration 0012). */
export interface AlarmOccurrenceTable {
  equipment: string;
  epoch: number;
  seq: number;
  code: string;
  severity: number;
  priority: 'high' | 'medium' | 'low';
  defined: boolean;
  source: 'fact' | 'anchor';
  raised_at: Timestamp;
  ended_at: NullableTimestamp;
  end_reason: EndReason | null;
  end_seq: number | null;
  updated_at: DefaultTimestamp;
}

/** A retained alarm delivery the occurrences of an epoch were derived from. */
export interface UsedAnchor {
  readonly code: string;
  readonly seq: number;
  readonly transition: 'active' | 'cleared';
  readonly severity: number;
  /** Milliseconds. */
  readonly at: number;
}

/** The latest resync snapshot of an epoch seen while it was not stale. */
export interface UsedSnapshot {
  readonly asOfSeq: number;
  /** Milliseconds. */
  readonly at: number;
  readonly active: readonly string[];
}

/** Per (equipment, epoch): what the occurrences were derived from (#142). */
export interface OccurrenceSourceTable {
  equipment: string;
  epoch: number;
  facts: number;
  /** Written as JSON text (pg would send a JS array as a PostgreSQL array). */
  anchors: JSONColumnType<UsedAnchor[], string | undefined>;
  snapshot: JSONColumnType<UsedSnapshot | null, string | null | undefined, string | null>;
  closed: ColumnType<boolean, boolean | undefined, boolean>;
  closed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  final_through: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  updated_at: DefaultTimestamp;
}

/** Revisions of final KPI hours per scope (#142). */
export interface KpiRevisionTable {
  scope: string;
  epoch: number;
  hour: Timestamp;
  revision: number;
  revised_at: DefaultTimestamp;
}

/** Acknowledgement per occurrence, insert-only (#143, migration 0013). */
export interface OccurrenceStateTable {
  equipment: string;
  epoch: number;
  seq: number;
  acknowledged_by: string;
  acknowledged_at: Timestamp;
  plant_at: NullableTimestamp;
  plant_epoch: number | null;
  comment: ColumnType<string, string | undefined, string>;
  request_id: string | null;
}

/** The shelf of one alarm point, with its version (#143). */
export interface AlarmShelfTable {
  equipment: string;
  code: string;
  version: ColumnType<number, number | undefined, number>;
  shelved: ColumnType<boolean, boolean | undefined, boolean>;
  shelved_by: string | null;
  reason: string | null;
  shelved_at: NullableTimestamp;
  plant_epoch: number | null;
  plant_at: NullableTimestamp;
  until: NullableTimestamp;
  duration_ms: number | null;
  updated_at: DefaultTimestamp;
}

export type TransitionAction = 'ack' | 'comment' | 'shelve' | 'unshelve' | 'expire' | 'epoch-ended';

/** The append-only audit of every MES transition of an alarm (#143). */
export interface AlarmTransitionTable {
  id: ColumnType<number, never, never>;
  equipment: string;
  code: string;
  epoch: number | null;
  seq: number | null;
  action: TransitionAction;
  /** Written as JSON text. */
  before: JSONColumnType<Record<string, unknown> | null, string | null, string | null>;
  after: JSONColumnType<Record<string, unknown> | null, string | null, string | null>;
  actor: string;
  authenticated: ColumnType<boolean, boolean | undefined, boolean>;
  at: DefaultTimestamp;
  plant_at: NullableTimestamp;
  plant_epoch: number | null;
  request_id: string | null;
  version: number | null;
}

export interface AlarmsTables {
  'alarms.alarm_occurrence': AlarmOccurrenceTable;
  'alarms.occurrence_source': OccurrenceSourceTable;
  'alarms.kpi_revision': KpiRevisionTable;
  'alarms.occurrence_state': OccurrenceStateTable;
  'alarms.alarm_shelf': AlarmShelfTable;
  'alarms.alarm_transition': AlarmTransitionTable;
}

export const ALARMS_COLUMNS = {
  'alarms.alarm_occurrence': [
    'equipment',
    'epoch',
    'seq',
    'code',
    'severity',
    'priority',
    'defined',
    'source',
    'raised_at',
    'ended_at',
    'end_reason',
    'end_seq',
    'updated_at',
  ],
  'alarms.occurrence_source': [
    'equipment',
    'epoch',
    'facts',
    'anchors',
    'snapshot',
    'closed',
    'closed_at',
    'final_through',
    'updated_at',
  ],
  'alarms.kpi_revision': ['scope', 'epoch', 'hour', 'revision', 'revised_at'],
  'alarms.occurrence_state': [
    'equipment',
    'epoch',
    'seq',
    'acknowledged_by',
    'acknowledged_at',
    'plant_at',
    'plant_epoch',
    'comment',
    'request_id',
  ],
  'alarms.alarm_shelf': [
    'equipment',
    'code',
    'version',
    'shelved',
    'shelved_by',
    'reason',
    'shelved_at',
    'plant_epoch',
    'plant_at',
    'until',
    'duration_ms',
    'updated_at',
  ],
  'alarms.alarm_transition': [
    'id',
    'equipment',
    'code',
    'epoch',
    'seq',
    'action',
    'before',
    'after',
    'actor',
    'authenticated',
    'at',
    'plant_at',
    'plant_epoch',
    'request_id',
    'version',
  ],
} as const;
