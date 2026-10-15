import type { PlantConfig } from '@shopfloor/plant-config';
import {
  HOUR,
  MINUTE,
  SECOND,
  bernoulli,
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
import { shiftAt, shiftBoundaries, type CalendarBoundary } from './calendar.ts';
import { Crew, type Assignment } from './crew.ts';
import { Inventory } from './materials.ts';
import { LeakTester, ToolWear } from './quality.ts';
import { Machine, type StateChange } from './machine.ts';
import type { MachineState } from './machine-state.ts';
import { RunningClock } from './running-clock.ts';

type StationEvent =
  | { readonly type: 'clock'; readonly station: string }
  | { readonly type: 'setup-end'; readonly station: string }
  | { readonly type: 'stop-end'; readonly station: string }
  | { readonly type: 'repair-end'; readonly station: string }
  | { readonly type: 'maintenance-end'; readonly station: string };

export type LineEvent =
  | StationEvent
  | { readonly type: 'calendar'; readonly boundary: CalendarBoundary }
  | { readonly type: 'calendar-refill'; readonly until: SimTime };

export type PlantEvent =
  | ({ readonly type: 'state' } & StateChange)
  | {
      readonly type: 'cycle-complete';
      readonly at: SimTime;
      readonly machineId: string;
      readonly product: string;
      readonly partId: number;
      readonly serial: string;
      readonly result: 'good' | 'scrap' | 'rework';
      readonly reason?: string;
      readonly measurement?: Measurement;
    }
  | {
      readonly type: 'repair-start' | 'repair-end';
      readonly at: SimTime;
      readonly machineId: string;
      readonly failureCode: string;
    }
  | {
      readonly type: 'material-consumed';
      readonly at: SimTime;
      readonly machineId: string;
      readonly partId: number;
      readonly material: string;
      readonly lotId: string;
    }
  | {
      readonly type: 'program-loaded';
      readonly at: SimTime;
      readonly machineId: string;
      readonly product: string;
      readonly quantity: number;
    }
  | {
      readonly type: 'shift';
      readonly at: SimTime;
      readonly action: CalendarBoundary['action'];
      readonly shiftId: string;
      readonly shiftDate: string;
    }
  | {
      readonly type: 'operator';
      readonly at: SimTime;
      readonly machineId: string;
      readonly operatorId: string | null;
      readonly absent: readonly string[];
    };

export interface Measurement {
  readonly characteristic: string;
  readonly value: number;
  readonly unit: string;
  readonly upperLimit: number;
}

type Unavailable = 'Off' | 'PlannedStop';

const CALENDAR_WINDOW = 7 * 24 * HOUR;

export const MAX_PROGRAM_QUANTITY = 100_000;

export type LoadProgramResult =
  | { ok: true; position: number }
  | {
      ok: false;
      code: 'not-a-cnc' | 'invalid-product' | 'invalid-quantity' | 'not-attached';
      reason: string;
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
  readonly requiresOperator: boolean;
  readonly tool: ToolWear | undefined;
  readonly defects: RandomStream;
  readonly leak: LeakTester | undefined;
  readonly rework: Part[] | undefined;
  operator: Assignment | undefined;
  stopEnd: EventHandle | undefined;
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
  readonly scrapped: Part[] = [];
  readonly inventory: Inventory;
  readonly #config: PlantConfig;
  readonly #onEvent: (event: PlantEvent) => void;
  readonly #repairQueue: Station[] = [];
  readonly #crew: Crew;
  #unavailable: Unavailable | undefined = 'Off';
  #freeTechnicians: number;
  #nextPartId = 1;
  #now: SimTime;

  constructor({ config, random, startTime, onEvent }: LineOptions) {
    this.#config = config;
    this.#onEvent = onEvent ?? (() => undefined);
    this.#now = startTime;
    this.#freeTechnicians = config.plant.maintenanceTechnicians;
    this.#crew = new Crew(config, random);
    this.inventory = new Inventory(config.stock);
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
        machine: new Machine(item.id, 'Off', startTime, (change) => {
          this.#onEvent({ type: 'state', ...change });
        }),
        cycle: random.stream(`${item.id}/cycle`),
        clock,
        failures,
        minorStops,
        input: this.buffers.find((b) => b.to === item.operation),
        output: this.buffers.find((b) => b.from === item.operation),
        campaigns,
        requiresOperator: item.requiresOperator,
        tool: campaigns ? new ToolWear(config.process.tool) : undefined,
        defects: random.stream(`${item.id}/quality/defect`),
        leak:
          item.operation === config.process.leakTest.operation
            ? new LeakTester(
                config.process.leakTest,
                random.stream(`${item.id}/quality/leak`),
                startTime,
              )
            : undefined,
        rework: item.operation === config.process.leakTest.reworkOperation ? [] : undefined,
        operator: undefined,
        stopEnd: undefined,
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
    this.#scheduleCalendar(simulation, this.#now + 1, this.#now + CALENDAR_WINDOW);
    const current = shiftAt(this.#config.shifts, this.#now);
    if (current) {
      const { shiftId, shiftDate } = current;
      this.#onEvent({ type: 'shift', at: this.#now, action: 'shift-start', shiftId, shiftDate });
      if (current.inBreak) {
        this.#onEvent({ type: 'shift', at: this.#now, action: 'break-start', shiftId, shiftDate });
      }
      this.#staff(shiftId);
      this.#unavailable = current.inBreak ? 'PlannedStop' : undefined;
    }
    this.stations.forEach((station) => {
      if (this.#unavailable) {
        this.#enter(station, this.#unavailable);
      } else {
        this.#activate(station, simulation);
      }
    });
  }

  handle(event: LineEvent, simulation: Simulation<LineEvent>): void {
    this.#now = simulation.now;
    if (event.type === 'calendar') {
      this.#onCalendar(event.boundary, simulation);
      return;
    }
    if (event.type === 'calendar-refill') {
      this.#scheduleCalendar(simulation, event.until, event.until + CALENDAR_WINDOW);
      return;
    }
    const station = this.#station(event.station);
    switch (event.type) {
      case 'clock':
        station.pending = undefined;
        this.#onClockDue(station, simulation);
        break;
      case 'setup-end':
        station.busy = false;
        if (this.#canWork(station)) {
          this.#tryStart(station, simulation);
        } else {
          this.#enter(station, this.#unavailable ?? 'Idle', this.#unavailableCause(station));
        }
        break;
      case 'stop-end':
        station.stopEnd = undefined;
        this.#run(station, simulation);
        break;
      case 'repair-end':
        this.#finishRepair(station, simulation);
        break;
      case 'maintenance-end':
        station.leak?.calibrate(this.#now);
        station.busy = false;
        if (this.#canWork(station)) {
          this.#tryStart(station, simulation);
        } else {
          this.#enter(station, this.#unavailable ?? 'Idle', this.#unavailableCause(station));
        }
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

  #scheduleCalendar(simulation: Simulation<LineEvent>, from: SimTime, until: SimTime): void {
    for (const boundary of shiftBoundaries(this.#config.shifts, from, until)) {
      simulation.schedule(boundary.at, { type: 'calendar', boundary });
    }
    simulation.schedule(until, { type: 'calendar-refill', until });
  }

  #onCalendar(boundary: CalendarBoundary, simulation: Simulation<LineEvent>): void {
    const { action, shiftId, shiftDate } = boundary;
    this.#onEvent({ type: 'shift', at: this.#now, action, shiftId, shiftDate });
    if (action === 'shift-start') {
      this.#staff(shiftId);
    }
    this.#unavailable =
      action === 'break-start' ? 'PlannedStop' : action === 'shift-end' ? 'Off' : undefined;
    for (const station of this.stations) {
      if (this.#unavailable) {
        this.#interrupt(
          station,
          this.#unavailable,
          action === 'shift-end' ? 'SHIFT-END' : 'BREAK',
          simulation,
        );
      } else {
        this.#activate(station, simulation);
      }
    }
  }

  #staff(shiftId: string): void {
    const crew = this.#crew.forShift(shiftId);
    for (const station of this.stations.filter((s) => s.requiresOperator)) {
      station.operator = crew.assignments.get(station.id);
      this.#onEvent({
        type: 'operator',
        at: this.#now,
        machineId: station.id,
        operatorId: station.operator?.operatorId ?? null,
        absent: crew.absent,
      });
    }
  }

  #canWork(station: Station): boolean {
    return (
      this.#unavailable === undefined &&
      (!station.requiresOperator || station.operator !== undefined)
    );
  }

  #unavailableCause(station: Station): string | undefined {
    return this.#unavailable === undefined && station.requiresOperator && !station.operator
      ? 'NO-OPERATOR'
      : undefined;
  }

  #interrupt(
    station: Station,
    to: MachineState,
    cause: string,
    simulation: Simulation<LineEvent>,
  ): void {
    const state = station.machine.state;
    if (state === 'Setup' || state === 'Down' || state === 'Maintenance' || state === to) {
      return;
    }
    if (station.stopEnd) {
      simulation.cancel(station.stopEnd);
      station.stopEnd = undefined;
    }
    this.#halt(station, simulation);
    this.#enter(station, to, cause);
  }

  #activate(station: Station, simulation: Simulation<LineEvent>): void {
    const state = station.machine.state;
    if (state === 'Setup' || state === 'Down' || state === 'Maintenance') {
      return;
    }
    if (!this.#canWork(station)) {
      this.#interrupt(station, 'Idle', 'NO-OPERATOR', simulation);
      return;
    }
    const waiting = state === 'Off' || state === 'PlannedStop' || state === 'Idle';
    if (!waiting) {
      return;
    }
    if (station.part && station.clock.remaining(CYCLE) !== undefined) {
      this.#run(station, simulation);
    } else if (station.part) {
      this.#unload(station, simulation);
    } else {
      this.#tryStart(station, simulation);
    }
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
    station.stopEnd = simulation.scheduleIn(millis(exponential(stops.duration, stops.mean)), {
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
    if (this.#canWork(station)) {
      this.#run(station, simulation);
    } else {
      this.#enter(station, this.#unavailable ?? 'Idle', this.#unavailableCause(station));
    }
    this.#dispatchTechnicians(simulation);
  }

  #tryStart(station: Station, simulation: Simulation<LineEvent>): void {
    if (station.busy || !this.#canWork(station)) {
      return;
    }
    if (station.tool?.needsChange) {
      station.tool.change();
      this.#occupy(
        station,
        'Setup',
        'TOOL-CHANGE',
        this.#config.process.tool.changeMinutes,
        'setup-end',
        simulation,
      );
      return;
    }
    if (station.leak?.calibrationDue(this.#now)) {
      this.#occupy(
        station,
        'Maintenance',
        'CALIBRATION',
        this.#config.process.leakTest.calibrationMinutes,
        'maintenance-end',
        simulation,
      );
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
    const blank = this.#product(campaign.product).blank;
    if (!this.inventory.available(blank)) {
      this.#enter(station, 'Starved', `MATERIAL:${blank}`);
      return undefined;
    }
    campaign.remaining--;
    const part: Part = { id: this.#nextPartId++, product: campaign.product, lots: [] };
    this.#consume(station, part, [blank]);
    return part;
  }

  #product(id: string): PlantConfig['products']['products'][number] {
    const product = this.#config.products.products.find((p) => p.id === id);
    if (!product) {
      throw new RangeError(`unknown product "${id}"`);
    }
    return product;
  }

  #consume(station: Station, part: Part, materials: readonly string[]): void {
    for (const material of materials) {
      const lotId = this.inventory.consume(material);
      part.lots.push({ material, lotId });
      this.#onEvent({
        type: 'material-consumed',
        at: this.#now,
        machineId: station.id,
        partId: part.id,
        material,
        lotId,
      });
    }
  }

  loadProgram(
    machineId: string,
    product: string,
    quantity: number,
    simulation: Simulation<LineEvent>,
  ): LoadProgramResult {
    const station = this.stations.find((s) => s.id === machineId);
    if (!station?.campaigns) {
      return { ok: false, code: 'not-a-cnc', reason: `${machineId} does not run programs` };
    }
    if (!this.#config.products.products.some((p) => p.id === product)) {
      return { ok: false, code: 'invalid-product', reason: `unknown product "${product}"` };
    }
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_PROGRAM_QUANTITY) {
      return {
        ok: false,
        code: 'invalid-quantity',
        reason: `quantity must be an integer from 1 to ${String(MAX_PROGRAM_QUANTITY)}, got ${String(quantity)}`,
      };
    }
    this.#now = simulation.now;
    station.campaigns.unshift({ product, remaining: quantity });
    this.#onEvent({ type: 'program-loaded', at: this.#now, machineId, product, quantity });
    if (station.machine.state === 'Idle' || station.machine.state === 'Starved') {
      this.#tryStart(station, simulation);
    }
    return { ok: true, position: 1 };
  }

  blockLot(lotId: string, blocked: boolean, simulation: Simulation<LineEvent>): void {
    this.#now = simulation.now;
    this.inventory.setBlocked(lotId, blocked);
    if (!blocked) {
      this.stations.forEach((station) => {
        if (station.machine.state === 'Starved') {
          this.#tryStart(station, simulation);
        }
      });
    }
  }

  #occupy(
    station: Station,
    state: MachineState,
    cause: string,
    minutes: number,
    end: 'setup-end' | 'maintenance-end',
    simulation: Simulation<LineEvent>,
  ): void {
    station.busy = true;
    this.#enter(station, state, cause);
    simulation.scheduleIn(millis(minutes * MINUTE), { type: end, station: station.id });
  }

  #takeFromInput(station: Station): Part | undefined {
    const rework = station.rework?.length ? station.rework : undefined;
    const next = rework ? rework[0] : station.input?.peek();
    if (!next) {
      this.#enter(station, 'Starved');
      return undefined;
    }
    const needed =
      station.operation !== this.#config.products.componentsOperation
        ? []
        : rework
          ? this.#product(next.product).reworkComponents
          : this.#product(next.product).components;
    const missing = needed.find((material) => !this.inventory.available(material));
    if (missing) {
      this.#enter(station, 'Starved', `MATERIAL:${missing}`);
      return undefined;
    }
    const part = rework ? rework.shift() : station.input?.shift();
    if (!part) {
      return undefined;
    }
    this.#consume(station, part, needed);
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
    const mean = ideal * (station.operator?.speedFactor ?? 1);
    const seconds = cv > 0 ? logNormalFromMeanCv(station.cycle, mean, cv) : mean;
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
    const complete = (
      result: 'good' | 'scrap' | 'rework',
      extra: { reason?: string; measurement?: Measurement } = {},
    ): void => {
      this.#onEvent({
        type: 'cycle-complete',
        at: this.#now,
        machineId: station.id,
        product: part.product,
        partId: part.id,
        serial: part.serial ?? '',
        result,
        ...extra,
      });
    };
    if (station.tool) {
      const defective = bernoulli(station.defects, station.tool.defectProbability());
      station.tool.recordCycle();
      if (defective) {
        complete('scrap', { reason: 'DIMENSIONAL' });
        this.#scrap(station, part, simulation);
        return;
      }
    }
    if (station.leak) {
      const config = this.#config.process.leakTest;
      const reading = station.leak.measure(this.#now);
      const measurement = {
        characteristic: 'leak-rate',
        value: reading.value,
        unit: config.unit,
        upperLimit: config.upperLimit,
      };
      if (!reading.pass) {
        part.leakFailures = (part.leakFailures ?? 0) + 1;
        if (part.leakFailures === 1) {
          complete('rework', { reason: 'LEAK', measurement });
          this.#sendToRework(station, part, simulation);
        } else {
          complete('scrap', { reason: 'LEAK', measurement });
          this.#scrap(station, part, simulation);
        }
        return;
      }
      complete('good', { measurement });
    } else {
      complete('good');
    }
    this.#unload(station, simulation);
  }

  #scrap(station: Station, part: Part, simulation: Simulation<LineEvent>): void {
    this.scrapped.push(part);
    station.part = undefined;
    station.busy = false;
    this.#tryStart(station, simulation);
  }

  #sendToRework(station: Station, part: Part, simulation: Simulation<LineEvent>): void {
    const target = this.stations.find((s) => s.rework !== undefined);
    if (!target?.rework) {
      throw new RangeError('no rework station configured');
    }
    target.rework.push(part);
    station.part = undefined;
    station.busy = false;
    this.#tryStart(target, simulation);
    this.#tryStart(station, simulation);
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
