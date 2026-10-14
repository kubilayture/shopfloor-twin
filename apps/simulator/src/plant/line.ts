import type { PlantConfig } from '@shopfloor/plant-config';
import {
  HOUR,
  MINUTE,
  SECOND,
  exponential,
  logNormalFromMeanCv,
  logNormalFromMedian,
  poissonArrivalGap,
  weibull,
  type EventHandle,
  type RandomSource,
  type RandomStream,
  type SimTime,
  type Simulation,
} from '@shopfloor/sim-core';
import { PartBuffer, type Part } from './buffer.ts';
import { Machine, type StateChange } from './machine.ts';
import type { MachineState } from './machine-state.ts';
import { RunningClock } from './running-clock.ts';

export type LineEvent =
  | { readonly type: 'clock'; readonly station: string }
  | { readonly type: 'setup-end'; readonly station: string }
  | { readonly type: 'stop-end'; readonly station: string }
  | { readonly type: 'repair-end'; readonly station: string };

export type PlantEvent =
  | ({ readonly type: 'state' } & StateChange)
  | {
      readonly type: 'cycle-complete';
      readonly at: SimTime;
      readonly machineId: string;
      readonly product: string;
      readonly partId: number;
      readonly serial: string;
    }
  | {
      readonly type: 'repair-start' | 'repair-end';
      readonly at: SimTime;
      readonly machineId: string;
      readonly failureCode: string;
    };

const CYCLE = 'cycle';
const MINOR_STOP = 'minor-stop';
const FAILURE = 'failure:';

interface Campaign {
  readonly product: string;
  remaining: number;
}

interface FailureMode {
  readonly code: string;
  readonly shape: number;
  readonly scale: number;
  readonly repairMedian: number;
  readonly repairSpread: number;
  readonly arrival: RandomStream;
  readonly repair: RandomStream;
}

interface MinorStops {
  readonly ratePerMs: number;
  readonly mean: number;
  readonly causes: readonly string[];
  readonly arrival: RandomStream;
  readonly duration: RandomStream;
  readonly cause: RandomStream;
}

interface Station {
  readonly id: string;
  readonly operation: string;
  readonly machine: Machine;
  readonly cycle: RandomStream;
  readonly clock: RunningClock;
  readonly failures: readonly FailureMode[];
  readonly minorStops: MinorStops | undefined;
  readonly input: PartBuffer | undefined;
  readonly output: PartBuffer | undefined;
  readonly campaigns: Campaign[] | undefined;
  loadedProduct: string | undefined;
  part: Part | undefined;
  busy: boolean;
  pending: EventHandle | undefined;
  failure: FailureMode | undefined;
}

export interface LineOptions {
  readonly config: PlantConfig;
  readonly random: RandomSource;
  readonly startTime: SimTime;
  readonly onEvent?: (event: PlantEvent) => void;
}

const millis = (value: number): number => Math.max(1, Math.round(value));

export class ProductionLine {
  readonly stations: readonly Station[];
  readonly buffers: readonly PartBuffer[];
  readonly finished: Part[] = [];
  readonly #config: PlantConfig;
  readonly #onEvent: (event: PlantEvent) => void;
  readonly #repairQueue: Station[] = [];
  #freeTechnicians: number;
  #nextPartId = 1;
  #now: SimTime;

