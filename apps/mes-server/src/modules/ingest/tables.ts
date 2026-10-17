import type {
  Alarm,
  AlarmSnapshot,
  CommandResult,
  Incident,
  StateCurrent,
  Status,
  UnsMessage,
} from '@shopfloor/contracts';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';
import type { Range } from './ranges.ts';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** Defaults to now() in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Quality = 'good' | 'uncertain' | 'bad';

export interface EquipmentEventTable {
  equipment: string;
  epoch: number;
  seq: number;
  source_time: Timestamp;
  event_type: 'state' | 'cycle' | 'alarm' | 'job';
  topic: string;
  state: string | null;
  cause: string | null;
  quality: Quality;
  source_protocol: string;
  received_at: Timestamp;
  ingested_at: DefaultTimestamp;
  payload: JSONColumnType<UnsMessage>;
}

export interface TelemetrySampleTable {
  topic: string;
  equipment: string;
  name: string;
  epoch: number;
  seq: number;
  source_time: Timestamp;
  value: number;
  unit: string;
  quality: Quality;
  source_protocol: string;
  received_at: Timestamp;
  ingested_at: DefaultTimestamp;
  payload: JSONColumnType<UnsMessage>;
}

export interface SourceCursorTable {
  stream: string;
  epoch: number;
  seen: JSONColumnType<Range[]>;
  reported: JSONColumnType<Range[]>;
  updated_at: DefaultTimestamp;
}

export interface StateAnchorTable {
  arrival: Generated<number>;
  equipment: string;
  kind: 'event' | 'snapshot';
  retained: boolean;
  scope: 'device' | 'topic';
  epoch: number;
  seq: number;
  source_time: Timestamp;
  device_epoch: number | null;
  superseded: ColumnType<boolean, boolean | undefined, boolean>;
  state: string;
  cause: string | null;
  quality: Quality;
  received_at: Timestamp;
  ingested_at: DefaultTimestamp;
  payload: JSONColumnType<StateCurrent>;
}

/** A retained alarm delivery (#141): the device's last fact for one code. */
export interface AlarmAnchorTable {
  equipment: string;
  epoch: number;
  code: string;
  seq: number;
  transition: 'active' | 'cleared';
  severity: number;
  source_time: Timestamp;
  quality: Quality;
  received_at: Timestamp;
  ingested_at: DefaultTimestamp;
  stale: ColumnType<boolean, boolean | undefined, boolean>;
  payload: JSONColumnType<Alarm>;
}

/** The gateway's alarm snapshot on resync (#141), the latest per (equipment, device epoch). */
export interface AlarmSnapshotTable {
  equipment: string;
  device_epoch: number;
  as_of_seq: number;
  active: string[];
  epoch: number;
  seq: number;
  source_time: Timestamp;
  quality: Quality;
  source_protocol: string;
  received_at: Timestamp;
  ingested_at: DefaultTimestamp;
  stale: ColumnType<boolean, boolean | undefined, boolean>;
  payload: JSONColumnType<AlarmSnapshot>;
}

/**
 * The gateway's answer to one command delivery (`cmd-res`, #174): a topic-scoped stream of the
 * gateway, deduplicated by its cursor; several per command id.
 */
export interface CommandResultTable {
  arrival: Generated<number>;
  topic: string;
  equipment: string;
  epoch: number;
  seq: number;
  command_id: string;
  order_id: string;
  device_epoch: number;
  expires_at: Timestamp;
  result: 'accepted' | 'duplicate' | 'rejected' | 'expired' | 'unknown';
  responded_at: Timestamp;
  ingested_at: DefaultTimestamp;
  payload: JSONColumnType<CommandResult>;
}

export interface DataQualityIncidentTable {
  id: Generated<number>;
  origin: 'mes' | 'gateway';
  type: string;
  stream: string;
  epoch: number;
  seq_from: number;
  seq_to: number;
  equipment: string | null;
  lost: number | null;
  message: string;
  source_time: NullableTimestamp;
  detected_at: Timestamp;
  closed_at: NullableTimestamp;
  resolution: 'filled' | 'epoch-ended' | null;
  payload: ColumnType<Incident | null, string | null, string | null>;
}

export interface ComponentStatusTable {
  component: string;
  instance: string;
  status: 'online' | 'offline';
  started_at: Timestamp;
  version: string;
  source_time: Timestamp;
  received_at: DefaultTimestamp;
  payload: JSONColumnType<Status>;
}

