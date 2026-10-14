import type { SimTime } from './sim-time.ts';

export interface QueuedEvent<E> {
  readonly time: SimTime;
  readonly sequence: number;
  readonly event: E;
}

interface Entry<E> extends QueuedEvent<E> {
  cancelled: boolean;
}

export interface EventHandle {
  readonly time: SimTime;
  readonly sequence: number;
}

const precedes = <E>(a: Entry<E>, b: Entry<E>): boolean =>
  a.time < b.time || (a.time === b.time && a.sequence < b.sequence);

export class EventQueue<E> {
  readonly #heap: Entry<E>[] = [];
  readonly #bySequence = new Map<number, Entry<E>>();
  #nextSequence = 0;

  get size(): number {
    return this.#bySequence.size;
  }

  push(time: SimTime, event: E): EventHandle {
    const entry: Entry<E> = { time, sequence: this.#nextSequence++, event, cancelled: false };
    this.#heap.push(entry);
    this.#bySequence.set(entry.sequence, entry);
    this.#siftUp(this.#heap.length - 1);
    return { time: entry.time, sequence: entry.sequence };
  }

  cancel(handle: EventHandle): boolean {
    const entry = this.#bySequence.get(handle.sequence);
    if (!entry) {
      return false;
    }
    entry.cancelled = true;
    this.#bySequence.delete(handle.sequence);
    return true;
  }

  peek(): QueuedEvent<E> | undefined {
    this.#dropCancelledHead();
    const head = this.#heap[0];
    return head && { time: head.time, sequence: head.sequence, event: head.event };
  }

  pop(): QueuedEvent<E> | undefined {
    this.#dropCancelledHead();
    const head = this.#removeHead();
    if (!head) {
      return undefined;
    }
    this.#bySequence.delete(head.sequence);
    return { time: head.time, sequence: head.sequence, event: head.event };
  }

  #dropCancelledHead(): void {
    while (this.#heap[0]?.cancelled) {
      this.#removeHead();
    }
  }

  #removeHead(): Entry<E> | undefined {
    const head = this.#heap[0];
    const last = this.#heap.pop();
    if (head && last && last !== head) {
      this.#heap[0] = last;
      this.#siftDown(0);
    }
    return head;
  }

  #siftUp(start: number): void {
    const heap = this.#heap;
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!precedes(this.#at(index), this.#at(parent))) {
        return;
      }
      [heap[index], heap[parent]] = [this.#at(parent), this.#at(index)];
      index = parent;
    }
  }

  #siftDown(start: number): void {
    const heap = this.#heap;
    let index = start;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && precedes(this.#at(left), this.#at(smallest))) {
        smallest = left;
      }
      if (right < heap.length && precedes(this.#at(right), this.#at(smallest))) {
        smallest = right;
      }
      if (smallest === index) {
        return;
      }
      [heap[index], heap[smallest]] = [this.#at(smallest), this.#at(index)];
      index = smallest;
    }
  }

  #at(index: number): Entry<E> {
    const entry = this.#heap[index];
    if (!entry) {
      throw new RangeError(`Heap index ${String(index)} out of bounds`);
    }
    return entry;
  }
}
