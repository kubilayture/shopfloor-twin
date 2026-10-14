import type { Duration, SimTime } from '@shopfloor/sim-core';

export interface DueTimer {
  readonly name: string;
  readonly remaining: Duration;
}

export class RunningClock {
  readonly #remaining = new Map<string, Duration>();
  readonly #priority: readonly string[];
  #since: SimTime | undefined;

  constructor(priority: readonly string[] = []) {
    this.#priority = priority;
  }

  get isRunning(): boolean {
    return this.#since !== undefined;
  }

  remaining(name: string): Duration | undefined {
    return this.#remaining.get(name);
  }

  set(name: string, duration: Duration, now: SimTime): void {
    this.sync(now);
    this.#remaining.set(name, duration);
  }

  delete(name: string, now: SimTime): void {
    this.sync(now);
    this.#remaining.delete(name);
  }

  start(now: SimTime): void {
    if (this.#since === undefined) {
      this.#since = now;
    }
  }

  pause(now: SimTime): void {
    this.sync(now);
    this.#since = undefined;
  }

  sync(now: SimTime): void {
    if (this.#since === undefined) {
      return;
    }
    const elapsed = now - this.#since;
    if (elapsed < 0) {
      throw new RangeError(
        `running clock cannot go back from ${String(this.#since)} to ${String(now)}`,
      );
    }
    for (const [name, remaining] of this.#remaining) {
      this.#remaining.set(name, remaining - elapsed);
    }
    this.#since = now;
  }

  next(): DueTimer | undefined {
    let best: DueTimer | undefined;
    for (const name of this.#ordered()) {
      const remaining = this.#remaining.get(name) ?? Number.POSITIVE_INFINITY;
      if (!best || remaining < best.remaining) {
        best = { name, remaining };
      }
    }
    return best;
  }

  #ordered(): string[] {
    const rank = (name: string): number => {
      const index = this.#priority.indexOf(name);
      return index < 0 ? this.#priority.length : index;
    };
    return [...this.#remaining.keys()].sort(
      (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
  }
}
