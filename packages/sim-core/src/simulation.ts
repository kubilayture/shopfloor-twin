import { EventQueue, type EventHandle } from './event-queue.ts';
import { assertSimTime, type Duration, type SimTime } from './sim-time.ts';

export type EventHandler<E> = (event: E, simulation: Simulation<E>) => void;

export class Simulation<E> {
  readonly #queue = new EventQueue<E>();
  #now: SimTime;

  constructor(startTime: SimTime) {
    assertSimTime(startTime, 'startTime');
    this.#now = startTime;
  }

  get now(): SimTime {
    return this.#now;
  }

  get pending(): number {
    return this.#queue.size;
  }

  get nextEventTime(): SimTime | undefined {
    return this.#queue.peek()?.time;
  }

  schedule(time: SimTime, event: E): EventHandle {
    assertSimTime(time);
    if (time < this.#now) {
      throw new RangeError(
        `Cannot schedule at ${String(time)}, before the current time ${String(this.#now)}`,
      );
    }
    return this.#queue.push(time, event);
  }

  scheduleIn(delay: Duration, event: E): EventHandle {
    assertSimTime(delay, 'delay');
    return this.schedule(this.#now + delay, event);
  }

  cancel(handle: EventHandle): boolean {
    return this.#queue.cancel(handle);
  }

  step(handler: EventHandler<E>): boolean {
    const next = this.#queue.pop();
    if (!next) {
      return false;
    }
    this.#now = next.time;
    handler(next.event, this);
    return true;
  }

  run(handler: EventHandler<E>): void {
    while (this.step(handler)) {
      continue;
    }
  }

  runUntil(endTime: SimTime, handler: EventHandler<E>): void {
    assertSimTime(endTime, 'endTime');
    for (let next = this.#queue.peek(); next && next.time <= endTime; next = this.#queue.peek()) {
      this.step(handler);
    }
    this.#now = Math.max(this.#now, endTime);
  }
}
