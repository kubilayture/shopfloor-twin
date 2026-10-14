import type { PlantConfig } from '@shopfloor/plant-config';
import {
  MINUTE,
  SECOND,
  logNormalFromMeanCv,
  type RandomSource,
  type RandomStream,
  type SimTime,
  type Simulation,
} from '@shopfloor/sim-core';
import { PartBuffer, type Part } from './buffer.ts';
import { Machine, type StateChange } from './machine.ts';
import type { MachineState } from './machine-state.ts';

export type LineEvent =
  | { readonly type: 'cycle-end'; readonly station: string }
  | { readonly type: 'setup-end'; readonly station: string };

export type PlantEvent =
  | ({ readonly type: 'state' } & StateChange)
  | {
      readonly type: 'cycle-complete';
      readonly at: SimTime;
      readonly machineId: string;
      readonly product: string;
      readonly partId: number;
      readonly serial: string;
    };

interface Campaign {
  readonly product: string;
  remaining: number;
}

interface Station {
  readonly id: string;
  readonly operation: string;
  readonly machine: Machine;
  readonly cycle: RandomStream;
  readonly input: PartBuffer | undefined;
  readonly output: PartBuffer | undefined;
  readonly campaigns: Campaign[] | undefined;
  loadedProduct: string | undefined;
  part: Part | undefined;
  busy: boolean;
}

export interface LineOptions {
  readonly config: PlantConfig;
  readonly random: RandomSource;
  readonly startTime: SimTime;
  readonly onEvent?: (event: PlantEvent) => void;
}

export class ProductionLine {
  readonly stations: readonly Station[];
  readonly buffers: readonly PartBuffer[];
  readonly finished: Part[] = [];
  readonly #config: PlantConfig;
  readonly #onEvent: (event: PlantEvent) => void;
  #nextPartId = 1;
  #now: SimTime;

  constructor({ config, random, startTime, onEvent }: LineOptions) {
    this.#config = config;
    this.#onEvent = onEvent ?? (() => undefined);
    this.#now = startTime;
    this.buffers = config.plant.buffers.map((b) => new PartBuffer(b.from, b.to, b.capacity));
    const equipment = config.plant.areas.flatMap((a) => a.workCenters.flatMap((w) => w.equipment));
    this.stations = equipment.map((item) => {
      const schedule = config.schedule.machines[item.id];
      const campaigns = schedule?.map((c) => ({ product: c.product, remaining: c.quantity }));
      return {
        id: item.id,
        operation: item.operation,
        machine: new Machine(item.id, 'Idle', startTime, (change) => {
          this.#onEvent({ type: 'state', ...change });
        }),
        cycle: random.stream(`${item.id}/cycle`),
        input: this.buffers.find((b) => b.to === item.operation),
        output: this.buffers.find((b) => b.from === item.operation),
        campaigns,
        loadedProduct: campaigns?.[0]?.product,
        part: undefined,
        busy: false,
      };
    });
  }

  get producedParts(): number {
    return this.#nextPartId - 1;
  }

  start(simulation: Simulation<LineEvent>): void {
    this.#now = simulation.now;
    this.stations.forEach((station) => {
      this.#tryStart(station, simulation);
    });
  }

  handle(event: LineEvent, simulation: Simulation<LineEvent>): void {
    this.#now = simulation.now;
    const station = this.#station(event.station);
    if (event.type === 'cycle-end') {
      this.#finishCycle(station, simulation);
    } else {
      station.busy = false;
      this.#tryStart(station, simulation);
    }
  }

