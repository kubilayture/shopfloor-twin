import type { JSONColumnType } from 'kysely';
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

export interface MasterDataTables {
  'master_data.site': SiteTable;
  'master_data.area': AreaTable;
  'master_data.work_center': WorkCenterTable;
  'master_data.equipment': EquipmentTable;
  'master_data.product': ProductTable;
  'master_data.shift_pattern': ShiftPatternTable;
}

export const MASTER_DATA_COLUMNS = {
  'master_data.site': ['id', 'name', 'enterprise_id', 'enterprise_name'],
  'master_data.area': ['id', 'site_id', 'name'],
  'master_data.work_center': ['id', 'area_id', 'name'],
  'master_data.equipment': ['id', 'work_center_id', 'name', 'operation', 'interface', 'position'],
  'master_data.product': ['id', 'name', 'ideal_cycle_seconds'],
  'master_data.shift_pattern': ['id', 'time_zone', 'workdays', 'shifts'],
} as const;
