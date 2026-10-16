import { readFile } from 'node:fs/promises';
import {
  expandErpDataset,
  type ErpMasterData,
  type FeedEntry,
  type Lot,
} from '@shopfloor/contracts/erp-api';
import { formatIssues, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { parse } from 'yaml';

/**
 * The ERP's master data from the plant configuration (ADR-0028): routings from `products.yaml`'s
 * operations, each run by the work center of the equipment for that operation (`plant.yaml`);
 * BOMs from the products' blank, components and rework components; lots from `stock.yaml`.
 */
export function masterDataFrom(config: PlantConfig): ErpMasterData {
  const workCenterByOperation: Record<string, string> = {};
  for (const area of config.plant.areas) {
    for (const workCenter of area.workCenters) {
      for (const equipment of workCenter.equipment) {
        const known = workCenterByOperation[equipment.operation];
        if (known !== undefined && known !== workCenter.id) {
          throw new Error(
            `${equipment.operation} runs in two work centers (${known}, ${workCenter.id}); a routing needs one`,
          );
        }
        workCenterByOperation[equipment.operation] = workCenter.id;
      }
    }
  }
  return {
    operations: config.products.operations,
    componentsOperation: config.products.componentsOperation,
    products: config.products.products,
    workCenterByOperation,
    lots: config.stock.lots,
  };
}

export interface Dataset {
  readonly feed: readonly FeedEntry[];
  readonly lots: readonly Lot[];
  readonly master: ErpMasterData;
}

/** Loads the plant master data and the dataset file (YAML, or JSON as a scenario's `orders.json`). */
export async function loadDataset(datasetPath: string, plantDir: string): Promise<Dataset> {
  const loaded = await loadPlantConfig(plantDir);
  if (!loaded.ok) throw new Error(`plant configuration:\n${formatIssues(loaded.issues)}`);
  const master = masterDataFrom(loaded.config);
  const raw: unknown = parse(await readFile(datasetPath, 'utf8'));
  const result = expandErpDataset(raw, master);
  if (!result.ok) {
    throw new Error(`ERP dataset ${datasetPath}:\n  ${result.issues.join('\n  ')}`);
  }
  return { feed: result.feed, lots: result.lots, master };
}
