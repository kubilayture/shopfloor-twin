import {
  CALIBRATION_ALARM_CODE,
  CALIBRATION_ALARM_SEVERITY,
  CAUSES,
  FAILURE_ALARM_SEVERITY,
  MAX_QUEUED_JOBS,
  type LOAD_ORDER_INPUTS,
  changeoverCause,
  materialCause,
  type JobTransition,
} from '@shopfloor/contracts';
import {
  LEAK_TEST_CHARACTERISTIC,
  actionIssues,
  driftIssues,
  shiftStart,
  type ActionIssueCode,
  type OperatorsAbsentSpec,
  driftSteps,
  injectionIssues,
  type DriftIssueCode,
  type InjectionIssueCode,
  type PlantConfig,
} from '@shopfloor/plant-config';
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
import { shiftAt, shiftBoundaries, type CalendarBoundary } from '@shopfloor/shift-calendar';
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
  | { readonly type: 'maintenance-end'; readonly station: string }
  | { readonly type: 'calibration-due'; readonly station: string }
  | { readonly type: 'inject-failure'; readonly station: string; readonly injection: number }
  | {
      readonly type: 'drift-start' | 'drift-end';
      readonly station: string;
      readonly injection: number;
    }
  | { readonly type: 'wake'; readonly station: string }
  | { readonly type: 'tool-break'; readonly station: string; readonly action: number };

export type LineEvent =
  | StationEvent
  | { readonly type: 'lot-action'; readonly action: number }
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
      readonly type: 'alarm';
      readonly at: SimTime;
      readonly machineId: string;
      readonly code: string;
      readonly transition: 'active' | 'cleared';
      readonly severity: number;
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
      /**
       * A failure injection (#140) took effect (`injection-applied`: the machine goes Down with its
       * code now) or is held until the machine would next enter Running (`injection-held`).
       */
      readonly type: 'injection-held' | 'injection-applied';
      readonly at: SimTime;
      readonly machineId: string;
      readonly injection: number;
      readonly code: string;
    }
  | {
      /**
       * A leak-test drift injection (#196, ADR-0033) began adding `shift` to the tester's readings
       * (`applied`), or stopped (`ended`): at its `until` (`endedBy: 'until'`) or at the start of
       * the tester's calibration before it (`endedBy: 'calibration'`). A drift still active at the
       * end of a run has no `ended` line. Only runs with a drift injection write it.
       */
      readonly type: 'leak-drift';
      readonly at: SimTime;
      readonly machineId: string;
      readonly injection: number;
      readonly transition: 'applied' | 'ended';
      readonly shift: number;
      readonly endedBy?: DriftEnd;
    }
  | {
      readonly type: 'operator';
      readonly at: SimTime;
      readonly machineId: string;
      readonly operatorId: string | null;
      readonly absent: readonly string[];
    }
  | {
      /**
       * Orders mode (#172, ADR-0030): a job was accepted by `LoadOrder` (or a scenario dispatch),
       * started (its first blank taken, after any changeover) or completed (its last OP10 cycle
       * ended, whatever the result). Only orders-mode runs write it.
       */
      readonly type: 'job';
      readonly at: SimTime;
      readonly machineId: string;
      readonly transition: JobTransition;
      readonly commandId: string;
      readonly orderId: string;
      readonly product: string;
      readonly quantity: number;
    }
  | {
      /**
       * A console action (#234, ADR-0037) blocked a material lot (skipped as if empty) or released
       * it. `action` is the action's id; a direct `blockLot` call has none. Only runs with a lot
       * action write it.
       */
      readonly type: 'lot';
      readonly at: SimTime;
      readonly lotId: string;
      readonly material: string;
      readonly transition: 'blocked' | 'released';
      readonly action?: number;
    }
  | {
      /**
       * A console action (#234, ADR-0037) made these operators absent for the shift that starts
       * now, whatever their roster draw said. Written at the shift start, before its `operator`
       * events; only runs with a forced absence write it.
       */
      readonly type: 'absence';
      readonly at: SimTime;
      readonly shiftId: string;
      readonly shiftDate: string;
      readonly operators: readonly string[];
    }
  | {
      /**
       * A console action (#234, ADR-0037) broke a CNC's tool: its wear is now end of life (1.0).
       * `cycles` is the tool's cycle count before. Only runs with a tool breakage write it.
       */
      readonly type: 'tool-breakage';
      readonly at: SimTime;
      readonly machineId: string;
      readonly action: number;
      readonly cycles: number;
      /**
       * Set when the breakage fell inside the machine's own `TOOL-CHANGE` setup: the tool being
       * fitted has not cut yet, so nothing changes (no second change).
       */
      readonly ignored?: 'tool-change-in-progress';
    };

export interface Measurement {
  readonly characteristic: string;
  readonly value: number;
  readonly unit: string;
  readonly upperLimit: number;
}

type Unavailable = 'Off' | 'PlannedStop';

/**
 * Where a CNC's work comes from (#172, ADR-0030): `schedule` (Phases 1–6, `schedule.yaml`'s
 * campaigns, the default) or `orders` (only the jobs `LoadOrder` or a scenario's dispatches give).
 */
export const PRODUCTION_MODES = ['schedule', 'orders'] as const;

export type ProductionMode = (typeof PRODUCTION_MODES)[number];

const CALENDAR_WINDOW = 7 * 24 * HOUR;

export const MAX_PROGRAM_QUANTITY = 100_000;
export {
  CALIBRATION_ALARM_CODE,
  CALIBRATION_ALARM_SEVERITY,
  FAILURE_ALARM_SEVERITY,
} from '@shopfloor/contracts';

export type LoadProgramResult =
  | { ok: true; position: number }
  | {
      ok: false;
      code: 'not-a-cnc' | 'invalid-product' | 'invalid-quantity' | 'not-attached' | 'wrong-mode';
      reason: string;
    };

/** A job for a CNC's queue (#172): `LoadOrder`'s arguments, or a scenario dispatch. */
export interface LoadOrderRequest {
  readonly commandId: string;
  readonly orderId: string;
  readonly product: string;
  /** Blanks to machine (a job's quantity is blanks started; OP10 scrap uses up a slot). */
  readonly quantity: number;
  /** Plant time; the job doesn't start earlier. */
  readonly notBefore: SimTime;
  /** The run the command was meant for; checked only with a `LoadOrderGuard`. */
  readonly deviceEpoch?: number | undefined;
  /** Wall time (ms); checked only with a `LoadOrderGuard`. */
  readonly expiresAt?: number | undefined;
}

/** What only the device knows: its run's epoch and its wall clock (OPC UA calls, not dispatches). */
export interface LoadOrderGuard {
  readonly epoch: number;
  readonly wallNow: number;
}

