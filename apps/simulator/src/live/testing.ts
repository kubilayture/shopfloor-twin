import type { WallClock } from './pacer.ts';

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

export class ManualClock implements WallClock {
  #now = 0;
  #nextId = 1;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const timer = { id: this.#nextId++, at: this.#now + Math.max(0, ms), callback };
    this.#timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      const due = this.#timers
        .filter((t) => t.at <= until)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) {
        break;
      }
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = due.at;
      due.callback();
    }
    this.#now = until;
  }
}
