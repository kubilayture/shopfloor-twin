import type { ColumnType, Generated } from 'kysely';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** Defaults to clock_timestamp() in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Defaulted<T> = ColumnType<T, T | undefined, T>;
/** JSONB: read as parsed JSON, written as a JSON string. */
type Json<T> = ColumnType<T, string, string>;
type NullableJson<T> = ColumnType<T | null, string | null, string | null>;

export type SignalStatus = 'provisional' | 'final' | 'withdrawn';

/** Rules per chart, as `quality.yaml` lists them. */
export interface StoredRules {
  readonly I: readonly number[];
  readonly MR: readonly number[];
  readonly Xbar: readonly number[];
  readonly R: readonly number[];
}

/** A position as stored inside a limit version's JSON: plant time as ISO text. */
export interface StoredPosition {
  readonly epoch: number;
  readonly at: string;
  readonly seq: number;
}

/** `spc-core`'s ChartLimits with exact fractions as text (`formatFraction`). */
export interface StoredLimits {
  readonly subgroupSize: number;
  readonly window: { readonly from: StoredPosition; readonly to: StoredPosition };
  readonly counts: {
    readonly readings: number;
    readonly movingRanges: number;
    readonly subgroups: number;
  };
  readonly statistics: {
    readonly mean: string;
    readonly movingRange: string;
    readonly grandMean: string;
    readonly range: string;
  };
  readonly charts: Readonly<
    Record<
      'I' | 'MR' | 'Xbar' | 'R',
      { readonly lower: string; readonly centre: string; readonly upper: string }
    >
  >;
}

export interface CharacteristicTable {
  id: string;
  name: string;
  equipment: string;
  operation: string;
  unit: string;
  resolution: number;
  upper_spec: number;
  subgroup_size: number;
  baseline_subgroups: number;
  rules: Json<StoredRules>;
  version: Defaulted<number>;
  notice_kind: 'baseline-changed' | null;
  notice_at: NullableTimestamp;
  notice_detail: string | null;
  notice_basis: string | null;
  updated_at: DefaultTimestamp;
}

export interface MeasurementTable {
  equipment: string;
  epoch: number;
  seq: number;
  characteristic: string;
  part_id: number;
  pass: number;
  measured_at: Timestamp;
  value: number;
  steps: number;
  unit: string;
  upper_limit: number;
  result: 'good' | 'scrap' | 'rework';
}

export interface ControlLimitTable {
  characteristic: string;
  n: number;
  kind: 'created' | 'ended';
  version: number;
  plant_at: Timestamp;
  position_epoch: number | null;
  position_at: NullableTimestamp;
  position_seq: number | null;
  limits: NullableJson<StoredLimits>;
  comment: string | null;
  actor: string;
  recorded_at: DefaultTimestamp;
}

export interface SpcSignalTable {
  id: Generated<number>;
  characteristic: string;
  limit_version: number;
  chart: 'I' | 'MR' | 'Xbar' | 'R';
  rule: number;
  epoch: number;
  part_id: number;
  pass: number;
  first_at: Timestamp;
  first_seq: number;
  last_epoch: number;
  last_part_id: number;
  last_pass: number;
  last_at: Timestamp;
  last_seq: number;
  points: number;
  closed_epoch: number | null;
  closed_part_id: number | null;
  closed_pass: number | null;
  closed_at: NullableTimestamp;
  closed_seq: number | null;
  baseline: boolean;
  extent_final: boolean;
  status: SignalStatus;
  detected_at: DefaultTimestamp;
  detected_plant_at: NullableTimestamp;
  final_at: NullableTimestamp;
  withdrawn_at: NullableTimestamp;
  withdrawn_reason: string | null;
  ack_by: string | null;
  ack_at: NullableTimestamp;
  ack_plant_at: NullableTimestamp;
  ack_comment: string | null;
  row_version: Defaulted<number>;
}

export interface QualityTables {
  'quality.characteristic': CharacteristicTable;
  'quality.measurement': MeasurementTable;
  'quality.control_limit': ControlLimitTable;
  'quality.spc_signal': SpcSignalTable;
  'quality.hold': HoldTable;
  'quality.hold_transition': HoldTransitionTable;
  'quality.hold_unit': HoldUnitTable;
  'quality.hold_incident': HoldIncidentTable;
}

