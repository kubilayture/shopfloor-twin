import type { SimTime } from '@shopfloor/sim-core';
import type { PlantEvent, ProductionLine } from '../plant/line.ts';
import { MACHINE_STATES, type MachineState } from '../plant/machine-state.ts';

type StateMs = Record<MachineState, number>;

const zero = (): StateMs => Object.fromEntries(MACHINE_STATES.map((s) => [s, 0])) as StateMs;

const NO_SHIFT = 'no-shift';

interface MachineTruth {
  state: MachineState;
  since: SimTime;
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

  finish(end: SimTime, line: ProductionLine, lotIds: readonly string[]): GroundTruthSummary {
    this.#closeAll(end);
    const machines = Object.fromEntries(
      [...this.#machines].map(([id, m]) => [
        id,
        { stateMs: m.total, byShift: Object.fromEntries(m.byShift), cycles: m.cycles },
      ]),
    );
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
    return { machines, production: { started: line.producedParts, finished, scrapped }, lots };
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
