import type { EventHandler, SimTime, Simulation } from '@shopfloor/sim-core';

export interface WallClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: WallClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 60;
const MAX_TIMER_MS = 1_000;

export type PacerState = 'idle' | 'running' | 'paused' | 'finished';

export interface PacerOptions<E> {
  readonly simulation: Simulation<E>;
  readonly handle: EventHandler<E>;
  readonly speed?: number;
  readonly end?: SimTime;
  readonly clock?: WallClock;
  readonly onAdvance?: (simNow: SimTime) => void;
}

/**
 * A pacing cue (#235, a live timeline's infrastructure entries): applied once the simulation has
 * processed every event at or before `at`, with the simulation clock at `at`. `pause` pauses the
 * run there, `speed` changes the speed there (the paced clock stays continuous), `call` runs a
 * callback (an infrastructure fault). Cues never touch the event queue, so the event log is the
 * same with or without them.
 */
export type PacerCue =
  | { readonly at: SimTime; readonly kind: 'pause' }
  | { readonly at: SimTime; readonly kind: 'speed'; readonly speed: number }
  | { readonly at: SimTime; readonly kind: 'call'; readonly run: () => void };

export interface PacerStatus {
  readonly state: PacerState;
  readonly speed: number;
  readonly simNow: SimTime;
  readonly lagMs: number;
}

function checkSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new RangeError(
      `speed must be between ${String(MIN_SPEED)} and ${String(MAX_SPEED)}, got ${String(speed)}`,
    );
  }
  return speed;
}

export class LivePacer<E> {
  readonly #simulation: Simulation<E>;
  readonly #handle: EventHandler<E>;
  readonly #end: SimTime | undefined;
  readonly #clock: WallClock;
  readonly #onAdvance: (simNow: SimTime) => void;
  #speed: number;
  #state: PacerState = 'idle';
  #simAnchor: SimTime;
  #wallAnchor = 0;
  #timer: unknown;
  #lagMs = 0;
  #busy = false;
  readonly #deferred: (() => void)[] = [];
  /** Pending cues by time, in the order they were added within a time. */
  readonly #cues: PacerCue[] = [];
  #onCue: (cue: PacerCue) => void = () => undefined;

  constructor({
    simulation,
    handle,
    speed = 1,
    end,
    clock = systemClock,
    onAdvance,
  }: PacerOptions<E>) {
    this.#simulation = simulation;
    this.#handle = handle;
    this.#speed = checkSpeed(speed);
    this.#end = end;
    this.#clock = clock;
    this.#onAdvance = onAdvance ?? (() => undefined);
    this.#simAnchor = simulation.now;
  }

  get state(): PacerState {
    return this.#state;
  }

  get speed(): number {
    return this.#speed;
  }

  simNow(): SimTime {
    if (this.#state === 'finished' && this.#end !== undefined) {
      return Math.max(this.#simulation.now, this.#end);
    }
    if (this.#state !== 'running') {
      return this.#simulation.now;
    }
    const target =
      this.#simAnchor + Math.floor((this.#clock.now() - this.#wallAnchor) * this.#speed);
    return this.#end === undefined ? target : Math.min(target, this.#end);
  }

  /**
   * Adds a cue (#235). Refused at a time before the simulation time; a cue at or after the end
   * never fires.
   */
  cue(cue: PacerCue): void {
    if (cue.kind === 'speed') checkSpeed(cue.speed);
    if (!Number.isSafeInteger(cue.at) || cue.at < this.#simulation.now) {
      throw new RangeError(
        `a cue must be at or after the simulation time ${String(this.#simulation.now)}, got ${String(cue.at)}`,
      );
    }
    const index = this.#cues.findIndex((pending) => pending.at > cue.at);
    this.#cues.splice(index < 0 ? this.#cues.length : index, 0, cue);
  }

  /** Called after each cue is applied (the live timeline's progress). */
  set onCue(listener: (cue: PacerCue) => void) {
    this.#onCue = listener;
  }

  /** Cues not applied yet. */
  get pendingCues(): number {
    return this.#cues.length;
  }

  status(): PacerStatus {
    return { state: this.#state, speed: this.#speed, simNow: this.simNow(), lagMs: this.#lagMs };
  }

  start(): void {
    if (this.#state !== 'idle') {
      throw new Error(`cannot start a pacer that is ${this.#state}`);
    }
    this.#run();
  }

  pause(): void {
    if (
      this.#defer(() => {
        this.pause();
      })
    ) {
      return;
    }
    if (this.#state !== 'running') {
      return;
    }
    this.#advanceTo(this.simNow());
    this.#cancelTimer();
    this.#lagMs = 0;
    this.#state = 'paused';
  }