export type LoadOrderRefusal =
  | 'not-a-cnc'
  | 'not-attached'
  | 'not-running'
  | 'wrong-mode'
  | 'command-conflict'
  | 'epoch-mismatch'
  | 'expired'
  | 'invalid-argument'
  | 'invalid-product'
  | 'invalid-quantity'
  | 'queue-full';

/** `LoadOrder`'s input argument names (`LOAD_ORDER_INPUTS` of the contracts). */
export type LoadOrderArgument = (typeof LOAD_ORDER_INPUTS)[number];

/** A job as the line keeps it (#172). */
export interface JobView {
  readonly commandId: string;
  readonly orderId: string;
  readonly machine: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: SimTime;
  /** 1-based place in the queue when it was accepted (jobs accepted and not completed). */
  readonly position: number;
  readonly acceptedAt: SimTime;
  /** Blanks taken so far. */
  readonly taken: number;
  readonly startedAt?: SimTime;
  readonly completedAt?: SimTime;
}

export type LoadOrderResult =
  | {
      readonly ok: true;
      /** The command id was already accepted with this job: nothing was added (idempotent). */
      readonly duplicate: boolean;
      readonly job: JobView;
    }
  | {
      readonly ok: false;
      readonly code: LoadOrderRefusal;
      readonly reason: string;
      /** The offending argument. */
      readonly argument?: LoadOrderArgument;
    };

interface Job {
  readonly commandId: string;
  readonly orderId: string;
  readonly machine: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: SimTime;
  readonly position: number;
  readonly acceptedAt: SimTime;
  taken: number;
  startedAt: SimTime | undefined;
  completedAt: SimTime | undefined;
}

/** Longest command and order id `LoadOrder` takes. */
export const MAX_JOB_ID_LENGTH = 128;

/** A failure injection (#140) and what became of it. */
export interface FailureInjection {
  /** 1, 2, … in the order the line accepted them. */
  readonly id: number;
  readonly machine: string;
  readonly code: string;
  /** When it was due (simulation time). */
  readonly at: SimTime;
  readonly repairMs?: number;
  /** `scheduled` until due; `held` while the machine is not Running; `applied` once Down. */
  readonly status: 'scheduled' | 'held' | 'applied';
  readonly heldAt?: SimTime;
  readonly appliedAt?: SimTime;
}

export interface InjectFailureRequest {
  readonly machine: string;
  readonly code: string;
  /** Simulation time; the current time when left out. */
  readonly at?: SimTime | undefined;
  readonly repairMs?: number | undefined;
}

export type InjectFailureResult =
  | { readonly ok: true; readonly injection: FailureInjection }
  | {
      readonly ok: false;
      readonly code: InjectionIssueCode | 'in-the-past';
      readonly reason: string;
    };

/** What ended a leak drift (#196): its `until`, or a calibration before it. */
export type DriftEnd = 'until' | 'calibration';

/** A leak-test drift injection (#196, ADR-0033) and what became of it. */
export interface LeakDrift {
  /** Numbered with the failure injections, in the order the line accepted them. */
  readonly id: number;
  readonly machine: string;
  /** Pa/min (the tester's unit) added to every reading while active. */
  readonly shift: number;
  readonly at: SimTime;
  readonly until: SimTime;
  /** `scheduled` until `at`, `active` until it ends, then `ended`. */
  readonly status: 'scheduled' | 'active' | 'ended';
  readonly appliedAt?: SimTime;
  readonly endedAt?: SimTime;
  readonly endedBy?: DriftEnd;
}

export interface InjectDriftRequest {
  readonly machine: string;
  readonly shift: number;
  /** Simulation time; the current time when left out. */
  readonly at?: SimTime | undefined;
  readonly until: SimTime;
}

export type InjectDriftResult =
  | { readonly ok: true; readonly drift: LeakDrift }
  | {
      readonly ok: false;
      readonly code: DriftIssueCode | 'in-the-past';
      readonly reason: string;
    };

interface Drift {
  readonly id: number;
  readonly machine: string;
  readonly shift: number;
  readonly steps: number;
  readonly at: SimTime;
  readonly until: SimTime;
  status: LeakDrift['status'];
  appliedAt: SimTime | undefined;
  endedAt: SimTime | undefined;
  endedBy: DriftEnd | undefined;
}

/**
 * A scheduled console action's progress (#234): `scheduled` until its time, then `applied`, or
 * `ignored` for a tool breakage that fell inside a `TOOL-CHANGE` setup.
 */
export type ActionStatus = 'scheduled' | 'applied' | 'ignored';

/** A lot block or release (#234, ADR-0037) and what became of it. */
export interface LotAction {
  /** 1, 2, … in the order the line accepted console actions (their own numbering). */
  readonly id: number;
  readonly kind: 'lot-block' | 'lot-release';
  readonly lot: string;
  readonly material: string;
  readonly at: SimTime;
  readonly status: ActionStatus;
  readonly appliedAt?: SimTime;
}

/** A tool breakage (#234, ADR-0037) and what became of it. */
export interface ToolBreakage {
  readonly id: number;
  readonly kind: 'tool-breakage';
  readonly machine: string;
  readonly at: SimTime;
  readonly status: ActionStatus;
  readonly appliedAt?: SimTime;
  /** The tool's cycle count when it broke. */
  readonly cycles?: number;
}

/** A forced absence (#234, ADR-0037): `planned` until its shift starts, then `applied`. */
export interface OperatorAbsence {
  readonly id: number;
  readonly kind: 'operators-absent';
  /** The shift bucket key, `YYYY-MM-DD/<shift id>`. */
  readonly shift: string;
  /** The shift's start. */
  readonly start: SimTime;
  readonly operators: readonly string[];
  readonly status: 'planned' | 'applied';
  readonly appliedAt?: SimTime;
}

export type ConsoleAction = LotAction | ToolBreakage | OperatorAbsence;

/**
 * A console action as the control API or a headless run's `actions` gives it; `at` is the
 * current simulation time when left out.
 */
export type ActionRequest =
  | {
      readonly kind: 'lot-block' | 'lot-release';
      readonly lot: string;
      readonly at?: SimTime | undefined;
    }
  | { readonly kind: 'tool-breakage'; readonly machine: string; readonly at?: SimTime | undefined }
  | OperatorsAbsentSpec;

export type ActionResult =
  | { readonly ok: true; readonly action: ConsoleAction }
  | {
      readonly ok: false;
      readonly code: ActionIssueCode | 'in-the-past' | 'shift-started';
      readonly reason: string;
    };

