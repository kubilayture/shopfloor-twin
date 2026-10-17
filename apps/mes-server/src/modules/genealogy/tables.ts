import type { ColumnType, Generated } from 'kysely';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** Defaults to clock_timestamp() in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type LotStatus = 'active' | 'retired';
export type CartonStatus = 'open' | 'closed';
export type GenealogyIncidentType = 'unknown-lot' | 'serial-reused' | 'material-mismatch';
export type LinkKind = 'lot-unit' | 'unit-carton';

/** A cycle's measurement as the fact reported it (UNS `measurement`). */
export interface StoredMeasurement {
  readonly characteristic: string;
  readonly value: number;
  readonly unit: string;
  readonly upperLimit: number;
}

export interface MaterialLotTable {
  id: string;
  material: string;
  quantity: number;
  status: LotStatus;
  feed_id: string;
  imported_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface SerialUnitTable {
  epoch: number;
  part_id: number;
  serial: string | null;
  product: string;
  order_id: string | null;
  status: 'wip' | 'packed' | 'scrapped' | 'lost';
  carton_id: string | null;
  updated_at: DefaultTimestamp;
}

export interface UnitRecordTable {
  equipment: string;
  epoch: number;
  seq: number;
  part_id: number;
  operation: string;
  pass: number;
  completed_at: Timestamp;
  result: 'good' | 'scrap' | 'rework';
  reason: string | null;
  lots_reported: boolean;
  operator: string | null;
  operator_reported: boolean;
  measurement: ColumnType<StoredMeasurement | null, string | null, string | null>;
}

export interface GenealogyLinkTable {
  kind: LinkKind;
  epoch: number;
  part_id: number;
  at: Timestamp;
  position: number;
  lot: string | null;
  material: string | null;
  operation: string | null;
  pass: number | null;
  equipment: string | null;
  seq: number | null;
  carton_id: string | null;
}

export interface CartonTable {
  id: string;
  order_id: string;
  number: number;
  product: string;
  capacity: number;
  status: CartonStatus;
  closed_at: NullableTimestamp;
  members: number;
  updated_at: DefaultTimestamp;
}

export interface GenealogyIncidentTable {
  id: Generated<number>;
  type: GenealogyIncidentType;
  key: string;
  lot: string | null;
  epoch: number | null;
  part_id: number | null;
  equipment: string | null;
  message: string;
  detected_at: DefaultTimestamp;
  closed_at: NullableTimestamp;
  resolution: string | null;
}

export interface GenealogyTables {
  'genealogy.material_lot': MaterialLotTable;
  'genealogy.serial_unit': SerialUnitTable;
  'genealogy.unit_record': UnitRecordTable;
  'genealogy.genealogy_link': GenealogyLinkTable;
  'genealogy.carton': CartonTable;
  'genealogy.genealogy_incident': GenealogyIncidentTable;
}

export const GENEALOGY_COLUMNS = {
  'genealogy.material_lot': [
    'id',
    'material',
    'quantity',
    'status',
    'feed_id',
    'imported_at',
    'updated_at',
  ],
  'genealogy.serial_unit': [
    'epoch',
    'part_id',
    'serial',
    'product',
    'order_id',
    'status',
    'carton_id',
    'updated_at',
  ],
  'genealogy.unit_record': [
    'equipment',
    'epoch',
    'seq',
    'part_id',
    'operation',
    'pass',
    'completed_at',
    'result',
    'reason',
    'lots_reported',
    'operator',
    'operator_reported',
    'measurement',
  ],
  'genealogy.genealogy_link': [
    'kind',
    'epoch',
    'part_id',
    'at',
    'position',
    'lot',
    'material',
    'operation',
    'pass',
    'equipment',
    'seq',
    'carton_id',
  ],
  'genealogy.carton': [
    'id',
    'order_id',
    'number',
    'product',
    'capacity',
    'status',
    'closed_at',
    'members',
    'updated_at',
  ],
  'genealogy.genealogy_incident': [
    'id',
    'type',
    'key',
    'lot',
    'epoch',
    'part_id',
    'equipment',
    'message',
    'detected_at',
    'closed_at',
    'resolution',
  ],
} as const;
