import type { ColumnType, JSONColumnType } from 'kysely';
import type { ShiftPattern } from '@shopfloor/shift-calendar';

export interface SiteTable {
  id: string;
  name: string;
  enterprise_id: string;
  enterprise_name: string;
}

export interface AreaTable {
  id: string;
  site_id: string;
  name: string;
}

export interface WorkCenterTable {
  id: string;
  area_id: string;
  name: string;
}

export interface EquipmentTable {
  id: string;
  work_center_id: string;
  name: string;
  operation: string;
  interface: 'opcua' | 'modbus';
  position: number;
}

export interface ProductTable {
  id: string;
  name: string;
  ideal_cycle_seconds: JSONColumnType<Record<string, number>>;
}

export interface ShiftPatternTable {
  id: string;
  time_zone: string;
  workdays: ShiftPattern['workdays'][number][];
  shifts: JSONColumnType<ShiftPattern['shifts']>;
}

/** The downtime reason tree (#119), from config/plant/reasons.yaml. */
export interface ReasonCodeTable {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  active: ColumnType<boolean, boolean | undefined, boolean>;
}

/** Operator positions for alarm KPIs (#141), from config/plant/alarms.yaml. */
export interface AlarmPositionTable {
  id: string;
  name: string;
  position: number;
  active: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface AlarmPositionWorkCenterTable {
  work_center_id: string;
  position_id: string;
}

/** One alarm point per (equipment, code) (#141), from config/plant/alarms.yaml. */
export interface AlarmDefinitionTable {
  equipment_id: string;
  code: string;
  priority: 'high' | 'medium' | 'low';
  text: string;
  consequence: string | null;
  response: string | null;
  position: number;
  active: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface MasterDataTables {
  'master_data.site': SiteTable;
  'master_data.area': AreaTable;
  'master_data.work_center': WorkCenterTable;
  'master_data.equipment': EquipmentTable;
  'master_data.product': ProductTable;
  'master_data.shift_pattern': ShiftPatternTable;
  'master_data.reason_code': ReasonCodeTable;
  'master_data.alarm_position': AlarmPositionTable;
  'master_data.alarm_position_work_center': AlarmPositionWorkCenterTable;
  'master_data.alarm_definition': AlarmDefinitionTable;
}

export const MASTER_DATA_COLUMNS = {
  'master_data.site': ['id', 'name', 'enterprise_id', 'enterprise_name'],
  'master_data.area': ['id', 'site_id', 'name'],
  'master_data.work_center': ['id', 'area_id', 'name'],
  'master_data.equipment': ['id', 'work_center_id', 'name', 'operation', 'interface', 'position'],
  'master_data.product': ['id', 'name', 'ideal_cycle_seconds'],
  'master_data.shift_pattern': ['id', 'time_zone', 'workdays', 'shifts'],
  'master_data.reason_code': ['id', 'parent_id', 'name', 'position', 'active'],
  'master_data.alarm_position': ['id', 'name', 'position', 'active'],
  'master_data.alarm_position_work_center': ['work_center_id', 'position_id'],
  'master_data.alarm_definition': [
    'equipment_id',
    'code',
    'priority',
    'text',
    'consequence',
    'response',
    'position',
    'active',
  ],
} as const;
