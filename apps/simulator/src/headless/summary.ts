import type { SimTime } from '@shopfloor/sim-core';
import type { PlantEvent, ProductionLine } from '../plant/line.ts';
import { MACHINE_STATES, type MachineState } from '../plant/machine-state.ts';

type StateMs = Record<MachineState, number>;

const zero = (): StateMs => Object.fromEntries(MACHINE_STATES.map((s) => [s, 0])) as StateMs;

const NO_SHIFT = 'no-shift';

interface MachineTruth {
  state: MachineState;
  /** Where the time not yet counted starts (the last state change or shift boundary). */
  since: SimTime;
  /** When the current state began. */
  changedAt: SimTime;
  readonly total: StateMs;
  readonly byShift: Map<string, StateMs>;
  readonly cycles: { good: number; scrap: number; rework: number };
}

export interface GroundTruthSummary {
  readonly machines: Record<
    string,
    {
      stateMs: StateMs;
      byShift: Record<string, StateMs>;
      cycles: { good: number; scrap: number; rework: number };
    }
  >;
  readonly production: {
    started: number;
    finished: Record<string, number>;
    scrapped: Record<string, Record<string, number>>;
  };
  readonly lots: Record<string, number>;
}

export class GroundTruth {
  readonly #machines = new Map<string, MachineTruth>();
  readonly #scrapped = new Map<string, Map<string, number>>();
  #shift = NO_SHIFT;

  constructor(machineIds: readonly string[], start: SimTime) {
    for (const id of machineIds) {
      this.#machines.set(id, {
        state: 'Off',
        since: start,
        changedAt: start,
        total: zero(),
        byShift: new Map(),
        cycles: { good: 0, scrap: 0, rework: 0 },
      });
    }
  }

  record(event: PlantEvent): void {
    if (event.type === 'shift') {
      this.#closeAll(event.at);
      this.#shift = event.action === 'shift-end' ? NO_SHIFT : `${event.shiftDate}/${event.shiftId}`;
      return;
    }
    if (event.type === 'state') {
      const machine = this.#machine(event.machineId);
      this.#close(machine, event.at);
      machine.state = event.to;
      machine.changedAt = event.at;
      return;
    }
    if (event.type === 'cycle-complete') {
      this.#machine(event.machineId).cycles[event.result]++;
      if (event.result === 'scrap') {
        const byReason = this.#scrapped.get(event.product) ?? new Map<string, number>();
        const reason = event.reason ?? 'UNKNOWN';
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        this.#scrapped.set(event.product, byReason);
      }
    }
  }

  /** The shift bucket the run is in now (`2026-10-12/A`, or `no-shift` between shifts). */
  get currentBucket(): string {
    return this.#shift;
  }

  /** Each machine's current state and when it began (the last state change, or the start). */
  current(): Record<string, { state: MachineState; since: SimTime }> {
    return Object.fromEntries(
      [...this.#machines].map(([id, m]) => [id, { state: m.state, since: m.changedAt }]),
    );
  }

  finish(end: SimTime, line: ProductionLine, lotIds: readonly string[]): GroundTruthSummary {
    this.#closeAll(end);
    const machines = Object.fromEntries(
      [...this.#machines].map(([id, m]) => [
        id,
        { stateMs: m.total, byShift: Object.fromEntries(m.byShift), cycles: m.cycles },
      ]),
    );
    return { machines, ...this.#production(line, lotIds) };
  }

  /**
   * The summary as `finish(now, …)` would return it, without closing anything: the live run keeps
   * recording afterwards (#100). The open state of each machine counts up to `now`, in the
   * current bucket.
   */
  snapshot(now: SimTime, line: ProductionLine, lotIds: readonly string[]): GroundTruthSummary {
    const machines = Object.fromEntries(
      [...this.#machines].map(([id, m]) => {
        const open = now - m.since;
        if (open < 0) {
          throw new RangeError(`snapshot at ${String(now)} is before ${String(m.since)}`);
        }
        const stateMs = { ...m.total };
        const byShift = new Map([...m.byShift].map(([key, ms]) => [key, { ...ms }]));
        if (open > 0) {
          stateMs[m.state] += open;
          const shift = byShift.get(this.#shift) ?? zero();
          shift[m.state] += open;
          byShift.set(this.#shift, shift);
        }
        return [id, { stateMs, byShift: Object.fromEntries(byShift), cycles: { ...m.cycles } }];
      }),
    );
    return { machines, ...this.#production(line, lotIds) };
  }

  #production(
    line: ProductionLine,
    lotIds: readonly string[],
  ): Pick<GroundTruthSummary, 'production' | 'lots'> {
    const finished: Record<string, number> = {};
    for (const part of line.finished) {
      finished[part.product] = (finished[part.product] ?? 0) + 1;
    }
    const scrapped = Object.fromEntries(
      [...this.#scrapped].map(([product, reasons]) => [product, Object.fromEntries(reasons)]),
    );
    const lots = Object.fromEntries(
      lotIds.map((id) => {
        const remaining = line.inventory.remaining(id);
        if (remaining === undefined) {
          throw new RangeError(`unknown lot "${id}"`);
        }
        return [id, remaining];
      }),
    );
    return { production: { started: line.producedParts, finished, scrapped }, lots };
  }

  #machine(id: string): MachineTruth {
    const machine = this.#machines.get(id);
    if (!machine) {
      throw new RangeError(`unknown machine "${id}"`);
    }
    return machine;
  }

  #closeAll(at: SimTime): void {
    for (const machine of this.#machines.values()) {
      this.#close(machine, at);
    }
  }

  #close(machine: MachineTruth, at: SimTime): void {
    const duration = at - machine.since;
    if (duration < 0) {
      throw new RangeError(`event at ${String(at)} is before ${String(machine.since)}`);
    }
    machine.since = at;
    if (duration === 0) {
      return;
    }
    machine.total[machine.state] += duration;
    const shift = machine.byShift.get(this.#shift) ?? zero();
    shift[machine.state] += duration;
    machine.byShift.set(this.#shift, shift);
  }
}