/** A roster entry with where the operator is in the current shift (#234, `GET /operators`). */
export interface OperatorView {
  readonly id: string;
  readonly shift: string;
  readonly skills: readonly string[];
  readonly speedFactor: number;
  /** `off-shift` when the operator is not rostered on the current shift, or no shift runs. */
  readonly status: 'present' | 'absent' | 'off-shift';
  /** The station the operator staffs in the current shift, if any. */
  readonly station: string | null;
  /** Absent in the current shift by a console action rather than the roster draw. */
  readonly forced: boolean;
}

export interface OperatorsView {
  /** The shift bucket key of the running shift, or null between shifts. */
  readonly currentShift: string | null;
  readonly operators: readonly OperatorView[];
  /** Every forced absence accepted so far, planned or applied, in acceptance order. */
  readonly absences: readonly OperatorAbsence[];
}

/** A material lot as `GET /lots` shows it (#234). */
export interface LotView {
  readonly id: string;
  readonly material: string;
  readonly remaining: number;
  readonly blocked: boolean;
}

interface LotActionRecord {
  readonly id: number;
  readonly kind: 'lot-block' | 'lot-release';
  readonly lot: string;
  readonly material: string;
  readonly at: SimTime;
  status: ActionStatus;
  appliedAt: SimTime | undefined;
}

interface ToolBreakageRecord {
  readonly id: number;
  readonly kind: 'tool-breakage';
  readonly machine: string;
  readonly at: SimTime;
  status: ActionStatus;
  appliedAt: SimTime | undefined;
  cycles: number | undefined;
}

interface AbsenceRecord {
  readonly id: number;
  readonly kind: 'operators-absent';
  readonly shift: string;
  readonly start: SimTime;
  readonly operators: readonly string[];
  status: OperatorAbsence['status'];
  appliedAt: SimTime | undefined;
}

type ActionRecord = LotActionRecord | ToolBreakageRecord | AbsenceRecord;

/** The crew of the running shift, for `GET /operators`. */
interface CrewNow {
  readonly key: string;
  readonly shiftId: string;
  readonly absent: ReadonlySet<string>;
  readonly forced: ReadonlySet<string>;
  /** Operator id → the station they staff. */
  readonly stations: ReadonlyMap<string, string>;
}

interface Injection {
  readonly id: number;
  readonly machine: string;
  readonly code: string;
  readonly at: SimTime;
  readonly repairMs: number | undefined;
  status: FailureInjection['status'];
  heldAt: SimTime | undefined;
  appliedAt: SimTime | undefined;
}

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
  /** CNCs only: `[]` in orders mode, so a CNC is still told from other stations by it. */
  readonly campaigns: Campaign[] | undefined;
  /** Orders mode, CNCs only: jobs accepted and not completed, in order (FIFO). */
  readonly jobs: Job[] | undefined;
  /** Orders mode, CNCs only: every job this run accepted, by command id (the dedup table). */
  readonly accepted: Map<string, Job> | undefined;
  readonly requiresOperator: boolean;
  readonly tool: ToolWear | undefined;
  readonly defects: RandomStream;
  readonly leak: LeakTester | undefined;
  readonly rework: Part[] | undefined;
  operator: Assignment | undefined;
  stopEnd: EventHandle | undefined;
  readonly activeAlarms: Set<string>;
  loadedProduct: string | undefined;
  part: Part | undefined;
  busy: boolean;
  pending: EventHandle | undefined;
  failure: FailureMode | undefined;
  /** The exact repair time of an injected failure; undefined draws from the mode's stream. */
  repairMs: number | undefined;
  /** Injections waiting for the machine to enter Running, in order (#140). */
  readonly held: Injection[];
  /** In a `TOOL-CHANGE` setup (#234): a tool breakage then changes nothing. */
  changingTool: boolean;
}

export interface LineOptions {
  readonly config: PlantConfig;
  readonly random: RandomSource;
  readonly startTime: SimTime;
  readonly onEvent?: (event: PlantEvent) => void;
  /** `schedule` (default) or `orders` (#172). */
  readonly production?: ProductionMode | undefined;
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
  readonly #injections: Injection[] = [];
  readonly #drifts: Drift[] = [];
  /** Failure injections and drifts share one numbering (#196): ids in acceptance order. */
  #nextInjectionId = 1;
  readonly #jobs: Job[] = [];
  /** Console actions (#234), in acceptance order, numbered on their own from 1. */
  readonly #actions: ActionRecord[] = [];
  #crewNow: CrewNow | undefined;
  /** Orders mode: every job this run accepted, by command id, line-wide (the dedup table). */
  readonly #acceptedCommands = new Map<string, Job>();
  readonly production: ProductionMode;
  #unavailable: Unavailable | undefined = 'Off';
  #freeTechnicians: number;
  #nextPartId = 1;
  #now: SimTime;