export type HoldSubjectKind = 'lot' | 'serial' | 'carton' | 'order';
export type HoldState = 'open' | 'released' | 'rejected';
export type HoldTransitionKind = 'opened' | 'commented' | 'released' | 'rejected';

/** The scope counts a notifying transition carried (#201). */
export interface StoredScope {
  readonly units: number;
  readonly cartons: number;
  readonly orders: number;
  /** Plant time the counts stand at (ISO), or null without a plant clock. */
  readonly asOf: string | null;
  readonly final: boolean;
}

export interface HoldTable {
  id: string;
  subject_kind: HoldSubjectKind;
  subject_id: string;
  state: HoldState;
  reason: string;
  opened_by: string;
  opened_at: DefaultTimestamp;
  opened_plant_at: NullableTimestamp;
  decided_by: string | null;
  decided_at: NullableTimestamp;
  decided_plant_at: NullableTimestamp;
  decision_reason: string | null;
  transitions: Defaulted<number>;
  version: Defaulted<number>;
  updated_at: DefaultTimestamp;
}

export interface HoldTransitionTable {
  hold_id: string;
  n: number;
  kind: HoldTransitionKind;
  reason: string | null;
  comment: string | null;
  actor: string;
  at: DefaultTimestamp;
  plant_at: NullableTimestamp;
  scope: NullableJson<StoredScope>;
}

export interface HoldUnitTable {
  hold_id: string;
  epoch: number;
  part_id: number;
  serial: string | null;
  order_id: string | null;
  carton_id: string | null;
  joined_at: DefaultTimestamp;
}

export interface HoldIncidentTable {
  id: Generated<number>;
  type: 'held-material-consumed';
  hold_id: string;
  lot: string;
  equipment: string;
  epoch: number;
  seq: number;
  part_id: number;
  operation: string | null;
  pass: number | null;
  consumed_at: Timestamp;
  message: string;
  detected_at: DefaultTimestamp;
}

export const QUALITY_COLUMNS = {
  'quality.characteristic': [
    'id',
    'name',
    'equipment',
    'operation',
    'unit',
    'resolution',
    'upper_spec',
    'subgroup_size',
    'baseline_subgroups',
    'rules',
    'version',
    'notice_kind',
    'notice_at',
    'notice_detail',
    'notice_basis',
    'updated_at',
  ],
  'quality.measurement': [
    'equipment',
    'epoch',
    'seq',
    'characteristic',
    'part_id',
    'pass',
    'measured_at',
    'value',
    'steps',
    'unit',
    'upper_limit',
    'result',
  ],
  'quality.control_limit': [
    'characteristic',
    'n',
    'kind',
    'version',
    'plant_at',
    'position_epoch',
    'position_at',
    'position_seq',
    'limits',
    'comment',
    'actor',
    'recorded_at',
  ],
  'quality.spc_signal': [
    'id',
    'characteristic',
    'limit_version',
    'chart',
    'rule',
    'epoch',
    'part_id',
    'pass',
    'first_at',
    'first_seq',
    'last_epoch',
    'last_part_id',
    'last_pass',
    'last_at',
    'last_seq',
    'points',
    'closed_epoch',
    'closed_part_id',
    'closed_pass',
    'closed_at',
    'closed_seq',
    'baseline',
    'extent_final',
    'status',
    'detected_at',
    'detected_plant_at',
    'final_at',
    'withdrawn_at',
    'withdrawn_reason',
    'ack_by',
    'ack_at',
    'ack_plant_at',
    'ack_comment',
    'row_version',
  ],
  'quality.hold': [
    'id',
    'subject_kind',
    'subject_id',
    'state',
    'reason',
    'opened_by',
    'opened_at',
    'opened_plant_at',
    'decided_by',
    'decided_at',
    'decided_plant_at',
    'decision_reason',
    'transitions',
    'version',
    'updated_at',
  ],
  'quality.hold_transition': [
    'hold_id',
    'n',
    'kind',
    'reason',
    'comment',
    'actor',
    'at',
    'plant_at',
    'scope',
  ],
  'quality.hold_unit': [
    'hold_id',
    'epoch',
    'part_id',
    'serial',
    'order_id',
    'carton_id',
    'joined_at',
  ],
  'quality.hold_incident': [
    'id',
    'type',
    'hold_id',
    'lot',
    'equipment',
    'epoch',
    'seq',
    'part_id',
    'operation',
    'pass',
    'consumed_at',
    'message',
    'detected_at',
  ],
} as const;
