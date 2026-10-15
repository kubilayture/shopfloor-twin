import type { PlantConfig } from '@shopfloor/plant-config';
import type { SimTime } from '@shopfloor/sim-core';
import type { Part } from '../plant/buffer.ts';
import type { PlantEvent, ProductionLine } from '../plant/line.ts';
import { MACHINE_STATES, type MachineState } from '../plant/machine-state.ts';

export class InvariantViolation extends Error {
  constructor(at: SimTime, message: string) {
    super(`invariant violated at ${new Date(at).toISOString()}: ${message}`);
    this.name = 'InvariantViolation';
  }
}

interface StateTally {
  state: MachineState;
  since: SimTime;
  readonly ms: Record<MachineState, number>;
}

export class InvariantChecker {
  readonly #line: ProductionLine;
  readonly #start: SimTime;
  readonly #initialLots: ReadonlyMap<string, number>;
  readonly #consumed = new Map<string, number>();
  readonly #tallies = new Map<string, StateTally>();
  readonly #alarms = new Map<string, Set<string>>();
  #checks = 0;

  constructor(line: ProductionLine, config: PlantConfig, start: SimTime) {
    this.#line = line;
    this.#start = start;
    this.#initialLots = new Map(config.stock.lots.map((lot) => [lot.id, lot.quantity]));
    for (const station of line.stations) {
      this.#tallies.set(station.id, {
        state: station.machine.state,
        since: start,
        ms: Object.fromEntries(MACHINE_STATES.map((s) => [s, 0])) as Record<MachineState, number>,
      });
    }
  }

  get checks(): number {
    return this.#checks;
  }

  record(event: PlantEvent): void {
    if (event.type === 'alarm') {
      const active = this.#alarms.get(event.machineId) ?? new Set<string>();
      this.#alarms.set(event.machineId, active);
      if (active.has(event.code) === (event.transition === 'active')) {
        throw new InvariantViolation(
          event.at,
          `${event.machineId}: alarm ${event.code} ${event.transition} twice in a row`,
        );
      }
      if (event.transition === 'active') {
        active.add(event.code);
      } else {
        active.delete(event.code);
      }
    } else if (event.type === 'material-consumed') {
      this.#consumed.set(event.lotId, (this.#consumed.get(event.lotId) ?? 0) + 1);
    } else if (event.type === 'state') {
      const tally = this.#tallies.get(event.machineId);
      if (!tally) {
        throw new InvariantViolation(
          event.at,
          `state event for unknown machine ${event.machineId}`,
        );
      }
      if (tally.state !== event.from) {
        throw new InvariantViolation(
          event.at,
          `${event.machineId}: event says ${event.from} → ${event.to}, but the event log had it in ${tally.state}`,
        );
      }
      tally.ms[tally.state] += event.at - tally.since;
      tally.state = event.to;
      tally.since = event.at;
    }
  }

  check(now: SimTime): void {
    this.#checks++;
    this.#checkParts(now);
    this.#checkTime(now);
    this.#checkLots(now);
    this.#checkAlarms(now);
  }

  #checkAlarms(now: SimTime): void {
    for (const station of this.#line.stations) {
      const logged = [...(this.#alarms.get(station.id) ?? [])].sort().join(',');
      const actual = [...station.activeAlarms].sort().join(',');
      if (logged !== actual) {
        throw new InvariantViolation(
          now,
          `${station.id}: active alarms are [${actual}], but the event log says [${logged}]`,
        );
      }
      const failure = station.failure?.code;
      if (failure !== undefined && !station.activeAlarms.has(failure)) {
        throw new InvariantViolation(now, `${station.id}: down with ${failure} but no alarm`);
      }
    }
  }

  #checkParts(now: SimTime): void {
    const line = this.#line;
    const places: [string, readonly Part[]][] = [
      ['finished', line.finished],
      ['scrapped', line.scrapped],
      ...line.buffers.map((b): [string, Part[]] => [`buffer ${b.from}→${b.to}`, b.contents()]),
      ...line.stations.map((s): [string, Part[]] => [s.id, s.part ? [s.part] : []]),
      ...line.stations.map((s): [string, readonly Part[]] => [`${s.id} rework`, s.rework ?? []]),
    ];
    const seen = new Map<number, string>();
    for (const [place, parts] of places) {
      for (const part of parts) {
        const other = seen.get(part.id);
        if (other !== undefined) {
          throw new InvariantViolation(
            now,
            `part ${String(part.id)} is both in ${other} and in ${place}`,
          );
        }
        seen.set(part.id, place);
      }
    }
    for (let id = 1; id <= line.producedParts; id++) {
      if (!seen.has(id)) {
        throw new InvariantViolation(now, `part ${String(id)} was started but is nowhere`);
      }
    }
    if (seen.size !== line.producedParts) {
      throw new InvariantViolation(
        now,
        `${String(seen.size)} parts are in the line but ${String(line.producedParts)} were started`,
      );
    }
  }

  #checkTime(now: SimTime): void {
    for (const station of this.#line.stations) {
      const tally = this.#tallies.get(station.id);
      if (!tally) {
        throw new InvariantViolation(now, `no tally for ${station.id}`);
      }
      const own = station.machine.durations(now);
      let total = 0;
      for (const state of MACHINE_STATES) {
        const fromEvents = tally.ms[state] + (tally.state === state ? now - tally.since : 0);
        total += fromEvents;
        if (fromEvents !== own[state]) {
          throw new InvariantViolation(
            now,
            `${station.id}: ${state} is ${String(own[state])} ms in the machine but ${String(fromEvents)} ms in the event log`,
          );
        }
      }
      if (total !== now - this.#start) {
        throw new InvariantViolation(
          now,
          `${station.id}: time in states ${String(total)} ms ≠ elapsed ${String(now - this.#start)} ms`,
        );
      }
    }
  }

  #checkLots(now: SimTime): void {
    for (const [lotId, initial] of this.#initialLots) {
      const used = this.#consumed.get(lotId) ?? 0;
      const remaining = this.#line.inventory.remaining(lotId);
      if (remaining === undefined || used + remaining !== initial) {
        throw new InvariantViolation(
          now,
          `lot ${lotId}: consumed ${String(used)} + remaining ${String(remaining)} ≠ initial ${String(initial)}`,
        );
      }
    }
  }
}
