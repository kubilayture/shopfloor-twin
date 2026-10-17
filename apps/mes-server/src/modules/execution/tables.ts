import type { ColumnType, Generated } from 'kysely';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** Defaults to clock_timestamp() in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export type UnitStatus = 'wip' | 'packed' | 'scrapped' | 'lost';
export type RoutingViolation = 'missing-predecessor' | 'repeated' | 'after-terminal';

export interface UnitTable {
  epoch: number;
  part_id: number;
  serial: string | null;
  product: string;
  order_id: string | null;
  command_id: string | null;
  status: UnitStatus;
  position: string;
  last_at: Timestamp;
  terminal_at: NullableTimestamp;
  suspect: Exclude<RoutingViolation, 'after-terminal'> | null;
  suspect_operation: string | null;
  suspect_before: NullableTimestamp;
  violation: RoutingViolation | null;
  updated_at: DefaultTimestamp;
}

export interface OperationRecordTable {
  equipment: string;
  epoch: number;
  seq: number;
  part_id: number;
  operation: string;
  pass: number;
  completed_at: Timestamp;
  result: 'good' | 'scrap' | 'rework';
  reason: string | null;
  order_id: string | null;
}

export interface ScrapRecordTable {
  id: Generated<number>;
  equipment: string;
  epoch: number;
  seq: number;
  part_id: number;
  serial: string | null;
  order_id: string | null;
  operation: string;
  pass: number;
  scrapped_at: Timestamp;
  machine_reason: string;
  coded_reason: string | null;
  comment: string | null;
  coded_by: string | null;
  coded_at: NullableTimestamp;
  version: Defaulted<number>;
}

export interface ExecutionIncidentTable {
  id: Generated<number>;
  type: 'routing-violation';
  key: string;
  epoch: number | null;
  part_id: number | null;
  order_id: string | null;
  equipment: string | null;
  message: string;
  detected_at: DefaultTimestamp;
  closed_at: NullableTimestamp;
  resolution: string | null;
}

export interface ExecutionTables {
  'execution.unit': UnitTable;
  'execution.operation_record': OperationRecordTable;
  'execution.scrap_record': ScrapRecordTable;
  'execution.execution_incident': ExecutionIncidentTable;
}

export const EXECUTION_COLUMNS = {
  'execution.unit': [
    'epoch',
    'part_id',
    'serial',
    'product',
    'order_id',
    'command_id',
    'status',
    'position',
    'last_at',
    'terminal_at',
    'suspect',
    'suspect_operation',
    'suspect_before',
    'violation',
    'updated_at',
  ],
  'execution.operation_record': [
    'equipment',
    'epoch',
    'seq',
    'part_id',
    'operation',
    'pass',
    'completed_at',
    'result',
    'reason',
    'order_id',
  ],
  'execution.scrap_record': [
    'id',
    'equipment',
    'epoch',
    'seq',
    'part_id',
    'serial',
    'order_id',
    'operation',
    'pass',
    'scrapped_at',
    'machine_reason',
    'coded_reason',
    'comment',
    'coded_by',
    'coded_at',
    'version',
  ],
  'execution.execution_incident': [
    'id',
    'type',
    'key',
    'epoch',
    'part_id',
    'order_id',
    'equipment',
    'message',
    'detected_at',
    'closed_at',
    'resolution',
  ],
} as const;
