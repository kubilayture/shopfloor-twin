import type { PlantConfig } from '@shopfloor/plant-config';
import type { SimTime } from '@shopfloor/sim-core';
import type { PlantEvent, ProductionLine } from '../plant/line.ts';

export class InvariantViolation extends Error {
  constructor(at: SimTime, message: string) {
    super(`invariant violated at ${new Date(at).toISOString()}: ${message}`);
    this.name = 'InvariantViolation';
  }
}

export class InvariantChecker {
  readonly #line: ProductionLine;
  readonly #start: SimTime;
  readonly #initialLots: ReadonlyMap<string, number>;
  readonly #consumed = new Map<string, number>();
  #checks = 0;

  constructor(line: ProductionLine, config: PlantConfig, start: SimTime) {
    this.#line = line;
    this.#start = start;
    this.#initialLots = new Map(config.stock.lots.map((lot) => [lot.id, lot.quantity]));
  }

  get checks(): number {
    return this.#checks;
  }

  record(event: PlantEvent): void {
    if (event.type === 'material-consumed') {
      this.#consumed.set(event.lotId, (this.#consumed.get(event.lotId) ?? 0) + 1);
    }
  }

  check(now: SimTime): void {
    this.#checks++;
    const line = this.#line;
    const inBuffers = line.buffers.reduce((sum, buffer) => sum + buffer.size, 0);
    const inMachines = line.stations.filter((station) => station.part !== undefined).length;
    const inRework = line.stations.reduce((sum, station) => sum + (station.rework?.length ?? 0), 0);
    const accounted =
      line.finished.length + line.scrapped.length + inBuffers + inMachines + inRework;
    if (accounted !== line.producedParts) {
      throw new InvariantViolation(
        now,
        `parts started ${String(line.producedParts)} ≠ finished ${String(line.finished.length)} + scrapped ${String(line.scrapped.length)} + buffered ${String(inBuffers)} + in machines ${String(inMachines)} + in rework ${String(inRework)}`,
      );
    }
    for (const station of line.stations) {
      const total = Object.values(station.machine.durations(now)).reduce((sum, d) => sum + d, 0);
      if (total !== now - this.#start) {
        throw new InvariantViolation(
          now,
          `${station.id}: time in states ${String(total)} ms ≠ elapsed ${String(now - this.#start)} ms`,
        );
      }
    }
    for (const [lotId, initial] of this.#initialLots) {
      const used = this.#consumed.get(lotId) ?? 0;
      const remaining = line.inventory.remaining(lotId);
      if (remaining === undefined || used + remaining !== initial) {
        throw new InvariantViolation(
          now,
          `lot ${lotId}: consumed ${String(used)} + remaining ${String(remaining)} ≠ initial ${String(initial)}`,
        );
      }
    }
  }
}