  constructor({ config, random, startTime, onEvent }: LineOptions) {
    this.#config = config;
    this.#onEvent = onEvent ?? (() => undefined);
    this.#now = startTime;
    this.#freeTechnicians = config.plant.maintenanceTechnicians;
    this.buffers = config.plant.buffers.map((b) => new PartBuffer(b.from, b.to, b.capacity));
    const equipment = config.plant.areas.flatMap((a) => a.workCenters.flatMap((w) => w.equipment));
    this.stations = equipment.map((item) => {
      const campaigns = config.schedule.machines[item.id]?.map((c) => ({
        product: c.product,
        remaining: c.quantity,
      }));
      const reliability = config.failures.equipment[item.id];
      const failures = (reliability?.failureModes ?? []).map((mode) => ({
        code: mode.code,
        shape: mode.weibullShape,
        scale: mode.weibullScaleHours * HOUR,
        repairMedian: mode.repairMedianMinutes * MINUTE,
        repairSpread: mode.repairSpread,
        arrival: random.stream(`${item.id}/failure/${mode.code}`),
        repair: random.stream(`${item.id}/repair/${mode.code}`),
      }));
      const stops = reliability?.minorStops;
      const minorStops =
        stops && stops.ratePerHour > 0
          ? {
              ratePerMs: stops.ratePerHour / HOUR,
              mean: stops.meanSeconds * SECOND,
              causes: stops.causes,
              arrival: random.stream(`${item.id}/minor-stop/arrival`),
              duration: random.stream(`${item.id}/minor-stop/duration`),
              cause: random.stream(`${item.id}/minor-stop/cause`),
            }
          : undefined;
      const clock = new RunningClock([CYCLE]);
      failures.forEach((mode) => {
        clock.set(
          FAILURE + mode.code,
          millis(weibull(mode.arrival, mode.shape, mode.scale)),
          startTime,
        );
      });
      if (minorStops) {
        clock.set(
          MINOR_STOP,
          millis(poissonArrivalGap(minorStops.arrival, minorStops.ratePerMs)),
          startTime,
        );
      }
      return {
        id: item.id,
        operation: item.operation,
        machine: new Machine(item.id, 'Idle', startTime, (change) => {
          this.#onEvent({ type: 'state', ...change });
        }),
        cycle: random.stream(`${item.id}/cycle`),
        clock,
        failures,
        minorStops,
        input: this.buffers.find((b) => b.to === item.operation),
        output: this.buffers.find((b) => b.from === item.operation),
        campaigns,
        loadedProduct: campaigns?.[0]?.product,
        part: undefined,
        busy: false,
        pending: undefined,
        failure: undefined,
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
    switch (event.type) {
      case 'clock':
        station.pending = undefined;
        this.#onClockDue(station, simulation);
        break;
      case 'setup-end':
        station.busy = false;
        this.#tryStart(station, simulation);
        break;
      case 'stop-end':
        this.#run(station, simulation);
        break;
      case 'repair-end':
        this.#finishRepair(station, simulation);
        break;
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

  #run(station: Station, simulation: Simulation<LineEvent>): void {
    this.#enter(station, 'Running');
    station.clock.start(this.#now);
    this.#reschedule(station, simulation);
  }

  #halt(station: Station, simulation: Simulation<LineEvent>): void {
    station.clock.pause(this.#now);
    if (station.pending) {
      simulation.cancel(station.pending);
      station.pending = undefined;
    }
  }

  #reschedule(station: Station, simulation: Simulation<LineEvent>): void {
    if (station.pending) {
      simulation.cancel(station.pending);
    }
    const next = station.clock.next();
    station.pending = next
      ? simulation.scheduleIn(Math.max(0, next.remaining), { type: 'clock', station: station.id })
      : undefined;
  }

  #onClockDue(station: Station, simulation: Simulation<LineEvent>): void {
    station.clock.sync(this.#now);
    const due = station.clock.next();
    if (!due || due.remaining > 0) {
      this.#reschedule(station, simulation);
      return;
    }
    this.#halt(station, simulation);
    if (due.name === CYCLE) {
      station.clock.delete(CYCLE, this.#now);
      this.#finishCycle(station, simulation);
    } else if (due.name === MINOR_STOP && station.minorStops) {
      this.#minorStop(station, station.minorStops, simulation);
    } else {
      const mode = station.failures.find((m) => FAILURE + m.code === due.name);
      if (!mode) {
        throw new RangeError(`${station.id}: unknown timer "${due.name}"`);
      }
      this.#breakDown(station, mode, simulation);
    }
  }

  #minorStop(station: Station, stops: MinorStops, simulation: Simulation<LineEvent>): void {
    station.clock.set(
      MINOR_STOP,
      millis(poissonArrivalGap(stops.arrival, stops.ratePerMs)),
      this.#now,
    );
    const cause = stops.causes[Math.floor(stops.cause.nextFloat() * stops.causes.length)];
    this.#enter(station, 'Stopped', cause);
    simulation.scheduleIn(millis(exponential(stops.duration, stops.mean)), {
      type: 'stop-end',
      station: station.id,
    });
  }

  #breakDown(station: Station, mode: FailureMode, simulation: Simulation<LineEvent>): void {
    station.clock.set(
      FAILURE + mode.code,
      millis(weibull(mode.arrival, mode.shape, mode.scale)),
      this.#now,
    );
    station.failure = mode;
    this.#enter(station, 'Down', mode.code);
    this.#repairQueue.push(station);
    this.#dispatchTechnicians(simulation);
  }

  #dispatchTechnicians(simulation: Simulation<LineEvent>): void {
    while (this.#freeTechnicians > 0) {
      const station = this.#repairQueue.shift();
      const mode = station?.failure;
      if (!station || !mode) {
        return;
      }
      this.#freeTechnicians--;
      this.#onEvent({
        type: 'repair-start',
        at: this.#now,
        machineId: station.id,
        failureCode: mode.code,
      });
      simulation.scheduleIn(
        millis(logNormalFromMedian(mode.repair, mode.repairMedian, mode.repairSpread)),
        {
          type: 'repair-end',
          station: station.id,
        },
      );
    }
  }

  #finishRepair(station: Station, simulation: Simulation<LineEvent>): void {
    const mode = station.failure;
    if (!mode) {
      throw new RangeError(`${station.id}: repair finished without a failure`);
    }
    this.#onEvent({
      type: 'repair-end',
      at: this.#now,
      machineId: station.id,
      failureCode: mode.code,
    });
    station.failure = undefined;
    this.#freeTechnicians++;
    this.#run(station, simulation);
    this.#dispatchTechnicians(simulation);
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
      simulation.scheduleIn(millis(this.#config.products.changeoverMinutes * MINUTE), {
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
    station.clock.set(CYCLE, this.#cycleTime(station, part.product), this.#now);
    this.#run(station, simulation);
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
    return millis(seconds * SECOND);
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
