export interface Part {
  readonly id: number;
  readonly product: string;
  serial?: string;
  leakFailures?: number;
  /** Orders mode (#172): the command id of the job whose blank this part is. */
  readonly commandId?: string;
  readonly lots: { readonly material: string; readonly lotId: string }[];
}

export class PartBuffer {
  readonly from: string;
  readonly to: string;
  readonly capacity: number;
  readonly #items: Part[] = [];

  constructor(from: string, to: string, capacity: number) {
    this.from = from;
    this.to = to;
    this.capacity = capacity;
  }

  get size(): number {
    return this.#items.length;
  }

  get isFull(): boolean {
    return this.#items.length >= this.capacity;
  }

  push(part: Part): void {
    if (this.isFull) {
      throw new RangeError(`buffer ${this.from}→${this.to} is full`);
    }
    this.#items.push(part);
  }

  contents(): Part[] {
    return [...this.#items];
  }

  peek(): Part | undefined {
    return this.#items[0];
  }

  shift(): Part | undefined {
    return this.#items.shift();
  }
}
