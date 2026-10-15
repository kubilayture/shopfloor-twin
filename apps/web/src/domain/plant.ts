import type { EquipmentDto } from '@shopfloor/contracts/mes-api';

export interface WorkCenterGroup {
  readonly id: string;
  readonly name: string;
  readonly equipment: EquipmentDto[];
}

export interface AreaGroup {
  readonly id: string;
  readonly name: string;
  readonly workCenters: WorkCenterGroup[];
}

/** Equipment by area and work center, each in line order (`position`). */
export function groupEquipment(equipment: readonly EquipmentDto[]): AreaGroup[] {
  const areas = new Map<string, { name: string; centers: Map<string, WorkCenterGroup> }>();
  for (const item of [...equipment].sort((a, b) => a.position - b.position)) {
    let area = areas.get(item.area.id);
    if (!area) {
      area = { name: item.area.name, centers: new Map() };
      areas.set(item.area.id, area);
    }
    let center = area.centers.get(item.workCenter.id);
    if (!center) {
      center = { id: item.workCenter.id, name: item.workCenter.name, equipment: [] };
      area.centers.set(item.workCenter.id, center);
    }
    center.equipment.push(item);
  }
  return [...areas].map(([id, area]) => ({
    id,
    name: area.name,
    workCenters: [...area.centers.values()],
  }));
}