  constructor({ config, random, startTime, onEvent, production = 'schedule' }: LineOptions) {
    this.#config = config;
    this.production = production;
    const firstOperation = config.products.operations[0];
    this.#onEvent = onEvent ?? (() => undefined);
    this.#now = startTime;
    this.#freeTechnicians = config.plant.maintenanceTechnicians;
    this.#crew = new Crew(config, random);
    this.inventory = new Inventory(config.stock);
    this.buffers = config.plant.buffers.map((b) => new PartBuffer(b.from, b.to, b.capacity));
    const equipment = config.plant.areas.flatMap((a) => a.workCenters.flatMap((w) => w.equipment));
    this.stations = equipment.map((item) => {
      // Orders mode (#172): every first-operation machine is a CNC with no campaign, and the
      // schedule is not used; nothing is loaded at the start.
      const campaigns =
        production === 'orders'
          ? item.operation === firstOperation
            ? []
            : undefined
          : config.schedule.machines[item.id]?.map((c) => ({
              product: c.product,
              remaining: c.quantity,
            }));
      const ordered = production === 'orders' && campaigns !== undefined;
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
        jobs: ordered ? [] : undefined,
        accepted: ordered ? new Map<string, Job>() : undefined,
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
        activeAlarms: new Set<string>(),
        loadedProduct: campaigns?.[0]?.product,
        part: undefined,
        busy: false,
        pending: undefined,
        failure: undefined,
        repairMs: undefined,
        held: [],
        changingTool: false,
      };
    });
  }

  get producedParts(): number {
    return this.#nextPartId - 1;
  }

  start(simulation: Simulation<LineEvent>): void {
    this.#now = simulation.now;
    for (const station of this.stations) {
      if (station.leak) {
        this.#scheduleCalibrationDue(station, simulation);
      }
    }
    this.#scheduleCalendar(simulation, this.#now + 1, this.#now + CALENDAR_WINDOW);
    const current = shiftAt(this.#config.shifts, this.#now);
    if (current) {
      const { shiftId, shiftDate } = current;
      this.#onEvent({ type: 'shift', at: this.#now, action: 'shift-start', shiftId, shiftDate });
      if (current.inBreak) {
        this.#onEvent({ type: 'shift', at: this.#now, action: 'break-start', shiftId, shiftDate });
      }
      this.#staff(shiftId, shiftDate);
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
    if (event.type === 'lot-action') {
      this.#applyLotAction(event.action, simulation);
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
        station.changingTool = false;
        if (this.#canWork(station)) {
          this.#tryStart(station, simulation);
        } else {
          this.#enter(station, this.#unavailable ?? 'Idle', this.#unavailableCause(station));
        }
        break;
      case 'stop-end':
        station.stopEnd = undefined;
        // Guard (#140): a minor stop ends into Running only; a Down machine waits for its repair.
        if (station.failure === undefined && station.machine.state === 'Stopped') {
          this.#run(station, simulation);
        }
        break;
      case 'inject-failure':
        this.#onInjection(station, this.#injection(event.injection), simulation);
        break;
      case 'drift-start':
        this.#startDrift(station, this.#drift(event.injection));
        break;
      case 'drift-end':
        this.#endDrift(station, this.#drift(event.injection), 'until');
        break;
      case 'wake':
        this.#startInShift(station, simulation);
        break;
      case 'tool-break':
        this.#applyToolBreak(station, event.action);
        break;
      case 'repair-end':
        this.#finishRepair(station, simulation);
        break;
      case 'calibration-due':
        // A same-millisecond tie can start the calibration first; then nothing is due any more.
        if (!this.#calibrating(station)) {
          this.#alarm(station, CALIBRATION_ALARM_CODE, 'active', CALIBRATION_ALARM_SEVERITY);
        }
        break;
      case 'maintenance-end':
        if (station.leak) {
          station.leak.calibrate(this.#now);
          if (station.activeAlarms.has(CALIBRATION_ALARM_CODE)) {
            this.#alarm(station, CALIBRATION_ALARM_CODE, 'cleared', CALIBRATION_ALARM_SEVERITY);
          }
          this.#scheduleCalibrationDue(station, simulation);
        }
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
      this.#staff(shiftId, shiftDate);
    } else if (action === 'shift-end') {
      this.#crewNow = undefined;
    }
    this.#unavailable =
      action === 'break-start' ? 'PlannedStop' : action === 'shift-end' ? 'Off' : undefined;
    for (const station of this.stations) {
      if (this.#unavailable) {
        this.#interrupt(
          station,
          this.#unavailable,
          action === 'shift-end' ? CAUSES.shiftEnd : CAUSES.break,
          simulation,
        );
      } else {
        this.#activate(station, simulation);
      }
    }
  }

  #staff(shiftId: string, shiftDate: string): void {
    const key = `${shiftDate}/${shiftId}`;
    // Forced absences of this shift (#234): every listed operator, in roster order.
    const forcing = this.#actions.filter(
      (a): a is AbsenceRecord => a.kind === 'operators-absent' && a.shift === key,
    );
    const listed = new Set(forcing.flatMap((a) => a.operators));
    const forced = this.#config.operators.operators
      .map((op) => op.id)
      .filter((id) => listed.has(id));
    const crew = this.#crew.forShift(shiftId, listed);
    if (forced.length > 0) {
      for (const absence of forcing) {
        absence.status = 'applied';
        absence.appliedAt = this.#now;
      }
      this.#onEvent({ type: 'absence', at: this.#now, shiftId, shiftDate, operators: forced });
    }
    const stations = new Map<string, string>();
    for (const [station, assignment] of crew.assignments) {
      if (assignment) stations.set(assignment.operatorId, station);
    }
    this.#crewNow = { key, shiftId, absent: new Set(crew.absent), forced: listed, stations };
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
      ? CAUSES.noOperator
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
      this.#interrupt(station, 'Idle', CAUSES.noOperator, simulation);
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
    // A held injection takes effect where the machine would enter Running: straight to Down, so
    // there is never a Running interval of zero length (#140). The cycle clock stays paused.
    const held = station.held.shift();
    if (held) {
      this.#applyInjection(station, held, simulation);
      return;
    }
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

  #breakDown(
    station: Station,
    mode: FailureMode,
    simulation: Simulation<LineEvent>,
    injected?: { readonly repairMs: number | undefined },
  ): void {
    // An injection doesn't redraw the mode's natural time to failure.
    if (!injected) {
      station.clock.set(
        FAILURE + mode.code,
        millis(weibull(mode.arrival, mode.shape, mode.scale)),
        this.#now,
      );
    }
    station.failure = mode;
    station.repairMs = injected?.repairMs;
    if (station.machine.state === 'Down') {
      // Only a held injection at the end of a repair: the machine stays Down with the new code.
      station.machine.transition('Down', this.#now, mode.code);
    } else {
      this.#enter(station, 'Down', mode.code);
    }
    this.#alarm(station, mode.code, 'active', FAILURE_ALARM_SEVERITY);
    this.#repairQueue.push(station);
    this.#dispatchTechnicians(simulation);
  }

  /**
   * Accepts a failure injection (#140, control API 1.3 and scenario `injections`) and schedules it
   * as a simulation event at `at` (now when left out). Refused: an unknown machine or code, an
   * invalid repair time, a time in the past or on a calendar boundary.
   */
  injectFailure(
    request: InjectFailureRequest,
    simulation: Simulation<LineEvent>,
  ): InjectFailureResult {
    this.#now = simulation.now;
    const at = request.at ?? simulation.now;
    const [issue] = injectionIssues(this.#config, { ...request, at });
    if (issue) {
      return { ok: false, code: issue.code, reason: issue.message };
    }
    if (at < simulation.now) {
      return {
        ok: false,
        code: 'in-the-past',
        reason: `${new Date(at).toISOString()} is before the simulation time ${new Date(simulation.now).toISOString()}`,
      };
    }
    const injection: Injection = {
      id: this.#nextInjectionId++,
      machine: request.machine,
      code: request.code,
      at,
      repairMs: request.repairMs,
      status: 'scheduled',
      heldAt: undefined,
      appliedAt: undefined,
    };
    this.#injections.push(injection);
    simulation.schedule(at, {
      type: 'inject-failure',
      station: request.machine,
      injection: injection.id,
    });
    return { ok: true, injection: this.#view(injection) };
  }

  /** Every injection accepted so far, in order, with its outcome. */
  injections(): FailureInjection[] {
    return this.#injections.map((injection) => this.#view(injection));
  }

  #view(injection: Injection): FailureInjection {
    return {
      id: injection.id,
      machine: injection.machine,
      code: injection.code,
      at: injection.at,
      status: injection.status,
      ...(injection.repairMs === undefined ? {} : { repairMs: injection.repairMs }),
      ...(injection.heldAt === undefined ? {} : { heldAt: injection.heldAt }),
      ...(injection.appliedAt === undefined ? {} : { appliedAt: injection.appliedAt }),
    };
  }

  #injection(id: number): Injection {
    const injection = this.#injections.find((i) => i.id === id);
    if (!injection) {
      throw new RangeError(`unknown injection ${String(id)}`);
    }
    return injection;
  }

  /**
   * Accepts a leak-test drift injection (#196, ADR-0033: control API 1.5 and scenario
   * `injections` with `kind: 'leak-drift'`) and schedules its start at `at` (now when left out)
   * and its end at `until`. Refused: another machine than the leak tester, a shift that is not a
   * non-zero whole multiple of the tester's resolution, an `until` not after `at`, a time in the
   * past, `at` or `until` (before `runEnd`, when given) on a calendar boundary. No random draw
   * changes: the reading still draws one normal, and the shift is added in whole resolution
   * steps after rounding, so the reading without the drift is exactly the logged one minus
   * `shift`.
   */
  injectLeakDrift(
    request: InjectDriftRequest,
    simulation: Simulation<LineEvent>,
    runEnd?: SimTime,
  ): InjectDriftResult {
    this.#now = simulation.now;
    const at = request.at ?? simulation.now;
    const [issue] = driftIssues(this.#config, { ...request, at }, runEnd);
    const steps = driftSteps(request.shift, this.#config.process.leakTest.resolution);
    if (issue || steps === undefined) {
      return {
        ok: false,
        code: issue?.code ?? 'invalid-shift',
        reason: issue?.message ?? 'invalid shift',
      };
    }
    if (at < simulation.now) {
      return {
        ok: false,
        code: 'in-the-past',
        reason: `${new Date(at).toISOString()} is before the simulation time ${new Date(simulation.now).toISOString()}`,
      };
    }
    const drift: Drift = {
      id: this.#nextInjectionId++,
      machine: request.machine,
      shift: request.shift,
      steps,
      at,
      until: request.until,
      status: 'scheduled',
      appliedAt: undefined,
      endedAt: undefined,
      endedBy: undefined,
    };
    this.#drifts.push(drift);
    simulation.schedule(at, { type: 'drift-start', station: request.machine, injection: drift.id });
    simulation.schedule(drift.until, {
      type: 'drift-end',
      station: request.machine,
      injection: drift.id,
    });
    return { ok: true, drift: this.#driftView(drift) };
  }

  /** Every drift injection accepted so far, in order, with its outcome. */
  drifts(): LeakDrift[] {
    return this.#drifts.map((drift) => this.#driftView(drift));
  }

  #driftView(drift: Drift): LeakDrift {
    return {
      id: drift.id,
      machine: drift.machine,
      shift: drift.shift,
      at: drift.at,
      until: drift.until,
      status: drift.status,
      ...(drift.appliedAt === undefined ? {} : { appliedAt: drift.appliedAt }),
      ...(drift.endedAt === undefined ? {} : { endedAt: drift.endedAt }),
      ...(drift.endedBy === undefined ? {} : { endedBy: drift.endedBy }),
    };
  }

  #drift(id: number): Drift {
    const drift = this.#drifts.find((d) => d.id === id);
    if (!drift) {
      throw new RangeError(`unknown drift injection ${String(id)}`);
    }
    return drift;
  }

  #startDrift(station: Station, drift: Drift): void {
    if (!station.leak) {
      throw new RangeError(`${station.id} is not a leak tester`);
    }
    drift.status = 'active';
    drift.appliedAt = this.#now;
    station.leak.addShift(drift.steps);
    this.#onEvent({
      type: 'leak-drift',
      at: this.#now,
      machineId: station.id,
      injection: drift.id,
      transition: 'applied',
      shift: drift.shift,
    });
  }

  /** Ends an active drift; one that already ended (by a calibration) stays as it is. */
  #endDrift(station: Station, drift: Drift, endedBy: DriftEnd): void {
    if (drift.status !== 'active' || !station.leak) {
      return;
    }
    drift.status = 'ended';
    drift.endedAt = this.#now;
    drift.endedBy = endedBy;
    station.leak.addShift(-drift.steps);
    this.#onEvent({
      type: 'leak-drift',
      at: this.#now,
      machineId: station.id,
      injection: drift.id,
      transition: 'ended',
      shift: drift.shift,
      endedBy,
    });
  }

  /** An injection falls due: it takes effect only in Running, else it is held (#140). */
  #onInjection(station: Station, injection: Injection, simulation: Simulation<LineEvent>): void {
    if (station.machine.state === 'Running') {
      // The order of a natural failure: halt the cycle and cancel its clock event, then break down.
      this.#halt(station, simulation);
      this.#applyInjection(station, injection, simulation);
      return;
    }
    injection.status = 'held';
    injection.heldAt = this.#now;
    station.held.push(injection);
    this.#onEvent({
      type: 'injection-held',
      at: this.#now,
      machineId: station.id,
      injection: injection.id,
      code: injection.code,
    });
  }

  #applyInjection(station: Station, injection: Injection, simulation: Simulation<LineEvent>): void {
    const mode = station.failures.find((m) => m.code === injection.code);
    if (!mode) {
      throw new RangeError(`${station.id}: no failure mode ${injection.code}`);
    }
    injection.status = 'applied';
    injection.appliedAt = this.#now;
    this.#onEvent({
      type: 'injection-applied',
      at: this.#now,
      machineId: station.id,
      injection: injection.id,
      code: injection.code,
    });
    this.#breakDown(station, mode, simulation, { repairMs: injection.repairMs });
  }

  #alarm(station: Station, code: string, transition: 'active' | 'cleared', severity: number): void {
    if (station.activeAlarms.has(code) === (transition === 'active')) {
      throw new RangeError(`${station.id}: alarm ${code} is already ${transition}`);
    }
    if (transition === 'active') {
      station.activeAlarms.add(code);
    } else {
      station.activeAlarms.delete(code);
    }
    this.#onEvent({
      type: 'alarm',
      at: this.#now,
      machineId: station.id,
      code,
      transition,
      severity,
    });
  }

  #calibrating(station: Station): boolean {
    // Calibration is the only maintenance a leak tester gets.
    return station.leak !== undefined && station.machine.state === 'Maintenance';
  }

  #scheduleCalibrationDue(station: Station, simulation: Simulation<LineEvent>): void {
    const days = this.#config.process.leakTest.calibrationIntervalDays;
    simulation.scheduleIn(millis(days * 24 * HOUR), {
      type: 'calibration-due',
      station: station.id,
    });
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
        station.repairMs ??
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
    this.#alarm(station, mode.code, 'cleared', FAILURE_ALARM_SEVERITY);
    station.failure = undefined;
    station.repairMs = undefined;
    this.#freeTechnicians++;
    if (this.#canWork(station)) {
      this.#run(station, simulation);
    } else {
      this.#enter(station, this.#unavailable ?? 'Idle', this.#unavailableCause(station));
    }
    this.#dispatchTechnicians(simulation);
  }

  #tryStart(station: Station, simulation: Simulation<LineEvent>): void {
    // Guard (#140): a Down machine starts nothing until its repair ends.
    if (station.busy || station.failure !== undefined || !this.#canWork(station)) {
      return;
    }
    if (station.tool?.needsChange) {
      station.tool.change();
      station.changingTool = true;
      this.#occupy(
        station,
        'Setup',
        CAUSES.toolChange,
        this.#config.process.tool.changeMinutes,
        'setup-end',
        simulation,
      );
      return;
    }
    if (station.leak?.calibrationDue(this.#now)) {
      // A calibration ends every drift active on the tester, at its start (#196).
      for (const drift of this.#drifts) {
        if (drift.machine === station.id) this.#endDrift(station, drift, 'calibration');
      }
      this.#occupy(
        station,
        'Maintenance',
        CAUSES.calibration,
        this.#config.process.leakTest.calibrationMinutes,
        'maintenance-end',
        simulation,
      );
      return;
    }
    const part = station.jobs
      ? this.#nextJobBlank(station, station.jobs, simulation)
      : station.campaigns
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
      this.#enter(station, 'Idle', CAUSES.scheduleComplete);
      return undefined;
    }
    if (station.loadedProduct !== campaign.product) {
      const cause = changeoverCause(station.loadedProduct, campaign.product);
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
      this.#enter(station, 'Starved', materialCause(blank));
      return undefined;
    }
    campaign.remaining--;
    const part: Part = { id: this.#nextPartId++, product: campaign.product, lots: [] };
    this.#consume(station, part, [blank]);
    return part;
  }

  /**
   * Orders mode (#172): the next blank of the head job, after a changeover if its product isn't
   * loaded. `Idle NO-ORDER` while the queue is empty or the head waits for its `NotBefore` (a
   * wake-up event at `NotBefore` calls the normal start path again).
   */
  #nextJobBlank(
    station: Station,
    jobs: readonly Job[],
    simulation: Simulation<LineEvent>,
  ): Part | undefined {
    const job = jobs.find((j) => j.taken < j.quantity);
    if (!job || job.notBefore > this.#now) {
      this.#enter(station, 'Idle', CAUSES.noOrder);
      return undefined;
    }
    if (station.loadedProduct !== job.product) {
      const cause = changeoverCause(station.loadedProduct, job.product);
      station.loadedProduct = job.product;
      station.busy = true;
      this.#enter(station, 'Setup', cause);
      simulation.scheduleIn(millis(this.#config.products.changeoverMinutes * MINUTE), {
        type: 'setup-end',
        station: station.id,
      });
      return undefined;
    }
    const blank = this.#product(job.product).blank;
    if (!this.inventory.available(blank)) {
      this.#enter(station, 'Starved', materialCause(blank));
      return undefined;
    }
    if (job.taken === 0) {
      job.startedAt = this.#now;
      this.#jobEvent(job, 'started');
    }
    job.taken++;
    const part: Part = {
      id: this.#nextPartId++,
      product: job.product,
      commandId: job.commandId,
      lots: [],
    };
    this.#consume(station, part, [blank]);
    return part;
  }

  #jobEvent(job: Job, transition: JobTransition): void {
    this.#onEvent({
      type: 'job',
      at: this.#now,
      machineId: job.machine,
      transition,
      commandId: job.commandId,
      orderId: job.orderId,
      product: job.product,
      quantity: job.quantity,
    });
  }

  /** After an OP10 cycle of a job ended: the job is completed with its last blank's cycle. */
  #afterJobCycle(station: Station, part: Part): void {
    const job = part.commandId === undefined ? undefined : station.accepted?.get(part.commandId);
    if (!job || !station.jobs || job.taken < job.quantity || job.completedAt !== undefined) {
      return;
    }
    job.completedAt = this.#now;
    station.jobs.splice(station.jobs.indexOf(job), 1);
    this.#jobEvent(job, 'completed');
  }

  /**
   * A job's `NotBefore` came, or a job was accepted (#172). Only the normal start path, and only
   * for an `Idle` CNC inside a shift and outside its break, checked against the calendar: a
   * wake-up or dispatch in a break, a planned stop or outside a shift starts nothing (the job
   * starts when the machine next leaves that state), also when it falls on the very instant of a
   * calendar boundary that the event queue happens to process after it.
   */
  #startInShift(station: Station, simulation: Simulation<LineEvent>): void {
    const shift = shiftAt(this.#config.shifts, this.#now);
    if (station.machine.state !== 'Idle' || !shift || shift.inBreak) {
      return;
    }
    this.#tryStart(station, simulation);
  }

  /**
   * `LoadOrder` (#172, ADR-0030): appends a job to a CNC's queue, idempotently by command id.
   * The dedup table is line-wide and checked first: a known command id with the same job on the
   * same machine answers `duplicate` with the original acceptance, whatever the epoch or expiry;
   * with another job, or for another machine, it is a `command-conflict`. Only on a miss come the epoch and expiry checks (with a guard, i.e. on an
   * OPC UA call) and the argument checks.
   */
  loadOrder(
    machineId: string,
    request: LoadOrderRequest,
    simulation: Simulation<LineEvent>,
    guard?: LoadOrderGuard,
  ): LoadOrderResult {
    const station = this.stations.find((s) => s.id === machineId);
    if (!station?.campaigns) {
      return { ok: false, code: 'not-a-cnc', reason: `${machineId} does not run jobs` };
    }
    if (!station.jobs || !station.accepted) {
      return {
        ok: false,
        code: 'wrong-mode',
        reason: `LoadOrder needs production mode "orders"; the simulator runs "${this.production}"`,
      };
    }
    this.#now = simulation.now;
    const known = this.#acceptedCommands.get(request.commandId);
    if (known) {
      const same =
        known.machine === machineId &&
        known.orderId === request.orderId &&
        known.product === request.product &&
        known.quantity === request.quantity &&
        known.notBefore === request.notBefore;
      return same
        ? { ok: true, duplicate: true, job: this.#jobView(known) }
        : {
            ok: false,
            code: 'command-conflict',
            reason:
              known.machine === machineId
                ? `command ${request.commandId} was accepted with another job`
                : `command ${request.commandId} was accepted for ${known.machine}`,
            argument: 'CommandId',
          };
    }
    if (guard && request.deviceEpoch !== guard.epoch) {
      return {
        ok: false,
        code: 'epoch-mismatch',
        reason: `the command is for device epoch ${String(request.deviceEpoch)}, this run is ${String(guard.epoch)}`,
        argument: 'DeviceEpoch',
      };
    }
    if (guard && (request.expiresAt === undefined || request.expiresAt < guard.wallNow)) {
      return {
        ok: false,
        code: 'expired',
        reason: `the command expired at ${request.expiresAt === undefined ? 'an unknown time' : new Date(request.expiresAt).toISOString()}`,
        argument: 'ExpiresAt',
      };
    }
    const issue = this.#jobIssue(request);
    if (issue) {
      return issue;
    }
    if (station.jobs.length >= MAX_QUEUED_JOBS) {
      return {
        ok: false,
        code: 'queue-full',
        reason: `${machineId} already has ${String(MAX_QUEUED_JOBS)} jobs queued`,
      };
    }
    const job: Job = {
      commandId: request.commandId,
      orderId: request.orderId,
      machine: machineId,
      product: request.product,
      quantity: request.quantity,
      notBefore: request.notBefore,
      position: station.jobs.length + 1,
      acceptedAt: this.#now,
      taken: 0,
      startedAt: undefined,
      completedAt: undefined,
    };
    station.jobs.push(job);
    station.accepted.set(job.commandId, job);
    this.#acceptedCommands.set(job.commandId, job);
    this.#jobs.push(job);
    this.#jobEvent(job, 'accepted');
    if (job.notBefore > this.#now) {
      simulation.schedule(job.notBefore, { type: 'wake', station: station.id });
    }
    this.#startInShift(station, simulation);
    return { ok: true, duplicate: false, job: this.#jobView(job) };
  }

  #jobIssue(request: LoadOrderRequest): Extract<LoadOrderResult, { ok: false }> | undefined {
    const id = (value: string) =>
      value.length > 0 && value.length <= MAX_JOB_ID_LENGTH && value.trim() === value;
    if (!id(request.commandId)) {
      return {
        ok: false,
        code: 'invalid-argument',
        reason: `a command id must be 1–${String(MAX_JOB_ID_LENGTH)} characters without surrounding spaces`,
        argument: 'CommandId',
      };
    }
    if (!id(request.orderId)) {
      return {
        ok: false,
        code: 'invalid-argument',
        reason: `an order id must be 1–${String(MAX_JOB_ID_LENGTH)} characters without surrounding spaces`,
        argument: 'OrderId',
      };
    }
    if (!this.#config.products.products.some((p) => p.id === request.product)) {
      return {
        ok: false,
        code: 'invalid-product',
        reason: `unknown product "${request.product}"`,
        argument: 'Product',
      };
    }
    if (
      !Number.isInteger(request.quantity) ||
      request.quantity <= 0 ||
      request.quantity > MAX_PROGRAM_QUANTITY
    ) {
      return {
        ok: false,
        code: 'invalid-quantity',
        reason: `quantity must be an integer from 1 to ${String(MAX_PROGRAM_QUANTITY)}, got ${String(request.quantity)}`,
        argument: 'Quantity',
      };
    }
    if (!Number.isSafeInteger(request.notBefore)) {
      return {
        ok: false,
        code: 'invalid-argument',
        reason: 'NotBefore must be a time in integer milliseconds',
        argument: 'NotBefore',
      };
    }
    return undefined;
  }

  #jobView(job: Job): JobView {
    return {
      commandId: job.commandId,
      orderId: job.orderId,
      machine: job.machine,
      product: job.product,
      quantity: job.quantity,
      notBefore: job.notBefore,
      position: job.position,
      acceptedAt: job.acceptedAt,
      taken: job.taken,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    };
  }

  /** Every job accepted so far (orders mode), in acceptance order, with its progress. */
  jobs(): JobView[] {
    return this.#jobs.map((job) => this.#jobView(job));
  }

  /** The jobs a CNC has accepted and not completed, in queue order. */
  queue(machineId: string): JobView[] {
    return (this.#station(machineId).jobs ?? []).map((job) => this.#jobView(job));
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
    if (this.production !== 'schedule') {
      return {
        ok: false,
        code: 'wrong-mode',
        reason: `LoadProgram needs production mode "schedule"; the simulator runs "${this.production}" (use LoadOrder)`,
      };
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

  /**
   * Blocks or releases a lot now (a `lot` event without an action id). The control API and a
   * headless run's `actions` go through `act`, which schedules it as a simulation event.
   */
  blockLot(lotId: string, blocked: boolean, simulation: Simulation<LineEvent>): void {
    this.#now = simulation.now;
    this.#setLot(lotId, blocked, undefined, simulation);
  }

  /**
   * A blocked lot is skipped as if it were empty (the consuming station starves with
   * `MATERIAL:<material>` once no other lot is left); releasing it wakes every starved station.
   */
  #setLot(
    lotId: string,
    blocked: boolean,
    action: number | undefined,
    simulation: Simulation<LineEvent>,
  ): void {
    const material = this.inventory.setBlocked(lotId, blocked);
    this.#onEvent({
      type: 'lot',
      at: this.#now,
      lotId,
      material,
      transition: blocked ? 'blocked' : 'released',
      ...(action === undefined ? {} : { action }),
    });
    if (!blocked) {
      this.stations.forEach((station) => {
        if (station.machine.state === 'Starved') {
          this.#tryStart(station, simulation);
        }
      });
    }
  }

  /**
   * Accepts a console action (#234, ADR-0037: the control API and a headless run's `actions`).
   * A lot block or release and a tool breakage are scheduled as simulation events at `at` (now
   * when left out), as failure injections are; a forced absence is applied at its shift's start,
   * which must be after the current simulation time. Refused: an unknown lot, machine, shift or
   * operator, a machine without a tool, an operator not rostered on the shift, a time in the past
   * or on a calendar boundary, a shift already started.
   */
  act(request: ActionRequest, simulation: Simulation<LineEvent>): ActionResult {
    this.#now = simulation.now;
    if (request.kind === 'operators-absent') {
      return this.#planAbsence(request);
    }
    const at = request.at ?? simulation.now;
    const [issue] = actionIssues(this.#config, { ...request, at });
    if (issue) {
      return { ok: false, code: issue.code, reason: issue.message };
    }
    // A first-operation machine without a tool (a CNC the schedule doesn't list) has nothing to
    // break: refused here, never at the event, which would abort the run.
    if (
      request.kind === 'tool-breakage' &&
      !this.stations.find((s) => s.id === request.machine)?.tool
    ) {
      return { ok: false, code: 'not-a-cnc', reason: `${request.machine} has no tool` };
    }
    if (at < simulation.now) {
      return {
        ok: false,
        code: 'in-the-past',
        reason: `${new Date(at).toISOString()} is before the simulation time ${new Date(simulation.now).toISOString()}`,
      };
    }
    const id = this.#actions.length + 1;
    let action: ActionRecord;
    if (request.kind === 'tool-breakage') {
      action = {
        id,
        kind: request.kind,
        machine: request.machine,
        at,
        status: 'scheduled',
        appliedAt: undefined,
        cycles: undefined,
      };
      simulation.schedule(at, { type: 'tool-break', station: request.machine, action: id });
    } else {
      action = {
        id,
        kind: request.kind,
        lot: request.lot,
        material: this.#config.stock.lots.find((lot) => lot.id === request.lot)?.material ?? '',
        at,
        status: 'scheduled',
        appliedAt: undefined,
      };
      simulation.schedule(at, { type: 'lot-action', action: id });
    }
    this.#actions.push(action);
    return { ok: true, action: this.#actionView(action) };
  }

  #planAbsence(request: OperatorsAbsentSpec): ActionResult {
    const [issue] = actionIssues(this.#config, request);
    if (issue) {
      return { ok: false, code: issue.code, reason: issue.message };
    }
    const start = shiftStart(this.#config, request.shift);
    if (start === undefined) {
      return { ok: false, code: 'unknown-shift', reason: `no shift ${request.shift}` };
    }
    if (start <= this.#now) {
      return {
        ok: false,
        code: 'shift-started',
        reason: `shift ${request.shift} starts at ${new Date(start).toISOString()}, not after the simulation time ${new Date(this.#now).toISOString()}`,
      };
    }
    const action: AbsenceRecord = {
      id: this.#actions.length + 1,
      kind: 'operators-absent',
      shift: request.shift,
      start,
      operators: [...request.operators],
      status: 'planned',
      appliedAt: undefined,
    };
    this.#actions.push(action);
    return { ok: true, action: this.#actionView(action) };
  }

  /** Every console action accepted so far, in order, with its outcome. */
  actions(): ConsoleAction[] {
    return this.#actions.map((action) => this.#actionView(action));
  }

  #actionView(action: LotActionRecord): LotAction;
  #actionView(action: AbsenceRecord): OperatorAbsence;
  #actionView(action: ActionRecord): ConsoleAction;
  #actionView(action: ActionRecord): ConsoleAction {
    const applied = action.appliedAt === undefined ? {} : { appliedAt: action.appliedAt };
    switch (action.kind) {
      case 'lot-block':
      case 'lot-release':
        return {
          id: action.id,
          kind: action.kind,
          lot: action.lot,
          material: action.material,
          at: action.at,
          status: action.status,
          ...applied,
        };
      case 'tool-breakage':
        return {
          id: action.id,
          kind: action.kind,
          machine: action.machine,
          at: action.at,
          status: action.status,
          ...applied,
          ...(action.cycles === undefined ? {} : { cycles: action.cycles }),
        };
      case 'operators-absent':
        return {
          id: action.id,
          kind: action.kind,
          shift: action.shift,
          start: action.start,
          operators: [...action.operators],
          status: action.status,
          ...applied,
        };
    }
  }

  #action(id: number): ActionRecord {
    const action = this.#actions.find((a) => a.id === id);
    if (!action) {
      throw new RangeError(`unknown console action ${String(id)}`);
    }
    return action;
  }

  #applyLotAction(id: number, simulation: Simulation<LineEvent>): void {
    const action = this.#action(id);
    if (action.kind !== 'lot-block' && action.kind !== 'lot-release') {
      throw new RangeError(`console action ${String(id)} is not a lot action`);
    }
    action.status = 'applied';
    action.appliedAt = this.#now;
    this.#setLot(action.lot, action.kind === 'lot-block', action.id, simulation);
  }

  /**
   * A tool breakage (#234, ADR-0037): the wear goes to end of life and nothing else happens now.
   * A cycle in progress completes normally and draws its defect at wear 1.0; `needsChange` then
   * makes the next `#tryStart` change the tool (`Setup TOOL-CHANGE`), as at a natural end of
   * life. No random draw is added or removed. Inside the machine's own `TOOL-CHANGE` setup the
   * tool being fitted has not cut yet: the breakage changes nothing (no second change) and is
   * recorded as `ignored`.
   */
  #applyToolBreak(station: Station, id: number): void {
    const action = this.#action(id);
    if (action.kind !== 'tool-breakage' || !station.tool) {
      throw new RangeError(`console action ${String(id)} is not a tool breakage on ${station.id}`);
    }
    action.appliedAt = this.#now;
    const ignored = station.changingTool;
    action.status = ignored ? 'ignored' : 'applied';
    const cycles = ignored ? station.tool.cycles : station.tool.break();
    action.cycles = cycles;
    this.#onEvent({
      type: 'tool-breakage',
      at: this.#now,
      machineId: station.id,
      action: action.id,
      cycles,
      ...(ignored ? { ignored: 'tool-change-in-progress' as const } : {}),
    });
  }

  /** Every lot in file order, with what is left and whether it is blocked (#234). */
  lots(): LotView[] {
    return this.inventory.lots();
  }

  /** The roster with each operator's place in the current shift, and the forced absences. */
  operators(): OperatorsView {
    const crew = this.#crewNow;
    return {
      currentShift: crew?.key ?? null,
      operators: this.#config.operators.operators.map((op): OperatorView => {
        // The running shift's crew, when the operator is rostered on it.
        const shift = crew?.shiftId === op.shift ? crew : undefined;
        return {
          id: op.id,
          shift: op.shift,
          skills: [...op.skills],
          speedFactor: op.speedFactor,
          status: !shift ? 'off-shift' : shift.absent.has(op.id) ? 'absent' : 'present',
          station: shift?.stations.get(op.id) ?? null,
          forced: shift?.forced.has(op.id) ?? false,
        };
      }),
      absences: this.#actions
        .filter((a): a is AbsenceRecord => a.kind === 'operators-absent')
        .map((a) => this.#actionView(a)),
    };
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
      this.#enter(station, 'Starved', materialCause(missing));
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
      if (station.jobs) {
        this.#afterJobCycle(station, part);
      }
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
        characteristic: LEAK_TEST_CHARACTERISTIC,
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
      // Guard (#140): only a Blocked machine without a failure unloads.
      if (
        upstream.machine.state === 'Blocked' &&
        upstream.failure === undefined &&
        !buffer.isFull
      ) {
        this.#unload(upstream, simulation);
      }
    }
  }
}
