import type { EquipmentPath } from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';

/** Equipment id → its ISA-95 path in the UNS, from config/plant/plant.yaml. */
export function equipmentPaths(config: PlantConfig): ReadonlyMap<string, EquipmentPath> {
  return new Map(
    config.plant.areas.flatMap((area) =>
      area.workCenters.flatMap((workCenter) =>
        workCenter.equipment.map(
          (item) =>
            [item.id, { area: area.id, workCenter: workCenter.id, equipment: item.id }] as const,
        ),
      ),
    ),
  );
}
