import type { PlantConfig } from '@shopfloor/plant-config';

interface Lot {
  readonly id: string;
  readonly material: string;
  remaining: number;
  blocked: boolean;
}

export class Inventory {
  readonly #lots: Lot[];

  constructor(stock: PlantConfig['stock']) {
    this.#lots = stock.lots.map((lot) => ({
      id: lot.id,
      material: lot.material,
      remaining: lot.quantity,
      blocked: false,
    }));
  }

  available(material: string): boolean {
    return this.#nextLot(material) !== undefined;
  }

  consume(material: string): string {
    const lot = this.#nextLot(material);
    if (!lot) {
      throw new RangeError(`no usable lot of ${material}`);
    }
    lot.remaining--;
    return lot.id;
  }

  setBlocked(lotId: string, blocked: boolean): string {
    const lot = this.#lots.find((l) => l.id === lotId);
    if (!lot) {
      throw new RangeError(`unknown lot "${lotId}"`);
    }
    lot.blocked = blocked;
    return lot.material;
  }

  remaining(lotId: string): number | undefined {
    return this.#lots.find((l) => l.id === lotId)?.remaining;
  }

  #nextLot(material: string): Lot | undefined {
    return this.#lots.find((l) => l.material === material && !l.blocked && l.remaining > 0);
  }
}
