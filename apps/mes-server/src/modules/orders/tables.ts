import type { BomItem, RoutingStep } from '@shopfloor/contracts/erp-api';
import type {
  CommandState,
  JobState,
  OrderIncidentType,
  OrderStatus,
} from '@shopfloor/contracts/mes-api';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** Defaults to clock_timestamp() in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export interface ErpCursorTable {
  id: 'erp';
  feed_id: string | null;
  cursor: number;
  updated_at: DefaultTimestamp;
}

export interface ProductionOrderTable {
  id: string;
  revision: number;
  feed_seq: number;
  product: string;
  quantity: number;
  priority: number;
  planned_start: Timestamp;
  due_date: Timestamp;
  erp_status: 'open' | 'cancelled';
  status: OrderStatus;
  short: Defaulted<boolean>;
  dispatch_failed: Defaulted<boolean>;
  dispatch_lost: Defaulted<boolean>;
  rejection: string | null;
  routing: JSONColumnType<RoutingStep[]>;
  bom: JSONColumnType<BomItem[]>;
  version: Defaulted<number>;
  imported_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  released_at: NullableTimestamp;
  dispatched_at: NullableTimestamp;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
}

export interface OrderOperationTable {
  order_id: string;
  operation: string;
  position: number;
  work_center: string;
  /** Raised by every terminal write on the operation (#177). */
  version: Defaulted<number>;
  /** The operator's sign-off (#177): user id and name, wall and plant time. */
  signed_off_user_id: ColumnType<number | null, number | null | undefined, number | null>;
  signed_off_by: ColumnType<string | null, string | null | undefined, string | null>;
  signed_off_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  signed_off_plant_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

/** Why an operator's activity interval ended (#177). */
export type ActivityEndReason = 'paused' | 'resumed' | 'signed-off' | 'crew-ended';

/** One interval of an operator's work or pause on an order operation (#177). */
export interface OperationActivityTable {
  id: Generated<number>;
  order_id: string;
  operation: string;
  work_center: string;
  user_id: number;
  username: string;
  kind: 'work' | 'pause';
  reason: string | null;
  comment: string | null;
  from_at: Timestamp;
  from_plant_at: Timestamp;
  to_at: NullableTimestamp;
  to_plant_at: NullableTimestamp;
  end_reason: ActivityEndReason | null;
}

export interface DispatchCommandTable {
  command_id: string;
  order_id: string;
  n: number;
  equipment: string;
  product: string;
  quantity: number;
  not_before: Timestamp;
  device_epoch: number;
  queue_position: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  state: Defaulted<CommandState>;
  settled: Defaulted<boolean>;
  final: Defaulted<boolean>;
  failed: Defaulted<boolean>;
  accepted_by: 'fact' | 'result' | null;
  accepted_seq: number | null;
  accepted_at: NullableTimestamp;
  confirmed: Defaulted<boolean>;
  job: JobState | null;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  lost_started: number | null;
  rejection: string | null;
  seq_after_expiry: number | null;
}

export interface CommandAttemptTable {
  command_id: string;
  attempt: number;
  issued_at: Timestamp;
  expires_at: Timestamp;
  mes_epoch: number;
  mes_seq: number;
  stored_seq: number | null;
  published_at: NullableTimestamp;
}

export type ErpMessageStatus =
  | 'imported'
  | 'rejected'
  | 'unchanged'
  | 'cancelled'
  | 'revision-refused'
  | 'pending'
  | 'sent'
  | 'conflict'
  | 'refused';

export interface ErpMessageLogTable {
  id: Generated<number>;
  direction: 'in' | 'out';
  kind: 'feed-entry' | 'status' | 'confirmation';
  order_id: string;
  revision: number;
  idempotency_key: string | null;
  feed_id: string | null;
  feed_seq: number | null;
  payload: ColumnType<unknown, string, string>;
  status: ErpMessageStatus;
  detail: string | null;
  attempts: Defaulted<number>;
  last_error: string | null;
  next_attempt_at: NullableTimestamp;
  receipt: ColumnType<unknown, string | null, string | null>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface OrderIncidentTable {
  id: Generated<number>;
  type: OrderIncidentType;
  key: string;
  order_id: string | null;
  command_id: string | null;
  equipment: string | null;
  message: string;
  detected_at: DefaultTimestamp;
  closed_at: NullableTimestamp;
  resolution: string | null;
}

/** A confirmation sent to the ERP (#175): final (n = 1) or a correction with deltas. */
export interface ConfirmationTable {
  order_id: string;
  operation: string;
  n: number;
  kind: 'final' | 'correction';
  revision: number;
  yield: number;
  scrap: ColumnType<unknown, string, string>;
  rework_passes: number;
  material: ColumnType<unknown, string, string>;
  totals: ColumnType<unknown, string, string>;
  confirmed_at: Timestamp;
  idempotency_key: string;
  created_at: DefaultTimestamp;
}

export interface OrdersTables {
  'orders.erp_cursor': ErpCursorTable;
  'orders.production_order': ProductionOrderTable;
  'orders.order_operation': OrderOperationTable;
  'orders.dispatch_command': DispatchCommandTable;
  'orders.command_attempt': CommandAttemptTable;
  'orders.erp_message_log': ErpMessageLogTable;
  'orders.order_incident': OrderIncidentTable;
  'orders.confirmation': ConfirmationTable;
  'orders.operation_activity': OperationActivityTable;
}

export const ORDERS_COLUMNS = {
  'orders.erp_cursor': ['id', 'feed_id', 'cursor', 'updated_at'],
  'orders.production_order': [
    'id',
    'revision',
    'feed_seq',
    'product',
    'quantity',
    'priority',
    'planned_start',
    'due_date',
    'erp_status',
    'status',
    'short',
    'dispatch_failed',
    'dispatch_lost',
    'rejection',
    'routing',
    'bom',
    'version',
    'imported_at',
    'updated_at',
    'released_at',
    'dispatched_at',
    'started_at',
    'completed_at',
    'closed_at',
    'cancelled_at',
  ],
  'orders.order_operation': [
    'order_id',
    'operation',
    'position',
    'work_center',
    'version',
    'signed_off_user_id',
    'signed_off_by',
    'signed_off_at',
    'signed_off_plant_at',
  ],
  'orders.dispatch_command': [
    'command_id',
    'order_id',
    'n',
    'equipment',
    'product',
    'quantity',
    'not_before',
    'device_epoch',
    'queue_position',
    'created_at',
    'updated_at',
    'state',
    'settled',
    'final',
    'failed',
    'accepted_by',
    'accepted_seq',
    'accepted_at',
    'confirmed',
    'job',
    'started_at',
    'completed_at',
    'lost_started',
    'rejection',
    'seq_after_expiry',
  ],
  'orders.command_attempt': [
    'command_id',
    'attempt',
    'issued_at',
    'expires_at',
    'mes_epoch',
    'mes_seq',
    'stored_seq',
    'published_at',
  ],
  'orders.erp_message_log': [
    'id',
    'direction',
    'kind',
    'order_id',
    'revision',
    'idempotency_key',
    'feed_id',
    'feed_seq',
    'payload',
    'status',
    'detail',
    'attempts',
    'last_error',
    'next_attempt_at',
    'receipt',
    'created_at',
    'updated_at',
  ],
  'orders.order_incident': [
    'id',
    'type',
    'key',
    'order_id',
    'command_id',
    'equipment',
    'message',
    'detected_at',
    'closed_at',
    'resolution',
  ],
  'orders.confirmation': [
    'order_id',
    'operation',
    'n',
    'kind',
    'revision',
    'yield',
    'scrap',
    'rework_passes',
    'material',
    'totals',
    'confirmed_at',
    'idempotency_key',
    'created_at',
  ],
  'orders.operation_activity': [
    'id',
    'order_id',
    'operation',
    'work_center',
    'user_id',
    'username',
    'kind',
    'reason',
    'comment',
    'from_at',
    'from_plant_at',
    'to_at',
    'to_plant_at',
    'end_reason',
  ],
} as const;
