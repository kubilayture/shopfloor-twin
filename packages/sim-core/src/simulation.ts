import { EventQueue, type EventHandle, type EventLane } from './event-queue.ts';
import { assertSimTime, type Duration, type SimTime } from './sim-time.ts';

export type EventHandler<E> = (event: E, simulation: Simulation<E>) => void;

export class Simulation<E> {
  readonly #queue = new EventQueue<E>();
  #now: SimTime;
  #processed = 0;

  constructor(startTime: SimTime) {
    assertSimTime(startTime, 'startTime');
    this.#now = startTime;
  }

  get now(): SimTime {
    return this.#now;
  }

  /**
   * How many events have been processed (handled by `step`, `run` or `runUntil`; cancelled events
   * don't count). With the time, it names the exact point between two events where something was
   * given from outside the model (#236, a dispatch recorded live and replayed headless).
   */
  get processed(): number {
    return this.#processed;
  }

  get pending(): number {
    return this.#queue.size;
  }

  get nextEventTime(): SimTime | undefined {
    return this.#queue.peek()?.time;
  }

  /**
   * Schedules a model event (`lane` left out), or an `external` one: an event given from outside
   * the model when it is accepted (an injection, a console action), which at its time runs before
   * every model event of that time, after the external events accepted before it (#235). So an
   * external event accepted for a later time lands where it would have had it been accepted
   * before the run started.
   */
  schedule(time: SimTime, event: E, lane: EventLane = 'model'): EventHandle {
    assertSimTime(time);
    if (time < this.#now) {
      throw new RangeError(
        `Cannot schedule at ${String(time)}, before the current time ${String(this.#now)}`,
      );
    }
    return this.#queue.push(time, event, lane);
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
    this.#processed++;
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