  resume(): void {
    if (
      this.#defer(() => {
        this.resume();
      })
    ) {
      return;
    }
    if (this.#state === 'paused') {
      this.#run();
    }
  }

  setSpeed(speed: number): void {
    checkSpeed(speed);
    if (
      this.#defer(() => {
        this.setSpeed(speed);
      })
    ) {
      return;
    }
    if (this.#state === 'running') {
      this.#advanceTo(this.simNow());
      this.#speed = speed;
      // A pause cue on the way leaves the run paused, with no timer to reschedule.
      if (this.#isRunning()) {
        this.#anchor();
        this.#scheduleNext();
      }
    } else {
      this.#speed = speed;
    }
  }

  step(): boolean {
    if (this.#busy) {
      throw new Error('step cannot be called while an event is being processed');
    }
    if (this.#state !== 'paused' && this.#state !== 'idle') {
      throw new Error('step is only possible while paused');
    }
    const next = this.#simulation.nextEventTime;
    if (next === undefined || (this.#end !== undefined && next >= this.#end)) {
      return false;
    }
    this.#process(() => {
      this.#simulation.step(this.#handle);
    });
    if (this.#state === 'idle') {
      this.#state = 'paused';
    }
    // Cues the step has reached: the run is paused already, so a pause cue changes nothing.
    for (let cue = this.#cues[0]; cue && cue.at <= this.#simulation.now; cue = this.#cues[0]) {
      this.#cues.shift();
      this.#apply(cue);
    }
    return true;
  }

  stop(): void {
    if (
      this.#defer(() => {
        this.stop();
      })
    ) {
      return;
    }
    this.#cancelTimer();
    this.#lagMs = 0;
    if (this.#state !== 'finished') {
      this.#state = 'finished';
    }
  }

  #run(): void {
    this.#state = 'running';
    this.#anchor();
    this.#tick();
  }

  #anchor(): void {
    this.#simAnchor = this.#simulation.now;
    this.#wallAnchor = this.#clock.now();
  }

  /**
   * Processes every event up to `target` (and before the end), applying each cue on the way once
   * its time is reached. A speed cue moves the target with the new speed; a pause cue stops here.
   * Returns the target finally reached.
   */
  #advanceTo(target: SimTime): SimTime {
    let reached = target;
    for (;;) {
      const limit = this.#end === undefined ? reached : Math.min(reached, this.#end - 1);
      const cue = this.#cues[0];
      if (cue && cue.at <= limit) {
        this.#process(() => {
          this.#simulation.runUntil(cue.at, this.#handle);
        });
        this.#cues.shift();
        const wasRunning = this.#isRunning();
        this.#apply(cue);
        if (!this.#isRunning()) {
          return wasRunning ? cue.at : reached;
        }
        if (cue.kind === 'speed') {
          reached = Math.max(cue.at, this.simNow());
        }
        continue;
      }
      if (limit >= this.#simulation.now) {
        this.#process(() => {
          this.#simulation.runUntil(limit, this.#handle);
        });
      }
      return reached;
    }
  }

  /** Applies one cue at its time (the simulation clock is there). */
  #apply(cue: PacerCue): void {
    switch (cue.kind) {
      case 'pause':
        if (this.#state === 'running') {
          this.#cancelTimer();
          this.#lagMs = 0;
          this.#state = 'paused';
        }
        break;
      case 'speed':
        if (this.#state === 'running') {
          // Continuous: the paced clock passed `at` at this wall time with the old speed.
          this.#wallAnchor += (cue.at - this.#simAnchor) / this.#speed;
          this.#simAnchor = cue.at;
        }
        this.#speed = cue.speed;
        break;
      case 'call':
        cue.run();
        break;
    }
    this.#onCue(cue);
  }

  #isRunning(): boolean {
    return this.#state === 'running';
  }

  #defer(action: () => void): boolean {
    if (!this.#busy) {
      return false;
    }
    this.#deferred.push(action);
    return true;
  }

  #process(work: () => void): void {
    this.#busy = true;
    try {
      work();
      this.#onAdvance(this.#simulation.now);
    } finally {
      this.#busy = false;
    }
    for (let action = this.#deferred.shift(); action; action = this.#deferred.shift()) {
      action();
    }
  }

  #tick(): void {
    this.#timer = undefined;
    if (this.#state !== 'running') {
      return;
    }
    const target = this.simNow();
    const next = this.#simulation.nextEventTime;
    this.#lagMs = next !== undefined && next < target ? (target - next) / this.#speed : 0;
    const reached = this.#advanceTo(target);
    if (!this.#isRunning()) {
      return;
    }
    if (this.#end !== undefined && reached >= this.#end) {
      this.stop();
      return;
    }
    this.#scheduleNext();
  }

  #scheduleNext(): void {
    this.#cancelTimer();
    const next = this.#simulation.nextEventTime;
    const now = this.simNow();
    const horizon =
      next === undefined ? this.#end : this.#end === undefined ? next : Math.min(next, this.#end);
    const wait =
      horizon === undefined ? MAX_TIMER_MS : Math.ceil(Math.max(0, horizon - now) / this.#speed);
    this.#timer = this.#clock.setTimeout(
      () => {
        this.#tick();
      },
      Math.min(wait, MAX_TIMER_MS),
    );
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