export type RejectReason =
  | 'invalid-json'
  | 'invalid-payload'
  | 'topic-mismatch'
  | 'unexpected-topic'
  | 'stale-epoch'
  | 'unstorable'
  /**
   * Not a refusal (#197): the cycle was stored, without trace fields (`lots`, `operator`) the
   * contract refuses; the row keeps the delivery as received and what was dropped.
   */
  | 'trace-dropped';

export interface RejectedMessageTable {
  id: Generated<number>;
  topic: string;
  payload: string;
  retained: boolean;
  reason: RejectReason;
  detail: string;
  received_at: DefaultTimestamp;
}

/** Read-only: a continuous aggregate (#118). */
type ViewColumn<T> = ColumnType<T, never, never>;

/** `ingest.cycle_hourly`: completed cycles per (equipment, epoch, UTC hour, product, result). */
export interface CycleHourlyView {
  equipment: ViewColumn<string>;
  epoch: ViewColumn<number>;
  hour: ViewColumn<Date>;
  product: ViewColumn<string>;
  result: ViewColumn<'good' | 'scrap' | 'rework'>;
  cycles: ViewColumn<number>;
}

export interface IngestTables {
  'ingest.equipment_event': EquipmentEventTable;
  'ingest.telemetry_sample': TelemetrySampleTable;
  'ingest.source_cursor': SourceCursorTable;
  'ingest.state_anchor': StateAnchorTable;
  'ingest.alarm_anchor': AlarmAnchorTable;
  'ingest.alarm_snapshot': AlarmSnapshotTable;
  'ingest.command_result': CommandResultTable;
  'ingest.data_quality_incident': DataQualityIncidentTable;
  'ingest.component_status': ComponentStatusTable;
  'ingest.rejected_message': RejectedMessageTable;
  'ingest.cycle_hourly': CycleHourlyView;
}

export const INGEST_COLUMNS = {
  'ingest.equipment_event': [
    'equipment',
    'epoch',
    'seq',
    'source_time',
    'event_type',
    'topic',
    'state',
    'cause',
    'quality',
    'source_protocol',
    'received_at',
    'ingested_at',
    'payload',
  ],
  'ingest.telemetry_sample': [
    'topic',
    'equipment',
    'name',
    'epoch',
    'seq',
    'source_time',
    'value',
    'unit',
    'quality',
    'source_protocol',
    'received_at',
    'ingested_at',
    'payload',
  ],
  'ingest.source_cursor': ['stream', 'epoch', 'seen', 'reported', 'updated_at'],
  'ingest.state_anchor': [
    'arrival',
    'equipment',
    'kind',
    'retained',
    'scope',
    'epoch',
    'seq',
    'source_time',
    'device_epoch',
    'superseded',
    'state',
    'cause',
    'quality',
    'received_at',
    'ingested_at',
    'payload',
  ],
  'ingest.alarm_anchor': [
    'equipment',
    'epoch',
    'code',
    'seq',
    'transition',
    'severity',
    'source_time',
    'quality',
    'received_at',
    'ingested_at',
    'stale',
    'payload',
  ],
  'ingest.alarm_snapshot': [
    'equipment',
    'device_epoch',
    'as_of_seq',
    'active',
    'epoch',
    'seq',
    'source_time',
    'quality',
    'source_protocol',
    'received_at',
    'ingested_at',
    'stale',
    'payload',
  ],
  'ingest.command_result': [
    'arrival',
    'topic',
    'equipment',
    'epoch',
    'seq',
    'command_id',
    'order_id',
    'device_epoch',
    'expires_at',
    'result',
    'responded_at',
    'ingested_at',
    'payload',
  ],
  'ingest.data_quality_incident': [
    'id',
    'origin',
    'type',
    'stream',
    'epoch',
    'seq_from',
    'seq_to',
    'equipment',
    'lost',
    'message',
    'source_time',
    'detected_at',
    'closed_at',
    'resolution',
    'payload',
  ],
  'ingest.component_status': [
    'component',
    'instance',
    'status',
    'started_at',
    'version',
    'source_time',
    'received_at',
    'payload',
  ],
  'ingest.rejected_message': [
    'id',
    'topic',
    'payload',
    'retained',
    'reason',
    'detail',
    'received_at',
  ],
  'ingest.cycle_hourly': ['equipment', 'epoch', 'hour', 'product', 'result', 'cycles'],
} as const;