  #station(id: string): Station {
    const station = this.stations.find((s) => s.id === id);
    if (!station) {
      throw new RangeError(`unknown station "${id}"`);
    }
    return station;
  }

  #enter(station: Station, to: MachineState, cause?: string): void {
    if (station.machine.state !== to) {
      station.machine.transition(to, this.#now, cause);
    }
  }

  #tryStart(station: Station, simulation: Simulation<LineEvent>): void {
    if (station.busy) {
      return;
    }
    const part = station.campaigns
      ? this.#nextBlank(station, simulation)
      : this.#takeFromInput(station);
    if (!part) {
      return;
    }
    this.#startCycle(station, part, simulation);
    if (station.input) {
      this.#releaseUpstream(station.input, simulation);
    }
  }

  #nextBlank(station: Station, simulation: Simulation<LineEvent>): Part | undefined {
    const campaign = station.campaigns?.find((c) => c.remaining > 0);
    if (!campaign) {
      this.#enter(station, 'Idle', 'SCHEDULE-COMPLETE');
      return undefined;
    }
    if (station.loadedProduct !== campaign.product) {
      const cause = `CHANGEOVER ${String(station.loadedProduct)}→${campaign.product}`;
      station.loadedProduct = campaign.product;
      station.busy = true;
      this.#enter(station, 'Setup', cause);
      simulation.scheduleIn(Math.round(this.#config.products.changeoverMinutes * MINUTE), {
        type: 'setup-end',
        station: station.id,
      });
      return undefined;
    }
    campaign.remaining--;
    return { id: this.#nextPartId++, product: campaign.product };
  }

  #takeFromInput(station: Station): Part | undefined {
    const part = station.input?.shift();
    if (!part) {
      this.#enter(station, 'Starved');
    }
    return part;
  }

  #startCycle(station: Station, part: Part, simulation: Simulation<LineEvent>): void {
    station.part = part;
    station.busy = true;
    this.#enter(station, 'Running');
    simulation.scheduleIn(this.#cycleTime(station, part.product), {
      type: 'cycle-end',
      station: station.id,
    });
  }

  #cycleTime(station: Station, product: string): number {
    const ideal = this.#config.products.products.find((p) => p.id === product)?.idealCycleSeconds[
      station.operation
    ];
    const cv = this.#config.process.cycleTimeCv[station.operation];
    if (ideal === undefined || cv === undefined) {
      throw new RangeError(`no cycle time for ${product} at ${station.operation}`);
    }
    const seconds = cv > 0 ? logNormalFromMeanCv(station.cycle, ideal, cv) : ideal;
    return Math.max(1, Math.round(seconds * SECOND));
  }

  #finishCycle(station: Station, simulation: Simulation<LineEvent>): void {
    const part = station.part;
    if (!part) {
      throw new RangeError(`${station.id} finished a cycle without a part`);
    }
    if (station.campaigns) {
      part.serial = `${part.product}-${String(part.id).padStart(6, '0')}`;
    }
    this.#onEvent({
      type: 'cycle-complete',
      at: this.#now,
      machineId: station.id,
      product: part.product,
      partId: part.id,
      serial: part.serial ?? '',
    });
    this.#unload(station, simulation);
  }

  #unload(station: Station, simulation: Simulation<LineEvent>): void {
    const part = station.part;
    if (!part) {
      return;
    }
    if (station.output?.isFull) {
      this.#enter(station, 'Blocked');
      return;
    }
    if (station.output) {
      station.output.push(part);
    } else {
      this.finished.push(part);
    }
    station.part = undefined;
    station.busy = false;
    if (station.output) {
      this.#feedDownstream(station.output, simulation);
    }
    this.#tryStart(station, simulation);
  }

  #feedDownstream(buffer: PartBuffer, simulation: Simulation<LineEvent>): void {
    this.stations
      .filter((s) => s.input === buffer)
      .forEach((s) => {
        this.#tryStart(s, simulation);
      });
  }

  #releaseUpstream(buffer: PartBuffer, simulation: Simulation<LineEvent>): void {
    for (const upstream of this.stations.filter((s) => s.output === buffer)) {
      if (upstream.machine.state === 'Blocked' && !buffer.isFull) {
        this.#unload(upstream, simulation);
      }
    }
  }
}
