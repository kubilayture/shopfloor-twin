import type { Duration, SimTime } from '@shopfloor/sim-core';
import {
  IllegalTransitionError,
  MACHINE_STATES,
  canTransition,
  type MachineState,
} from './machine-state.ts';

export interface StateChange {
  readonly machineId: string;
  readonly at: SimTime;
  readonly from: MachineState;
  readonly to: MachineState;
  readonly cause?: string;
}

export type StateDurations = Record<MachineState, Duration>;

const zeroDurations = (): StateDurations =>
  Object.fromEntries(MACHINE_STATES.map((state) => [state, 0])) as StateDurations;

export class Machine {
  readonly id: string;
  readonly #since: SimTime;
  readonly #durations = zeroDurations();
  readonly #onChange: ((change: StateChange) => void) | undefined;
  #state: MachineState;
  #enteredAt: SimTime;

  constructor(
    id: string,
    initialState: MachineState,
    at: SimTime,
    onChange?: (change: StateChange) => void,
  ) {
    this.id = id;
    this.#state = initialState;
    this.#since = at;
    this.#enteredAt = at;
    this.#onChange = onChange;
  }

  get state(): MachineState {
    return this.#state;
  }

  get enteredAt(): SimTime {
    return this.#enteredAt;
  }

  transition(to: MachineState, at: SimTime, cause?: string): void {
    if (at < this.#enteredAt) {
      throw new RangeError(
        `${this.id}: transition at ${String(at)} is before the last one at ${String(this.#enteredAt)}`,
      );
    }
    const from = this.#state;
    if (!canTransition(from, to)) {
      throw new IllegalTransitionError(this.id, from, to);
    }
    this.#durations[from] += at - this.#enteredAt;
    this.#state = to;
    this.#enteredAt = at;
    this.#onChange?.({
      machineId: this.id,
      at,
      from,
      to,
      ...(cause === undefined ? {} : { cause }),
    });
  }

  durations(now: SimTime): StateDurations {
    if (now < this.#enteredAt) {
      throw new RangeError(
        `${this.id}: cannot account up to ${String(now)}, before the last transition`,
      );
    }
    const result = { ...this.#durations };
    result[this.#state] += now - this.#enteredAt;
    return result;
  }

  elapsed(now: SimTime): Duration {
    return now - this.#since;
  }
}
