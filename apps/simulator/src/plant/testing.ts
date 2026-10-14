import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { PlantEvent, ProductionLine } from './line.ts';

export async function loadDefaultConfig(): Promise<PlantConfig> {
  const result = await loadPlantConfig(resolve(import.meta.dirname, '../../../../config/plant'));
  if (!result.ok) {
    throw new Error(formatIssues(result.issues));
  }
  return result.config;
}

export function continuousOperation(config: PlantConfig): void {
  config.shifts.workdays = [
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY',
  ];
  config.shifts.shifts = [{ id: 'A', start: '06:00', end: '06:00' }];
  config.operators.operators = [
    { id: 'op-test', shift: 'A', skills: ['asm-01', 'lkt-01', 'pck-01'], speedFactor: 1 },
  ];
  config.operators.absenceProbabilityPerShift = 0;
  unlimitedMaterial(config);
}

export function unlimitedMaterial(config: PlantConfig): void {
  config.stock.lots = config.stock.lots.map((lot) => ({ ...lot, quantity: 1_000_000_000 }));
}

export function runningTimeBetween(
  events: readonly PlantEvent[],
  machineId: string,
  isMark: (event: PlantEvent) => boolean,
): number[] {
  const gaps: number[] = [];
  let running = 0;
  let runningSince: number | undefined;
  for (const event of events) {
    if (!('machineId' in event) || event.machineId !== machineId) {
      continue;
    }
    if (event.type === 'state') {
      if (runningSince !== undefined) {
        running += event.at - runningSince;
        runningSince = undefined;
      }
      if (event.to === 'Running') {
        runningSince = event.at;
      }
    }
    if (isMark(event)) {
      const extra = runningSince === undefined ? 0 : event.at - runningSince;
      gaps.push(running + extra);
      running = -extra;
    }
  }
  return gaps;
}

export function partsAccountedFor(line: ProductionLine): number {
  const inBuffers = line.buffers.reduce((sum, buffer) => sum + buffer.size, 0);
  const inMachines = line.stations.filter((station) => station.part !== undefined).length;
  const inRework = line.stations.reduce((sum, station) => sum + (station.rework?.length ?? 0), 0);
  return line.finished.length + line.scrapped.length + inBuffers + inMachines + inRework;
}
